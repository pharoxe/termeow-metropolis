import { describe, expect, it } from "vitest";
import {
  COUNT_THRESHOLDS,
  DEFAULT_MAX_MARKERS,
  MARKER_SIZE_BY_CLASS,
  buildFomoMarkers,
  candleIndexFor,
  countSizeClass,
  indexFomoMarkersByTime,
  markerText,
  sizeClass,
  summarizeFomo
} from "./fomoMarkers";
import { FLOW_PALETTE } from "./flowChart";
import type { FomoFill, TraderRef } from "../../shared/wire";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;
const CANDLES = [0, 1, 2, 3].map((i) => T0 + i * MINUTE);
const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WALLET_C = "0xcccccccccccccccccccccccccccccccccccccccc";
const ALICE: TraderRef = { address: WALLET_A, kind: "fomo", handle: "alice", followers: 10 };
const BOB_NO_HANDLE: TraderRef = { address: WALLET_B, kind: "fomo", handle: null, followers: null };
const SEEDED_C: TraderRef = { address: WALLET_C, kind: "seeded", handle: "unipcs", followers: 514_576 };

function fill(overrides: Partial<FomoFill> & { time: number; side: FomoFill["side"]; usd: number | null }): FomoFill {
  return {
    chain: "robinhood",
    token: "0xtoken",
    pair: "0xpair",
    dex: "pons",
    tx: `0xtx${overrides.time}${overrides.side}${Math.random()}`,
    trader: ALICE,
    ...overrides
  };
}

describe("candleIndexFor", () => {
  it("returns the containing candle, -1 before the first and the last when beyond", () => {
    expect(candleIndexFor(CANDLES, T0)).toBe(0);
    expect(candleIndexFor(CANDLES, T0 + MINUTE - 1)).toBe(0);
    expect(candleIndexFor(CANDLES, T0 + MINUTE)).toBe(1);
    expect(candleIndexFor(CANDLES, T0 + 2 * MINUTE + 30_000)).toBe(2);
    expect(candleIndexFor(CANDLES, T0 - 1)).toBe(-1);
    expect(candleIndexFor(CANDLES, T0 + 99 * MINUTE)).toBe(3);
    expect(candleIndexFor([], T0)).toBe(-1);
  });
});

