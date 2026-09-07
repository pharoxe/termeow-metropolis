import { Router } from "express";
import { z } from "zod";
import type { Chain, FeedHealth, FlowBar, FomoCoverage, FomoFill, PairRow, TapePrint, TokenFlowFomo, TokenFlowResponse } from "../../shared/wire.js";
import { peekMarketProvider } from "../clawpump/market.js";
import {
  FLOW_INTERVALS,
  flowWindows,
  intervalToMs,
  largePrints,
  sinceAnchor,
  tokenFlow,
  type FlowAnchor,
  type FlowInterval
} from "../flow/aggregate.js";
import { flowCollector } from "../flow/collector.js";
import { allSourcesDown } from "../flow/feedHealth.js";
import { FOMO_MERGE_LIMIT, fomoWindowsFromFills, ledgerFomoFills, mergeFomoFills, type FomoLedgerLike } from "../flow/fomoFills.js";
import { FlowLedger } from "../flow/ledger.js";
import { priceOf } from "../flow/printPrice.js";
import { getRegistry, isLaunchpadRow, type RegistryResult } from "../flow/registry.js";
import { sourceChips, type SourcesLike } from "../flow/sources.js";
import { getLaunchService } from "../launch/service.js";
import { errorMessage } from "../lib/http.js";
import { getTokenPairs, sumTxns } from "../sources/dexscreener.js";
import { getTraderService } from "../traders/service.js";
import { geckoTokenPools } from "../sources/gecko.js";
import { pumpPoolFor } from "../sources/pumpfun.js";

export const FLOW_SOURCE = "pumpfun+geckoterminal→ledger";
export const DEFAULT_BAR_COUNT = 300;
export const SESSION_START_MS = Date.now();
export const TAPE_LIMIT = 40;
export const FOMO_TAPE_LIMIT = 40;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const FLOW_ANCHORS = ["window", "session", "launch"] as const;

/** Robinhood addresses are lowercased here, matching how the registry and DexScreener caches key them. */
export const flowParamsSchema = z.discriminatedUnion("chain", [
  z.object({ chain: z.literal("solana"), address: z.string().regex(SOLANA_ADDRESS) }),
  z.object({ chain: z.literal("robinhood"), address: z.string().regex(EVM_ADDRESS).transform((address) => address.toLowerCase()) })
]);

export const flowQuerySchema = z.object({
  interval: z.enum(FLOW_INTERVALS).default("5m"),
  anchor: z.enum(FLOW_ANCHORS).default("window"),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional()
});

const windowSchema = z
  .object({ fromMs: z.number(), toMs: z.number() })
  .refine((window) => window.fromMs < window.toMs, { error: "from must be before to" });

export type FlowParams = {
  chain: Chain;
  address: string;
  interval: FlowInterval;
  anchor: FlowAnchor;
  fromMs: number;
  toMs: number;
};

export type FlowCollectorLike = {
  ledger: FlowLedger;
  subscribe(chain: Chain, address: string, pairs: PairRow[]): void;
  launchMs(chain: Chain, address: string): number | null;
  /** Optional: FlowCollector.status() narrowed to the source health the response condenses into chips, plus R6 feedHealth. */
  status?(chain: Chain, address: string): { sources: SourcesLike; feedHealth?: FeedHealth };
  /** Optional: last registry rows the collector saw for this token (kept after eviction), so a registry outage can still serve the ring. */
  pairsOf?(chain: Chain, address: string): PairRow[] | null;
};

/** The slice of TraderService the FOMO block reads; absent means no FOMO block (tests, or the service not wired). */
export type FlowTradersLike = {
  /** Token-keyed book fills (pools and "fomo:<token>"), newest first, with symbol/handle/price when known. */
  fillsForToken(chain: Chain, token: string, limit: number): FomoFill[];
  fomoLedger: FomoLedgerLike;
  population: { size: number };
  handles: { stats(): { entries: number } };
  /** R5: watched-vs-population coverage, computed once in TraderService.coverage(). */
  coverage(): FomoCoverage;
  dexOf(chain: Chain, pair: string): string;
};

export type FlowRouteDeps = {
  registry: (chain: Chain, address: string) => Promise<RegistryResult>;
  collector: FlowCollectorLike;
  sessionStartMs: number;
  now: () => number;
  traders?: FlowTradersLike;
};

