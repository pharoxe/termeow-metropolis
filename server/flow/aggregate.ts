import type { Chain, FlowBar, FlowBucket, FlowCoverage, FlowWindow, LargePrint, PairRow, SinceAnchor } from "../../shared/wire.js";
import { FlowLedger, HOUR_MS, MINUTE_MS, alignTo, emptyBucket, mergeBuckets, toBars } from "./ledger.js";

export type FlowInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type FlowAnchor = "window" | "session" | "launch";

const INTERVAL_MS: Record<FlowInterval, number> = {
  "1m": MINUTE_MS,
  "5m": 5 * MINUTE_MS,
  "15m": 15 * MINUTE_MS,
  "1h": HOUR_MS,
  "4h": 4 * HOUR_MS,
  "1d": 24 * HOUR_MS
};

export const FLOW_INTERVALS = Object.keys(INTERVAL_MS) as FlowInterval[];

export function isFlowInterval(value: string): value is FlowInterval {
  return Object.prototype.hasOwnProperty.call(INTERVAL_MS, value);
}

export function intervalToMs(interval: FlowInterval): number {
  return INTERVAL_MS[interval];
}

/** ms for any interval label, null when it is not one of FLOW_INTERVALS (the market route shares these six labels). */
export function intervalMsOf(interval: string): number | null {
  return isFlowInterval(interval) ? INTERVAL_MS[interval] : null;
}

export type TokenFlowInput = {
  ledger: FlowLedger;
  chain: Chain;
  address: string;
  pairs: PairRow[];
  interval: string;
  fromMs: number;
  toMs: number;
  anchor: FlowAnchor;
  sessionStartMs: number;
  launchMs: number | null;
};

export type PairFlow = PairRow & { bars: FlowBar[] };

export type TokenFlowResult = {
  bars: FlowBar[];
  pairs: PairFlow[];
  coverage: FlowCoverage;
};

/** Start of the cvd running sum for the given anchor; null means "the window itself". */
export function anchorStartMs(anchor: FlowAnchor, sessionStartMs: number, launchMs: number | null): number | null {
  if (anchor === "session") return sessionStartMs;
  if (anchor === "launch") return launchMs ?? 0;
  return null;
}

function sumDelta(buckets: FlowBucket[]): number {
  return buckets.reduce((acc, bucket) => acc + bucket.buyUsd - bucket.sellUsd, 0);
}

