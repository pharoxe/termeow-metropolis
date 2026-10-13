import type { SmartHoverView } from "../lib/smartHover";

type SmartHoverProps = { view: SmartHoverView | null };

/** Wallet breakdown of the hovered candle's SMART buckets; rendered under the OHLCV legend, hidden when the candle has none. */
export function SmartHover({ view }: SmartHoverProps) {
  if (!view) return null;
  return (
    <div className="chart-smart-hover" aria-live="off">
      <div className="chart-smart-title">{view.title}</div>
      <ul className="chart-smart-rows">
        {view.rows.map((row, index) => (
          <li key={`${row.label}|${row.side}|${index}`} className={row.seeded ? "is-seeded" : undefined}>
            <span className="chart-smart-label">{row.label}</span>
            <b className={row.side === "buy" ? "up" : "down"}>{row.side.toUpperCase()}</b>
            <span className="chart-smart-amount">{row.amount}</span>
            {/* always the 4th grid cell: the rows are `display: contents`, so a missing cell would shift every following row left */}
            <i className="chart-smart-tag">{row.seeded ? "SEEDED" : ""}</i>
          </li>
        ))}
      </ul>
      {view.more > 0 ? <div className="chart-smart-more">+{view.more} more wallets</div> : null}
    </div>
  );
}
