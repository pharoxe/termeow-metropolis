import { config } from "../config.js";
import { errorMessage, fetchJson } from "../lib/http.js";

/**
 * nad.fun REST (github.com/Naddotfun/api-intergration): token metadata and curve/DEX market state for one token. Used by
 * the agent's research tools; launches themselves come from CurveCreate logs (launch/monad), not from this API, because
 * it has no new-token list. Keyless calls are limited to 10/min, so answers are cached for a minute.
 */
export const NADFUN_SOURCE = "nad.fun";

export type NadfunMarket = {
  token: string;
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  creator: string | null;
  /** CURVE while on the bonding curve, DEX after graduation (V2_ variants for the v2 contracts). */
  marketType: string | null;
  priceMon: number | null;
  priceUsd: number | null;
  holders: number | null;
  volume: number | null;
  reserveMon: number | null;
  url: string;
};

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

/** Some responses wrap the payload ({ token_info }, { market_info }); read the first object that carries fields. */
function unwrap(body: unknown, keys: string[]): Json {
  const root = record(body);
  for (const key of keys) if (root[key] && typeof root[key] === "object") return record(root[key]);
  return root;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseNadfun(token: string, tokenBody: unknown, marketBody: unknown): NadfunMarket {
  const info = unwrap(tokenBody, ["token_info", "token", "data"]);
  const market = unwrap(marketBody, ["market_info", "market", "data"]);
  return {
    token: token.toLowerCase(),
    name: text(info.name),
    symbol: text(info.symbol),
    imageUrl: text(info.image_uri) ?? text(info.image_url) ?? text(info.image),
    creator: text(record(info.creator).account_id) ?? text(info.creator),
    marketType: text(market.market_type),
    priceMon: num(market.price),
    priceUsd: num(market.price_usd),
    holders: num(market.holder_count),
    volume: num(market.volume),
    reserveMon: num(market.reserve_quote),
    url: `https://nad.fun/tokens/${token}`
  };
}

const cache = new Map<string, { at: number; value: NadfunMarket }>();

export async function nadfunToken(token: string, fetchImpl: typeof fetchJson = fetchJson): Promise<{ source: string; observedAt: number; market: NadfunMarket | null; error: string | null }> {
  const key = token.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return { source: NADFUN_SOURCE, observedAt: hit.at, market: hit.value, error: null };
  const headers: Record<string, string> = { Accept: "application/json", ...(config.nadfun.apiKey ? { "X-API-Key": config.nadfun.apiKey } : {}) };
  try {
    const [tokenBody, marketBody] = await Promise.all([
      fetchImpl<unknown>(`${config.nadfun.apiUrl}/token/${key}`, { headers }),
      fetchImpl<unknown>(`${config.nadfun.apiUrl}/trade/market/${key}`, { headers }).catch(() => null)
    ]);
    const market = parseNadfun(key, tokenBody, marketBody);
    cache.set(key, { at: Date.now(), value: market });
    while (cache.size > 200) cache.delete(cache.keys().next().value!);
    return { source: NADFUN_SOURCE, observedAt: Date.now(), market, error: null };
  } catch (error) {
    return { source: NADFUN_SOURCE, observedAt: Date.now(), market: hit?.value ?? null, error: errorMessage(error) };
  }
}
