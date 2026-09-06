import type { FlowBar, FlowBucket, FlowPrint } from "../../shared/wire.js";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

const DEFAULT_MAX_PAIRS = 64;
const DEFAULT_MINUTE_RETENTION_MS = 48 * HOUR_MS;
const DEFAULT_HOUR_RETENTION_MS = 30 * 24 * HOUR_MS;
const DEFAULT_DEDUPE_RING = 2000;
const DEFAULT_RECENT_RING = 200;

export type FlowLedgerOptions = {
  maxPairs?: number;
  minuteRetentionMs?: number;
  hourRetentionMs?: number;
  dedupeRing?: number;
  recentRing?: number;
  now?: () => number;
};

export type IngestResult = { accepted: number; duplicates: number };
export type CoverageResult = { fraction: number; firstPrintAt: number | null };
export type LedgerStats = { pairs: number; buckets: number };

type PairState = {
  minutes: Map<number, FlowBucket>;
  hours: Map<number, FlowBucket>;
  /** Insertion-ordered tx ring; oldest entries drop once the ring is full. */
  seen: Set<string>;
  /** Last `recentRing` accepted prints, ascending by time; oldest-by-time drops when full. */
  recent: FlowPrint[];
  firstPrintAt: number | null;
};

export function pairKey(chain: string, pair: string): string {
  return `${chain}:${pair}`;
}

export function alignTo(time: number, bucketMs: number): number {
  return Math.floor(time / bucketMs) * bucketMs;
}

export function emptyBucket(t: number): FlowBucket {
  return { t, buyUsd: 0, sellUsd: 0, buys: 0, sells: 0, unpricedBuys: 0, unpricedSells: 0 };
}

function emptyPair(): PairState {
  return { minutes: new Map(), hours: new Map(), seen: new Set(), recent: [], firstPrintAt: null };
}

/** Inserts `print` keeping `ring` ascending by time, then trims the oldest entries down to `cap`. */
function insertByTime(ring: FlowPrint[], print: FlowPrint, cap: number): void {
  let i = ring.length;
  while (i > 0 && ring[i - 1].time > print.time) i -= 1;
  ring.splice(i, 0, print);
  if (ring.length > cap) ring.splice(0, ring.length - cap);
}

/** Returns a new bucket with the print folded in. Counts every print; sums only priced ones. */
export function foldPrint(bucket: FlowBucket, print: FlowPrint): FlowBucket {
  const priced = print.usd !== null && Number.isFinite(print.usd);
  const usd = priced ? (print.usd as number) : 0;
  if (print.side === "buy") {
    return {
      ...bucket,
      buyUsd: bucket.buyUsd + usd,
      buys: bucket.buys + 1,
      unpricedBuys: bucket.unpricedBuys + (priced ? 0 : 1)
    };
  }
  return {
    ...bucket,
    sellUsd: bucket.sellUsd + usd,
    sells: bucket.sells + 1,
    unpricedSells: bucket.unpricedSells + (priced ? 0 : 1)
  };
}

/** Returns a new bucket at `t` holding the sum of both inputs. */
export function mergeBuckets(t: number, a: FlowBucket, b: FlowBucket): FlowBucket {
  return {
    t,
    buyUsd: a.buyUsd + b.buyUsd,
    sellUsd: a.sellUsd + b.sellUsd,
    buys: a.buys + b.buys,
    sells: a.sells + b.sells,
    unpricedBuys: a.unpricedBuys + b.unpricedBuys,
    unpricedSells: a.unpricedSells + b.unpricedSells
  };
}

function foldInto(tier: Map<number, FlowBucket>, t: number, print: FlowPrint): void {
  tier.set(t, foldPrint(tier.get(t) ?? emptyBucket(t), print));
}

function pruneTier(tier: Map<number, FlowBucket>, cutoff: number): void {
  for (const t of tier.keys()) {
    if (t < cutoff) tier.delete(t);
  }
}

function aggregate(
  out: Map<number, FlowBucket>,
  source: Iterable<FlowBucket>,
  bucketMs: number,
  fromMs: number,
  toMs: number,
  skip?: (bucket: FlowBucket) => boolean
): void {
  for (const bucket of source) {
    if (bucket.t < fromMs || bucket.t > toMs) continue;
    if (skip && skip(bucket)) continue;
    const t = alignTo(bucket.t, bucketMs);
    const current = out.get(t);
    out.set(t, current ? mergeBuckets(t, current, bucket) : mergeBuckets(t, emptyBucket(t), bucket));
  }
}

/** delta = buyUsd - sellUsd per bucket; cvd = running sum starting at anchorCvd; time = t. */
export function toBars(buckets: FlowBucket[], _bucketMs: number, anchorCvd = 0): FlowBar[] {
  let cvd = anchorCvd;
  return buckets.map((bucket) => {
    const delta = bucket.buyUsd - bucket.sellUsd;
    cvd += delta;
    return { ...bucket, delta, cvd };
  });
}

