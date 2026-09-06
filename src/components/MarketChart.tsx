import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type UTCTimestamp
} from "lightweight-charts";
import type { Candle } from "../types";
import { bollinger, ema, macd, obv, rsi, vwap } from "../lib/indicators";
import { axisUsd } from "../lib/format";
import { alignFlowToCandles } from "../lib/cvdAlign";
import type { Theme } from "./ThemeToggle";

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

export type CvdSeriesPoint = { time: number; value: number };
export type MarketChartHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
  goToRealtime: () => void;
};

function lineData(candles: Candle[], values: Array<number | null>) {
  return values.flatMap((value, index) => {
    if (value == null) return [];
    const raw = Number(candles[index].time);
    return [{ time: Math.floor(raw > 1e12 ? raw / 1000 : raw) as UTCTimestamp, value }];
  });
}

const EMPTY_CVD: CvdSeriesPoint[] = [];

const compactFormat = { type: "custom" as const, minMove: 1, formatter: (value: number) => axisUsd(value) };

const DEFAULT_VISIBLE_BARS = 88;

export const MarketChart = forwardRef<MarketChartHandle, { candles: Candle[]; indicators: IndicatorSet; cvdSeries?: CvdSeriesPoint[]; compactAxis?: boolean; theme?: Theme }>(function MarketChart({ candles, indicators, cvdSeries = EMPTY_CVD, compactAxis = false, theme = "dark" }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const barCountRef = useRef(0);
  const visibleRangeRef = useRef<{ from: number; to: number } | null>(null);

  const defaultRange = () => ({
    from: Math.max(0, barCountRef.current - DEFAULT_VISIBLE_BARS),
    to: barCountRef.current + 4
  });

  const scaleRange = (factor: number) => {
    const current = chartRef.current?.timeScale().getVisibleLogicalRange() || visibleRangeRef.current || defaultRange();
    const center = (Number(current.from) + Number(current.to)) / 2;
    const half = Math.max(12, (Number(current.to) - Number(current.from)) * factor / 2);
    const next = { from: center - half, to: center + half };
    visibleRangeRef.current = next;
    chartRef.current?.timeScale().setVisibleLogicalRange(next);
  };

  useImperativeHandle(ref, () => ({
    zoomIn: () => scaleRange(0.72),
    zoomOut: () => scaleRange(1.38),
    resetView: () => {
      const next = defaultRange();
      visibleRangeRef.current = next;
      chartRef.current?.timeScale().setVisibleLogicalRange(next);
    },
    goToRealtime: () => chartRef.current?.timeScale().scrollToRealTime()
  }), []);

  useEffect(() => {
    if (!host.current || !candles.length) return;
    const node = host.current;
    const width = Math.max(node.clientWidth || 0, 320);
    const height = Math.max(node.clientHeight || 0, 280);
    const palette = theme === "light"
      ? { background: "rgba(247,250,245,0.86)", text: "#516058", grid: "rgba(190,207,194,0.62)", crosshair: "#7b8d82", border: "#cad7cc" }
      : { background: "rgba(8,11,9,0.82)", text: "#8c9a91", grid: "rgba(35,51,40,0.62)", crosshair: "#526357", border: "#253129" };
    const chart = createChart(node, {
      width,
      height,
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: palette.background }, textColor: palette.text, fontFamily: "Home Video, monospace" },
      grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
      crosshair: { vertLine: { color: palette.crosshair }, horzLine: { color: palette.crosshair } },
      rightPriceScale: { borderColor: palette.border },
      timeScale: { borderColor: palette.border, timeVisible: true, secondsVisible: false },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
    });
    chartRef.current = chart;
    const price = chart.addSeries(CandlestickSeries, {
      upColor: "#39ff88", downColor: "#ff5268", borderVisible: false,
      wickUpColor: "#18b85d", wickDownColor: "#c44854", priceLineVisible: false,
      priceFormat: compactAxis ? compactFormat : { type: "price", precision: 5, minMove: 0.00001 }
    });
    const bars = candles.map((candle) => {
      const raw = Number(candle.time);
      const time = Math.floor(raw > 1e12 ? raw / 1000 : raw) as UTCTimestamp;
      return { time, open: candle.open, high: candle.high, low: candle.low, close: candle.close };
    }).filter((bar, index, list) => index === 0 || bar.time > list[index - 1].time);
    if (!bars.length) return;
    barCountRef.current = bars.length;
    price.setData(bars);

    const closes = candles.map((candle) => candle.close);
    if (indicators.ema) {
      const fast = chart.addSeries(LineSeries, { color: "#f5cf5f", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      const slow = chart.addSeries(LineSeries, { color: "#d08cff", lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
      fast.setData(lineData(candles, ema(closes, 20)));
      slow.setData(lineData(candles, ema(closes, 50)));
    }
    if (indicators.vwap) {
      const series = chart.addSeries(LineSeries, { color: "#64b5ff", lineWidth: 2, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
      series.setData(lineData(candles, vwap(candles)));
    }
    if (indicators.bollinger) {
      const bands = bollinger(closes);
      for (const [key, color] of [["upper", "#43536a"], ["lower", "#43536a"]] as const) {
        const series = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
        series.setData(lineData(candles, bands.map((band) => band[key])));
      }
    }
    if (indicators.volume) {
      const volume = chart.addSeries(HistogramSeries, { priceFormat: compactFormat, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volume.setData(candles.map((candle) => ({
        time: Math.floor(Number(candle.time) > 1e12 ? Number(candle.time) / 1000 : Number(candle.time)) as UTCTimestamp,
        value: candle.volume,
        color: candle.close >= candle.open ? "#315b30aa" : "#64333aaa"
      })));
    }
    if (indicators.sr) {
      const high = Math.max(...candles.map((candle) => candle.high));
      const low = Math.min(...candles.map((candle) => candle.low));
      const windowOpen = candles[0]?.close ?? candles[0]?.open;
      for (const [priceValue, title, color] of [[high, "RES", "#ff4d5e"], [low, "SUP", "#39ff88"], [windowOpen, "OPEN", "#00b86b"]] as const) {
        if (Number.isFinite(priceValue)) price.createPriceLine({ price: priceValue, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title });
      }
    }
    let pane = 1;
    if (indicators.cvd) {
      const aligned = alignFlowToCandles(candles, cvdSeries);
      if (aligned.delta.length) {
        const delta = chart.addSeries(HistogramSeries, {
          priceFormat: compactFormat,
          lastValueVisible: true,
          priceLineVisible: false,
          title: "DELTA"
        }, pane);
        delta.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });
        delta.setData(aligned.delta.map((bar) => ({ time: bar.time as UTCTimestamp, value: bar.value, color: bar.color })));
        const cvd = chart.addSeries(LineSeries, {
          color: "#28d7d0",
          lineWidth: 1,
          priceFormat: compactFormat,
          lastValueVisible: true,
          priceLineVisible: false,
          title: "CVD",
          priceScaleId: "cvd-line"
        }, pane++);
        cvd.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });
        cvd.setData(aligned.cvd.map((bar) => ({ time: bar.time as UTCTimestamp, value: bar.value })));
      }
    }
    if (indicators.rsi) {
      const series = chart.addSeries(LineSeries, { color: "#28d7d0", lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: "RSI14" }, pane++);
      series.setData(lineData(candles, rsi(closes)));
      series.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0.15 } });
    }
    if (indicators.macd) {
      const values = macd(closes);
      const line = chart.addSeries(LineSeries, { color: "#3aa0ff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: "MACD" }, pane);
      const signal = chart.addSeries(LineSeries, { color: "#ff9f0a", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: "SIGNAL" }, pane++);
      line.setData(lineData(candles, values.line));
      signal.setData(lineData(candles, values.signal));
    }
    if (indicators.obv) {
      const series = chart.addSeries(LineSeries, { color: "#c084fc", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: "OBV" }, pane++);
      series.setData(lineData(candles, obv(candles)));
    }
    const panes = chart.panes();
    if (panes.length > 1) {
      panes[0].setStretchFactor(3.4);
      for (let index = 1; index < panes.length; index += 1) panes[index].setStretchFactor(1);
    }
    const range = visibleRangeRef.current || defaultRange();
    chart.timeScale().setVisibleLogicalRange(range);
    const rememberRange = (next: { from: number; to: number } | null) => {
      if (next) visibleRangeRef.current = { from: Number(next.from), to: Number(next.to) };
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(rememberRange);
    return () => {
      const current = chart.timeScale().getVisibleLogicalRange();
      if (current) visibleRangeRef.current = { from: Number(current.from), to: Number(current.to) };
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(rememberRange);
      if (chartRef.current === chart) chartRef.current = null;
      chart.remove();
    };
  }, [candles, indicators, cvdSeries, compactAxis, theme]);

  return <div className="chart-host" ref={host} />;
});
