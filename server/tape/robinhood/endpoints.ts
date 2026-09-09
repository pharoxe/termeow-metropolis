import type { RpcEndpointHealth, RpcPoolHealth } from "../../../shared/wire.js";
import { UpstreamError, errorMessage } from "../../lib/http.js";
import type { LaneReporter } from "./logsLane.js";
import { hexToNumber } from "./rpc.js";

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
 * A 403 to an eth_getLogs marks the host logs-incapable for this long, then it is probed again: the static NO_LOGS_HOSTS
 * refuse for good, but a 403 from any other host may be a WAF/edge blip, and losing a live logs host permanently would
 * halve the remaining logs capacity (two hosts carry it today).
 */
export const LOGS_FORBIDDEN_RETRY_MS = 15 * 60_000;
/**
 * A failure streak counts against an endpoint's rank only this long after its last failure; then the endpoint ranks
 * clean again and its next block restarts from the base backoff. Without this a host with one old failure stayed behind
 * every clean host indefinitely (it only reset on a success it was never given).
 */
export const FAIL_STREAK_DECAY_MS = 2 * ENDPOINT_BACKOFF_MAX_MS;

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

/**
 * Kept in the pool, but new calls skip them while any other host can serve the lane. Both returned
 * "upstream returned 429" on 2026-09-08; a restart zeroes rateLimited, so the penalty is not only the counter.
 */
export const DEPRIORITIZED_HOSTS: ReadonlySet<string> = new Set([
  "rpc.mainnet.chain.robinhood.com",
  "rpc.nodeflare.app"
]);

/**
 * Measured 2026-09-07: blockmachine caps one eth_getLogs at 9,999 blocks (-32602 with data.max_blocks); the official
 * RPC answered a PoolManager+poolId filter over 1M blocks in 3.0 s and timed out at 3M. Hosts absent here carry no
 * known cap. A request wider than an endpoint's cap is never sent to it (it would only burn that endpoint's budget).
 */
export const LOGS_RANGE_CAPS: ReadonlyMap<string, number> = new Map([
  ["rpc-robinhood.blockmachine.io", 9_999],
  ["rpc.mainnet.chain.robinhood.com", 1_000_000]
]);
/**
 * Measured 2026-09-07 22:05 IST: blockmachine answers HTTP 200 with -32001 "No backend available" to any eth_getLogs
 * whose toBlock exceeds its head (toBlock = head and "latest" both serve). A batched poller tick asks cursor + 400
 * before it knows the head, so such ticks skip these hosts instead of failing there and backing the poller off.
 */
export const NO_SPECULATIVE_TOBLOCK_HOSTS: ReadonlySet<string> = new Set(["rpc-robinhood.blockmachine.io"]);
/** An eth_getLogs wider than this is a backfill and routes to the largest-range endpoint first; a poller tick spans 405 blocks. */
export const DEFAULT_BACKFILL_RANGE_BLOCKS = 2_000;

export type EndpointLane = "logs" | "other";

/**
 * What routing needs to know about one request body: its lane, the widest eth_getLogs block span it carries (0 when
 * none or unreadable), and whether it is a batched tick whose toBlock is speculative (eth_blockNumber travels with
 * the eth_getLogs, so the caller could not have clamped toBlock to the head).
 */
export type RequestShape = { lane: EndpointLane; range: number; speculative: boolean };

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
  logsRangeCaps?: ReadonlyMap<string, number>;
  noSpeculativeToBlockHosts?: ReadonlySet<string>;
  /** Told about every logs-lane 429 / clean answer and about lane-wide blocks; see tape/robinhood/logsLane.ts. */
  logsLane?: LaneReporter;
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
  /** Structurally logs-capable (not in noLogsHosts); a 403 suspends it until `logsRetryAt` instead. */
  readonly logs: boolean;
  /** Epoch ms until which a 403 keeps this host out of the logs lane; 0 when not suspended. */
  readonly logsRetryAt: number;
  /** Requests handed to this endpoint that have not settled (reserved at pick time so a same-tick fan-out spreads). */
  readonly inFlight: number;
  /** Epoch ms of the last block(); drives FAIL_STREAK_DECAY_MS. */
  readonly lastFailureAt: number;
  /** Widest eth_getLogs span this host serves (null: no known cap). */
  readonly logsRangeCap: number | null;
  /** False when the host rejects an eth_getLogs whose toBlock is beyond its head. */
  readonly speculativeToBlock: boolean;
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

