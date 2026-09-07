import type { RpcEndpointHealth, RpcPoolHealth } from "../../../shared/wire.js";
import { UpstreamError, errorMessage } from "../../lib/http.js";

/** Robinhood Chain (eth_chainId 0x1237). An endpoint answering anything else is disabled for the process. */
export const ROBINHOOD_CHAIN_ID = 4663;
/** First block after a 429/5xx (official RPC's Cloudflare retry measured 17-30 s on 2026-09-06). */
export const ENDPOINT_BACKOFF_MS = 20_000;
/** Doubles per consecutive block up to this cap. */
export const ENDPOINT_BACKOFF_MAX_MS = 120_000;
/** One failover per call: an attempt on the picked endpoint, then at most one more on the next healthiest. */
export const MAX_ATTEMPTS_PER_CALL = 2;
/** rpc.nodeflare.app answers HTTP 403 to any request without a User-Agent; harmless everywhere else. */
export const ENDPOINT_USER_AGENT = "terminal-v/0.2 (robinhood rpc pool)";
export const CHAIN_CHECK_TIMEOUT_MS = 10_000;
export const LATENCY_RING = 32;
/**
 * An endpoint whose p50 sits above this ranks behind every faster one whatever its failure streak: measured 2026-09-07,
 * pocket (p50 10.2 s) and blxrbdn (8.5 s) kept winning a clean-streak sort and drove the callers' 15 s aborts.
 */
export const SLOW_P50_MS = 4_000;

/**
 * Measured 2026-09-07 19:10-19:25 IST: these hosts refuse historical eth_getLogs (publicnode 403 "Archive requests
 * require a personal token", pocket -32000 "historical state is not available", blxrbdn 403 administrative rules).
 * They stay in the pool for eth_blockNumber / eth_getBlockByNumber / eth_call / eth_getCode / receipts.
 */
export const NO_LOGS_HOSTS: ReadonlySet<string> = new Set([
  "robinhood-rpc.publicnode.com",
  "robinhood.api.pocket.network",
  "robinhood.rpc.blxrbdn.com"
]);

export type EndpointLane = "logs" | "other";

export type EndpointPoolOptions = {
  urls: readonly string[];
  chainId?: number;
  fetchImpl?: typeof fetch;
  /** Must agree with the timers in use (Date.now under vitest fake timers). */
  now?: () => number;
  log?: (message: string) => void;
  backoffMs?: number;
  maxBackoffMs?: number;
  userAgent?: string;
  noLogsHosts?: ReadonlySet<string>;
};

/** The wire shape of GET /api/health's robinhoodRpc block (shared/wire.ts) is the pool's own stats type. */
export type EndpointStats = RpcEndpointHealth;
export type EndpointPoolStats = RpcPoolHealth;

type EndpointState = {
  readonly url: string;
  readonly key: string;
  readonly host: string;
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  readonly chainVerified: boolean;
  readonly logs: boolean;
  readonly blockedUntil: number;
  readonly backoffMs: number;
  readonly failStreak: number;
  readonly calls: number;
  readonly rateLimited: number;
  readonly failures: number;
  readonly latencies: readonly number[];
  readonly lastError: string | null;
};

/** Trailing slash and host case never make two endpoints distinct. */
export function endpointKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

function initialState(url: string, noLogsHosts: ReadonlySet<string>, backoffMs: number): EndpointState {
  const host = hostOf(url);
  return {
    url,
    key: endpointKey(url),
    host,
    enabled: true,
    disabledReason: null,
    chainVerified: false,
    logs: !noLogsHosts.has(host),
    blockedUntil: 0,
    backoffMs,
    failStreak: 0,
    calls: 0,
    rateLimited: 0,
    failures: 0,
    latencies: [],
    lastError: null
  };
}

function p50(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The lane a request needs: any eth_getLogs (single or inside a batch array) must go to a logs-capable endpoint. */
export function laneOf(body: BodyInit | null | undefined): EndpointLane {
  if (typeof body !== "string") return "other";
  try {
    const parsed = JSON.parse(body) as unknown;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const usesLogs = items.some((item) => item && typeof item === "object" && (item as { method?: unknown }).method === "eth_getLogs");
    return usesLogs ? "logs" : "other";
  } catch {
    return "other";
  }
}

function withUserAgent(init: RequestInit | undefined, userAgent: string): RequestInit {
  const headers = new Headers(init?.headers);
  if (!headers.has("user-agent")) headers.set("User-Agent", userAgent);
  return { ...init, headers };
}

function parseChainId(text: string): number | null {
  try {
    const body = JSON.parse(text) as { result?: unknown };
    if (typeof body?.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.result)) return null;
    return Number(BigInt(body.result));
  } catch {
    return null;
  }
}

