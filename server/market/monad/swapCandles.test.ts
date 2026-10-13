import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FlowPrint } from "../../../shared/wire.js";
import type { EvmLog } from "../../tape/monad/decode.js";
import { POOL_MANAGER, type EvmPoolRef } from "../../tape/monad/pools.js";
import {
  BLOCK_MS,
  decodeSwapPoint,
  decodeSwapPoints,
  interpolateBlockTime,
  intervalMsOf,
  pointTicks,
  printTicks,
  swapCandles,
  ticksToCandles,
  timePoints,
  tokenPriceFromSqrtX96,
  type BlockAnchor
} from "./swapCandles.js";

type FixtureLog = Omit<EvmLog, "address">;
type FixtureFile = { pool: string; logs: FixtureLog[] };
type Blocks = { fatcoinV4: { first: { number: number; timestampSec: number }; last: { number: number; timestampSec: number } }; gldV3: { first: { number: number; timestampSec: number }; last: { number: number; timestampSec: number } } };
type Gecko = { data: { attributes: { ohlcv_list: number[][] } } };

function load<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(`../__fixtures__/r6/${file}`, import.meta.url), "utf8")) as T;
}

function logs(files: string[], address: string): EvmLog[] {
  return files.flatMap((file) => load<FixtureFile>(file).logs.map((log) => ({ ...log, address })));
}

const BLOCKS = load<Blocks>("blocks.json");

