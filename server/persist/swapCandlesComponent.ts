import { z } from "zod";
import { MAX_BACKFILL_BLOCKS } from "../market/monad/swapBackfill.js";
import { BLOCK_MS } from "../market/monad/swapCandles.js";
import type { PoolCandleSnapshot, SwapCacheRestoreCounts, SwapCacheSnapshot } from "../market/monad/swapCache.js";
import { parseWith, tail, type ComponentSpec } from "./components.js";

/**
 * Snapshot component "swap-candles": the chain swap-candle cache's settled pools, bounded to the freshest
 * SWAP_SNAPSHOT_POOLS_CAP pools and the last SWAP_SNAPSHOT_POINTS_CAP swaps of each (~200 bytes a swap: at most ~8 MB,
 * under the store's 16 MB write cap; every drop is counted as `truncated`, which the manager logs before writing).
 * A pool cut short says so: its fromBlock/fromTime move up to the oldest kept swap, the cut is added to `trimmed`, and
 * stoppedBy becomes "depth" so a deeper request re-fetches below it instead of trusting a reach it no longer has.
 */
export const SWAP_SNAPSHOT_POOLS_CAP = 8;
export const SWAP_SNAPSHOT_POINTS_CAP = 5_000;
/** Past the top-up cap the restored head cannot be made continuous (the cache would reset it anyway): do not restore. */
export const SWAP_SNAPSHOT_MAX_AGE_MS = Math.round(MAX_BACKFILL_BLOCKS * BLOCK_MS);

const finite = z.number().finite();
const nonNegInt = z.number().int().nonnegative();
const pointSchema = z.object({
  block: nonNegInt,
  logIndex: nonNegInt,
  tx: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  price: finite.positive(),
  quoteUnits: finite,
  tokenUnits: finite,
  time: finite
});
const poolRefSchema = z.object({
  kind: z.enum(["v2", "v3", "v4"]),
  pair: z.string().min(1),
  ledgerPair: z.string().min(1),
  logAddress: z.string().min(1),
  dex: z.string(),
  token: z.string().min(1),
  quote: z.string().min(1),
  tokenIsCurrency0: z.boolean(),
  tokenDecimals: z.number().int().min(0).max(255),
  quoteDecimals: z.number().int().min(0).max(255),
  fee: z.number().int().nullable()
});
const poolSnapshotSchema = z.object({
  key: z.string().min(1),
  pool: poolRefSchema,
  points: z.array(pointSchema),
  fromBlock: nonNegInt,
  fromTime: finite,
  toBlock: nonNegInt,
  spanMs: finite,
  stoppedBy: z.enum(["depth", "cap", "genesis", "head", "error"]),
  chunks: nonNegInt,
  anchors: nonNegInt,
  estimatedChunks: nonNegInt,
  trimmed: nonNegInt
});
const swapCacheSnapshotSchema = z.object({ collectedAt: finite, pools: z.array(poolSnapshotSchema) });

type SwapCacheLike = { snapshot(): SwapCacheSnapshot; restore(snapshot: SwapCacheSnapshot): SwapCacheRestoreCounts };

/** Keeps the last `cap` swaps and moves the pool's vouched reach up to the oldest one kept. */
export function boundPool(pool: PoolCandleSnapshot, cap: number): { pool: PoolCandleSnapshot; truncated: number } {
  const kept = tail(pool.points, cap);
  if (kept.truncated === 0) return { pool, truncated: 0 };
  const oldest = kept.items[0];
  return {
    pool: { ...pool, points: kept.items, fromBlock: oldest.block, fromTime: oldest.time, trimmed: pool.trimmed + kept.truncated, stoppedBy: "depth" },
    truncated: kept.truncated
  };
}

export function swapCandlesComponent(owner: () => SwapCacheLike | null, poolsCap = SWAP_SNAPSHOT_POOLS_CAP, pointsCap = SWAP_SNAPSHOT_POINTS_CAP): ComponentSpec<SwapCacheSnapshot> {
  return {
    name: "swap-candles",
    version: 1,
    maxAgeMs: SWAP_SNAPSHOT_MAX_AGE_MS,
    collect: () => {
      const cache = owner();
      if (!cache) return null;
      const snapshot = cache.snapshot();
      const pools = tail(snapshot.pools, poolsCap);
      const bounded = pools.items.map((pool) => boundPool(pool, pointsCap));
      const truncated = pools.truncated + bounded.reduce((sum, entry) => sum + entry.truncated, 0);
      return { data: { collectedAt: snapshot.collectedAt, pools: bounded.map((entry) => entry.pool) }, truncated };
    },
    parse: (data) => parseWith(swapCacheSnapshotSchema)(data) as SwapCacheSnapshot | null,
    restore: (data) => {
      const cache = owner();
      return cache ? cache.restore(data) : null;
    }
  };
}
