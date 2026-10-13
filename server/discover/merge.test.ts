import { describe, expect, it } from "vitest";
import type { DiscoverRow } from "../../shared/wire.js";
import { DISAGREE_FRACTION, disagrees, emptyFigures, mergeDiscover, rankRows, sourceRank, type DiscoverPartial } from "./merge.js";

const A = "0xaaaa000000000000000000000000000000000001";
const B = "0xbbbb000000000000000000000000000000000002";

function partial(overrides: Partial<DiscoverPartial> & { token: string; source: string }): DiscoverPartial {
  return { ...emptyFigures(), lastOkAt: 1, stale: false, rank: null, symbol: null, name: null, ...overrides };
}

describe("disagrees", () => {
  it("is false for one figure, equal figures, and spreads within the threshold", () => {
    expect(disagrees([])).toBe(false);
    expect(disagrees([1])).toBe(false);
    expect(disagrees([100, 100])).toBe(false);
    expect(disagrees([100, 100 * (1 - DISAGREE_FRACTION) + 0.001])).toBe(false);
    expect(disagrees([0, 0])).toBe(false);
  });

  it("is true past the threshold, including opposite signs on change figures", () => {
    expect(disagrees([100, 94])).toBe(true);
    expect(disagrees([-12, 3])).toBe(true);
    expect(disagrees([1e-9, 2e-9])).toBe(true);
  });
});

describe("mergeDiscover", () => {
  it("groups by token case-insensitively and keeps every source's figures side by side", () => {
    const rows = mergeDiscover(
      "monad",
      [
        partial({ token: A.toUpperCase(), source: "dex", priceUsd: 1, volumeUsd: 100, symbol: "AAA" }),
        partial({ token: A, source: "gecko", priceUsd: 2, volumeUsd: 100, rank: 0 }),
        partial({ token: B, source: "gecko", priceUsd: 5, rank: 1, symbol: "BBB" })
      ],
      ["dex", "gecko"]
    );
    expect(rows).toHaveLength(2);
    const a = rows.find((row) => row.token === A) as DiscoverRow;
    expect(a.symbol).toBe("AAA");
    expect(a.priceUsd).toBe(1);
    expect(a.sources.map((source) => [source.source, source.priceUsd])).toEqual([
      ["dex", 1],
      ["gecko", 2]
    ]);
    expect(a.disputed).toEqual(["priceUsd"]);
    expect(sourceRank(a, "gecko")).toBe(0);
    expect(sourceRank(a, "dex")).toBeNull();
  });

  it("takes the first non-null figure in precedence order and never averages", () => {
    const [row] = mergeDiscover(
      "monad",
      [partial({ token: A, source: "trenches", priceUsd: 3, liquidityUsd: 50 }), partial({ token: A, source: "dex", priceUsd: null, marketCapUsd: 9 })],
      ["dex", "trenches"]
    );
    expect(row.priceUsd).toBe(3);
    expect(row.marketCapUsd).toBe(9);
    expect(row.liquidityUsd).toBe(50);
    expect(row.volumeUsd).toBeNull();
    expect(row.disputed).toEqual([]);
    expect(row.sources.map((source) => source.source)).toEqual(["dex", "trenches"]);
  });

  it("flags nothing when one side is null and keeps unknown sources after the precedence list", () => {
    const [row] = mergeDiscover("monad", [partial({ token: A, source: "mystery", volumeUsd: 7 }), partial({ token: A, source: "dex", volumeUsd: null })], ["dex"]);
    expect(row.disputed).toEqual([]);
    expect(row.sources.map((source) => source.source)).toEqual(["dex", "mystery"]);
    expect(row.volumeUsd).toBe(7);
  });

  it("drops partials with an empty token", () => {
    expect(mergeDiscover("monad", [partial({ token: "", source: "dex" })], ["dex"])).toEqual([]);
  });
});

describe("rankRows", () => {
  const rows = mergeDiscover(
    "monad",
    [
      partial({ token: A, source: "gecko", rank: 1, volumeUsd: 10, changePct: -40, ageMs: 5_000, smartHolders: 2 }),
      partial({ token: B, source: "gecko", rank: 0, volumeUsd: 1, changePct: 15, ageMs: null, smartHolders: 0 }),
      partial({ token: "0xcccc000000000000000000000000000000000003", source: "dex", volumeUsd: 99, changePct: null, ageMs: 1_000, smartHolders: null })
    ],
    ["dex", "gecko"]
  );
  const tokens = (view: Parameters<typeof rankRows>[0]) => rankRows(view, rows, "gecko").map((row) => row.token.slice(0, 6));

  it("trending follows the ranked source, then volume for unranked rows", () => {
    expect(tokens("trending")).toEqual(["0xbbbb", "0xaaaa", "0xcccc"]);
  });

  it("movers orders by absolute change and drops rows without a change figure", () => {
    expect(tokens("movers")).toEqual(["0xaaaa", "0xbbbb"]);
  });

  it("new orders youngest first with unknown age last", () => {
    expect(tokens("new")).toEqual(["0xcccc", "0xaaaa", "0xbbbb"]);
  });

  it("holders keeps only rows with verified-SMART buyers, most first", () => {
    expect(tokens("holders")).toEqual(["0xaaaa"]);
  });

  it("does not mutate the input order", () => {
    const before = rows.map((row) => row.token);
    rankRows("new", rows, "gecko");
    expect(rows.map((row) => row.token)).toEqual(before);
  });
});
