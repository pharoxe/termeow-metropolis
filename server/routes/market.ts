import { Router } from "express";
import { z } from "zod";
import type { Chain, MarketResponse } from "../../shared/wire.js";
import type { OnchainMarket } from "../types.js";
import { getOnchainMarket } from "../clawpump/market.js";
import { errorMessage } from "../lib/http.js";
import { emptyMarketResponse } from "../market/envelope.js";
import { ROBINHOOD_MARKET_SOURCE, assembleRobinhoodMarket } from "../market/robinhood.js";
import { adaptSolanaMarket } from "../market/solana.js";
import { getTokenPairs, rawTokenPairs } from "../sources/dexscreener.js";
import { GECKO_OHLCV_INTERVALS, geckoPoolOhlcv, type GeckoOhlcvInterval } from "../sources/gecko.js";

export const MARKET_CACHE_TTL_MS = 45_000;
export const SOLANA_MARKET_SOURCE = "ClawPump + on-chain fallback";
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/** Same discriminated union as routes/flow.ts (copied, not imported): Robinhood addresses are lowercased. */
export const marketParamsSchema = z.discriminatedUnion("chain", [
  z.object({ chain: z.literal("solana"), address: z.string().regex(SOLANA_ADDRESS) }),
  z.object({ chain: z.literal("robinhood"), address: z.string().regex(EVM_ADDRESS).transform((address) => address.toLowerCase()) })
]);

export const marketQuerySchema = z.object({ interval: z.enum(GECKO_OHLCV_INTERVALS).default("5m") });

export type MarketParams = { chain: Chain; address: string; interval: GeckoOhlcvInterval };

export type MarketRouteDeps = {
  getOnchainMarket: (mint: string, interval: string) => Promise<OnchainMarket>;
  assembleRobinhoodMarket: (address: string, interval: GeckoOhlcvInterval) => Promise<MarketResponse>;
  now: () => number;
};

export function resolveMarketParams(params: unknown, query: unknown): MarketParams {
  const { chain, address } = marketParamsSchema.parse(params);
  const { interval } = marketQuerySchema.parse(query ?? {});
  return { chain, address, interval };
}

const robinhoodCache = new Map<string, MarketResponse>();
const robinhoodInflight = new Map<string, Promise<MarketResponse>>();

/** Testing hook: forgets Robinhood last-good responses and in-flight work. */
export function resetMarketCache(): void {
  robinhoodCache.clear();
  robinhoodInflight.clear();
}

async function solanaMarket(params: MarketParams, deps: MarketRouteDeps): Promise<MarketResponse> {
  try {
    return adaptSolanaMarket(await deps.getOnchainMarket(params.address, params.interval), params.interval);
  } catch (error) {
    return emptyMarketResponse(params.chain, params.address, params.interval, deps.now(), SOLANA_MARKET_SOURCE, errorMessage(error));
  }
}

/** Last-good with stale + error when one exists, otherwise the empty envelope; never rejects. */
function robinhoodFallback(key: string, params: MarketParams, deps: MarketRouteDeps, error: unknown): MarketResponse {
  const message = errorMessage(error);
  const lastGood = robinhoodCache.get(key);
  if (lastGood) return { ...lastGood, stale: true, error: message };
  return emptyMarketResponse(params.chain, params.address, params.interval, deps.now(), ROBINHOOD_MARKET_SOURCE, message);
}

/** 45s TTL per (address, interval), in-flight dedupe, last-good on failure. */
function robinhoodMarket(params: MarketParams, deps: MarketRouteDeps): Promise<MarketResponse> {
  const key = `${params.address}:${params.interval}`;
  const cached = robinhoodCache.get(key);
  if (cached && deps.now() - cached.observedAt < MARKET_CACHE_TTL_MS) return Promise.resolve(cached);
  const pending = robinhoodInflight.get(key);
  if (pending) return pending;
  const request = deps
    .assembleRobinhoodMarket(params.address, params.interval)
    .then((market) => {
      robinhoodCache.set(key, market);
      return market;
    })
    .catch((error: unknown) => robinhoodFallback(key, params, deps, error))
    .finally(() => robinhoodInflight.delete(key));
  robinhoodInflight.set(key, request);
  return request;
}

/** Pure handler: Solana delegates to getOnchainMarket unchanged; Robinhood assembles behind the cache. Always resolves. */
export function buildMarketResponse(params: MarketParams, deps: MarketRouteDeps): Promise<MarketResponse> {
  return params.chain === "solana" ? solanaMarket(params, deps) : robinhoodMarket(params, deps);
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
  getOnchainMarket,
  assembleRobinhoodMarket: (address, interval) =>
    assembleRobinhoodMarket(address, interval, { getTokenPairs, geckoPoolOhlcv, fetchDexPairsRaw: rawTokenPairs }),
  now: () => Date.now()
};

export const marketRouter = createMarketRouter(liveDeps);
