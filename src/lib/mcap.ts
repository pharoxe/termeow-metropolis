import type { Candle } from "../types";

export type McapScale = {
  mcap: number | null;
  supply: number | null;
  source: "mcap" | "fdv" | null;
};

function finitePositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** Desk convention: trade off market cap. supply = mcap / token USD when both exist. */
export function mcapScale(input: {
  marketCapUsd?: number | null;
  priceUsd?: number | null;
  fdvUsd?: number | null;
}): McapScale {
  const price = finitePositive(input.priceUsd);
  const mcap = finitePositive(input.marketCapUsd);
  const fdv = finitePositive(input.fdvUsd);
  const basis = mcap ?? fdv;
  const source = mcap != null ? "mcap" as const : fdv != null ? "fdv" as const : null;
  const supply = basis != null && price != null ? basis / price : null;
  return { mcap: basis, supply, source };
}

/** Scale OHLC into mcap units. Volume stays USD volume. */
export function scaleCandlesToMcap(candles: Candle[], supply: number | null | undefined): Candle[] {
  if (supply == null || !Number.isFinite(supply) || supply <= 0) return candles;
  return candles.map((candle) => ({
    ...candle,
    open: candle.open * supply,
    high: candle.high * supply,
    low: candle.low * supply,
    close: candle.close * supply
  }));
}

export function rowMarketCap(item: Record<string, unknown>): number | null {
  for (const key of ["market_cap_usd", "marketCapUsd", "marketCap", "fdv_usd", "fdvUsd", "fdv"]) {
    const value = finitePositive(item[key]);
    if (value != null) return value;
  }
  return null;
}

export function rowTokenPrice(item: Record<string, unknown>): number | null {
  for (const key of ["price_usd", "priceUsd", "price"]) {
    const number = Number(item[key]);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}
