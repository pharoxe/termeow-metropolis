import type { OnchainMarket } from "../types";
import { money, pct } from "../lib/format";

export function MarketStats({ market }: { market: OnchainMarket }) {
  const stats = [
    ["MCAP", money(market.marketCapUsd ?? market.fdvUsd, true)],
    ["24H", pct(market.change24hPct)],
    ["VOLUME", money(market.volume24hUsd, true)],
    ["LIQUIDITY", money(market.liquidityUsd, true)],
    ["TOKEN", money(market.priceUsd)],
    ["FDV", money(market.fdvUsd, true)]
  ];
  return (
    <div className="stats-grid">
      {stats.map(([label, value]) => <div key={label}><small>{label}</small><strong className={label === "24H" && Number(market.change24hPct) < 0 ? "negative" : ""}>{value}</strong></div>)}
    </div>
  );
}
