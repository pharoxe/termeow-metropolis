import { Router } from "express";
import { z } from "zod";
import type { Chain, FlowCandleInterval, FlowCandlesResponse } from "../../shared/wire.js";
import { CANDLE_INTERVALS, CANDLE_INTERVAL_MS, OWN_TAPE_SOURCE, candlesForToken } from "../flow/candles.js";
import { isLaunchpadRow, type RegistryResult } from "../flow/registry.js";
import { errorMessage } from "../lib/http.js";
import { flowParamsSchema, liveDeps, type FlowRouteDeps } from "./flow.js";

/**
 * GET /api/flow/candles/:chain/:address?interval=5s|15s|1m — candles built only from own-tape ring prints that carry
 * a price. Reads the same registry and collector as /api/flow/token (liveDeps) so it never gathers anything twice;
 * always answers 200, with an `untracked:` error when the registry failed with nothing cached or knows no pair for the token.
 */
export const DEFAULT_CANDLE_INTERVAL: FlowCandleInterval = "15s";

export const candlesQuerySchema = z.object({ interval: z.enum(CANDLE_INTERVALS).default(DEFAULT_CANDLE_INTERVAL) });

export type CandlesParams = { chain: Chain; address: string; interval: FlowCandleInterval };

/** The subset of the flow route's dependencies this route needs (registry + collector + clock). */
export type CandlesRouteDeps = Pick<FlowRouteDeps, "registry" | "collector" | "now">;

/** Zod-validates params (same address rules as the flow route, Robinhood lowercased) and the interval query. */
export function resolveCandlesParams(params: unknown, query: unknown): CandlesParams {
  const { chain, address } = flowParamsSchema.parse(params);
  const { interval } = candlesQuerySchema.parse(query ?? {});
  return { chain, address, interval };
}

function emptyCandles(params: CandlesParams, observedAt: number, error: string): FlowCandlesResponse {
  return { ...params, candles: [], source: OWN_TAPE_SOURCE, spanMs: 0, prints: 0, priced: 0, firstPrintAt: null, pricedBySource: {}, observedAt, error };
}

async function loadRegistry(params: CandlesParams, deps: CandlesRouteDeps): Promise<RegistryResult | { failure: string }> {
  try {
    return await deps.registry(params.chain, params.address);
  } catch (error) {
    return { failure: errorMessage(error) };
  }
}

/** Pure handler: registry -> subscribe (same filter as the flow route) -> ring candles. Never throws. */
export async function buildFlowCandlesResponse(params: CandlesParams, deps: CandlesRouteDeps): Promise<FlowCandlesResponse> {
  const observedAt = deps.now();
  const registry = await loadRegistry(params, deps);
  if ("failure" in registry) return emptyCandles(params, observedAt, `untracked: ${registry.failure}`);
  if (registry.pairs.length === 0) return emptyCandles(params, observedAt, `untracked: no pairs known for this token${registry.error ? ` (${registry.error})` : ""}`);
  // Launchpad pseudo-pairs are fed by the launch service; the collector must not poll Gecko or resolve pools for them (as in routes/flow.ts).
  deps.collector.subscribe(params.chain, params.address, registry.pairs.filter((pair) => !isLaunchpadRow(pair)));
  const built = candlesForToken(deps.collector.ledger, registry.pairs, params.chain, CANDLE_INTERVAL_MS[params.interval]);
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

export const flowCandlesRouter = Router();

flowCandlesRouter.get("/candles/:chain/:address", async (request, response, next) => {
  try {
    response.json(await buildFlowCandlesResponse(resolveCandlesParams(request.params, request.query), liveDeps));
  } catch (error) {
    next(error);
  }
});
