import type { Chain, DiscoverWindow, PairTxns } from "../../shared/wire.js";
import { createLastGoodCache, type LastGood } from "../lib/lastGood.js";
import { geckoGet } from "../sources/gecko.js";
import type { DiscoverPartial } from "./merge.js";

export type GeckoListKind = "trending" | "new";
export const GECKO_TRENDING_SOURCE = "geckoterminal trending_pools";
export const GECKO_NEW_SOURCE = "geckoterminal new_pools";
/** One list fetch per 60 s per kind; both lists together cost at most 2 of the shared 25/min bucket, on the low class. */
export const GECKO_LIST_TTL_MS = 60_000;

type GeckoWindowKey = "h1" | "h24";
const WINDOW_KEY: Record<DiscoverWindow, GeckoWindowKey> = { "1h": "h1", "24h": "h24" };

type RawTxn = { buys?: unknown; sells?: unknown } | null | undefined;
type RawAttributes = {
  address?: unknown;
  name?: unknown;
  base_token_price_usd?: unknown;
  fdv_usd?: unknown;
  market_cap_usd?: unknown;
  reserve_in_usd?: unknown;
  pool_created_at?: unknown;
  volume_usd?: Partial<Record<GeckoWindowKey, unknown>>;
  price_change_percentage?: Partial<Record<GeckoWindowKey, unknown>>;
  transactions?: Partial<Record<GeckoWindowKey, RawTxn>>;
};
export type GeckoListRow = {
  attributes?: RawAttributes;
  relationships?: { base_token?: { data?: { id?: unknown } }; dex?: { data?: { id?: unknown } } };
};

const cache = createLastGoodCache<GeckoListRow[]>(GECKO_LIST_TTL_MS);

export function geckoListSource(kind: GeckoListKind): string {
  return kind === "trending" ? GECKO_TRENDING_SOURCE : GECKO_NEW_SOURCE;
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function txns(raw: RawTxn): PairTxns {
  if (!raw) return null;
  const buys = finiteOrNull(raw.buys);
  const sells = finiteOrNull(raw.sells);
  return buys === null || sells === null ? null : { buys, sells };
}

/** Relationship ids read "<network>_<address>"; the address is whatever follows the first underscore. */
export function tokenFromRelationshipId(id: unknown, network: Chain): string | null {
  if (typeof id !== "string") return null;
  const prefix = `${network}_`;
  if (!id.startsWith(prefix)) return null;
  const raw = id.slice(prefix.length).trim();
  if(network === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw) ? raw : null;
  const address=raw.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(address) ? address : null;
}

/** Pool names read "BASE / QUOTE"; the base symbol is the part before the separator. Null when the name has no separator. */
export function baseSymbolFromPoolName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const separator = name.indexOf(" / ");
  if (separator <= 0) return null;
  const symbol = name.slice(0, separator).trim();
  return symbol ? symbol : null;
}

/**
 * One trending/new pool row as this token's partial for `window`. Gecko's list order is the source's ranking, kept as
 * `rank`. market_cap_usd is often null on new pools and is NOT replaced by fdv_usd: they are different figures.
 */
export function normalizeGeckoListRow(row: GeckoListRow, index: number, kind: GeckoListKind, window: DiscoverWindow, network: Chain, now: number, lastOkAt: number | null, stale: boolean): DiscoverPartial | null {
  const attrs = row.attributes ?? {};
  const token = tokenFromRelationshipId(row.relationships?.base_token?.data?.id, network);
  if (!token) return null;
  const key = WINDOW_KEY[window];
  const createdAt = Date.parse(String(attrs.pool_created_at ?? ""));
  const pool = typeof attrs.address === "string" && attrs.address.trim() ? (network === "solana" ? attrs.address.trim() : attrs.address.trim().toLowerCase()) : null;
  const dex = row.relationships?.dex?.data?.id;
  return {
    token,
    source: geckoListSource(kind),
    lastOkAt,
    stale,
    rank: index,
    symbol: baseSymbolFromPoolName(attrs.name),
    name: null,
    priceUsd: finiteOrNull(attrs.base_token_price_usd),
    marketCapUsd: finiteOrNull(attrs.market_cap_usd),
    liquidityUsd: finiteOrNull(attrs.reserve_in_usd),
    volumeUsd: finiteOrNull(attrs.volume_usd?.[key]),
    changePct: finiteOrNull(attrs.price_change_percentage?.[key]),
    txns: txns(attrs.transactions?.[key]),
    ageMs: Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : null,
    pool,
    dex: typeof dex === "string" && dex ? dex : null,
    fomoHolders: null,
    trackedBuyers: null
  };
}

async function loadList(network: Chain, kind: GeckoListKind): Promise<GeckoListRow[]> {
  const body = await geckoGet<{ data?: unknown }>(`/networks/${network}/${kind}_pools?page=1`, { priority: "low" });
  return Array.isArray(body.data) ? (body.data as GeckoListRow[]) : [];
}

/**
 * GeckoTerminal trending_pools / new_pools for `network` through the shared low-priority bucket, 60 s TTL and last-good
 * per kind. Throws only before the first success for that kind.
 */
export function fetchGeckoList(network: Chain, kind: GeckoListKind): Promise<LastGood<GeckoListRow[]>> {
  return cache.get(`${network}:${kind}`, () => loadList(network, kind));
}

export function resetGeckoListCache(): void {
  cache.reset();
}
