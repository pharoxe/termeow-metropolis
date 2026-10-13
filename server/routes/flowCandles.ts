import { Router } from "express";
import { z } from "zod";
import type { Chain, FlowCandleInterval, FlowCandlesResponse, MarketCandle } from "../../shared/wire.js";
import { CANDLE_INTERVALS, CANDLE_INTERVAL_MS, OWN_TAPE_SOURCE, candlesForToken, type TokenCandles } from "../flow/candles.js";
import { isLaunchpadRow, type RegistryResult } from "../flow/registry.js";
import { errorMessage } from "../lib/http.js";
import { flowParamsSchema, liveDeps, type FlowRouteDeps } from "./flow.js";
import { liveMarketResponse } from "./market.js";

/**
 * GET /api/flow/candles/:chain/:address?interval=5s|15s|1m — candles from own-tape ring prints that carry a price.
 * When the ring has none, the same market builder /api/market uses (on-chain public fallback or monad assembly)
 * supplies the series, labeled with that source. Reads the same registry and collector as /api/flow/token (liveDeps)
 * so it never gathers anything twice; always answers 200, with an `untracked:` error when the registry failed with
 * nothing cached or knows no pair for the token and the market fallback also has no bars.
 */
export const DEFAULT_CANDLE_INTERVAL: FlowCandleInterval = "15s";
/** Market candles have no 5s/15s series; the desk already falls back to 1m for those chips. */
const MARKET_FALLBACK_INTERVAL = "1m" as const;

export const candlesQuerySchema = z.object({ interval: z.enum(CANDLE_INTERVALS).default(DEFAULT_CANDLE_INTERVAL) });

export type CandlesParams = { chain: Chain; address: string; interval: FlowCandleInterval };

/** The subset of the flow route's dependencies this route needs (registry + collector + clock). */
export type CandlesRouteDeps = Pick<FlowRouteDeps, "registry" | "collector" | "now"> & {
  /** Market-route candles used only when the own tape has no priced prints. Tests omit it. */
  marketCandles?: (params: CandlesParams) => Promise<{ candles: MarketCandle[]; source: string; error?: string } | null>;
};

/** Zod-validates params (same address rules as the flow route, Monad lowercased) and the interval query. */
export function resolveCandlesParams(params: unknown, query: unknown): CandlesParams {
  const { chain, address } = flowParamsSchema.parse(params);
  const { interval } = candlesQuerySchema.parse(query ?? {});
  return { chain, address, interval };
}

function emptyCandles(params: CandlesParams, observedAt: number, error: string): FlowCandlesResponse {
  return { ...params, candles: [], source: OWN_TAPE_SOURCE, spanMs: 0, prints: 0, priced: 0, firstPrintAt: null, pricedBySource: {}, observedAt, error };
}

function spanOfCandles(candles: MarketCandle[]): number {
  if (candles.length < 2) return 0;
  return candles[candles.length - 1].time - candles[0].time;
}

async function loadRegistry(params: CandlesParams, deps: CandlesRouteDeps): Promise<RegistryResult | { failure: string }> {
  try {
    return await deps.registry(params.chain, params.address);
  } catch (error) {
    return { failure: errorMessage(error) };
  }
}

async function defaultMarketCandles(params: CandlesParams): Promise<{ candles: MarketCandle[]; source: string; error?: string } | null> {
  const market = await liveMarketResponse({ chain: params.chain, address: params.address, interval: MARKET_FALLBACK_INTERVAL });
  return { candles: market.candles, source: market.source, ...(market.error ? { error: market.error } : {}) };
}

function fromOwnTape(params: CandlesParams, observedAt: number, built: TokenCandles, registry: RegistryResult): FlowCandlesResponse {
  return {
    ...params,
    candles: built.candles,
    source: built.source,
    spanMs: built.spanMs,
    prints: built.prints,
    priced: built.priced,
    firstPrintAt: built.firstPrintAt,
    pricedBySource: built.pricedBySource,
    observedAt,
    ...(registry.stale ? { stale: true } : {}),
    ...(registry.error ? { error: registry.error } : {})
  };
}

function fromMarket(
  params: CandlesParams,
  observedAt: number,
  market: { candles: MarketCandle[]; source: string; error?: string },
  note: string
): FlowCandlesResponse {
  const candles = market.candles;
  return {
    ...params,
    candles,
    source: market.source,
    spanMs: spanOfCandles(candles),
    prints: candles.length,
    priced: candles.length,
    firstPrintAt: candles[0]?.time ?? null,
    pricedBySource: {},
    observedAt,
    error: market.error ? `${note}; ${market.error}` : note
  };
}

/** Pure handler: registry -> subscribe -> ring candles, else the market route's candles. Never throws. */
export async function buildFlowCandlesResponse(params: CandlesParams, deps: CandlesRouteDeps): Promise<FlowCandlesResponse> {
  const observedAt = deps.now();
  const registry = await loadRegistry(params, deps);
  const marketOf = deps.marketCandles;
  if ("failure" in registry) {
    const market = marketOf ? await marketOf(params).catch((error) => ({ candles: [] as MarketCandle[], source: "market", error: errorMessage(error) })) : null;
    if (market && market.candles.length > 0) {
      return fromMarket(params, observedAt, market, `own tape empty (untracked: ${registry.failure}); candles from ${market.source} (${MARKET_FALLBACK_INTERVAL})`);
    }
    return emptyCandles(params, observedAt, `untracked: ${registry.failure}`);
  }
  if (registry.pairs.length === 0) {
    const why = `untracked: no pairs known for this token${registry.error ? ` (${registry.error})` : ""}`;
    const market = marketOf ? await marketOf(params).catch((error) => ({ candles: [] as MarketCandle[], source: "market", error: errorMessage(error) })) : null;
    if (market && market.candles.length > 0) return fromMarket(params, observedAt, market, `own tape empty (${why}); candles from ${market.source} (${MARKET_FALLBACK_INTERVAL})`);
    return emptyCandles(params, observedAt, why);
  }
  // Launchpad pseudo-pairs are fed by the launch service; the collector must not poll Gecko or resolve pools for them (as in routes/flow.ts).
  deps.collector.subscribe(params.chain, params.address, registry.pairs.filter((pair) => !isLaunchpadRow(pair)));
  const built = candlesForToken(deps.collector.ledger, registry.pairs, params.chain, CANDLE_INTERVAL_MS[params.interval]);
  if (built.candles.length > 0) return fromOwnTape(params, observedAt, built, registry);
  const market = marketOf ? await marketOf(params).catch((error) => ({ candles: [] as MarketCandle[], source: "market", error: errorMessage(error) })) : null;
  if (market && market.candles.length > 0) {
    const tape = `own tape empty (${built.priced} priced of ${built.prints} ring prints)`;
    return fromMarket(params, observedAt, market, `${tape}; candles from ${market.source} (${MARKET_FALLBACK_INTERVAL})`);
  }
  return fromOwnTape(params, observedAt, built, registry);
}

export const flowCandlesRouter = Router();

flowCandlesRouter.get("/candles/:chain/:address", async (request, response, next) => {
  try {
    response.json(await buildFlowCandlesResponse(resolveCandlesParams(request.params, request.query), { ...liveDeps, marketCandles: defaultMarketCandles }));
  } catch (error) {
    next(error);
  }
});
