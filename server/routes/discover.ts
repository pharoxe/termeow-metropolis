import { Router } from "express";
import { z } from "zod";
import type { Chain, DiscoverResponse, DiscoverView, DiscoverWindow } from "../../shared/wire.js";
import { discoverMonad } from "../discover/monad.js";
import { errorMessage } from "../lib/http.js";

export const DISCOVER_VIEWS = ["trending", "movers", "new", "holders"] as const;
export const DISCOVER_WINDOWS = ["1h", "24h"] as const;

export const discoverParamsSchema = z.object({ chain: z.literal("monad") });
export const discoverQuerySchema = z.object({ view: z.enum(DISCOVER_VIEWS).default("trending"), window: z.enum(DISCOVER_WINDOWS).default("24h") });

export type DiscoverQuery = { chain: Chain; view: DiscoverView; window: DiscoverWindow };

export type DiscoverRouteDeps = {
  monad: (view: DiscoverView, window: DiscoverWindow) => Promise<DiscoverResponse>;
  now: () => number;
};

export function resolveDiscoverQuery(params: unknown, query: unknown): DiscoverQuery {
  return { ...discoverParamsSchema.parse(params ?? {}), ...discoverQuerySchema.parse(query ?? {}) };
}

function emptyResponse(query: DiscoverQuery, observedAt: number, error: string): DiscoverResponse {
  return { chain: query.chain, view: query.view, window: query.window, rows: [], observedAt, sources: [], coverage: null, stale: true, error };
}

/** Always resolves to a DiscoverResponse: a throwing builder answers rows [] + error. */
export async function buildDiscoverResponse(query: DiscoverQuery, deps: DiscoverRouteDeps): Promise<DiscoverResponse> {
  try {
    return await deps.monad(query.view, query.window);
  } catch (error) {
    return emptyResponse(query, deps.now(), `discover: ${errorMessage(error)}`);
  }
}

export const discoverRouter = Router();

discoverRouter.get("/:chain", async (request, response, next) => {
  try {
    const query = resolveDiscoverQuery(request.params, request.query);
    response.json(await buildDiscoverResponse(query, { monad: discoverMonad, now: () => Date.now() }));
  } catch (error) {
    next(error);
  }
});
