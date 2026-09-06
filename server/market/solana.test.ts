import { describe, expect, it } from "vitest";
import type { OnchainMarket } from "../types.js";
import { adaptSolanaMarket } from "./solana.js";

const MINT = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const POOL = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";

function onchain(overrides: Partial<OnchainMarket> = {}): OnchainMarket {
  return {
    instrumentId: `solana:${MINT}:spot`,
    mint: MINT,
    symbol: "ANSEM",
    name: "Ansem Coin",
    quoteSymbol: "USD",
    priceUsd: 0.0123,
    change24hPct: -4.2,
    volume24hUsd: 120_000,
    liquidityUsd: 45_000,
    marketCapUsd: 12_300_000,
    fdvUsd: 12_300_000,
    pairAddress: POOL,
    dex: "raydium",
    observedAt: 1_788_700_000_000,
    source: "ClawPump + on-chain fallback",
    degraded: false,
    notes: ["intelligence_market: timeout"],
    provider: {
      token_image_url: "https://img/ansem.png",
      token_search: { tokens: [{ symbol: "ANSEM", twitter: "https://x.com/ansem", website: "https://ansem.example" }] },
      intelligence_market: { holders: 1200 }
    },
    candles: [{ time: 1_788_699_700_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
    signals: [{ label: "5M", value: "1.00%", tone: "positive" }],
    ...overrides
  };
}

describe("adaptSolanaMarket", () => {
  it("maps numbers, pair, candles, notes and provider one-to-one and reads image/socials/website from the provider", () => {
    const m = onchain();
    const market = adaptSolanaMarket(m, "5m");
    expect(market).toEqual({
      instrument: {
        chain: "solana",
        address: MINT,
        symbol: "ANSEM",
        name: "Ansem Coin",
        image: "https://img/ansem.png",
        socials: [{ type: "twitter", url: "https://x.com/ansem" }],
        websites: ["https://ansem.example"]
      },
      priceUsd: 0.0123,
      marketCapUsd: 12_300_000,
      fdvUsd: 12_300_000,
      liquidityUsd: 45_000,
      volume24Usd: 120_000,
      change24Pct: -4.2,
      primaryPair: { dex: "raydium", pairAddress: POOL, quoteSymbol: null },
      candles: m.candles,
      interval: "5m",
      observedAt: 1_788_700_000_000,
      source: "ClawPump + on-chain fallback",
      degraded: false,
      notes: ["intelligence_market: timeout"],
      provider: m.provider
    });
    expect(market.candles).toBe(m.candles);
    expect(market.provider).toBe(m.provider);
  });

  it("prefers an explicit socials list on the search token and keeps nulls null", () => {
    const market = adaptSolanaMarket(onchain({
      priceUsd: null,
      pairAddress: null,
      dex: null,
      degraded: true,
      provider: { token_search: { tokens: [{ socials: [{ type: "telegram", url: "https://t.me/x" }, { type: "", url: "bad" }], twitter: "https://x.com/ignored" }] } }
    }), "1h");
    expect(market.instrument).toMatchObject({ image: null, socials: [{ type: "telegram", url: "https://t.me/x" }], websites: [] });
    expect(market.priceUsd).toBeNull();
    expect(market.primaryPair).toBeNull();
    expect(market.degraded).toBe(true);
    expect(market.interval).toBe("1h");
  });

  it("falls back to dex 'unknown' when a pair address has no dex and tolerates a non-object provider", () => {
    const market = adaptSolanaMarket(onchain({ dex: null, provider: null }), "5m");
    expect(market.primaryPair).toEqual({ dex: "unknown", pairAddress: POOL, quoteSymbol: null });
    expect(market.instrument).toMatchObject({ image: null, socials: [], websites: [] });
    expect(market.provider).toBeNull();
  });
});
