import type { Candle } from "../types";

export type CvdSeriesPoint = { time: number; value: number };
export type AlignedBar = { time: number; value: number; color: string };
export type AlignedLine = { time: number; value: number };

function toUtc(raw: number) {
  return Math.floor(raw > 1e12 ? raw / 1000 : raw);
}

/** Per-bar DELTA (buy−sell in that candle) plus running CVD, snapped to candle times. */
export function alignFlowToCandles(candles: Candle[], points: CvdSeriesPoint[]) {
  const prints = [...points]
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value))
    .sort((a, b) => a.time - b.time)
    .map((point) => ({ time: toUtc(Number(point.time)), value: point.value }));
  const delta: AlignedBar[] = [];
  const cvd: AlignedLine[] = [];
  let index = 0;
  let last: number | null = null;
  let prev = 0;
  for (const candle of candles) {
    const time = toUtc(Number(candle.time));
    while (index < prints.length && prints[index].time <= time) {
      last = prints[index].value;
      index += 1;
    }
    if (last == null) continue;
    const change = last - prev;
    if (!delta.length || time > delta[delta.length - 1].time) {
      delta.push({ time, value: change, color: change >= 0 ? "#4df09b" : "#ff4d5e" });
      cvd.push({ time, value: last });
    } else {
      delta[delta.length - 1] = { time, value: change, color: change >= 0 ? "#4df09b" : "#ff4d5e" };
      cvd[cvd.length - 1] = { time, value: last };
    }
    prev = last;
  }
  return { delta, cvd };
}
