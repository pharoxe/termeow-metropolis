import { Router } from "express";
import { z } from "zod";
import type { Chain, FomoBoardResponse, FomoBoardRow, FomoCoverage, FomoFill, FomoTapeResponse } from "../../shared/wire.js";
import { getLaunchService } from "../launch/service.js";
import { errorMessage } from "../lib/http.js";
import type { ChainScope, RankOptions, TapeOptions, TraderRow, TraderTapeRow } from "../traders/book.js";
import { emptyCoverage } from "../traders/coverage.js";
import { FOMO_PROFILE_BASE, type HandleEntry } from "../traders/handles.js";
import { FOMO_POPULATION_LABEL, TAPE_KINDS, getTraderService, toFomoFill, type TraderServiceStatus } from "../traders/service.js";
import { identityRegistry } from "../terminal/identityStore.js";
import type { TraderIdentity } from "../../shared/identity.js";

export const FOMO_TAPE_DEFAULT = 60;
export const FOMO_TAPE_MAX = 200;
export const FOMO_BOARD_WINDOWS = ["1h", "24h", "7d"] as const;
const HOUR_MS = 3_600_000;
export const FOMO_WINDOW_MS: Record<(typeof FOMO_BOARD_WINDOWS)[number], number> = { "1h": HOUR_MS, "24h": 24 * HOUR_MS, "7d": 7 * 24 * HOUR_MS };

const chainSchema = z.enum(["all", "solana", "robinhood"]).default("all");
export const fomoTapeQuerySchema = z.object({ chain: chainSchema, limit: z.coerce.number().int().min(1).max(FOMO_TAPE_MAX).default(FOMO_TAPE_DEFAULT) });
export const fomoBoardQuerySchema = z.object({ chain: chainSchema, window: z.enum(FOMO_BOARD_WINDOWS).default("24h") });

export type FomoTapeQuery = z.infer<typeof fomoTapeQuerySchema>;
export type FomoBoardQuery = z.infer<typeof fomoBoardQuerySchema>;

/** The slice of TraderService the routes read; tests inject a fake. */
export type FomoTradersLike = {
  book: {
    tape(chain: ChainScope, limit: number, opts?: TapeOptions): TraderTapeRow[];
    rank(chain: ChainScope, windowMs: number, opts?: RankOptions): TraderRow[];
    oldestFillAt(): number | null;
  };
  population: { size: number };
  handles: { get(address: string): HandleEntry | null; stats(): { entries: number } };
  /** R5: watched-vs-population coverage, computed once in TraderService.coverage(). */
  coverage(): FomoCoverage;
  dexOf(chain: Chain, pair: string): string;
  status(): TraderServiceStatus;
};

/** GET /api/fomo/status: the trader service as it stands (counters incl. deadlined/late/classifyFailed, paced-RPC 429s); null status + error when it throws. Server-only shape, no client consumer. */
export type FomoStatusResponse = { status: TraderServiceStatus | null; observedAt: number; stale?: boolean; error?: string };

export type FomoRouteDeps = {
  traders: FomoTradersLike;
  /** Token symbol when something on this server knows it (launch index); null otherwise. */
  symbolOf?: (chain: Chain, token: string) => string | null;
  now: () => number;
  identityOf?: (chain: Chain, wallet: string) => TraderIdentity | null;
};

function profileUrlFor(traders: FomoTradersLike, row: TraderRow): string | null {
  const entry = traders.handles.get(row.wallet);
  if (entry?.profileUrl) return entry.profileUrl;
  return row.handle ? `${FOMO_PROFILE_BASE}${encodeURIComponent(row.handle)}` : null;
}

export function toBoardRow(traders: FomoTradersLike, row: TraderRow): FomoBoardRow {
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

function tapeFills(deps: FomoRouteDeps, query: FomoTapeQuery): FomoFill[] {
  return deps.traders.book.tape(query.chain, query.limit, { kind: TAPE_KINDS }).map((row) => {
    const followers = deps.traders.handles.get(row.trader)?.followers ?? null;
    const fill = toFomoFill(row, deps.traders.dexOf(row.chain, row.pair), followers, deps.symbolOf?.(row.chain, row.token) ?? null);
    const identity = deps.identityOf?.(row.chain, row.trader);
    return identity ? { ...fill, trader: {
      ...fill.trader, kind: fill.trader.kind === "other" ? "fomo" : fill.trader.kind,
      handle: identity.handle ?? fill.trader.handle, followers: identity.followers ?? fill.trader.followers,
      displayName: identity.displayName, twitter: identity.twitter, avatarUrl: identity.avatarUrl
    } } : fill;
  });
}

/** Pure handler: always resolves to a FomoTapeResponse; a throwing book yields an empty tape plus `error`. */
export function buildFomoTapeResponse(query: FomoTapeQuery, deps: FomoRouteDeps): FomoTapeResponse {
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

/** Pure handler: rank by netUsd over the window, FOMO and seeded kinds (each row says which); failure keeps the 200 + error contract. */
export function buildFomoBoardResponse(query: FomoBoardQuery, deps: FomoRouteDeps): FomoBoardResponse {
  const observedAt = deps.now();
  const windowMs = FOMO_WINDOW_MS[query.window];
  const base = { chain: query.chain, window: query.window, populationLabel: FOMO_POPULATION_LABEL, observedAt };
  try {
    const rows = deps.traders.book.rank(query.chain, windowMs, { kind: TAPE_KINDS }).map((row) => toBoardRow(deps.traders, row));
    return { ...base, rows, population: deps.traders.population.size, truncatedAt: truncatedAt(deps.traders.book.oldestFillAt(), windowMs, observedAt), coverage: deps.traders.coverage() };
  } catch (error) {
    return { ...base, rows: [], population: 0, truncatedAt: null, coverage: emptyCoverage(), stale: true, error: `board: ${errorMessage(error)}` };
  }
}

/** Pure handler: the service's status() verbatim so "population grows, fills stay 0" is explainable from the wire. */
export function buildFomoStatusResponse(deps: FomoRouteDeps): FomoStatusResponse {
  const observedAt = deps.now();
  try {
    return { status: deps.traders.status(), observedAt };
  } catch (error) {
    return { status: null, observedAt, stale: true, error: `status: ${errorMessage(error)}` };
  }
}

function liveDeps(): FomoRouteDeps {
  return {
    traders: getTraderService(),
    symbolOf: (chain, token) => getLaunchService().index.get(chain, token)?.symbol ?? (chain === "robinhood" ? (getTraderService().erc20Meta.get(token)?.symbol ?? null) : null),
    identityOf: (chain, wallet) => identityRegistry.lookup(chain, wallet),
    now: () => Date.now()
  };
}

export const fomoRouter = Router();

fomoRouter.get("/tape", (request, response, next) => {
  try {
    response.json(buildFomoTapeResponse(fomoTapeQuerySchema.parse(request.query ?? {}), liveDeps()));
  } catch (error) {
    next(error);
  }
});

fomoRouter.get("/board", (request, response, next) => {
  try {
    response.json(buildFomoBoardResponse(fomoBoardQuerySchema.parse(request.query ?? {}), liveDeps()));
  } catch (error) {
    next(error);
  }
});

fomoRouter.get("/status", (_request, response, next) => {
  try {
    response.json(buildFomoStatusResponse(liveDeps()));
  } catch (error) {
    next(error);
  }
});
