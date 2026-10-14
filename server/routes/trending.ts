import { Router } from "express";
import { z } from "zod";
import { fetchJson } from "../lib/http.js";

/**
 * Trending tokens per chain from GeckoTerminal's keyless trending-pools feed (30 requests/min, so each chain is cached
 * for a minute). Read-only: Monad is the only chain the agent can trade; Solana and Robinhood are for research.
 */
export const TRENDING_CHAINS = ["monad", "solana", "robinhood"] as const;
const TRENDING_TTL_MS = 60_000;
const querySchema = z.object({
  window: z.enum(["5m", "1h", "6h", "24h"]).default("1h"),
  limit: z.coerce.number().int().min(1).max(20).default(10)
});

export type TrendingToken = {
  chain: (typeof TRENDING_CHAINS)[number];
  address: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number | null;
  change1hPct: number | null;
  change24hPct: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  pool: string;
  dex: string | null;
};

type GeckoPool = {
  attributes: Record<string, any>;
  relationships?: { base_token?: { data?: { id?: string } }; dex?: { data?: { id?: string } } };
};
type GeckoTrending = { data?: GeckoPool[]; included?: Array<{ id: string; type: string; attributes: Record<string, any> }> };

const num = (value: unknown) => {
  const parsed = Number(value);
  return value == null || value === "" || !Number.isFinite(parsed) ? null : parsed;
};

export function normalizeTrending(chain: TrendingToken["chain"], body: GeckoTrending): TrendingToken[] {
  const tokens = new Map((body.included ?? []).filter((item) => item.type === "token").map((item) => [item.id, item.attributes]));
  const seen = new Set<string>();
  const rows: TrendingToken[] = [];
  for (const pool of body.data ?? []) {
    const tokenId = pool.relationships?.base_token?.data?.id ?? "";
    const token = tokens.get(tokenId);
    const address = String(token?.address ?? tokenId.split("_").slice(1).join("_"));
    if (!address || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    const attributes = pool.attributes;
    rows.push({
      chain, address, symbol: String(token?.symbol ?? attributes.name?.split("/")[0]?.trim() ?? "?"), name: String(token?.name ?? attributes.name ?? ""),
      imageUrl: token?.image_url && token.image_url !== "missing.png" ? String(token.image_url) : null,
      priceUsd: num(attributes.base_token_price_usd), change1hPct: num(attributes.price_change_percentage?.h1),
      change24hPct: num(attributes.price_change_percentage?.h24), volume24hUsd: num(attributes.volume_usd?.h24),
      liquidityUsd: num(attributes.reserve_in_usd), marketCapUsd: num(attributes.market_cap_usd) ?? num(attributes.fdv_usd),
      pool: String(attributes.address ?? ""), dex: pool.relationships?.dex?.data?.id ?? null
    });
  }
  return rows;
}

const cache = new Map<string, { at: number; rows: TrendingToken[] }>();

/** Monad fallback when GeckoTerminal is rate limited: the desk's own DexScreener-built trending list. */
async function monadDiscoverTrending(window: string): Promise<TrendingToken[]> {
  const { discoverMonad } = await import("../discover/monad.js");
  const response = await discoverMonad("trending", window === "24h" || window === "6h" ? "24h" : "1h");
  return response.rows.map((row) => ({
    chain: "monad", address: row.token, symbol: row.symbol ?? "?", name: row.name ?? "", imageUrl: null, priceUsd: row.priceUsd,
    change1hPct: window === "24h" || window === "6h" ? null : row.changePct, change24hPct: window === "24h" || window === "6h" ? row.changePct : null,
    volume24hUsd: row.volumeUsd, liquidityUsd: row.liquidityUsd, marketCapUsd: row.marketCapUsd, pool: row.pool ?? "", dex: row.dex
  }));
}

/** GeckoTerminal shares its 30/min keyless budget with the flow collector, so a 429 serves the last good list. */
export async function trendingTokens(chain: TrendingToken["chain"], window: string) {
  const key = `${chain}:${window}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TRENDING_TTL_MS) return { rows: hit.rows, cachedAt: hit.at, source: "geckoterminal trending_pools" };
  try {
    const body = await fetchJson<GeckoTrending>(`https://api.geckoterminal.com/api/v2/networks/${chain}/trending_pools?include=base_token&duration=${window}`, { headers: { Accept: "application/json" } });
    const rows = normalizeTrending(chain, body);
    cache.set(key, { at: Date.now(), rows });
    return { rows, cachedAt: Date.now(), source: "geckoterminal trending_pools" };
  } catch (error) {
    if (hit) return { rows: hit.rows, cachedAt: hit.at, source: "geckoterminal trending_pools (cached)" };
    if (chain === "monad") return { rows: await monadDiscoverTrending(window), cachedAt: Date.now(), source: "dexscreener discover (fallback)" };
    throw error;
  }
}

export const trendingRouter = Router();
trendingRouter.get("/:chain", async (request, response, next) => {
  try {
    const chain = z.enum(TRENDING_CHAINS).parse(request.params.chain);
    const { window, limit } = querySchema.parse(request.query);
    const { rows, cachedAt, source } = await trendingTokens(chain, window);
    response.json({ chain, window, source, tradable: chain === "monad", observedAt: cachedAt, tokens: rows.slice(0, limit) });
  } catch (error) { next(error); }
});
