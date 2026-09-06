import type { Chain, MarketResponse } from "../../shared/wire.js";

export const UNKNOWN_SYMBOL = "TOKEN";

/** Finite number or null; never coerces a missing upstream field into 0. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function text(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

/** Keeps only `{ type, url }` entries with non-empty strings; anything else is dropped, never guessed. */
export function socialLinks(value: unknown): Array<{ type: string; url: string }> {
  if (!Array.isArray(value)) return [];
  const links: Array<{ type: string; url: string }> = [];
  for (const entry of value) {
    const type = text(record(entry).type);
    const url = text(record(entry).url);
    if (type && url) links.push({ type, url });
  }
  return links;
}

/** Website URLs from either `[{ url }]` (DexScreener) or `[string]`. */
export function websiteLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === "string" ? text(entry) : text(record(entry).url))).filter((url): url is string => url !== null);
}

/** The 200 + error envelope for a chain/address the route could not price at all. */
export function emptyMarketResponse(chain: Chain, address: string, interval: string, observedAt: number, source: string, error: string): MarketResponse {
  return {
    instrument: { chain, address, symbol: UNKNOWN_SYMBOL, name: UNKNOWN_SYMBOL, image: null, socials: [], websites: [] },
    priceUsd: null,
    marketCapUsd: null,
    fdvUsd: null,
    liquidityUsd: null,
    volume24Usd: null,
    change24Pct: null,
    primaryPair: null,
    candles: [],
    interval,
    observedAt,
    source,
    degraded: true,
    notes: [],
    error
  };
}