/** Zod-validates route params and query; `to` defaults to now, `from` to DEFAULT_BAR_COUNT bars earlier. */
export function resolveFlowParams(params: unknown, query: unknown, now = Date.now()): FlowParams {
  const { chain, address } = flowParamsSchema.parse(params);
  const parsed = flowQuerySchema.parse(query ?? {});
  const toMs = parsed.to ?? now;
  const fromMs = parsed.from ?? toMs - DEFAULT_BAR_COUNT * intervalToMs(parsed.interval);
  const window = windowSchema.parse({ fromMs, toMs });
  return { chain, address, interval: parsed.interval, anchor: parsed.anchor, ...window };
}

const EMPTY_COUNTS: TokenFlowResponse["counts"] = { m5: null, h1: null, h6: null, h24: null };

function emptyResponse(params: FlowParams, observedAt: number, error: string): TokenFlowResponse {
  return {
    chain: params.chain,
    address: params.address,
    interval: params.interval,
    anchor: params.anchor,
    bars: [],
    pairs: [],
    coverage: { fraction: 0, firstPrintAt: null, volumeShare: null, tierAPairs: 0, totalPairs: 0 },
    counts: EMPTY_COUNTS,
    observedAt,
    source: FLOW_SOURCE,
    error
  };
}

/** Registry, or the collector's remembered rows marked stale when the registry throws; `failure` only when neither exists. */
async function loadRegistry(params: FlowParams, deps: FlowRouteDeps): Promise<RegistryResult | { failure: string }> {
  try {
    return await deps.registry(params.chain, params.address);
  } catch (error) {
    const failure = errorMessage(error);
    const remembered = deps.collector.pairsOf?.(params.chain, params.address);
    if (!remembered?.length) return { failure };
    return { pairs: remembered, observedAt: deps.now(), stale: true, error: `registry: ${failure} (last-known pairs)` };
  }
}

/** Anchor start the side outputs sum from: window → first bar, session → session start, launch → known launch or null. */
function anchorStart(params: FlowParams, bars: FlowBar[], deps: FlowRouteDeps): number | null {
  if (params.anchor === "session") return deps.sessionStartMs;
  if (params.anchor === "launch") return deps.collector.launchMs(params.chain, params.address);
  return bars[0]?.t ?? null;
}

type SideOutputs = Pick<TokenFlowResponse, "windows" | "largePrints" | "sinceAnchor" | "sources" | "tape" | "feedHealth" | "fomo">;

/**
 * FOMO and seeded fills of this token, newest first: the token-keyed book merged with the pair-keyed FOMO ledger rings
 * (Tier A pairs + "fomo:<token>"), one row per tx+wallet, plus windows summed over the verified-FOMO subset of that
 * deduped list (seeded rows are tagged on `fills`, never folded into the cohort totals). Robinhood only (the designator
 * check is eth_getCode); populations are "seen by this server".
 */
export function fomoBlock(traders: FlowTradersLike, params: FlowParams, pairs: PairRow[], observedAt: number): TokenFlowFomo {
  const dexByPair = new Map(pairs.map((pair) => [pair.pairAddress, pair.dex]));
  const dexOf = (pair: string) => dexByPair.get(pair) ?? traders.dexOf(params.chain, pair);
  const fromBook = traders.fillsForToken(params.chain, params.address, FOMO_MERGE_LIMIT).map((fill) => ({ ...fill, dex: dexByPair.get(fill.pair) ?? fill.dex }));
  const merged = mergeFomoFills(fromBook, ledgerFomoFills(traders.fomoLedger, params.chain, params.address, pairs, dexOf));
  return { fills: merged.slice(0, FOMO_TAPE_LIMIT), windows: fomoWindowsFromFills(merged.filter((fill) => fill.trader.kind === "fomo"), observedAt), population: traders.population.size, handles: traders.handles.stats().entries, coverage: traders.coverage() };
}

/** Newest Tier A prints across pairs from the ledger ring, dex from the PairRow, time desc, at most `limit`. Unpriced prints keep usd null. */
export function recentTape(ledger: FlowLedger, chain: Chain, pairs: PairRow[], limit = TAPE_LIMIT): TapePrint[] {
  const out: TapePrint[] = [];
  for (const pair of pairs) {
    if (pair.tier !== "A") continue;
    for (const print of ledger.recentPrints(chain, pair.pairAddress, limit)) {
      out.push({ pair: print.pair, dex: pair.dex, tx: print.tx, time: print.time, side: print.side, usd: print.usd, source: print.source, ...(print.trader ? { trader: print.trader } : {}), ...priceOf(print) });
    }
  }
  return out.sort((a, b) => b.time - a.time).slice(0, Math.max(0, limit));
}

