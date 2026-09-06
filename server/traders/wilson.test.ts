import { describe, expect, it } from "vitest";
import { WILSON_MIN_N, wilsonLower } from "./wilson.js";

describe("wilsonLower", () => {
  it("returns null under the minimum sample", () => {
    expect(wilsonLower(4, 4)).toBeNull();
    expect(wilsonLower(0, 0)).toBeNull();
    expect(wilsonLower(3, WILSON_MIN_N - 1)).toBeNull();
  });

  it("returns a bound at exactly the minimum sample", () => {
    const low = wilsonLower(5, 5);
    expect(low).not.toBeNull();
    expect(low as number).toBeGreaterThan(0.5);
    expect(low as number).toBeLessThan(1);
  });

  it("matches the textbook value for 8 of 10 at z=1.96", () => {
    expect(wilsonLower(8, 10)).toBeCloseTo(0.4902, 3);
  });

  it("is 0 for zero wins and grows with sample size at a fixed rate", () => {
    expect(wilsonLower(0, 10)).toBe(0);
    expect(wilsonLower(50, 100) as number).toBeGreaterThan(wilsonLower(5, 10) as number);
  });

  it("rejects impossible counts and bad z", () => {
    expect(wilsonLower(6, 5)).toBeNull();
    expect(wilsonLower(-1, 10)).toBeNull();
    expect(wilsonLower(Number.NaN, 10)).toBeNull();
    expect(wilsonLower(5, 10, 0)).toBeNull();
  });
});
