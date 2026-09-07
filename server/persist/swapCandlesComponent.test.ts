import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackfillResult } from "../market/robinhood/swapBackfill.js";
import { REORG_RESCAN_BLOCKS } from "../market/robinhood/swapBackfill.js";
import { SwapCandleCache, poolCacheKey } from "../market/robinhood/swapCache.js";
import { decodeSwapPoints, timePoints, type BlockAnchor, type TimedSwapPoint } from "../market/robinhood/swapCandles.js";
import type { EvmLog } from "../tape/robinhood/decode.js";
import { POOL_MANAGER, type EvmPoolRef } from "../tape/robinhood/pools.js";
import { SnapshotManager } from "./snapshot.js";
import { snapshotFile } from "./store.js";
import { SWAP_SNAPSHOT_MAX_AGE_MS, boundPool, swapCandlesComponent } from "./swapCandlesComponent.js";

type FixtureFile = { pool: string; logs: Omit<EvmLog, "address">[] };
type Blocks = { fatcoinV4: { first: { number: number; timestampSec: number }; last: { number: number; timestampSec: number } } };
function load<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(`../market/__fixtures__/r6/${file}`, import.meta.url), "utf8")) as T;
}

/** LLY/FATCOIN Uniswap v4: the r6 capture's 200 real Swap logs, timed on its two measured block anchors. */
const FATCOIN: EvmPoolRef = {
  kind: "v4",
  pair: "0x46ba8216b5d05ff33427b976663836ec5b34b3e261f374f9a5e773d776d3af85",
  ledgerPair: "0x46ba8216b5d05ff33427b976663836ec5b34b3e261f374f9a5e773d776d3af85",
  logAddress: POOL_MANAGER,
  dex: "uniswap",
  token: "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01",
  quote: "0x8005d266423c7ea827372c9c864491e5786600ea",
  tokenIsCurrency0: true,
  tokenDecimals: 18,
  quoteDecimals: 18,
  fee: null
};
const OTHER: EvmPoolRef = { ...FATCOIN, pair: "0x1111111111111111111111111111111111111111111111111111111111111111" };
const BLOCKS = load<Blocks>("blocks.json");
const ANCHORS: BlockAnchor[] = [
  { block: BLOCKS.fatcoinV4.first.number, time: BLOCKS.fatcoinV4.first.timestampSec * 1000 },
  { block: BLOCKS.fatcoinV4.last.number, time: BLOCKS.fatcoinV4.last.timestampSec * 1000 }
];
const LOGS: EvmLog[] = ["fatcoin-v4-swaps-1.json", "fatcoin-v4-swaps-2.json"].flatMap((file) => load<FixtureFile>(file).logs.map((log) => ({ ...log, address: POOL_MANAGER })));
const POINTS: TimedSwapPoint[] = timePoints(decodeSwapPoints(LOGS, FATCOIN), ANCHORS);
const HEAD = BLOCKS.fatcoinV4.last.number;
const T0 = ANCHORS[1].time + 60_000; // one minute after the capture's last block
const FP = "fp-test";
let dir: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "termeow-swapsnap-"));
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function manager(now = T0) {
  return new SnapshotManager({ dir, intervalMs: 30_000, fingerprint: FP, now: () => now, log: (message) => logs.push(message) });
}

function filled(points: TimedSwapPoint[], overrides: Partial<BackfillResult> = {}): BackfillResult {
  return { fromBlock: BLOCKS.fatcoinV4.first.number, fromTime: ANCHORS[0].time, toBlock: HEAD, chunks: 1, anchors: 2, estimatedChunks: 0, points, stoppedBy: "depth", error: null, ...overrides };
}
const idleTopUp = async (_pool: EvmPoolRef, fromBlock: number): Promise<BackfillResult> => filled([], { fromBlock: fromBlock + 1, toBlock: fromBlock, chunks: 0, anchors: 0, stoppedBy: "head" });

/** A cache holding the fixture swaps for `pools` as a finished "depth" fill at T0. */
async function sourceCache(pools: EvmPoolRef[], now = T0): Promise<SwapCandleCache> {
  const cache = new SwapCandleCache({ backfill: async () => filled(POINTS), topUp: idleTopUp, now: () => now });
  for (const pool of pools) await cache.ensure(pool, 3_600_000, 100);
  return cache;
}

