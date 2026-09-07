import type { Chain, Side } from "../../shared/wire.js";
import {
  emptyWallet,
  foldWallet,
  toRow,
  toStats,
  type TraderFill,
  type TraderKind,
  type TraderRow,
  type TraderStats,
  type WalletState
} from "./walletStats.js";

export type { TraderFill, TraderKind, TraderRow, TraderStats } from "./walletStats.js";

export const DEFAULT_MAX_WALLETS = 5000;
export const DEFAULT_FILL_RING = 20_000;
export const DEFAULT_MAX_TOKENS_PER_WALLET = 200;

export type ChainScope = Chain | "all";

export type TraderBookOptions = {
  /** Wallet cap across chains; least-recently-seen wallets are evicted first. */
  max?: number;
  /** Fill ring cap across chains; oldest-by-time fills drop first. Also bounds the dedupe set. */
  fills?: number;
  /** Distinct tokens tracked per wallet; oldest-inserted position drops first. */
  maxTokens?: number;
  now?: () => number;
};

export type RecordOutcome = "accepted" | "duplicate" | "rejected";
export type RecordResult = { accepted: number; duplicates: number; rejected: number };

/** A single kind or a list of kinds to keep (e.g. ["fomo", "seeded"]); undefined keeps every row. */
export type KindFilter = TraderKind | readonly TraderKind[];
export type RankOptions = { kind?: KindFilter };
export type TapeOptions = { kind?: KindFilter; token?: string };

export type TraderTapeRow = {
  chain: Chain;
  trader: string;
  handle: string | null;
  kind: TraderKind | null;
  token: string;
  pair: string;
  tx: string;
  side: Side;
  usd: number | null;
  time: number;
  /** USD per token at the fill when the source carried one (R4 transfer fills); null otherwise. */
  price: number | null;
  /** Provenance of usd for transfer-decoded fills; absent otherwise. */
  usdVia?: TraderFill["usdVia"];
};

export type BookSize = { wallets: number; fills: number };

export function walletKey(chain: string, wallet: string): string {
  return `${chain}:${wallet}`;
}

function fillKey(fill: TraderFill): string {
  return `${fill.chain}:${fill.tx}:${fill.pair}:${fill.trader}:${fill.side}`;
}

/** The same fill seen under two pair ids (R3 pool attribution vs R4 "fomo:<token>" transfer decode) must count once. */
function tradeKey(fill: Pick<TraderFill, "chain" | "tx" | "trader" | "token" | "side">): string {
  return `${fill.chain}:${fill.tx}:${fill.trader}:${fill.token}:${fill.side}`;
}

function isValidFill(fill: TraderFill): boolean {
  return (
    typeof fill.trader === "string" &&
    fill.trader.length > 0 &&
    typeof fill.token === "string" &&
    fill.token.length > 0 &&
    typeof fill.tx === "string" &&
    fill.tx.length > 0 &&
    Number.isFinite(fill.time) &&
    (fill.side === "buy" || fill.side === "sell")
  );
}

function inScope(chain: ChainScope, fill: { chain: Chain }): boolean {
  return chain === "all" || fill.chain === chain;
}

function kindAllowed(filter: KindFilter | undefined, kind: TraderKind | null): boolean {
  if (filter === undefined) return true;
  return typeof filter === "string" ? kind === filter : kind !== null && filter.includes(kind);
}

/** Inserts `fill` keeping `ring` ascending by time, then trims the oldest entries down to `cap`. */
function insertByTime(ring: TraderFill[], fill: TraderFill, cap: number): void {
  let i = ring.length;
  while (i > 0 && ring[i - 1].time > fill.time) i -= 1;
  ring.splice(i, 0, fill);
  if (ring.length > cap) ring.splice(0, ring.length - cap);
}

function byNetUsdDesc(a: TraderRow, b: TraderRow): number {
  return b.netUsd - a.netUsd || b.lastSeenAt - a.lastSeenAt || a.wallet.localeCompare(b.wallet);
}

/**
 * In-memory per-wallet trader book. Lifetime stats live per (chain, wallet); windowed ranks are re-folded
 * from the fill ring, so a window longer than the ring's coverage (`oldestFillAt`) is truncated, not lifetime.
 * Every population here is "wallets seen by this server"; no fetch, no clock of its own.
 */
export class TraderBook {
  private readonly maxWallets: number;
  private readonly fillRing: number;
  private readonly maxTokens: number;
  private readonly now: () => number;
  /** Insertion order doubles as LRU order: most recently recorded wallet is last. */
  private readonly wallets = new Map<string, WalletState>();
  /** Accepted fills ascending by time; duplicates never enter. */
  private readonly ring: TraderFill[] = [];
  /** Insertion-ordered dedupe keys, two per accepted fill (fillKey + tradeKey), so bounded to twice the fill ring. */
  private readonly seen = new Set<string>();

  constructor(opts: TraderBookOptions = {}) {
    this.maxWallets = opts.max ?? DEFAULT_MAX_WALLETS;
    this.fillRing = opts.fills ?? DEFAULT_FILL_RING;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS_PER_WALLET;
    this.now = opts.now ?? (() => Date.now());
  }

