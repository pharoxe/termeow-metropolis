import type { Chain, PairRow } from "../../shared/wire.js";
import { errorMessage } from "../lib/http.js";

export const REGISTRY_TTL_MS = 60_000;
export const TIER_A_SHARE = 0.95;
export const TIER_A_CAP = 4;
const SHARE_EPSILON = 1e-9;
const PUMP_PREFIX = "pumpfun:";
const PUMP_VENUES = new Set(["pumpfun", "pumpswap", "pumpamm"]);

export type RegistryPool = {
  dex: string;
  pairAddress: string;
  liquidityUsd: number | null;
  volume24Usd: number | null;
};

export type RegistryInput = {
  chain: Chain;
  address: string;
  dexPairs: PairRow[];
  geckoPools: RegistryPool[];
  clawTopPools: unknown;
  pumpPool: string | null;
};

export type RegistryResult = { pairs: PairRow[]; observedAt: number; stale: boolean; error?: string };

export type RegistryDeps = {
  getTokenPairs: (chain: Chain, address: string) => Promise<{ pairs: PairRow[]; stale: boolean; error?: string }>;
  geckoTokenPools: (chain: Chain, address: string) => Promise<RegistryPool[]>;
  clawTopPools: () => Promise<unknown>;
  pumpPool: () => string | null;
};

const EMPTY_TXNS: PairRow["txns"] = { m5: null, h1: null, h6: null, h24: null };

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function poolRow(chain: Chain, address: string, pool: RegistryPool, source: string): PairRow {
  return {
    chain,
    dex: pool.dex,
    pairAddress: pool.pairAddress,
    baseMint: address,
    quoteMint: null,
    liquidityUsd: pool.liquidityUsd,
    volume24Usd: pool.volume24Usd,
    share24: null,
    txns: EMPTY_TXNS,
    tier: "B",
    sources: [source]
  };
}

/** Defensive read of intelligence_market.top_pools; rows without a pool address are dropped. */
export function clawPools(raw: unknown): RegistryPool[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const row = record(item);
    const pairAddress = String(row.pool_address ?? row.pair_address ?? row.pairAddress ?? "").trim();
    if (!pairAddress) return [];
    return [
      {
        dex: String(row.protocol ?? row.dex ?? "").trim(),
        pairAddress,
        liquidityUsd: num(row.liquidity_usd),
        volume24Usd: num(row.volume_24h_usd)
      }
    ];
  });
}

function isPumpPair(pair: string): boolean {
  return pair.startsWith(PUMP_PREFIX);
}

/** Pool rows on the pump.fun bonding curve or PumpSwap AMM: the very tape the pump pseudo-pair polls. */
function isPumpVenue(dex: string): boolean {
  return PUMP_VENUES.has(dex.toLowerCase().replace(/[^a-z]/g, ""));
}

function sumOrNull(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

function knownDex(dex: string): boolean {
  return dex !== "" && dex !== "unknown";
}

/** Merge an incoming row into an existing one: existing numbers win, gaps are filled, sources are unioned. */
function mergeRow(existing: PairRow, incoming: PairRow): PairRow {
  return {
    ...existing,
    dex: knownDex(existing.dex) ? existing.dex : incoming.dex || existing.dex,
    quoteMint: existing.quoteMint ?? incoming.quoteMint,
    liquidityUsd: existing.liquidityUsd ?? incoming.liquidityUsd,
    volume24Usd: existing.volume24Usd ?? incoming.volume24Usd,
    sources: [...existing.sources, ...incoming.sources.filter((source) => !existing.sources.includes(source))]
  };
}

function unionRows(rows: PairRow[]): PairRow[] {
  const byKey = new Map<string, PairRow>();
  for (const row of rows) {
    const key = row.pairAddress.toLowerCase();
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeRow(existing, row) : row);
  }
  return [...byKey.values()];
}

function withShares(rows: PairRow[]): PairRow[] {
  const known = rows.map((row) => row.volume24Usd).filter((volume): volume is number => volume !== null);
  const total = known.reduce((sum, volume) => sum + volume, 0);
  if (!known.length || total <= 0) return rows.map((row) => ({ ...row, share24: null }));
  return rows.map((row) => ({ ...row, share24: row.volume24Usd === null ? null : row.volume24Usd / total }));
}

