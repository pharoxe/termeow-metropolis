import type { Chain, FlowBar } from './wire';
export type AggregateFlow = {
  chain: Chain; token: string; from: number; to: number; intervalMs: number; observedAt: number;
  bars: FlowBar[]; buyUsd: number; sellUsd: number; delta: number; trades: number; unpriced: number;
  capturedPools: number; knownPools: number;
  /** First captured print of this same population, over all time. Null when nothing is captured; never 0. */
  firstPrintAt: number | null;
  coverage: 'captured-only';
};