describe("buildFomoMarkers grouping", () => {
  it("places a fill on its containing candle in UTC seconds, buys below/up and sells above/down", () => {
    const fills = [fill({ time: T0 + MINUTE + 15_000, side: "buy", usd: 120 }), fill({ time: T0 + 2 * MINUTE + 59_999, side: "sell", usd: 80 })];
    const { markers, dropped, beforeRange } = buildFomoMarkers(fills, CANDLES, { theme: "dark" });
    expect(dropped).toBe(0);
    expect(beforeRange).toBe(0);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({ time: (T0 + MINUTE) / 1000, position: "belowBar", shape: "arrowUp", color: FLOW_PALETTE.dark.buy });
    expect(markers[1]).toMatchObject({ time: (T0 + 2 * MINUTE) / 1000, position: "aboveBar", shape: "arrowDown", color: FLOW_PALETTE.dark.sell });
  });

  it("snaps fills beyond the last candle to it and reports fills before the first candle without placing them", () => {
    const fills = [fill({ time: T0 - 5_000, side: "buy", usd: 10 }), fill({ time: T0 + 40 * MINUTE, side: "sell", usd: 20 })];
    const { markers, beforeRange } = buildFomoMarkers(fills, CANDLES, { theme: "dark" });
    expect(beforeRange).toBe(1);
    expect(markers).toHaveLength(1);
    expect(markers[0].time).toBe(CANDLES[3] / 1000);
  });

  it("returns nothing and counts every fill as beforeRange when there are no candles", () => {
    expect(buildFomoMarkers([fill({ time: T0, side: "buy", usd: 1 })], [], { theme: "dark" })).toEqual({ markers: [], dropped: 0, beforeRange: 1, seeded: 0 });
  });

  it("collapses every wallet on the same side + candle into ONE marker (the FATCOIN column)", () => {
    const fills = [
      fill({ time: T0 + 1_000, side: "buy", usd: 600 }),
      fill({ time: T0 + 2_000, side: "buy", usd: 400, trader: BOB_NO_HANDLE }),
      fill({ time: T0 + 3_000, side: "buy", usd: 200, trader: { ...ALICE, address: WALLET_A.toUpperCase() } })
    ];
    const { markers } = buildFomoMarkers(fills, CANDLES, { theme: "dark" });
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ text: "3 FOMO buys · $1.2K", fomoFills: 3, seededFills: 0, seeded: false });
    expect(markers[0].wallets.map((wallet) => [wallet.address.toLowerCase(), wallet.count, wallet.usd])).toEqual([[WALLET_A, 2, 800], [WALLET_B, 1, 400]]);
  });

  it("keeps sides and candles apart, so at most two markers stack on a bar", () => {
    const fills = [
      fill({ time: T0 + 1_000, side: "buy", usd: 100 }),
      fill({ time: T0 + 2_000, side: "sell", usd: 100 }),
      fill({ time: T0 + 3_000, side: "buy", usd: 100, trader: BOB_NO_HANDLE }),
      fill({ time: T0 + MINUTE + 1_000, side: "buy", usd: 100 })
    ];
    const { markers } = buildFomoMarkers(fills, CANDLES, { theme: "dark" });
    expect(markers.map((m) => [m.time, m.side, m.fomoFills])).toEqual([[T0 / 1000, "buy", 2], [T0 / 1000, "sell", 1], [(T0 + MINUTE) / 1000, "buy", 1]]);
  });

  it("orders markers by time ascending, buys before sells", () => {
    const fills = [
      fill({ time: T0 + 2 * MINUTE, side: "sell", usd: 50 }),
      fill({ time: T0 + 5_000, side: "sell", usd: 50 }),
      fill({ time: T0 + 5_000, side: "buy", usd: 50, trader: BOB_NO_HANDLE })
    ];
    const { markers } = buildFomoMarkers(fills, CANDLES, { theme: "dark" });
    expect(markers.map((m) => [m.time, m.shape])).toEqual([[T0 / 1000, "arrowUp"], [T0 / 1000, "arrowDown"], [(T0 + 2 * MINUTE) / 1000, "arrowDown"]]);
  });
});

describe("buildFomoMarkers text", () => {
  it("names the wallet when the bucket is exactly one fill with a handle", () => {
    const { markers } = buildFomoMarkers([fill({ time: T0, side: "buy", usd: 747, trader: { ...ALICE, handle: "frankdegods" } })], CANDLES, { theme: "dark" });
    expect(markers[0].text).toBe("frankdegods buy $747");
  });

  it("falls back to the count form when the single fill has no handle (never invents a name)", () => {
    const { markers } = buildFomoMarkers([fill({ time: T0, side: "sell", usd: 5, trader: BOB_NO_HANDLE })], CANDLES, { theme: "dark" });
    expect(markers[0].text).toBe("1 FOMO sell · $5");
  });

  it("omits the money when nothing is priced and sums only priced fills otherwise", () => {
    const unpriced = [fill({ time: T0, side: "sell", usd: null }), fill({ time: T0 + 1, side: "sell", usd: null, trader: BOB_NO_HANDLE })];
    const { markers } = buildFomoMarkers(unpriced, CANDLES, { theme: "dark" });
    expect(markers[0].text).toBe("2 FOMO sells");
    expect(markers[0].wallets.map((wallet) => [wallet.usd, wallet.unpriced])).toEqual([[null, 1], [null, 1]]);
    const single = buildFomoMarkers([fill({ time: T0, side: "sell", usd: null })], CANDLES, { theme: "dark" });
    expect(single.markers[0].text).toBe("alice sell");
    const mixed = buildFomoMarkers([...unpriced, fill({ time: T0 + 2, side: "sell", usd: 300 })], CANDLES, { theme: "dark" });
    expect(mixed.markers[0].text).toBe("3 FOMO sells · $300");
    expect(mixed.markers[0].wallets.map((wallet) => [wallet.usd, wallet.unpriced])).toEqual([[300, 1], [null, 1]]);
  });

  it("pluralises by count", () => {
    expect(markerText({ side: "buy", fomoFills: 1, seededFills: 0, usd: null, soleHandle: null })).toBe("1 FOMO buy");
    expect(markerText({ side: "buy", fomoFills: 2, seededFills: 0, usd: 12_000, soleHandle: null })).toBe("2 FOMO buys · $12K");
  });
});

