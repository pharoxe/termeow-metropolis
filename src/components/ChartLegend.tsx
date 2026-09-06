import { formatIst, type TimeGranularity } from "../lib/chartTime";
import { axisUsd, pct } from "../lib/format";
import type { LegendBar } from "../lib/liveCandle";
import { formatMicroPrice } from "../lib/priceFormat";

/** Legend state owned by MarketChart: the hovered bar, or the last bar when the pointer is off the chart. */
export type LegendState = { bar: LegendBar; hovered: boolean; total: number };

type ChartLegendProps = {
  state: LegendState | null;
  /** True in mcap mode: values are USD market cap and use the compact axis formatter instead of micro-price. */
  compact: boolean;
  granularity: TimeGranularity;
  /** Optional symbol prefix, e.g. "ANSEM/USD". */
  label?: string | null;
};

function value(amount: number | null, compact: boolean): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  return compact ? axisUsd(amount) : formatMicroPrice(amount);
}

export function ChartLegend({ state, compact, granularity, label }: ChartLegendProps) {
  if (!state) return null;
  const { bar, hovered } = state;
  const up = bar.close >= bar.open;
  const tone = up ? "up" : "down";
  return (
    <div className={`chart-legend ${hovered ? "is-hover" : "is-last"}`} aria-live="off">
      {label ? <span className="chart-legend-label">{label}</span> : null}
      <i className="chart-legend-tag">{hovered ? `BAR ${bar.index + 1}/${state.total}` : "LAST"}</i>
      <span>O<b className={tone}>{value(bar.open, compact)}</b></span>
      <span>H<b className={tone}>{value(bar.high, compact)}</b></span>
      <span>L<b className={tone}>{value(bar.low, compact)}</b></span>
      <span>C<b className={tone}>{value(bar.close, compact)}</b></span>
      <span>Δ<b className={bar.changePct == null ? "" : bar.changePct >= 0 ? "up" : "down"}>{pct(bar.changePct)}</b></span>
      <span>VOL<b>{bar.volume == null ? "—" : axisUsd(bar.volume)}</b></span>
      <span className="chart-legend-time">{formatIst(bar.time, granularity)}</span>
    </div>
  );
}
