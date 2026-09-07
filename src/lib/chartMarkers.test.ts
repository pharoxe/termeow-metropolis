import { describe, expect, it } from "vitest";
import type { LargePrint } from "../../shared/wire";
import { LAUNCH_MARKER_SIZE, buildEventMarkers, largePrintText, mergeMarkers, sortMarkers, type ChartMarker } from "./chartMarkers";
import { FLOW_PALETTE } from "./flowChart";
import { MARKER_SIZE_BY_CLASS } from "./fomoMarkers";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;
const CANDLES = [0, 1, 2, 3].map((i) => T0 + i * MINUTE);

function print(time: number, side: LargePrint["side"], usd: number): LargePrint {
  return { pair: "0xpair", dex: "pons", tx: `0x${time}${side}${usd}`, time, side, usd, source: "own" };
}

describe("buildEventMarkers", () => {
  it("places launch and graduation on their containing candles", () => {
    const { markers, dropped, beforeRange } = buildEventMarkers(
      { launch: { createdAt: T0 + 10_000, launchpad: "pons" }, graduation: { time: T0 + 2 * MINUTE + 1 } },
      CANDLES,
      { theme: "dark" }
    );
    expect(dropped).toBe(0);
    expect(beforeRange).toBe(0);
    expect(markers).toEqual([
      { time: T0 / 1000, position: "belowBar", shape: "square", color: FLOW_PALETTE.dark.pair[0], text: "LAUNCH pons", size: LAUNCH_MARKER_SIZE },
      { time: (T0 + 2 * MINUTE) / 1000, position: "aboveBar", shape: "square", color: FLOW_PALETTE.dark.pair[1], text: "GRADUATED", size: LAUNCH_MARKER_SIZE }
    ]);
  });

  it("reports events before the first candle instead of placing them", () => {
    const { markers, beforeRange } = buildEventMarkers({ launch: { createdAt: T0 - 1, launchpad: "flap" }, largePrints: [print(T0 - 5, "buy", 900)] }, CANDLES, { theme: "dark" });
    expect(markers).toEqual([]);
    expect(beforeRange).toBe(2);
  });

  it("collapses large prints per candle and side with count and max USD", () => {
    const prints = [print(T0 + MINUTE + 1_000, "buy", 600), print(T0 + MINUTE + 2_000, "buy", 7_000), print(T0 + MINUTE + 3_000, "sell", 800)];
    const { markers } = buildEventMarkers({ largePrints: prints }, CANDLES, { theme: "light" });
    expect(markers).toHaveLength(2);
    expect(markers[0]).toEqual({
      time: (T0 + MINUTE) / 1000, position: "belowBar", shape: "circle", color: FLOW_PALETTE.light.buy, text: "×2 ≤$7K", size: MARKER_SIZE_BY_CLASS[2]
    });
    expect(markers[1]).toMatchObject({ position: "aboveBar", color: FLOW_PALETTE.light.sell, text: "$800", size: MARKER_SIZE_BY_CLASS[1] });
  });

  it("caps large-print groups by max USD and reports the dropped count; launch survives the cap", () => {
    const prints = [print(T0 + 1_000, "buy", 100), print(T0 + MINUTE + 1_000, "buy", 5_000), print(T0 + 2 * MINUTE + 1_000, "sell", 900)];
    const { markers, dropped } = buildEventMarkers({ launch: { createdAt: T0, launchpad: "bags" }, largePrints: prints }, CANDLES, { theme: "dark", maxLargePrintMarkers: 1 });
    expect(dropped).toBe(2);
    expect(markers.map((marker) => marker.text)).toEqual(["LAUNCH bags", "$5K"]);
  });

  it("returns everything as beforeRange with no candles and ignores unusable prints", () => {
    expect(buildEventMarkers({ launch: { createdAt: T0, launchpad: "x" }, largePrints: [print(T0, "buy", 1)] }, [], { theme: "dark" })).toEqual({ markers: [], dropped: 0, beforeRange: 2 });
    const { markers } = buildEventMarkers({ largePrints: [print(T0, "buy", Number.NaN)] }, CANDLES, { theme: "dark" });
    expect(markers).toEqual([]);
  });

  it("emits markers sorted by time as lightweight-charts requires", () => {
    const prints = [print(T0 + 3 * MINUTE, "sell", 900), print(T0, "buy", 900)];
    const { markers } = buildEventMarkers({ graduation: { time: T0 + MINUTE }, largePrints: prints }, CANDLES, { theme: "dark" });
    expect(markers.map((marker) => marker.time)).toEqual([T0 / 1000, (T0 + MINUTE) / 1000, (T0 + 3 * MINUTE) / 1000]);
  });
});

describe("largePrintText", () => {
  it("shows the max with ≤ only when several prints collapsed", () => {
    expect(largePrintText({ count: 1, maxUsd: 12_300 })).toBe("$12.3K");
    expect(largePrintText({ count: 3, maxUsd: 12_300 })).toBe("×3 ≤$12.3K");
  });
});

describe("mergeMarkers / sortMarkers", () => {
  it("merges FOMO and event markers into one time-sorted list, below before above, stable within ties", () => {
    const fomo: ChartMarker[] = [
      { time: 20, position: "aboveBar", shape: "arrowDown", color: "#f00", text: "alice" },
      { time: 10, position: "belowBar", shape: "arrowUp", color: "#0f0", text: "bob" }
    ];
    const events = buildEventMarkers({ largePrints: [print(T0, "buy", 900)] }, [T0 / 1000 * 1000], { theme: "dark" }).markers;
    const merged = mergeMarkers(fomo, events, undefined);
    expect(merged.map((marker) => marker.time)).toEqual([10, 20, T0 / 1000]);
    const tie = sortMarkers([
      { time: 5, position: "aboveBar", text: "a" },
      { time: 5, position: "belowBar", text: "b" },
      { time: 5, position: "aboveBar", text: "c" }
    ]);
    expect(tie.map((marker) => marker.text)).toEqual(["b", "a", "c"]);
  });
});