describe("buildFomoMarkers seeded handling", () => {
  it("prefixes an all-seeded bucket with SEEDED, mutes its color and counts it in `seeded`", () => {
    const fills = [fill({ time: T0 + 1_000, side: "buy", usd: 10, trader: SEEDED_C }), fill({ time: T0 + 2_000, side: "buy", usd: 30, trader: { ...SEEDED_C, address: WALLET_B } })];
    const { markers, seeded } = buildFomoMarkers(fills, CANDLES, { theme: "dark" });
    expect(seeded).toBe(1);
    expect(markers[0]).toMatchObject({ text: "SEEDED 2 buys · $40", seeded: true, fomoFills: 0, seededFills: 2, color: FLOW_PALETTE.dark.marker });
  });

  it("names a lone seeded wallet with the SEEDED prefix", () => {
    const { markers } = buildFomoMarkers([fill({ time: T0, side: "sell", usd: 40, trader: SEEDED_C })], CANDLES, { theme: "dark" });
    expect(markers[0].text).toBe("SEEDED unipcs sell $40");
    expect(markers[0].seeded).toBe(true);
  });

  it("counts seeded fills separately in a mixed bucket, which keeps the FOMO color and is not counted as seeded", () => {
    const fills = [
      fill({ time: T0 + 1_000, side: "buy", usd: 1_000 }),
      fill({ time: T0 + 2_000, side: "buy", usd: 200, trader: BOB_NO_HANDLE }),
      fill({ time: T0 + 3_000, side: "buy", usd: 40, trader: SEEDED_C })
    ];
    const { markers, seeded } = buildFomoMarkers(fills, CANDLES, { theme: "dark" });
    expect(seeded).toBe(0);
    expect(markers[0]).toMatchObject({ text: "2 FOMO buys + 1 SEEDED · $1.24K", seeded: false, color: FLOW_PALETTE.dark.buy });
    expect(markers[0].wallets.map((wallet) => wallet.kind)).toEqual(["fomo", "fomo", "seeded"]);
  });
});

describe("buildFomoMarkers sizes", () => {
  it("scales by fill count in three bounded classes, not by usd", () => {
    expect(COUNT_THRESHOLDS).toEqual([2, 5]);
    expect(countSizeClass(1)).toBe(0);
    expect(countSizeClass(2)).toBe(1);
    expect(countSizeClass(4)).toBe(1);
    expect(countSizeClass(5)).toBe(2);
    expect(countSizeClass(50)).toBe(2);
    const one = buildFomoMarkers([fill({ time: T0, side: "buy", usd: 50_000 })], CANDLES, { theme: "dark" });
    expect(one.markers[0].size).toBe(MARKER_SIZE_BY_CLASS[0]);
    const five = buildFomoMarkers(Array.from({ length: 5 }, (_, i) => fill({ time: T0 + i, side: "buy", usd: 1 })), CANDLES, { theme: "dark" });
    expect(five.markers[0].size).toBe(MARKER_SIZE_BY_CLASS[2]);
  });

  it("uses the light palette when asked", () => {
    const fills = [fill({ time: T0, side: "buy", usd: 1 }), fill({ time: T0, side: "sell", usd: 1 })];
    const { markers } = buildFomoMarkers(fills, CANDLES, { theme: "light" });
    expect(markers.map((m) => m.color)).toEqual([FLOW_PALETTE.light.buy, FLOW_PALETTE.light.sell]);
    expect(FLOW_PALETTE.light.buy).not.toBe(FLOW_PALETTE.dark.buy);
  });
});

