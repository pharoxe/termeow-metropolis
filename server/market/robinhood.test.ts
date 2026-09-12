import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PairRow } from "../../shared/wire.js";
import type { Candle } from "../types.js";
import { normalizePair, type DexScreenerPair } from "../sources/dexscreener.js";
import { GECKO_OHLCV_PAGE_LIMIT } from "../sources/gecko.js";
import { CHAIN_CANDLE_FIRST_PAINT_MS, ROBINHOOD_MARKET_SOURCE, assembleRobinhoodMarket, primaryPairOf, type RobinhoodMarketDeps } from "./robinhood.js";
import type { ChainCandlesResult } from "./robinhood/chainCandles.js";

const FATCOIN = "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01";
const PRIMARY = "0xa659efd0442e9bb12f94193422d29bce5799225fca316ea8dd59f98afaaa90e1";
const NOW = 1_788_700_000_000;
const RAW = JSON.parse(readFileSync(new URL("../tape/robinhood/__fixtures__/dexscreener-fatcoin.json", import.meta.url), "utf8")) as DexScreenerPair[];
const PAIRS = RAW.map((raw) => normalizePair("robinhood", FATCOIN, raw)).filter((row): row is PairRow => row !== null);

function candle(seconds: number): Candle {
  return { time: seconds * 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };
}

function page(count: number, newestSeconds: number, stepSeconds = 300): Candle[] {
  return Array.from({ length: count }, (_, index) => candle(newestSeconds - (count - 1 - index) * stepSeconds));
}

function deps(overrides: Partial<RobinhoodMarketDeps> = {}): RobinhoodMarketDeps & { geckoPoolOhlcv: ReturnType<typeof vi.fn> } {
  const geckoPoolOhlcv = vi.fn(async () => page(3, 1_788_699_900));
  return {
    getTokenPairs: async () => ({ pairs: PAIRS, stale: false, observedAt: NOW - 1000 }),
    geckoPoolOhlcv,
    fetchDexPairsRaw: async () => ({ pairs: RAW, stale: false, observedAt: NOW - 1000 }),
    now: () => NOW,
    ...overrides
  } as RobinhoodMarketDeps & { geckoPoolOhlcv: ReturnType<typeof vi.fn> };
}

describe("primaryPairOf", () => {
  it("picks the deepest pool where the token is the base side, ignoring deeper pools that quote in the token", () => {
    expect(PAIRS).toHaveLength(20);
    expect(primaryPairOf(FATCOIN, PAIRS)?.pairAddress).toBe(PRIMARY);
    expect(primaryPairOf(FATCOIN.toUpperCase(), PAIRS)?.pairAddress).toBe(PRIMARY);
    expect(primaryPairOf(FATCOIN, [])).toBeNull();
  });

  it("treats a null liquidity as the shallowest and breaks ties on 24h volume", () => {
    const base = PAIRS[0];
    const rows: PairRow[] = [
      { ...base, pairAddress: "a", liquidityUsd: null, volume24Usd: 999 },
      { ...base, pairAddress: "b", liquidityUsd: 10, volume24Usd: 1 },
      { ...base, pairAddress: "c", liquidityUsd: 10, volume24Usd: 5 }
    ];
    expect(primaryPairOf(FATCOIN, rows)?.pairAddress).toBe("c");
  });
});

