import { describe, expect, it } from "vitest";
import { fomoBuyersByToken, type HolderFill } from "./holders.js";

const T1 = "0xaaaa000000000000000000000000000000000001";
const T2 = "0xbbbb000000000000000000000000000000000002";

function fill(overrides: Partial<HolderFill>): HolderFill {
  return { token: T1, trader: "0xw1", side: "buy", time: 1_000, ...overrides };
}

describe("fomoBuyersByToken", () => {
  it("counts distinct buyers per token, ignoring sells and fills before the window", () => {
    const counts = fomoBuyersByToken(
      [
        fill({ trader: "0xw1" }),
        fill({ trader: "0xW1" }),
        fill({ trader: "0xw2" }),
        fill({ trader: "0xw3", side: "sell" }),
        fill({ trader: "0xw4", time: 999 }),
        fill({ token: T2.toUpperCase(), trader: "0xw9", time: 5_000 })
      ],
      1_000
    );
    expect(counts.get(T1)).toBe(2);
    expect(counts.get(T2)).toBe(1);
    expect(counts.size).toBe(2);
  });

  it("returns an empty map for an empty tape, never a placeholder", () => {
    expect(fomoBuyersByToken([], 0).size).toBe(0);
  });

  it("treats a non-finite time as outside the window", () => {
    expect(fomoBuyersByToken([fill({ time: Number.NaN })], 0).size).toBe(0);
  });
});
