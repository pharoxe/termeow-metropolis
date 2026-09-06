import type { Candle } from "../types";
import type { TapePrint } from "../../shared/wire";
import { toMillis } from "./chartTime";

/**
 * Pure candle-stream logic for the create-once chart: which bars to setData vs series.update,
 * ticking the forming bar from tape prints, and the legend row for a hovered bar. Tested in node.
 */

export type CandlePlan = { kind: "reset" | "update" | "none"; bars: Candle[] };

/** The print fields the forming bar needs; structurally a subset of TapePrint (time ms, price per token, usd notional). */
export type LivePrint = Pick<TapePrint, "time" | "price" | "usd">;

/** `applied` = prints that moved OHLC; `volumeOnly` = unpriced prints whose usd was added; `ignored` = out of range/unusable. */
export type LiveCandleStats = { applied: number; volumeOnly: number; ignored: number };
export type LiveCandleResult = { candles: Candle[]; stats: LiveCandleStats };

export type LegendBar = {
  index: number;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  /** Close vs previous bar's close; null on the first bar. */
  changePct: number | null;
};

export const DEFAULT_INTERVAL_MS = 60_000;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Ascending, strictly increasing times (first occurrence wins), non-finite times dropped — what the series may hold. */
export function dedupeAscending(candles: Candle[]): Candle[] {
  const sorted = candles.filter((candle) => finite(candle.time)).slice().sort((a, b) => a.time - b.time);
  return sorted.filter((candle, index) => index === 0 || candle.time > sorted[index - 1].time);
}

function sameBar(a: Candle, b: Candle): boolean {
  return a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;
}

/**
 * Decide how to push `next` into a series currently holding `prev` (both ascending, deduped).
 * "update" when the history before prev's last bar is unchanged and next is the same length or one longer:
 * `bars` are the tail to feed series.update in order (prev's last slot, then any new bar). Anything else resets.
 */
export function planCandleUpdate(prev: Candle[], next: Candle[]): CandlePlan {
  if (prev === next) return { kind: "none", bars: [] };
  if (!prev.length && !next.length) return { kind: "none", bars: [] };
  if (!prev.length || !next.length) return { kind: "reset", bars: next };
  const grew = next.length - prev.length;
  if (grew < 0 || grew > 1 || prev[0].time !== next[0].time) return { kind: "reset", bars: next };
  const stable = prev.length - 1;
  for (let index = 0; index < stable; index += 1) {
    if (!sameBar(prev[index], next[index])) return { kind: "reset", bars: next };
  }
  if (next[stable].time !== prev[stable].time) return { kind: "reset", bars: next };
  if (grew === 0 && sameBar(prev[stable], next[stable])) return { kind: "none", bars: [] };
  return { kind: "update", bars: next.slice(stable) };
}

/** Start of the bucket containing `timeMs` for `intervalMs` buckets aligned to the UTC epoch (matches Gecko/pump buckets). */
export function bucketStartMs(timeMs: number, intervalMs: number): number {
  return Math.floor(timeMs / intervalMs) * intervalMs;
}

/** Bar spacing inferred from the last few candle times (smallest positive gap, ms); DEFAULT_INTERVAL_MS when unknowable. */
export function inferIntervalMs(candles: Candle[]): number {
  let smallest = Number.POSITIVE_INFINITY;
  const start = Math.max(1, candles.length - 24);
  for (let index = start; index < candles.length; index += 1) {
    const gap = toMillis(candles[index].time) - toMillis(candles[index - 1].time);
    if (gap > 0 && gap < smallest) smallest = gap;
  }
  return Number.isFinite(smallest) ? smallest : DEFAULT_INTERVAL_MS;
}

function scaledPrice(print: LivePrint, scale: number | null | undefined): number | null {
  if (!finite(print.price) || print.price <= 0) return null;
  return finite(scale) && scale > 0 ? print.price * scale : print.price;
}

function tick(bar: Candle, price: number | null, usd: number | null): Candle {
  return {
    ...bar,
    high: price == null ? bar.high : Math.max(bar.high, price),
    low: price == null ? bar.low : Math.min(bar.low, price),
    close: price ?? bar.close,
    volume: bar.volume + (usd ?? 0)
  };
}

/** A new bar opens at its first priced print (as the server's own-tape bars do); nothing is carried from the previous bar. */
function openBar(time: number, price: number, usd: number | null): Candle {
  return { time, open: price, high: price, low: price, close: price, volume: usd ?? 0 };
}

/**
 * Tick the forming bar with tape prints the candle source has not seen yet.
 * Caller contract: pass only prints newer than the candle feed's observation time (else volume double-counts);
 * prints older than the last bar's open or in the future (> nowMs) are ignored. A priced print in a later
 * bucket opens a new bar at that print's price; unpriced prints only add usd to an existing bar and can
 * never open one, so an empty or price-less bucket is never fabricated. `scale` multiplies print prices
 * (mcap mode: pass the supply the candles were scaled by); candle times keep the caller's unit (ms or s).
 */
export function applyPrintsToCandles(
  candles: Candle[],
  prints: LivePrint[],
  intervalMs: number,
  nowMs: number,
  scale: number | null | undefined = null
): LiveCandleResult {
  const stats: LiveCandleStats = { applied: 0, volumeOnly: 0, ignored: 0 };
  if (!prints.length || !finite(intervalMs) || intervalMs <= 0) return { candles, stats: { ...stats, ignored: prints.length } };
  const inMillis = candles.length ? toMillis(candles[candles.length - 1].time) === candles[candles.length - 1].time : true;
  const toUnit = (ms: number) => (inMillis ? ms : ms / 1000);
  const ordered = prints.filter((print) => finite(print.time)).slice().sort((a, b) => a.time - b.time);
  stats.ignored += prints.length - ordered.length;
  const out = candles.slice();
  const lastOpenMs = out.length ? toMillis(out[out.length - 1].time) : Number.NEGATIVE_INFINITY;
  for (const print of ordered) {
    if (print.time < lastOpenMs || print.time > nowMs) {
      stats.ignored += 1;
      continue;
    }
    const price = scaledPrice(print, scale);
    const usd = finite(print.usd) && print.usd >= 0 ? print.usd : null;
    const bucket = bucketStartMs(print.time, intervalMs);
    const last = out.length ? out[out.length - 1] : null;
    const lastMs = last ? toMillis(last.time) : Number.NEGATIVE_INFINITY;
    if (last && bucket <= lastMs) {
      if (price == null && usd == null) {
        stats.ignored += 1;
        continue;
      }
      out[out.length - 1] = tick(last, price, usd);
      if (price == null) stats.volumeOnly += 1;
      else stats.applied += 1;
      continue;
    }
    if (price == null) {
      stats.ignored += 1;
      continue;
    }
    out.push(openBar(toUnit(bucket), price, usd));
    stats.applied += 1;
  }
  return { candles: out, stats };
}

/** Legend row for `candles[index]` (null when out of range); change is against the previous bar's close. */
export function barLegend(candles: Candle[], index: number | null | undefined): LegendBar | null {
  if (index == null || !Number.isInteger(index) || index < 0 || index >= candles.length) return null;
  const bar = candles[index];
  const previous = index > 0 ? candles[index - 1] : null;
  const changePct = previous && previous.close !== 0 ? ((bar.close - previous.close) / previous.close) * 100 : null;
  return {
    index,
    time: toMillis(bar.time),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: finite(bar.volume) ? bar.volume : null,
    changePct
  };
}
