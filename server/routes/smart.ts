import { Router } from "express";
import { z } from "zod";
import type { Chain, SmartBoardResponse, SmartBoardRow, SmartCoverage, SmartFill, SmartTapeResponse } from "../../shared/wire.js";
import { getLaunchService } from "../launch/service.js";
import { errorMessage } from "../lib/http.js";
import type { ChainScope, RankOptions, TapeOptions, TraderRow, TraderTapeRow } from "../traders/book.js";
import { emptyCoverage } from "../traders/coverage.js";
import { profileUrlFor as nansenProfileUrl, type HandleEntry } from "../traders/handles.js";
import { SMART_POPULATION_LABEL, TAPE_KINDS, getTraderService, toSmartFill, type TraderServiceStatus } from "../traders/service.js";

export const SMART_TAPE_DEFAULT = 60;
export const SMART_TAPE_MAX = 200;
export const SMART_BOARD_WINDOWS = ["1h", "24h", "7d"] as const;
const HOUR_MS = 3_600_000;
export const SMART_WINDOW_MS: Record<(typeof SMART_BOARD_WINDOWS)[number], number> = { "1h": HOUR_MS, "24h": 24 * HOUR_MS, "7d": 7 * 24 * HOUR_MS };

const chainSchema = z.enum(["all", "monad"]).default("all");
export const smartTapeQuerySchema = z.object({ chain: chainSchema, limit: z.coerce.number().int().min(1).max(SMART_TAPE_MAX).default(SMART_TAPE_DEFAULT) });
export const smartBoardQuerySchema = z.object({ chain: chainSchema, window: z.enum(SMART_BOARD_WINDOWS).default("24h") });

export type SmartTapeQuery = z.infer<typeof smartTapeQuerySchema>;
export type SmartBoardQuery = z.infer<typeof smartBoardQuerySchema>;

/** The slice of TraderService the routes read; tests inject a fake. */
export type SmartTradersLike = {
  book: {
    tape(chain: ChainScope, limit: number, opts?: TapeOptions): TraderTapeRow[];
    rank(chain: ChainScope, windowMs: number, opts?: RankOptions): TraderRow[];
    oldestFillAt(): number | null;
  };
  population: { size: number };
  handles: { get(address: string): HandleEntry | null; stats(): { entries: number } };
  /** R5: watched-vs-population coverage, computed once in TraderService.coverage(). */
  coverage(): SmartCoverage;
  dexOf(chain: Chain, pair: string): string;
  status(): TraderServiceStatus;
};

/** GET /api/smart/status: the trader service as it stands (counters incl. deadlined/late/classifyFailed, paced-RPC 429s); null status + error when it throws. Server-only shape, no client consumer. */
export type SmartStatusResponse = { status: TraderServiceStatus | null; observedAt: number; stale?: boolean; error?: string };

export type SmartRouteDeps = {
  traders: SmartTradersLike;
  /** Token symbol when something on this server knows it (launch index); null otherwise. */
  symbolOf?: (chain: Chain, token: string) => string | null;
  now: () => number;
};

function profileUrlFor(traders: SmartTradersLike, row: TraderRow): string | null {
  const entry = traders.handles.get(row.wallet);
  if (entry?.profileUrl) return entry.profileUrl;
  return nansenProfileUrl(row.wallet);
}

export function toBoardRow(traders: SmartTradersLike, row: TraderRow): SmartBoardRow {
  return {
    chain: row.chain,
    wallet: row.wallet,
    handle: row.handle,
    followers: row.followers,
    fills: row.fills,
    buyUsd: row.buyUsd,
    sellUsd: row.sellUsd,
    netUsd: row.netUsd,
    unpriced: row.unpriced,
    closed: row.closed,
    wins: row.wins,
    wilsonLow: row.wilsonLow,
    lastSeenAt: row.lastSeenAt,
    profileUrl: profileUrlFor(traders, row),
    kind: row.kind
  };
}

function tapeFills(deps: SmartRouteDeps, query: SmartTapeQuery): SmartFill[] {
  return deps.traders.book.tape(query.chain, query.limit, { kind: TAPE_KINDS }).map((row) => {
    const followers = deps.traders.handles.get(row.trader)?.followers ?? null;
    return toSmartFill(row, deps.traders.dexOf(row.chain, row.pair), followers, deps.symbolOf?.(row.chain, row.token) ?? null);
  });
}