describe("assembleRobinhoodMarket", () => {
  it("assembles instrument, numbers, primary pair and candles from the FATCOIN fixture", async () => {
    const d = deps();
    const market = await assembleRobinhoodMarket(FATCOIN, "5m", d);
    expect(market.instrument).toEqual({
      chain: "robinhood",
      address: FATCOIN,
      symbol: "FATCOIN",
      name: "FATCOIN",
      image: "https://cdn.dexscreener.com/cms/images/NrGeVCGTamuQ4v2m?width=800&height=800&quality=95&format=auto",
      socials: [{ type: "twitter", url: "https://x.com/FatcoinLLY" }],
      websites: ["https://www.fatcoin.space/", "https://x.com/i/communities/1939856297614352899"]
    });
    expect(market).toMatchObject({
      priceUsd: 0.02048,
      marketCapUsd: 20485291,
      fdvUsd: 20485291,
      liquidityUsd: 484836.39,
      volume24Usd: 3416736.1,
      change24Pct: -42.09,
      primaryPair: { dex: "uniswap", pairAddress: PRIMARY, quoteSymbol: "USDG" },
      interval: "5m",
      observedAt: NOW,
      source: ROBINHOOD_MARKET_SOURCE,
      degraded: false,
      notes: []
    });
    expect(market.candles).toHaveLength(3);
    expect(market.provider).toBeUndefined();
    expect(d.geckoPoolOhlcv).toHaveBeenCalledTimes(1);
    expect(d.geckoPoolOhlcv).toHaveBeenCalledWith("robinhood", PRIMARY, "5m", { limit: GECKO_OHLCV_PAGE_LIMIT });
  });

  it("walks back one extra page with before_timestamp only when the first page is full, merged ascending", async () => {
    const newest = 1_788_699_900;
    const first = page(GECKO_OHLCV_PAGE_LIMIT, newest);
    const second = page(GECKO_OHLCV_PAGE_LIMIT, first[0].time / 1000);
    const geckoPoolOhlcv = vi.fn(async (_n: unknown, _p: unknown, _i: unknown, opts?: { beforeTs?: number }) => (opts?.beforeTs ? second : first));
    const market = await assembleRobinhoodMarket(FATCOIN, "1m", deps({ geckoPoolOhlcv }));
    expect(geckoPoolOhlcv).toHaveBeenCalledTimes(2);
    expect(geckoPoolOhlcv.mock.calls[1][3]).toEqual({ limit: GECKO_OHLCV_PAGE_LIMIT, beforeTs: first[0].time / 1000 });
    expect(market.candles).toHaveLength(2 * GECKO_OHLCV_PAGE_LIMIT - 1);
    expect(market.candles.every((row, index, all) => index === 0 || all[index - 1].time < row.time)).toBe(true);
    expect(market.candles.at(-1)?.time).toBe(newest * 1000);
  });

  it("degrades to empty candles with a note when GeckoTerminal fails, keeping the DexScreener numbers", async () => {
    const market = await assembleRobinhoodMarket(FATCOIN, "5m", deps({ geckoPoolOhlcv: vi.fn(async () => { throw new Error("Upstream returned 429"); }) }));
    expect(market.candles).toEqual([]);
    expect(market.priceUsd).toBe(0.02048);
    expect(market.degraded).toBe(true);
    expect(market.notes).toEqual(["OHLCV unavailable: Upstream returned 429"]);
  });

  it("keeps price and metadata null/placeholder when the raw body is unavailable, and notes stale registries", async () => {
    const market = await assembleRobinhoodMarket(FATCOIN, "5m", deps({
      getTokenPairs: async () => ({ pairs: PAIRS, stale: true, error: "Upstream returned 500", observedAt: NOW - 90_000 }),
      fetchDexPairsRaw: async () => { throw new Error("boom"); }
    }));
    expect(market.instrument).toMatchObject({ symbol: "TOKEN", name: "TOKEN", image: null, socials: [], websites: [] });
    expect(market).toMatchObject({ priceUsd: null, marketCapUsd: null, fdvUsd: null, change24Pct: null, liquidityUsd: 484836.39 });
    expect(market.primaryPair).toEqual({ dex: "uniswap", pairAddress: PRIMARY, quoteSymbol: null });
    expect(market.notes).toEqual(["DexScreener pairs stale: Upstream returned 500", "DexScreener token metadata unavailable: boom"]);
    expect(market.degraded).toBe(true);
  });

  it("returns no primary pair, no candles and no Gecko call when the registry has no base-side pool", async () => {
    const d = deps({ getTokenPairs: async () => ({ pairs: [], stale: false, observedAt: NOW }) });
    const market = await assembleRobinhoodMarket(FATCOIN, "5m", d);
    expect(market.primaryPair).toBeNull();
    expect(market.candles).toEqual([]);
    expect(market.liquidityUsd).toBeNull();
    expect(market.instrument.symbol).toBe("FATCOIN");
    expect(market.notes).toEqual(["No DexScreener pool with this token as base"]);
    expect(d.geckoPoolOhlcv).not.toHaveBeenCalled();
  });

  it("propagates a registry failure so the route can serve last-good", async () => {
    await expect(assembleRobinhoodMarket(FATCOIN, "5m", deps({ getTokenPairs: async () => { throw new Error("down"); } }))).rejects.toThrow("down");
  });
});

function chainResult(kind: "chain swaps", candles: Candle[], notes: string[] = []): ChainCandlesResult {
  return {
    candles,
    notes,
    stale: false,
    candleSource: {
      kind,
      backfilledFrom: kind === "chain swaps" ? { block: 56_800_228, time: 1_788_780_684_000 } : null,
      coverage: { fromMs: candles[0]?.time ?? null, toMs: candles.at(-1)?.time ?? null, bars: candles.length, prints: candles.length, complete: kind === "chain swaps", backfilling: false },
      timing: "test",
      quoteUsd: kind === "chain swaps" ? 1 : null,
      live: 0
    }
  };
}

