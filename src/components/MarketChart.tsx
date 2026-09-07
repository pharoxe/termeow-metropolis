import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  PriceScaleMode,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineSeriesPartialOptions,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp
} from "lightweight-charts";
import type { Candle } from "../types";
import type { TapePrint } from "../../shared/wire";
import { bollinger, ema, macd, obv, rsi, vwap } from "../lib/indicators";
import { axisUsd } from "../lib/format";
import { buildFlowSeries, type FlowChartInput, type FlowChartSeries } from "../lib/flowChart";
import { indexFomoMarkersByTime, type FomoMarker } from "../lib/fomoMarkers";
import { fomoHoverView, type FomoHoverView } from "../lib/fomoHover";
import { mergeMarkers, type ChartMarker } from "../lib/chartMarkers";
import { formatIst, granularityFor, istLocalization, istTimeScaleOptions, toSeconds, type TimeGranularity } from "../lib/chartTime";
import { applyPrintsToCandles, barLegend, dedupeAscending, inferIntervalMs, planCandleUpdate, type CandlePlan, type LiveCandleStats } from "../lib/liveCandle";
import { formatMicroPrice, priceMinMove, pricePriceFormat } from "../lib/priceFormat";
import { applyFlowSeries, createFlowSeries, SIDE_PANE_STRETCH, type FlowSeriesRefs } from "./flowChartSeries";
import { ChartLegend, type LegendState } from "./ChartLegend";
import { FomoHover } from "./FomoHover";
import { attachDrawings, type DrawingsApi } from "../chart/drawings";
import type { Theme } from "./ThemeToggle";
import "./chart.css";

export type IndicatorSet = {
  ema: boolean;
  bollinger: boolean;
  vwap: boolean;
  sr: boolean;
  volume: boolean;
  cvd: boolean;
  rsi: boolean;
  macd: boolean;
  obv: boolean;
};

export type ChartScaleMode = "linear" | "log";
export type MarketChartHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
  goToRealtime: () => void;
};

type PaneMode = "flow" | "none";
type LineRef = { series: ISeriesApi<"Line">; compute: (candles: Candle[]) => Array<number | null> };
type Built = {
  chart: IChartApi;
  price: ISeriesApi<"Candlestick">;
  markers: ISeriesMarkersPluginApi<Time>;
  lines: LineRef[];
  volume: ISeriesApi<"Histogram"> | null;
  flow: FlowSeriesRefs | null;
  sr: boolean;
  compactAxis: boolean;
};
/** Mutable bookkeeping per build: what the series currently hold, so data effects can diff instead of rebuild. */
type Held = { candles: Candle[]; srLines: IPriceLine[]; minMove: number | null; flow: FlowChartSeries | null; markers: ChartMarker[] | null };

const EMPTY_MARKERS: FomoMarker[] = [];
const EMPTY_EVENTS: ChartMarker[] = [];
const EMPTY_PRINTS: TapePrint[] = [];
const INDICATOR_KEYS: Array<keyof IndicatorSet> = ["ema", "bollinger", "vwap", "sr", "volume", "cvd", "rsi", "macd", "obv"];
const DEFAULT_VISIBLE_BARS = 88;
const MIN_FLOW_BARS = 2;
const compactFormat = { type: "custom" as const, minMove: 1, formatter: (value: number) => axisUsd(value) };
const PALETTE = {
  light: { background: "rgba(247,250,245,0.86)", text: "#516058", grid: "rgba(190,207,194,0.62)", crosshair: "#7b8d82", border: "#cad7cc" },
  dark: { background: "rgba(8,11,9,0.82)", text: "#8c9a91", grid: "rgba(35,51,40,0.62)", crosshair: "#526357", border: "#253129" }
} as const;

const closes = (candles: Candle[]) => candles.map((candle) => candle.close);
const utc = (candle: Candle) => toSeconds(candle.time) as UTCTimestamp;
const candleBar = (candle: Candle) => ({ time: utc(candle), open: candle.open, high: candle.high, low: candle.low, close: candle.close });
const volumeBar = (candle: Candle) => ({ time: utc(candle), value: candle.volume, color: candle.close >= candle.open ? "#315b30aa" : "#64333aaa" });
const scaleModeOf = (mode: ChartScaleMode) => (mode === "log" ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal);

function linePoints(candles: Candle[], values: Array<number | null>, from = 0) {
  const points: Array<{ time: UTCTimestamp; value: number }> = [];
  for (let index = from; index < candles.length; index += 1) {
    const value = values[index];
    if (value != null && Number.isFinite(value)) points.push({ time: utc(candles[index]), value });
  }
  return points;
}

