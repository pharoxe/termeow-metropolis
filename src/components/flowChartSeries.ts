import {
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp
} from "lightweight-charts";
import { axisUsd } from "../lib/format";
import { FLOW_PALETTE, MAX_PAIR_LINES, UNCOVERED_MARKER_TEXT, type FlowChartSeries, type FlowChartTheme } from "../lib/flowChart";

/** Chart-side wiring for the F4 flow panes: creates the series once, then only setData on each poll. */

export type FlowSeriesRefs = {
  buys: ISeriesApi<"Histogram">;
  sells: ISeriesApi<"Histogram">;
  cvd: ISeriesApi<"Line">;
  pairs: ISeriesApi<"Line">[];
  side: ISeriesApi<"Histogram">;
  markers: ISeriesMarkersPluginApi<Time>;
  sidePane: number;
  theme: FlowChartTheme;
};

const usdFormat = { type: "custom" as const, minMove: 1, formatter: (value: number) => axisUsd(value) };
const percentFormat = { type: "custom" as const, minMove: 1, formatter: (value: number) => `${Math.round(value)}%` };
const SIDE_RANGE = () => ({ priceRange: { minValue: 0, maxValue: 100 } });
const DELTA_MARGINS = { scaleMargins: { top: 0.12, bottom: 0.08 } };

export const SIDE_PANE_STRETCH = 0.5;

function addDeltaHistograms(chart: IChartApi, pane: number, theme: FlowChartTheme) {
  const buys = chart.addSeries(HistogramSeries, {
    priceFormat: usdFormat, title: "Δ/BAR", lastValueVisible: true, priceLineVisible: false, color: FLOW_PALETTE[theme].buy, base: 0
  }, pane);
  const sells = chart.addSeries(HistogramSeries, {
    priceFormat: usdFormat, lastValueVisible: true, priceLineVisible: false, color: FLOW_PALETTE[theme].sell, base: 0
  }, pane);
  buys.priceScale().applyOptions(DELTA_MARGINS);
  return { buys, sells };
}

function addCvdLines(chart: IChartApi, pane: number, theme: FlowChartTheme) {
  const palette = FLOW_PALETTE[theme];
  const cvd = chart.addSeries(LineSeries, {
    color: palette.cvd, lineWidth: 2, priceFormat: usdFormat, lastValueVisible: true, priceLineVisible: false, title: "CVD", priceScaleId: "cvd-line"
  }, pane);
  cvd.priceScale().applyOptions(DELTA_MARGINS);
  const pairs = Array.from({ length: MAX_PAIR_LINES }, (_, index) => chart.addSeries(LineSeries, {
    color: palette.pair[index % palette.pair.length], lineWidth: 1, lineStyle: LineStyle.Dotted, priceFormat: usdFormat,
    lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, priceScaleId: "cvd-line"
  }, pane));
  return { cvd, pairs };
}

function addSideRibbon(chart: IChartApi, pane: number, theme: FlowChartTheme) {
  const side = chart.addSeries(HistogramSeries, {
    priceFormat: percentFormat, title: "BUY %", lastValueVisible: true, priceLineVisible: false, base: 0, autoscaleInfoProvider: SIDE_RANGE
  }, pane);
  side.createPriceLine({ price: 50, color: FLOW_PALETTE[theme].midline, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
  return side;
}

/** Builds the Δ/BAR + CVD pane at `pane` and the BUY % ribbon at `pane + 1`; returns refs and the next free pane index. */
export function createFlowSeries(chart: IChartApi, pane: number, theme: FlowChartTheme): { refs: FlowSeriesRefs; nextPane: number } {
  const { buys, sells } = addDeltaHistograms(chart, pane, theme);
  const { cvd, pairs } = addCvdLines(chart, pane, theme);
  const sidePane = pane + 1;
  const side = addSideRibbon(chart, sidePane, theme);
  const markers = createSeriesMarkers(cvd, []);
  return { refs: { buys, sells, cvd, pairs, side, markers, sidePane, theme }, nextPane: sidePane + 1 };
}

function asTime(time: number): UTCTimestamp {
  return time as UTCTimestamp;
}

/** Pushes a freshly built FlowChartSeries into existing series without touching the chart itself. */
export function applyFlowSeries(refs: FlowSeriesRefs, series: FlowChartSeries): void {
  refs.buys.setData(series.buys.map((point) => ({ time: asTime(point.time), value: point.value, color: point.color })));
  refs.sells.setData(series.sells.map((point) => ({ time: asTime(point.time), value: point.value, color: point.color })));
  refs.cvd.setData(series.cvd.map((point) => ({ time: asTime(point.time), value: point.value })));
  refs.side.setData(series.sideShare.map((point) => ({ time: asTime(point.time), value: point.value, color: point.color })));
  refs.pairs.forEach((line, index) => {
    const pair = series.pairLines[index];
    line.applyOptions({ title: pair?.label ?? "", visible: Boolean(pair) });
    line.setData(pair ? pair.points.map((point) => ({ time: asTime(point.time), value: point.value })) : []);
  });
  refs.markers.setMarkers(series.uncoveredUntil == null ? [] : [{
    time: asTime(series.uncoveredUntil), position: "aboveBar", shape: "circle", size: 0.6,
    color: FLOW_PALETTE[refs.theme].marker, text: UNCOVERED_MARKER_TEXT
  }]);
}
