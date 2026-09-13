import type { FomoFill, Side, TapePrint } from "../../shared/wire";

export const AGENT_SIGNAL_MIN_USD = 1_000;

export function isLargeAgentSignal(fill: Pick<FomoFill, "usd">) {
  return (fill.usd || 0) >= AGENT_SIGNAL_MIN_USD;
}

export function filterRecentOrderFlow(
  tape: TapePrint[],
  options: { now: number; windowMinutes: number; minUsd?: number; side?: Side }
) {
  const minimumUsd = Math.max(AGENT_SIGNAL_MIN_USD, options.minUsd ?? AGENT_SIGNAL_MIN_USD);
  const since = options.now - Math.max(1, options.windowMinutes) * 60_000;
  return tape.filter((row) => row.time >= since
    && (row.usd || 0) >= minimumUsd
    && (!options.side || row.side === options.side));
}