/** In-memory per-pair flow ledger: minute buckets (48h) plus an hourly tier (30d) folded at ingest. */
export class FlowLedger {
  private readonly maxPairs: number;
  private readonly minuteRetentionMs: number;
  private readonly hourRetentionMs: number;
  private readonly dedupeRing: number;
  private readonly recentRing: number;
  private readonly now: () => number;
  /** Insertion order doubles as LRU order: most recently ingested pair is last. */
  private readonly store = new Map<string, PairState>();

  constructor(opts: FlowLedgerOptions = {}) {
    this.maxPairs = opts.maxPairs ?? DEFAULT_MAX_PAIRS;
    this.minuteRetentionMs = opts.minuteRetentionMs ?? DEFAULT_MINUTE_RETENTION_MS;
    this.hourRetentionMs = opts.hourRetentionMs ?? DEFAULT_HOUR_RETENTION_MS;
    this.dedupeRing = opts.dedupeRing ?? DEFAULT_DEDUPE_RING;
    this.recentRing = opts.recentRing ?? DEFAULT_RECENT_RING;
    this.now = opts.now ?? (() => Date.now());
  }

  ingest(prints: FlowPrint[]): IngestResult {
    let accepted = 0;
    let duplicates = 0;
    for (const print of prints) {
      if (!Number.isFinite(print.time)) continue;
      const state = this.touch(pairKey(print.chain, print.pair));
      if (this.isDuplicate(state, print.tx)) {
        duplicates += 1;
        continue;
      }
      this.fold(state, print);
      accepted += 1;
    }
    this.evict();
    this.prune(this.now());
    return { accepted, duplicates };
  }

  series(chain: string, pair: string, bucketMs: number, fromMs: number, toMs: number): FlowBucket[] {
    const state = this.store.get(pairKey(chain, pair));
    if (!state || !(bucketMs > 0)) return [];
    const out = new Map<number, FlowBucket>();
    if (bucketMs < HOUR_MS) {
      aggregate(out, state.minutes.values(), bucketMs, fromMs, toMs);
    } else {
      const covered = coveredHours(state.minutes);
      aggregate(out, state.minutes.values(), bucketMs, fromMs, toMs);
      aggregate(out, state.hours.values(), bucketMs, fromMs, toMs, (bucket) => covered.has(bucket.t));
    }
    return [...out.values()].sort((a, b) => a.t - b.t);
  }

  coverage(chain: string, pair: string, fromMs: number, toMs: number): CoverageResult {
    const firstPrintAt = this.firstPrintAt(chain, pair);
    if (firstPrintAt === null || !(toMs > fromMs)) return { fraction: 0, firstPrintAt };
    const covered = toMs - Math.max(fromMs, firstPrintAt);
    const fraction = Math.min(1, Math.max(0, covered / (toMs - fromMs)));
    return { fraction, firstPrintAt };
  }

  /** Accepted prints for one pair, newest first, at most `limit` (default: the whole ring). Duplicates never enter the ring. */
  recentPrints(chain: string, pair: string, limit = this.recentRing): FlowPrint[] {
    const recent = this.store.get(pairKey(chain, pair))?.recent;
    if (!recent || !(limit > 0)) return [];
    return recent.slice(-Math.floor(limit)).reverse();
  }

  firstPrintAt(chain: string, pair: string): number | null {
    return this.store.get(pairKey(chain, pair))?.firstPrintAt ?? null;
  }

  pairs(): string[] {
    return [...this.store.keys()];
  }

  stats(): LedgerStats {
    let buckets = 0;
    for (const state of this.store.values()) buckets += state.minutes.size + state.hours.size;
    return { pairs: this.store.size, buckets };
  }

  private touch(key: string): PairState {
    const existing = this.store.get(key);
    if (existing) this.store.delete(key);
    const state = existing ?? emptyPair();
    this.store.set(key, state);
    return state;
  }

  private isDuplicate(state: PairState, tx: string): boolean {
    if (state.seen.has(tx)) return true;
    state.seen.add(tx);
    while (state.seen.size > this.dedupeRing) {
      const oldest = state.seen.keys().next().value;
      if (oldest === undefined) break;
      state.seen.delete(oldest);
    }
    return false;
  }

  private fold(state: PairState, print: FlowPrint): void {
    foldInto(state.minutes, alignTo(print.time, MINUTE_MS), print);
    foldInto(state.hours, alignTo(print.time, HOUR_MS), print);
    insertByTime(state.recent, print, this.recentRing);
    if (state.firstPrintAt === null || print.time < state.firstPrintAt) state.firstPrintAt = print.time;
  }

  private evict(): void {
    while (this.store.size > this.maxPairs) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Minute cutoff is hour-aligned so every retained hour keeps all of its minutes. */
  private prune(now: number): void {
    const minuteCutoff = alignTo(now - this.minuteRetentionMs, HOUR_MS);
    const hourCutoff = alignTo(now - this.hourRetentionMs, HOUR_MS);
    for (const state of this.store.values()) {
      pruneTier(state.minutes, minuteCutoff);
      pruneTier(state.hours, hourCutoff);
    }
  }
}

function coveredHours(minutes: Map<number, FlowBucket>): Set<number> {
  const covered = new Set<number>();
  for (const t of minutes.keys()) covered.add(alignTo(t, HOUR_MS));
  return covered;
}
