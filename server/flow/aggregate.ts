import type { Chain, FlowBar, FlowBucket, FlowCoverage, PairRow } from "../../shared/wire.js";
import { FlowLedger, HOUR_MS, MINUTE_MS, mergeBuckets, toBars } from "./ledger.js";

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