function byVolumeDesc(left: PairRow, right: PairRow): number {
  const a = left.volume24Usd ?? -Infinity;
  const b = right.volume24Usd ?? -Infinity;
  return b - a;
}

/** The pump pseudo-pair inherits volume and share from the pump-venue pool rows its tape covers. */
function withPumpShare(rows: PairRow[]): PairRow[] {
  const venues = rows.filter((row) => isPumpVenue(row.dex) && !isPumpPair(row.pairAddress));
  if (!venues.length) return rows;
  return rows.map((row) =>
    isPumpPair(row.pairAddress)
      ? { ...row, volume24Usd: sumOrNull(venues.map((venue) => venue.volume24Usd)), share24: sumOrNull(venues.map((venue) => venue.share24)) }
      : row
  );
}

/**
 * Smallest volume-sorted prefix reaching TIER_A_SHARE, capped at TIER_A_CAP; the pump pseudo-pair is always Tier A
 * and, when present, stands in for every pump-venue pool row (those stay Tier B so their prints are not ingested twice).
 */
function withTiers(rows: PairRow[]): PairRow[] {
  const sorted = [...rows].sort(byVolumeDesc);
  const pump = sorted.find((row) => isPumpPair(row.pairAddress));
  const tierA = new Set<string>();
  let cumulative = pump?.share24 ?? 0;
  for (const row of sorted) {
    if (isPumpPair(row.pairAddress) || (pump && isPumpVenue(row.dex))) continue;
    if (tierA.size >= TIER_A_CAP || cumulative >= TIER_A_SHARE - SHARE_EPSILON || row.share24 === null) break;
    tierA.add(row.pairAddress);
    cumulative += row.share24;
  }
  return sorted.map((row) => ({
    ...row,
    tier: isPumpPair(row.pairAddress) || tierA.has(row.pairAddress) ? "A" : "B"
  }));
}

/** Union DexScreener, Gecko, Claw and the pump pseudo-pair into one shared/tiered registry. */
export function buildRegistry(input: RegistryInput): PairRow[] {
  const { chain, address } = input;
  const gecko = input.geckoPools.map((pool) => poolRow(chain, address, pool, "geckoterminal"));
  const claw = clawPools(input.clawTopPools).map((pool) => poolRow(chain, address, pool, "clawpump"));
  const pump = input.pumpPool
    ? [poolRow(chain, address, { dex: "pumpfun", pairAddress: input.pumpPool, liquidityUsd: null, volume24Usd: null }, "pumpfun")]
    : [];
  return withTiers(withPumpShare(withShares(unionRows([...input.dexPairs, ...gecko, ...claw, ...pump]))));
}

type CacheEntry = { pairs: PairRow[]; observedAt: number };

/** Rows from each source's last successful call for a key; absent = that source has never succeeded. */
type LastGoodRows = { dexPairs?: PairRow[]; geckoPools?: RegistryPool[]; clawTopPools?: unknown };

/** Per-source refresh outcome: `ok:false` means the call rejected or reported an error, and `rows` is only a fallback. */
type SourceOutcome<T> = { rows: T; ok: boolean; error?: string };

type GatherOutcomes = {
  dex: SourceOutcome<PairRow[]>;
  gecko: SourceOutcome<RegistryPool[]>;
  claw: SourceOutcome<unknown>;
  /** Every source rejected outright; nothing usable came back this refresh. */
  allRejected: boolean;
};

const cache = new Map<string, CacheEntry>();
const lastGood = new Map<string, LastGoodRows>();
const inFlight = new Map<string, Promise<RegistryResult>>();

function cacheKey(chain: Chain, address: string): string {
  return `${chain}:${chain === "robinhood" ? address.toLowerCase() : address}`;
}

type Settled<T> = { value: T; error?: string };

async function settle<T>(label: string, task: () => Promise<T>, fallback: T): Promise<Settled<T>> {
  try {
    return { value: await task() };
  } catch (error) {
    return { value: fallback, error: `${label}: ${errorMessage(error)}` };
  }
}

function outcome<T>(settled: Settled<T>): SourceOutcome<T> {
  return settled.error ? { rows: settled.value, ok: false, error: settled.error } : { rows: settled.value, ok: true };
}

