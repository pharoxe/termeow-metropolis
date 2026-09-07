import type { AddressInfo } from "node:net";
import express from "express";
import { ZodError } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketResponse } from "../../shared/wire.js";
import type { OnchainMarket } from "../types.js";
import { ROBINHOOD_MARKET_SOURCE } from "../market/robinhood.js";
import {
  MARKET_BACKFILLING_TTL_MS,
  MARKET_CACHE_TTL_MS,
  SOLANA_MARKET_SOURCE,
  buildMarketResponse,
  createMarketRouter,
  marketParamsSchema,
  resetMarketCache,
  resolveMarketParams,
  type MarketRouteDeps
} from "./market.js";

const MINT = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const FATCOIN = "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01";
const NOW = 1_788_700_000_000;

const ONCHAIN: OnchainMarket = {
  instrumentId: `solana:${MINT}:spot`, mint: MINT, symbol: "ANSEM", name: "Ansem", quoteSymbol: "USD",
  priceUsd: 0.01, change24hPct: 1, volume24hUsd: 2, liquidityUsd: 3, marketCapUsd: 4, fdvUsd: 5,
  pairAddress: "POOL", dex: "raydium", observedAt: NOW - 5000, source: "ClawPump + on-chain fallback", degraded: false,
  notes: [], provider: { token_image_url: null }, candles: [], signals: []
};

function robinhoodMarket(observedAt: number, priceUsd = 0.02): MarketResponse {
  return {
    instrument: { chain: "robinhood", address: FATCOIN, symbol: "FATCOIN", name: "FATCOIN", image: null, socials: [], websites: [] },
    priceUsd, marketCapUsd: 1, fdvUsd: 1, liquidityUsd: 1, volume24Usd: 1, change24Pct: 0,
    primaryPair: { dex: "uniswap", pairAddress: "0xpool", quoteSymbol: "USDG" },
    candles: [], interval: "5m", observedAt, source: ROBINHOOD_MARKET_SOURCE, degraded: false, notes: []
  };
}

function deps(overrides: Partial<MarketRouteDeps> = {}): MarketRouteDeps & Record<"getOnchainMarket" | "assembleRobinhoodMarket", ReturnType<typeof vi.fn>> {
  const getOnchainMarket = vi.fn(async () => ONCHAIN);
  const assembleRobinhoodMarket = vi.fn(async () => robinhoodMarket(NOW));
  return { getOnchainMarket, assembleRobinhoodMarket, now: () => NOW, ...overrides } as MarketRouteDeps & Record<"getOnchainMarket" | "assembleRobinhoodMarket", ReturnType<typeof vi.fn>>;
}

beforeEach(() => resetMarketCache());

describe("resolveMarketParams", () => {
  it("defaults the interval to 5m and lowercases Robinhood addresses", () => {
    expect(resolveMarketParams({ chain: "solana", address: MINT }, undefined)).toEqual({ chain: "solana", address: MINT, interval: "5m" });
    expect(resolveMarketParams({ chain: "robinhood", address: "0x12D5ee7917cA430073C3A638ee1e6f0648A98a01" }, { interval: "1h" })).toEqual({ chain: "robinhood", address: FATCOIN, interval: "1h" });
  });

  it("rejects unknown chains, mismatched address formats and unknown intervals", () => {
    expect(() => resolveMarketParams({ chain: "base", address: MINT }, {})).toThrow(ZodError);
    expect(marketParamsSchema.safeParse({ chain: "solana", address: FATCOIN }).success).toBe(false);
    expect(marketParamsSchema.safeParse({ chain: "robinhood", address: MINT }).success).toBe(false);
    expect(() => resolveMarketParams({ chain: "solana", address: MINT }, { interval: "2m" })).toThrow(ZodError);
  });
});

