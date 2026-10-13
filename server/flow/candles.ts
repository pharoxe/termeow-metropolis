import type { Chain, FlowCandleInterval, FlowPrint, MarketCandle, PairRow } from "../../shared/wire.js";
import { MINUTE_MS, alignTo } from "./ledger.js";
import { isLaunchpadRow } from "./registry.js";

/**
 * Own-tape candles: OHLC from the per-print `price` producers attach (usd / token units of that print), volume = summed
 * usd, one bar per bucket that saw at least one priced print. Buckets without a priced print are left empty, never
 * filled or carried forward. Inputs are the ledger's recent-print rings (200 prints per pair), so history is minutes.
 */
export const OWN_TAPE_SOURCE = "own tape" as const;
export const CANDLE_INTERVALS = ["5s", "15s", "1m"] as const satisfies readonly FlowCandleInterval[];
export const CANDLE_INTERVAL_MS: Record<FlowCandleInterval, number> = { "5s": 5_000, "15s": 15_000, "1m": MINUTE_MS };

export type PricedPrint = FlowPrint & { price: number };

/** The slice of FlowLedger the candle builder reads; tests can hand in a plain object. */
export type CandleLedgerLike = { recentPrints(chain: string, pair: string, limit?: number): FlowPrint[] };

export type TokenCandles = {
  candles: MarketCandle[];
  /** Every ring print merged across the candle pairs, priced or not. */
  prints: number;
  /** Prints that carried a finite positive price and therefore shaped a candle. */
  priced: number;
  /** Oldest ring print of any kind (null when the rings are empty). */
  firstPrintAt: number | null;
  /** Newest minus oldest priced print; 0 with fewer than two priced prints. */
  spanMs: number;
  /** Priced prints per producer, only sources that contributed: the rings mix this server's decoder with Gecko rows. */
  pricedBySource: Partial<Record<FlowPrint["source"], number>>;
  source: typeof OWN_TAPE_SOURCE;
};

export function isPriced(print: FlowPrint): print is PricedPrint {
  return typeof print.price === "number" && Number.isFinite(print.price) && print.price > 0 && Number.isFinite(print.time);
}

function usdOf(print: FlowPrint): number {
  return print.usd !== null && Number.isFinite(print.usd) ? print.usd : 0;
}

function openCandle(time: number, print: PricedPrint): MarketCandle {
  return { time, open: print.price, high: print.price, low: print.price, close: print.price, volume: usdOf(print) };
}

function foldCandle(candle: MarketCandle, print: PricedPrint): MarketCandle {
  return {
    ...candle,
    high: Math.max(candle.high, print.price),
    low: Math.min(candle.low, print.price),
    close: print.price,
    volume: candle.volume + usdOf(print)
  };
}

/** Time-ascending copy; equal times keep input order, so callers control tie-breaks by the order they pass. */
function sortByTime(prints: FlowPrint[]): FlowPrint[] {
  return [...prints].sort((a, b) => a.time - b.time);
}

/** Candles from priced prints only, ascending by bucket start (ms). Throws on a non-positive bucket. */
export function printCandles(prints: FlowPrint[], bucketMs: number): MarketCandle[] {
  if (!(bucketMs > 0) || !Number.isFinite(bucketMs)) throw new RangeError(`printCandles: bucketMs must be positive, got ${bucketMs}`);
  const byBucket = new Map<number, MarketCandle>();
  for (const print of sortByTime(prints)) {
    if (!isPriced(print)) continue;
    const t = alignTo(print.time, bucketMs);
    const current = byBucket.get(t);
    byBucket.set(t, current ? foldCandle(current, print) : openCandle(t, print));
  }
  return [...byBucket.values()].sort((a, b) => a.time - b.time);
}

/** Pairs whose rings feed the candles: Tier A pools plus launchpad curve pseudo-pairs (always Tier A, kept explicit). */
export function candlePairs(rows: PairRow[]): PairRow[] {
  return rows.filter((row) => row.tier === "A" || isLaunchpadRow(row));
}

/** Every ring print of the candle pairs, merged time-ascending (pair order breaks ties). */
export function mergeRingPrints(ledger: CandleLedgerLike, chain: Chain, rows: PairRow[]): FlowPrint[] {
  const merged = candlePairs(rows).flatMap((row) => [...ledger.recentPrints(chain, row.pairAddress)].reverse());
  return sortByTime(merged);
}

function spanOf(prints: FlowPrint[]): number {
  if (prints.length < 2) return 0;
  return prints[prints.length - 1].time - prints[0].time;
}

function countBySource(prints: FlowPrint[]): Partial<Record<FlowPrint["source"], number>> {
  const out: Partial<Record<FlowPrint["source"], number>> = {};
  for (const print of prints) out[print.source] = (out[print.source] ?? 0) + 1;
  return out;
}

/** Own-tape candles for one token from the ledger rings of its Tier A and launchpad pairs. */
export function candlesForToken(ledger: CandleLedgerLike, rows: PairRow[], chain: Chain, bucketMs: number): TokenCandles {
  const merged = mergeRingPrints(ledger, chain, rows);
  const priced = merged.filter(isPriced);
  const spanMs = spanOf(priced);
  return {
    candles: printCandles(merged, bucketMs),
    prints: merged.length,
    priced: priced.length,
    firstPrintAt: merged[0]?.time ?? null,
    spanMs,
    pricedBySource: countBySource(priced),
    source: OWN_TAPE_SOURCE
  };
}
