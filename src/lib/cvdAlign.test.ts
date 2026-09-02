import { describe, expect, it } from "vitest";
import { alignFlowToCandles } from "./cvdAlign";
import type { Candle } from "../types";

function candle(time: number): Candle {
  return { time, open: 1, high: 1, low: 1, close: 1, volume: 1 };
}

describe("alignFlowToCandles", () => {
  const t0 = 1_700_000_000_000;

  it("skips candles before the first print, then splits cumulative CVD into per-bar delta", () => {
    const candles = [candle(t0), candle(t0 + 300000), candle(t0 + 600000), candle(t0 + 900000)];
    const { delta, cvd } = alignFlowToCandles(candles, [
      { time: t0 + 200000, value: 10 },
      { time: t0 + 250000, value: 40 },
      { time: t0 + 650000, value: 25 }
    ]);
    expect(delta.map((bar) => bar.value)).toEqual([40, 0, -15]);
    expect(cvd.map((bar) => bar.value)).toEqual([40, 40, 25]);
  });

  it("emits zero delta when a later candle has no new prints", () => {
    const { delta, cvd } = alignFlowToCandles(
      [candle(t0), candle(t0 + 300000)],
      [{ time: t0, value: 8 }]
    );
    expect(delta.map((bar) => bar.value)).toEqual([8, 0]);
    expect(cvd.map((bar) => bar.value)).toEqual([8, 8]);
  });
});
