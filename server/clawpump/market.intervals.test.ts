import { describe, expect, it } from "vitest";
import { aggregateCandles } from "./market.js";

describe("candle interval aggregation", () => {
  it("builds daily OHLCV from four-hour bars instead of relabeling them", () => {
    const bar = (time: number, open: number, close: number, volume: number) => ({ time, open, high: Math.max(open, close), low: Math.min(open, close), close, volume });
    expect(aggregateCandles([bar(8 * 3600e3, 4, 2, 30), bar(0, 1, 3, 10), bar(4 * 3600e3, 3, 4, 20), bar(86400e3, 2, 5, 40)], "1d"))
      .toEqual([{ time: 0, open: 1, high: 4, low: 1, close: 2, volume: 60 }, { time: 86400e3, open: 2, high: 5, low: 2, close: 5, volume: 40 }]);
  });
  it("leaves missing buckets empty rather than inventing trades", () => {
    expect(aggregateCandles([0, 3600e3].map(time => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 2 })), "15m").map(row => row.time)).toEqual([0, 3600e3]);
  });
});