describe("swap-candles component", () => {
  it("round-trips the r6 FATCOIN swaps exactly and restores them as a stale-headed pool that reports the file's age", async () => {
    expect(POINTS).toHaveLength(200);
    const source = await sourceCache([FATCOIN]);
    const saved = manager().register(swapCandlesComponent(() => source)).saveAll("test");
    expect(saved[0]).toMatchObject({ component: "swap-candles", skipped: null, truncated: 0 });
    expect(saved[0].bytes).toBeGreaterThan(20_000);

    const topUp = vi.fn(idleTopUp);
    const target = new SwapCandleCache({ backfill: async () => filled([]), topUp, now: () => T0 + 90_000 });
    const report = manager(T0 + 90_000).register(swapCandlesComponent(() => target)).restore("swap-candles");
    expect(report).toMatchObject({ skipped: null, savedAt: T0, ageMs: 90_000, counts: { pools: 1, points: 200, skipped: 0 } });
    const state = target.peek(FATCOIN);
    expect(state?.points).toEqual(POINTS);
    expect(state).toMatchObject({ fromBlock: BLOCKS.fatcoinV4.first.number, toBlock: HEAD, stoppedBy: "depth", toppedUpAt: null, backfilling: false });
    expect(state?.restored).toEqual({ at: T0 + 90_000, ageMs: 90_000, points: 200, toBlock: HEAD, headTime: POINTS[POINTS.length - 1].time });
    expect(logs.some((line) => /restored swap-candles .*pools 1, points 200/.test(line))).toBe(true);

    // the existing top-up logic extends the restored head on the first read instead of backfilling afresh
    const read = await target.ensure(FATCOIN, 3_600_000, 100);
    expect(topUp).toHaveBeenCalledWith(FATCOIN, HEAD - REORG_RESCAN_BLOCKS, expect.any(Function));
    expect(read.points).toHaveLength(200);
    expect(read.restored?.points).toBe(200);
  });

  it("bounds the file to the freshest pools and the last N swaps of each, moving a cut pool's reach up and counting every drop", async () => {
    const source = await sourceCache([OTHER, FATCOIN]);
    const component = swapCandlesComponent(() => source, 1, 50);
    const saved = manager().register(component).saveAll("test");
    // one pool dropped (the least recently read) + 150 swaps cut from the kept one
    expect(saved[0]).toMatchObject({ skipped: null, truncated: 151 });
    expect(logs).toContain("snapshot: swap-candles truncated by 151 before writing");

    const target = new SwapCandleCache({ backfill: async () => filled([]), topUp: idleTopUp, now: () => T0 + 1_000 });
    manager(T0 + 1_000).register(swapCandlesComponent(() => target)).restore("swap-candles");
    expect(target.peek(OTHER)).toBeNull();
    const state = target.peek(FATCOIN);
    const kept = POINTS.slice(150);
    expect(state?.points).toEqual(kept);
    // a cut pool vouches only for what it holds: reach moves up to the oldest kept swap, the cut is trimmed, depth is re-fetchable
    expect(state).toMatchObject({ fromBlock: kept[0].block, fromTime: kept[0].time, trimmed: 150, stoppedBy: "depth", toBlock: HEAD });

    const untouched = boundPool(source.snapshot().pools[1], 500);
    expect(untouched.truncated).toBe(0);
    expect(untouched.pool.points).toHaveLength(200);
  });

  it("skips a file of another version, a foreign fingerprint, an expired one past the top-up cap, and an invalid shape", async () => {
    const target = new SwapCandleCache({ backfill: async () => filled([]), topUp: idleTopUp, now: () => T0 });
    const file = snapshotFile(dir, "swap-candles", 1);
    const envelope = (over: Record<string, unknown>) => JSON.stringify({ component: "swap-candles", version: 1, savedAt: T0 - 1_000, fingerprint: FP, truncated: 0, data: { collectedAt: T0 - 1_000, pools: [] }, ...over });

    writeFileSync(file, envelope({ version: 2 }));
    expect(manager().register(swapCandlesComponent(() => target)).restore("swap-candles")).toMatchObject({ skipped: "version" });
    writeFileSync(file, envelope({ fingerprint: "elsewhere" }));
    expect(manager().register(swapCandlesComponent(() => target)).restore("swap-candles")).toMatchObject({ skipped: "fingerprint" });
    writeFileSync(file, envelope({ savedAt: T0 - SWAP_SNAPSHOT_MAX_AGE_MS - 1 }));
    expect(manager().register(swapCandlesComponent(() => target)).restore("swap-candles")).toMatchObject({ skipped: "expired" });
    writeFileSync(file, envelope({ data: { collectedAt: T0, pools: [{ key: "x", points: "nope" }] } }));
    expect(manager().register(swapCandlesComponent(() => target)).restore("swap-candles")).toMatchObject({ skipped: "invalid" });
    expect(target.peek(FATCOIN)).toBeNull();
    // no owner yet (the market path has not been read in this process): nothing applied, reported as such
    writeFileSync(file, envelope({}));
    expect(manager().register(swapCandlesComponent(() => null)).restore("swap-candles")).toMatchObject({ skipped: "no-owner" });
    expect(poolCacheKey(FATCOIN)).toBe(`${FATCOIN.pair}:${FATCOIN.token}`);
  });

  it("lets a restored pool whose gap to the head exceeds the cap reset and fill afresh through the cache's own top-up path", async () => {
    const source = await sourceCache([FATCOIN]);
    manager().register(swapCandlesComponent(() => source)).saveAll("test");
    const backfill = vi.fn(async () => filled(POINTS.slice(190), { fromBlock: POINTS[190].block, fromTime: POINTS[190].time, toBlock: HEAD + 1_200_000 }));
    const topUp = vi.fn(async (_pool: EvmPoolRef, fromBlock: number) => filled([], { fromBlock: fromBlock + 1, toBlock: fromBlock, chunks: 0, anchors: 0, stoppedBy: "error", error: "gap of 1200064 blocks exceeds 1000000" }));
    const target = new SwapCandleCache({ backfill, topUp, now: () => T0 + 3_600_000 });
    manager(T0 + 3_600_000).register(swapCandlesComponent(() => target)).restore("swap-candles");
    const state = await target.ensure(FATCOIN, 3_600_000, 100);
    expect(topUp).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(state.points).toEqual(POINTS.slice(190));
    expect(state.restored).toBeNull();
    expect(state.toBlock).toBe(HEAD + 1_200_000);
  });
});
