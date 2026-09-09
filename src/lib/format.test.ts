import { describe, expect, it } from "vitest";
import { axisUsd, money, pct, shortAddress, signedMoney } from "./format";

describe("money", () => {
  it("picks precision by magnitude, so a negative is not read as sub-cent", () => {
    // The regression: every negative is below both thresholds, so all of them took the 7-digit branch.
    expect(money(-1152.80684065719)).toBe("-$1,152.81");
    expect(money(-12.3456789)).toBe("-$12.35");
    expect(money(-0.523456789)).toBe("-$0.52346");
    expect(money(-0.0034567891)).toBe("-$0.0034568");
    // The positive side is unchanged, which is what made the bug survive: these were always right.
    expect(money(1152.80684065719)).toBe("$1,152.81");
    expect(money(0.523456789)).toBe("$0.52346");
    expect(money(0.0034567891)).toBe("$0.0034568");
  });

  it("keeps the significant digits of a sub-cent price", () => {
    expect(money(0.00000123456789)).toBe("$0.0000012");
    expect(money(-0.00000123456789)).toBe("-$0.0000012");
  });

  it("renders zero at cents and gives it no sign", () => {
    expect(money(0)).toBe("$0.00");
    expect(signedMoney(0, false)).toBe("$0.00");
  });

  it("answers an em dash for anything not a finite number", () => {
    for (const value of [null, undefined, NaN, Infinity, -Infinity]) expect(money(value)).toBe("—");
    for (const value of [null, undefined, NaN, Infinity]) expect(signedMoney(value)).toBe("—");
  });

  it("compacts both signs at the same scale", () => {
    expect(money(1_757_367.63, true)).toBe("$1.76M");
    expect(money(-1_757_367.63, true)).toBe("-$1.76M");
    expect(money(-1152.8, true)).toBe("-$1.15K");
  });
});

describe("signedMoney", () => {
  it("marks a gain and leaves the minus sign to do the rest", () => {
    expect(signedMoney(26005.26)).toBe("+$26.01K");
    expect(signedMoney(-1152.80684065719)).toBe("-$1.15K");
    expect(signedMoney(-1152.80684065719, false)).toBe("-$1,152.81");
  });
});

describe("pct", () => {
  it("signs a gain, never a loss twice, and rejects a non-number", () => {
    expect(pct(5.634)).toBe("+5.63%");
    expect(pct(-5.634)).toBe("-5.63%");
    expect(pct(0)).toBe("+0.00%");
    expect(pct(null)).toBe("—");
    expect(pct(NaN)).toBe("—");
  });
});

describe("axisUsd", () => {
  it("carries the sign through every scale", () => {
    expect(axisUsd(1_500_000)).toBe("$1.5M");
    expect(axisUsd(-1_500_000)).toBe("-$1.5M");
    expect(axisUsd(-2_400_000_000)).toBe("-$2.4B");
    expect(axisUsd(-999)).toBe("-$999.00");
    expect(axisUsd(-0.5)).toBe("-$0.5000");
    expect(axisUsd(-0.001234)).toBe("-$0.00123");
  });

  it("answers an empty string rather than a dash, because it labels a chart axis", () => {
    expect(axisUsd(null)).toBe("");
    expect(axisUsd(NaN)).toBe("");
  });
});

describe("shortAddress", () => {
  it("keeps both ends of an address and says when there is none", () => {
    expect(shortAddress("FZ8ofuKKQbZ6QKRGYb75hD2Un56MKJzF6zErpcLn3Cma")).toBe("FZ8o…3Cma");
    expect(shortAddress(null)).toBe("not connected");
    expect(shortAddress("")).toBe("not connected");
  });
});
