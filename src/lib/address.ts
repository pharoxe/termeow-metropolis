import type { Chain } from "../../shared/wire";

/** The desk's one instrument: chain is a property of the token, not a mode of the desk. */
export type InstrumentRef = { chain: Chain; address: string };
export type AddressExtract = InstrumentRef | { error: string };

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX64_RE = /^0x[a-fA-F0-9]{64}$/;
const POOL_ERROR = "paste the token address, not the pool";
const URL_HINT_RE = /[./]|(?:dexscreener|geckoterminal|monadvision|monadscan|nad\.fun|kuru)/i;
/** A bare 0x address anywhere in pasted text (a tweet, a link we do not know). */
const EMBEDDED_EVM_RE = /0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/;

export function isEvmAddress(text: string): boolean {
  return EVM_RE.test(text.trim());
}

function stripQuotes(text: string): string {
  return text.trim().replace(/^['"`]+/, "").replace(/['"`]+$/, "").trim();
}

function cleanSegment(segment: string | undefined): string {
  let value = (segment ?? "").trim();
  try { value = decodeURIComponent(value); } catch { /* keep raw */ }
  return value.split("?")[0].split("#")[0].replace(/\/+$/, "");
}

function parseUrl(text: string): URL | null {
  if (!URL_HINT_RE.test(text)) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

function monad(address: string): InstrumentRef {
  return { chain: "monad", address: address.toLowerCase() };
}

/** 0x40 → token; 0x64 (Uniswap v4 poolId) → error; anything else → null. */
function monadToken(segment: string | undefined): AddressExtract | null {
  const value = cleanSegment(segment);
  if (EVM_RE.test(value)) return monad(value);
  if (HEX64_RE.test(value)) return { error: POOL_ERROR };
  return null;
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** DexScreener, GeckoTerminal, MonadVision / Monadscan, nad.fun token links → the token. */
function monadFromUrl(url: URL): AddressExtract | null {
  const host = url.hostname.toLowerCase();
  const [first, second, third] = url.pathname.split("/").filter(Boolean);
  if (hostMatches(host, "dexscreener.com") && first === "monad") return monadToken(second);
  if (hostMatches(host, "geckoterminal.com") && first === "monad") {
    if (second === "pools") return { error: POOL_ERROR };
    if (second === "tokens") return monadToken(third);
    return null;
  }
  const isExplorer = hostMatches(host, "monadvision.com") || hostMatches(host, "monadscan.com");
  if (isExplorer && (first === "token" || first === "address")) return monadToken(second);
  if (hostMatches(host, "nad.fun") && (first === "tokens" || first === "token")) return monadToken(second);
  return null;
}

/**
 * Paste any CA or URL → { chain: "monad", address }. Returns null when nothing address-shaped is present so the caller
 * can fall through to ticker search.
 */
export function extractAddress(text: string): AddressExtract | null {
  const cleaned = stripQuotes(text);
  if (!cleaned) return null;
  if (EVM_RE.test(cleaned)) return monad(cleaned);
  const url = parseUrl(cleaned);
  if (url) {
    const fromMonad = monadFromUrl(url);
    if (fromMonad) return fromMonad;
  }
  const embedded = cleaned.match(EMBEDDED_EVM_RE)?.[0];
  return embedded ? monad(embedded) : null;
}
