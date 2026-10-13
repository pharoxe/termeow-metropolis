import type { AddressInfo } from "node:net";
import express from "express";
import { ZodError } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketResponse } from "../../shared/wire.js";
import { MONAD_MARKET_SOURCE } from "../market/monad.js";
import {
  MARKET_BACKFILLING_TTL_MS,
  MARKET_CACHE_TTL_MS,
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

function monadMarket(observedAt: number, priceUsd = 0.02): MarketResponse {
  return {
    instrument: { chain: "monad", address: FATCOIN, symbol: "FATCOIN", name: "FATCOIN", image: null, socials: [], websites: [] },
    priceUsd, marketCapUsd: 1, fdvUsd: 1, liquidityUsd: 1, volume24Usd: 1, change24Pct: 0,
    primaryPair: { dex: "uniswap", pairAddress: "0xpool", quoteSymbol: "USDC" },
    candles: [], interval: "5m", observedAt, source: MONAD_MARKET_SOURCE, degraded: false, notes: []
  };
}

function deps(overrides: Partial<MarketRouteDeps> = {}): MarketRouteDeps & Record<"assembleMonadMarket", ReturnType<typeof vi.fn>> {
  const assembleMonadMarket = vi.fn(async () => monadMarket(NOW));
  return { assembleMonadMarket, now: () => NOW, ...overrides } as MarketRouteDeps & Record<"assembleMonadMarket", ReturnType<typeof vi.fn>>;
}

beforeEach(() => resetMarketCache());

describe("resolveMarketParams", () => {
  it("defaults the interval to 5m and lowercases Monad addresses", () => {
    expect(resolveMarketParams({ chain: "monad", address: FATCOIN }, undefined)).toEqual({ chain: "monad", address: FATCOIN, interval: "5m" });
    expect(resolveMarketParams({ chain: "monad", address: "0x12D5ee7917cA430073C3A638ee1e6f0648A98a01" }, { interval: "1h" })).toEqual({ chain: "monad", address: FATCOIN, interval: "1h" });
  });

  it("rejects unknown chains, mismatched address formats and unknown intervals", () => {
    expect(() => resolveMarketParams({ chain: "base", address: MINT }, {})).toThrow(ZodError);
    expect(marketParamsSchema.safeParse({ chain: "solana", address: FATCOIN }).success).toBe(false);
    expect(marketParamsSchema.safeParse({ chain: "monad", address: MINT }).success).toBe(false);
    expect(() => resolveMarketParams({ chain: "monad", address: FATCOIN }, { interval: "2m" })).toThrow(ZodError);
  });
});

describe("buildMarketResponse", () => {
  it("caches Monad per (address, interval) for 45s and dedupes concurrent calls", async () => {
    let resolveFirst: (market: MarketResponse) => void = () => undefined;
    let now = NOW;
    const assembleMonadMarket = vi.fn((_address: string, _interval: string) => assembleMonadMarket.mock.calls.length === 1
      ? new Promise<MarketResponse>((resolve) => { resolveFirst = resolve; })
      : Promise.resolve(monadMarket(now)));
    const d = deps({ assembleMonadMarket, now: () => now });
    const params = { chain: "monad" as const, address: FATCOIN, interval: "5m" as const };
    const [a, b] = [buildMarketResponse(params, d), buildMarketResponse(params, d)];
    expect(assembleMonadMarket).toHaveBeenCalledTimes(1);
    resolveFirst(monadMarket(NOW));
    expect(await a).toBe(await b);
    now = NOW + MARKET_CACHE_TTL_MS - 1;
    expect((await buildMarketResponse(params, d)).observedAt).toBe(NOW);
    expect(assembleMonadMarket).toHaveBeenCalledTimes(1);
    await buildMarketResponse({ ...params, interval: "1h" }, d);
    expect(assembleMonadMarket).toHaveBeenCalledTimes(2);
    expect(assembleMonadMarket).toHaveBeenLastCalledWith(FATCOIN, "1h");
    now = NOW + MARKET_CACHE_TTL_MS;
    expect((await buildMarketResponse(params, d)).observedAt).toBe(now);
    expect(assembleMonadMarket).toHaveBeenCalledTimes(3);
  });

  it("re-reads a Monad answer after 5s instead of 45s while its chain backfill is still running", async () => {
    let now = NOW;
    let backfilling = true;
    const assembleMonadMarket = vi.fn(async () => ({
      ...monadMarket(now),
      source: "chain swaps",
      candleSource: { kind: "chain swaps" as const, backfilledFrom: null, coverage: { fromMs: null, toMs: null, bars: 0, prints: 0, complete: !backfilling, backfilling }, timing: "t", quoteUsd: 1, live: 0 }
    }));
    const d = deps({ assembleMonadMarket, now: () => now });
    const params = { chain: "monad" as const, address: FATCOIN, interval: "1m" as const };
    await buildMarketResponse(params, d);
    now = NOW + MARKET_BACKFILLING_TTL_MS - 1;
    await buildMarketResponse(params, d);
    expect(assembleMonadMarket).toHaveBeenCalledTimes(1);
    now = NOW + MARKET_BACKFILLING_TTL_MS;
    backfilling = false;
    await buildMarketResponse(params, d);
    expect(assembleMonadMarket).toHaveBeenCalledTimes(2);
    now += MARKET_CACHE_TTL_MS - 1;
    await buildMarketResponse(params, d);
    expect(assembleMonadMarket).toHaveBeenCalledTimes(2);
  });

  it("serves last-good with stale + error after a Monad failure, and the empty envelope when nothing is cached", async () => {
    let fail = false;
    let now = NOW;
    const assembleMonadMarket = vi.fn(async () => {
      if (fail) throw new Error("dexscreener 500");
      return monadMarket(now, 0.03);
    });
    const d = deps({ assembleMonadMarket, now: () => now });
    const params = { chain: "monad" as const, address: FATCOIN, interval: "5m" as const };
    fail = true;
    const empty = await buildMarketResponse(params, d);
    expect(empty).toMatchObject({ instrument: { chain: "monad", address: FATCOIN, symbol: "TOKEN" }, priceUsd: null, degraded: true, source: MONAD_MARKET_SOURCE, error: "dexscreener 500" });
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

  it("serves the Monad envelope with the query interval", async () => {
    const { status, body } = await get(`/monad/0x12D5ee7917cA430073C3A638ee1e6f0648A98a01?interval=1m`);
    expect(status).toBe(200);
    expect(d.assembleMonadMarket).toHaveBeenLastCalledWith(FATCOIN, "1m");
    expect(body).toMatchObject({ instrument: { chain: "monad", address: FATCOIN, symbol: "FATCOIN" }, primaryPair: { dex: "uniswap" }, source: MONAD_MARKET_SOURCE });
  });

  it("400s on a non-Monad chain, a bad address or interval", async () => {
    expect((await get(`/solana/${FATCOIN}`)).status).toBe(400);
    expect((await get(`/monad/${MINT}`)).status).toBe(400);
    expect((await get(`/monad/${FATCOIN}?interval=2m`)).status).toBe(400);
    expect((await get(`/base/${MINT}`)).status).toBe(400);
  });
});
