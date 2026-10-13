import { config } from "../config.js";
import { errorMessage } from "../lib/http.js";
import { isAddress, isRevert } from "../tape/monad/rpc.js";
import { LruMap } from "./lru.js";
import { PacedRpc, type PacedRpcPriority, type PacedRpcStats } from "./pacedRpc.js";

export const DECIMALS_SELECTOR = "0x313ce567";
export const SYMBOL_SELECTOR = "0x95d89b41";
export const DEFAULT_ERC20_META_MAX = 5_000;
/** Own lane, low priority: ~11 new tokens per 10 min measured, two eth_calls each, so 2 rps is never saturated. */
export const DEFAULT_ERC20_META_RPS = 2;
/** A token whose lookups failed (HTTP, 429 after retry, malformed) is retried no sooner than this. */
export const ERC20_META_RETRY_MS = 10 * 60_000;
const MAX_TEXT = 64;
const WORD_HEX = 64;

export type Erc20MetaEntry = { decimals: number | null; symbol: string | null; resolvedAt: number };
export type Erc20MetaStats = { cached: number; pending: number; resolved: number; failed: number; lastError: string | null; rpc: PacedRpcStats | null };
export type Erc20MetaRpc = { call(method: string, params: unknown[], priority?: PacedRpcPriority): Promise<unknown>; stats?(): PacedRpcStats };

export type Erc20MetaOptions = {
  rpcUrl?: string;
  rpc?: Erc20MetaRpc;
  now?: () => number;
  max?: number;
  retryMs?: number;
};

function stripHex(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function utf8(hex: string): string | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const text = Buffer.from(hex, "hex").toString("utf8").replace(/\0+$/g, "").trim();
  return text.length > 0 && text.length <= MAX_TEXT && !text.includes("�") ? text : null;
}

/** uint8 return word; null for empty ("0x") or malformed data or a value past 255. */
export function decodeAbiUint8(hex: string): number | null {
  const raw = stripHex(hex);
  if (raw.length !== WORD_HEX || !/^[0-9a-fA-F]+$/.test(raw)) return null;
  const value = BigInt(`0x${raw}`);
  return value <= 255n ? Number(value) : null;
}

/** ABI string (offset, length, bytes) or a bare bytes32 (older tokens); null when empty, malformed or not readable UTF-8. */
export function decodeAbiString(hex: string): string | null {
  const raw = stripHex(hex);
  if (raw.length === 0 || raw.length % WORD_HEX !== 0 || !/^[0-9a-fA-F]+$/.test(raw)) return null;
  if (raw.length === WORD_HEX) return utf8(raw.replace(/(00)+$/, ""));
  const offset = Number(BigInt(`0x${raw.slice(0, WORD_HEX)}`)) * 2;
  if (!Number.isSafeInteger(offset) || offset + WORD_HEX > raw.length) return null;
  const length = Number(BigInt(`0x${raw.slice(offset, offset + WORD_HEX)}`)) * 2;
  if (!Number.isSafeInteger(length) || length === 0 || offset + WORD_HEX + length > raw.length) return null;
  return utf8(raw.slice(offset + WORD_HEX, offset + WORD_HEX + length));
}

/**
 * decimals()/symbol() per ERC-20 via eth_call on a low-priority paced lane, LRU-cached forever once read.
 * get() is synchronous and answers null until resolve() has finished; a revert leaves that field null, any other failure
 * leaves the token unresolved and retried after `retryMs`. Nothing here throws or blocks a caller.
 */
export class Erc20Meta {
  private readonly rpc: Erc20MetaRpc;
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly entries: LruMap<string, Erc20MetaEntry>;
  private readonly failedUntil: LruMap<string, number>;
  private readonly inFlight = new Map<string, Promise<Erc20MetaEntry | null>>();
  private counters = { resolved: 0, failed: 0 };
  private lastError: string | null = null;

  constructor(opts: Erc20MetaOptions = {}) {
    this.rpc = opts.rpc ?? new PacedRpc({ rpcUrl: opts.rpcUrl ?? config.monad.rpcUrl, label: "erc20Meta", now: opts.now, rps: DEFAULT_ERC20_META_RPS });
    this.now = opts.now ?? (() => Date.now());
    this.retryMs = opts.retryMs ?? ERC20_META_RETRY_MS;
    this.entries = new LruMap(opts.max ?? DEFAULT_ERC20_META_MAX);
    this.failedUntil = new LruMap(opts.max ?? DEFAULT_ERC20_META_MAX);
  }

  /** Cached metadata, or null when never resolved (call resolve() to schedule it). */
  get(token: string): Erc20MetaEntry | null {
    return this.entries.get(token.toLowerCase()) ?? null;
  }

  /** Resolves (or joins the lookup in flight for) one token; null when the lookups failed or the address is malformed. */
  resolve(token: string): Promise<Erc20MetaEntry | null> {
    const address = token.trim().toLowerCase();
    if (!isAddress(address)) return Promise.resolve(null);
    const hit = this.entries.get(address);
    if (hit) return Promise.resolve(hit);
    const retryAt = this.failedUntil.get(address);
    if (retryAt !== undefined && this.now() < retryAt) return Promise.resolve(null);
    const pending = this.inFlight.get(address);
    if (pending) return pending;
    const request = this.lookup(address).finally(() => this.inFlight.delete(address));
    this.inFlight.set(address, request);
    return request;
  }

  stats(): Erc20MetaStats {
    return { cached: this.entries.size, pending: this.inFlight.size, ...this.counters, lastError: this.lastError, rpc: this.rpc.stats?.() ?? null };
  }

  /** Restart persistence: resolved entries, oldest first (on-chain facts; resolvedAt stays the time they were read). */
  snapshot(): [string, Erc20MetaEntry][] {
    return [...this.entries.entriesOldestFirst()];
  }

  /** Puts saved entries back without RPC; an entry already resolved in this process wins. Returns how many were added. */
  restore(entries: [string, Erc20MetaEntry][]): number {
    let added = 0;
    for (const [token, entry] of entries) {
      const address = token.trim().toLowerCase();
      if (!isAddress(address) || this.entries.has(address)) continue;
      this.entries.set(address, { ...entry });
      added += 1;
    }
    return added;
  }

  private async lookup(address: string): Promise<Erc20MetaEntry | null> {
    try {
      const decimals = await this.view(address, DECIMALS_SELECTOR);
      const symbol = await this.view(address, SYMBOL_SELECTOR);
      const entry: Erc20MetaEntry = { decimals: decimals === null ? null : decodeAbiUint8(decimals), symbol: symbol === null ? null : decodeAbiString(symbol), resolvedAt: this.now() };
      this.entries.set(address, entry);
      this.failedUntil.delete(address);
      this.counters = { ...this.counters, resolved: this.counters.resolved + 1 };
      return entry;
    } catch (error) {
      this.counters = { ...this.counters, failed: this.counters.failed + 1 };
      this.lastError = `${address}: ${errorMessage(error)}`;
      this.failedUntil.set(address, this.now() + this.retryMs);
      return null;
    }
  }

  /** Raw return data, or null when the call reverted (the token lacks that view); other errors propagate. */
  private async view(address: string, selector: string): Promise<string | null> {
    try {
      const result = await this.rpc.call("eth_call", [{ to: address, data: selector }, "latest"], "low");
      if (typeof result !== "string") throw new Error(`eth_call ${selector}: non-string result`);
      return result;
    } catch (error) {
      if (isRevert(error)) return null;
      throw error;
    }
  }
}
