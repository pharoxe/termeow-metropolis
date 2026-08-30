import { describe, expect, it } from "vitest";
import { atr, bollinger, ema, macd, obv, rsi, vwap } from "./indicators";

const values = Array.from({ length: 80 }, (_, index) => 10 + index * 0.2 + Math.sin(index / 3));

describe("indicators", () => {
  it("warms EMA after its period", () => {
    const result = ema(values, 20);
    expect(result.slice(0, 19).every((value) => value == null)).toBe(true);
    expect(result[19]).toBeTypeOf("number");
  });

  it("keeps RSI in range", () => {
    for (const value of rsi(values).filter((item) => item != null)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("orders Bollinger bands", () => {
    const last = bollinger(values).at(-1)!;
    expect(last.upper!).toBeGreaterThan(last.mid!);
    expect(last.lower!).toBeLessThan(last.mid!);
  });

  it("produces MACD and VWAP", () => {
    expect(macd(values).line.some((value) => value != null)).toBe(true);
    const candles = values.map((close, index) => ({ time: index, open: close - 0.1, high: close + 0.2, low: close - 0.2, close, volume: 100 + index }));
    expect(vwap(candles).at(-1)).toBeTypeOf("number");
    expect(atr(candles).at(-1)).toBeGreaterThan(0);
    expect(obv(candles)).toHaveLength(candles.length);
  });
});
