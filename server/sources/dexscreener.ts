import type { Chain, PairRow, PairTxns } from "../../shared/wire.js";
import { errorMessage, fetchJson } from "../lib/http.js";

const TOKEN_PAIRS_BASE = "https://api.dexscreener.com/token-pairs/v1";
const CACHE_TTL_MS = 60_000;
const SOURCE = "dexscreener";

type RawTxnWindow = { buys?: unknown; sells?: unknown } | null | undefined;

export type DexScreenerPair = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  priceChange?: { m5?: unknown; h1?: unknown; h6?: unknown; h24?: unknown };
  fdv?: unknown;
  marketCap?: unknown;
  info?: { imageUrl?: string; websites?: Array<{ url?: string; label?: string }>; socials?: Array<{ type?: string; url?: string }> };
  liquidity?: { usd?: unknown };
  volume?: { m5?: unknown; h1?: unknown; h6?: unknown; h24?: unknown };
  txns?: { m5?: RawTxnWindow; h1?: RawTxnWindow; h6?: RawTxnWindow; h24?: RawTxnWindow };
  pairCreatedAt?: number;
};

export type TokenPairsResult = {
  pairs: PairRow[];
  stale: boolean;
  error?: string;
  observedAt: number;
};

type CacheEntry = { pairs: PairRow[]; observedAt: number };

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<TokenPairsResult>>();

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function txnWindow(raw: RawTxnWindow): PairTxns {
  if (!raw) return null;
  const buys = finiteOrNull(raw.buys);
  const sells = finiteOrNull(raw.sells);
  if (buys === null || sells === null) return null;
  return { buys, sells };
}

function sameAddress(chain: Chain, left: string, right: string): boolean {
  if (chain === "monad") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

/** Normalize one DexScreener pair; null when the pair is on another chain or the token is not the base side. */
export function normalizePair(chain: Chain, address: string, raw: DexScreenerPair): PairRow | null {
  if (raw.chainId !== chain) return null;
  const baseMint = String(raw.baseToken?.address || "").trim();
  const pairAddress = String(raw.pairAddress || "").trim();
  if (!baseMint || !pairAddress || !sameAddress(chain, baseMint, address)) return null;
  const quote = String(raw.quoteToken?.address || "").trim();
  return {
    chain,
    dex: String(raw.dexId || "unknown"),
    pairAddress,
    baseMint,
    quoteMint: quote || null,
    liquidityUsd: finiteOrNull(raw.liquidity?.usd),
    volume24Usd: finiteOrNull(raw.volume?.h24),
    share24: null,
    txns: {
      m5: txnWindow(raw.txns?.m5),
      h1: txnWindow(raw.txns?.h1),
      h6: txnWindow(raw.txns?.h6),
      h24: txnWindow(raw.txns?.h24)
    },
    tier: "B",
    sources: [SOURCE]
  };
}

export async function fetchTokenPairs(chain: Chain, address: string): Promise<PairRow[]> {
  const url = `${TOKEN_PAIRS_BASE}/${chain}/${encodeURIComponent(address)}`;
  const body = await fetchJson<unknown>(url, { headers: { Accept: "application/json" } });
  if (!Array.isArray(body)) return [];
  return body
    .map((raw) => normalizePair(chain, address, raw as DexScreenerPair))
    .filter((row): row is PairRow => row !== null);
}

function sumWindow(windows: PairTxns[]): PairTxns {
  const present = windows.filter((window): window is NonNullable<PairTxns> => window !== null);
  if (!present.length) return null;
  return present.reduce((acc, window) => ({ buys: acc.buys + window.buys, sells: acc.sells + window.sells }), {
    buys: 0,
    sells: 0
  });
}

/** Sum buy/sell counts across pairs; a window is null only when every pair has null for it. */
export function sumTxns(pairs: PairRow[]): { m5: PairTxns; h1: PairTxns; h6: PairTxns; h24: PairTxns } {
  return {
    m5: sumWindow(pairs.map((pair) => pair.txns.m5)),
    h1: sumWindow(pairs.map((pair) => pair.txns.h1)),
    h6: sumWindow(pairs.map((pair) => pair.txns.h6)),
    h24: sumWindow(pairs.map((pair) => pair.txns.h24))
  };
}

function cacheKey(chain: Chain, address: string): string {
  return `${chain}:${chain === "monad" ? address.toLowerCase() : address}`;
}

async function refresh(key: string, chain: Chain, address: string, previous?: CacheEntry): Promise<TokenPairsResult> {
  try {
    const pairs = await fetchTokenPairs(chain, address);
    const entry = { pairs, observedAt: Date.now() };
    cache.set(key, entry);
    return { ...entry, stale: false };
  } catch (error) {
    if (!previous) throw error;
    return { pairs: previous.pairs, observedAt: previous.observedAt, stale: true, error: errorMessage(error) };
  }
}

/**
 * Cached token pairs: 60s TTL per (chain,address), in-flight dedupe, last-good retention.
 * Never throws once a value has been cached; throws only when there is nothing to fall back to.
 */
export async function getTokenPairs(chain: Chain, address: string): Promise<TokenPairsResult> {
  const key = cacheKey(chain, address);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.observedAt < CACHE_TTL_MS) return { ...cached, stale: false };
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = refresh(key, chain, address, cached).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

export function resetTokenPairsCache(): void {
  cache.clear();
  inFlight.clear();
  rawCache.clear();
  rawInFlight.clear();
}

// ---- Raw token-pairs (token metadata the normalized PairRow drops: symbol, name, image, socials, priceUsd, change, fdv, mcap) ----

export type RawTokenPairsResult = { pairs: DexScreenerPair[]; stale: boolean; error?: string; observedAt: number };

type RawCacheEntry = { pairs: DexScreenerPair[]; observedAt: number };

const rawCache = new Map<string, RawCacheEntry>();
const rawInFlight = new Map<string, Promise<RawTokenPairsResult>>();

async function refreshRaw(key: string, chain: Chain, address: string, previous?: RawCacheEntry): Promise<RawTokenPairsResult> {
  try {
    const url = `${TOKEN_PAIRS_BASE}/${chain}/${encodeURIComponent(address)}`;
    const body = await fetchJson<unknown>(url, { headers: { Accept: "application/json" } });
    const pairs = Array.isArray(body) ? (body.filter((raw) => raw && typeof raw === "object") as DexScreenerPair[]) : [];
    const entry = { pairs, observedAt: Date.now() };
    rawCache.set(key, entry);
    return { ...entry, stale: false };
  } catch (error) {
    if (!previous) throw error;
    return { pairs: previous.pairs, observedAt: previous.observedAt, stale: true, error: errorMessage(error) };
  }
}

/** The un-normalized DexScreener token-pairs body with the same 60s TTL / in-flight dedupe / last-good contract as getTokenPairs. */
export async function rawTokenPairs(chain: Chain, address: string): Promise<RawTokenPairsResult> {
  const key = cacheKey(chain, address);
  const cached = rawCache.get(key);
  if (cached && Date.now() - cached.observedAt < CACHE_TTL_MS) return { ...cached, stale: false };
  const pending = rawInFlight.get(key);
  if (pending) return pending;
  const request = refreshRaw(key, chain, address, cached).finally(() => rawInFlight.delete(key));
  rawInFlight.set(key, request);
  return request;
}
