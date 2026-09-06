import type { Chain } from "../../shared/wire.js";
import { fetchJson } from "../lib/http.js";
import { createLastGoodCache } from "../lib/lastGood.js";

const PROFILES_URL = "https://api.dexscreener.com/token-profiles/latest/v1";
const BOOSTS_URL = "https://api.dexscreener.com/token-boosts/latest/v1";
const CACHE_TTL_MS = 60_000;
export const DEXSCREENER_PROFILES_SOURCE = "dexscreener token-profiles";
export const DEXSCREENER_BOOSTS_SOURCE = "dexscreener token-boosts";

export type ProfileLink = { type?: string; label?: string; url: string };

export type TokenProfile = {
  /** null for chains this desk does not model (base, bsc, ...); callers drop those rows. */
  chain: Chain | null;
  /** Lowercased for robinhood, exact for solana. */
  address: string;
  /** Absolute URL, or null. Boost rows carry a bare CDN id here (e.g. "XRUwjpNTfGYdC88o"); that is not a URL and becomes null. */
  icon: string | null;
  description: string | null;
  links: ProfileLink[];
  url: string;
  /** Boost credits on token-boosts rows; null on token-profiles rows. */
  boostTotal: number | null;
};

export type ProfileFeedStatus = { observedAt: number; stale: boolean; error?: string } | null;

type RawProfile = {
  chainId?: unknown;
  tokenAddress?: unknown;
  icon?: unknown;
  description?: unknown;
  links?: unknown;
  url?: unknown;
  totalAmount?: unknown;
};

const feeds = createLastGoodCache<TokenProfile[]>(CACHE_TTL_MS);

function chainOf(chainId: unknown): Chain | null {
  return chainId === "solana" || chainId === "robinhood" ? chainId : null;
}

function normalizeAddress(chain: Chain | null, address: string): string {
  return chain === "robinhood" ? address.toLowerCase() : address;
}

function absoluteUrlOrNull(value: unknown): string | null {
  return typeof value === "string" && /^https?:\/\//i.test(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLinks(raw: unknown): ProfileLink[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { type, label, url } = entry as { type?: unknown; label?: unknown; url?: unknown };
    if (typeof url !== "string" || !url) return [];
    return [
      {
        ...(typeof type === "string" && type ? { type } : {}),
        ...(typeof label === "string" && label ? { label } : {}),
        url
      }
    ];
  });
}

/** One profile/boost row; null when it has no token address or page URL. */
export function normalizeProfile(raw: unknown): TokenProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as RawProfile;
  const address = typeof row.tokenAddress === "string" ? row.tokenAddress.trim() : "";
  const url = typeof row.url === "string" ? row.url.trim() : "";
  if (!address || !url) return null;
  const chain = chainOf(row.chainId);
  return {
    chain,
    address: normalizeAddress(chain, address),
    icon: absoluteUrlOrNull(row.icon),
    description: textOrNull(row.description),
    links: normalizeLinks(row.links),
    url,
    boostTotal: finiteOrNull(row.totalAmount)
  };
}

async function loadFeed(url: string): Promise<TokenProfile[]> {
  const body = await fetchJson<unknown>(url, { headers: { Accept: "application/json" } });
  if (!Array.isArray(body)) return [];
  return body.map(normalizeProfile).filter((row): row is TokenProfile => row !== null);
}

/**
 * Latest DexScreener token profiles (keyless; 16 to 21 of the newest 30 were robinhood when measured). 60s TTL, last-good on
 * failure; throws only before the first success. Rows with `chain: null` are other chains and are the caller's to drop.
 */
export async function fetchLatestProfiles(): Promise<TokenProfile[]> {
  return (await feeds.get(PROFILES_URL, () => loadFeed(PROFILES_URL))).value;
}

/** Latest DexScreener token boosts, same shape and cache contract as fetchLatestProfiles; `boostTotal` is populated. */
export async function fetchLatestBoosts(): Promise<TokenProfile[]> {
  return (await feeds.get(BOOSTS_URL, () => loadFeed(BOOSTS_URL))).value;
}

/** Freshness of the last profiles fetch (observedAt / stale / error) or null before any success. */
export function latestProfilesStatus(): ProfileFeedStatus {
  return feedStatus(PROFILES_URL);
}

export function latestBoostsStatus(): ProfileFeedStatus {
  return feedStatus(BOOSTS_URL);
}

function feedStatus(url: string): ProfileFeedStatus {
  const entry = feeds.peek(url);
  return entry ? { observedAt: entry.observedAt, stale: entry.stale } : null;
}

export function resetProfilesCache(): void {
  feeds.reset();
}
