import { discoverSolana } from "../discover/solana.js";
import { Router } from "express";
import { z } from "zod";
import type { Chain, DiscoverResponse, DiscoverView, DiscoverWindow } from "../../shared/wire.js";
import { discoverRobinhood } from "../discover/robinhood.js";
import { errorMessage } from "../lib/http.js";

export const DISCOVER_VIEWS = ["trending", "movers", "new", "holders"] as const;
export const DISCOVER_WINDOWS = ["1h", "24h"] as const;
export const SOLANA_DISCOVER_ERROR = "solana views served by /api/onchain/*";

export const discoverParamsSchema = z.object({ chain: z.enum(["solana", "robinhood"]) });
export const discoverQuerySchema = z.object({ view: z.enum(DISCOVER_VIEWS).default("trending"), window: z.enum(DISCOVER_WINDOWS).default("24h") });

export type DiscoverQuery = { chain: Chain; view: DiscoverView; window: DiscoverWindow };

export type DiscoverRouteDeps = {
  robinhood: (view: DiscoverView, window: DiscoverWindow) => Promise<DiscoverResponse>;
  solana?: (view: DiscoverView, window: DiscoverWindow) => Promise<DiscoverResponse>;
  now: () => number;
};

export function resolveDiscoverQuery(params: unknown, query: unknown): DiscoverQuery {
  return { ...discoverParamsSchema.parse(params ?? {}), ...discoverQuerySchema.parse(query ?? {}) };
}

function emptyResponse(query: DiscoverQuery, observedAt: number, error: string): DiscoverResponse {
  return { chain: query.chain, view: query.view, window: query.window, rows: [], observedAt, sources: [], coverage: null, stale: true, error };
}

/** Always resolves to a DiscoverResponse: Solana answers the redirect error, a throwing builder answers rows [] + error. */
export async function buildDiscoverResponse(query: DiscoverQuery, deps: DiscoverRouteDeps): Promise<DiscoverResponse> {
  if (query.chain === "solana" && !deps.solana) return emptyResponse(query, deps.now(), SOLANA_DISCOVER_ERROR);
  try {
    return await (query.chain === "solana" ? deps.solana! : deps.robinhood)(query.view, query.window);
  } catch (error) {
    return emptyResponse(query, deps.now(), `discover: ${errorMessage(error)}`);
  }
}

export const discoverRouter = Router();

discoverRouter.get("/:chain", async (request, response, next) => {
  try {
    const query = resolveDiscoverQuery(request.params, request.query);
    response.json(await buildDiscoverResponse(query, { robinhood: discoverRobinhood, solana: discoverSolana, now: () => Date.now() }));
  } catch (error) {
    next(error);
  }
});
