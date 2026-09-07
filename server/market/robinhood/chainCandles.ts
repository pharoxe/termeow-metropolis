import type { CandleSourceInfo, FlowPrint, MarketCandle, PairRow } from "../../../shared/wire.js";
import type { EvmPoolRef } from "../../tape/robinhood/pools.js";
import { backfillSpanMs, DEFAULT_BARS } from "./swapBackfill.js";
import type { PoolCandleState, SwapCandleCache } from "./swapCache.js";
import { CANDLE_SOURCE_CHAIN, intervalMsOf, pointTicks, printTicks, ticksToCandles, type CandleTick } from "./swapCandles.js";

/**
 * Assembles one candle series for a Robinhood pool from the swap cache (history) plus the own tape's ring prints
 * (forming bar), under the single label "chain swaps". Only prints with source "own" (this server's decoded Swap logs)
 * are merged: the same ledger ring also holds GeckoTerminal trade prints, and those must never enter a series called
 * chain swaps. Throws with a reason whenever it cannot produce an honest series, so the caller can fall back to
 * GeckoTerminal and say so.
 */
export const CHAIN_TIMING = "block timestamps: two eth_getBlockByNumber anchors per 10,000-block chunk, linear interpolation between them (0.1 s blocks)";
/**
 * Share of the requested depth a first fill must reach before the chain series replaces the GeckoTerminal fallback;
 * below it the chart would collapse from hundreds of Gecko bars to the handful the first chunks hold and grow back.
 */
export const MIN_FILL_SHARE = 0.5;
const OWN_SOURCE: FlowPrint["source"] = "own";

export type ChainCandlesResult = {
  candles: MarketCandle[];
  candleSource: CandleSourceInfo;
  notes: string[];
  /** True when the last top-up failed: the head of the series is not vouched current (bars end at the last good head). */
  stale: boolean;
};

export type ChainCandleDeps = {
  /** Resolve the DexScreener row into a pool ref (token0/token1/decimals); null when the chain says no (reason via `resolveError`). */
  resolvePool: (row: PairRow) => Promise<EvmPoolRef | null>;
  resolveError?: () => string | null;
  cache: SwapCandleCache;
  /** USD per whole quote unit right now (EvmQuotePrice.prime + get); null when the quote cannot be priced. */
  quoteUsd: (quote: string) => Promise<number | null>;
  /** Ledger ring prints for a pair (FlowLedger.recentPrints), newest first, any source; filtered to "own" here. */
  livePrints: (pair: string) => FlowPrint[];
  now?: () => number;
  waitMs?: number;
  bars?: number;
};

function intervalOrThrow(interval: string): number {
  const ms = intervalMsOf(interval);
  if (ms === null) throw new Error(`unsupported interval ${interval}`);
  return ms;
}

function coverageOf(candles: MarketCandle[], prints: number, complete: boolean, backfilling: boolean): CandleSourceInfo["coverage"] {
  return { fromMs: candles[0]?.time ?? null, toMs: candles[candles.length - 1]?.time ?? null, bars: candles.length, prints, complete, backfilling };
}

/** Only this server's decoded Swap logs; GeckoTerminal and pump.fun prints share the ring but are other sources. */
export function ownPrints(prints: readonly FlowPrint[]): FlowPrint[] {
  return prints.filter((print) => print.source === OWN_SOURCE);
}

/**
 * Ring prints outside the range the backfill covers, oldest first: newer than the cached head (the forming bar) and,
 * while a fill is still shallow, older than its reach (same pool, same swaps, execution price). A print whose tx the
 * backfill already carries is dropped, so a ring print is displaced by its chain swap as soon as the fill reaches it.
 */
export function livePrintsOutside(prints: FlowPrint[], state: Pick<PoolCandleState, "points" | "fromTime">): FlowPrint[] {
  const newest = state.points[state.points.length - 1]?.time ?? -Infinity;
  const oldest = state.points.length === 0 ? Infinity : (state.fromTime ?? state.points[0].time);
  const known = new Set(state.points.map((point) => point.tx));
  return [...prints].reverse().filter((print) => (print.time > newest || print.time < oldest) && !known.has(print.tx));
}

