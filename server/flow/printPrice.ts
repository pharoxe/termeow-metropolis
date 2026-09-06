import type { FlowPrint } from "../../shared/wire.js";

/**
 * Per-print USD-per-token derivation shared by every print producer.
 * price = usd / tokenUnits, computed only from the print's own amounts (never a fetch, never carried from another
 * print). The key is omitted, not nulled, whenever either side is unknown or non-positive.
 */
export type PriceField = { price: number } | Record<never, never>;

export function perTokenPrice(usd: number | null | undefined, tokenUnits: number | null | undefined): PriceField {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd < 0) return {};
  if (tokenUnits === null || tokenUnits === undefined || !Number.isFinite(tokenUnits)) return {};
  const units = Math.abs(tokenUnits);
  if (units === 0) return {};
  const price = usd / units;
  return Number.isFinite(price) ? { price } : {};
}

/** Projection helper: copies a finite `price` off a ledger print, omitting the key otherwise. */
export function priceOf(print: Pick<FlowPrint, "price">): PriceField {
  return typeof print.price === "number" && Number.isFinite(print.price) ? { price: print.price } : {};
}
