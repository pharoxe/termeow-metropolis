import type { Candle } from "../types";

export function ema(values: number[], period: number): Array<number | null> {
  if (period <= 0) throw new Error("EMA period must be positive");
  const out: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return out;
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  out[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    current = (values[i] - current) * multiplier + current;
    out[i] = current;
  }
  return out;
}

export function rsi(values: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function bollinger(values: number[], period = 20, deviations = 2) {
  return values.map((_, index) => {
    if (index < period - 1) return { mid: null, upper: null, lower: null };
    const window = values.slice(index - period + 1, index + 1);
    const mid = window.reduce((sum, value) => sum + value, 0) / period;
    const variance = window.reduce((sum, value) => sum + (value - mid) ** 2, 0) / period;
    const width = Math.sqrt(variance) * deviations;
    return { mid, upper: mid + width, lower: mid - width };
  });
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9) {
  const fastLine = ema(values, fast);
  const slowLine = ema(values, slow);
  const line = values.map((_, index) => fastLine[index] != null && slowLine[index] != null
    ? fastLine[index]! - slowLine[index]!
    : null);
  const valid = line.filter((value): value is number => value != null);
  const signalValid = ema(valid, signalPeriod);
  let cursor = 0;
  const signal = line.map((value) => value == null ? null : signalValid[cursor++]);
  const histogram = line.map((value, index) => value != null && signal[index] != null ? value - signal[index]! : null);
  return { line, signal, histogram };
}

export function vwap(candles: Candle[]) {
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  return candles.map((candle) => {
    const typical = (candle.high + candle.low + candle.close) / 3;
    cumulativePriceVolume += typical * candle.volume;
    cumulativeVolume += candle.volume;
    return cumulativeVolume ? cumulativePriceVolume / cumulativeVolume : null;
  });
}

export function atr(candles: Candle[], period = 14): Array<number | null> {
  const ranges = candles.map((candle, index) => index === 0
    ? candle.high - candle.low
    : Math.max(candle.high - candle.low, Math.abs(candle.high - candles[index - 1].close), Math.abs(candle.low - candles[index - 1].close)));
  return ranges.map((_, index) => index < period - 1
    ? null
    : ranges.slice(index - period + 1, index + 1).reduce((sum, value) => sum + value, 0) / period);
}

export function obv(candles: Candle[]) {
  let total = 0;
  return candles.map((candle, index) => {
    if (index > 0) total += candle.close > candles[index - 1].close ? candle.volume : candle.close < candles[index - 1].close ? -candle.volume : 0;
    return total;
  });
}