/** DexScreener is a fetched source with its own last-good: a reported error still counts as a failed refresh. */
function dexOutcome(settled: Settled<{ pairs: PairRow[]; stale: boolean; error?: string }>): SourceOutcome<PairRow[]> {
  if (settled.error) return { rows: settled.value.pairs, ok: false, error: settled.error };
  if (settled.value.error) return { rows: settled.value.pairs, ok: false, error: `dexscreener: ${settled.value.error}` };
  return { rows: settled.value.pairs, ok: true };
}

/** Settle every source; per-source outcomes let the caller substitute last-good rows for failures. */
async function gather(chain: Chain, address: string, deps: RegistryDeps): Promise<GatherOutcomes> {
  const [dex, gecko, claw] = await Promise.all([
    settle("dexscreener", () => deps.getTokenPairs(chain, address), { pairs: [] as PairRow[], stale: true }),
    settle("geckoterminal", () => deps.geckoTokenPools(chain, address), [] as RegistryPool[]),
    settle("clawpump", () => deps.clawTopPools(), null as unknown)
  ]);
  return {
    dex: dexOutcome(dex),
    gecko: outcome(gecko),
    claw: outcome(claw),
    allRejected: Boolean(dex.error && gecko.error && claw.error)
  };
}

/** A failed source keeps its last-good rows; a source that succeeded with an empty list is taken at face value. */
function pick<T>(source: SourceOutcome<T>, previous: T | undefined): T {
  return source.ok || previous === undefined ? source.rows : previous;
}

function retainedRows(outcomes: GatherOutcomes, previous: LastGoodRows): Omit<RegistryInput, "chain" | "address" | "pumpPool"> {
  return {
    dexPairs: pick(outcomes.dex, previous.dexPairs),
    geckoPools: pick(outcomes.gecko, previous.geckoPools),
    clawTopPools: pick(outcomes.claw, previous.clawTopPools)
  };
}

/** New last-good snapshot: only sources that succeeded this refresh overwrite their previous rows. */
function rememberRows(outcomes: GatherOutcomes, previous: LastGoodRows): LastGoodRows {
  return {
    ...previous,
    ...(outcomes.dex.ok ? { dexPairs: outcomes.dex.rows } : {}),
    ...(outcomes.gecko.ok ? { geckoPools: outcomes.gecko.rows } : {}),
    ...(outcomes.claw.ok ? { clawTopPools: outcomes.claw.rows } : {})
  };
}

function gatherErrors(outcomes: GatherOutcomes): string[] {
  return [outcomes.dex.error, outcomes.gecko.error, outcomes.claw.error].filter((message): message is string => Boolean(message));
}

/** Fresh registry from this refresh plus last-good rows for failed sources; throws when every source rejected. */
async function fresh(key: string, chain: Chain, address: string, deps: RegistryDeps): Promise<RegistryResult> {
  const outcomes = await gather(chain, address, deps);
  const errors = gatherErrors(outcomes);
  if (outcomes.allRejected) throw new Error(errors.join("; "));
  const retained = lastGood.get(key) ?? {};
  const pairs = buildRegistry({ chain, address, ...retainedRows(outcomes, retained), pumpPool: deps.pumpPool() });
  lastGood.set(key, rememberRows(outcomes, retained));
  const entry = { pairs, observedAt: Date.now() };
  cache.set(key, entry);
  return errors.length ? { ...entry, stale: false, error: errors.join("; ") } : { ...entry, stale: false };
}

async function refresh(key: string, chain: Chain, address: string, deps: RegistryDeps, previous?: CacheEntry): Promise<RegistryResult> {
  try {
    return await fresh(key, chain, address, deps);
  } catch (error) {
    if (!previous) throw error;
    return { pairs: previous.pairs, observedAt: previous.observedAt, stale: true, error: errorMessage(error) };
  }
}

/**
 * Cached registry: 60s TTL per (chain,address), in-flight dedupe, last-good retention.
 * Partial source failures still produce a fresh registry (with `error` listing them) built from each failed
 * source's last-good rows, so Tier A does not flap on a transient 429; throws only when every source failed
 * and nothing is cached.
 */
export async function getRegistry(chain: Chain, address: string, deps: RegistryDeps): Promise<RegistryResult> {
  const key = cacheKey(chain, address);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.observedAt < REGISTRY_TTL_MS) return { ...cached, stale: false };
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = refresh(key, chain, address, deps, cached).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

export function resetRegistryCache(): void {
  cache.clear();
  lastGood.clear();
  inFlight.clear();
}