/** LLY/FATCOIN Uniswap v4 (hooked). currency0 = FATCOIN (lower address), charted token = FATCOIN, quote = LLY. */
const FATCOIN_POOL: EvmPoolRef = {
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

/** GLD/USDG Uniswap v3: token0 = USDG (6 dec), token1 = GLD (18 dec), charted token = GLD (currency1). */
const GLD_POOL: EvmPoolRef = {
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

const FATCOIN_LOGS = logs(["fatcoin-v4-swaps-1.json", "fatcoin-v4-swaps-2.json"], POOL_MANAGER);
const GLD_LOGS = logs(["gld-v3-swaps-1.json", "gld-v3-swaps-2.json"], GLD_POOL.logAddress);
const FATCOIN_ANCHORS: BlockAnchor[] = [
  { block: BLOCKS.fatcoinV4.first.number, time: BLOCKS.fatcoinV4.first.timestampSec * 1000 },
  { block: BLOCKS.fatcoinV4.last.number, time: BLOCKS.fatcoinV4.last.timestampSec * 1000 }
];
const GLD_ANCHORS: BlockAnchor[] = [
  { block: BLOCKS.gldV3.first.number, time: BLOCKS.gldV3.first.timestampSec * 1000 },
  { block: BLOCKS.gldV3.last.number, time: BLOCKS.gldV3.last.timestampSec * 1000 }
];
const MINUTE = 60_000;

/** Gecko minute closes keyed by bucket ms, from the newest-first ohlcv_list. */
function geckoCloses(file: string): Map<number, number> {
  const rows = load<Gecko>(file).data.attributes.ohlcv_list;
  return new Map(rows.map((row) => [row[0] * 1000, row[4]]));
}

function agreement(ours: Map<number, number>, theirs: Map<number, number>, fromMs: number, toMs: number, scale: number): { compared: number; within1pct: number; maxRel: number } {
  let compared = 0;
  let within1pct = 0;
  let maxRel = 0;
  for (const [time, close] of ours) {
    if (time < fromMs || time > toMs) continue;
    const gecko = theirs.get(time);
    if (gecko === undefined) continue;
    compared += 1;
    const rel = Math.abs(close * scale - gecko) / gecko;
    maxRel = Math.max(maxRel, rel);
    if (rel <= 0.01) within1pct += 1;
  }
  return { compared, within1pct, maxRel };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe("sqrtPriceX96 price math", () => {
  it("reproduces DexScreener priceNative for the LLY/FATCOIN v4 pool from the last saved swap", () => {
    const llyPerFatcoin = tokenPriceFromSqrtX96(328973652497907759442971916n, FATCOIN_POOL);
    expect(llyPerFatcoin).not.toBeNull();
    expect(1 / (llyPerFatcoin as number)).toBeCloseTo(58001.194, 2);
  });

  it("flips the ratio when the charted token is currency1 and scales by the decimals gap (GLD in USDG)", () => {
    const last = decodeSwapPoint(GLD_LOGS[GLD_LOGS.length - 1], GLD_POOL);
    expect(last).not.toBeNull();
    // DexScreener priceUsd 410.73 and Gecko last close 409.72 at capture; the chain print sits between them.
    expect(last?.price).toBeGreaterThan(405);
    expect(last?.price).toBeLessThan(415);
    expect(tokenPriceFromSqrtX96(0n, GLD_POOL)).toBeNull();
  });
});

describe("decodeSwapPoints", () => {
  it("decodes all 200 saved FATCOIN v4 logs, ascending by block/logIndex, no duplicates", () => {
    const points = decodeSwapPoints(FATCOIN_LOGS, FATCOIN_POOL);
    expect(points).toHaveLength(200);
    expect(points[0].block).toBe(BLOCKS.fatcoinV4.first.number);
    expect(points[points.length - 1].block).toBe(BLOCKS.fatcoinV4.last.number);
    expect(points.every((point, index) => index === 0 || points[index - 1].block <= point.block)).toBe(true);
    expect(new Set(points.map((point) => `${point.tx}:${point.logIndex}`)).size).toBe(200);
    for (const point of points) {
      expect(point.price).toBeGreaterThan(0);
      expect(point.quoteUnits).toBeGreaterThan(0);
      expect(point.tokenUnits).toBeGreaterThan(0);
      expect(["buy", "sell"]).toContain(point.side);
    }
    expect(decodeSwapPoints([...FATCOIN_LOGS, FATCOIN_LOGS[0]], FATCOIN_POOL)).toHaveLength(200);
  });

  it("ignores logs of another pool and malformed data", () => {
    expect(decodeSwapPoint(GLD_LOGS[0], FATCOIN_POOL)).toBeNull();
    expect(decodeSwapPoint({ ...FATCOIN_LOGS[0], data: "0x1234" }, FATCOIN_POOL)).toBeNull();
    expect(decodeSwapPoint({ ...FATCOIN_LOGS[0], blockNumber: "nope" }, FATCOIN_POOL)).toBeNull();
  });
});

describe("interpolateBlockTime", () => {
  const anchors: BlockAnchor[] = [{ block: 100, time: 1_000_000 }, { block: 200, time: 1_010_000 }];

  it("is exact on anchors, linear between them and BLOCK_MS beyond them", () => {
    expect(interpolateBlockTime(100, anchors)).toBe(1_000_000);
    expect(interpolateBlockTime(200, anchors)).toBe(1_010_000);
    expect(interpolateBlockTime(150, anchors)).toBe(1_005_000);
    expect(interpolateBlockTime(210, anchors)).toBe(Math.round(1_010_000 + 10 * BLOCK_MS));
    expect(interpolateBlockTime(90, anchors)).toBe(Math.round(1_000_000 - 10 * BLOCK_MS));
    expect(() => interpolateBlockTime(1, [])).toThrow(/no anchors/);
  });

  it("places the two measured anchors 100.9 ms/block apart (the interpolation slope matches the chain)", () => {
    const [first, last] = FATCOIN_ANCHORS;
    expect((last.time - first.time) / (last.block - first.block)).toBeCloseTo(BLOCK_MS, 0);
  });
});

describe("ticksToCandles", () => {
  it("buckets by floor, OHLC from price, volume from usd (unpriced ticks add 0), absent buckets stay absent", () => {
    const candles = ticksToCandles(
      [
        { time: 61_000, price: 2, usd: 10 },
        { time: 59_000, price: 1, usd: null },
        { time: 62_000, price: 3, usd: 5 },
        { time: 63_000, price: 1.5, usd: 1 },
        { time: 190_000, price: 4, usd: 2 }
      ],
      MINUTE
    );
    expect(candles).toEqual([
      { time: 0, open: 1, high: 1, low: 1, close: 1, volume: 0 },
      { time: 60_000, open: 2, high: 3, low: 1.5, close: 1.5, volume: 16 },
      { time: 180_000, open: 4, high: 4, low: 4, close: 4, volume: 2 }
    ]);
    expect(() => ticksToCandles([], 0)).toThrow(RangeError);
  });

  it("turns prints into ticks only when they carry a positive price", () => {
    const prints: FlowPrint[] = [
      { chain: "monad", pair: "p", tx: "a", time: 1, side: "buy", usd: 5, source: "own", price: 0.5 },
      { chain: "monad", pair: "p", tx: "b", time: 2, side: "buy", usd: 5, source: "own" },
      { chain: "monad", pair: "p", tx: "c", time: 3, side: "buy", usd: null, source: "own", price: 0 }
    ];
    expect(printTicks(prints)).toEqual([{ time: 1, price: 0.5, usd: 5 }]);
    expect(pointTicks([{ block: 1, logIndex: 0, tx: "x", side: "buy", price: 2, quoteUnits: 3, tokenUnits: 1.5, time: 9 }], 10)).toEqual([{ time: 9, price: 20, usd: 30 }]);
    expect(intervalMsOf("15m")).toBe(900_000);
    expect(intervalMsOf("2m")).toBeNull();
  });
});

describe("agreement with GeckoTerminal minute candles (fixtures captured 2026-09-07 13:40-13:55Z)", () => {
  it("GLD/USDG v3: chain closes in USDG match Gecko USD closes within 1% on >= 90% of overlapping minutes (no free parameter)", () => {
    const points = timePoints(decodeSwapPoints(GLD_LOGS, GLD_POOL), GLD_ANCHORS);
    const ours = new Map(swapCandles(points, MINUTE, 1).map((candle) => [candle.time, candle.close]));
    // Full minutes inside both spans: logs 12:36:38Z..13:44:45Z, Gecko 08:38Z..13:50Z (see meta.json).
    const result = agreement(ours, geckoCloses("gecko-gld-v3-minute.json"), Date.UTC(2026, 8, 7, 12, 37), Date.UTC(2026, 8, 7, 13, 43), 1);
    expect(result.compared).toBeGreaterThanOrEqual(40);
    // Measured: 56/56 minutes within 1%, max relative gap 0.13%.
    expect(result.within1pct / result.compared).toBeGreaterThanOrEqual(0.9);
    expect(result.maxRel).toBeLessThan(0.01);
  });

  it("LLY/FATCOIN v4: per-minute USD volume matches Gecko x one LLY/USD scale, but Gecko's closes are NOT this pool's own price (measured)", () => {
    const points = timePoints(decodeSwapPoints(FATCOIN_LOGS, FATCOIN_POOL), FATCOIN_ANCHORS);
    const ours = swapCandles(points, MINUTE, 1);
    const gecko = new Map(load<Gecko>("gecko-fatcoin-v4-minute.json").data.attributes.ohlcv_list.map((row) => [row[0] * 1000, row]));
    const from = Date.UTC(2026, 8, 7, 11, 32);
    const to = Date.UTC(2026, 8, 7, 13, 44);
    const rows = ours.filter((candle) => candle.time >= from && candle.time <= to && gecko.has(candle.time)).map((candle) => ({ candle, gecko: gecko.get(candle.time) as number[] }));
    expect(rows.length).toBeGreaterThanOrEqual(80);
    // Gecko prices this pool in USD via its own LLY/USD; the fixture has no LLY/USD series, so one median scale stands in.
    const volumeScale = median(rows.map((row) => row.gecko[5] / row.candle.volume));
    expect(volumeScale).toBeGreaterThan(1100);
    expect(volumeScale).toBeLessThan(1250);
    const volumeWithin5pct = rows.filter((row) => Math.abs(row.candle.volume * volumeScale - row.gecko[5]) / row.gecko[5] <= 0.05).length;
    // Measured 84/89: the swaps we decode per minute are the swaps Gecko counts (timing + amounts hold).
    expect(volumeWithin5pct / rows.length).toBeGreaterThanOrEqual(0.9);
    const priceScale = median(rows.map((row) => row.gecko[4] / row.candle.close));
    const closeWithin1pct = rows.filter((row) => Math.abs(row.candle.close * priceScale - row.gecko[4]) / row.gecko[4] <= 0.01).length;
    // Measured 26/89 (0.29): Gecko's close sits flat (0.022763, 0.022760, 0.022758 ...) across minutes where the pool's own
    // LLY price moves 2%, so for a token-quoted pool Gecko's USD candles follow FATCOIN's global USD price, not this pool.
    // The 1%/90% bar is met on the USDG-quoted GLD pool above; here we record the figure rather than pretend.
    expect(closeWithin1pct / rows.length).toBeGreaterThan(0.2);
    expect(closeWithin1pct / rows.length).toBeLessThan(0.4);
  });
});
