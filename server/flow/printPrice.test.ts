import { describe, expect, it } from "vitest";
import { perTokenPrice, priceOf } from "./printPrice";

describe("perTokenPrice", () => {
  it("divides usd by absolute token units", () => {
    expect(perTokenPrice(152.3, 1233700.5)).toEqual({ price: 152.3 / 1233700.5 });
    expect(perTokenPrice(305.8, -1141.773729)).toEqual({ price: 305.8 / 1141.773729 });
    expect(perTokenPrice(0, 10)).toEqual({ price: 0 });
  });

  it("omits the key when either side is unknown, non-finite or the units are zero", () => {
    expect(perTokenPrice(null, 10)).toEqual({});
    expect(perTokenPrice(undefined, 10)).toEqual({});
    expect(perTokenPrice(10, null)).toEqual({});
    expect(perTokenPrice(10, undefined)).toEqual({});
    expect(perTokenPrice(10, 0)).toEqual({});
    expect(perTokenPrice(Number.NaN, 10)).toEqual({});
    expect(perTokenPrice(10, Number.POSITIVE_INFINITY)).toEqual({});
    expect(perTokenPrice(-1, 10)).toEqual({});
  });
});

describe("priceOf", () => {
  it("copies only a finite price off a print", () => {
    expect(priceOf({ price: 0.25 })).toEqual({ price: 0.25 });
    expect(priceOf({ price: null })).toEqual({});
    expect(priceOf({})).toEqual({});
    expect(priceOf({ price: Number.NaN })).toEqual({});
  });
});
