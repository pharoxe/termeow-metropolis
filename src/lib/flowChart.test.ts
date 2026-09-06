import { describe, expect, it } from "vitest";
import { FLOW_PALETTE, MAX_PAIR_LINES, buildFlowSeries, uncoveredUntil, type FlowChartInput, type FlowChartPair } from "./flowChart";
import type { FlowBar, FlowCoverage } from "../../shared/wire";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

function bar(index: number, buyUsd: number, sellUsd: number, cvd: number): FlowBar {
  return { t: T0 + index * MINUTE, buyUsd, sellUsd, buys: buyUsd > 0 ? 1 : 0, sells: sellUsd > 0 ? 1 : 0, unpricedBuys: 0, unpricedSells: 0, delta: buyUsd - sellUsd, cvd };
}

function coverage(firstPrintAt: number | null): FlowCoverage {
  return { fraction: 0.5, firstPrintAt, volumeShare: null, tierAPairs: 1, totalPairs: 2 };
}

function pair(index: number, tier: "A" | "B", bars: FlowBar[]): FlowChartPair {
  return { pairAddress: `pair${index}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, dex: "raydium", tier, bars };
}

const BARS = [bar(0, 100, 40, 60), bar(1, 0, 25, 35), bar(2, 50, 50, 35), bar(3, 0, 0, 35)];

function input(overrides: Partial<FlowChartInput> = {}): FlowChartInput {
  return { bars: BARS, pairs: [], coverage: null, candleTimes: BARS.map((entry) => entry.t), ...overrides };
}

describe("buildFlowSeries", () => {
  it("emits one buy and one sell point per bar in UTC seconds, sells negative, cvd copied", () => {
    const series = buildFlowSeries(input(), "dark");
    expect(series.buys).toHaveLength(BARS.length);
    expect(series.sells).toHaveLength(BARS.length);
    expect(series.cvd).toHaveLength(BARS.length);
    expect(series.buys[0]).toEqual({ time: T0 / 1000, value: 100, color: FLOW_PALETTE.dark.buy });
    expect(series.sells[0]).toEqual({ time: T0 / 1000, value: -40, color: FLOW_PALETTE.dark.sell });
    expect(series.sells.every((point) => point.value <= 0)).toBe(true);
    expect(series.cvd.map((point) => point.value)).toEqual(BARS.map((entry) => entry.cvd));
    expect(series.empty).toBe(false);
  });

  it("mutes bars before coverage.firstPrintAt and reports uncoveredUntil in seconds", () => {
    const firstPrintAt = T0 + 2 * MINUTE + 5_000;
    const series = buildFlowSeries(input({ coverage: coverage(firstPrintAt) }), "dark");
    expect(series.buys.slice(0, 3).map((point) => point.color)).toEqual(Array(3).fill(FLOW_PALETTE.dark.buyMuted));
    expect(series.sells.slice(0, 3).map((point) => point.color)).toEqual(Array(3).fill(FLOW_PALETTE.dark.sellMuted));
    expect(series.buys[3].color).toBe(FLOW_PALETTE.dark.buy);
    expect(series.uncoveredUntil).toBe((T0 + 2 * MINUTE) / 1000);
  });

  it("leaves everything unmuted and uncoveredUntil null without coverage", () => {
    const series = buildFlowSeries(input({ coverage: coverage(null) }), "light");
    expect(series.buys.every((point) => point.color === FLOW_PALETTE.light.buy)).toBe(true);
    expect(series.uncoveredUntil).toBeNull();
  });

  it("returns null uncoveredUntil when no candle precedes the first print", () => {
    expect(uncoveredUntil([T0, T0 + MINUTE], T0)).toBeNull();
    expect(uncoveredUntil([], T0 + MINUTE)).toBeNull();
  });

  it("computes sideShare in 0..100, colored by the 50 line, skipping bars with no priced volume", () => {
    const series = buildFlowSeries(input(), "dark");
    expect(series.sideShare).toHaveLength(3);
    expect(series.sideShare.map((point) => point.value)).toEqual([100 * 100 / 140, 0, 50]);
    expect(series.sideShare[0].color).toBe(FLOW_PALETTE.dark.buy);
    expect(series.sideShare[1].color).toBe(FLOW_PALETTE.dark.sell);
    expect(series.sideShare[2].color).toBe(FLOW_PALETTE.dark.buy);
    expect(series.sideShare.every((point) => point.value >= 0 && point.value <= 100)).toBe(true);
  });

  it("draws pair lines for Tier A pairs only, capped at MAX_PAIR_LINES", () => {
    const pairs = [pair(0, "B", BARS), ...Array.from({ length: 6 }, (_, index) => pair(index + 1, "A", BARS.slice(0, 2)))];
    const series = buildFlowSeries(input({ pairs }), "dark");
    expect(series.pairLines).toHaveLength(MAX_PAIR_LINES);
    expect(series.pairLines[0].label).toBe("raydium pair…xxxx");
    expect(series.pairLines[0].points).toEqual([{ time: T0 / 1000, value: 60 }, { time: (T0 + MINUTE) / 1000, value: 35 }]);
    expect(series.pairLines.some((line) => line.label.includes("pair0"))).toBe(false);
  });

  it("flags empty input and produces no points", () => {
    const series = buildFlowSeries(input({ bars: [], candleTimes: [] }), "dark");
    expect(series.empty).toBe(true);
    expect(series.buys).toEqual([]);
    expect(series.sideShare).toEqual([]);
    expect(series.cvd).toEqual([]);
  });

  it("sorts unordered bars and drops duplicate bucket times", () => {
    const series = buildFlowSeries(input({ bars: [BARS[2], BARS[0], BARS[1], { ...BARS[1], buyUsd: 9 }] }), "dark");
    expect(series.buys.map((point) => point.time)).toEqual([T0 / 1000, (T0 + MINUTE) / 1000, (T0 + 2 * MINUTE) / 1000]);
    expect(series.buys[1].value).toBe(9);
  });
});