type HostRules = { noLogsHosts: ReadonlySet<string>; logsRangeCaps: ReadonlyMap<string, number>; noSpeculativeToBlockHosts: ReadonlySet<string> };

function initialState(url: string, rules: HostRules, backoffMs: number): EndpointState {
  const host = hostOf(url);
  return {
    url,
    key: endpointKey(url),
    host,
    enabled: true,
    disabledReason: null,
    chainVerified: false,
    logs: !rules.noLogsHosts.has(host),
    logsRetryAt: 0,
    inFlight: 0,
    lastFailureAt: 0,
    logsRangeCap: rules.logsRangeCaps.get(host) ?? null,
    speculativeToBlock: !rules.noSpeculativeToBlockHosts.has(host),
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

/** The failure streak as ranking sees it: the raw streak while the last failure is recent, 0 once it has decayed. */
function recentStreak(state: EndpointState, now: number): number {
  return now - state.lastFailureAt < FAIL_STREAK_DECAY_MS ? state.failStreak : 0;
}

/** A host that has already drawn a 429 ranks behind every host that has not, even after its block expires. */
function rateLimitedRank(state: EndpointState): number {
  return state.rateLimited > 0 || DEPRIORITIZED_HOSTS.has(state.host) ? 1 : 0;
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

function hexQuantity(value: unknown): number | null {
  try {
    return hexToNumber(value);
  } catch {
    return null;
  }
}

/** Inclusive block span of one eth_getLogs filter; 0 when either bound is a tag ("latest") or unreadable. */
function spanOf(item: Record<string, unknown>): number {
  const filter = Array.isArray(item.params) && item.params[0] && typeof item.params[0] === "object" ? (item.params[0] as Record<string, unknown>) : null;
  if (!filter) return 0;
  const from = hexQuantity(filter.fromBlock);
  const to = hexQuantity(filter.toBlock);
  return from === null || to === null || to < from ? 0 : to - from + 1;
}

/** Lane, widest eth_getLogs span and speculative-toBlock flag of a request body (see RequestShape). */
export function shapeOf(body: BodyInit | null | undefined): RequestShape {
  const other: RequestShape = { lane: "other", range: 0, speculative: false };
  if (typeof body !== "string") return other;
  try {
    const parsed = JSON.parse(body) as unknown;
    const items = (Array.isArray(parsed) ? parsed : [parsed]).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    const logs = items.filter((item) => item.method === "eth_getLogs");
    if (logs.length === 0) return other;
    const range = Math.max(0, ...logs.map(spanOf));
    const speculative = Array.isArray(parsed) && items.some((item) => item.method === "eth_blockNumber");
    return { lane: "logs", range, speculative };
  } catch {
    return other;
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
  private readonly logsLane: LaneReporter | null;
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
    this.logsLane = opts.logsLane ?? null;
    const rules: HostRules = {
      noLogsHosts: opts.noLogsHosts ?? NO_LOGS_HOSTS,
      logsRangeCaps: opts.logsRangeCaps ?? LOGS_RANGE_CAPS,
      noSpeculativeToBlockHosts: opts.noSpeculativeToBlockHosts ?? NO_SPECULATIVE_TOBLOCK_HOSTS
    };
    const seen = new Set<string>();
    this.endpoints = opts.urls
      .map((url) => initialState(url, rules, this.baseBackoffMs))
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

  /** Epoch ms when the lane next has an unblocked enabled endpoint: 0 when one is free now, Infinity when none is enabled. */
  laneFreeAt(lane: EndpointLane): number {
    const now = this.now();
    const eligible = this.endpoints.filter((endpoint) => endpoint.enabled && (lane !== "logs" || endpoint.logs));
    if (eligible.length === 0) return Number.POSITIVE_INFINITY;
    // a 403-suspended host rejoins the logs lane at logsRetryAt, so that is when it counts as free
    const freeAt = (endpoint: EndpointState) => (lane === "logs" ? Math.max(endpoint.blockedUntil, endpoint.logsRetryAt) : endpoint.blockedUntil);
    if (eligible.some((endpoint) => freeAt(endpoint) <= now)) return 0;
    return Math.min(...eligible.map(freeAt));
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
        logs: endpoint.logs && endpoint.logsRetryAt <= now,
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
    const shape = shapeOf(init?.body);
    const lane = shape.lane;
    const tried = new Set<string>();
    let lastResponse: Response | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_CALL; attempt += 1) {
      const endpoint = await this.pick(shape, tried);
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
    if (lane === "logs") this.logsLane?.holdUntil(this.laneFreeAt("logs"));
    throw new UpstreamError(`robinhood rpc pool: no ${lane} endpoint available (all blocked or disabled)`, 429);
  }

  /**
   * Healthiest candidate: enabled, unblocked, right lane, untried, and for eth_getLogs able to serve the request's span
   * (a speculative tick never goes to a host that rejects toBlock beyond head). Order: never-429 first (a 429 host is
   * only used when no cleaner endpoint can serve this lane — the pool is not dropped); then not slow; then for a
   * backfill span the largest known range cap (unknown caps last) and for a small single getLogs the smallest cap that
   * fits (so top-ups and shrunk chunks leave the largest endpoint's budget to ticks and backfills); then fewest
   * requests in flight (reserved synchronously here, so N callers in one tick land on N endpoints rather than all on
   * the "healthiest"); then fewest recent consecutive failures (FAIL_STREAK_DECAY_MS), then fewer lifetime 429s,
   * then p50, then configured order.
   */
  private async pick(shape: RequestShape, tried: ReadonlySet<string>): Promise<EndpointState | null> {
    const now = this.now();
    const lane = shape.lane;
    const slow = (endpoint: EndpointState) => ((p50(endpoint.latencies) ?? 0) > SLOW_P50_MS ? 1 : 0);
    const capRank = this.capRank(shape);
    const candidates = this.endpoints
      .map((endpoint, index) => ({ endpoint, index }))
      .filter(({ endpoint }) => endpoint.enabled && endpoint.blockedUntil <= now && !tried.has(endpoint.key))
      .filter(({ endpoint }) => lane !== "logs" || this.servesLogs(endpoint, shape, now))
      .sort((a, b) =>
        rateLimitedRank(a.endpoint) - rateLimitedRank(b.endpoint) ||
        slow(a.endpoint) - slow(b.endpoint) ||
        capRank(a.endpoint) - capRank(b.endpoint) ||
        a.endpoint.inFlight - b.endpoint.inFlight ||
        recentStreak(a.endpoint, now) - recentStreak(b.endpoint, now) ||
        a.endpoint.rateLimited - b.endpoint.rateLimited ||
        (p50(a.endpoint.latencies) ?? 0) - (p50(b.endpoint.latencies) ?? 0) ||
        a.index - b.index
      );
    for (const { endpoint } of candidates) {
      // reserved before any await, so concurrent picks in the same tick already see this request counted
      this.reserve(endpoint.key, 1);
      if (await this.verify(endpoint)) return this.state(endpoint.key) ?? endpoint;
      this.reserve(endpoint.key, -1);
    }
    return null;
  }

  /** Counts a request against the endpoint from pick until send() settles it. */
  private reserve(key: string, delta: 1 | -1): void {
    this.update(key, (state) => ({ ...state, inFlight: Math.max(0, state.inFlight + delta) }));
  }

  private servesLogs(endpoint: EndpointState, shape: RequestShape, now: number): boolean {
    if (!endpoint.logs || endpoint.logsRetryAt > now) return false;
    if (shape.speculative && !endpoint.speculativeToBlock) return false;
    return endpoint.logsRangeCap === null || endpoint.logsRangeCap >= shape.range;
  }

  /**
   * Lower ranks first; identical (0) outside the logs lane and for speculative ticks, which rank on health alone. A
   * backfill span ranks the largest known cap first (unknown caps after the known ones); a small single getLogs ranks
   * the largest-cap endpoint last so it stays free for ticks and backfills whenever any other host fits.
   */
  private capRank(shape: RequestShape): (endpoint: EndpointState) => number {
    if (shape.lane !== "logs" || shape.speculative) return () => 0;
    if (shape.range > DEFAULT_BACKFILL_RANGE_BLOCKS) return (endpoint) => -(endpoint.logsRangeCap ?? 0);
    const largest = Math.max(0, ...this.endpoints.filter((endpoint) => endpoint.enabled && endpoint.logs).map((endpoint) => endpoint.logsRangeCap ?? 0));
    return (endpoint) => (largest > 0 && endpoint.logsRangeCap === largest ? 1 : 0);
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
        if (response.status === 403 && lane === "logs") this.suspendLogs(endpoint);
        this.block(endpoint.key, `upstream returned ${response.status}`, response.status === 429);
        if (lane === "logs") this.tellLane(response.status === 429);
        return { kind: "response", response };
      }
      this.update(endpoint.key, (state) => ({
        ...state,
        failStreak: 0,
        backoffMs: this.baseBackoffMs,
        latencies: [...state.latencies, elapsed].slice(-LATENCY_RING)
      }));
      if (lane === "logs") this.logsLane?.reportOk();
      return { kind: "ok", response };
    } catch (error) {
      if (init?.signal?.aborted) {
        // The caller gave up waiting: that is this endpoint's failure to answer in time, not a neutral event.
        this.block(endpoint.key, `no answer within ${Math.max(0, this.now() - started)} ms (caller aborted)`, false);
        if (lane === "logs") this.tellLane(false);
        return { kind: "aborted", error };
      }
      this.block(endpoint.key, errorMessage(error), false);
      if (lane === "logs") this.tellLane(false);
      return { kind: "error", error };
    } finally {
      this.reserve(endpoint.key, -1);
    }
  }

  /** A 403 to eth_getLogs: out of the logs lane until LOGS_FORBIDDEN_RETRY_MS pass, then probed again (never for good). */
  private suspendLogs(endpoint: EndpointState): void {
    const until = this.now() + LOGS_FORBIDDEN_RETRY_MS;
    this.update(endpoint.key, (state) => ({ ...state, logsRetryAt: until }));
    this.log(`robinhood rpc pool: ${endpoint.url} answered 403 to eth_getLogs; out of the logs lane for ${Math.round(LOGS_FORBIDDEN_RETRY_MS / 60_000)} min`);
  }

  /** After a logs-lane failure: a 429 widens the lane's gap; whenever no logs endpoint is left, the lane holds until one frees. */
  private tellLane(rateLimited: boolean): void {
    if (!this.logsLane) return;
    if (rateLimited) this.logsLane.report429();
    this.logsLane.holdUntil(this.laneFreeAt("logs"));
  }

  /** A streak older than FAIL_STREAK_DECAY_MS no longer counts: the endpoint ranks clean and its next block starts from the base backoff. */
  private block(key: string, reason: string, rateLimited: boolean): void {
    const now = this.now();
    this.update(key, (state) => {
      const decayed = recentStreak(state, now) === 0;
      const backoffMs = decayed ? this.baseBackoffMs : state.backoffMs;
      return {
        ...state,
        blockedUntil: now + backoffMs,
        backoffMs: Math.min(backoffMs * 2, this.maxBackoffMs),
        failStreak: (decayed ? 0 : state.failStreak) + 1,
        lastFailureAt: now,
        rateLimited: state.rateLimited + (rateLimited ? 1 : 0),
        failures: state.failures + (rateLimited ? 0 : 1),
        lastError: reason
      };
    });
  }

  private state(key: string): EndpointState | undefined {
    return this.endpoints.find((endpoint) => endpoint.key === key);
  }

  private update(key: string, patch: (state: EndpointState) => EndpointState): void {
    this.endpoints = this.endpoints.map((endpoint) => (endpoint.key === key ? patch(endpoint) : endpoint));
  }
}