/** Pure handler: always resolves to a SmartTapeResponse; a throwing book yields an empty tape plus `error`. */
export function buildSmartTapeResponse(query: SmartTapeQuery, deps: SmartRouteDeps): SmartTapeResponse {
  const observedAt = deps.now();
  const base = { chain: query.chain, observedAt };
  try {
    return { ...base, fills: tapeFills(deps, query), population: deps.traders.population.size, handles: deps.traders.handles.stats().entries, coverage: deps.traders.coverage() };
  } catch (error) {
    return { ...base, fills: [], population: 0, handles: 0, coverage: emptyCoverage(), stale: true, error: `tape: ${errorMessage(error)}` };
  }
}

/** A window reaching past the oldest fill in the ring is truncated, not lifetime: say so instead of showing smaller numbers as totals. */
export function truncatedAt(oldest: number | null, windowMs: number, now: number): number | null {
  return oldest !== null && oldest > now - windowMs ? oldest : null;
}

/** Pure handler: rank by netUsd over the window, SMART and seeded kinds (each row says which); failure keeps the 200 + error contract. */
export function buildSmartBoardResponse(query: SmartBoardQuery, deps: SmartRouteDeps): SmartBoardResponse {
  const observedAt = deps.now();
  const windowMs = SMART_WINDOW_MS[query.window];
  const base = { chain: query.chain, window: query.window, populationLabel: SMART_POPULATION_LABEL, observedAt };
  try {
    const rows = deps.traders.book.rank(query.chain, windowMs, { kind: TAPE_KINDS }).map((row) => toBoardRow(deps.traders, row));
    return { ...base, rows, population: deps.traders.population.size, truncatedAt: truncatedAt(deps.traders.book.oldestFillAt(), windowMs, observedAt), coverage: deps.traders.coverage() };
  } catch (error) {
    return { ...base, rows: [], population: 0, truncatedAt: null, coverage: emptyCoverage(), stale: true, error: `board: ${errorMessage(error)}` };
  }
}

/** Pure handler: the service's status() verbatim so "population grows, fills stay 0" is explainable from the wire. */
export function buildSmartStatusResponse(deps: SmartRouteDeps): SmartStatusResponse {
  const observedAt = deps.now();
  try {
    return { status: deps.traders.status(), observedAt };
  } catch (error) {
    return { status: null, observedAt, stale: true, error: `status: ${errorMessage(error)}` };
  }
}

function liveDeps(): SmartRouteDeps {
  return {
    traders: getTraderService(),
    symbolOf: (chain, token) => getLaunchService().index.get(chain, token)?.symbol ?? getTraderService().erc20Meta.get(token)?.symbol ?? null,
    now: () => Date.now()
  };
}

export const smartRouter = Router();

smartRouter.get("/tape", (request, response, next) => {
  try {
    response.json(buildSmartTapeResponse(smartTapeQuerySchema.parse(request.query ?? {}), liveDeps()));
  } catch (error) {
    next(error);
  }
});

smartRouter.get("/board", (request, response, next) => {
  try {
    response.json(buildSmartBoardResponse(smartBoardQuerySchema.parse(request.query ?? {}), liveDeps()));
  } catch (error) {
    next(error);
  }
});

smartRouter.get("/status", (_request, response, next) => {
  try {
    response.json(buildSmartStatusResponse(liveDeps()));
  } catch (error) {
    next(error);
  }
});

smartRouter.get("/handles", async (request, response, next) => {
  try {
    const limit = z.coerce.number().int().min(1).max(500).default(200).parse(request.query.limit ?? 200);
    const handles = getTraderService().handles;
    if (!handles.directory) throw new Error("Handle directory unavailable");
    if (handles.stats().entries === 0 && handles.refresh) await handles.refresh();
    else if (handles.refresh) void handles.refresh();
    response.json({ source: "nansen + watchlist", observedAt: Date.now(), entries: handles.directory(limit).map((entry) => ({ ...entry, chain: "monad" as const })) });
  } catch (error) {
    next(error);
  }
});
