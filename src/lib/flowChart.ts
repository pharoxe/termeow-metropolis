import type { FlowBar, FlowCoverage } from "../../shared/wire";

/** Pure series builders for the F4 flow panes. No chart-library imports: tested in node. */

export type FlowChartTheme = "dark" | "light";
export type HistogramPoint = { time: number; value: number; color: string };
export type LinePoint = { time: number; value: number };
export type FlowChartPair = { pairAddress: string; dex: string; tier: "A" | "B"; bars: FlowBar[] };
export type FlowChartInput = {
  bars: FlowBar[];
  pairs: FlowChartPair[];
  /** Only the coverage start is read here, so a caller whose population reports nothing else can still say where
   *  its capture begins instead of passing null and silently losing the "no tape" boundary. */
  coverage: Pick<FlowCoverage, "firstPrintAt"> | null;
  /** Candle open times in ms, ascending. */
  candleTimes: number[];
};
export type FlowPairLine = { label: string; points: LinePoint[] };
export type FlowChartSeries = {
  buys: HistogramPoint[];
  /** Negative values: drawn downward from the zero base. */
  sells: HistogramPoint[];
  cvd: LinePoint[];
  /** Tier A pairs only, at most MAX_PAIR_LINES, each the pair's own running cvd. */
  pairLines: FlowPairLine[];
  /** 0..100 buy share per bar; bars with no priced volume emit no point. */
  sideShare: HistogramPoint[];
  /** UTC seconds of the last candle before coverage.firstPrintAt, null when nothing precedes it. */
  uncoveredUntil: number | null;
  empty: boolean;
};

export type FlowPalette = {
  buy: string;
  sell: string;
  buyMuted: string;
  sellMuted: string;
  cvd: string;
  pair: readonly string[];
  marker: string;
  midline: string;
};

/**
 * Muted variants are the buy/sell colors at 0.25 alpha so the tape boundary stays visible.
 * buy/sell are the same direction hues the candles, drawings and trade markers use (--up / --down): the flow bars
 * and the SMART arrows sit on the same pane, so a second "buy green" here would mean two greens on one chart.
 */
export const FLOW_PALETTE: Record<FlowChartTheme, FlowPalette> = {
  dark: {
    buy: "#42c99a",
    sell: "#ef7885",
    buyMuted: "rgba(66,201,154,0.25)",
    sellMuted: "rgba(239,120,133,0.25)",
    cvd: "#28d7d0",
    pair: ["#f5cf5f", "#d08cff", "#64b5ff", "#ff9f0a"],
    marker: "#908c9a",
    midline: "#575263"
  },
  light: {
    buy: "#0a7a4b",
    sell: "#c02d43",
    buyMuted: "rgba(10,122,75,0.25)",
    sellMuted: "rgba(192,45,67,0.25)",
    cvd: "#0e8f8a",
    pair: ["#b58a00", "#8a3fd9", "#1f6fd0", "#d97706"],
    marker: "#565160",
    midline: "#807b8d"
  }
};

export const MAX_PAIR_LINES = 4;
export const UNCOVERED_MARKER_TEXT = "no tape ◀";

function toSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** Ascending, finite, strictly unique bucket times (later duplicates win). */
function orderedBars(bars: FlowBar[]): FlowBar[] {
  const sorted = bars.filter((bar) => Number.isFinite(bar.t)).sort((a, b) => a.t - b.t);
  return sorted.filter((bar, index) => index === sorted.length - 1 || bar.t !== sorted[index + 1].t);
}

function isMuted(bar: FlowBar, firstPrintAt: number | null): boolean {
  return firstPrintAt != null && bar.t < firstPrintAt;
}

function sideColor(muted: boolean, up: boolean, palette: FlowPalette): string {
  if (muted) return up ? palette.buyMuted : palette.sellMuted;
  return up ? palette.buy : palette.sell;
}

function buildHistograms(bars: FlowBar[], firstPrintAt: number | null, palette: FlowPalette) {
  const buys: HistogramPoint[] = [];
  const sells: HistogramPoint[] = [];
  for (const bar of bars) {
    const muted = isMuted(bar, firstPrintAt);
    const time = toSeconds(bar.t);
    buys.push({ time, value: bar.buyUsd, color: sideColor(muted, true, palette) });
    sells.push({ time, value: -bar.sellUsd, color: sideColor(muted, false, palette) });
  }
  return { buys, sells };
}

function buildSideShare(bars: FlowBar[], firstPrintAt: number | null, palette: FlowPalette): HistogramPoint[] {
  const points: HistogramPoint[] = [];
  for (const bar of bars) {
    const total = bar.buyUsd + bar.sellUsd;
    if (!Number.isFinite(total) || total <= 0) continue;
    const value = (bar.buyUsd / total) * 100;
    points.push({ time: toSeconds(bar.t), value, color: sideColor(isMuted(bar, firstPrintAt), value >= 50, palette) });
  }
  return points;
}

function cvdLine(bars: FlowBar[]): LinePoint[] {
  return bars.filter((bar) => Number.isFinite(bar.cvd)).map((bar) => ({ time: toSeconds(bar.t), value: bar.cvd }));
}

function pairLabel(pair: FlowChartPair): string {
  return `${pair.dex} ${pair.pairAddress.slice(0, 4)}…${pair.pairAddress.slice(-4)}`;
}

function buildPairLines(pairs: FlowChartPair[]): FlowPairLine[] {
  return pairs
    .filter((pair) => pair.tier === "A")
    .slice(0, MAX_PAIR_LINES)
    .map((pair) => ({ label: pairLabel(pair), points: cvdLine(orderedBars(pair.bars)) }));
}

/** Last candle open strictly before the first ingested print, in UTC seconds. */
export function uncoveredUntil(candleTimes: number[], firstPrintAt: number | null): number | null {
  if (firstPrintAt == null) return null;
  let last: number | null = null;
  for (const time of candleTimes) {
    if (!Number.isFinite(time) || time >= firstPrintAt) continue;
    if (last == null || time > last) last = time;
  }
  return last == null ? null : toSeconds(last);
}

export function buildFlowSeries(input: FlowChartInput, theme: FlowChartTheme): FlowChartSeries {
  const palette = FLOW_PALETTE[theme];
  const bars = orderedBars(input.bars);
  const firstPrintAt = input.coverage?.firstPrintAt ?? null;
  const { buys, sells } = buildHistograms(bars, firstPrintAt, palette);
  return {
    buys,
    sells,
    cvd: cvdLine(bars),
    pairLines: buildPairLines(input.pairs),
    sideShare: buildSideShare(bars, firstPrintAt, palette),
    uncoveredUntil: uncoveredUntil(input.candleTimes, firstPrintAt),
    empty: bars.length === 0
  };
}
