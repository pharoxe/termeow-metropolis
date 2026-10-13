import { createBackoff, type Backoff } from "../lib/backoff.js";
import { UpstreamError, errorMessage } from "../lib/http.js";
import { EvmRpcError } from "../tape/monad/rpc.js";
import { monadRpcFetch } from "../tape/monad/rpcPool.js";

/** Monad public RPC (rpc.mainnet.chain.monad.com) 429s intermittently; 4 rps kept the capture stage under the limit. */
export const DEFAULT_RPS = 4;
/** Cloudflare retry-after measured 17-30 s on 2026-09-06; one block covers the whole window. */
export const DEFAULT_BACKOFF_MS = 20_000;
/** A 429 is retried once after the backoff; a second 429 fails the call so callers can answer null. */
export const RETRIES_AFTER_429 = 1;
export const PACED_RPC_TIMEOUT_MS = 15_000;

export type PacedRpcOptions = {
  rpcUrl: string;
  /** Names the caller in errors and the backoff ("eth_getCode", "receipts"). */
  label: string;
  fetchImpl?: typeof fetch;
  /** Must agree with the timers in use (Date.now under vitest fake timers). */
  now?: () => number;
  rps?: number;
  backoffMs?: number;
  timeoutMs?: number;
};

/** "low" callers (discovery) yield every slot to "high" callers (per-print receipts and classify) still waiting. */
export type PacedRpcPriority = "high" | "low";

export type PacedRpcStats = {
  calls: number;
  rateLimited: number;
  failures: number;
  blocked: boolean;
  lastError: string | null;
};

const RPC_HEADERS = { "Content-Type": "application/json" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isRateLimit(error: unknown): boolean {
  return error instanceof UpstreamError && error.status === 429;
}

function parseResult(label: string, method: string, text: string): unknown {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} ${method}: non-JSON body (${errorMessage(error)})`);
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!record) throw new Error(`${label} ${method}: malformed response body`);
  if (record.error) {
    const err = typeof record.error === "object" ? (record.error as Record<string, unknown>) : {};
    const code = typeof err.code === "number" ? err.code : null;
    throw new EvmRpcError(`${label} ${method}: ${String(err.message ?? JSON.stringify(record.error))}`, code, err.data);
  }
  return record.result;
}

/**
 * One JSON-RPC client paced at `rps` (a slot every 1000/rps ms, callers queue on the slot) with the shared 429 pattern
 * from lib/backoff.ts: a 429 blocks the client for `backoffMs`, every waiter re-queues behind the block, and the failed
 * call is retried once. Throws UpstreamError / EvmRpcError / Error like tape/monad/rpc.ts so callers map to null.
 */
export class PacedRpc {
  private readonly rpcUrl: string;
  private readonly label: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly gapMs: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;
  private readonly backoff: Backoff;
  private nextSlot = 0;
  private resumeAt = 0;
  private waiters: ReadonlyArray<{ priority: PacedRpcPriority; grant: () => void }> = [];
  private dispatching = false;
  private counters = { calls: 0, rateLimited: 0, failures: 0 };
  private lastError: string | null = null;

  constructor(opts: PacedRpcOptions) {
    this.rpcUrl = opts.rpcUrl;
    this.label = opts.label;
    this.fetchImpl = opts.fetchImpl ?? monadRpcFetch;
    this.now = opts.now ?? (() => Date.now());
    const rps = opts.rps ?? DEFAULT_RPS;
    if (!Number.isFinite(rps) || rps <= 0) throw new Error(`${opts.label}: rps must be > 0, got ${String(rps)}`);
    this.gapMs = 1000 / rps;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.timeoutMs = opts.timeoutMs ?? PACED_RPC_TIMEOUT_MS;
    this.backoff = createBackoff(opts.label, this.backoffMs, this.now);
  }

  async call(method: string, params: unknown[], priority: PacedRpcPriority = "high"): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      await this.waitTurn(priority);
      try {
        return await this.post(method, params);
      } catch (error) {
        this.noteError(error);
        if (isRateLimit(error) && attempt < RETRIES_AFTER_429) continue;
        this.counters = { ...this.counters, failures: this.counters.failures + 1 };
        throw error;
      }
    }
  }

  stats(): PacedRpcStats {
    return { ...this.counters, blocked: this.backoff.isBlocked(), lastError: this.lastError };
  }

  /**
   * Queues the caller for a pacing slot; one dispatcher hands out slots in order, never before the 429 resume point,
   * and every "high" waiter goes before any "low" one. A slot already granted is never taken back, so a "low" call
   * that was alone in the queue still runs at once.
   */
  private waitTurn(priority: PacedRpcPriority): Promise<void> {
    return new Promise<void>((grant) => {
      this.waiters = [...this.waiters, { priority, grant }];
      void this.dispatch();
    });
  }

  private async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.waiters.length > 0) {
        const at = Math.max(this.now(), this.nextSlot, this.resumeAt);
        const wait = at - this.now();
        if (wait > 0) await sleep(wait);
        if (this.backoff.isBlocked()) {
          if (this.resumeAt <= this.now()) await sleep(this.gapMs);
          continue;
        }
        const index = this.waiters.findIndex((waiter) => waiter.priority === "high");
        const next = this.waiters[index >= 0 ? index : 0];
        this.waiters = this.waiters.filter((waiter) => waiter !== next);
        this.nextSlot = this.now() + this.gapMs;
        next.grant();
      }
    } finally {
      this.dispatching = false;
    }
  }

  private async post(method: string, params: unknown[]): Promise<unknown> {
    this.counters = { ...this.counters, calls: this.counters.calls + 1 };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: RPC_HEADERS,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new UpstreamError(`${this.label} ${method}: upstream returned ${response.status}`, response.status);
      return parseResult(this.label, method, text);
    } finally {
      clearTimeout(timeout);
    }
  }

  private noteError(error: unknown): void {
    this.lastError = errorMessage(error);
    this.backoff.noteError(error);
    if (!isRateLimit(error)) return;
    this.resumeAt = this.now() + this.backoffMs;
    this.counters = { ...this.counters, rateLimited: this.counters.rateLimited + 1 };
  }
}
