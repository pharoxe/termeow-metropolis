import type { DiscoverWindow } from "../../shared/wire.js";
import { TRENCHES_SOURCE, type TrenchToken } from "../sources/trenches.js";
import type { DiscoverPartial } from "./merge.js";

/**
 * One robinhoodtrenches row as a partial. The site's volume24/change24/buys24/sells24 are 24h figures only, so under a
 * 1h window those stay null rather than being passed off as hourly; usd_in/usd_out are tracked-trader flows, not volume,
 * and are not mapped to volumeUsd. `mark` is the site's price; `mcap` is not in the normalized row (not mapped by the
 * source module) so marketCapUsd stays null here. `buyers` is the site's own tracked-buyer count (unofficial population).
 */
export function trenchPartial(row: TrenchToken, window: DiscoverWindow, now: number, lastOkAt: number | null, stale: boolean): DiscoverPartial {
  const daily = window === "24h";
  const createdAt = row.pairCreatedAt ?? row.firstAt;
  const txns = daily && row.buys24 !== null && row.sells24 !== null ? { buys: row.buys24, sells: row.sells24 } : null;
  return {
    token: row.address,
    source: TRENCHES_SOURCE,
    lastOkAt,
    stale,
    rank: null,
    symbol: row.symbol || null,
    name: row.name || null,
    priceUsd: row.priceUsd,
    marketCapUsd: null,
    liquidityUsd: row.liquidityUsd,
    volumeUsd: daily ? row.volume24Usd : null,
    changePct: daily ? row.change24Pct : null,
    txns,
    ageMs: createdAt === null ? null : Math.max(0, now - createdAt),
    pool: null,
    dex: null,
    fomoHolders: null,
    trackedBuyers: row.buyers
  };
}
