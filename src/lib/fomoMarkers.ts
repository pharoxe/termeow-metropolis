import type { FomoFill, TraderKind } from "../../shared/wire";
import { FLOW_PALETTE, type FlowChartTheme } from "./flowChart";
import { money } from "./format";

/**
 * Pure marker builder for lightweight-charts v5 createSeriesMarkers. No chart-library imports: tested in node.
 *
 * One marker per candle per side (a "bucket"), so at most two labels stack on a bar. The bucket keeps
 * its per-wallet breakdown so the chart can show it on hover (see indexFomoMarkersByTime).
 */

/** One wallet's share of a bucket. `usd` sums priced fills only; `unpriced` fills are counted, never summed. */
export type FomoBucketWallet = {
  address: string;
  handle: string | null;
  /** Kind of the wallet's first fill in the bucket (a wallet has one kind at a time on the wire). */
  kind: TraderKind | null;
  count: number;
  usd: number | null;
  unpriced: number;
};

export type FomoMarker = {
  time: number; // UTC seconds of the containing candle
  position: "aboveBar" | "belowBar";
  shape: "arrowUp" | "arrowDown";
  color: string;
  text: string;
  size?: number;
  /** Bucket breakdown (not read by the chart library; MarketChart strips it before setMarkers). */
  side: FomoFill["side"];
  /** Fill counts by wallet kind; the chart meta sums them across markers. */
  fomoFills: number;
  seededFills: number;
  /** True when every fill in the bucket is from a wallet still awaiting its 7702 check (text starts with SEEDED, muted color). */
  seeded: boolean;
  /** Distinct wallets, largest priced usd first (unpriced last, ties by count). */
  wallets: FomoBucketWallet[];
};

export type FomoMarkerOptions = { maxMarkers?: number; theme: FlowChartTheme };

/**
 * `dropped` = buckets cut by the cap; `beforeRange` = fills older than the first candle (no candle contains them);
 * `seeded` = kept buckets made only of seeded wallets (text starts with SEEDED). Mixed buckets count as FOMO.
 */
export type FomoMarkerResult = { markers: FomoMarker[]; dropped: number; beforeRange: number; seeded: number };

/** `wallets` = distinct addresses; `unpriced` fills are counted, never summed. `net` = buyUsd - sellUsd. */
export type FomoSummary = { buyUsd: number; sellUsd: number; net: number; wallets: number; fills: number; unpriced: number };

export type FomoSizeClass = 0 | 1 | 2;

export const DEFAULT_MAX_MARKERS = 60;
/** USD size-class boundaries (used by the large-print markers): class 0 below the first, class 1 below the second, class 2 at or above it. */
export const SIZE_THRESHOLDS: readonly [number, number] = [500, 5_000];
/** Fill-count boundaries for FOMO bucket markers: 1 fill → class 0, 2–4 → class 1, 5+ → class 2. */
export const COUNT_THRESHOLDS: readonly [number, number] = [2, 5];
/** lightweight-charts clamps marker size at 0 (invisible), so classes map to visible multipliers of the default. */
export const MARKER_SIZE_BY_CLASS: Readonly<Record<FomoSizeClass, number>> = { 0: 0.8, 1: 1.1, 2: 1.6 };

type Bucket = {
  side: FomoFill["side"];
  candleIndex: number;
  fomoFills: number;
  seededFills: number;
  usd: number | null;
  unpriced: number;
  /** Insertion-ordered by wallet key; sorted on output. */
  wallets: Map<string, FomoBucketWallet>;
  /** Handle of the only fill when the bucket has exactly one fill; null otherwise. */
  soleHandle: string | null;
};

