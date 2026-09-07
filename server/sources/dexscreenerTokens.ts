import type { Chain } from "../../shared/wire.js";
import { fetchJson } from "../lib/http.js";
import type { DexScreenerPair } from "./dexscreener.js";

const TOKENS_BASE = "https://api.dexscreener.com/tokens/v1";
const CACHE_TTL_MS = 60_000;
/** DexScreener's per-call ceiling for /tokens/v1. */
export const TOKEN_BATCH_MAX = 30;

export type TokenBatchRow = {
  symbol: string;
  name: string;
  image: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  volume24Usd: number | null;
  change24Pct: number | null;
  pairAddress: string;
  dex: string;
  pairCreatedAt: number | null;
};

/** Keyed by `address.toLowerCase()`; addresses with no listed pair are absent. */
export type TokenBatch = Map<string, TokenBatchRow>;
/** The raw best pair per listed address (R6 discovery reads h1 fields the row omits) with the cache's provenance. */
export type BestPairs = { pairs: Map<string, DexScreenerPair>; observedAt: number; stale: boolean; error: string | null };

/** null = fetched, no pair listed (curve-phase or unlisted) — cached so unlisted tokens are not re-asked every call. */
type CacheEntry = { pair: DexScreenerPair | null; row: TokenBatchRow | null; observedAt: number };

const cache = new Map<string, CacheEntry>();
const now = () => Date.now();

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cacheKey(chain: Chain, address: string): string {
  return `${chain}:${address.toLowerCase()}`;
}

function rowFromPair(pair: DexScreenerPair): TokenBatchRow | null {
  const pairAddress = String(pair.pairAddress || "").trim();
  if (!pairAddress) return null;
  return {
    symbol: String(pair.baseToken?.symbol || ""),
    name: String(pair.baseToken?.name || ""),
    image: typeof pair.info?.imageUrl === "string" && pair.info.imageUrl ? pair.info.imageUrl : null,
    priceUsd: finiteOrNull(pair.priceUsd),
    marketCapUsd: finiteOrNull(pair.marketCap),
    fdvUsd: finiteOrNull(pair.fdv),
    liquidityUsd: finiteOrNull(pair.liquidity?.usd),
    volume24Usd: finiteOrNull(pair.volume?.h24),
    change24Pct: finiteOrNull(pair.priceChange?.h24),
    pairAddress,
    dex: String(pair.dexId || "unknown"),
    pairCreatedAt: finiteOrNull(pair.pairCreatedAt)
  };
}

/** Higher liquidity wins; a pair with unknown liquidity loses to any known figure; ties keep the earlier pair. */
function betterPair(current: DexScreenerPair | undefined, candidate: DexScreenerPair): DexScreenerPair {
  if (!current) return candidate;
  const currentLiq = finiteOrNull(current.liquidity?.usd) ?? -1;
  const candidateLiq = finiteOrNull(candidate.liquidity?.usd) ?? -1;
  return candidateLiq > currentLiq ? candidate : current;
}

/** Groups a pair-array body (/tokens/v1, or /latest/dex/tokens' `pairs`) by base token; highest-liquidity pair per requested address. */
export function bestPairsOf(chain: Chain, addresses: readonly string[], body: unknown): Map<string, DexScreenerPair> {
  const wanted = new Set(addresses.map((address) => address.toLowerCase()));
  const best = new Map<string, DexScreenerPair>();
  for (const raw of Array.isArray(body) ? body : []) {
    if (!raw || typeof raw !== "object") continue;
    const pair = raw as DexScreenerPair;
    const base = String(pair.baseToken?.address || "").toLowerCase();
    if (pair.chainId !== chain || !base || !wanted.has(base)) continue;
    best.set(base, betterPair(best.get(base), pair));
  }
  return best;
}

/** Groups a /tokens/v1 body by base token and keeps the highest-liquidity pair per requested address, as rows. */
export function pickBestPairs(chain: Chain, addresses: string[], body: unknown): TokenBatch {
  const rows: TokenBatch = new Map();
  for (const [address, pair] of bestPairsOf(chain, addresses, body)) {
    const row = rowFromPair(pair);
    if (row) rows.set(address, row);
  }
  return rows;
}

