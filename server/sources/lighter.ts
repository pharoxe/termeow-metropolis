import { errorMessage, fetchJson } from "../lib/http.js";

export const LIGHTER_API_BASE = "https://mainnet.zklighter.elliot.ai/api/v1";
export const MARKETS_TTL_MS = 30_000;
const DEFAULT_TRADE_LIMIT = 100;
const DEFAULT_BOOK_DEPTH = 20;
/** orderBookOrders is a per-ORDER list; ask for enough orders to aggregate into `depth` price levels per side. */
const BOOK_ORDER_LIMIT = 100;
const FUNDING_LOOKBACK_S = 3 * 3600;
const SOURCE = "lighter";

export type LighterMarket = {
  marketId: number;
  symbol: string;
  status: string;
  markPrice: number | null;
  indexPrice: number | null;
  lastPrice: number | null;
  change24Pct: number | null;
  volume24Usd: number | null;
  trades24: number | null;
  sizeDecimals: number;
  priceDecimals: number;
};

export type TakerSide = "buy" | "sell";

/** One Lighter trade. `takerSide` follows the verified rule: is_maker_ask true => the taker lifted an ask => BUY. */
export type LighterTrade = {
  id: string;
  tx: string;
  time: number; // ms epoch
  price: number;
  size: number;
  usd: number | null;
  takerSide: TakerSide;
  liquidation: boolean;
};

export type Level = { price: number; size: number };
export type BookSnapshot = { asks: Level[]; bids: Level[] };
export type LighterFunding = { rate: number; direction: string; at: number };

export type CachedResult<T> = { value: T; observedAt: number | null; stale: boolean; error?: string };

type RawDetail = Record<string, unknown>;

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A price of 0 is the API's "no trade yet" placeholder, not a price. */
function priceOrNull(value: unknown): number | null {
  const parsed = finiteOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function asRecords(value: unknown): RawDetail[] {
  return Array.isArray(value) ? value.filter((row): row is RawDetail => !!row && typeof row === "object") : [];
}

function marketOf(detail: RawDetail, stat: RawDetail | undefined): LighterMarket | null {
  const marketId = finiteOrNull(detail.market_id);
  const symbol = String(detail.symbol ?? "").trim();
  if (marketId === null || !Number.isInteger(marketId) || !symbol) return null;
  return {
    marketId,
    symbol,
    status: String(detail.status ?? "unknown"),
    markPrice: priceOrNull(detail.mark_price),
    indexPrice: priceOrNull(detail.index_price),
    lastPrice: priceOrNull(detail.last_trade_price) ?? priceOrNull(stat?.last_trade_price),
    change24Pct: finiteOrNull(stat?.daily_price_change) ?? finiteOrNull(detail.daily_price_change),
    volume24Usd: finiteOrNull(detail.daily_quote_token_volume) ?? finiteOrNull(stat?.daily_quote_token_volume),
    trades24: finiteOrNull(detail.daily_trades_count) ?? finiteOrNull(stat?.daily_trades_count),
    sizeDecimals: finiteOrNull(detail.size_decimals) ?? 0,
    priceDecimals: finiteOrNull(detail.price_decimals) ?? 0
  };
}

/**
 * Merge /orderBookDetails (authoritative market list, carries market_id) with /exchangeStats by symbol.
 * Symbols present only in exchangeStats have no market_id and are skipped. Sorted by marketId.
 */
export function parseMarkets(details: unknown, stats: unknown): LighterMarket[] {
  const detailRows = asRecords((details as { order_book_details?: unknown } | null)?.order_book_details);
  const statRows = asRecords((stats as { order_book_stats?: unknown } | null)?.order_book_stats);
  const bySymbol = new Map(statRows.map((row) => [String(row.symbol ?? ""), row]));
  return detailRows
    .map((detail) => marketOf(detail, bySymbol.get(String(detail.symbol ?? ""))))
    .filter((market): market is LighterMarket => market !== null)
    .sort((a, b) => a.marketId - b.marketId);
}

/** Normalize one raw trade (REST or websocket shape); null when the load-bearing fields are missing. */
export function parseTrade(raw: unknown, liquidation = false): LighterTrade | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as RawDetail;
  const id = row.trade_id_str ?? row.trade_id;
  const time = finiteOrNull(row.timestamp);
  const price = finiteOrNull(row.price);
  const size = finiteOrNull(row.size);
  if (id === undefined || id === null || time === null || price === null || size === null) return null;
  return {
    id: String(id),
    tx: String(row.tx_hash ?? id),
    time,
    price,
    size,
    usd: finiteOrNull(row.usd_amount),
    takerSide: row.is_maker_ask === true ? "buy" : "sell",
    liquidation
  };
}

/** Trades from a /recentTrades body or a trade websocket frame; liquidation_trades are flagged, not dropped. */
export function parseTrades(body: unknown): LighterTrade[] {
  const frame = (body ?? {}) as { trades?: unknown; liquidation_trades?: unknown };
  const regular = asRecords(frame.trades).map((row) => parseTrade(row, false));
  const liquidations = asRecords(frame.liquidation_trades).map((row) => parseTrade(row, true));
  return [...regular, ...liquidations].filter((trade): trade is LighterTrade => trade !== null);
}