describe("assembleRobinhoodMarket R6 chain-swap candles", () => {
  it("serves the pool's own swaps under source 'chain swaps' with candleSource, never calling GeckoTerminal", async () => {
    const chainCandles = vi.fn(async (_primary: PairRow, _interval: string) => chainResult("chain swaps", page(4, 1_788_699_900), ["candles from v4 Swap logs of 0xpool (4 swaps, 1 chunks, 2 block anchors; times interpolated between anchors)"]));
    const d = deps({ chainCandles });
    const market = await assembleRobinhoodMarket(FATCOIN, "1m", d);
    expect(chainCandles).toHaveBeenCalledTimes(1);
    expect(chainCandles.mock.calls[0][0]).toMatchObject({ pairAddress: PRIMARY });
    expect(chainCandles.mock.calls[0][1]).toBe("1m");
    expect(d.geckoPoolOhlcv).not.toHaveBeenCalled();
    expect(market.source).toBe("chain swaps");
    expect(market.candles).toHaveLength(4);
    expect(market.candleSource).toMatchObject({ kind: "chain swaps", backfilledFrom: { block: 56_800_228 }, coverage: { bars: 4, complete: true } });
    expect(market.notes).toEqual(["candles from v4 Swap logs of 0xpool (4 swaps, 1 chunks, 2 block anchors; times interpolated between anchors)"]);
    // provenance notes describe the series; they are not a degradation
    expect(market.degraded).toBe(false);
    expect(market.priceUsd).toBe(0.02048);
  });

  it("falls back to GeckoTerminal only when the chain path throws, labelled 'geckoterminal' with the reason", async () => {
    const d = deps({ chainCandles: vi.fn(async () => { throw new Error("quote 0x8005 has no USD price"); }) });
    const market = await assembleRobinhoodMarket(FATCOIN, "5m", d);
    expect(d.geckoPoolOhlcv).toHaveBeenCalledTimes(1);
    expect(market.source).toBe("geckoterminal");
    expect(market.candles).toHaveLength(3);
    expect(market.candleSource).toBeUndefined();
    expect(market.degraded).toBe(true);
    expect(market.notes).toEqual(["chain swaps unavailable: quote 0x8005 has no USD price; candles are GeckoTerminal pool OHLCV"]);
  });

  it("falls back to Gecko within the first-paint budget while a cold chain path keeps warming", async () => {
    vi.useFakeTimers();
    try {
      const chainCandles = vi.fn(() => new Promise<ChainCandlesResult>(() => {}));
      const d = deps({ chainCandles });
      const pending = assembleRobinhoodMarket(FATCOIN, "5m", d);
      await vi.advanceTimersByTimeAsync(CHAIN_CANDLE_FIRST_PAINT_MS + 1);
      const market = await pending;
      expect(market.source).toBe("geckoterminal");
      expect(market.candles).toHaveLength(3);
      expect(market.notes).toEqual([`chain swaps unavailable: chain path still warming after ${CHAIN_CANDLE_FIRST_PAINT_MS}ms; candles are GeckoTerminal pool OHLCV`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports both failures when the chain path throws and GeckoTerminal is in backoff", async () => {
    const market = await assembleRobinhoodMarket(FATCOIN, "5m", deps({
      chainCandles: vi.fn(async () => { throw new Error("chain backfill failed: upstream returned 429"); }),
      geckoPoolOhlcv: vi.fn(async () => { throw new Error("GeckoTerminal backoff active after 429"); })
    }));
    expect(market.candles).toEqual([]);
    expect(market.source).toBe("geckoterminal");
    expect(market.notes).toEqual([
      "chain swaps unavailable: chain backfill failed: upstream returned 429; candles are GeckoTerminal pool OHLCV",
      "OHLCV unavailable: GeckoTerminal backoff active after 429"
    ]);
  });

  it("marks a still-backfilling empty chain series as degraded-but-chain rather than falling back", async () => {
    const running = chainResult("chain swaps", [], ["backfill in progress: older bars arrive on the next read"]);
    running.candleSource.coverage = { ...running.candleSource.coverage, complete: false, backfilling: true };
    const d = deps({ chainCandles: vi.fn(async () => running) });
    const market = await assembleRobinhoodMarket(FATCOIN, "1m", d);
    expect(d.geckoPoolOhlcv).not.toHaveBeenCalled();
    expect(market.source).toBe("chain swaps");
    expect(market.candles).toEqual([]);
    expect(market.degraded).toBe(true);
    expect(market.candleSource?.coverage.backfilling).toBe(true);
  });

  it("marks the response stale when the chain series' last top-up failed", async () => {
    const stale = chainResult("chain swaps", page(2, 1_788_699_900), ["chain backfill error: upstream returned 429 (series may be partial; head not current)"]);
    const market = await assembleRobinhoodMarket(FATCOIN, "1m", deps({ chainCandles: vi.fn(async () => ({ ...stale, stale: true })) }));
    expect(market.stale).toBe(true);
    expect(market.degraded).toBe(true);
    const fresh = await assembleRobinhoodMarket(FATCOIN, "1m", deps({ chainCandles: vi.fn(async () => chainResult("chain swaps", page(2, 1_788_699_900))) }));
    expect(fresh.stale).toBeUndefined();
  });

  it("keeps the legacy note when a token has no pool", async () => {
    const market = await assembleRobinhoodMarket(FATCOIN, "1m", deps({ getTokenPairs: async () => ({ pairs: [], stale: false, observedAt: NOW }), chainCandles: vi.fn() }));
    expect(market.notes).toEqual(["No DexScreener pool with this token as base"]);
    expect(market.source).toBe(ROBINHOOD_MARKET_SOURCE);
    expect(market.candleSource).toBeUndefined();
  });
});
