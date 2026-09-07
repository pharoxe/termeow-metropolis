import { Router } from "express";
import { z } from "zod";
import type { AlertEngineStats, AlertRow, AlertsResponse, FomoCoverage } from "../../shared/wire.js";
import { getAlertEngine, liveAlertsRouteDeps } from "../alerts/live.js";
import type { AlertListQuery } from "../alerts/ring.js";
import { ALERT_RULE_NAMES, rulesFor } from "../alerts/rules.js";
import { errorMessage } from "../lib/http.js";
import { emptyCoverage } from "../traders/coverage.js";

export const ALERTS_DEFAULT = 200;
export const ALERTS_MAX = 500;

/** `since` = the client's last observedAt (wall clock ms); `rule` narrows to one rule; chain defaults to all. */
export const alertsQuerySchema = z.object({
  chain: z.enum(["all", "solana", "robinhood"]).default("all"),
  since: z.coerce.number().int().min(0).optional(),
  rule: z.enum(ALERT_RULE_NAMES).optional(),
  limit: z.coerce.number().int().min(1).max(ALERTS_MAX).default(ALERTS_DEFAULT)
});

export type AlertsQuery = z.infer<typeof alertsQuerySchema>;

/** The slice of the engine and trader service the route reads; tests inject fakes. */
export type AlertsRouteDeps = {
  engine: { list(query: AlertListQuery): AlertRow[]; ring: { size(): { size: number; max: number } }; stats(): AlertEngineStats };
  coverage(): FomoCoverage;
  now: () => number;
};

/** Pure handler: newest first; a throwing engine yields an empty list plus `error` (200 + stale contract). */
export function buildAlertsResponse(query: AlertsQuery, deps: AlertsRouteDeps): AlertsResponse {
  const observedAt = deps.now();
  const base = { chain: query.chain, observedAt, rules: rulesFor(query.chain) };
  try {
    const alerts = deps.engine.list({ chain: query.chain, since: query.since, rule: query.rule, limit: query.limit });
    return { ...base, alerts, ring: deps.engine.ring.size(), coverage: deps.coverage(), engine: deps.engine.stats() };
  } catch (error) {
    return { ...base, alerts: [], ring: { size: 0, max: 0 }, coverage: emptyCoverage(), engine: null, stale: true, error: `alerts: ${errorMessage(error)}` };
  }
}

/** Router over injected deps; `getDeps` runs per request so the live singletons are read fresh. */
export function createAlertsRouter(getDeps: () => AlertsRouteDeps): Router {
  const router = Router();
  router.get("/", (request, response, next) => {
    try {
      response.json(buildAlertsResponse(alertsQuerySchema.parse(request.query ?? {}), getDeps()));
    } catch (error) {
      next(error);
    }
  });
  return router;
}

/** Mounted by server/index.ts: subscribes the live engine to the sink at mount time, so alerts accrue before the tab is first opened. */
export function liveAlertsRouter(): Router {
  getAlertEngine();
  return createAlertsRouter(liveAlertsRouteDeps);
}
