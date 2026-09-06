import { Router } from "express";
import { z } from "zod";
import type { Chain, FlowBar, PairRow, TokenFlowResponse } from "../../shared/wire.js";
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
import { FlowLedger } from "../flow/ledger.js";
import { getRegistry, type RegistryResult } from "../flow/registry.js";
import { sourceChips, type SourcesLike } from "../flow/sources.js";
import { errorMessage } from "../lib/http.js";
import { getTokenPairs, sumTxns } from "../sources/dexscreener.js";
import { geckoTokenPools } from "../sources/gecko.js";
import { pumpPoolFor } from "../sources/pumpfun.js";

export const FLOW_SOURCE = "pumpfun+geckoterminal→ledger";
export const DEFAULT_BAR_COUNT = 300;
export const SESSION_START_MS = Date.now();
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
  /** Optional: FlowCollector.status() narrowed to the source health the response condenses into chips. */
  status?(chain: Chain, address: string): { sources: SourcesLike };
};

export type FlowRouteDeps = {
  registry: (chain: Chain, address: string) => Promise<RegistryResult>;
  collector: FlowCollectorLike;
  sessionStartMs: number;
  now: () => number;
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

async function loadRegistry(params: FlowParams, deps: FlowRouteDeps): Promise<RegistryResult | { failure: string }> {
  try {
    return await deps.registry(params.chain, params.address);
  } catch (error) {
    return { failure: errorMessage(error) };
  }
}

/** Anchor start the side outputs sum from: window → first bar, session → session start, launch → known launch or null. */
function anchorStart(params: FlowParams, bars: FlowBar[], deps: FlowRouteDeps): number | null {
  if (params.anchor === "session") return deps.sessionStartMs;
  if (params.anchor === "launch") return deps.collector.launchMs(params.chain, params.address);
  return bars[0]?.t ?? null;
}

type SideOutputs = Pick<TokenFlowResponse, "windows" | "largePrints" | "sinceAnchor" | "sources">;

/** Windows and large prints are Tier A only; windows end at observedAt, sinceAnchor ends at params.toMs. */
function sideOutputs(params: FlowParams, pairs: PairRow[], bars: FlowBar[], deps: FlowRouteDeps, observedAt: number): SideOutputs {
  const { ledger } = deps.collector;
  const status = deps.collector.status?.(params.chain, params.address);
  return {
    windows: flowWindows(ledger, params.chain, pairs, observedAt),
    largePrints: largePrints(ledger, params.chain, pairs),
    sinceAnchor: sinceAnchor(ledger, params.chain, pairs, anchorStart(params, bars, deps), params.toMs),
    ...(status ? { sources: sourceChips(status.sources) } : {})
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
  deps.collector.subscribe(params.chain, params.address, registry.pairs);
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
    ...(registry.stale ? { stale: true } : {}),
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
    pumpPool: () => (address.endsWith("pump") ? pumpPoolFor(address) : null)
  });
}

const liveDeps: FlowRouteDeps = {
  registry: liveRegistry,
  collector: flowCollector,
  sessionStartMs: SESSION_START_MS,
  now: () => Date.now()
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
