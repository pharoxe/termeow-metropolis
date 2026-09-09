export type ViewRange = { from: number; to: number };
/** Keep the same candle under the viewport after history is prepended or a rolling window drops bars. */
export function rebaseViewport(range: ViewRange, before: readonly { time: number }[], after: readonly { time: number }[]): ViewRange {
  if (!before.length || !after.length) return range;
  if (range.to >= before.length - 1) {
    const shift = after.length - before.length;
    return { from: range.from + shift, to: range.to + shift };
  }
  const anchor = Math.max(0, Math.min(before.length - 1, Math.floor(range.from)));
  const index = after.findIndex(candle => candle.time === before[anchor].time);
  if (index < 0) return range;
  const shift = index - anchor;
  return { from: range.from + shift, to: range.to + shift };
}
export function zoomViewport(range: ViewRange, factor: number): ViewRange {
  const width = Math.max(5, Math.min(100_000, (range.to - range.from) * factor));
  const center = (range.from + range.to) / 2;
  return { from: center - width / 2, to: center + width / 2 };
}
