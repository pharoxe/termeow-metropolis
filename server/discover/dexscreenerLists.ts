import type { Chain, DiscoverWindow, PairTxns } from "../../shared/wire.js";
import type { LastGood } from "../lib/lastGood.js";
import type { DexScreenerPair } from "../sources/dexscreener.js";
import { fetchLatestBoosts, fetchLatestProfiles, type TokenProfile } from "../sources/dexscreenerProfiles.js";
import { bestPairsOf, fetchBestPairs } from "../sources/dexscreenerTokens.js";
import type { DiscoverPartial } from "./merge.js";

/**
 * DexScreener side of discovery: the profile and boost feeds name the tokens, sources/dexscreenerTokens fetches their
 * best pair (one /tokens/v1 call per 30 addresses, 60 s per-address cache, last-good on failure) shared with the
 * launch index's enrichment, so the same tokens are never asked for twice a minute. Nothing here fetches.
 */
export const DEXSCREENER_DISCOVERY_SOURCE = "dexscreener profiles+boosts · tokens/v1";
/** DexScreener's per-call address ceiling; profiles ∪ boosts measured 27 monad tokens, so one call covers the lists. */
export const DEXSCREENER_LIST_MAX = 30;

type WindowKey = "h1" | "h24";
const WINDOW_KEY: Record<DiscoverWindow, WindowKey> = { "1h": "h1", "24h": "h24" };

/** The addresses the feeds named and every pair DexScreener returned for them (best pair per token chosen at read). */
export type DexScreenerListLoad = { requested: string[]; pairs: DexScreenerPair[] };
export type ProfileFeeds = { profiles: () => Promise<TokenProfile[]>; boosts: () => Promise<TokenProfile[]> };

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function txns(raw: { buys?: unknown; sells?: unknown } | null | undefined): PairTxns {
  if (!raw) return null;
  const buys = finiteOrNull(raw.buys);
  const sells = finiteOrNull(raw.sells);
  return buys === null || sells === null ? null : { buys, sells };
}

/** Distinct lowercased monad addresses across both feeds, profiles first (newest first), capped to one call. */
export function discoveryAddresses(chain: Chain, profiles: readonly TokenProfile[], boosts: readonly TokenProfile[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const profile of [...profiles, ...boosts]) {
    if (profile.chain !== chain) continue;
    const address = profile.address.toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    out.push(address);
    if (out.length >= DEXSCREENER_LIST_MAX) break;
  }
  return out;
}

/** One best pair as the token's partial for `window`. marketCap is not backfilled from fdv: they differ on tokens with locked supply. */
export function normalizeDexScreenerPair(token: string, pair: DexScreenerPair, window: DiscoverWindow, now: number, lastOkAt: number | null, stale: boolean, chain: Chain = "monad"): DiscoverPartial {
  const key = WINDOW_KEY[window];
  const createdAt = finiteOrNull(pair.pairCreatedAt);
  const symbol = String(pair.baseToken?.symbol ?? "").trim();
  const name = String(pair.baseToken?.name ?? "").trim();
  const pool = String(pair.pairAddress ?? "").trim();
  return {
    token: token.toLowerCase(),
    source: DEXSCREENER_DISCOVERY_SOURCE,
    lastOkAt,
    stale,
    rank: null,
    symbol: symbol || null,
    name: name || null,
    priceUsd: finiteOrNull(pair.priceUsd),
    marketCapUsd: finiteOrNull(pair.marketCap),
    liquidityUsd: finiteOrNull(pair.liquidity?.usd),
    volumeUsd: finiteOrNull(pair.volume?.[key]),
    changePct: finiteOrNull(pair.priceChange?.[key]),
    txns: txns(pair.txns?.[key]),
    ageMs: createdAt === null ? null : Math.max(0, now - createdAt),
    pool: pool ? pool.toLowerCase() : null,
    dex: pair.dexId ? String(pair.dexId) : null,
    smartHolders: null,
    trackedBuyers: null
  };
}

/**
 * Partials for every requested address DexScreener listed (highest-liquidity pair per token, the same rule the launch
 * enrichment applies). Addresses on the profile/boost feeds with no pair yet (curve phase) are absent: the feeds carry
 * no symbol, price or volume, so there is nothing honest to show for them.
 */
export function dexScreenerListPartials(chain: Chain, load: DexScreenerListLoad, window: DiscoverWindow, now: number, lastOkAt: number | null, stale: boolean): DiscoverPartial[] {
  const best = bestPairsOf(chain, load.requested, load.pairs);
  return [...best.entries()].map(([token, pair]) => normalizeDexScreenerPair(token, pair, window, now, lastOkAt, stale, chain));
}

/**
 * profiles ∪ boosts for `chain` (both already cached 60 s by sources/dexscreenerProfiles) enriched through the shared
 * token-batch fetcher. `stale`/`error` say when the pairs are last-good rather than fresh; throws only when the feeds
 * fail or nothing at all is cached for the addresses.
 */
export async function fetchDexScreenerList(chain: Chain, feeds: ProfileFeeds = { profiles: fetchLatestProfiles, boosts: fetchLatestBoosts }): Promise<LastGood<DexScreenerListLoad>> {
  const [profiles, boosts] = await Promise.all([feeds.profiles(), feeds.boosts()]);
  const requested = discoveryAddresses(chain, profiles, boosts);
  if (!requested.length) return { value: { requested, pairs: [] }, observedAt: Date.now(), stale: false };
  const batch = await fetchBestPairs(chain, requested);
  return { value: { requested, pairs: [...batch.pairs.values()] }, observedAt: batch.observedAt, stale: batch.stale, ...(batch.error ? { error: batch.error } : {}) };
}
