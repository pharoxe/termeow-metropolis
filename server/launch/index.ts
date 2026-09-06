import type { Chain, LaunchRow } from "../../shared/wire.js";

export const DEFAULT_MAX_LAUNCHES = 3_000;
/** Launchpad recorded when a row is first seen through enrichment before any on-chain create event named its pad. */
export const UNKNOWN_LAUNCHPAD = "unknown";

export type TradeSide = "buy" | "sell";

/**
 * Fields a source may contribute. `chain` + `token` key the row; everything else merges field-by-field, null and undefined
 * never overwrite a known value. `isStock` is index-side metadata (robinhoodtrenches `is_stock`), not part of the wire row.
 */
export type LaunchUpsert = Pick<LaunchRow, "chain" | "token"> & Partial<Omit<LaunchRow, "chain" | "token">> & { isStock?: boolean };

export type LaunchListQuery = {
  chain: "all" | Chain;
  windowMs: number;
  pad?: string;
  /** Default true. `false` hides rows a source flagged as tokenised stocks. */
  includeStocks?: boolean;
  limit?: number;
};

export type LaunchIndexOptions = { max?: number; now?: () => number };

export type LaunchIndexStats = {
  rows: number;
  max: number;
  evicted: number;
  byChain: Record<Chain, number>;
  byPad: Record<string, number>;
  graduated: number;
  oldestCreatedAt: number | null;
  newestCreatedAt: number | null;
};

export function launchKey(chain: Chain, token: string): string {
  return `${chain}:${token.toLowerCase()}`;
}

function unionSources(existing: string[], incoming: string[] | undefined): string[] {
  if (!incoming || incoming.length === 0) return existing;
  const merged = [...existing];
  for (const source of incoming) if (!merged.includes(source)) merged.push(source);
  return merged;
}

/** Copies every provided non-null, non-undefined scalar/object field of `patch` onto a new row; counters and sources are handled by the caller. */
function mergeFields(row: LaunchRow, patch: Partial<LaunchRow>): LaunchRow {
  const next: Record<string, unknown> = { ...row };
  for (const [field, value] of Object.entries(patch)) {
    if (field === "chain" || field === "token" || field === "sources" || field === "observedAt") continue;
    if (value === null || value === undefined) continue;
    next[field] = value;
  }
  return next as LaunchRow;
}

function newRow(input: LaunchUpsert, observedAt: number): LaunchRow {
  return {
    chain: input.chain,
    launchpad: input.launchpad ?? UNKNOWN_LAUNCHPAD,
    token: input.token,
    symbol: input.symbol ?? null,
    name: input.name ?? null,
    image: input.image ?? null,
    creator: input.creator ?? null,
    curve: input.curve ?? null,
    pool: input.pool ?? null,
    createdAt: input.createdAt ?? observedAt,
    tx: input.tx ?? "",
    graduatedAt: input.graduatedAt ?? null,
    priceUsd: input.priceUsd ?? null,
    marketCapUsd: input.marketCapUsd ?? null,
    liquidityUsd: input.liquidityUsd ?? null,
    volume24Usd: input.volume24Usd ?? null,
    change24Pct: input.change24Pct ?? null,
    pricedAt: input.pricedAt ?? null,
    curveBuys: input.curveBuys ?? 0,
    curveSells: input.curveSells ?? 0,
    curveNetUsd: input.curveNetUsd ?? null,
    tracked: input.tracked ?? null,
    sources: unionSources([], input.sources),
    observedAt
  };
}

function newestFirst(a: LaunchRow, b: LaunchRow): number {
  return b.createdAt - a.createdAt || b.observedAt - a.observedAt;
}

/**
 * In-memory index of launchpad tokens across chains. Rows are immutable snapshots replaced on every write, keyed by
 * chain + lowercase token (the stored `token` keeps its first-seen case, which matters for Solana mints). Bounded by
 * `max`: the row with the oldest `createdAt` is evicted first, so a stale token surfaced late by enrichment cannot
 * displace a fresh launch. Nothing here throws on unknown tokens; writes to them return false.
 */
export class LaunchIndex {
  private readonly max: number;
  private readonly now: () => number;
  private readonly rows = new Map<string, LaunchRow>();
  private readonly stocks = new Set<string>();
  private evicted = 0;

  constructor(opts: LaunchIndexOptions = {}) {
    this.max = Math.max(1, Math.floor(opts.max ?? DEFAULT_MAX_LAUNCHES));
    this.now = opts.now ?? (() => Date.now());
  }

