import { Router } from "express";
import { z } from "zod";
import type { LaunchRow, LaunchesResponse } from "../../shared/wire.js";
import { getLaunchService, type LaunchSourceHealth } from "../launch/service.js";
import type { LaunchListQuery } from "../launch/index.js";
import { errorMessage } from "../lib/http.js";

export const LAUNCH_WINDOWS = ["1h", "6h", "24h"] as const;
export const LAUNCHES_LIMIT = 300;
const HOUR_MS = 3_600_000;
const WINDOW_MS: Record<LaunchWindow, number> = { "1h": HOUR_MS, "6h": 6 * HOUR_MS, "24h": 24 * HOUR_MS };

export type LaunchWindow = (typeof LAUNCH_WINDOWS)[number];

/** `stocks` hides robinhoodtrenches-flagged tokenised stocks by default; `pad` matches the row's launchpad exactly. */
export const launchesQuerySchema = z.object({
  chain: z.enum(["all", "solana", "robinhood"]).default("all"),
  window: z.enum(LAUNCH_WINDOWS).default("24h"),
  pad: z.string().trim().min(1).max(40).optional(),
  stocks: z.enum(["0", "1"]).default("0")
});

export type LaunchesQuery = z.infer<typeof launchesQuerySchema>;

export type LaunchesRouteDeps = {
  service: { list(query: LaunchListQuery): LaunchRow[]; status(): { sources: LaunchSourceHealth[] } };
  now: () => number;
};

export function resolveLaunchesQuery(query: unknown): LaunchesQuery {
  return launchesQuerySchema.parse(query ?? {});
}

export function toListQuery(query: LaunchesQuery): LaunchListQuery {
  return {
    chain: query.chain,
    windowMs: WINDOW_MS[query.window],
    ...(query.pad !== undefined ? { pad: query.pad } : {}),
    includeStocks: query.stocks === "1",
    limit: LAUNCHES_LIMIT
  };
}

function safeSources(deps: LaunchesRouteDeps): { sources: LaunchSourceHealth[]; failure?: string } {
  try {
    return { sources: deps.service.status().sources };
  } catch (error) {
    return { sources: [], failure: `status: ${errorMessage(error)}` };
  }
}

/** Pure handler: always resolves to a LaunchesResponse; a failing service yields an empty list plus `error`. */
export function buildLaunchesResponse(query: LaunchesQuery, deps: LaunchesRouteDeps): LaunchesResponse {
  const observedAt = deps.now();
  const status = safeSources(deps);
  const base = { window: query.window, chain: query.chain, observedAt, sources: status.sources };
  try {
    const launches = deps.service.list(toListQuery(query));
    const truncated = launches.length >= LAUNCHES_LIMIT ? { truncated: true } : {};
    return { launches, ...base, ...truncated, ...(status.failure ? { error: status.failure } : {}) };
  } catch (error) {
    const failure = [`list: ${errorMessage(error)}`, status.failure].filter((message): message is string => Boolean(message)).join("; ");
    return { launches: [], ...base, stale: true, error: failure };
  }
}

export const launchesRouter = Router();

launchesRouter.get("/", (request, response, next) => {
  try {
    const query = resolveLaunchesQuery(request.query);
    response.json(buildLaunchesResponse(query, { service: getLaunchService(), now: () => Date.now() }));
  } catch (error) {
    next(error);
  }
});