/**
 * One pool of Robinhood Chain JSON-RPC endpoints behind a fetch-compatible transport. `pool.fetch(url, init)` routes any
 * request addressed to a member URL to the healthiest enabled, unblocked endpoint of the right lane (eth_getLogs only
 * to logs-capable hosts), adds a User-Agent, verifies eth_chainId once per endpoint, and on a 429/5xx/403 blocks that
 * endpoint (backoff doubling to the cap) and retries once on the next one. A URL outside the pool passes straight
 * through to the underlying fetch, so callers built against a test RPC keep their own stubs. Every caller keeps its own
 * pacing and 429 semantics; the pool only guarantees that a 429 on endpoint A does not block endpoint B.
 */
export class EndpointPool {
  private readonly chainId: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly userAgent: string;
  private endpoints: readonly EndpointState[];
  private readonly verifying = new Map<string, Promise<boolean>>();

  readonly fetch: typeof fetch = (input, init) => this.route(input, init);

  constructor(opts: EndpointPoolOptions) {
    if (opts.urls.length === 0) throw new Error("EndpointPool: at least one url is required");
    this.chainId = opts.chainId ?? ROBINHOOD_CHAIN_ID;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((message) => console.warn(message));
    this.baseBackoffMs = opts.backoffMs ?? ENDPOINT_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? ENDPOINT_BACKOFF_MAX_MS;
    this.userAgent = opts.userAgent ?? ENDPOINT_USER_AGENT;
    const noLogs = opts.noLogsHosts ?? NO_LOGS_HOSTS;
    const seen = new Set<string>();
    this.endpoints = opts.urls
      .map((url) => initialState(url, noLogs, this.baseBackoffMs))
      .filter((state) => (seen.has(state.key) ? false : (seen.add(state.key), true)));
  }

  /** True when `url` names a member endpoint (so a request to it is routed rather than passed through). */
  has(url: string): boolean {
    const key = endpointKey(url);
    return this.endpoints.some((endpoint) => endpoint.key === key);
  }

  urls(): string[] {
    return this.endpoints.map((endpoint) => endpoint.url);
  }

  stats(): EndpointPoolStats {
    const now = this.now();
    return {
      chainId: this.chainId,
      endpoints: this.endpoints.map((endpoint) => ({
        url: endpoint.url,
        ok: endpoint.enabled && endpoint.blockedUntil <= now,
        enabled: endpoint.enabled,
        disabledReason: endpoint.disabledReason,
        chainVerified: endpoint.chainVerified,
        logs: endpoint.logs,
        blockedUntil: endpoint.blockedUntil > now ? new Date(endpoint.blockedUntil).toISOString() : null,
        calls: endpoint.calls,
        rateLimited: endpoint.rateLimited,
        failures: endpoint.failures,
        p50Ms: p50(endpoint.latencies),
        lastError: endpoint.lastError
      }))
    };
  }