/** Only the library's marker fields cross over (FomoMarker carries its wallet breakdown too); `time` needs the branded type. */
function toSeriesMarkers(markers: ChartMarker[]): SeriesMarker<Time>[] {
  return markers.map(({ time, position, shape, color, text, size }) => ({ time: time as UTCTimestamp, position, shape, color, text, size }));
}

type BuildConfig = { theme: Theme; compactAxis: boolean; indicators: IndicatorSet; paneMode: PaneMode; granularity: TimeGranularity; scaleMode: ChartScaleMode; sample: number | null };

function buildChart(node: HTMLDivElement, cfg: BuildConfig): Built {
  const palette = PALETTE[cfg.theme];
  const chart = createChart(node, {
    width: Math.max(node.clientWidth || 0, 320),
    height: Math.max(node.clientHeight || 0, 280),
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: palette.background }, textColor: palette.text, fontFamily: "Home Video, monospace" },
    grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
    crosshair: { vertLine: { color: palette.crosshair }, horzLine: { color: palette.crosshair } },
    rightPriceScale: { borderColor: palette.border, mode: scaleModeOf(cfg.scaleMode) },
    timeScale: { borderColor: palette.border, ...istTimeScaleOptions(cfg.granularity) },
    localization: istLocalization(cfg.granularity),
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
  });
  const price = chart.addSeries(CandlestickSeries, {
    upColor: "#39ff88", downColor: "#ff5268", borderVisible: false,
    wickUpColor: "#18b85d", wickDownColor: "#c44854", priceLineVisible: false,
    priceFormat: cfg.compactAxis ? compactFormat : pricePriceFormat(cfg.sample)
  });
  const markers = createSeriesMarkers(price, []);
  const lines: LineRef[] = [];
  const addLine = (options: LineSeriesPartialOptions, compute: LineRef["compute"], pane?: number) => {
    const series = chart.addSeries(LineSeries, { priceLineVisible: false, lastValueVisible: false, ...options }, pane);
    lines.push({ series, compute });
    return series;
  };
  if (cfg.indicators.ema) {
    addLine({ color: "#f5cf5f", lineWidth: 1 }, (candles) => ema(closes(candles), 20));
    addLine({ color: "#d08cff", lineWidth: 2 }, (candles) => ema(closes(candles), 50));
  }
  if (cfg.indicators.vwap) addLine({ color: "#64b5ff", lineWidth: 2, lineStyle: 2 }, vwap);
  if (cfg.indicators.bollinger) {
    for (const key of ["upper", "lower"] as const) addLine({ color: "#43536a", lineWidth: 1, lineStyle: 2 }, (candles) => bollinger(closes(candles)).map((band) => band[key]));
  }
  let volume: Built["volume"] = null;
  if (cfg.indicators.volume) {
    volume = chart.addSeries(HistogramSeries, { priceFormat: compactFormat, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  }
  let pane = 1;
  let sidePane: number | null = null;
  let flow: FlowSeriesRefs | null = null;
  if (cfg.paneMode === "flow") {
    const built = createFlowSeries(chart, pane, cfg.theme);
    flow = built.refs;
    sidePane = built.refs.sidePane;
    pane = built.nextPane;
  }
  if (cfg.indicators.rsi) {
    addLine({ color: "#28d7d0", lineWidth: 1, lastValueVisible: true, title: "RSI14" }, (candles) => rsi(closes(candles)), pane++)
      .priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0.15 } });
  }
  if (cfg.indicators.macd) {
    addLine({ color: "#3aa0ff", lineWidth: 1, title: "MACD" }, (candles) => macd(closes(candles)).line, pane);
    addLine({ color: "#ff9f0a", lineWidth: 1, title: "SIGNAL" }, (candles) => macd(closes(candles)).signal, pane++);
  }
  if (cfg.indicators.obv) addLine({ color: "#c084fc", lineWidth: 1, title: "OBV" }, obv, pane++);
  const panes = chart.panes();
  if (panes.length > 1) {
    panes[0].setStretchFactor(3.4);
    for (let index = 1; index < panes.length; index += 1) panes[index].setStretchFactor(1);
    if (sidePane !== null && panes[sidePane]) panes[sidePane].setStretchFactor(SIDE_PANE_STRETCH);
  }
  return { chart, price, markers, lines, volume, flow, sr: cfg.indicators.sr, compactAxis: cfg.compactAxis };
}

