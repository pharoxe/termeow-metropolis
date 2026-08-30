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

export type IndicatorSet = {
  ema: boolean;
  bollinger: boolean;
  vwap: boolean;
  sr: boolean;
  volume: boolean;
  rsi: boolean;
  macd: boolean;
  obv: boolean;
};

function lineData(candles: Candle[], values: Array<number | null>) {
  return values.flatMap((value, index) => value == null ? [] : [{ time: Math.floor(candles[index].time / 1000) as UTCTimestamp, value }]);
}

export function MarketChart({ candles, indicators }: { candles: Candle[]; indicators: IndicatorSet }) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!host.current || !candles.length) return;
    const chart = createChart(host.current, {
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
      wickUpColor: "#72c95b", wickDownColor: "#c44854", priceLineVisible: false
    });
    price.setData(candles.map((candle) => ({
      time: Math.floor(candle.time / 1000) as UTCTimestamp,
      open: candle.open, high: candle.high, low: candle.low, close: candle.close
    })));

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
      const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volume.setData(candles.map((candle) => ({
        time: Math.floor(candle.time / 1000) as UTCTimestamp,
        value: candle.volume,
        color: candle.close >= candle.open ? "#315b30aa" : "#64333aaa"
      })));
    }
    if (indicators.sr) {
      const recent = candles.slice(-96);
      const high = Math.max(...recent.map((candle) => candle.high));
      const low = Math.min(...recent.map((candle) => candle.low));
      const previousClose = recent[0]?.close;
      for (const [priceValue, title, color] of [[high, "R96", "#ff4d5e"], [low, "S96", "#4df09b"], [previousClose, "OPEN96", "#28d7d0"]] as const) {
        if (Number.isFinite(priceValue)) price.createPriceLine({ price: priceValue, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title });
      }
    }
    let pane = 1;
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
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles, indicators]);

  return <div className="chart-host" ref={host} />;
}
