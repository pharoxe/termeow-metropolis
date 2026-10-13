import { NansenClient, type SmartMoneyTrade } from "../sources/nansen.js";
import { config } from "../config.js";
import { errorMessage } from "../lib/http.js";
import { isAddress } from "../tape/monad/rpc.js";

/**
 * Wallet labels for Monad traders. Two sources feed one book:
 *  - Nansen smart-money DEX trades on chain "monad" (trailing 24 h, refreshed every NANSEN_REFRESH_MS): every labelled
 *    trader becomes a smart-money wallet with its Nansen label as the handle;
 *  - the user's own watchlist (wallets armed in a monitor_wallet automation), labelled "watched".
 * New wallets from either source are handed to onTraders so the transfer legs start watching them at once.
 * get() is synchronous and schedules a background refresh when due; a failed load keeps the last-good entries.
 */
export const HANDLES_POPULATION = "Nansen smart money on Monad + your watchlist";
export const NANSEN_PROFILE_BASE = "https://app.nansen.ai/profiler?chain=monad&address=";
/** A failed Nansen load is retried after this instead of on every get(). */
export const HANDLES_RETRY_MS = 60_000;
const WATCHED_HANDLE = "watched";

export type HandleSource = "nansen" | "watchlist" | "learned";
export type HandleEntry = { handle: string; followers: number | null; profileUrl: string | null; source: HandleSource };
export type HandleSourceStatus = { rows: number; lastOkAt: number | null; lastError: string | null };
export type HandleBookStats = {
  entries: number;
  population: typeof HANDLES_POPULATION;
  nansen: HandleSourceStatus & { configured: boolean };
  watchlist: number;
  learned: number;
};
export type HandleDirectoryEntry = HandleEntry & { wallet: string };

export type SmartTradesSource = { configured: boolean; dexTrades(opts: { limit?: number }): Promise<{ data: SmartMoneyTrade[]; error: string | null }> };

export type HandleBookOptions = {
  now?: () => number;
  source?: SmartTradesSource;
  refreshMs?: number;
  /** Called with the lowercase wallets of every newly labelled or watched wallet (seeds the transfer-leg population). */
  onTraders?: (wallets: string[]) => void;
};

/** A richer source never loses to a poorer one; a source refreshing itself overwrites its own rows. */
const RANK: Record<HandleSource, number> = { nansen: 3, watchlist: 2, learned: 1 };

export function profileUrlFor(address: string): string {
  return `${NANSEN_PROFILE_BASE}${address}`;
}

export class HandleBook {
  private readonly now: () => number;
  private readonly source: SmartTradesSource;
  private readonly refreshMs: number;
  private readonly entries = new Map<string, HandleEntry>();
  private readonly onTraders: ((wallets: string[]) => void) | null;
  private status: HandleSourceStatus = { rows: 0, lastOkAt: null, lastError: null };
  private nextAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(opts: HandleBookOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.source = opts.source ?? new NansenClient({ apiKey: config.nansen.apiKey, apiUrl: config.nansen.apiUrl, now: this.now });
    this.refreshMs = opts.refreshMs ?? config.nansen.refreshMs;
    this.onTraders = opts.onTraders ?? null;
  }

  /** Known label for the wallet, or null; kicks off a background refresh when the Nansen population is due. */
  get(address: string): HandleEntry | null {
    if (this.source.configured && this.now() >= this.nextAt) void this.refresh();
    return this.entries.get(address.trim().toLowerCase()) ?? null;
  }

  /** True when the wallet is in the smart-money population or on a watchlist. */
  isTracked(address: string): boolean {
    return this.entries.has(address.trim().toLowerCase());
  }

