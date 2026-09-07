import type { FlowPrint, MarketCandle } from "../../../shared/wire.js";
import { decodeSwapLeg, type EvmLog, type EvmPoolRef as DecodePoolRef } from "../../tape/robinhood/decode.js";
import type { EvmPoolRef } from "../../tape/robinhood/pools.js";
import { hexToNumber } from "../../tape/robinhood/rpc.js";

export { intervalMsOf } from "../../flow/aggregate.js";

/**
 * Pure swap -> candle math for Robinhood Chain pools (the DexScreener way: every bar is built from real Swap logs).
 *  - v3/v4: price = post-swap sqrtPriceX96 (data word 2), currency1 per currency0, scaled by decimals and flipped when the
 *    charted token is currency1. Verified 2026-09-07 against DexScreener priceNative for the LLY/FATCOIN v4 pool
 *    (58001.194 FATCOIN per LLY to 9 significant figures; see __fixtures__/r6/meta.json).
 *  - v2: no sqrtPrice in the log, so price = quote units / token units of the swap itself (execution price).
 * Bars exist only where swaps exist; nothing is forward-filled.
 */
export const CANDLE_SOURCE_CHAIN = "chain swaps" as const;
export const CANDLE_SOURCE_GECKO = "geckoterminal" as const;

/** Measured 2026-09-07: 79,622 blocks over 8,030 s (blocks 56800228 -> 56879850). Used only to place a block between or beyond anchors. */
export const BLOCK_MS = 100.9;
const Q96 = 2 ** 96;
const WORD_HEX = 64;
/** sqrtPriceX96 is the third data word in both v3 (int256, int256, uint160, ...) and v4 (int128, int128, uint160, ...) Swap logs. */
const SQRT_PRICE_WORD = 2;

/** One decoded swap of the charted pool: price in QUOTE units per token, amounts in whole units. */
export type SwapPoint = {
  block: number;
  logIndex: number;
  tx: string;
  side: "buy" | "sell";
  /** Quote units per one token (post-swap pool price for v3/v4, execution price for v2). */
  price: number;
  quoteUnits: number;
  tokenUnits: number;
};

export type TimedSwapPoint = SwapPoint & { time: number };

/** A block anchor: a block whose timestamp was actually read from eth_getBlockByNumber. */
export type BlockAnchor = { block: number; time: number };

/** What a bar folds: a moment, a USD price per token and the USD notional (null when the quote could not be priced). */
export type CandleTick = { time: number; price: number; usd: number | null };

