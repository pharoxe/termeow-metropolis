import type { Chain, DiscoverResponse, DiscoverSourceHealth, DiscoverView, DiscoverWindow, FomoCoverage } from "../../shared/wire.js";
import { ERC20_META_SOURCE } from "../launch/enrich.js";
import { errorMessage } from "../lib/http.js";
import { createLastGoodCache, type LastGood } from "../lib/lastGood.js";
import { TRENCHES_SOURCE, fetchTrenchTokens, type TrenchTokensResult } from "../sources/trenches.js";
import { DEFAULT_FILL_RING, type TapeOptions, type TraderTapeRow, type ChainScope } from "../traders/book.js";
import { getTraderService } from "../traders/service.js";
import { DEXSCREENER_DISCOVERY_SOURCE, dexScreenerListPartials, fetchDexScreenerList, type DexScreenerListLoad } from "./dexscreenerLists.js";
import { fetchGeckoList, geckoListSource, normalizeGeckoListRow, type GeckoListKind, type GeckoListRow } from "./geckoLists.js";
import { fomoBuyersByToken } from "./holders.js";
import { emptyFigures, mergeDiscover, rankRows, type DiscoverPartial } from "./merge.js";
import { trenchPartial } from "./trenchesList.js";

export const CHAIN: Chain = "robinhood";
export const DISCOVER_CACHE_TTL_MS = 60_000;
export const DISCOVER_ROW_LIMIT = 60;
export const TRENCHES_LIST_LIMIT = 50;
export const BOOK_SOURCE = "trader book · verified-FOMO buyers seen by this server";
/** Same label the launch index uses for a contract-read symbol, so the provenance chip cannot drift between the two. */
export const ERC20_SYMBOL_SOURCE = ERC20_META_SOURCE;
const HOUR_MS = 3_600_000;
export const DISCOVER_WINDOW_MS: Record<DiscoverWindow, number> = { "1h": HOUR_MS, "24h": 24 * HOUR_MS };
/** Scalar precedence when sources agree within 5%: the per-token DexScreener pair, then the ranked Gecko list, then the unofficial site. */
const PRECEDENCE = [DEXSCREENER_DISCOVERY_SOURCE, geckoListSource("trending"), geckoListSource("new"), TRENCHES_SOURCE, BOOK_SOURCE, ERC20_SYMBOL_SOURCE];

/** The slice of TraderService this module reads; tests inject a fake, null means "no book on this chain". */
export type DiscoverTradersLike = {
  book: { tape(chain: ChainScope, limit: number, opts?: TapeOptions): TraderTapeRow[] };
  coverage(): FomoCoverage;
  erc20Meta: { get(token: string): { symbol: string | null } | null };
};

export type RobinhoodDiscoverDeps = {
  now?: () => number;
  geckoList?: (kind: GeckoListKind) => Promise<LastGood<GeckoListRow[]>>;
  dexList?: () => Promise<LastGood<DexScreenerListLoad>>;
  trenches?: (window: DiscoverWindow) => Promise<TrenchTokensResult>;
  traders?: () => DiscoverTradersLike | null;
};

type ProviderResult = { partials: DiscoverPartial[]; health: DiscoverSourceHealth };

function health(name: string, lastOkAt: number | null, lastError: string | null, stale: boolean): DiscoverSourceHealth {
  return { name, lastOkAt, lastError, stale };
}

function failed(name: string, error: unknown): ProviderResult {
  return { partials: [], health: health(name, null, errorMessage(error), true) };
}

async function geckoProvider(deps: Required<Pick<RobinhoodDiscoverDeps, "now" | "geckoList">>, kind: GeckoListKind, window: DiscoverWindow): Promise<ProviderResult> {
  const name = geckoListSource(kind);
  try {
    const entry = await deps.geckoList(kind);
    const now = deps.now();
    const partials = entry.value
      .map((row, index) => normalizeGeckoListRow(row, index, kind, window, CHAIN, now, entry.observedAt, entry.stale))
      .filter((partial): partial is DiscoverPartial => partial !== null);
    return { partials, health: health(name, entry.observedAt, entry.error ?? null, entry.stale) };
  } catch (error) {
    return failed(name, error);
  }
}

async function dexProvider(deps: Required<Pick<RobinhoodDiscoverDeps, "now" | "dexList">>, window: DiscoverWindow): Promise<ProviderResult> {
  try {
    const entry = await deps.dexList();
    const partials = dexScreenerListPartials(CHAIN, entry.value, window, deps.now(), entry.observedAt, entry.stale);
    return { partials, health: health(DEXSCREENER_DISCOVERY_SOURCE, entry.observedAt, entry.error ?? null, entry.stale) };
  } catch (error) {
    return failed(DEXSCREENER_DISCOVERY_SOURCE, error);
  }
}

async function trenchesProvider(deps: Required<Pick<RobinhoodDiscoverDeps, "now" | "trenches">>, window: DiscoverWindow): Promise<ProviderResult> {
  try {
    const result = await deps.trenches(window);
    const now = deps.now();
    const partials = result.rows.map((row) => trenchPartial(row, window, now, result.observedAt, result.stale));
    return { partials, health: health(TRENCHES_SOURCE, result.observedAt, result.error ?? null, result.stale) };
  } catch (error) {
    return failed(TRENCHES_SOURCE, error);
  }
}

