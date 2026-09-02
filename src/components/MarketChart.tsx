import { useEffect, useRef } from "react";
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

function lineData(candles: Candle[], values: Array<number | null>) {
  return values.flatMap((value, index) => {
    if (value == null) return [];
    const raw = Number(candles[index].time);
    return [{ time: Math.floor(raw > 1e12 ? raw / 1000 : raw) as UTCTimestamp, value }];
  });
}

const EMPTY_CVD: CvdSeriesPoint[] = [];

const compactFormat = { type: "custom" as const, minMove: 1, formatter: (value: number) => axisUsd(value) };

export function MarketChart({ candles, indicators, cvdSeries = EMPTY_CVD, compactAxis = false }: { candles: Candle[]; indicators: IndicatorSet; cvdSeries?: CvdSeriesPoint[]; compactAxis?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!host.current || !candles.length) return;
    const node = host.current;
    const width = Math.max(node.clientWidth || 0, 320);
    const height = Math.max(node.clientHeight || 0, 280);
    const chart = createChart(node, {
      width,
      height,
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#090c12" }, textColor: "#85909f", fontFamily: "IBM Plex Mono, monospace" },
      grid: { vertLines: { color: "#141922" }, horzLines: { color: "#141922" } },
      crosshair: { vertLine: { color: "#506077" }, horzLine: { color: "#506077" } },
      rightPriceScale: { borderColor: "#202633" },
      timeScale: { borderColor: "#202633", timeVisible: true, secondsVisible: false }
    });
    chartRef.current = chart;
    const price = chart.addSeries(CandlestickSeries, {
      upColor: "#9aff72", downColor: "#ff5b68", borderVisible: false,
      wickUpColor: "#72c95b", wickDownColor: "#c44854", priceLineVisible: false,
      priceFormat: compactAxis ? compactFormat : { type: "price", precision: 5, minMove: 0.00001 }
    });
    const bars = candles.map((candle) => {
      const raw = Number(candle.time);
      const time = Math.floor(raw > 1e12 ? raw / 1000 : raw) as UTCTimestamp;
      return { time, open: candle.open, high: candle.high, low: candle.low, close: candle.close };
    }).filter((bar, index, list) => index === 0 || bar.time > list[index - 1].time);
    if (!bars.length) return;
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
      for (const [priceValue, title, color] of [[high, "RES", "#ff4d5e"], [low, "SUP", "#4df09b"], [windowOpen, "OPEN", "#28d7d0"]] as const) {
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
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles, indicators, cvdSeries, compactAxis]);

  return <div className="chart-host" ref={host} />;
}
