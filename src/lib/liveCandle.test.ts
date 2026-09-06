import { describe, expect, it } from "vitest";
import type { Candle } from "../types";
import {
  DEFAULT_INTERVAL_MS,
  applyPrintsToCandles,
  barLegend,
  bucketStartMs,
  dedupeAscending,
  inferIntervalMs,
  planCandleUpdate
} from "./liveCandle";

const MINUTE = 60_000;
const T0 = 1_788_717_000_000; // 2026-09-06 ~17:50 UTC, ms
const NOW = T0 + 3 * MINUTE + 30_000;

function bar(time: number, close: number, overrides: Partial<Candle> = {}): Candle {
  return { time, open: close, high: close, low: close, close, volume: 10, ...overrides };
}

const HISTORY = [bar(T0, 1), bar(T0 + MINUTE, 1.1), bar(T0 + 2 * MINUTE, 1.05)];

describe("dedupeAscending", () => {
  it("sorts, drops non-finite times and keeps the first of equal times", () => {
    const messy = [bar(T0 + MINUTE, 2), bar(T0, 1), bar(T0 + MINUTE, 3), bar(Number.NaN, 9)];
    expect(dedupeAscending(messy).map((c) => [c.time, c.close])).toEqual([[T0, 1], [T0 + MINUTE, 2]]);
    expect(dedupeAscending(HISTORY)).not.toBe(HISTORY); // new array, input untouched
  });
});

describe("planCandleUpdate", () => {
  it("is none for the same array, both empty, or identical content", () => {
    expect(planCandleUpdate(HISTORY, HISTORY).kind).toBe("none");
    expect(planCandleUpdate([], []).kind).toBe("none");
    expect(planCandleUpdate(HISTORY, HISTORY.map((c) => ({ ...c }))).kind).toBe("none");
  });
  it("updates when only the last bar changed", () => {
    const next = [...HISTORY.slice(0, 2), bar(T0 + 2 * MINUTE, 1.2, { volume: 40 })];
    const plan = planCandleUpdate(HISTORY, next);
    expect(plan.kind).toBe("update");
    expect(plan.bars).toEqual([next[2]]);
  });
  it("updates with the old tail then the new bar when one bar was appended", () => {
    const next = [...HISTORY, bar(T0 + 3 * MINUTE, 1.3)];
    const plan = planCandleUpdate(HISTORY, next);
    expect(plan.kind).toBe("update");
    expect(plan.bars.map((c) => c.time)).toEqual([T0 + 2 * MINUTE, T0 + 3 * MINUTE]);
  });
  it("resets on a different first time, interior revision, shrink, or growth over one", () => {
    expect(planCandleUpdate(HISTORY, HISTORY.slice(1)).kind).toBe("reset");
    expect(planCandleUpdate(HISTORY, [bar(T0, 1), bar(T0 + MINUTE, 9), HISTORY[2]]).kind).toBe("reset");
    expect(planCandleUpdate(HISTORY, HISTORY.slice(0, 2)).kind).toBe("reset");
    expect(planCandleUpdate(HISTORY, [...HISTORY, bar(T0 + 3 * MINUTE, 1), bar(T0 + 4 * MINUTE, 1)]).kind).toBe("reset");
    expect(planCandleUpdate([], HISTORY)).toEqual({ kind: "reset", bars: HISTORY });
    expect(planCandleUpdate(HISTORY, [])).toEqual({ kind: "reset", bars: [] });
  });
  it("resets when the tail slot moved to a different time (gap, not append)", () => {
    const next = [...HISTORY.slice(0, 2), bar(T0 + 5 * MINUTE, 1.2)];
    expect(planCandleUpdate(HISTORY, next).kind).toBe("reset");
  });
});

describe("bucketStartMs / inferIntervalMs", () => {
  it("aligns to epoch buckets including 5-second ones", () => {
    expect(bucketStartMs(T0 + 61_000, MINUTE)).toBe(T0 + MINUTE);
    expect(bucketStartMs(T0 + 7_400, 5_000)).toBe(T0 + 5_000);
  });
  it("infers spacing from the smallest positive gap and falls back", () => {
    expect(inferIntervalMs(HISTORY)).toBe(MINUTE);
    expect(inferIntervalMs([bar(T0 / 1000, 1), bar(T0 / 1000 + 5, 1)])).toBe(5_000);
    expect(inferIntervalMs([bar(T0, 1)])).toBe(DEFAULT_INTERVAL_MS);
    expect(inferIntervalMs([])).toBe(DEFAULT_INTERVAL_MS);
  });
});

