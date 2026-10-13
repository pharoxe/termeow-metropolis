import { Router } from "express";
import { z } from "zod";
import type { Chain, MarketResponse } from "../../shared/wire.js";
import { errorMessage } from "../lib/http.js";
import { emptyMarketResponse } from "../market/envelope.js";
import { MONAD_MARKET_SOURCE, assembleMonadMarket } from "../market/monad.js";
import { liveChainCandles } from "../market/monad/live.js";
import { lastGoodOverEmpty, marketCacheTtlMs } from "./marketCachePolicy.js";
import { getTokenPairs, rawTokenPairs } from "../sources/dexscreener.js";
import { GECKO_OHLCV_INTERVALS, geckoPoolOhlcv, type GeckoOhlcvInterval } from "../sources/gecko.js";

export const MARKET_CACHE_TTL_MS = 45_000;
/** R6: while the chain backfill is still running the answer changes every few seconds, so it is re-read sooner. */
export const MARKET_BACKFILLING_TTL_MS = 5_000;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/** Same schema as routes/flow.ts (copied, not imported): Monad addresses are lowercased. */
export const marketParamsSchema = z.object({ chain: z.literal("monad"), address: z.string().regex(EVM_ADDRESS).transform((address) => address.toLowerCase()) });

export const marketQuerySchema = z.object({ interval: z.enum(GECKO_OHLCV_INTERVALS).default("5m") });

export type MarketParams = { chain: Chain; address: string; interval: GeckoOhlcvInterval };

export type MarketRouteDeps = {
  assembleMonadMarket: (address: string, interval: GeckoOhlcvInterval) => Promise<MarketResponse>;
  now: () => number;
};

export function resolveMarketParams(params: unknown, query: unknown): MarketParams {
  const { chain, address } = marketParamsSchema.parse(params);
  const { interval } = marketQuerySchema.parse(query ?? {});
  return { chain, address, interval };
}

const monadCache = new Map<string, MarketResponse>();
const monadInflight = new Map<string, Promise<MarketResponse>>();

/** Testing hook: forgets Monad last-good responses and in-flight work. */
export function resetMarketCache(): void {
  monadCache.clear();
  monadInflight.clear();
}

/** Last-good with stale + error when one exists, otherwise the empty envelope; never rejects. */
function monadFallback(key: string, params: MarketParams, deps: MarketRouteDeps, error: unknown): MarketResponse {
  const message = errorMessage(error);
  const lastGood = monadCache.get(key);
  if (lastGood) return { ...lastGood, stale: true, error: message };
  return emptyMarketResponse(params.chain, params.address, params.interval, deps.now(), MONAD_MARKET_SOURCE, message);
}

/** 45s TTL per (address, interval) (5 s while a chain fill is pending), in-flight dedupe, last-good on failure or on a candle-less answer. */
function monadMarket(params: MarketParams, deps: MarketRouteDeps): Promise<MarketResponse> {
  const key = `${params.address}:${params.interval}`;
  const cached = monadCache.get(key);
  if (cached && deps.now() - cached.observedAt < marketCacheTtlMs(cached, MARKET_CACHE_TTL_MS, MARKET_BACKFILLING_TTL_MS)) return Promise.resolve(cached);
  const pending = monadInflight.get(key);
  if (pending) return pending;
  const request = deps
    .assembleMonadMarket(params.address, params.interval)
    .then((market) => {
      const kept = lastGoodOverEmpty(monadCache.get(key), market);
      if (kept) return kept;
      monadCache.set(key, market);
      return market;
    })
    .catch((error: unknown) => monadFallback(key, params, deps, error))
    .finally(() => monadInflight.delete(key));
  monadInflight.set(key, request);
  return request;
}

/** Pure handler: Monad assembles behind the cache. Always resolves. */
export function buildMarketResponse(params: MarketParams, deps: MarketRouteDeps): Promise<MarketResponse> {
  return monadMarket(params, deps);
}

export function createMarketRouter(deps: MarketRouteDeps): Router {
  const router = Router();
  router.get("/:chain/:address", async (request, response, next) => {
    try {
      const params = resolveMarketParams(request.params, request.query);
      response.json(await buildMarketResponse(params, deps));
    } catch (error) {
      next(error);
    }
  });
  return router;
}

const liveDeps: MarketRouteDeps = {
  assembleMonadMarket: (address, interval) =>
    assembleMonadMarket(address, interval, { getTokenPairs, geckoPoolOhlcv, fetchDexPairsRaw: rawTokenPairs, chainCandles: liveChainCandles }),
  now: () => Date.now()
};

export const marketRouter = createMarketRouter(liveDeps);

/** Same builder the market route uses (Monad assembly). For empty-tape candle fallback. */
export function liveMarketResponse(params: MarketParams): Promise<MarketResponse> {
  return buildMarketResponse(params, liveDeps);
}
