import { describe, expect, it } from "vitest";
import type { CandleSourceInfo, MarketResponse } from "../../shared/wire.js";
import { lastGoodOverEmpty, marketCacheTtlMs } from "./marketCachePolicy.js";

const TTL = 45_000;
const SHORT = 5_000;

function market(overrides: Partial<MarketResponse> = {}): MarketResponse {
  return {
    instrument: { chain: "monad", address: "0xtoken", symbol: "T", name: "T", image: null, socials: [], websites: [] },
    priceUsd: 1, marketCapUsd: null, fdvUsd: null, liquidityUsd: null, volume24Usd: null, change24Pct: null,
    primaryPair: null, candles: [], interval: "1m", observedAt: 0, source: "geckoterminal", degraded: false, notes: [],
    ...overrides
  };
}

function chainSource(backfilling: boolean): CandleSourceInfo {
  return { kind: "chain swaps", backfilledFrom: null, coverage: { fromMs: null, toMs: null, bars: 1, prints: 1, complete: !backfilling, backfilling }, timing: "t", quoteUsd: 1, live: 0 };
}

const BAR = { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0 } as MarketResponse["candles"][number];

describe("marketCacheTtlMs", () => {
  it("uses the short TTL while the chain series is backfilling", () => {
    expect(marketCacheTtlMs(market({ candleSource: chainSource(true) }), TTL, SHORT)).toBe(SHORT);
    expect(marketCacheTtlMs(market({ candleSource: chainSource(false) }), TTL, SHORT)).toBe(TTL);
  });

  it("uses the short TTL for a fallback answer whose notes say the first fill is still running", () => {
    const pending = market({ notes: ["chain swaps unavailable: chain backfill in progress: 3 of 60 min fetched (12 swaps so far); candles are GeckoTerminal pool OHLCV"] });
    expect(marketCacheTtlMs(pending, TTL, SHORT)).toBe(SHORT);
    const empty = market({ notes: ["chain swaps unavailable: chain backfill found no swaps yet (still running); candles are GeckoTerminal pool OHLCV"] });
    expect(marketCacheTtlMs(empty, TTL, SHORT)).toBe(SHORT);
  });

  it("keeps the full TTL for a fallback whose chain path failed outright", () => {
    const failed = market({ notes: ["chain swaps unavailable: quote 0x8005 has no USD price; candles are GeckoTerminal pool OHLCV"] });
    expect(marketCacheTtlMs(failed, TTL, SHORT)).toBe(TTL);
  });
});

describe("lastGoodOverEmpty", () => {
  it("serves the last-good series stale with the fresh reason when the fresh answer has no candles and no source", () => {
    const lastGood = market({ candles: [BAR], candleSource: chainSource(false), observedAt: 10 });
    const fresh = market({ notes: ["No DexScreener pool with this token as base"], observedAt: 20 });
    expect(lastGoodOverEmpty(lastGood, fresh)).toEqual({ ...lastGood, stale: true, error: "No DexScreener pool with this token as base" });
  });

  it("lets a fresh answer through when it has candles, carries a candleSource, or nothing good was cached", () => {
    const lastGood = market({ candles: [BAR] });
    expect(lastGoodOverEmpty(lastGood, market({ candles: [BAR] }))).toBeNull();
    expect(lastGoodOverEmpty(lastGood, market({ candleSource: chainSource(true) }))).toBeNull();
    expect(lastGoodOverEmpty(undefined, market())).toBeNull();
    expect(lastGoodOverEmpty(market(), market())).toBeNull();
  });
});
