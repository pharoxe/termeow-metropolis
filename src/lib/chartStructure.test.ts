import { describe, expect, it } from "vitest";
import { recentRallyStructure } from "./chartStructure";

const bars = [10, 9, 8, 9, 11, 13, 15, 16, 15, 14].map((close, index) => ({
  time: index * 60_000, open: close - .2, high: close + .5, low: close - .5, close, volume: 1
}));

describe("recentRallyStructure", () => {
  it("calculates a 0.618 pullback from the recent upswing", () => {
    const rally = recentRallyStructure(bars)!;
    expect(rally.swingLow).toBe(7.5);
    expect(rally.swingHigh).toBe(16.5);
    expect(rally.retracement0618).toBeCloseTo(10.938);
  });
  it("does not invent structure from too few bars", () => expect(recentRallyStructure(bars.slice(0, 4))).toBeNull());
});