function applySupportResistance(built: Built, held: Held, candles: Candle[]): IPriceLine[] {
  held.srLines.forEach((line) => built.price.removePriceLine(line));
  if (!built.sr || !candles.length) return [];
  const high = Math.max(...candles.map((candle) => candle.high));
  const low = Math.min(...candles.map((candle) => candle.low));
  const windowOpen = candles[0].close;
  const specs = [[high, "RES", "#ff4d5e"], [low, "SUP", "#39ff88"], [windowOpen, "OPEN", "#00b86b"]] as const;
  return specs.filter(([value]) => Number.isFinite(value)).map(([value, title, color]) =>
    built.price.createPriceLine({ price: value, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }));
}

/** setData on reset, series.update on the tail; indicators are recomputed in full (cheap) and only their tail points pushed. */
function applyCandles(built: Built, held: Held, next: Candle[], plan: CandlePlan): void {
  if (plan.kind === "none") {
    held.candles = next;
    return;
  }
  if (plan.kind === "reset") {
    built.price.setData(next.map(candleBar));
    built.volume?.setData(next.map(volumeBar));
    for (const line of built.lines) line.series.setData(linePoints(next, line.compute(next)));
    held.srLines = applySupportResistance(built, held, next);
    const sample = next.length ? next[next.length - 1].close : null;
    const minMove = priceMinMove(sample);
    if (!built.compactAxis && minMove !== held.minMove) built.price.applyOptions({ priceFormat: pricePriceFormat(sample) });
    held.minMove = minMove;
  } else {
    const from = next.length - plan.bars.length;
    for (const bar of plan.bars) {
      built.price.update(candleBar(bar));
      built.volume?.update(volumeBar(bar));
    }
    for (const line of built.lines) {
      for (const point of linePoints(next, line.compute(next), from)) line.series.update(point);
    }
  }
  held.candles = next;
}

type MarketChartProps = {
  candles: Candle[];
  indicators: IndicatorSet;
  /** Identity of the candle stream (e.g. `${chain}:${address}:${interval}`); a change forces setData + the default viewport. */
  seriesKey?: string;
  /** Bar size in ms (parseIntervalMs(interval)); inferred from candle spacing when absent. Drives live bucketing and IST tick granularity. */
  intervalMs?: number | null;
  /** Tier A prints the candle feed has not seen yet (time > feed observedAt); ticked into the forming bar without a rebuild. */
  livePrints?: TapePrint[];
  /** Supply the candles were scaled by in mcap mode, so print prices land in the same unit; null/undefined in price mode. */
  mcapScale?: number | null;
  /** Reported after each live tick so the page can label how many prints moved the bar. */
  onLiveStats?: (stats: LiveCandleStats) => void;
  scaleMode?: ChartScaleMode;
  /** Launch / graduation / large-print markers from buildEventMarkers; merged with fomoMarkers into the one markers plugin. */
  eventMarkers?: ChartMarker[];
  /** F4 token flow (Δ/BAR, CVD, Tier A pair lines, BUY % ribbon); no side pane is drawn with fewer than 2 bars. */
  flow?: FlowChartInput;
  /** R3 FOMO-wallet fills placed on the candle series (built by buildFomoMarkers); applied without rebuilding the chart. */
  fomoMarkers?: FomoMarker[];
  compactAxis?: boolean;
  theme?: Theme;
  /** Legend prefix, e.g. "ANSEM/USD". */
  legendLabel?: string | null;
  /** Drawings persistence namespace (instrument key); drawings attach to the candle series while it is set. */
  drawingsKey?: string | null;
  /** Receives the drawings API when attached and null when detached (chart rebuilt or instrument changed). */
  onDrawings?: (api: DrawingsApi | null) => void;
};

