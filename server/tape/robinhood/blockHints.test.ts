import { beforeEach, describe, expect, it } from "vitest";
import { blockHintStats, hintedBlockTimeMs, rememberBlockTime, resetBlockHints } from "./blockHints.js";

beforeEach(() => resetBlockHints());

describe("blockHints", () => {
  it("serves a remembered block time and counts stores and serves", () => {
    expect(hintedBlockTimeMs(57_022_486)).toBeNull();
    rememberBlockTime(57_022_486, 0x6a9ef825 * 1000);
    expect(hintedBlockTimeMs(57_022_486)).toBe(0x6a9ef825 * 1000);
    expect(blockHintStats()).toEqual({ size: 1, stored: 1, served: 1 });
  });

  it("keeps the first report for a block and ignores garbage (negative, fractional, zero or NaN times)", () => {
    rememberBlockTime(10, 5_000);
    rememberBlockTime(10, 6_000);
    rememberBlockTime(-1, 5_000);
    rememberBlockTime(1.5, 5_000);
    rememberBlockTime(11, 0);
    rememberBlockTime(12, Number.NaN);
    expect(hintedBlockTimeMs(10)).toBe(5_000);
    expect(hintedBlockTimeMs(11)).toBeNull();
    expect(blockHintStats().size).toBe(1);
  });

  it("evicts the oldest blocks past the ring size", () => {
    resetBlockHints(3);
    for (let block = 1; block <= 5; block += 1) rememberBlockTime(block, block * 1_000);
    expect(hintedBlockTimeMs(1)).toBeNull();
    expect(hintedBlockTimeMs(2)).toBeNull();
    expect(hintedBlockTimeMs(3)).toBe(3_000);
    expect(hintedBlockTimeMs(5)).toBe(5_000);
    expect(blockHintStats().size).toBe(3);
  });
});
