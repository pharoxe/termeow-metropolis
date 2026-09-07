import type { FomoHoverView } from "../lib/fomoHover";

type FomoHoverProps = { view: FomoHoverView | null };

/** Wallet breakdown of the hovered candle's FOMO buckets; rendered under the OHLCV legend, hidden when the candle has none. */
export function FomoHover({ view }: FomoHoverProps) {
  if (!view) return null;
  return (
    <div className="chart-fomo-hover" aria-live="off">
      <div className="chart-fomo-title">{view.title}</div>
      <ul className="chart-fomo-rows">
        {view.rows.map((row, index) => (
          <li key={`${row.label}|${row.side}|${index}`} className={row.seeded ? "is-seeded" : undefined}>
            <span className="chart-fomo-label">{row.label}</span>
            <b className={row.side === "buy" ? "up" : "down"}>{row.side.toUpperCase()}</b>
            <span className="chart-fomo-amount">{row.amount}</span>
            {/* always the 4th grid cell: the rows are `display: contents`, so a missing cell would shift every following row left */}
            <i className="chart-fomo-tag">{row.seeded ? "SEEDED" : ""}</i>
          </li>
        ))}
      </ul>
      {view.more > 0 ? <div className="chart-fomo-more">+{view.more} more wallets</div> : null}
    </div>
  );
}
