import { describe, expect, it } from "vitest";
import { mcapScale, scaleCandlesToMcap } from "./mcap";

const ansem = { priceUsd: 0.247, marketCapUsd: 246_467_226, fdvUsd: 250_000_000 };

describe("mcapScale", () => {
  it("computes supply from mcap / price", () => {
    const scale = mcapScale(ansem);
    expect(scale.source).toBe("mcap");
    expect(scale.mcap).toBe(246_467_226);
    expect(scale.supply).toBeCloseTo(246_467_226 / 0.247);
  });

  it("falls back to fdv when mcap is missing", () => {
    const scale = mcapScale({ priceUsd: 0.247, marketCapUsd: null, fdvUsd: 250_000_000 });
    expect(scale.source).toBe("fdv");
    expect(scale.supply).toBeCloseTo(250_000_000 / 0.247);
  });

  it("leaves supply null when both mcap and fdv are missing", () => {
    const scale = mcapScale({ priceUsd: 0.247, marketCapUsd: null, fdvUsd: null });
    expect(scale.source).toBeNull();
    expect(scale.supply).toBeNull();
    expect(scale.mcap).toBeNull();
  });
});

describe("scaleCandlesToMcap", () => {
  const candles = [
    { time: 1, open: 0.24, high: 0.25, low: 0.23, close: 0.247, volume: 12_000 }
  ];

  it("scales OHLC by supply and keeps USD volume", () => {
    const supply = 246_467_226 / 0.247;
    const [bar] = scaleCandlesToMcap(candles, supply);
    expect(bar.open).toBeCloseTo(0.24 * supply);
    expect(bar.high).toBeCloseTo(0.25 * supply);
    expect(bar.low).toBeCloseTo(0.23 * supply);
    expect(bar.close).toBeCloseTo(0.247 * supply);
    expect(bar.volume).toBe(12_000);
  });

  it("returns price candles when supply is missing", () => {
    expect(scaleCandlesToMcap(candles, null)).toEqual(candles);
  });
});