  /** Creates or merges a row; returns the stored snapshot. Missing required scalars on creation default to `unknown`, now, "". */
  upsert(input: LaunchUpsert): LaunchRow {
    const key = launchKey(input.chain, input.token);
    const observedAt = this.now();
    const existing = this.rows.get(key);
    const { isStock, ...patch } = input;
    const merged = existing ? mergeFields(existing, patch) : newRow(input, observedAt);
    const row: LaunchRow = { ...merged, sources: existing ? unionSources(existing.sources, patch.sources) : merged.sources, observedAt };
    if (isStock === true) this.stocks.add(key);
    else if (isStock === false) this.stocks.delete(key);
    this.rows.set(key, row);
    this.evict();
    return this.rows.get(key) ?? row;
  }

  /** Counts a curve-phase trade. Unpriced trades (usd null) still count; only priced ones move `curveNetUsd`. */
  recordTrade(chain: Chain, token: string, side: TradeSide, usd: number | null): boolean {
    const key = launchKey(chain, token);
    const row = this.rows.get(key);
    if (!row) return false;
    const priced = usd !== null && Number.isFinite(usd);
    const signed = priced ? (side === "buy" ? usd : -usd) : 0;
    const net = priced ? (row.curveNetUsd ?? 0) + signed : row.curveNetUsd;
    this.rows.set(key, {
      ...row,
      curveBuys: row.curveBuys + (side === "buy" ? 1 : 0),
      curveSells: row.curveSells + (side === "sell" ? 1 : 0),
      curveNetUsd: net,
      observedAt: this.now()
    });
    return true;
  }

  recordGraduation(chain: Chain, token: string, at: number, pool: string | null): boolean {
    const key = launchKey(chain, token);
    const row = this.rows.get(key);
    if (!row) return false;
    this.rows.set(key, { ...row, graduatedAt: at, pool: pool ?? row.pool, observedAt: this.now() });
    return true;
  }

  get(chain: Chain, token: string): LaunchRow | null {
    return this.rows.get(launchKey(chain, token)) ?? null;
  }

  /** Rows created within `windowMs` of now, newest first. */
  list(query: LaunchListQuery): LaunchRow[] {
    const since = this.now() - Math.max(0, query.windowMs);
    const includeStocks = query.includeStocks ?? true;
    const out: LaunchRow[] = [];
    for (const [key, row] of this.rows) {
      if (row.createdAt < since) continue;
      if (query.chain !== "all" && row.chain !== query.chain) continue;
      if (query.pad !== undefined && row.launchpad !== query.pad) continue;
      if (!includeStocks && this.stocks.has(key)) continue;
      out.push(row);
    }
    out.sort(newestFirst);
    return query.limit !== undefined ? out.slice(0, Math.max(0, query.limit)) : out;
  }

  /** Token addresses on `chain` created within `sinceMs`, newest first — the enrichment batch. */
  tokens(chain: Chain, sinceMs: number): string[] {
    return this.list({ chain, windowMs: sinceMs }).map((row) => row.token);
  }

  stats(): LaunchIndexStats {
    const byChain: Record<Chain, number> = { solana: 0, robinhood: 0 };
    const byPad: Record<string, number> = {};
    let graduated = 0;
    let oldest: number | null = null;
    let newest: number | null = null;
    for (const row of this.rows.values()) {
      byChain[row.chain] += 1;
      byPad[row.launchpad] = (byPad[row.launchpad] ?? 0) + 1;
      if (row.graduatedAt !== null) graduated += 1;
      oldest = oldest === null ? row.createdAt : Math.min(oldest, row.createdAt);
      newest = newest === null ? row.createdAt : Math.max(newest, row.createdAt);
    }
    return { rows: this.rows.size, max: this.max, evicted: this.evicted, byChain, byPad, graduated, oldestCreatedAt: oldest, newestCreatedAt: newest };
  }

  /** Drops the oldest-created rows (ties: earliest inserted) until the index fits `max`. */
  private evict(): void {
    while (this.rows.size > this.max) {
      let victim: string | null = null;
      let victimAt = Number.POSITIVE_INFINITY;
      for (const [key, row] of this.rows) {
        if (row.createdAt < victimAt) {
          victim = key;
          victimAt = row.createdAt;
        }
      }
      if (victim === null) break;
      this.rows.delete(victim);
      this.stocks.delete(victim);
      this.evicted += 1;
    }
  }
}
