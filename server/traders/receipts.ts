import { errorMessage } from "../lib/http.js";
import { LruMap } from "./lru.js";
import { PacedRpc, type PacedRpcStats } from "./pacedRpc.js";

export const DEFAULT_RECEIPT_CACHE_MAX = 5_000;
/** Paired with DEFAULT_CLASSIFIER_RPS: the two lanes plus the tape poller must stay under the public RPC ceiling. */
export const DEFAULT_RECEIPT_RPS = 2;

export type ReceiptLog = { address: string; topics: string[]; data: string; logIndex: string };

/** The receipt fields attribution reads; addresses and hashes lowercased, logs in node order. */
export type Receipt = {
  transactionHash: string;
  from: string;
  to: string | null;
  blockNumber: string;
  status: string | null;
  logs: ReceiptLog[];
};

export type ReceiptFetcherOptions = {
  rpcUrl: string;
  fetchImpl?: typeof fetch;
  /** Must agree with the timers in use (Date.now under vitest fake timers). */
  now?: () => number;
  rps?: number;
  /** LRU bound on cached receipts. */
  max?: number;
  backoffMs?: number;
};

export type ReceiptFetcherStats = {
  cached: number;
  pending: number;
  /** Receipts fetched and cached since start. */
  fetched: number;
  /** Lookups the node answered with null (unknown or not yet mined); not cached. */
  missing: number;
  /** Lookups that failed (HTTP, RPC error, malformed receipt); not cached. */
  failures: number;
  lastError: string | null;
  rpc: PacedRpcStats;
};

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

function lowerString(value: unknown): string | null {
  return typeof value === "string" ? value.toLowerCase() : null;
}

function normalizeLog(raw: unknown): ReceiptLog | null {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!row) return null;
  const address = lowerString(row.address);
  const data = typeof row.data === "string" ? row.data : null;
  const logIndex = typeof row.logIndex === "string" ? row.logIndex : null;
  const topics = Array.isArray(row.topics) && row.topics.every((topic) => typeof topic === "string") ? row.topics.map((topic) => topic.toLowerCase()) : null;
  if (address === null || data === null || logIndex === null || topics === null) return null;
  return { address, topics, data, logIndex };
}

/** Throws on a malformed receipt so the caller counts a failure instead of caching junk. */
export function normalizeReceipt(raw: unknown): Receipt {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!row) throw new Error("receipt: not an object");
  const transactionHash = lowerString(row.transactionHash);
  const from = lowerString(row.from);
  const blockNumber = typeof row.blockNumber === "string" ? row.blockNumber : null;
  if (transactionHash === null || from === null || blockNumber === null) throw new Error("receipt: missing transactionHash/from/blockNumber");
  if (!Array.isArray(row.logs)) throw new Error("receipt: logs is not an array");
  const logs = row.logs.map(normalizeLog);
  if (logs.some((log) => log === null)) throw new Error("receipt: malformed log entry");
  return { transactionHash, from, to: lowerString(row.to), blockNumber, status: typeof row.status === "string" ? row.status : null, logs: logs as ReceiptLog[] };
}

/**
 * eth_getTransactionReceipt by tx hash: LRU-cached, one request per hash in flight, paced through PacedRpc with the
 * shared 429 backoff. A null receipt (unknown / pending) and any failure answer null without caching, so a later
 * caller retries. Never throws.
 */
export class ReceiptFetcher {
  private readonly rpc: PacedRpc;
  private readonly cache: LruMap<string, Receipt>;
  private readonly inFlight = new Map<string, Promise<Receipt | null>>();
  private counters = { fetched: 0, missing: 0, failures: 0 };
  private lastError: string | null = null;

  constructor(opts: ReceiptFetcherOptions) {
    this.rpc = new PacedRpc({
      rpcUrl: opts.rpcUrl,
      label: "receipts",
      fetchImpl: opts.fetchImpl,
      now: opts.now,
      rps: opts.rps ?? DEFAULT_RECEIPT_RPS,
      backoffMs: opts.backoffMs
    });
    this.cache = new LruMap(opts.max ?? DEFAULT_RECEIPT_CACHE_MAX);
  }

  get(tx: string): Promise<Receipt | null> {
    const key = tx.trim().toLowerCase();
    if (!TX_HASH.test(key)) {
      this.lastError = `invalid tx hash ${tx}`;
      return Promise.resolve(null);
    }
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const request = this.fetch(key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  stats(): ReceiptFetcherStats {
    return { cached: this.cache.size, pending: this.inFlight.size, ...this.counters, lastError: this.lastError, rpc: this.rpc.stats() };
  }

  private async fetch(key: string): Promise<Receipt | null> {
    try {
      const result = await this.rpc.call("eth_getTransactionReceipt", [key]);
      if (result === null || result === undefined) {
        this.counters = { ...this.counters, missing: this.counters.missing + 1 };
        return null;
      }
      const receipt = normalizeReceipt(result);
      this.cache.set(key, receipt);
      this.counters = { ...this.counters, fetched: this.counters.fetched + 1 };
      return receipt;
    } catch (error) {
      this.counters = { ...this.counters, failures: this.counters.failures + 1 };
      this.lastError = `${key}: ${errorMessage(error)}`;
      return null;
    }
  }
}
