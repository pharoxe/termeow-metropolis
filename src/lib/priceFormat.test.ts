import { describe, expect, it } from "vitest";
import { DEFAULT_MIN_MOVE, formatMicroPrice, formatSubscriptZeros, priceMinMove, pricePriceFormat } from "./priceFormat";

describe("formatMicroPrice", () => {
  it("uses subscript zeros with four significant digits under 0.001", () => {
    expect(formatMicroPrice(0.00000123456)).toBe("0.0₅1235");
    expect(formatMicroPrice(0.0000761)).toBe("0.0₄7610"); // FATCOIN/ETH priceNative scale
    expect(formatMicroPrice(0.000123)).toBe("0.0₃1230");
    expect(formatMicroPrice(1.23456e-13)).toBe("0.0₁₂1235"); // two-digit zero count
    expect(formatMicroPrice(-0.00000123456)).toBe("-0.0₅1235");
  });
  it("rounds across a magnitude boundary without a stray zero count", () => {
    expect(formatMicroPrice(0.0000999951)).toBe("0.0₃1000");
  });
  it("keeps sensible fixed precision above the micro threshold", () => {
    expect(formatMicroPrice(0.002423)).toBe("0.002423"); // ANSEM/SOL native
    expect(formatMicroPrice(0.02042)).toBe("0.02042"); // FATCOIN/USDG
    expect(formatMicroPrice(0.2579)).toBe("0.2579"); // ANSEM USD
    expect(formatMicroPrice(106.08)).toBe("106.0800");
    expect(formatMicroPrice(19_420_000)).toBe("19,420,000.00");
  });
  it("never invents a value", () => {
    expect(formatMicroPrice(null)).toBe("");
    expect(formatMicroPrice(undefined)).toBe("");
    expect(formatMicroPrice(Number.NaN)).toBe("");
    expect(formatMicroPrice(0)).toBe("0");
  });
});

describe("formatSubscriptZeros", () => {
  it("emits no subscript when there are no leading zeros", () => {
    expect(formatSubscriptZeros(0.5)).toBe("0.5000");
  });
});

describe("priceMinMove", () => {
  it("scales the axis step to the fourth significant digit of the sample", () => {
    expect(priceMinMove(0.2579)).toBeCloseTo(0.0001, 12);
    expect(priceMinMove(0.002423)).toBeCloseTo(0.000001, 15);
    expect(priceMinMove(0.00000761)).toBeCloseTo(1e-9, 18);
    expect(priceMinMove(106.08)).toBeCloseTo(0.01, 12);
  });
  it("clamps and falls back", () => {
    expect(priceMinMove(19_420_000)).toBe(0.01);
    expect(priceMinMove(1e-15)).toBe(1e-12);
    expect(priceMinMove(null)).toBe(DEFAULT_MIN_MOVE);
    expect(priceMinMove(0)).toBe(DEFAULT_MIN_MOVE);
    expect(priceMinMove(Number.NaN)).toBe(DEFAULT_MIN_MOVE);
  });
});

describe("pricePriceFormat", () => {
  it("builds a custom lightweight-charts price format", () => {
    const format = pricePriceFormat(0.00000761);
    expect(format.type).toBe("custom");
    expect(format.minMove).toBeCloseTo(1e-9, 18);
    expect(format.formatter(0.00000761)).toBe("0.0₅7610");
  });
});
