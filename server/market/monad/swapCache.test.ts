import { describe, expect, it, vi } from "vitest";
import type { EvmPoolRef } from "../../tape/monad/pools.js";
import type { BackfillResult, ChunkResult } from "./swapBackfill.js";
import { REORG_RESCAN_BLOCKS } from "./swapBackfill.js";
import { SwapCandleCache, mergePoints, poolCacheKey, type BackfillFn, type TopUpFn } from "./swapCache.js";
import type { TimedSwapPoint } from "./swapCandles.js";

const POOL: EvmPoolRef = {
  kind: "v3",
  pair: "0x7a6a053eccf1446a2633e05aa6d40d09381997ec",
  ledgerPair: "0x7a6a053ECCf1446A2633e05Aa6d40d09381997EC",
  logAddress: "0x7a6a053eccf1446a2633e05aa6d40d09381997ec",
  dex: "uniswap",
  token: "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e",
  quote: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  tokenIsCurrency0: false,
  tokenDecimals: 18,
  quoteDecimals: 6,
  fee: 3000
};
const OTHER: EvmPoolRef = { ...POOL, pair: "0x1111111111111111111111111111111111111111", logAddress: "0x1111111111111111111111111111111111111111" };
const NOW = 1_788_788_000_000;

function point(block: number, logIndex = 0, price = 400): TimedSwapPoint {
  return { block, logIndex, tx: `0x${block.toString(16)}-${logIndex}`, side: "buy", price, quoteUnits: 10, tokenUnits: 10 / price, time: NOW - (1_000_000 - block) * 100 };
}

function result(points: TimedSwapPoint[], overrides: Partial<BackfillResult> = {}): BackfillResult {
  const blocks = points.map((p) => p.block);
  return {
    fromBlock: blocks.length ? Math.min(...blocks) : null,
    fromTime: points.length ? Math.min(...points.map((p) => p.time)) : null,
    toBlock: blocks.length ? Math.max(...blocks) : 0,
    chunks: 1,
    anchors: 2,
    estimatedChunks: 0,
    points,
    stoppedBy: "depth",
    error: null,
    ...overrides
  };
}

/** A finished chunk as the backfill reports it: bounds, its two anchors, and the time it reaches back to. */
function chunk(points: TimedSwapPoint[]): ChunkResult {
  const fromBlock = Math.min(...points.map((p) => p.block));
  const toBlock = Math.max(...points.map((p) => p.block));
  return { fromBlock, fromTime: point(fromBlock).time, toBlock, points, anchors: [{ block: fromBlock, time: point(fromBlock).time }, { block: toBlock, time: point(toBlock).time }], estimated: false };
}

type Fakes = { backfill: ReturnType<typeof vi.fn> & BackfillFn; topUp: ReturnType<typeof vi.fn> & TopUpFn };

function fakes(backfill: BackfillFn, topUp: TopUpFn = async (_pool, fromBlock) => result([], { fromBlock: fromBlock + 1, toBlock: fromBlock, chunks: 0, anchors: 0, stoppedBy: "head" })): Fakes {
  return { backfill: vi.fn(backfill) as Fakes["backfill"], topUp: vi.fn(topUp) as Fakes["topUp"] };
}

describe("mergePoints", () => {
  it("dedupes by tx:logIndex (incoming wins), sorts by block/logIndex and trims the oldest past the cap", () => {
    const merged = mergePoints([point(5), point(7)], [point(6), { ...point(5), price: 401 }, point(7, 1)], 3);
    expect(merged.trimmed).toBe(1);
    expect(merged.points.map((p) => [p.block, p.logIndex, p.price])).toEqual([[6, 0, 400], [7, 0, 400], [7, 1, 400]]);
    expect(poolCacheKey(POOL)).toBe(`${POOL.pair}:${POOL.token}`);
  });
});

