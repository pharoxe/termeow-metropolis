import { errorMessage } from "../../lib/http.js";
import { hintedBlockTimeMs } from "./blockHints.js";
import { evmRpc, hexToNumber, toHexQuantity } from "./rpc.js";
import { robinhoodRpcFetch } from "./rpcPool.js";

export const DEFAULT_BLOCK_CACHE_MAX = 5_000;
/** Attempts per block before giving up: a 429 or a lagging node must not drop the swap logs that cite this block. */
export const BLOCK_RETRY_ATTEMPTS = 3;
/** Wait before the second attempt; doubles per attempt (500ms, 1s). */
export const BLOCK_RETRY_BASE_MS = 500;

export type BlockTimeCacheOptions = {
  rpcUrl: string;
  fetchImpl?: typeof fetch;
  max?: number;
  retryAttempts?: number;
  retryBaseMs?: number;
};

export type BlockTimeStats = {
  cached: number;
  inFlight: number;
  hits: number;
  misses: number;
  failures: number;
  lastError: string | null;
};

function blockTimestamp(result: unknown): number | null {
  if (result === null || result === undefined) return null;
  const record = typeof result === "object" ? (result as Record<string, unknown>) : {};
  return hexToNumber(record.timestamp);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Block number -> ms timestamp via eth_getBlockByNumber(n, false). The official RPC's logs carry blockTimestamp 0x0,
 * so this is the honest clock for a print; a block the websocket transport has already timed (newHeads header, see
 * blockHints.ts) is taken from there first and costs no request. LRU-bounded, one request per block in flight, retried with a short
 * backoff before a miss is reported, never throws.
 */
export class BlockTimeCache {
  private readonly rpcUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly max: number;
  private readonly retryAttempts: number;
  private readonly retryBaseMs: number;
  /** Insertion order is recency order: a hit re-inserts, eviction drops the first key. */
  private readonly entries = new Map<number, number>();
  private readonly inFlight = new Map<number, Promise<number | null>>();
  private counters = { hits: 0, misses: 0, failures: 0 };
  private lastError: string | null = null;

  constructor(opts: BlockTimeCacheOptions) {
    this.rpcUrl = opts.rpcUrl;
    this.fetchImpl = opts.fetchImpl ?? robinhoodRpcFetch;
    this.max = opts.max ?? DEFAULT_BLOCK_CACHE_MAX;
    this.retryAttempts = Math.max(1, opts.retryAttempts ?? BLOCK_RETRY_ATTEMPTS);
    this.retryBaseMs = opts.retryBaseMs ?? BLOCK_RETRY_BASE_MS;
  }

  /** ms epoch of the block, or null when it cannot be read (reason in stats().lastError). */
  async timeMs(blockNumber: number): Promise<number | null> {
    if (!Number.isInteger(blockNumber) || blockNumber < 0) {
      this.lastError = `invalid block number ${String(blockNumber)}`;
      return null;
    }
    const hit = this.entries.get(blockNumber);
    if (hit !== undefined) {
      this.counters = { ...this.counters, hits: this.counters.hits + 1 };
      this.entries.delete(blockNumber);
      this.entries.set(blockNumber, hit);
      return hit;
    }
    const pending = this.inFlight.get(blockNumber);
    if (pending) return pending;
    const hinted = hintedBlockTimeMs(blockNumber);
    if (hinted !== null) {
      this.store(blockNumber, hinted);
      return hinted;
    }
    const request = this.fetchBlock(blockNumber).finally(() => this.inFlight.delete(blockNumber));
    this.inFlight.set(blockNumber, request);
    return request;
  }

  stats(): BlockTimeStats {
    return { cached: this.entries.size, inFlight: this.inFlight.size, ...this.counters, lastError: this.lastError };
  }

  /** One miss = up to retryAttempts requests; every failure reason lands in lastError, the last one counts. */
  private async fetchBlock(blockNumber: number): Promise<number | null> {
    this.counters = { ...this.counters, misses: this.counters.misses + 1 };
    for (let attempt = 1; ; attempt += 1) {
      const ms = await this.attempt(blockNumber);
      if (ms !== null) {
        this.store(blockNumber, ms);
        return ms;
      }
      if (attempt >= this.retryAttempts) return this.fail();
      await sleep(this.retryBaseMs * 2 ** (attempt - 1));
    }
  }

  /** Null on any failure (HTTP, JSON-RPC error, unknown block), with the reason recorded in lastError. */
  private async attempt(blockNumber: number): Promise<number | null> {
    try {
      const result = await evmRpc(this.rpcUrl, "eth_getBlockByNumber", [toHexQuantity(blockNumber), false], this.fetchImpl);
      const seconds = blockTimestamp(result);
      if (seconds === null) {
        this.lastError = `block ${blockNumber} not found`;
        return null;
      }
      return seconds * 1000;
    } catch (error) {
      this.lastError = `block ${blockNumber}: ${errorMessage(error)}`;
      return null;
    }
  }

  private store(blockNumber: number, ms: number): void {
    this.entries.set(blockNumber, ms);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private fail(): null {
    this.counters = { ...this.counters, failures: this.counters.failures + 1 };
    return null;
  }
}
