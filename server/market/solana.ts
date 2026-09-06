import type { MarketResponse } from "../../shared/wire.js";
import type { OnchainMarket } from "../types.js";
import { record, socialLinks, text, websiteLinks } from "./envelope.js";

/** First ClawPump token_search hit, where symbol/socials/website live when the MCP answered. */
function searchToken(provider: Record<string, unknown>): Record<string, unknown> {
  const tokens = record(provider.token_search).tokens;
  return Array.isArray(tokens) ? record(tokens[0]) : {};
}

const SOCIAL_KEYS = ["twitter", "telegram", "discord"] as const;

/** Socials from an explicit `socials` list or flat twitter/telegram/discord URL fields; empty when the provider has neither. */
function socialsFrom(token: Record<string, unknown>): Array<{ type: string; url: string }> {
  const listed = socialLinks(token.socials);
  if (listed.length) return listed;
  return SOCIAL_KEYS.flatMap((type) => {
    const url = text(token[type]);
    return url ? [{ type, url }] : [];
  });
}

function websitesFrom(token: Record<string, unknown>): string[] {
  const listed = websiteLinks(token.websites);
  if (listed.length) return listed;
  const single = text(token.website);
  return single ? [single] : [];
}

/**
 * Pure mapping of getOnchainMarket's result onto the neutral shape. Numbers, notes, degraded, source and the
 * provider blob pass through untouched so the Solana desk and ClawMap intel behave exactly as before.
 * `signals` is not carried: its only consumer (EvidencePanel) is on the R1 cut list.
 */
export function adaptSolanaMarket(m: OnchainMarket, interval: string): MarketResponse {
  const provider = record(m.provider);
  const token = searchToken(provider);
  return {
    instrument: {
      chain: "solana",
      address: m.mint,
      symbol: m.symbol,
      name: m.name,
      image: text(provider.token_image_url),
      socials: socialsFrom(token),
      websites: websitesFrom(token)
    },
    priceUsd: m.priceUsd,
    marketCapUsd: m.marketCapUsd,
    fdvUsd: m.fdvUsd,
    liquidityUsd: m.liquidityUsd,
    volume24Usd: m.volume24hUsd,
    change24Pct: m.change24hPct,
    primaryPair: m.pairAddress ? { dex: m.dex ?? "unknown", pairAddress: m.pairAddress, quoteSymbol: null } : null,
    candles: m.candles,
    interval,
    observedAt: m.observedAt,
    source: m.source,
    degraded: m.degraded,
    notes: m.notes,
    provider: m.provider
  };
}
