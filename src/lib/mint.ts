export const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[a-fA-F0-9]{40}$/;

export type MintExtract = { mint: string } | { error: string };

function stripQuotes(text: string) {
  return text.trim().replace(/^['"`]+/, "").replace(/['"`]+$/, "").trim();
}

function mintFromSegment(segment: string): string | null {
  let value = segment.trim();
  try { value = decodeURIComponent(value); } catch { /* keep raw */ }
  value = value.split("?")[0].split("#")[0].replace(/\/+$/, "");
  if (MINT_RE.test(value)) return value;
  const tail = value.split("_").pop() || "";
  if (tail !== value && MINT_RE.test(tail)) return tail;
  return null;
}

function evmFromSegment(segment: string): boolean {
  let value = segment.trim();
  try { value = decodeURIComponent(value); } catch { /* keep raw */ }
  value = value.split("?")[0].split("#")[0];
  return EVM_RE.test(value);
}

function extractFromUrl(text: string): MintExtract | null {
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  for (const key of ["mint", "token", "address", "ca", "contract", "tokenAddress", "token_address"]) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    if (evmFromSegment(value)) return { error: "Solana mint only" };
    const mint = mintFromSegment(value);
    if (mint) return { mint };
  }
  const segments = url.pathname.split("/").filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (evmFromSegment(segments[index])) return { error: "Solana mint only" };
    const mint = mintFromSegment(segments[index]);
    if (mint) return { mint };
  }
  return null;
}

export function extractSolanaMint(text: string): MintExtract | null {
  const cleaned = stripQuotes(text);
  if (!cleaned) return null;
  if (EVM_RE.test(cleaned) || /^0x[a-fA-F0-9]{40}\b/.test(cleaned)) {
    return { error: "Solana mint only" };
  }
  const scheme = cleaned.match(/^solana:\/?\/?([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (scheme && MINT_RE.test(scheme[1])) return { mint: scheme[1] };
  if (/[./]/.test(cleaned) || /(?:dexscreener|pump\.fun|birdeye|geckoterminal|axiom\.trade|photon|gmgn)/i.test(cleaned)) {
    const fromUrl = extractFromUrl(cleaned);
    if (fromUrl) return fromUrl;
  }
  if (MINT_RE.test(cleaned)) return { mint: cleaned };
  return null;
}