describe("SwapCandleCache.ensure", () => {
  it("starts one backfill for a new pool, absorbs chunks as they land, and reports backfilling until it finishes", async () => {
    let finish: () => void = () => undefined;
    const f = fakes(async (_pool, run) => {
      run.onChunk?.(chunk([point(990_000), point(990_500)]));
      await new Promise<void>((resolve) => { finish = resolve; });
      run.onChunk?.(chunk([point(980_000), point(985_000)]));
      return result([point(980_000), point(985_000), point(990_000), point(990_500)], { chunks: 2, anchors: 4 });
    });
    const cache = new SwapCandleCache({ ...f, now: () => NOW });
    // 30 min asked; the fill reaches 2,000,000 ms back (block 980,000), so no deepening follows
    const [a, b] = await Promise.all([cache.ensure(POOL, 1_800_000, 10), cache.ensure(POOL, 1_800_000, 10)]);
    expect(f.backfill).toHaveBeenCalledTimes(1);
    expect(a.backfilling).toBe(true);
    expect(b.points.map((p) => p.block)).toEqual([990_000, 990_500]);
    // the first chunk is already visible: bounds, anchors and the time it reaches back to
    expect(a).toMatchObject({ fromBlock: 990_000, toBlock: 990_500, fromTime: point(990_000).time, chunks: 1, anchors: 2, stoppedBy: null, toppedUpAt: null });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const done = await cache.ensure(POOL, 1_800_000, 10);
    expect(f.backfill).toHaveBeenCalledTimes(1);
    expect(done.backfilling).toBe(false);
    expect(done.points.map((p) => p.block)).toEqual([980_000, 985_000, 990_000, 990_500]);
    expect(done).toMatchObject({ fromBlock: 980_000, toBlock: 990_500, stoppedBy: "depth", chunks: 2, anchors: 4, error: null });
    expect(done.toppedUpAt).toBe(NOW);
  });

  it("returns immediately with the empty state when waitMs elapses before the first chunk", async () => {
    const f = fakes(() => new Promise(() => undefined));
    const cache = new SwapCandleCache({ ...f, now: () => NOW });
    const state = await cache.ensure(POOL, 60_000, 5);
    expect(state.points).toEqual([]);
    expect(state.backfilling).toBe(true);
  });

  it("tops up a cached pool once its head is older than topUpMinMs, extending toBlock and keeping the history", async () => {
    let now = NOW;
    const f = fakes(async () => result([point(980_000), point(990_000)]), async (_pool, fromBlock) => result([point(990_010)], { fromBlock: fromBlock + 1, toBlock: 990_010, stoppedBy: "head" }));
    const cache = new SwapCandleCache({ ...f, now: () => now, topUpMinMs: 5_000 });
    await cache.ensure(POOL, 60_000, 100);
    await cache.ensure(POOL, 60_000, 100);
    expect(f.topUp).not.toHaveBeenCalled();
    now += 5_000;
    const state = await cache.ensure(POOL, 60_000, 100);
    // the top-up starts REORG_RESCAN_BLOCKS below the cached head so the re-read window can correct it
    expect(f.topUp).toHaveBeenCalledWith(POOL, 990_000 - REORG_RESCAN_BLOCKS, expect.any(Function));
    expect(state.points.map((p) => p.block)).toEqual([980_000, 990_010]);
    expect(state.toBlock).toBe(990_010);
    expect(state.fromBlock).toBe(980_000);
  });

  it("replaces the rescan window on top-up: a cached swap the chain no longer reports there goes, older history stays", async () => {
    let now = NOW;
    const phantom = point(990_000, 3);
    const f = fakes(
      async () => result([point(980_000), point(989_900), phantom, point(990_000, 4)]),
      async (_pool, fromBlock) => result([point(990_000, 4), point(990_020)], { fromBlock: fromBlock + 1, toBlock: 990_020, stoppedBy: "head" })
    );
    const cache = new SwapCandleCache({ ...f, now: () => now, topUpMinMs: 1 });
    await cache.ensure(POOL, 60_000, 100);
    now += 10;
    const state = await cache.ensure(POOL, 60_000, 100);
    expect(state.points.map((p) => [p.block, p.logIndex])).toEqual([[980_000, 0], [989_900, 0], [990_000, 4], [990_020, 0]]);
    // a top-up that fetched nothing (error before the first chunk) replaces nothing
    const failing = fakes(async () => result([point(980_000), phantom]), async (_pool, fromBlock) => result([], { fromBlock: fromBlock + 1, toBlock: fromBlock, chunks: 0, stoppedBy: "error", error: "upstream returned 429" }));
    const kept = new SwapCandleCache({ ...failing, now: () => now, topUpMinMs: 1 });
    await kept.ensure(POOL, 60_000, 100);
    now += 10;
    expect((await kept.ensure(POOL, 60_000, 100)).points.map((p) => p.block)).toEqual([980_000, 990_000]);
  });

  it("deepens below fromBlock when a later request wants more depth than a 'depth' fill reached", async () => {
    const f = fakes(async (_pool, run) => (run.toBlock === undefined ? result([point(990_000)]) : result([point(900_000)], { toBlock: run.toBlock })));
    const cache = new SwapCandleCache({ ...f, now: () => NOW, topUpMinMs: 3_600_000 });
    const shallow = await cache.ensure(POOL, 60_000, 100);
    expect(shallow.fromBlock).toBe(990_000);
    const deep = await cache.ensure(POOL, 6 * 3_600_000, 100);
    expect(f.backfill).toHaveBeenCalledTimes(2);
    expect(f.backfill.mock.calls[1][1]).toMatchObject({ toBlock: 989_999, spanMs: 6 * 3_600_000 });
    expect(deep.fromBlock).toBe(900_000);
    expect(deep.toBlock).toBe(990_000);
    expect(deep.points.map((p) => p.block)).toEqual([900_000, 990_000]);
  });

  it("drops a pool whose gap to the head exceeds the cap (long idle) and fills it afresh", async () => {
    let now = NOW;
    let fills = 0;
    const f = fakes(async () => result([point(fills++ === 0 ? 650_000 : 999_000)]), async (_pool, fromBlock) => result([], { fromBlock: fromBlock + 1, toBlock: fromBlock, chunks: 0, stoppedBy: "error", error: "gap of 300000 blocks exceeds 240000" }));
    const cache = new SwapCandleCache({ ...f, now: () => now, topUpMinMs: 1 });
    await cache.ensure(POOL, 60_000, 100);
    now += 10;
    const state = await cache.ensure(POOL, 60_000, 100);
    expect(f.topUp).toHaveBeenCalledTimes(1);
    expect(f.backfill).toHaveBeenCalledTimes(2);
    expect(state.points.map((p) => p.block)).toEqual([999_000]);
    expect(state.toBlock).toBe(999_000);
  });

  it("keeps the old history and records the error when a top-up fails for another reason", async () => {
    let now = NOW;
    const f = fakes(async () => result([point(990_000)]), async (_pool, fromBlock) => result([], { fromBlock: fromBlock + 1, toBlock: fromBlock, chunks: 0, stoppedBy: "error", error: "upstream returned 429" }));
    const cache = new SwapCandleCache({ ...f, now: () => now, topUpMinMs: 1 });
    await cache.ensure(POOL, 60_000, 100);
    now += 10;
    const state = await cache.ensure(POOL, 60_000, 100);
    expect(state.points).toHaveLength(1);
    expect(state.error).toBe("upstream returned 429");
    expect(state.toBlock).toBe(990_000);
  });

  it("evicts the least recently read pool past maxPools", async () => {
    const f = fakes(async () => result([point(990_000)]));
    const cache = new SwapCandleCache({ ...f, now: () => NOW, maxPools: 1 });
    await cache.ensure(POOL, 60_000, 100);
    await cache.ensure(OTHER, 60_000, 100);
    expect(cache.peek(POOL)).toBeNull();
    expect(cache.peek(OTHER)).not.toBeNull();
  });
});