function aggregateLevels(rows: RawDetail[], sizeKey: string): Map<number, number> {
  const levels = new Map<number, number>();
  for (const row of rows) {
    const price = finiteOrNull(row.price);
    const size = finiteOrNull(row[sizeKey]);
    if (price === null || size === null || size <= 0) continue;
    levels.set(price, (levels.get(price) ?? 0) + size);
  }
  return levels;
}

function sortedLevels(levels: Map<number, number>, ascending: boolean, depth: number): Level[] {
  return [...levels.entries()]
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => (ascending ? a.price - b.price : b.price - a.price))
    .slice(0, Math.max(0, depth));
}

/** /orderBookOrders lists individual orders; sum them per price into levels, asks ascending and bids descending. */
export function parseBookOrders(body: unknown, depth = DEFAULT_BOOK_DEPTH): BookSnapshot {
  const frame = (body ?? {}) as { asks?: unknown; bids?: unknown };
  return {
    asks: sortedLevels(aggregateLevels(asRecords(frame.asks), "remaining_base_amount"), true, depth),
    bids: sortedLevels(aggregateLevels(asRecords(frame.bids), "remaining_base_amount"), false, depth)
  };
}

/** Latest funding row by timestamp (seconds on the wire, ms in the result); null when the body has none. */
export function parseFunding(body: unknown): LighterFunding | null {
  const rows = asRecords((body as { fundings?: unknown } | null)?.fundings);
  let latest: LighterFunding | null = null;
  for (const row of rows) {
    const at = finiteOrNull(row.timestamp);
    const rate = finiteOrNull(row.rate);
    if (at === null || rate === null) continue;
    const candidate = { rate, direction: String(row.direction ?? "unknown"), at: at * 1000 };
    if (!latest || candidate.at > latest.at) latest = candidate;
  }
  return latest;
}

function apiUrl(path: string, params: Record<string, string | number> = {}): string {
  const url = new URL(`${LIGHTER_API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

async function getJson<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  return fetchJson<T>(apiUrl(path, params), { headers: { Accept: "application/json" } });
}

export async function fetchMarkets(): Promise<LighterMarket[]> {
  const [details, stats] = await Promise.all([getJson<unknown>("orderBookDetails"), getJson<unknown>("exchangeStats")]);
  return parseMarkets(details, stats);
}

export async function fetchRecentTrades(marketId: number, limit = DEFAULT_TRADE_LIMIT): Promise<LighterTrade[]> {
  return parseTrades(await getJson<unknown>("recentTrades", { market_id: marketId, limit }));
}

export async function fetchBookSnapshot(marketId: number, depth = DEFAULT_BOOK_DEPTH): Promise<BookSnapshot> {
  return parseBookOrders(await getJson<unknown>("orderBookOrders", { market_id: marketId, limit: BOOK_ORDER_LIMIT }), depth);
}

export async function fetchFunding(marketId: number, now: () => number = () => Date.now()): Promise<LighterFunding | null> {
  const end = Math.floor(now() / 1000);
  const body = await getJson<unknown>("fundings", {
    market_id: marketId,
    resolution: "1h",
    start_timestamp: end - FUNDING_LOOKBACK_S,
    end_timestamp: end,
    count_back: 2
  });
  return parseFunding(body);
}

type MarketsCache = { value: LighterMarket[]; observedAt: number };

let marketsCache: MarketsCache | null = null;
let marketsInFlight: Promise<CachedResult<LighterMarket[]>> | null = null;

async function refreshMarkets(previous: MarketsCache | null, now: () => number, load: () => Promise<LighterMarket[]>): Promise<CachedResult<LighterMarket[]>> {
  try {
    const value = await load();
    marketsCache = { value, observedAt: now() };
    return { ...marketsCache, stale: false };
  } catch (error) {
    if (previous) return { ...previous, stale: true, error: errorMessage(error) };
    return { value: [], observedAt: null, stale: true, error: errorMessage(error) };
  }
}

/**
 * Cached market list: 30s TTL, in-flight dedupe, last-good retention. Never throws: before the first success it
 * returns an empty list with `error` set; afterwards it returns the last good list flagged `stale`.
 */
export async function getMarkets(now: () => number = () => Date.now(), load: () => Promise<LighterMarket[]> = fetchMarkets): Promise<CachedResult<LighterMarket[]>> {
  const cached = marketsCache;
  if (cached && now() - cached.observedAt < MARKETS_TTL_MS) return { ...cached, stale: false };
  if (marketsInFlight) return marketsInFlight;
  marketsInFlight = refreshMarkets(cached, now, load).finally(() => {
    marketsInFlight = null;
  });
  return marketsInFlight;
}

export function resetLighterCache(): void {
  marketsCache = null;
  marketsInFlight = null;
}

export const LIGHTER_SOURCE = SOURCE;