  /** Adds wallets the user armed an automation on; they are tracked like smart money from now on. */
  watch(addresses: string[]): number {
    const fresh: string[] = [];
    for (const raw of addresses) {
      const key = raw.trim().toLowerCase();
      if (!isAddress(key)) continue;
      if (!this.entries.has(key)) fresh.push(key);
      this.merge(key, { handle: WATCHED_HANDLE, followers: null, profileUrl: profileUrlFor(key), source: "watchlist" });
    }
    if (fresh.length && this.onTraders) this.onTraders(fresh);
    return fresh.length;
  }

  /** A label seen on a print this server processed; fills gaps, never overrides a Nansen or watchlist entry. */
  learn(address: string, handle: string, followers: number | null): void {
    const key = address.trim().toLowerCase();
    const name = handle?.trim();
    if (!isAddress(key) || !name) return;
    this.merge(key, { handle: name, followers: Number.isFinite(followers) ? followers : null, profileUrl: profileUrlFor(key), source: "learned" });
  }

  /** Loads the Nansen population when due (always when `force`); one refresh in flight at a time; never rejects. */
  refresh(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.source.configured || (!force && this.now() < this.nextAt)) return Promise.resolve();
    this.inFlight = this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Restart persistence: watchlist and learned entries (the Nansen population refetches itself). */
  learned(): [string, HandleEntry][] {
    return [...this.entries].filter(([, entry]) => entry.source !== "nansen");
  }

  restoreLearned(entries: [string, HandleEntry][]): number {
    let applied = 0;
    const watched: string[] = [];
    for (const [address, entry] of entries) {
      const key = address.trim().toLowerCase();
      if (!isAddress(key) || !entry?.handle || (entry.source !== "learned" && entry.source !== "watchlist")) continue;
      this.merge(key, { ...entry, profileUrl: profileUrlFor(key) });
      if (entry.source === "watchlist") watched.push(key);
      applied += 1;
    }
    if (watched.length && this.onTraders) this.onTraders(watched);
    return applied;
  }

  stats(): HandleBookStats {
    const values = [...this.entries.values()];
    return {
      entries: this.entries.size,
      population: HANDLES_POPULATION,
      nansen: { ...this.status, configured: this.source.configured },
      watchlist: values.filter((entry) => entry.source === "watchlist").length,
      learned: values.filter((entry) => entry.source === "learned").length
    };
  }

  /** Directory for agent disambiguation: labelled wallets first, alphabetical by label. */
  directory(limit = 500): HandleDirectoryEntry[] {
    return [...this.entries].map(([wallet, entry]) => ({ wallet, ...entry }))
      .sort((a, b) => RANK[b.source] - RANK[a.source] || a.handle.localeCompare(b.handle))
      .slice(0, Math.max(1, Math.min(500, Math.trunc(limit))));
  }

  private merge(address: string, entry: HandleEntry): void {
    const existing = this.entries.get(address);
    if (existing && RANK[existing.source] > RANK[entry.source]) return;
    this.entries.set(address, entry);
  }

  private async load(): Promise<void> {
    try {
      const result = await this.source.dexTrades({ limit: 500 });
      if (result.error && !result.data.length) throw new Error(result.error);
      const fresh: string[] = [];
      let rows = 0;
      for (const trade of result.data) {
        // Every trader on the smart-money DEX-trades endpoint is in a Nansen smart-money cohort; the label names which.
        const label = trade.label?.trim() || "Smart Money";
        rows += 1;
        if (!this.entries.has(trade.trader)) fresh.push(trade.trader);
        this.merge(trade.trader, { handle: label, followers: null, profileUrl: profileUrlFor(trade.trader), source: "nansen" });
      }
      this.status = { rows, lastOkAt: this.now(), lastError: result.error };
      this.nextAt = this.now() + this.refreshMs;
      if (fresh.length && this.onTraders) this.onTraders([...new Set(fresh)]);
    } catch (error) {
      this.status = { ...this.status, lastError: `nansen: ${errorMessage(error)}` };
      this.nextAt = this.now() + HANDLES_RETRY_MS;
    }
  }
}