export const MarketChart = forwardRef<MarketChartHandle, MarketChartProps>(function MarketChart(props, ref) {
  const {
    candles, indicators, seriesKey = "", intervalMs = null, livePrints = EMPTY_PRINTS, mcapScale = null, onLiveStats,
    scaleMode = "linear", eventMarkers = EMPTY_EVENTS, flow, fomoMarkers = EMPTY_MARKERS,
    compactAxis = false, theme = "dark", legendLabel = null, drawingsKey = null, onDrawings
  } = props;
  const host = useRef<HTMLDivElement>(null);
  const builtRef = useRef<Built | null>(null);
  const heldRef = useRef<Held>({ candles: [], srLines: [], minMove: null, flow: null, markers: null });
  const keyRef = useRef(seriesKey);
  const barCountRef = useRef(0);
  const visibleRangeRef = useRef<{ from: number; to: number } | null>(null);
  const hoverIndexRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const [legend, setLegend] = useState<LegendState | null>(null);
  const [fomoHover, setFomoHover] = useState<FomoHoverView | null>(null);

  const resolvedIntervalMs = intervalMs != null && intervalMs > 0 ? intervalMs : inferIntervalMs(candles);
  const granularity = granularityFor(resolvedIntervalMs);
  const live = useMemo(() => applyPrintsToCandles(candles, livePrints, resolvedIntervalMs, Date.now(), mcapScale), [candles, livePrints, resolvedIntervalMs, mcapScale]);
  const displayCandles = useMemo(() => dedupeAscending(live.candles), [live.candles]);
  const flowSeries = useMemo(() => (indicators.cvd && flow ? buildFlowSeries(flow, theme) : null), [indicators.cvd, flow, theme]);
  const flowUsable = Boolean(flowSeries && !flowSeries.empty && flowSeries.buys.length >= MIN_FLOW_BARS);
  const paneMode: PaneMode = flowUsable ? "flow" : "none";
  const merged = useMemo(() => mergeMarkers(fomoMarkers, eventMarkers), [fomoMarkers, eventMarkers]);
  const fomoByTime = useMemo(() => indexFomoMarkersByTime(fomoMarkers), [fomoMarkers]);
  const fomoByTimeRef = useRef(fomoByTime);
  fomoByTimeRef.current = fomoByTime;
  const hasCandles = displayCandles.length > 0;
  const mountKey = [theme, compactAxis, INDICATOR_KEYS.filter((key) => indicators[key]).join("+"), paneMode, hasCandles].join("|");

  // Latest props for the mount effect, which is keyed on structure only and must not close over stale data.
  const latest = useRef({ displayCandles, flowSeries, merged, granularity, scaleMode });
  latest.current = { displayCandles, flowSeries, merged, granularity, scaleMode };

  const defaultRange = () => ({ from: Math.max(0, barCountRef.current - DEFAULT_VISIBLE_BARS), to: barCountRef.current + 4 });
  const scaleRange = (factor: number) => {
    const chart = builtRef.current?.chart;
    const current = chart?.timeScale().getVisibleLogicalRange() || visibleRangeRef.current || defaultRange();
    const center = (Number(current.from) + Number(current.to)) / 2;
    const half = Math.max(12, (Number(current.to) - Number(current.from)) * factor / 2);
    const next = { from: center - half, to: center + half };
    visibleRangeRef.current = next;
    chart?.timeScale().setVisibleLogicalRange(next);
  };
  useImperativeHandle(ref, () => ({
    zoomIn: () => scaleRange(0.72),
    zoomOut: () => scaleRange(1.38),
    resetView: () => {
      const next = defaultRange();
      visibleRangeRef.current = next;
      builtRef.current?.chart.timeScale().setVisibleLogicalRange(next);
    },
    goToRealtime: () => builtRef.current?.chart.timeScale().scrollToRealTime()
  }), []);

  const refreshLegend = () => {
    const held = heldRef.current.candles;
    const hovered = hoverIndexRef.current;
    const bar = barLegend(held, hovered ?? held.length - 1);
    // Hover-only: the wallet strip names who filled the bar under the crosshair, never the last bar by default.
    const buckets = hovered != null && bar ? fomoByTimeRef.current.get(Math.floor(bar.time / 1000)) ?? [] : [];
    setFomoHover((prev) => {
      const next = fomoHoverView(buckets);
      return prev && next && prev.title === next.title && prev.rows.length === next.rows.length && prev.more === next.more ? prev : next;
    });
    setLegend((prev) => {
      if (!bar) return null;
      if (prev && prev.bar.index === bar.index && prev.hovered === (hovered != null) && prev.total === held.length && prev.bar.close === bar.close && prev.bar.volume === bar.volume && prev.bar.time === bar.time) return prev;
      return { bar, hovered: hovered != null, total: held.length };
    });
  };

  const applyFlow = (built: Built, held: Held, series: FlowChartSeries | null) => {
    if (!built.flow || !series || held.flow === series) return;
    applyFlowSeries(built.flow, series);
    held.flow = series;
  };
  const applyMarkers = (built: Built, held: Held, markers: ChartMarker[]) => {
    if (held.markers === markers) return;
    built.markers.setMarkers(toSeriesMarkers(markers));
    held.markers = markers;
  };

  // (a) Structure: created once per mountKey (theme, axis unit, indicator set, pane mode, candles present); data never rebuilds it.
  useEffect(() => {
    if (!host.current || !hasCandles) return;
    const snapshot = latest.current;
    const sample = snapshot.displayCandles.length ? snapshot.displayCandles[snapshot.displayCandles.length - 1].close : null;
    const built = buildChart(host.current, { theme, compactAxis, indicators, paneMode, granularity: snapshot.granularity, scaleMode: snapshot.scaleMode, sample });
    const held: Held = { candles: [], srLines: [], minMove: null, flow: null, markers: null };
    builtRef.current = built;
    heldRef.current = held;
    applyCandles(built, held, snapshot.displayCandles, { kind: "reset", bars: snapshot.displayCandles });
    applyFlow(built, held, snapshot.flowSeries);
    applyMarkers(built, held, snapshot.merged);
    barCountRef.current = snapshot.displayCandles.length;
    const chart = built.chart;
    chart.timeScale().setVisibleLogicalRange(visibleRangeRef.current || defaultRange());
    const rememberRange = (next: { from: number; to: number } | null) => {
      if (next) visibleRangeRef.current = { from: Number(next.from), to: Number(next.to) };
    };
    // One legend update per frame; a hidden tab gets no frames, so apply synchronously there to avoid a stale hover.
    const onCrosshair = (param: MouseEventParams<Time>) => {
      const index = param.time == null || param.logical == null ? null : Math.round(Number(param.logical));
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      const apply = () => {
        frameRef.current = null;
        hoverIndexRef.current = index;
        refreshLegend();
      };
      if (document.hidden) apply();
      else frameRef.current = requestAnimationFrame(apply);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(rememberRange);
    chart.subscribeCrosshairMove(onCrosshair);
    refreshLegend();
    return () => {
      const current = chart.timeScale().getVisibleLogicalRange();
      if (current) visibleRangeRef.current = { from: Number(current.from), to: Number(current.to) };
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(rememberRange);
      chart.unsubscribeCrosshairMove(onCrosshair);
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      if (builtRef.current === built) builtRef.current = null;
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountKey]);

  // (b) Candle data: setData when the stream identity changes or history was revised, series.update when only the tail moved.
  useEffect(() => {
    const built = builtRef.current;
    if (!built) return;
    const held = heldRef.current;
    const keyChanged = keyRef.current !== seriesKey;
    keyRef.current = seriesKey;
    if (!keyChanged && held.candles === displayCandles) return;
    const plan: CandlePlan = keyChanged ? { kind: "reset", bars: displayCandles } : planCandleUpdate(held.candles, displayCandles);
    applyCandles(built, held, displayCandles, plan);
    barCountRef.current = displayCandles.length;
    if (keyChanged) {
      const next = defaultRange();
      visibleRangeRef.current = next;
      built.chart.timeScale().setVisibleLogicalRange(next);
    } else if (plan.kind === "reset") {
      built.chart.timeScale().setVisibleLogicalRange(visibleRangeRef.current || defaultRange());
    }
    refreshLegend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayCandles, seriesKey]);

  useEffect(() => {
    const built = builtRef.current;
    if (built) applyFlow(built, heldRef.current, flowSeries);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowSeries]);

  // Drawings attach to the live candle series; re-attached on chart rebuild or instrument change, destroyed before the chart goes.
  useEffect(() => {
    const built = builtRef.current;
    if (!built || !drawingsKey) {
      onDrawings?.(null);
      return;
    }
    const api = attachDrawings({
      chart: built.chart,
      series: built.price,
      instrumentKey: drawingsKey,
      theme,
      formatters: {
        price: (value) => (built.compactAxis ? axisUsd(value) : formatMicroPrice(value)),
        time: (ms) => formatIst(ms, latest.current.granularity)
      }
    });
    onDrawings?.(api);
    return () => {
      onDrawings?.(null);
      api.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountKey, drawingsKey]);

  // Markers ride the existing candle series: a new poll only calls setMarkers, it never rebuilds the chart.
  useEffect(() => {
    const built = builtRef.current;
    if (built) applyMarkers(built, heldRef.current, merged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merged]);

  // A new FOMO poll can change the buckets under a resting crosshair; re-derive the strip without waiting for a move.
  useEffect(() => {
    refreshLegend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fomoByTime]);

  useEffect(() => {
    builtRef.current?.chart.priceScale("right").applyOptions({ mode: scaleModeOf(scaleMode) });
  }, [scaleMode]);

  useEffect(() => {
    builtRef.current?.chart.applyOptions({ localization: istLocalization(granularity), timeScale: istTimeScaleOptions(granularity) });
  }, [granularity]);

  useEffect(() => {
    onLiveStats?.(live.stats);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.stats]);

  return (
    <div className="chart-host">
      <div className="chart-canvas" ref={host} />
      <ChartLegend state={legend} compact={compactAxis} granularity={granularity} label={legendLabel} />
      <FomoHover view={fomoHover} />
    </div>
  );
});