describe("applyPrintsToCandles", () => {
  it("ticks the forming bar: high/low/close from print prices, volume += usd, open untouched", () => {
    const prints = [
      { time: T0 + 2 * MINUTE + 10_000, price: 1.3, usd: 100 },
      { time: T0 + 2 * MINUTE + 20_000, price: 0.9, usd: 50 },
      { time: T0 + 2 * MINUTE + 30_000, price: 1.0, usd: null }
    ];
    const { candles, stats } = applyPrintsToCandles(HISTORY, prints, MINUTE, NOW);
    expect(candles).toHaveLength(3);
    expect(candles[2]).toEqual({ time: T0 + 2 * MINUTE, open: 1.05, high: 1.3, low: 0.9, close: 1.0, volume: 160 });
    expect(stats).toEqual({ applied: 3, volumeOnly: 0, ignored: 0 });
    expect(HISTORY[2].close).toBe(1.05); // input not mutated
    expect(candles.slice(0, 2)).toEqual(HISTORY.slice(0, 2));
  });
  it("opens a new bar in a later bucket at its first print's price (nothing carried from the previous close), skipping empty buckets", () => {
    const prints = [{ time: T0 + 4 * MINUTE + 5_000, price: 1.5, usd: 20 }];
    const { candles } = applyPrintsToCandles(HISTORY, prints, MINUTE, T0 + 5 * MINUTE);
    expect(candles).toHaveLength(4); // bucket T0+3m had no print: not fabricated
    expect(candles[3]).toEqual({ time: T0 + 4 * MINUTE, open: 1.5, high: 1.5, low: 1.5, close: 1.5, volume: 20 });
  });
  it("counts unpriced prints in volume only and never lets them open a bar", () => {
    const inBar = [{ time: T0 + 2 * MINUTE + 5_000, price: null, usd: 30 }];
    const ticked = applyPrintsToCandles(HISTORY, inBar, MINUTE, NOW);
    expect(ticked.candles[2]).toEqual({ ...HISTORY[2], volume: 40 });
    expect(ticked.stats).toEqual({ applied: 0, volumeOnly: 1, ignored: 0 });
    const nextBucket = [{ time: T0 + 3 * MINUTE + 5_000, price: null, usd: 30 }];
    const untouched = applyPrintsToCandles(HISTORY, nextBucket, MINUTE, NOW);
    expect(untouched.candles).toHaveLength(3);
    expect(untouched.stats.ignored).toBe(1);
    const nothing = applyPrintsToCandles(HISTORY, [{ time: T0 + 2 * MINUTE + 5_000, price: null, usd: null }], MINUTE, NOW);
    expect(nothing.stats).toEqual({ applied: 0, volumeOnly: 0, ignored: 1 });
  });
  it("ignores prints before the last bar's open, in the future, or with bad times", () => {
    const prints = [
      { time: T0 + MINUTE + 30_000, price: 5, usd: 5 },
      { time: NOW + 1, price: 5, usd: 5 },
      { time: Number.NaN, price: 5, usd: 5 }
    ];
    const { candles, stats } = applyPrintsToCandles(HISTORY, prints, MINUTE, NOW);
    expect(candles).toEqual(HISTORY);
    expect(stats).toEqual({ applied: 0, volumeOnly: 0, ignored: 3 });
  });
  it("applies the mcap scale to print prices but not to usd volume", () => {
    const prints = [{ time: T0 + 2 * MINUTE + 5_000, price: 2, usd: 10 }];
    const scaled = HISTORY.map((c) => ({ ...c, open: c.open * 1000, high: c.high * 1000, low: c.low * 1000, close: c.close * 1000 }));
    const { candles } = applyPrintsToCandles(scaled, prints, MINUTE, NOW, 1000);
    expect(candles[2]).toMatchObject({ high: 2000, close: 2000, volume: 20 });
  });
  it("keeps candle times in seconds when the caller's candles are in seconds", () => {
    const seconds = HISTORY.map((c) => ({ ...c, time: c.time / 1000 }));
    const prints = [{ time: T0 + 3 * MINUTE + 1_000, price: 1.2, usd: 1 }];
    const { candles } = applyPrintsToCandles(seconds, prints, MINUTE, NOW);
    expect(candles[3].time).toBe((T0 + 3 * MINUTE) / 1000);
  });
  it("handles empty candles and sub-minute buckets", () => {
    const prints = [
      { time: T0 + 1_000, price: 1, usd: 1 },
      { time: T0 + 6_000, price: 2, usd: 1 }
    ];
    const { candles } = applyPrintsToCandles([], prints, 5_000, T0 + 10_000);
    expect(candles.map((c) => [c.time, c.open, c.close])).toEqual([[T0, 1, 1], [T0 + 5_000, 2, 2]]);
    expect(applyPrintsToCandles(HISTORY, [], MINUTE, NOW).candles).toBe(HISTORY);
    expect(applyPrintsToCandles(HISTORY, prints, 0, NOW).stats.ignored).toBe(2);
  });
});

describe("barLegend", () => {
  it("returns OHLCV in ms with change vs the previous close", () => {
    const legend = barLegend(HISTORY, 1);
    expect(legend).toMatchObject({ index: 1, time: T0 + MINUTE, open: 1.1, high: 1.1, low: 1.1, close: 1.1, volume: 10 });
    expect(legend?.changePct).toBeCloseTo(10, 9);
    expect(barLegend(HISTORY, 0)?.changePct).toBeNull();
    expect(barLegend(HISTORY.map((c) => ({ ...c, time: c.time / 1000 })), 2)?.time).toBe(T0 + 2 * MINUTE);
  });
  it("is null out of range and keeps unknown volume null", () => {
    expect(barLegend(HISTORY, 3)).toBeNull();
    expect(barLegend(HISTORY, -1)).toBeNull();
    expect(barLegend(HISTORY, null)).toBeNull();
    expect(barLegend([{ ...HISTORY[0], volume: Number.NaN }], 0)?.volume).toBeNull();
  });
});