/** Dedupes (case-insensitively, first spelling kept) and splits into groups of at most `size`. */
export function chunkAddresses(addresses: string[], size = TOKEN_BATCH_MAX): string[][] {
  const seen = new Set<string>();
  const unique = addresses.filter((address) => {
    const key = address.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const chunks: string[][] = [];
  for (let start = 0; start < unique.length; start += size) chunks.push(unique.slice(start, start + size));
  return chunks;
}

function fresh(entry: CacheEntry | undefined): entry is CacheEntry {
  return entry !== undefined && now() - entry.observedAt < CACHE_TTL_MS;
}

type Entries = Map<string, CacheEntry>;

function collectCached(chain: Chain, addresses: string[], onlyFresh: boolean): { entries: Entries; missing: string[] } {
  const entries: Entries = new Map();
  const missing: string[] = [];
  for (const address of addresses) {
    const entry = cache.get(cacheKey(chain, address));
    if (entry && (!onlyFresh || fresh(entry))) entries.set(address.toLowerCase(), entry);
    else missing.push(address);
  }
  return { entries, missing };
}

async function loadBatch(chain: Chain, addresses: string[]): Promise<Entries> {
  const url = `${TOKENS_BASE}/${chain}/${addresses.map((address) => encodeURIComponent(address)).join(",")}`;
  const body = await fetchJson<unknown>(url, { headers: { Accept: "application/json" } });
  const best = bestPairsOf(chain, addresses, body);
  const observedAt = now();
  const entries: Entries = new Map();
  for (const address of addresses) {
    const pair = best.get(address.toLowerCase()) ?? null;
    const entry: CacheEntry = { pair, row: pair ? rowFromPair(pair) : null, observedAt };
    cache.set(cacheKey(chain, address), entry);
    entries.set(address.toLowerCase(), entry);
  }
  return entries;
}

/**
 * Cache entries for up to 30 addresses in one DexScreener call, 60s TTL per address; only addresses not fresh in the cache
 * are asked for. On upstream failure returns whatever last-good entries exist for the missing addresses (stale, with the
 * error) and rethrows only when there is nothing cached for any of them.
 */
async function fetchEntries(chain: Chain, addresses: string[]): Promise<{ entries: Entries; stale: boolean; error: string | null }> {
  const unique = chunkAddresses(addresses)[0] ?? [];
  if (chunkAddresses(addresses).length > 1) throw new Error(`fetchTokenBatch: at most ${TOKEN_BATCH_MAX} addresses per call`);
  const { entries, missing } = collectCached(chain, unique, true);
  if (!missing.length) return { entries, stale: false, error: null };
  try {
    const loaded = await loadBatch(chain, missing);
    return { entries: new Map([...entries, ...loaded]), stale: false, error: null };
  } catch (error) {
    const lastGood = collectCached(chain, missing, false);
    if (lastGood.missing.length === missing.length && !entries.size) throw error;
    return { entries: new Map([...entries, ...lastGood.entries]), stale: true, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Best pair per token for up to 30 addresses (see fetchEntries): rows only, addresses with no listed pair absent. */
export async function fetchTokenBatch(chain: Chain, addresses: string[]): Promise<TokenBatch> {
  const { entries } = await fetchEntries(chain, addresses);
  const rows: TokenBatch = new Map();
  for (const [address, entry] of entries) if (entry.row) rows.set(address, entry.row);
  return rows;
}

/** Same call and cache as fetchTokenBatch, handing back the raw best pairs with the oldest observedAt among them. */
export async function fetchBestPairs(chain: Chain, addresses: string[]): Promise<BestPairs> {
  const { entries, stale, error } = await fetchEntries(chain, addresses);
  const pairs = new Map<string, DexScreenerPair>();
  let observedAt = now();
  for (const [address, entry] of entries) {
    observedAt = Math.min(observedAt, entry.observedAt);
    if (entry.pair) pairs.set(address, entry.pair);
  }
  return { pairs, observedAt, stale, error };
}

/** Any number of addresses, fetched in calls of at most 30; a failed chunk contributes nothing rather than failing the whole. */
export async function fetchTokenBatches(chain: Chain, addresses: string[]): Promise<TokenBatch> {
  const results = await Promise.allSettled(chunkAddresses(addresses).map((chunk) => fetchTokenBatch(chain, chunk)));
  const merged: TokenBatch = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const [address, row] of result.value) merged.set(address, row);
  }
  return merged;
}

export function resetTokenBatchCache(): void {
  cache.clear();
}
