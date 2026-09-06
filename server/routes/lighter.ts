import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { LighterBook, LighterFlowResponse, LighterMarketsResponse, LighterTradesResponse } from "../../shared/wire.js";
import { FLOW_INTERVALS } from "../flow/aggregate.js";
import { getLighterService, type LighterService } from "../lighter/service.js";

export const LIGHTER_FLOW_SOURCE = "lighter";
export const LIGHTER_FLOW_INTERVALS = ["1m", "5m", "15m", "1h"] as const satisfies ReadonlyArray<(typeof FLOW_INTERVALS)[number]>;
const MAX_MARKET_ID = 1_000_000;
const MAX_DEPTH = 25;
const MAX_TRADES = 500;

/** The service surface the router needs; tests inject a fake, production resolves the lazy singleton per request. */
export type LighterServiceLike = Pick<LighterService, "markets" | "book" | "trades" | "flow" | "funding">;

export const marketIdSchema = z.object({ marketId: z.coerce.number().int().nonnegative().max(MAX_MARKET_ID) });
export const bookQuerySchema = z.object({ depth: z.coerce.number().int().min(1).max(MAX_DEPTH).default(20) });
export const tradesQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(MAX_TRADES).default(50) });
export const flowQuerySchema = z.object({ interval: z.enum(LIGHTER_FLOW_INTERVALS).default("1m") });

type Parsed<T> = { ok: true; value: T } | { ok: false };

/** Validation failures are 400s; upstream failures stay 200 + error (the service never throws). */
function parse<T>(schema: z.ZodType<T>, input: unknown, response: Response): Parsed<T> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return { ok: true, value: result.data };
  response.status(400).json({ error: "Invalid request", issues: result.error.issues });
  return { ok: false };
}

function joinErrors(...messages: Array<string | undefined>): string | undefined {
  const present = messages.filter((message): message is string => Boolean(message));
  return present.length ? present.join("; ") : undefined;
}

/** Flow bars/windows plus the latest funding print in one envelope; stale/error are the union of both reads. */
export async function buildLighterFlow(service: LighterServiceLike, marketId: number, interval: string): Promise<LighterFlowResponse> {
  const [flow, funding] = await Promise.all([service.flow(marketId, interval), service.funding(marketId)]);
  const error = joinErrors(flow.error, funding.error ? `funding: ${funding.error}` : undefined);
  const stale = Boolean(flow.stale || funding.stale);
  return {
    marketId,
    interval,
    bars: flow.bars,
    windows: flow.windows,
    coverage: flow.coverage,
    funding: funding.funding,
    observedAt: flow.observedAt,
    source: LIGHTER_FLOW_SOURCE,
    ...(stale ? { stale: true } : {}),
    ...(error ? { error } : {})
  };
}

/** Every market route touches the service, which subscribes the websocket lazily and bootstraps the ledger once. */
export function createLighterRouter(resolve: () => LighterServiceLike): Router {
  const router = Router();

  router.get("/markets", async (_request: Request, response: Response, next) => {
    try {
      const result: LighterMarketsResponse = await resolve().markets();
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:marketId/book", async (request, response, next) => {
    try {
      const params = parse(marketIdSchema, request.params, response);
      if (!params.ok) return;
      const query = parse(bookQuerySchema, request.query, response);
      if (!query.ok) return;
      const book: LighterBook = await resolve().book(params.value.marketId, query.value.depth);
      response.json(book);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:marketId/trades", async (request, response, next) => {
    try {
      const params = parse(marketIdSchema, request.params, response);
      if (!params.ok) return;
      const query = parse(tradesQuerySchema, request.query, response);
      if (!query.ok) return;
      const trades: LighterTradesResponse = await resolve().trades(params.value.marketId, query.value.limit);
      response.json(trades);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:marketId/flow", async (request, response, next) => {
    try {
      const params = parse(marketIdSchema, request.params, response);
      if (!params.ok) return;
      const query = parse(flowQuerySchema, request.query, response);
      if (!query.ok) return;
      response.json(await buildLighterFlow(resolve(), params.value.marketId, query.value.interval));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const lighterRouter = createLighterRouter(getLighterService);
