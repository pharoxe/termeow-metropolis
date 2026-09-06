import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_MARKERS,
  MARKER_SIZE_BY_CLASS,
  buildFomoMarkers,
  candleIndexFor,
  markerText,
  sizeClass,
  summarizeFomo
} from "./fomoMarkers";
import { FLOW_PALETTE } from "./flowChart";
import type { FomoFill } from "../../shared/wire";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;
const CANDLES = [0, 1, 2, 3].map((i) => T0 + i * MINUTE);
const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function fill(overrides: Partial<FomoFill> & { time: number; side: FomoFill["side"]; usd: number | null }): FomoFill {
  return {
    chain: "robinhood",
    token: "0xtoken",
    pair: "0xpair",
    dex: "pons",
    tx: `0xtx${overrides.time}${overrides.side}${Math.random()}`,
    trader: { address: WALLET_A, kind: "fomo", handle: "alice", followers: 10 },
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

describe("buildFomoMarkers", () => {
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
    expect(buildFomoMarkers([fill({ time: T0, side: "buy", usd: 1 })], [], { theme: "dark" })).toEqual({ markers: [], dropped: 0, beforeRange: 1 });
  });

  it("collapses same wallet + side + candle into one marker with ×n and the summed usd", () => {
    const fills = [
      fill({ time: T0 + 1_000, side: "buy", usd: 600 }),
      fill({ time: T0 + 2_000, side: "buy", usd: 400 }),
      fill({ time: T0 + 3_000, side: "buy", usd: 200, trader: { address: WALLET_A.toUpperCase(), kind: "fomo", handle: "alice", followers: 10 } })
    ];
    const { markers } = buildFomoMarkers(fills, CANDLES, { theme: "dark" });
    expect(markers).toHaveLength(1);
    expect(markers[0].text).toBe("alice ×3 $1.2K");
    expect(markers[0].size).toBe(MARKER_SIZE_BY_CLASS[1]);
  });

  it("keeps different wallets, sides and candles apart", () => {
    const fills = [
      fill({ time: T0 + 1_000, side: "buy", usd: 100 }),
      fill({ time: T0 + 2_000, side: "sell", usd: 100 }),
      fill({ time: T0 + 3_000, side: "buy", usd: 100, trader: { address: WALLET_B, kind: "fomo", handle: null, followers: null } }),
      fill({ time: T0 + MINUTE + 1_000, side: "buy", usd: 100 })
    ];
    const { markers } = buildFomoMarkers(fills, CANDLES, { theme: "dark" });
    expect(markers).toHaveLength(4);
  });

  it("orders markers by time ascending, buys before sells, then wallet", () => {
    const fills = [
      fill({ time: T0 + 2 * MINUTE, side: "sell", usd: 50 }),
      fill({ time: T0 + 5_000, side: "sell", usd: 50 }),
      fill({ time: T0 + 5_000, side: "buy", usd: 50, trader: { address: WALLET_B, kind: "fomo", handle: "bob", followers: 1 } }),
      fill({ time: T0 + 5_000, side: "buy", usd: 50 })
    ];
    const { markers } = buildFomoMarkers(fills, CANDLES, { theme: "dark" });
    expect(markers.map((m) => m.time)).toEqual([T0 / 1000, T0 / 1000, T0 / 1000, (T0 + 2 * MINUTE) / 1000]);
    expect(markers.map((m) => m.text)).toEqual(["alice $50", "bob $50", "alice $50", "alice $50"]);
    expect(markers.slice(0, 3).map((m) => m.shape)).toEqual(["arrowUp", "arrowUp", "arrowDown"]);
  });

  it("caps at maxMarkers keeping the largest by usd, reports dropped, and re-sorts by time", () => {
    const fills = [
      fill({ time: T0 + 1_000, side: "buy", usd: 10 }),
      fill({ time: T0 + MINUTE + 1_000, side: "buy", usd: 9_000 }),
      fill({ time: T0 + 2 * MINUTE + 1_000, side: "buy", usd: null }),
      fill({ time: T0 + 3 * MINUTE + 1_000, side: "buy", usd: 700 })
    ];
    const { markers, dropped } = buildFomoMarkers(fills, CANDLES, { theme: "dark", maxMarkers: 2 });
    expect(dropped).toBe(2);
    expect(markers.map((m) => m.time)).toEqual([(T0 + MINUTE) / 1000, (T0 + 3 * MINUTE) / 1000]);
    expect(markers.map((m) => m.size)).toEqual([MARKER_SIZE_BY_CLASS[2], MARKER_SIZE_BY_CLASS[1]]);
  });

  it("defaults the cap to DEFAULT_MAX_MARKERS", () => {
    const candles = Array.from({ length: 100 }, (_, i) => T0 + i * MINUTE);
    const fills = candles.map((time, i) => fill({ time: time + 1, side: "buy", usd: i }));
    const { markers, dropped } = buildFomoMarkers(fills, candles, { theme: "dark" });
    expect(DEFAULT_MAX_MARKERS).toBe(60);
    expect(markers).toHaveLength(60);
    expect(dropped).toBe(40);
  });

  it("uses the light palette when asked", () => {
    const fills = [fill({ time: T0, side: "buy", usd: 1 }), fill({ time: T0, side: "sell", usd: 1 })];
    const { markers } = buildFomoMarkers(fills, CANDLES, { theme: "light" });
    expect(markers.map((m) => m.color)).toEqual([FLOW_PALETTE.light.buy, FLOW_PALETTE.light.sell]);
    expect(FLOW_PALETTE.light.buy).not.toBe(FLOW_PALETTE.dark.buy);
  });

  it("counts null-usd fills in ×n without summing them and omits the money when nothing is priced", () => {
    const fills = [fill({ time: T0, side: "sell", usd: null }), fill({ time: T0 + 1, side: "sell", usd: null })];
    const { markers } = buildFomoMarkers(fills, CANDLES, { theme: "dark" });
    expect(markers[0].text).toBe("alice ×2");
    expect(markers[0].size).toBe(MARKER_SIZE_BY_CLASS[0]);
    const mixed = buildFomoMarkers([...fills, fill({ time: T0 + 2, side: "sell", usd: 300 })], CANDLES, { theme: "dark" });
    expect(mixed.markers[0].text).toBe("alice ×3 $300");
  });

  it("falls back to the short address when the wallet has no handle", () => {
    const fills = [fill({ time: T0, side: "buy", usd: 5, trader: { address: WALLET_B, kind: "fomo", handle: null, followers: null } })];
    expect(buildFomoMarkers(fills, CANDLES, { theme: "dark" }).markers[0].text).toBe("0xbb…bbbb $5");
    expect(markerText({ address: WALLET_B, handle: "   ", count: 1, usd: null })).toBe("0xbb…bbbb");
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
    fill({ time: T0 + 2, side: "sell", usd: 30, trader: { address: WALLET_B, kind: "fomo", handle: null, followers: null } }),
    fill({ time: T0 + 3, side: "sell", usd: 20, trader: { address: WALLET_A.toUpperCase(), kind: "fomo", handle: "alice", followers: 10 } })
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