  private async route(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (!this.has(urlOf(input))) return this.fetchImpl(input, init);
    const lane = laneOf(init?.body);
    const tried = new Set<string>();
    let lastResponse: Response | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_CALL; attempt += 1) {
      const endpoint = await this.pick(lane, tried);
      if (!endpoint) break;
      tried.add(endpoint.key);
      const outcome = await this.send(endpoint, lane, init);
      if (outcome.kind === "ok") return outcome.response;
      if (outcome.kind === "aborted") throw outcome.error;
      lastResponse = outcome.kind === "response" ? outcome.response : lastResponse;
      if (attempt === MAX_ATTEMPTS_PER_CALL - 1) {
        if (outcome.kind === "response") return outcome.response;
        throw outcome.error;
      }
    }
    if (lastResponse) return lastResponse;
    throw new UpstreamError(`robinhood rpc pool: no ${lane} endpoint available (all blocked or disabled)`, 429);
  }

  /** Healthiest candidate: enabled, unblocked, right lane, untried; not slow first, then fewest consecutive failures, then p50, then order. */
  private async pick(lane: EndpointLane, tried: ReadonlySet<string>): Promise<EndpointState | null> {
    const now = this.now();
    const slow = (endpoint: EndpointState) => ((p50(endpoint.latencies) ?? 0) > SLOW_P50_MS ? 1 : 0);
    const candidates = this.endpoints
      .map((endpoint, index) => ({ endpoint, index }))
      .filter(({ endpoint }) => endpoint.enabled && endpoint.blockedUntil <= now && !tried.has(endpoint.key))
      .filter(({ endpoint }) => lane !== "logs" || endpoint.logs)
      .sort((a, b) =>
        slow(a.endpoint) - slow(b.endpoint) ||
        a.endpoint.failStreak - b.endpoint.failStreak ||
        (p50(a.endpoint.latencies) ?? 0) - (p50(b.endpoint.latencies) ?? 0) ||
        a.index - b.index
      );
    for (const { endpoint } of candidates) {
      if (await this.verify(endpoint)) return this.state(endpoint.key) ?? endpoint;
    }
    return null;
  }

  /** eth_chainId once per endpoint; a mismatch disables it for good, a transport failure blocks it for one backoff. */
  private verify(endpoint: EndpointState): Promise<boolean> {
    const current = this.state(endpoint.key);
    if (!current || !current.enabled) return Promise.resolve(false);
    if (current.chainVerified) return Promise.resolve(true);
    const pending = this.verifying.get(endpoint.key);
    if (pending) return pending;
    const run = this.checkChain(current).finally(() => this.verifying.delete(endpoint.key));
    this.verifying.set(endpoint.key, run);
    return run;
  }

  private async checkChain(endpoint: EndpointState): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHAIN_CHECK_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(endpoint.url, withUserAgent({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "eth_chainId", params: [] }),
        signal: controller.signal
      }, this.userAgent));
      const text = await response.text();
      if (!response.ok) {
        this.block(endpoint.key, `eth_chainId: upstream returned ${response.status}`, response.status === 429);
        return false;
      }
      const chainId = parseChainId(text);
      if (chainId === null) {
        this.block(endpoint.key, "eth_chainId: unreadable result", false);
        return false;
      }
      if (chainId !== this.chainId) {
        const reason = `eth_chainId ${chainId} != ${this.chainId}`;
        this.update(endpoint.key, (state) => ({ ...state, enabled: false, disabledReason: reason, lastError: reason }));
        this.log(`robinhood rpc pool: disabled ${endpoint.url} (${reason})`);
        return false;
      }
      this.update(endpoint.key, (state) => ({ ...state, chainVerified: true }));
      return true;
    } catch (error) {
      this.block(endpoint.key, `eth_chainId: ${errorMessage(error)}`, false);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async send(
    endpoint: EndpointState,
    lane: EndpointLane,
    init: RequestInit | undefined
  ): Promise<
    | { kind: "ok"; response: Response }
    | { kind: "response"; response: Response }
    | { kind: "error"; error: unknown }
    | { kind: "aborted"; error: unknown }
  > {
    this.update(endpoint.key, (state) => ({ ...state, calls: state.calls + 1 }));
    const started = this.now();
    try {
      const response = await this.fetchImpl(endpoint.url, withUserAgent(init, this.userAgent));
      const elapsed = Math.max(0, this.now() - started);
      if (response.status === 429 || response.status === 403 || response.status >= 500) {
        const forbidsLogs = response.status === 403 && lane === "logs";
        this.block(endpoint.key, `upstream returned ${response.status}`, response.status === 429, forbidsLogs);
        return { kind: "response", response };
      }
      this.update(endpoint.key, (state) => ({
        ...state,
        failStreak: 0,
        backoffMs: this.baseBackoffMs,
        latencies: [...state.latencies, elapsed].slice(-LATENCY_RING)
      }));
      return { kind: "ok", response };
    } catch (error) {
      if (init?.signal?.aborted) {
        // The caller gave up waiting: that is this endpoint's failure to answer in time, not a neutral event.
        this.block(endpoint.key, `no answer within ${Math.max(0, this.now() - started)} ms (caller aborted)`, false);
        return { kind: "aborted", error };
      }
      this.block(endpoint.key, errorMessage(error), false);
      return { kind: "error", error };
    }
  }

  private block(key: string, reason: string, rateLimited: boolean, forbidsLogs = false): void {
    this.update(key, (state) => ({
      ...state,
      logs: forbidsLogs ? false : state.logs,
      blockedUntil: this.now() + state.backoffMs,
      backoffMs: Math.min(state.backoffMs * 2, this.maxBackoffMs),
      failStreak: state.failStreak + 1,
      rateLimited: state.rateLimited + (rateLimited ? 1 : 0),
      failures: state.failures + (rateLimited ? 0 : 1),
      lastError: reason
    }));
  }

  private state(key: string): EndpointState | undefined {
    return this.endpoints.find((endpoint) => endpoint.key === key);
  }

  private update(key: string, patch: (state: EndpointState) => EndpointState): void {
    this.endpoints = this.endpoints.map((endpoint) => (endpoint.key === key ? patch(endpoint) : endpoint));
  }
}