function stripHex(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

function dataWord(data: string, index: number): string | null {
  const raw = stripHex(data);
  const start = index * WORD_HEX;
  if (raw.length < start + WORD_HEX || !/^[0-9a-fA-F]+$/.test(raw)) return null;
  return raw.slice(start, start + WORD_HEX);
}

/** currency1 per currency0 in whole units from a Uniswap sqrtPriceX96; null for a zero/invalid word. */
export function priceFromSqrtX96(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number | null {
  if (sqrtPriceX96 <= 0n) return null;
  const ratio = Number(sqrtPriceX96) / Q96;
  const price = ratio * ratio * 10 ** (decimals0 - decimals1);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** Token price in quote units from the pool's post-swap sqrtPriceX96, honouring which side the charted token is. */
export function tokenPriceFromSqrtX96(sqrtPriceX96: bigint, pool: Pick<EvmPoolRef, "tokenIsCurrency0" | "tokenDecimals" | "quoteDecimals">): number | null {
  const [decimals0, decimals1] = pool.tokenIsCurrency0 ? [pool.tokenDecimals, pool.quoteDecimals] : [pool.quoteDecimals, pool.tokenDecimals];
  const price1per0 = priceFromSqrtX96(sqrtPriceX96, decimals0, decimals1);
  if (price1per0 === null) return null;
  return pool.tokenIsCurrency0 ? price1per0 : 1 / price1per0;
}

/** The decoder's view of a resolved pool (decode.ts keys the map by the lowercase pool id). */
export function decodePoolMap(pool: EvmPoolRef): Map<string, DecodePoolRef> {
  return new Map([[pool.pair, { ...pool, pairAddress: pool.pair }]]);
}

function units(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

function swapPrice(log: EvmLog, pool: EvmPoolRef, tokenUnits: number, quoteUnits: number): number | null {
  if (pool.kind !== "v2") {
    const word = dataWord(log.data, SQRT_PRICE_WORD);
    return word === null ? null : tokenPriceFromSqrtX96(BigInt(`0x${word}`), pool);
  }
  if (!(tokenUnits > 0) || !(quoteUnits > 0)) return null;
  const price = quoteUnits / tokenUnits;
  return Number.isFinite(price) ? price : null;
}

/** One Swap log of `pool` -> SwapPoint; null when it is not this pool's swap, is malformed, or has no usable price. */
export function decodeSwapPoint(log: EvmLog, pool: EvmPoolRef, pools: Map<string, DecodePoolRef> = decodePoolMap(pool)): SwapPoint | null {
  const decoded = decodeSwapLeg(log, pools);
  if (!decoded) return null;
  const tokenUnits = units(decoded.leg.tokenAmount, pool.tokenDecimals);
  const quoteUnits = units(decoded.leg.quoteAmount, pool.quoteDecimals);
  const price = swapPrice(log, pool, tokenUnits, quoteUnits);
  if (price === null) return null;
  let block: number;
  let logIndex: number;
  try {
    block = hexToNumber(log.blockNumber);
    logIndex = hexToNumber(log.logIndex);
  } catch {
    return null;
  }
  return { block, logIndex, tx: log.transactionHash, side: decoded.leg.side, price, quoteUnits, tokenUnits };
}

/** Every decodable swap of `pool` in `logs`, ascending by (block, logIndex), duplicates (same tx:logIndex) dropped. */
export function decodeSwapPoints(logs: EvmLog[], pool: EvmPoolRef): SwapPoint[] {
  const pools = decodePoolMap(pool);
  const seen = new Set<string>();
  const points: SwapPoint[] = [];
  for (const log of logs) {
    const point = decodeSwapPoint(log, pool, pools);
    if (!point) continue;
    const key = `${point.tx}:${point.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push(point);
  }
  return sortPoints(points);
}

export function sortPoints<T extends SwapPoint>(points: T[]): T[] {
  return [...points].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

/**
 * ms clock for `block` from the anchors around it: linear between the two nearest anchors (0.1 s blocks, so the error
 * inside a 10,000-block chunk is bounded by block-time jitter), BLOCK_MS extrapolation beyond the outermost anchor.
 * Callers must say in notes that times between anchors are interpolated. Throws with no anchors.
 */
export function interpolateBlockTime(block: number, anchors: BlockAnchor[]): number {
  if (anchors.length === 0) throw new Error("interpolateBlockTime: no anchors");
  const sorted = [...anchors].sort((a, b) => a.block - b.block);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (block <= first.block) return Math.round(first.time - (first.block - block) * BLOCK_MS);
  if (block >= last.block) return Math.round(last.time + (block - last.block) * BLOCK_MS);
  let lo = first;
  for (const anchor of sorted) {
    if (anchor.block === block) return anchor.time;
    if (anchor.block > block) {
      const span = anchor.block - lo.block;
      return Math.round(lo.time + ((block - lo.block) / span) * (anchor.time - lo.time));
    }
    lo = anchor;
  }
  return last.time;
}

export function timePoints(points: SwapPoint[], anchors: BlockAnchor[]): TimedSwapPoint[] {
  return points.map((point) => ({ ...point, time: interpolateBlockTime(point.block, anchors) }));
}

/** Backfilled swaps as USD ticks: price x quote USD, notional = quote units x quote USD; null notional when the quote is unpriced. */
export function pointTicks(points: TimedSwapPoint[], quoteUsd: number): CandleTick[] {
  return points.map((point) => ({ time: point.time, price: point.price * quoteUsd, usd: Number.isFinite(point.quoteUnits) ? point.quoteUnits * quoteUsd : null }));
}

/** Own-tape prints (R4 `price` = usd / token units of that print) as ticks; unpriced prints are skipped. */
export function printTicks(prints: FlowPrint[]): CandleTick[] {
  const ticks: CandleTick[] = [];
  for (const print of prints) {
    if (typeof print.price !== "number" || !Number.isFinite(print.price) || print.price <= 0 || !Number.isFinite(print.time)) continue;
    ticks.push({ time: print.time, price: print.price, usd: print.usd !== null && Number.isFinite(print.usd) ? print.usd : null });
  }
  return ticks;
}

function alignTo(time: number, bucketMs: number): number {
  return Math.floor(time / bucketMs) * bucketMs;
}

/** OHLC = tick price, volume = summed USD notional (unpriced ticks add 0), one bar per bucket that saw a tick. Ascending. */
export function ticksToCandles(ticks: CandleTick[], bucketMs: number): MarketCandle[] {
  if (!(bucketMs > 0) || !Number.isFinite(bucketMs)) throw new RangeError(`ticksToCandles: bucketMs must be positive, got ${bucketMs}`);
  const byBucket = new Map<number, MarketCandle>();
  const ordered = [...ticks].sort((a, b) => a.time - b.time);
  for (const tick of ordered) {
    if (!Number.isFinite(tick.price) || tick.price <= 0) continue;
    const t = alignTo(tick.time, bucketMs);
    const usd = tick.usd ?? 0;
    const current = byBucket.get(t);
    byBucket.set(
      t,
      current
        ? { ...current, high: Math.max(current.high, tick.price), low: Math.min(current.low, tick.price), close: tick.price, volume: current.volume + usd }
        : { time: t, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: usd }
    );
  }
  return [...byBucket.values()].sort((a, b) => a.time - b.time);
}

/** Convenience for tests and the curve path: candles straight from timed swaps in quote units x `quoteUsd`. */
export function swapCandles(points: TimedSwapPoint[], bucketMs: number, quoteUsd = 1): MarketCandle[] {
  return ticksToCandles(pointTicks(points, quoteUsd), bucketMs);
}
