import type { Chain } from "../../shared/wire";
import { MINT_RE, extractSolanaMint } from "./mint";

/** The desk's one instrument: chain is a property of the token, not a mode of the desk. */
export type InstrumentRef = { chain: Chain; address: string };
export type AddressExtract = InstrumentRef | { error: string };

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX64_RE = /^0x[a-fA-F0-9]{64}$/;
const POOL_ERROR = "paste the token address, not the pool";
const URL_HINT_RE = /[./]|(?:dexscreener|geckoterminal|blockscout|robinscan)/i;

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

function robinhood(address: string): InstrumentRef {
  return { chain: "robinhood", address: address.toLowerCase() };
}

/** 0x40 → token; 0x64 (Uniswap v4 poolId) → error; anything else → null. */
function robinhoodToken(segment: string | undefined): AddressExtract | null {
  const value = cleanSegment(segment);
  if (EVM_RE.test(value)) return robinhood(value);
  if (HEX64_RE.test(value)) return { error: POOL_ERROR };
  return null;
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function robinhoodFromUrl(url: URL): AddressExtract | null {
  const host = url.hostname.toLowerCase();
  const [first, second, third] = url.pathname.split("/").filter(Boolean);
  if (hostMatches(host, "dexscreener.com") && first === "robinhood") return robinhoodToken(second);
  if (hostMatches(host, "geckoterminal.com") && first === "robinhood") {
    if (second === "pools") return { error: POOL_ERROR };
    if (second === "tokens") return robinhoodToken(third);
    return null;
  }
  const isExplorer = host === "robinhoodchain.blockscout.com" || hostMatches(host, "robinscan.io");
  if (isExplorer && first === "token") return robinhoodToken(second);
  return null;
}

/**
 * Paste any CA or URL → { chain, address }. Solana pair addresses (dexscreener.com/solana/<pair>) are
 * returned as given for the server to resolve. Returns null when nothing address-shaped is present so
 * the caller can fall through to ticker search.
 */
export function extractAddress(text: string): AddressExtract | null {
  const cleaned = stripQuotes(text);
  if (!cleaned) return null;
  if (EVM_RE.test(cleaned)) return robinhood(cleaned);
  if (MINT_RE.test(cleaned)) return { chain: "solana", address: cleaned };
  const url = parseUrl(cleaned);
  if (url) {
    const fromRobinhood = robinhoodFromUrl(url);
    if (fromRobinhood) return fromRobinhood;
  }
  const solana = extractSolanaMint(cleaned);
  if (solana && "mint" in solana) return { chain: "solana", address: solana.mint };
  return null;
}
