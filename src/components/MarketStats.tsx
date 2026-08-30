import type { OnchainMarket } from "../types";
import { money, pct } from "../lib/format";

export function MarketStats({ market }: { market: OnchainMarket }) {
  const stats = [
    ["PRICE", money(market.priceUsd)],
    ["24H", pct(market.change24hPct)],
    ["VOLUME", money(market.volume24hUsd, true)],
    ["LIQUIDITY", money(market.liquidityUsd, true)],
    ["MARKET CAP", money(market.marketCapUsd, true)],
    ["FDV", money(market.fdvUsd, true)]
  ];
  return (
    <div className="stats-grid">
      {stats.map(([label, value]) => <div key={label}><small>{label}</small><strong className={label === "24H" && Number(market.change24hPct) < 0 ? "negative" : ""}>{value}</strong></div>)}
    </div>
  );
}