/**
 * Book partials: one per token with verified-FOMO buyers in the window, plus an explicit 0 for every listed token when
 * the book holds fills (0 seen is a measurement under the coverage label). An empty book contributes nothing, so
 * fomoHolders stays null everywhere: no placeholder.
 */
function bookPartials(traders: DiscoverTradersLike | null, listed: ReadonlySet<string>, window: DiscoverWindow, now: number): { partials: DiscoverPartial[]; coverage: FomoCoverage | null } {
  if (!traders) return { partials: [], coverage: null };
  const tape = traders.book.tape(CHAIN, DEFAULT_FILL_RING, { kind: "fomo" });
  const coverage = traders.coverage();
  if (!tape.length) return { partials: [], coverage };
  const counts = fomoBuyersByToken(tape, now - DISCOVER_WINDOW_MS[window]);
  const tokens = new Set([...listed, ...counts.keys()]);
  const partials = [...tokens].map((token) => ({
    ...emptyFigures(),
    token,
    source: BOOK_SOURCE,
    lastOkAt: now,
    stale: false,
    rank: null,
    symbol: null,
    name: null,
    fomoHolders: counts.get(token) ?? 0
  }));
  return { partials, coverage };
}

/** Symbol from the ERC-20 cache for tokens no list named; erc20Meta.get is synchronous and never fetches. */
function erc20Partials(traders: DiscoverTradersLike | null, partials: readonly DiscoverPartial[], now: number): DiscoverPartial[] {
  if (!traders) return [];
  const named = new Set(partials.filter((partial) => partial.symbol !== null).map((partial) => partial.token));
  const unnamed = new Set(partials.map((partial) => partial.token).filter((token) => !named.has(token)));
  const out: DiscoverPartial[] = [];
  for (const token of unnamed) {
    const symbol = traders.erc20Meta.get(token)?.symbol ?? null;
    if (symbol === null) continue;
    out.push({ ...emptyFigures(), token, source: ERC20_SYMBOL_SOURCE, lastOkAt: now, stale: false, rank: null, symbol, name: null });
  }
  return out;
}

function geckoKindFor(view: DiscoverView): GeckoListKind {
  return view === "new" ? "new" : "trending";
}

/** Builds one uncached response; never throws. Provider failures land in `sources[]`, `stale` and `error`. */
export async function buildRobinhoodDiscover(view: DiscoverView, window: DiscoverWindow, deps: RobinhoodDiscoverDeps = {}): Promise<DiscoverResponse> {
  const now = deps.now ?? (() => Date.now());
  const geckoList = deps.geckoList ?? ((kind) => fetchGeckoList(CHAIN, kind));
  const dexList = deps.dexList ?? (() => fetchDexScreenerList(CHAIN));
  const trenches = deps.trenches ?? ((w) => fetchTrenchTokens(w, TRENCHES_LIST_LIMIT));
  const tradersOf = deps.traders ?? (() => getTraderService());
  const kind = geckoKindFor(view);
  const [gecko, dex, trench] = await Promise.all([geckoProvider({ now, geckoList }, kind, window), dexProvider({ now, dexList }, window), trenchesProvider({ now, trenches }, window)]);
  const providers = [dex, gecko, trench];
  const listed = providers.flatMap((provider) => provider.partials);
  let traders: DiscoverTradersLike | null = null;
  try {
    traders = tradersOf();
  } catch {
    traders = null;
  }
  const observedAt = now();
  const book = bookPartials(traders, new Set(listed.map((partial) => partial.token)), window, observedAt);
  const known = [...listed, ...book.partials];
  const partials = [...known, ...erc20Partials(traders, known, observedAt)];
  const rows = rankRows(view, mergeDiscover(CHAIN, partials, PRECEDENCE), geckoListSource(kind)).slice(0, DISCOVER_ROW_LIMIT);
  const sources = providers.map((provider) => provider.health);
  const errors = sources.filter((source) => source.lastError !== null).map((source) => `${source.name}: ${source.lastError}`);
  const stale = sources.some((source) => source.stale);
  return {
    chain: CHAIN,
    view,
    window,
    rows,
    observedAt,
    sources,
    coverage: book.coverage,
    ...(stale ? { stale: true } : {}),
    ...(errors.length ? { error: errors.join("; ") } : {})
  };
}

const cache = createLastGoodCache<DiscoverResponse>(DISCOVER_CACHE_TTL_MS);

/** Cached 60 s per (view, window): upstream lists are asked at most once a minute per view however often the desk polls. */
export async function discoverRobinhood(view: DiscoverView, window: DiscoverWindow, deps: RobinhoodDiscoverDeps = {}): Promise<DiscoverResponse> {
  const entry = await cache.get(`${view}:${window}`, () => buildRobinhoodDiscover(view, window, deps));
  return entry.value;
}

export function resetDiscoverCache(): void {
  cache.reset();
}
