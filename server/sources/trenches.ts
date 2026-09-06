import { fetchJson } from "../lib/http.js";
import { createLastGoodCache } from "../lib/lastGood.js";

const TOKENS_URL = "https://robinhoodtrenches.com/api/tokens";
const CACHE_TTL_MS = 30_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Unofficial community site; label every population drawn from it. */
export const TRENCHES_SOURCE = "robinhoodtrenches · unofficial";

export type TrenchWindow = "1h" | "24h";

export type TrenchFirstBuyer = { at: number | null; priceUsd: number | null; handle: string | null; followers: number | null };

export type TrenchToken = {
  /** Lowercased 0x address on Robinhood Chain. */
  address: string;
  symbol: string;
  name: string;
  isStock: boolean;
  traders: number | null;
  buyers: number | null;
  usdIn: number | null;
  usdOut: number | null;
  netUsd: number | null;
  firstAt: number | null;
  lastAt: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  change24Pct: number | null;
  volume24Usd: number | null;
  pairUrl: string | null;
  pairCreatedAt: number | null;
  buys24: number | null;
  sells24: number | null;
  honeypot: boolean | null;
  firstBuyer: TrenchFirstBuyer | null;
  sinceFirstBuyPct: number | null;
  holders: number | null;
};

export type TrenchTokensResult = {
  rows: TrenchToken[];
  source: typeof TRENCHES_SOURCE;
  window: TrenchWindow;
  observedAt: number;
  stale: boolean;
  error?: string;
};

type RawFirstBuyer = { ts?: unknown; price?: unknown; handle?: unknown; followers?: unknown };

type RawTrenchToken = {
  token?: unknown;
  symbol?: unknown;
  name?: unknown;
  is_stock?: unknown;
  traders?: unknown;
  buyers?: unknown;
  usd_in?: unknown;
  usd_out?: unknown;
  net_usd?: unknown;
  first_ts?: unknown;
  last_ts?: unknown;
  mark?: unknown;
  liquidity?: unknown;
  change24?: unknown;
  volume24?: unknown;
  pair_url?: unknown;
  pair_created_at?: unknown;
  buys24?: unknown;
  sells24?: unknown;
  honeypot?: unknown;
  first_buyer?: unknown;
  since_first_buy_pct?: unknown;
  holders?: unknown;
};

const cache = createLastGoodCache<TrenchToken[]>(CACHE_TTL_MS);

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Trenches timestamps are unix seconds; the desk speaks ms. */
function secondsToMs(value: unknown): number | null {
  const seconds = finiteOrNull(value);
  return seconds === null ? null : Math.round(seconds * 1000);
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstBuyer(raw: unknown): TrenchFirstBuyer | null {
  if (!raw || typeof raw !== "object") return null;
  const buyer = raw as RawFirstBuyer;
  return {
    at: secondsToMs(buyer.ts),
    priceUsd: finiteOrNull(buyer.price),
    handle: textOrNull(buyer.handle),
    followers: finiteOrNull(buyer.followers)
  };
}

/** One /api/tokens row; null when it carries no 0x token address. */
export function normalizeTrenchToken(raw: unknown): TrenchToken | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as RawTrenchToken;
  const address = typeof row.token === "string" ? row.token.trim().toLowerCase() : "";
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
  return {
    address,
    symbol: textOrNull(row.symbol) ?? "",
    name: textOrNull(row.name) ?? "",
    isStock: row.is_stock === 1 || row.is_stock === true,
    traders: finiteOrNull(row.traders),
    buyers: finiteOrNull(row.buyers),
    usdIn: finiteOrNull(row.usd_in),
    usdOut: finiteOrNull(row.usd_out),
    netUsd: finiteOrNull(row.net_usd),
    firstAt: secondsToMs(row.first_ts),
    lastAt: secondsToMs(row.last_ts),
    priceUsd: finiteOrNull(row.mark),
    liquidityUsd: finiteOrNull(row.liquidity),
    change24Pct: finiteOrNull(row.change24),
    volume24Usd: finiteOrNull(row.volume24),
    pairUrl: textOrNull(row.pair_url),
    pairCreatedAt: secondsToMs(row.pair_created_at),
    buys24: finiteOrNull(row.buys24),
    sells24: finiteOrNull(row.sells24),
    honeypot: typeof row.honeypot === "boolean" ? row.honeypot : null,
    firstBuyer: firstBuyer(row.first_buyer),
    sinceFirstBuyPct: finiteOrNull(row.since_first_buy_pct),
    holders: finiteOrNull(row.holders)
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

async function loadTokens(window: TrenchWindow, limit: number): Promise<TrenchToken[]> {
  const url = `${TOKENS_URL}?window=${window}&limit=${limit}`;
  const body = await fetchJson<unknown>(url, { headers: { Accept: "application/json" } });
  if (!Array.isArray(body)) return [];
  return body.map(normalizeTrenchToken).filter((row): row is TrenchToken => row !== null);
}

/**
 * robinhoodtrenches.com /api/tokens for a window, normalized; 30s TTL and last-good per (window, limit). Throws only before
 * the first success for that key so the route can answer 200 + error.
 */
export async function fetchTrenchTokens(window: TrenchWindow = "1h", limit?: number): Promise<TrenchTokensResult> {
  const capped = clampLimit(limit);
  const entry = await cache.get(`${window}:${capped}`, () => loadTokens(window, capped));
  return { rows: entry.value, source: TRENCHES_SOURCE, window, observedAt: entry.observedAt, stale: entry.stale, ...(entry.error ? { error: entry.error } : {}) };
}

export function resetTrenchCache(): void {
  cache.reset();
}