describe("buildFomoMarkers cap", () => {
  it("caps at maxMarkers over buckets keeping the largest by usd, reports dropped, and re-sorts by time", () => {
    const fills = [
      fill({ time: T0 + 1_000, side: "buy", usd: 10 }),
      fill({ time: T0 + MINUTE + 1_000, side: "buy", usd: 9_000 }),
      fill({ time: T0 + 2 * MINUTE + 1_000, side: "buy", usd: null }),
      fill({ time: T0 + 3 * MINUTE + 1_000, side: "buy", usd: 700 })
    ];
    const { markers, dropped } = buildFomoMarkers(fills, CANDLES, { theme: "dark", maxMarkers: 2 });
    expect(dropped).toBe(2);
    expect(markers.map((m) => m.time)).toEqual([(T0 + MINUTE) / 1000, (T0 + 3 * MINUTE) / 1000]);
  });

  it("defaults the cap to DEFAULT_MAX_MARKERS and never cuts fills within a kept bucket", () => {
    const candles = Array.from({ length: 100 }, (_, i) => T0 + i * MINUTE);
    const fills = candles.flatMap((time, i) => [fill({ time: time + 1, side: "buy", usd: i }), fill({ time: time + 2, side: "buy", usd: i, trader: BOB_NO_HANDLE })]);
    const { markers, dropped } = buildFomoMarkers(fills, candles, { theme: "dark" });
    expect(DEFAULT_MAX_MARKERS).toBe(60);
    expect(markers).toHaveLength(60);
    expect(dropped).toBe(40);
    expect(markers.every((m) => m.fomoFills + m.seededFills === 2)).toBe(true);
  });
});

describe("lookup", () => {
  const fills = [
    fill({ time: T0 + 1_000, side: "buy", usd: 100 }),
    fill({ time: T0 + 2_000, side: "sell", usd: 50, trader: BOB_NO_HANDLE }),
    fill({ time: T0 + 2 * MINUTE, side: "buy", usd: 1 })
  ];
  const { markers } = buildFomoMarkers(fills, CANDLES, { theme: "dark" });

  it("indexFomoMarkersByTime keys the candle's buckets by its UTC seconds, buy first, nothing for an empty candle", () => {
    const byTime = indexFomoMarkersByTime(markers);
    expect(byTime.get(T0 / 1000)?.map((m) => m.side)).toEqual(["buy", "sell"]);
    expect(byTime.get(T0 / 1000)?.[1].wallets[0].address).toBe(WALLET_B);
    expect(byTime.get((T0 + MINUTE) / 1000)).toBeUndefined();
    expect(byTime.get((T0 + 2 * MINUTE) / 1000)).toHaveLength(1);
    expect(indexFomoMarkersByTime([]).size).toBe(0);
  });
});

describe("sizeClass", () => {
  it("buckets by usd with null as the smallest", () => {
    expect(sizeClass(null)).toBe(0);
    expect(sizeClass(499.99)).toBe(0);
    expect(sizeClass(500)).toBe(1);
    expect(sizeClass(4_999)).toBe(1);
    expect(sizeClass(5_000)).toBe(2);
    expect(MARKER_SIZE_BY_CLASS[0]).toBeGreaterThan(0);
  });
});

describe("summarizeFomo", () => {
  const fills = [
    fill({ time: T0, side: "buy", usd: 100 }),
    fill({ time: T0 + 1, side: "buy", usd: null }),
    fill({ time: T0 + 2, side: "sell", usd: 30, trader: BOB_NO_HANDLE }),
    fill({ time: T0 + 3, side: "sell", usd: 20, trader: { ...ALICE, address: WALLET_A.toUpperCase() } })
  ];

  it("sums priced buys and sells, nets them, counts unpriced and distinct wallets case-insensitively", () => {
    expect(summarizeFomo(fills, T0 + MINUTE)).toEqual({ buyUsd: 100, sellUsd: 50, net: 50, wallets: 2, fills: 4, unpriced: 1 });
  });

  it("ignores fills stamped after nowMs and, when a window is given, older than it", () => {
    expect(summarizeFomo(fills, T0 + 1).fills).toBe(2);
    expect(summarizeFomo(fills, T0 + 3, 1).fills).toBe(2);
    expect(summarizeFomo([], T0)).toEqual({ buyUsd: 0, sellUsd: 0, net: 0, wallets: 0, fills: 0, unpriced: 0 });
  });
});