function chainNotes(state: PoolCandleState, live: number, quoteUsd: number, pool: EvmPoolRef): string[] {
  const priceBasis = pool.kind === "v2" ? "per-swap execution price (quote units / token units; v2 logs carry no pool price)" : "post-swap pool price (sqrtPriceX96)";
  const notes = [
    `candles from ${pool.kind} Swap logs of ${pool.pair} (${state.points.length} swaps, ${state.chunks} chunks, ${state.anchors} block anchors; times interpolated between anchors; ${priceBasis})`,
    `USD via current ${pool.quote} price ${quoteUsd} (DexScreener), not a historical quote series`
  ];
  if (state.stoppedBy === "cap") notes.push("backfill depth capped at 240,000 blocks (~6.7 h); older bars not fetched");
  if (state.estimatedChunks > 0) notes.push(`${state.estimatedChunks} chunk(s) lacked a readable block anchor; their times are extrapolated at 100.9 ms/block`);
  if (state.error) notes.push(`chain backfill error: ${state.error} (series may be partial; head not current)`);
  if (state.backfilling) notes.push("backfill in progress: older bars arrive on the next read");
  if (state.trimmed > 0) notes.push(`${state.trimmed} oldest swaps dropped by the per-pool cap`);
  if (live > 0) notes.push(`${live} own-tape print(s) merged outside the backfilled range (forming bar; older ring prints until the fill reaches them; execution price, not pool price)`);
  return notes;
}

/** ms of history a fill vouches for, measured from now back to the oldest scanned block (0 before the first chunk). */
function coveredMs(state: PoolCandleState, now: number): number {
  return state.fromTime === null ? 0 : Math.max(0, now - state.fromTime);
}

/**
 * Chain candles for the primary pool: cache history (backfilled/topped up through rpc.ts) + own ring prints after the
 * cached head. Throws when the pool cannot be resolved, the quote cannot be priced in USD, the backfill failed with
 * nothing to show, a first fill is still shallower than MIN_FILL_SHARE of the request, or there is not one swap and
 * not one own print to chart: in each case the caller falls back to GeckoTerminal, labelled.
 */
export async function chainCandlesFor(row: PairRow, interval: string, deps: ChainCandleDeps): Promise<ChainCandlesResult> {
  const intervalMs = intervalOrThrow(interval);
  const pool = await deps.resolvePool(row);
  if (!pool) throw new Error(`pool ${row.pairAddress} unresolved: ${deps.resolveError?.() ?? "unknown"}`);
  const quoteUsd = await deps.quoteUsd(pool.quote);
  if (quoteUsd === null || !(quoteUsd > 0)) throw new Error(`quote ${pool.quote} has no USD price`);
  const spanMs = backfillSpanMs(intervalMs, deps.bars ?? DEFAULT_BARS);
  const state = await deps.cache.ensure(pool, spanMs, deps.waitMs);
  if (state.points.length === 0 && state.error && !state.backfilling) throw new Error(`chain backfill failed: ${state.error}`);
  const now = (deps.now ?? Date.now)();
  const covered = coveredMs(state, now);
  if (state.backfilling && state.stoppedBy === null && covered < spanMs * MIN_FILL_SHARE) {
    throw new Error(`chain backfill in progress: ${Math.round(covered / 60_000)} of ${Math.round(spanMs / 60_000)} min fetched (${state.points.length} swaps so far)`);
  }
  const live = livePrintsOutside(ownPrints(deps.livePrints(pool.ledgerPair)), state);
  if (state.points.length === 0 && live.length === 0) throw new Error(`chain backfill found no swaps ${state.backfilling ? "yet (still running)" : "in range"}`);
  const ticks: CandleTick[] = [...pointTicks(state.points, quoteUsd), ...printTicks(live)];
  const candles = ticksToCandles(ticks, intervalMs);
  const reached = state.stoppedBy === "depth" || state.stoppedBy === "genesis" || state.stoppedBy === "cap";
  const stale = state.error !== null && !state.backfilling;
  return {
    candles,
    candleSource: {
      kind: CANDLE_SOURCE_CHAIN,
      backfilledFrom: state.fromBlock !== null && state.fromTime !== null ? { block: state.fromBlock, time: state.fromTime } : null,
      coverage: coverageOf(candles, state.points.length, reached && !state.backfilling && state.error === null, state.backfilling),
      timing: CHAIN_TIMING,
      quoteUsd,
      live: live.length
    },
    notes: chainNotes(state, live.length, quoteUsd, pool),
    stale
  };
}
