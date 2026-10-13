import {chartPalette} from "../lib/themeTokens";
import { rebaseViewport, zoomViewport } from "../lib/chartViewport";
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
import { indexSmartMarkersByTime, type SmartMarker } from "../lib/smartMarkers";
import { smartHoverView, type SmartHoverView } from "../lib/smartHover";
import { mergeMarkers, type ChartMarker } from "../lib/chartMarkers";
import { formatIst, granularityFor, istLocalization, istTimeScaleOptions, toSeconds, type TimeGranularity } from "../lib/chartTime";
import { applyPrintsToCandles, barLegend, dedupeAscending, inferIntervalMs, planCandleUpdate, type CandlePlan, type LiveCandleStats } from "../lib/liveCandle";
import { formatMicroPrice, priceMinMove, pricePriceFormat } from "../lib/priceFormat";
import { applyFlowSeries, createFlowSeries, SIDE_PANE_STRETCH, type FlowSeriesRefs } from "./flowChartSeries";
import { ChartLegend, type LegendState } from "./ChartLegend";
import { SmartHover } from "./SmartHover";
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
  setCrosshair: (time: number|null) => void;
  seekTime: (time: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
  goToRealtime: () => void;
  fitHistory: () => void;
  freeMove: () => void;
  tallerCandles: () => void;
  shorterCandles: () => void;
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
  /** The palette this chart was built with, so price lines drawn later use the same direction hues as the candles. */
  theme: Theme;
};
/** Mutable bookkeeping per build: what the series currently hold, so data effects can diff instead of rebuild. */
type Held = { candles: Candle[]; srLines: IPriceLine[]; minMove: number | null; flow: FlowChartSeries | null; markers: ChartMarker[] | null };

const EMPTY_MARKERS: SmartMarker[] = [];
const EMPTY_EVENTS: ChartMarker[] = [];
const EMPTY_PRINTS: TapePrint[] = [];
const INDICATOR_KEYS: Array<keyof IndicatorSet> = ["ema", "bollinger", "vwap", "sr", "volume", "cvd", "rsi", "macd", "obv"];
const DEFAULT_VISIBLE_BARS = 88;
/** A flow pane needs at least two bars to draw anything; below that the pane would be axes and nothing else. */
const MIN_FLOW_BARS = 2;
const compactFormat = { type: "custom" as const, minMove: 1, formatter: (value: number) => axisUsd(value) };
/** Canvas colours cannot read CSS custom properties, so the chart's copy of the roles lives here: `up`/`down` are
 *  the direction hues (--up / --down), `select` is the one selection hue (--select) shared with markers and drawings. */
const PALETTE = {light:chartPalette("light"),dark:chartPalette("dark")};

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