describe("SwapCandleCache snapshot/restore", () => {
  it("serializes pools whose first fill finished (a pool mid-first-fill is left out, one mid-top-up is kept) with the cache clock as collectedAt", async () => {
    let finish: () => void = () => undefined;
    const f = fakes(async (pool, run) => {
      if (pool.pair === OTHER.pair) {
        run.onChunk?.(chunk([point(990_000)]));
        await new Promise<void>((resolve) => { finish = resolve; });
      }
      return result([point(980_000), point(990_000)]);
    });
    const cache = new SwapCandleCache({ ...f, now: () => NOW });
    await cache.ensure(POOL, 60_000, 100);
    void cache.ensure(OTHER, 60_000, 10);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const snapshot = cache.snapshot();
    expect(snapshot.collectedAt).toBe(NOW);
    expect(snapshot.pools.map((pool) => pool.key)).toEqual([poolCacheKey(POOL)]);
    expect(snapshot.pools[0]).toMatchObject({ pool: POOL, fromBlock: 980_000, toBlock: 990_000, stoppedBy: "depth", trimmed: 0 });
    expect(snapshot.pools[0].points.map((p) => p.block)).toEqual([980_000, 990_000]);
    expect("backfilling" in snapshot.pools[0]).toBe(false);
    finish();

    // a slow top-up must not empty the file: the pool stays in the snapshot with the points it holds
    let now = NOW;
    let release: () => void = () => undefined;
    const slow = fakes(async () => result([point(980_000), point(990_000)]), async (_pool, fromBlock) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return result([], { fromBlock: fromBlock + 1, toBlock: fromBlock, chunks: 0, stoppedBy: "head" });
    });
    const held = new SwapCandleCache({ ...slow, now: () => now, topUpMinMs: 1 });
    await held.ensure(POOL, 60_000, 100);
    now += 10;
    const mid = await held.ensure(POOL, 60_000, 10);
    expect(mid.backfilling).toBe(true);
    expect(held.snapshot().pools.map((pool) => [pool.key, pool.points.length, pool.toBlock])).toEqual([[poolCacheKey(POOL), 2, 990_000]]);
    release();
  });

  it("restores pools as stale-headed entries carrying the snapshot's age, never over a pool this process already holds", async () => {
    const source = new SwapCandleCache({ ...fakes(async () => result([point(980_000), point(990_000)])), now: () => NOW });
    await source.ensure(POOL, 60_000, 100);
    const snapshot = source.snapshot();
    const json = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;

    const target = new SwapCandleCache({ ...fakes(async () => result([point(999_000)])), now: () => NOW + 120_000 });
    expect(target.restore(json)).toEqual({ pools: 1, points: 2, skipped: 0 });
    const state = target.peek(POOL);
    expect(state).toMatchObject({ toBlock: 990_000, fromBlock: 980_000, toppedUpAt: null, backfilling: false, error: null, updatedAt: NOW + 120_000 });
    expect(state?.restored).toEqual({ at: NOW + 120_000, ageMs: 120_000, points: 2, toBlock: 990_000, headTime: point(990_000).time });
    expect(state?.points).toEqual([point(980_000), point(990_000)]);
    // a second restore does not replace the live entry; a key that does not match its ref is refused
    expect(target.restore(json)).toEqual({ pools: 0, points: 0, skipped: 1 });
    expect(target.restore({ collectedAt: NOW, pools: [{ ...json.pools[0], key: "bogus" }] })).toEqual({ pools: 0, points: 0, skipped: 1 });
    // the per-pool point cap applies on the way in, counted as trimmed
    const capped = new SwapCandleCache({ ...fakes(async () => result([])), now: () => NOW, maxPoints: 1 });
    expect(capped.restore(json)).toEqual({ pools: 1, points: 1, skipped: 0 });
    expect(capped.peek(POOL)).toMatchObject({ trimmed: 1, restored: expect.objectContaining({ points: 1 }) });
  });

  it("tops a restored pool up from its cached head on the first read and keeps the restored mark", async () => {
    const source = new SwapCandleCache({ ...fakes(async () => result([point(980_000), point(990_000)])), now: () => NOW });
    await source.ensure(POOL, 60_000, 100);
    const f = fakes(async () => result([point(1)]), async (_pool, fromBlock) => result([point(990_010)], { fromBlock: fromBlock + 1, toBlock: 990_010, stoppedBy: "head" }));
    const target = new SwapCandleCache({ ...f, now: () => NOW + 60_000 });
    target.restore(source.snapshot());
    const state = await target.ensure(POOL, 60_000, 100);
    expect(f.backfill).not.toHaveBeenCalled();
    expect(f.topUp).toHaveBeenCalledWith(POOL, 990_000 - REORG_RESCAN_BLOCKS, expect.any(Function));
    // the rescan window below the restored head is replaced by what the chain reports there now (990_000 was not re-reported)
    expect(state.points.map((p) => p.block)).toEqual([980_000, 990_010]);
    expect(state).toMatchObject({ toBlock: 990_010, toppedUpAt: NOW + 60_000, restored: expect.objectContaining({ points: 2, toBlock: 990_000 }) });
  });

  it("fills a restored pool afresh, dropping the restored mark, when the gap to the head exceeds the top-up cap", async () => {
    const source = new SwapCandleCache({ ...fakes(async () => result([point(650_000)])), now: () => NOW });
    await source.ensure(POOL, 60_000, 100);
    const f = fakes(async () => result([point(999_000)]), async (_pool, fromBlock) => result([], { fromBlock: fromBlock + 1, toBlock: fromBlock, chunks: 0, stoppedBy: "error", error: "gap of 1200000 blocks exceeds 1000000" }));
    const target = new SwapCandleCache({ ...f, now: () => NOW + 60_000 });
    target.restore(source.snapshot());
    const state = await target.ensure(POOL, 60_000, 100);
    expect(f.topUp).toHaveBeenCalledTimes(1);
    expect(f.backfill).toHaveBeenCalledTimes(1);
    expect(state.points.map((p) => p.block)).toEqual([999_000]);
    expect(state.restored).toBeNull();
    expect(state.toBlock).toBe(999_000);
  });
});