describe("buildMarketResponse", () => {
  it("delegates Solana to getOnchainMarket with the interval and adapts the result", async () => {
    const d = deps();
    const market = await buildMarketResponse({ chain: "solana", address: MINT, interval: "15m" }, d);
    expect(d.getOnchainMarket).toHaveBeenCalledWith(MINT, "15m");
    expect(d.assembleRobinhoodMarket).not.toHaveBeenCalled();
    expect(market).toMatchObject({ instrument: { chain: "solana", address: MINT, symbol: "ANSEM" }, priceUsd: 0.01, interval: "15m", source: ONCHAIN.source, provider: ONCHAIN.provider });
  });

  it("returns the empty 200 envelope with error when the Solana market throws", async () => {
    const d = deps({ getOnchainMarket: vi.fn(async () => { throw new Error("mcp down"); }) });
    const market = await buildMarketResponse({ chain: "solana", address: MINT, interval: "5m" }, d);
    expect(market).toMatchObject({ instrument: { chain: "solana", address: MINT }, priceUsd: null, candles: [], degraded: true, source: SOLANA_MARKET_SOURCE, error: "mcp down", observedAt: NOW });
  });

  it("caches Robinhood per (address, interval) for 45s and dedupes concurrent calls", async () => {
    let resolveFirst: (market: MarketResponse) => void = () => undefined;
    let now = NOW;
    const assembleRobinhoodMarket = vi.fn((_address: string, _interval: string) => assembleRobinhoodMarket.mock.calls.length === 1
      ? new Promise<MarketResponse>((resolve) => { resolveFirst = resolve; })
      : Promise.resolve(robinhoodMarket(now)));
    const d = deps({ assembleRobinhoodMarket, now: () => now });
    const params = { chain: "robinhood" as const, address: FATCOIN, interval: "5m" as const };
    const [a, b] = [buildMarketResponse(params, d), buildMarketResponse(params, d)];
    expect(assembleRobinhoodMarket).toHaveBeenCalledTimes(1);
    resolveFirst(robinhoodMarket(NOW));
    expect(await a).toBe(await b);
    now = NOW + MARKET_CACHE_TTL_MS - 1;
    expect((await buildMarketResponse(params, d)).observedAt).toBe(NOW);
    expect(assembleRobinhoodMarket).toHaveBeenCalledTimes(1);
    await buildMarketResponse({ ...params, interval: "1h" }, d);
    expect(assembleRobinhoodMarket).toHaveBeenCalledTimes(2);
    expect(assembleRobinhoodMarket).toHaveBeenLastCalledWith(FATCOIN, "1h");
    now = NOW + MARKET_CACHE_TTL_MS;
    expect((await buildMarketResponse(params, d)).observedAt).toBe(now);
    expect(assembleRobinhoodMarket).toHaveBeenCalledTimes(3);
  });

  it("re-reads a Robinhood answer after 5s instead of 45s while its chain backfill is still running", async () => {
    let now = NOW;
    let backfilling = true;
    const assembleRobinhoodMarket = vi.fn(async () => ({
      ...robinhoodMarket(now),
      source: "chain swaps",
      candleSource: { kind: "chain swaps" as const, backfilledFrom: null, coverage: { fromMs: null, toMs: null, bars: 0, prints: 0, complete: !backfilling, backfilling }, timing: "t", quoteUsd: 1, live: 0 }
    }));
    const d = deps({ assembleRobinhoodMarket, now: () => now });
    const params = { chain: "robinhood" as const, address: FATCOIN, interval: "1m" as const };
    await buildMarketResponse(params, d);
    now = NOW + MARKET_BACKFILLING_TTL_MS - 1;
    await buildMarketResponse(params, d);
    expect(assembleRobinhoodMarket).toHaveBeenCalledTimes(1);
    now = NOW + MARKET_BACKFILLING_TTL_MS;
    backfilling = false;
    await buildMarketResponse(params, d);
    expect(assembleRobinhoodMarket).toHaveBeenCalledTimes(2);
    now += MARKET_CACHE_TTL_MS - 1;
    await buildMarketResponse(params, d);
    expect(assembleRobinhoodMarket).toHaveBeenCalledTimes(2);
  });

  it("serves last-good with stale + error after a Robinhood failure, and the empty envelope when nothing is cached", async () => {
    let fail = false;
    let now = NOW;
    const assembleRobinhoodMarket = vi.fn(async () => {
      if (fail) throw new Error("dexscreener 500");
      return robinhoodMarket(now, 0.03);
    });
    const d = deps({ assembleRobinhoodMarket, now: () => now });
    const params = { chain: "robinhood" as const, address: FATCOIN, interval: "5m" as const };
    fail = true;
    const empty = await buildMarketResponse(params, d);
    expect(empty).toMatchObject({ instrument: { chain: "robinhood", address: FATCOIN, symbol: "TOKEN" }, priceUsd: null, degraded: true, source: ROBINHOOD_MARKET_SOURCE, error: "dexscreener 500" });
    expect(empty.stale).toBeUndefined();
    fail = false;
    const good = await buildMarketResponse(params, d);
    expect(good.priceUsd).toBe(0.03);
    now = NOW + MARKET_CACHE_TTL_MS + 1;
    fail = true;
    const stale = await buildMarketResponse(params, d);
    expect(stale).toMatchObject({ priceUsd: 0.03, observedAt: NOW, stale: true, error: "dexscreener 500" });
    fail = false;
    now = NOW + 2 * MARKET_CACHE_TTL_MS + 2;
    const fresh = await buildMarketResponse(params, d);
    expect(fresh.stale).toBeUndefined();
    expect(fresh.observedAt).toBe(now);
  });
});

describe("GET /api/market/:chain/:address", () => {
  const d = deps();
  const app = express();
  app.use("/api/market", createMarketRouter(d));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof ZodError ? 400 : 500).json({ error: error instanceof ZodError ? "Invalid request" : "Server error" });
  });
  let base = "";
  let server: ReturnType<typeof app.listen>;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/market`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function get(path: string): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: await response.json() };
  }

  it("serves the Robinhood envelope with the query interval", async () => {
    const { status, body } = await get(`/robinhood/0x12D5ee7917cA430073C3A638ee1e6f0648A98a01?interval=1m`);
    expect(status).toBe(200);
    expect(d.assembleRobinhoodMarket).toHaveBeenLastCalledWith(FATCOIN, "1m");
    expect(body).toMatchObject({ instrument: { chain: "robinhood", address: FATCOIN, symbol: "FATCOIN" }, primaryPair: { dex: "uniswap" }, source: ROBINHOOD_MARKET_SOURCE });
  });

  it("serves the Solana envelope and 400s on a bad address or interval", async () => {
    const ok = await get(`/solana/${MINT}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ instrument: { chain: "solana", address: MINT }, interval: "5m" });
    expect((await get(`/solana/${FATCOIN}`)).status).toBe(400);
    expect((await get(`/robinhood/${FATCOIN}?interval=2m`)).status).toBe(400);
    expect((await get(`/base/${MINT}`)).status).toBe(400);
  });
});