/** Only the library's marker fields cross over (SmartMarker carries its wallet breakdown too); `time` needs the branded type. */
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
    layout: { background: { type: ColorType.Solid, color: palette.background }, textColor: palette.text, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11, panes: { enableResize: true, separatorColor: palette.border, separatorHoverColor: palette.select } },
    grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
    crosshair: { vertLine: { color: palette.crosshair }, horzLine: { color: palette.crosshair } },
    rightPriceScale: { borderColor: palette.border, mode: scaleModeOf(cfg.scaleMode) },
    timeScale: { rightOffset: 5, minBarSpacing: 0.2, rightBarStaysOnScroll: true, shiftVisibleRangeOnNewBar: true, borderColor: palette.border, ...istTimeScaleOptions(cfg.granularity) },
    localization: istLocalization(cfg.granularity),
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
    handleScale: { axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true }, mouseWheel: false, pinch: true },
    kineticScroll: { mouse: false, touch: true }
  });
  const price = chart.addSeries(CandlestickSeries, {
    upColor: palette.up, downColor: palette.down, borderVisible: false,
    wickUpColor: palette.up, wickDownColor: palette.down, priceLineVisible: false,
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
  return { chart, price, markers, lines, volume, flow, sr: cfg.indicators.sr, compactAxis: cfg.compactAxis, theme: cfg.theme };
}

function applySupportResistance(built: Built, held: Held, candles: Candle[]): IPriceLine[] {
  held.srLines.forEach((line) => built.price.removePriceLine(line));
  if (!built.sr || !candles.length) return [];
  const high = Math.max(...candles.map((candle) => candle.high));
  const low = Math.min(...candles.map((candle) => candle.low));
  const windowOpen = candles[0].close;
  const specs = [[high, "RES", PALETTE[built.theme].down], [low, "SUP", PALETTE[built.theme].up], [windowOpen, "OPEN", PALETTE[built.theme].crosshair]] as const;
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
  onSelectTime?: (time: number) => void;
  onVisibleRange?: (range: {from:number;to:number}) => void;
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
  /** Launch / graduation / large-print markers from buildEventMarkers; merged with smartMarkers into the one markers plugin. */
  eventMarkers?: ChartMarker[];
  /** F4 token flow (Δ/BAR, CVD, Tier A pair lines, BUY % ribbon); no side pane is drawn with fewer than 2 bars. */
  flow?: FlowChartInput;
  /** R3 SMART-wallet fills placed on the candle series (built by buildSmartMarkers); applied without rebuilding the chart. */
  smartMarkers?: SmartMarker[];
  compactAxis?: boolean;
  theme?: Theme;
  /** Legend prefix, e.g. "MON/USD". */
  legendLabel?: string | null;
  /** Drawings persistence namespace (instrument key); drawings attach to the candle series while it is set. */
  drawingsKey?: string | null;
  onCrosshairTime?: (time:number|null)=>void;
  /** Receives the drawings API when attached and null when detached (chart rebuilt or instrument changed). */
  onDrawings?: (api: DrawingsApi | null) => void;
};

export const MarketChart = forwardRef<MarketChartHandle, MarketChartProps>(function MarketChart(props, ref) {
  const crosshairCallback=useRef(props.onCrosshairTime);crosshairCallback.current=props.onCrosshairTime;
  const syncingCrosshair=useRef(false);
  const {
    candles, indicators, seriesKey = "", intervalMs = null, livePrints = EMPTY_PRINTS, mcapScale = null, onLiveStats,
    scaleMode = "linear", eventMarkers = EMPTY_EVENTS, flow, smartMarkers = EMPTY_MARKERS,
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
  const savedPrice = useRef<{ range: { from: number; to: number } | null; auto: boolean; unit: boolean; key: string } | null>(null);
  const drawingActive = useRef(false);
  const disposeDrawings = useRef<(()=>void)|null>(null);
  const paneHeights = useRef<number[]>([]);
  const [legend, setLegend] = useState<LegendState | null>(null);
  const [smartHover, setSmartHover] = useState<SmartHoverView | null>(null);
  const [smartBubbles, setSmartBubbles] = useState<Array<{ marker: SmartMarker; x: number; y: number }>>([]);

  const interactionRef = useRef({onSelectTime:props.onSelectTime,onVisibleRange:props.onVisibleRange});
  interactionRef.current = {onSelectTime:props.onSelectTime,onVisibleRange:props.onVisibleRange};
  const resolvedIntervalMs = intervalMs != null && intervalMs > 0 ? intervalMs : inferIntervalMs(candles);
  const intervalRef = useRef(resolvedIntervalMs);
  intervalRef.current = resolvedIntervalMs;
  const granularity = granularityFor(resolvedIntervalMs);
  const live = useMemo(() => applyPrintsToCandles(candles, livePrints, resolvedIntervalMs, Date.now(), mcapScale), [candles, livePrints, resolvedIntervalMs, mcapScale]);
  const displayCandles = useMemo(() => dedupeAscending(live.candles), [live.candles]);
  const flowSeries = useMemo(() => (indicators.cvd && flow ? buildFlowSeries(flow, theme) : null), [indicators.cvd, flow, theme]);
  // No pane rather than an empty one: with the toggle on and no captured flow yet, an axes-only pane would read as
  // "no flow in this window" when the truth is "not loaded / not captured", which the coverage note states instead.
  const flowUsable = Boolean(flowSeries && !flowSeries.empty && flowSeries.buys.length >= MIN_FLOW_BARS);
  const paneMode: PaneMode = flowUsable ? "flow" : "none";
  // Identity-rich SMART activity is an HTML overlay; the series plugin keeps only launch/large-print events.
  const merged = useMemo(() => mergeMarkers(eventMarkers), [eventMarkers]);
  const smartByTime = useMemo(() => indexSmartMarkersByTime(smartMarkers), [smartMarkers]);
  const smartByTimeRef = useRef(smartByTime);
  smartByTimeRef.current = smartByTime;
  const hasCandles = displayCandles.length > 0;
  const mountKey = [theme, compactAxis, INDICATOR_KEYS.filter((key) => indicators[key]).join("+"), paneMode, hasCandles].join("|");

  const refreshSmartBubbles = () => {
    const built = builtRef.current;
    if (!built) { setSmartBubbles([]); return; }
    const lanes = { buy: [] as number[], sell: [] as number[] };
    const next = smartMarkers.map((marker) => {
      const x = built.chart.timeScale().timeToCoordinate(marker.time as UTCTimestamp);
      const candle = heldRef.current.candles.find((bar) => Math.floor(bar.time / 1000) === marker.time);
      if (x == null || !candle) return null;
      let lane = 0;
      while (lanes[marker.side][lane] != null && Math.abs(x - lanes[marker.side][lane]) < 54) lane += 1;
      lane = Math.min(lane, 5); lanes[marker.side][lane] = x;
      const anchor = built.price.priceToCoordinate(marker.side === "buy" ? candle.low : candle.high);
      if (anchor == null) return null;
      return { marker, x, y: anchor + (marker.side === "buy" ? 20 + lane * 29 : -20 - lane * 29) };
    }).filter((item): item is NonNullable<typeof item> => Boolean(item));
    setSmartBubbles(next);
  };

  // Latest props for the mount effect, which is keyed on structure only and must not close over stale data.
  const latest = useRef({ displayCandles, flowSeries, merged, granularity, scaleMode });
  latest.current = { displayCandles, flowSeries, merged, granularity, scaleMode };

  const defaultRange = () => ({ from: Math.max(0, barCountRef.current - DEFAULT_VISIBLE_BARS), to: barCountRef.current + 4 });
  const scaleRange = (factor: number) => {
    const chart = builtRef.current?.chart;
    const current = chart?.timeScale().getVisibleLogicalRange() || visibleRangeRef.current || defaultRange();
    const next = zoomViewport(current, factor);
    visibleRangeRef.current = next;
    chart?.timeScale().setVisibleLogicalRange(next);
  };
  const scalePrice = (factor: number) => {
    const priceScale = builtRef.current?.price.priceScale();
    const range = priceScale?.getVisibleRange();
    if (!range || !priceScale) return;
    const log = priceScale.options().mode === PriceScaleMode.Logarithmic && range.from > 0;
    const low = log ? Math.log(range.from) : range.from;
    const high = log ? Math.log(range.to) : range.to;
    const middle = (low + high) / 2;
    const half = (high - low) * factor / 2;
    const next = { from: log ? Math.exp(middle - half) : middle - half, to: log ? Math.exp(middle + half) : middle + half };
    if (!Number.isFinite(next.from) || !Number.isFinite(next.to) || next.from >= next.to) return;
    priceScale.applyOptions({ autoScale: false });
    priceScale.setVisibleRange(next);
  };
  useImperativeHandle(ref, () => ({
    setCrosshair:(time)=>{
      const built=builtRef.current;if(!built)return;
      syncingCrosshair.current=true;
      if(time==null)built.chart.clearCrosshairPosition();
      else {const bars=heldRef.current.candles;const bar=bars.find((bar,i)=>bar.time<=time&&(i===bars.length-1||bars[i+1].time>time));if(bar)built.chart.setCrosshairPosition(bar.close,Math.floor(bar.time/1000) as UTCTimestamp,built.price);else built.chart.clearCrosshairPosition();}
      syncingCrosshair.current=false;
    },
    seekTime: (time) => {
      const bars = heldRef.current.candles;
      const index = bars.findIndex((bar, i) => bar.time <= time && (i === bars.length - 1 || bars[i + 1].time > time));
      if (index < 0) return;
      const current = builtRef.current?.chart.timeScale().getVisibleLogicalRange();
      const width = current ? current.to - current.from : DEFAULT_VISIBLE_BARS;
      builtRef.current?.chart.timeScale().setVisibleLogicalRange({from:index-width/2,to:index+width/2});
      hoverIndexRef.current = index; refreshLegend();
    },
    zoomIn: () => scaleRange(0.72),
    zoomOut: () => scaleRange(1.38),
    resetView: () => {
      builtRef.current?.chart.priceScale("right").applyOptions({ autoScale: true });
      const next = defaultRange();
      visibleRangeRef.current = next;
      builtRef.current?.chart.timeScale().setVisibleLogicalRange(next);
    },
    goToRealtime: () => {
      builtRef.current?.chart.priceScale("right").applyOptions({ autoScale: true });
      builtRef.current?.chart.timeScale().scrollToRealTime();
    },
    fitHistory: () => {
      builtRef.current?.chart.priceScale("right").applyOptions({ autoScale: true });
      builtRef.current?.chart.timeScale().fitContent();
    },
    tallerCandles: () => scalePrice(0.75),
    shorterCandles: () => scalePrice(1.33),
    freeMove: () => builtRef.current?.chart.priceScale("right").applyOptions({ autoScale: false })
  }), []);

  const refreshLegend = () => {
    const held = heldRef.current.candles;
    const hovered = hoverIndexRef.current;
    const bar = barLegend(held, hovered ?? held.length - 1);
    // Hover-only: the wallet strip names who filled the bar under the crosshair, never the last bar by default.
    const buckets = hovered != null && bar ? smartByTimeRef.current.get(Math.floor(bar.time / 1000)) ?? [] : [];
    setSmartHover((prev) => {
      const next = smartHoverView(buckets);
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
    if (savedPrice.current && savedPrice.current.unit === compactAxis && savedPrice.current.key === keyRef.current && !savedPrice.current.auto && savedPrice.current.range) {
      built.price.priceScale().applyOptions({ autoScale: false });
      built.price.priceScale().setVisibleRange(savedPrice.current.range);
    }
    if (paneHeights.current.length === chart.panes().length) chart.panes().forEach((pane, index) => pane.setStretchFactor(paneHeights.current[index]));
    const node = host.current;
    const onWheel = (event: WheelEvent) => {
      const range = chart.timeScale().getVisibleLogicalRange();
      if (!range) return;
      event.preventDefault();
      const bounds = node.getBoundingClientRect();
      const plotWidth = chart.timeScale().width();
      const x = Math.max(0, Math.min(plotWidth, event.clientX - bounds.left));
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1);
      if (event.shiftKey || event.clientX - bounds.left >= plotWidth) {
        scalePrice(Math.exp(Math.max(-0.3, Math.min(0.3, delta * 0.003))));
      } else if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.ctrlKey) {
        const shift = event.deltaX / Math.max(1, plotWidth) * (range.to - range.from);
        chart.timeScale().setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
      } else {
        const width = Math.max(5, Math.min(100000, (range.to - range.from) * Math.exp(Math.max(-0.5, Math.min(0.5, delta * 0.003)))));
        const anchor = chart.timeScale().coordinateToLogical(x) ?? ((range.from + range.to) / 2);
        const fraction = (anchor - range.from) / (range.to - range.from);
        chart.timeScale().setVisibleLogicalRange({ from: anchor - width * fraction, to: anchor + width * (1 - fraction) });
      }
    };
    const unlockDrag = (event: PointerEvent) => {
      if (event.button !== 0 || drawingActive.current) return;
      const bounds = node.getBoundingClientRect();
      if (event.clientX - bounds.left < chart.timeScale().width() && event.clientY - bounds.top < chart.paneSize(0).height) {
        built.price.priceScale().applyOptions({ autoScale: false });
        node.parentElement?.focus({ preventScroll: true });
      }
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("pointerdown", unlockDrag, true);
    chart.timeScale().setVisibleLogicalRange(visibleRangeRef.current || defaultRange());
    const rememberRange = (next: { from: number; to: number } | null) => {
      if (next) {
        visibleRangeRef.current = { from: Number(next.from), to: Number(next.to) };
        const bars = heldRef.current.candles;
        const first = bars[Math.max(0, Math.floor(next.from))];
        const last = bars[Math.min(bars.length - 1, Math.ceil(next.to))];
        if(first && last) interactionRef.current.onVisibleRange?.({from:first.time,to:last.time+intervalRef.current});
      }
      requestAnimationFrame(refreshSmartBubbles);
    };
    // One legend update per frame; a hidden tab gets no frames, so apply synchronously there to avoid a stale hover.
    const onCrosshair = (param: MouseEventParams<Time>) => {
      if(!syncingCrosshair.current && param.sourceEvent)crosshairCallback.current?.(typeof param.time==='number'?param.time*1000:null);
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
    const selectTime = (param: MouseEventParams<Time>) => {
      if (!drawingActive.current && typeof param.time === "number") interactionRef.current.onSelectTime?.(param.time * 1000);
    };
    chart.subscribeClick(selectTime);
    rememberRange(chart.timeScale().getVisibleLogicalRange());
    refreshLegend();
    refreshSmartBubbles();
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("pointerdown", unlockDrag, true);
      savedPrice.current = { range: built.price.priceScale().getVisibleRange(), auto: built.price.priceScale().options().autoScale, unit: compactAxis, key: keyRef.current };
      paneHeights.current = chart.panes().map(pane => pane.getStretchFactor());
      const current = chart.timeScale().getVisibleLogicalRange();
      if (current) visibleRangeRef.current = { from: Number(current.from), to: Number(current.to) };
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(rememberRange);
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.unsubscribeClick(selectTime);
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      if (builtRef.current === built) builtRef.current = null;
      disposeDrawings.current?.();
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
    const previousRange = built.chart.timeScale().getVisibleLogicalRange();
    const preservedRange = previousRange ? rebaseViewport(previousRange, held.candles, displayCandles) : null;
    applyCandles(built, held, displayCandles, plan);
    barCountRef.current = displayCandles.length;
    if (keyChanged) {
      savedPrice.current = null;
      built.price.priceScale().applyOptions({ autoScale: true });
      const next = defaultRange();
      visibleRangeRef.current = next;
      built.chart.timeScale().setVisibleLogicalRange(next);
    } else if (plan.kind === "reset") {
      built.chart.timeScale().setVisibleLogicalRange(preservedRange || defaultRange());
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
    const unsubscribe = api.subscribe(state => { drawingActive.current = Boolean(state.tool || state.drafting || state.selectedId); });
    onDrawings?.(api);
    let disposed=false;
    const dispose=() => {
      if(disposed)return;
      disposed=true;
      unsubscribe();
      drawingActive.current = false;
      onDrawings?.(null);
      api.destroy();
      if(disposeDrawings.current===dispose)disposeDrawings.current=null;
    };
    disposeDrawings.current=dispose;
    return dispose;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountKey, drawingsKey]);

  // Markers ride the existing candle series: a new poll only calls setMarkers, it never rebuilds the chart.
  useEffect(() => {
    const built = builtRef.current;
    if (built) applyMarkers(built, heldRef.current, merged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merged]);

  useEffect(() => { requestAnimationFrame(refreshSmartBubbles); }, [smartMarkers, displayCandles]);

  // A new SMART poll can change the buckets under a resting crosshair; re-derive the strip without waiting for a move.
  useEffect(() => {
    refreshLegend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smartByTime]);

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
    <div className="chart-host" tabIndex={0} role="region" aria-label="Interactive price chart" aria-describedby="chart-navigation-help"
      onKeyDown={event => {
        if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, button")) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const chart = builtRef.current?.chart;
        if (!chart) return;
        if (event.key === "+" || event.key === "=") { event.preventDefault(); scaleRange(0.8); }
        else if (event.key === "-") { event.preventDefault(); scaleRange(1.25); }
        else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); scalePrice(event.key === "ArrowUp" ? 0.8 : 1.25); }
        else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          const range = chart.timeScale().getVisibleLogicalRange();
          if (!range) return;
          event.preventDefault();
          const shift = (range.to - range.from) * (event.key === "ArrowLeft" ? -0.15 : 0.15);
          chart.timeScale().setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
        } else if (event.key === "End") { event.preventDefault(); chart.timeScale().scrollToRealTime(); }
      }}>
      <div className="chart-canvas" ref={host} />
      <div className="chart-smart-bubbles" aria-label="Top trader activity">
        {smartBubbles.map(({ marker, x, y }, index) => {
          const wallet = marker.wallets[0];
          const address = wallet?.address || "unknown";
          const name = wallet?.twitter || wallet?.handle || `${address.slice(0, 5)}…${address.slice(-3)}`;
          return <div key={`${marker.time}-${marker.side}-${index}`} className={`chart-smart-bubble ${marker.side}`} style={{ left: x, top: y }} title={marker.text}>
            {wallet?.avatarUrl ? <img src={wallet.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <i className="pixel-trader-avatar" aria-hidden="true"><b /><b /><b /><b /></i>}
            <span>{name}{marker.wallets.length > 1 ? ` +${marker.wallets.length - 1}` : ""}</span>
          </div>;
        })}
      </div>
      <ChartLegend state={legend} compact={compactAxis} granularity={granularity} label={legendLabel} />
      <SmartHover view={smartHover} />
    </div>
  );
});
