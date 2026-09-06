import type { TraderKind } from "../../shared/wire.js";
import { errorMessage } from "../lib/http.js";
import { isAddress } from "../tape/robinhood/rpc.js";
import { LruMap } from "./lru.js";
import { PacedRpc, type PacedRpcPriority, type PacedRpcStats } from "./pacedRpc.js";

/**
 * eth_getCode of a fomo.family wallet on Robinhood Chain: EIP-7702 delegation designator (0xef0100 || delegate).
 * Measured 2026-09-06: 24/24 sampled trader wallets carried exactly this code; of 30 robinhoodtrenches tape wallets
 * captured in __fixtures__/codes.json, 28 carried it and 2 lookups 429d (code null, a failure rather than a classification).
 */
export const FOMO_DESIGNATOR = "0xef0100e6cae83bde06e4c305530e199d7217f42808555b";
export const FOMO_DELEGATE = "0xe6cae83bde06e4c305530e199d7217f42808555b";
export const DEFAULT_CLASSIFIER_MAX = 20_000;
/** 4 rps classify + 4 rps receipts + the tape poller drew a 429 block every ~25 s from the public RPC (2026-09-06); 2+2 shares the IP. */
export const DEFAULT_CLASSIFIER_RPS = 2;

/** True only for the exact FOMO designator; an EOA ("0x"), a contract, or another 7702 delegate is "other". */
export function isFomoCode(code: unknown): boolean {
  return typeof code === "string" && code.trim().toLowerCase() === FOMO_DESIGNATOR;
}

export type AccountClassifierOptions = {
  rpcUrl: string;
  fetchImpl?: typeof fetch;
  /** Must agree with the timers in use (Date.now under vitest fake timers). */
  now?: () => number;
  /** LRU bound on cached classifications (positive and negative). */
  max?: number;
  rps?: number;
  backoffMs?: number;
};

export type AccountClassifierStats = {
  /** Classifications held right now (LRU-bounded). */
  cached: number;
  /** Cumulative results by kind since start; evictions do not decrement these. */
  fomo: number;
  other: number;
  pending: number;
  /** Lookups that failed after the paced retry (not cached; classify() returned null). */
  failures: number;
  lastError: string | null;
  rpc: PacedRpcStats;
};

/**
 * Wallet -> "fomo" | "other" by eth_getCode against FOMO_DESIGNATOR. Both outcomes cache forever (a wallet's delegation
 * is stable enough for a session), one lookup in flight per address, every lookup paced through PacedRpc with the
 * shared 429 backoff. A failed lookup returns null and is NOT cached, so the next caller retries. Never throws.
 */
export class AccountClassifier {
  private readonly rpc: PacedRpc;
  private readonly cache: LruMap<string, TraderKind>;
  private readonly inFlight = new Map<string, Promise<TraderKind | null>>();
  private counters = { fomo: 0, other: 0, failures: 0 };
  private lastError: string | null = null;

  constructor(opts: AccountClassifierOptions) {
    this.rpc = new PacedRpc({
      rpcUrl: opts.rpcUrl,
      label: "eth_getCode",
      fetchImpl: opts.fetchImpl,
      now: opts.now,
      rps: opts.rps ?? DEFAULT_CLASSIFIER_RPS,
      backoffMs: opts.backoffMs
    });
    this.cache = new LruMap(opts.max ?? DEFAULT_CLASSIFIER_MAX);
  }

  /**
   * Kind for the wallet, or null when the lookup failed or the address is malformed (reason in stats().lastError).
   * `priority: "low"` (discovery) yields the RPC slot to per-print lookups still waiting.
   */
  classify(address: string, opts: { priority?: PacedRpcPriority } = {}): Promise<TraderKind | null> {
    const key = address.trim().toLowerCase();
    if (!isAddress(key)) {
      this.lastError = `invalid address ${address}`;
      return Promise.resolve(null);
    }
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const request = this.lookup(key, opts.priority ?? "high").finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  /** Distinct addresses through the same pacing; the map is keyed by lowercase address. */
  async classifyMany(addresses: string[]): Promise<Map<string, TraderKind | null>> {
    const distinct = [...new Set(addresses.map((address) => address.trim().toLowerCase()))];
    const entries = await Promise.all(
      distinct.map(async (address): Promise<[string, TraderKind | null]> => [address, await this.classify(address)])
    );
    return new Map(entries);
  }

  /** Cached kind without a lookup; undefined when never classified (or evicted). */
  peek(address: string): TraderKind | undefined {
    return this.cache.get(address.trim().toLowerCase());
  }

  stats(): AccountClassifierStats {
    return { cached: this.cache.size, ...this.counters, pending: this.inFlight.size, lastError: this.lastError, rpc: this.rpc.stats() };
  }

  private async lookup(key: string, priority: PacedRpcPriority): Promise<TraderKind | null> {
    try {
      const code = await this.rpc.call("eth_getCode", [key, "latest"], priority);
      if (typeof code !== "string") throw new Error("eth_getCode: non-string result");
      const kind: TraderKind = isFomoCode(code) ? "fomo" : "other";
      this.cache.set(key, kind);
      this.counters = { ...this.counters, [kind]: this.counters[kind] + 1 };
      return kind;
    } catch (error) {
      this.counters = { ...this.counters, failures: this.counters.failures + 1 };
      this.lastError = `${key}: ${errorMessage(error)}`;
      return null;
    }
  }
}