/** Windows and large prints are Tier A only; windows end at observedAt, sinceAnchor ends at params.toMs. */
function sideOutputs(params: FlowParams, pairs: PairRow[], bars: FlowBar[], deps: FlowRouteDeps, observedAt: number): SideOutputs {
  const { ledger } = deps.collector;
  const status = deps.collector.status?.(params.chain, params.address);
  return {
    windows: flowWindows(ledger, params.chain, pairs, observedAt),
    largePrints: largePrints(ledger, params.chain, pairs),
    sinceAnchor: sinceAnchor(ledger, params.chain, pairs, anchorStart(params, bars, deps), params.toMs),
    tape: recentTape(ledger, params.chain, pairs),
    ...(status ? { sources: sourceChips(status.sources) } : {}),
    ...(status?.feedHealth ? { feedHealth: status.feedHealth } : {}),
    ...(deps.traders && params.chain === "robinhood" ? { fomo: fomoBlock(deps.traders, params, pairs, observedAt) } : {})
  };
}

/** sideOutputs never throws today; this guard keeps the read-route contract (200 + error) if that ever changes. */
function guardedSideOutputs(...args: Parameters<typeof sideOutputs>): { outputs: Partial<SideOutputs>; failure?: string } {
  try {
    return { outputs: sideOutputs(...args) };
  } catch (error) {
    return { outputs: {}, failure: `side outputs: ${errorMessage(error)}` };
  }
}

/** Pure handler: registry -> subscribe -> ledger aggregation. Always resolves to a TokenFlowResponse. */
export async function buildTokenFlowResponse(params: FlowParams, deps: FlowRouteDeps): Promise<TokenFlowResponse> {
  const observedAt = deps.now();
  const registry = await loadRegistry(params, deps);
  if ("failure" in registry) return emptyResponse(params, observedAt, registry.failure);
  // Launchpad pseudo-pairs are fed by the launch service; the collector must not poll Gecko or resolve pools for them.
  deps.collector.subscribe(params.chain, params.address, registry.pairs.filter((pair) => !isLaunchpadRow(pair)));
  const flow = tokenFlow({
    ledger: deps.collector.ledger,
    chain: params.chain,
    address: params.address,
    pairs: registry.pairs,
    interval: params.interval,
    fromMs: params.fromMs,
    toMs: params.toMs,
    anchor: params.anchor,
    sessionStartMs: deps.sessionStartMs,
    launchMs: deps.collector.launchMs(params.chain, params.address)
  });
  const side = guardedSideOutputs(params, registry.pairs, flow.bars, deps, observedAt);
  const error = [registry.error, side.failure].filter((message): message is string => Boolean(message)).join("; ");
  // Prints in the ring with every feed down are last-good data, not a live tape: say so instead of emptying it.
  const staleFeed = Boolean(side.outputs.tape?.length && side.outputs.feedHealth && allSourcesDown(side.outputs.feedHealth));
  return {
    chain: params.chain,
    address: params.address,
    interval: params.interval,
    anchor: params.anchor,
    bars: flow.bars,
    pairs: flow.pairs,
    coverage: flow.coverage,
    counts: sumTxns(registry.pairs),
    observedAt,
    source: FLOW_SOURCE,
    ...(registry.stale || staleFeed ? { stale: true } : {}),
    ...(error ? { error } : {}),
    ...side.outputs
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cachedClawTopPools(mint: string): unknown {
  return record(record(peekMarketProvider(mint)).intelligence_market).top_pools ?? null;
}

function liveRegistry(chain: Chain, address: string): Promise<RegistryResult> {
  return getRegistry(chain, address, {
    getTokenPairs,
    geckoTokenPools: (network, token) => geckoTokenPools(network, token),
    clawTopPools: async () => cachedClawTopPools(address),
    pumpPool: () => (address.endsWith("pump") ? pumpPoolFor(address) : null),
    launchpadPairs: (network, token) => getLaunchService().curvePairsFor(network, token)
  });
}

/** Shared by the candles route (routes/flowCandles.ts) so both read the same registry and collector. */
export const liveDeps: FlowRouteDeps = {
  registry: liveRegistry,
  collector: flowCollector,
  sessionStartMs: SESSION_START_MS,
  now: () => Date.now(),
  traders: getTraderService()
};

export const flowRouter = Router();

flowRouter.get("/token/:chain/:address", async (request, response, next) => {
  try {
    const params = resolveFlowParams(request.params, request.query);
    response.json(await buildTokenFlowResponse(params, liveDeps));
  } catch (error) {
    next(error);
  }
});
