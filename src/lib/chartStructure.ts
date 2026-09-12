import type { Candle } from "../types";
import type { TerminalAgentSnapshot } from "../../shared/automation";

export type RecentRally = NonNullable<NonNullable<NonNullable<TerminalAgentSnapshot["chart"]>["structure"]>["recentRally"]>;

/** O(n), capped at 160 bars: exact Fibonacci context without another agent tool call or RPC. */
export function recentRallyStructure(candles: readonly Candle[]): RecentRally | null {
  const bars = candles.filter((bar) => Number.isFinite(bar.low) && Number.isFinite(bar.high) && bar.high >= bar.low).slice(-160);
  if (bars.length < 8) return null;
  const ranges = bars.slice(-14).map((bar) => bar.high - bar.low).filter((value) => value > 0);
  const noise = ranges.length ? ranges.reduce((sum, value) => sum + value, 0) / ranges.length : 0;
  let best: { low: number; high: number; lowIndex: number; highIndex: number; score: number } | null = null;
  let runningLow = bars[0].low;
  let runningLowIndex = 0;
  // A swing high needs at least one confirming bar after it; the forming/latest bar is not a confirmed pivot.
  for (let highIndex = 1; highIndex < bars.length - 1; highIndex += 1) {
    const prior = bars[highIndex - 1];
    if (prior.low < runningLow) { runningLow = prior.low; runningLowIndex = highIndex - 1; }
    const high = bars[highIndex].high;
    if (high < bars[highIndex - 1].high || high < bars[highIndex + 1].high) continue;
    const move = high - runningLow;
    const movePct = runningLow > 0 ? move / runningLow : 0;
    if (move <= 0 || (move < noise * 1.8 && movePct < 0.025)) continue;
    const score = (highIndex / bars.length) * 2 + Math.min(3, move / Math.max(noise, Number.EPSILON)) * 0.15;
    if (!best || score >= best.score) best = { low: runningLow, high, lowIndex: runningLowIndex, highIndex, score };
  }
  if (!best || best.highIndex <= best.lowIndex) return null;
  const range = best.high - best.low;
  const impulseBars = best.highIndex - best.lowIndex + 1;
  const ratio = range / Math.max(noise, Number.EPSILON);
  return {
    swingLow: best.low, swingHigh: best.high,
    swingLowTime: bars[best.lowIndex].time, swingHighTime: bars[best.highIndex].time,
    retracement0382: best.high - range * 0.382,
    retracement05: best.high - range * 0.5,
    retracement0618: best.high - range * 0.618,
    invalidationBelow: best.low,
    bars: impulseBars,
    confidence: ratio >= 5 && impulseBars >= 4 ? "high" : ratio >= 2.5 ? "medium" : "low"
  };
}