/** Bucket-wise sum over several series; missing pair-buckets contribute zero. */
export function sumSeries(series: FlowBucket[][]): FlowBucket[] {
  const out = new Map<number, FlowBucket>();
  for (const buckets of series) {
    for (const bucket of buckets) {
      const current = out.get(bucket.t);
      out.set(bucket.t, current ? mergeBuckets(bucket.t, current, bucket) : bucket);
    }
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/** Sum of Tier A share24; null when any Tier A share is unknown or there are no Tier A pairs. */
export function coverageShare(pairs: PairRow[]): number | null {
  const tierA = pairs.filter((pair) => pair.tier === "A");
  if (tierA.length === 0) return null;
  let total = 0;
  for (const pair of tierA) {
    if (pair.share24 === null || !Number.isFinite(pair.share24)) return null;
    total += pair.share24;
  }
  return Math.min(1, Math.max(0, total));
}

type PairCoverage = { fraction: number; firstPrintAt: number | null; share24: number | null };

/** share24-weighted mean of per-pair fractions; equal weights unless every share is known and positive in sum. */
export function weightedCoverage(rows: PairCoverage[]): { fraction: number; firstPrintAt: number | null } {
  if (rows.length === 0) return { fraction: 0, firstPrintAt: null };
  const known = rows.every((row) => row.share24 !== null && Number.isFinite(row.share24));
  const shareSum = known ? rows.reduce((acc, row) => acc + (row.share24 as number), 0) : 0;
  const weights = known && shareSum > 0 ? rows.map((row) => (row.share24 as number) / shareSum) : rows.map(() => 1 / rows.length);
  const fraction = rows.reduce((acc, row, i) => acc + row.fraction * weights[i], 0);
  const firsts = rows.map((row) => row.firstPrintAt).filter((t): t is number => t !== null);
  const firstPrintAt = firsts.length > 0 ? Math.min(...firsts) : null;
  return { fraction: Math.min(1, Math.max(0, fraction)), firstPrintAt };
}

function openingCvd(ledger: FlowLedger, chain: Chain, pair: string, bucketMs: number, start: number | null, fromMs: number): number {
  if (start === null || start >= fromMs) return 0;
  return sumDelta(ledger.series(chain, pair, bucketMs, start, fromMs - 1));
}

export function tokenFlow(input: TokenFlowInput): TokenFlowResult {
  const { ledger, chain, pairs, fromMs, toMs } = input;
  if (!isFlowInterval(input.interval)) throw new RangeError(`unknown flow interval: ${input.interval}`);
  const bucketMs = intervalToMs(input.interval);
  const start = anchorStartMs(input.anchor, input.sessionStartMs, input.launchMs);
  const tierA = pairs.filter((pair) => pair.tier === "A");

  const perPair = tierA.map((pair) => {
    const series = ledger.series(chain, pair.pairAddress, bucketMs, fromMs, toMs);
    const opening = openingCvd(ledger, chain, pair.pairAddress, bucketMs, start, fromMs);
    const cov = ledger.coverage(chain, pair.pairAddress, fromMs, toMs);
    return { pair, series, opening, coverage: { ...cov, share24: pair.share24 } };
  });

  const tokenOpening = perPair.reduce((acc, row) => acc + row.opening, 0);
  const bars = toBars(sumSeries(perPair.map((row) => row.series)), bucketMs, tokenOpening);
  const barsByPair = new Map(perPair.map((row) => [row.pair.pairAddress, toBars(row.series, bucketMs, row.opening)]));
  const merged = weightedCoverage(perPair.map((row) => row.coverage));

  return {
    bars,
    pairs: pairs.map((pair) => ({ ...pair, bars: barsByPair.get(pair.pairAddress) ?? [] })),
    coverage: {
      fraction: merged.fraction,
      firstPrintAt: merged.firstPrintAt,
      volumeShare: coverageShare(pairs),
      tierAPairs: tierA.length,
      totalPairs: pairs.length
    }
  };
}

export const WINDOW_MS: Record<FlowWindow["label"], number> = {
  "1m": MINUTE_MS,
  "5m": 5 * MINUTE_MS,
  "15m": 15 * MINUTE_MS,
  "1h": HOUR_MS
};

export const FLOW_WINDOW_LABELS = Object.keys(WINDOW_MS) as FlowWindow["label"][];
export const LARGE_PRINT_MIN_USD = 1000;
export const LARGE_PRINT_LIMIT = 20;

function tierAOf(pairs: PairRow[]): PairRow[] {
  return pairs.filter((pair) => pair.tier === "A");
}

/**
 * One bucket holding the Tier A minute-bucket totals covering [fromMs, toMs]; the query start is aligned down to the
 * minute boundary so the bucket straddling fromMs is included. Minute retention (48h) bounds the reach.
 */
function minuteTotals(ledger: FlowLedger, chain: Chain, pairs: PairRow[], fromMs: number, toMs: number): FlowBucket {
  const series = tierAOf(pairs).map((pair) => ledger.series(chain, pair.pairAddress, MINUTE_MS, alignTo(fromMs, MINUTE_MS), toMs));
  return sumSeries(series).reduce((acc, bucket) => mergeBuckets(fromMs, acc, bucket), emptyBucket(fromMs));
}

/** Rolling Tier A totals for the four fixed windows ending at nowMs. Unpriced prints are counted, never priced. */
export function flowWindows(ledger: FlowLedger, chain: Chain, pairs: PairRow[], nowMs: number): FlowWindow[] {
  return FLOW_WINDOW_LABELS.map((label) => {
    const total = minuteTotals(ledger, chain, pairs, nowMs - WINDOW_MS[label], nowMs);
    const gross = total.buyUsd + total.sellUsd;
    return {
      label,
      buyUsd: total.buyUsd,
      sellUsd: total.sellUsd,
      net: total.buyUsd - total.sellUsd,
      buys: total.buys,
      sells: total.sells,
      unpriced: total.unpricedBuys + total.unpricedSells,
      aggressor: gross === 0 ? null : total.buyUsd / gross
    };
  });
}

/** Priced Tier A prints at or above minUsd from each pair's recent ring, newest first, capped at limit. */
export function largePrints(ledger: FlowLedger, chain: Chain, pairs: PairRow[], minUsd = LARGE_PRINT_MIN_USD, limit = LARGE_PRINT_LIMIT): LargePrint[] {
  const out: LargePrint[] = [];
  for (const pair of tierAOf(pairs)) {
    for (const print of ledger.recentPrints(chain, pair.pairAddress)) {
      if (print.usd === null || !Number.isFinite(print.usd) || print.usd < minUsd) continue;
      out.push({ pair: print.pair, dex: pair.dex, tx: print.tx, time: print.time, side: print.side, usd: print.usd, source: print.source });
    }
  }
  return out.sort((a, b) => b.time - a.time).slice(0, Math.max(0, limit));
}

/** Tier A totals from the anchor start to nowMs; an unknown start yields zeros with startMs null, never a guess. */
export function sinceAnchor(ledger: FlowLedger, chain: Chain, pairs: PairRow[], startMs: number | null, nowMs: number): SinceAnchor {
  if (startMs === null || !Number.isFinite(startMs)) return { startMs: null, net: 0, buyUsd: 0, sellUsd: 0, prints: 0 };
  const total = minuteTotals(ledger, chain, pairs, startMs, nowMs);
  return { startMs, net: total.buyUsd - total.sellUsd, buyUsd: total.buyUsd, sellUsd: total.sellUsd, prints: total.buys + total.sells };
}