/** Index of the last candle whose start is at or before `timeMs`; -1 when the fill predates the first candle. */
export function candleIndexFor(candleTimesMs: number[], timeMs: number): number {
  let lo = 0;
  let hi = candleTimesMs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candleTimesMs[mid] <= timeMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function sizeClass(usd: number | null): FomoSizeClass {
  if (usd == null || !Number.isFinite(usd)) return 0;
  if (usd < SIZE_THRESHOLDS[0]) return 0;
  if (usd < SIZE_THRESHOLDS[1]) return 1;
  return 2;
}

/** Bucket size grows with how many fills landed in the candle, not with usd (a $5 pile-in is still a pile-in). */
export function countSizeClass(fills: number): FomoSizeClass {
  if (fills < COUNT_THRESHOLDS[0]) return 0;
  if (fills < COUNT_THRESHOLDS[1]) return 1;
  return 2;
}

function priced(usd: number | null): usd is number {
  return usd != null && Number.isFinite(usd);
}

function walletKey(address: string): string {
  return address.toLowerCase();
}

function addUsd(prior: number | null, usd: number | null): number | null {
  return usd == null ? prior : (prior ?? 0) + usd;
}

function walletWith(prior: FomoBucketWallet | undefined, fill: FomoFill, usd: number | null): FomoBucketWallet {
  if (!prior) {
    return { address: fill.trader.address, handle: fill.trader.handle, kind: fill.trader.kind ?? null, count: 1, usd, unpriced: usd == null ? 1 : 0 };
  }
  return { ...prior, handle: prior.handle ?? fill.trader.handle, count: prior.count + 1, usd: addUsd(prior.usd, usd), unpriced: prior.unpriced + (usd == null ? 1 : 0) };
}

function bucketWith(prior: Bucket | undefined, fill: FomoFill, candleIndex: number): Bucket {
  const usd = priced(fill.usd) ? fill.usd : null;
  const seeded = fill.trader.kind === "seeded";
  const key = walletKey(fill.trader.address);
  const base: Bucket = prior ?? { side: fill.side, candleIndex, fomoFills: 0, seededFills: 0, usd: null, unpriced: 0, wallets: new Map(), soleHandle: null };
  const wallets = new Map(base.wallets);
  wallets.set(key, walletWith(base.wallets.get(key), fill, usd));
  return {
    ...base,
    fomoFills: base.fomoFills + (seeded ? 0 : 1),
    seededFills: base.seededFills + (seeded ? 1 : 0),
    usd: addUsd(base.usd, usd),
    unpriced: base.unpriced + (usd == null ? 1 : 0),
    wallets,
    soleHandle: prior ? null : fill.trader.handle?.trim() || null
  };
}

function groupFills(fills: FomoFill[], candleTimesMs: number[]): { buckets: Bucket[]; beforeRange: number } {
  const byKey = new Map<string, Bucket>();
  let beforeRange = 0;
  for (const fill of fills) {
    const candleIndex = candleIndexFor(candleTimesMs, fill.time);
    if (candleIndex < 0) {
      beforeRange += 1;
      continue;
    }
    const key = `${fill.side}|${candleIndex}`;
    byKey.set(key, bucketWith(byKey.get(key), fill, candleIndex));
  }
  return { buckets: [...byKey.values()], beforeRange };
}

/** Largest priced first; unpriced rank below every priced one, ties broken by count. */
function usdDesc(a: { usd: number | null; count: number }, b: { usd: number | null; count: number }): number {
  const ua = priced(a.usd) ? a.usd : -1;
  const ub = priced(b.usd) ? b.usd : -1;
  if (ua !== ub) return ub - ua;
  return b.count - a.count;
}

type TextInput = Pick<Bucket, "side" | "fomoFills" | "seededFills" | "usd" | "soleHandle">;

/**
 * "3 FOMO buys · $1.2K" · "1 FOMO sell" (nothing priced → no money) · "SEEDED 2 buys · $40" (all seeded) ·
 * "2 FOMO buys + 1 SEEDED · $1.2K" (mixed) · "frankdegods buy $747" (exactly one fill and it has a handle;
 * "SEEDED frankdegods buy $747" when that wallet is seeded). Money is the sum of PRICED fills only.
 */
export function markerText(bucket: TextInput): string {
  const fills = bucket.fomoFills + bucket.seededFills;
  const allSeeded = fills > 0 && bucket.fomoFills === 0;
  const amount = priced(bucket.usd) ? money(bucket.usd, true) : null;
  if (fills === 1 && bucket.soleHandle) {
    return [allSeeded ? "SEEDED" : null, bucket.soleHandle, bucket.side, amount].filter(Boolean).join(" ");
  }
  const sideNoun = (n: number) => `${bucket.side}${n === 1 ? "" : "s"}`;
  const head = allSeeded
    ? `SEEDED ${bucket.seededFills} ${sideNoun(bucket.seededFills)}`
    : `${bucket.fomoFills} FOMO ${sideNoun(bucket.fomoFills)}${bucket.seededFills > 0 ? ` + ${bucket.seededFills} SEEDED` : ""}`;
  return amount ? `${head} · ${amount}` : head;
}

function toMarker(bucket: Bucket, candleTimesMs: number[], theme: FlowChartTheme): FomoMarker {
  const palette = FLOW_PALETTE[theme];
  const buy = bucket.side === "buy";
  const fills = bucket.fomoFills + bucket.seededFills;
  const seeded = bucket.fomoFills === 0;
  return {
    time: Math.floor(candleTimesMs[bucket.candleIndex] / 1000),
    position: buy ? "belowBar" : "aboveBar",
    shape: buy ? "arrowUp" : "arrowDown",
    color: seeded ? palette.marker : buy ? palette.buy : palette.sell,
    text: markerText(bucket),
    size: MARKER_SIZE_BY_CLASS[countSizeClass(fills)],
    side: bucket.side,
    fomoFills: bucket.fomoFills,
    seededFills: bucket.seededFills,
    seeded,
    wallets: [...bucket.wallets.values()].sort(usdDesc)
  };
}

function byTimeThenSide(a: Bucket, b: Bucket): number {
  if (a.candleIndex !== b.candleIndex) return a.candleIndex - b.candleIndex;
  if (a.side === b.side) return 0;
  return a.side === "buy" ? -1 : 1;
}

function bucketUsdDesc(a: Bucket, b: Bucket): number {
  return usdDesc({ usd: a.usd, count: a.fomoFills + a.seededFills }, { usd: b.usd, count: b.fomoFills + b.seededFills });
}

export function buildFomoMarkers(fills: FomoFill[], candleTimesMs: number[], opts: FomoMarkerOptions): FomoMarkerResult {
  const maxMarkers = opts.maxMarkers ?? DEFAULT_MAX_MARKERS;
  if (candleTimesMs.length === 0) return { markers: [], dropped: 0, beforeRange: fills.length, seeded: 0 };
  const { buckets, beforeRange } = groupFills(fills, candleTimesMs);
  const kept = buckets.length > maxMarkers ? [...buckets].sort(bucketUsdDesc).slice(0, Math.max(0, maxMarkers)) : buckets;
  const markers = [...kept].sort(byTimeThenSide).map((bucket) => toMarker(bucket, candleTimesMs, opts.theme));
  return { markers, dropped: buckets.length - kept.length, beforeRange, seeded: markers.filter((marker) => marker.seeded).length };
}

/** Buckets (buy first, then sell) keyed by the candle's UTC seconds, for the hover that only knows the bar's time. */
export function indexFomoMarkersByTime(markers: readonly FomoMarker[]): Map<number, FomoMarker[]> {
  const byTime = new Map<number, FomoMarker[]>();
  for (const marker of markers) byTime.set(marker.time, [...(byTime.get(marker.time) ?? []), marker]);
  return byTime;
}

/** Header-line totals over fills at or before `nowMs` (future-stamped fills are ignored) and within `windowMs` of it. */
export function summarizeFomo(fills: FomoFill[], nowMs: number, windowMs = Number.POSITIVE_INFINITY): FomoSummary {
  const wallets = new Set<string>();
  let buyUsd = 0;
  let sellUsd = 0;
  let unpriced = 0;
  let counted = 0;
  for (const fill of fills) {
    if (fill.time > nowMs || nowMs - fill.time > windowMs) continue;
    counted += 1;
    wallets.add(walletKey(fill.trader.address));
    if (!priced(fill.usd)) {
      unpriced += 1;
      continue;
    }
    if (fill.side === "buy") buyUsd += fill.usd;
    else sellUsd += fill.usd;
  }
  return { buyUsd, sellUsd, net: buyUsd - sellUsd, wallets: wallets.size, fills: counted, unpriced };
}