  record(fill: TraderFill): RecordOutcome {
    if (!isValidFill(fill)) return "rejected";
    const keys = [fillKey(fill), tradeKey(fill)];
    if (keys.some((key) => this.seen.has(key))) return "duplicate";
    for (const key of keys) this.remember(key);
    const state = this.touch(fill);
    foldWallet(state, fill, this.maxTokens);
    insertByTime(this.ring, fill, this.fillRing);
    this.evictWallets();
    return "accepted";
  }

  /** Sets the kind of a wallet already in the book (a seeded wallet whose 7702 check finished after its first fill); false when unknown here. */
  classify(chain: Chain, wallet: string, kind: TraderKind): boolean {
    const state = this.wallets.get(walletKey(chain, wallet));
    if (!state) return false;
    state.identity = { ...state.identity, kind };
    return true;
  }

  recordAll(fills: TraderFill[]): RecordResult {
    const result = { accepted: 0, duplicates: 0, rejected: 0 };
    for (const fill of fills) {
      const outcome = this.record(fill);
      if (outcome === "accepted") result.accepted += 1;
      else if (outcome === "duplicate") result.duplicates += 1;
      else result.rejected += 1;
    }
    return result;
  }

  /** Lifetime stats for one wallet as seen by this server, or null when never recorded. */
  stats(chain: Chain, wallet: string): TraderStats | null {
    const state = this.wallets.get(walletKey(chain, wallet));
    return state ? toStats(state) : null;
  }

  /**
   * Rows sorted by netUsd (buyUsd - sellUsd) desc. A finite `windowMs` re-folds fills with
   * time >= now - windowMs from the ring; a non-finite window returns lifetime stats.
   */
  rank(chain: ChainScope, windowMs: number, opts: RankOptions = {}): TraderRow[] {
    const states = Number.isFinite(windowMs)
      ? this.windowStates(chain, this.now() - windowMs)
      : [...this.wallets.values()].filter((state) => inScope(chain, state));
    return states
      .map(toRow)
      .filter((row) => kindAllowed(opts.kind, row.kind))
      .sort(byNetUsdDesc);
  }

  /** Newest fills first, at most `limit`, optionally narrowed by wallet kind and/or token. */
  tape(chain: ChainScope, limit: number, opts: TapeOptions = {}): TraderTapeRow[] {
    if (!(limit > 0)) return [];
    const out: TraderTapeRow[] = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const fill = this.ring[i];
      if (!inScope(chain, fill)) continue;
      if (opts.token !== undefined && fill.token !== opts.token) continue;
      const identity = this.wallets.get(walletKey(fill.chain, fill.trader))?.identity;
      const kind = identity?.kind ?? fill.kind ?? null;
      if (!kindAllowed(opts.kind, kind)) continue;
      out.push(toTapeRow(fill, identity?.handle ?? fill.handle ?? null, kind));
    }
    return out;
  }

  /** Every ring fill of one (chain, wallet), oldest first, as recorded (per-fill kind may be stale; identity holds the current one). Fills already evicted from the ring are gone. */
  fillsOf(chain: Chain, wallet: string): TraderFill[] {
    return this.ring.filter((fill) => fill.chain === chain && fill.trader === wallet);
  }

  /** Oldest fill time still in the ring; a window reaching past it is truncated. Null when empty. */
  oldestFillAt(): number | null {
    return this.ring.length > 0 ? this.ring[0].time : null;
  }

  size(): BookSize {
    return { wallets: this.wallets.size, fills: this.ring.length };
  }

  private windowStates(chain: ChainScope, since: number): WalletState[] {
    const out = new Map<string, WalletState>();
    for (let i = this.ring.length - 1; i >= 0; i -= 1) {
      const fill = this.ring[i];
      if (fill.time < since) break;
      if (!inScope(chain, fill)) continue;
      const key = walletKey(fill.chain, fill.trader);
      const state = out.get(key) ?? emptyWallet(fill);
      foldWallet(state, fill, this.maxTokens);
      out.set(key, state);
    }
    for (const state of out.values()) {
      const lifetime = this.wallets.get(walletKey(state.chain, state.wallet));
      if (lifetime) state.identity = lifetime.identity;
    }
    return [...out.values()];
  }

  private touch(fill: TraderFill): WalletState {
    const key = walletKey(fill.chain, fill.trader);
    const existing = this.wallets.get(key);
    if (existing) this.wallets.delete(key);
    const state = existing ?? emptyWallet(fill);
    this.wallets.set(key, state);
    return state;
  }

  /** Only accepted fills leave keys behind, so a rejected duplicate never evicts live memory. */
  private remember(key: string): void {
    this.seen.add(key);
    while (this.seen.size > this.fillRing * 2) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  private evictWallets(): void {
    while (this.wallets.size > this.maxWallets) {
      const oldest = this.wallets.keys().next().value;
      if (oldest === undefined) break;
      this.wallets.delete(oldest);
    }
  }
}

function toTapeRow(fill: TraderFill, handle: string | null, kind: TraderKind | null): TraderTapeRow {
  return {
    chain: fill.chain,
    trader: fill.trader,
    handle,
    kind,
    token: fill.token,
    pair: fill.pair,
    tx: fill.tx,
    side: fill.side,
    usd: fill.usd,
    time: fill.time,
    price: fill.price ?? null,
    ...(fill.usdVia ? { usdVia: fill.usdVia } : {})
  };
}
