import { config } from "../config.js";
import { clawpumpMcp } from "./mcp.js";
import { fetchJson, errorMessage } from "../lib/http.js";
import { isGeckoBlocked, noteGeckoError } from "../sources/gecko.js";
import { mockAnsemMarket } from "../mock/market.js";
import type { Candle, OnchainMarket, ToolResult } from "../types.js";
import { computeCvd, type PoolTrade } from "./cvd.js";

type DexPair = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  priceChange?: { h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  info?: { imageUrl?: string };
};

type RpcEnvelope<T> = { result?: T; error?: { message?: string } };
type TokenAmount = { address?: string; amount?: string; uiAmount?: number | null; decimals?: number };
type SupplyAmount = { amount?: string; uiAmount?: number | null; decimals?: number };

const TRENCH_SORTS = ["hot", "new", "mcap", "volume"] as const;
export type TrenchSort = (typeof TRENCH_SORTS)[number];

function bestPair(pairs: DexPair[] = []) {
  return rankCandlePairs(pairs)[0];
}

export function rankCandlePairs(pairs: DexPair[] = []): DexPair[] {
  const seen = new Set<string>();
  return pairs
    .filter((pair) => {
      const chainOk = !pair.chainId || pair.chainId === "solana";
      const addr = pair.pairAddress;
      if (!chainOk || !addr || seen.has(addr)) return false;
      seen.add(addr);
      return true;
    })
    .sort((a, b) => {
      const liq = (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0);
      if (liq !== 0) return liq;
      return (b.volume?.h24 || 0) - (a.volume?.h24 || 0);
    });
}

async function dexSnapshot(mint: string) {
  const result = await fetchJson<{ pairs?: DexPair[] }>(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  return { pair: bestPair(result.pairs), pairs: (result.pairs || []).filter((item) => item.chainId === "solana") };
}

const GECKO_HEADERS = {
  Accept: "application/json",
  "User-Agent": "terminal-v-solana/0.2"
};

function mapGeckoOhlcv(rows: number[][] = []): Candle[] {
  return rows.map((row) => ({
    time: Number(row[0]) * 1000,
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5])
  })).filter((row) => Object.values(row).every(Number.isFinite));
}

const GECKO_INTERVALS: Record<string, [string, number]> = {
  "1m": ["minute", 1], "5m": ["minute", 5], "15m": ["minute", 15],
  "1h": ["hour", 1], "4h": ["hour", 4], "1d": ["day", 1]
};

async function geckoOhlcv(resourcePath: string, interval = "5m"): Promise<Candle[]> {
  const [unit, aggregate] = GECKO_INTERVALS[interval] || GECKO_INTERVALS["5m"];
  const collected: Candle[] = [];
  let before: number | undefined;
  for (let page = 0; page < 2; page += 1) {
    const params = new URLSearchParams({ aggregate: String(aggregate), limit: "1000" });
    if (before) params.set("before_timestamp", String(before));
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/${resourcePath}/ohlcv/${unit}?${params}`;
    const result = await fetchJson<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(url, { headers: GECKO_HEADERS });
    const rows = mapGeckoOhlcv(result.data?.attributes?.ohlcv_list);
    if (!rows.length) break;
    collected.push(...rows);
    const oldest = Math.min(...rows.map((row) => row.time));
    before = Math.floor(oldest / 1000);
    if (rows.length < 1000) break;
  }
  const byTime = new Map<number, Candle>();
  for (const row of collected) byTime.set(row.time, row);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function geckoCandles(pairAddress?: string, interval = "5m"): Promise<Candle[]> {
  if (!pairAddress) return [];
  return geckoOhlcv(`pools/${pairAddress}`, interval);
}

type GeckoPoolRow = {
  attributes?: { address?: string };
  relationships?: { dex?: { data?: { id?: string } } };
};

async function geckoTokenPoolPairs(mint: string): Promise<DexPair[]> {
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`;
  const result = await fetchJson<{ data?: GeckoPoolRow[] }>(url, { headers: GECKO_HEADERS });
  const seen = new Set<string>();
  const pools: DexPair[] = [];
  for (const row of result.data || []) {
    const addr = String(row.attributes?.address || "").trim();
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    pools.push({
      chainId: "solana",
      pairAddress: addr,
      dexId: row.relationships?.dex?.data?.id
    });
  }
  return pools;
}

type PumpFunBar = {
  timestamp?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  volume?: unknown;
};

function mapPumpFunCandles(rows: PumpFunBar[] = []): Candle[] {
  return rows
    .map((row) => ({
      time: Number(row.timestamp),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume)
    }))
    .filter((row) => Object.values(row).every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
}

async function fetchPumpFunSeries(mint: string, interval: string): Promise<Candle[]> {
  const url = `https://swap-api.pump.fun/v1/coins/${mint}/candles?interval=${interval}&limit=1000`;
  const result = await fetchJson<PumpFunBar[]>(url, { headers: GECKO_HEADERS });
  return mapPumpFunCandles(Array.isArray(result) ? result : []);
}

function intervalMs(interval: string): number {
  if (interval === "1m") return 60e3;
  if (interval === "5m") return 300e3;
  if (interval === "15m") return 900e3;
  if (interval === "1h") return 3600e3;
  if (interval === "4h") return 4 * 3600e3;
  if (interval === "1d") return 86400e3;
  return 300e3;
}

export function mergeCandles(...series: Candle[][]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const rows of series) {
    for (const row of rows) {
      if (!byTime.has(row.time)) byTime.set(row.time, row);
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function pumpCreatedMs(mint: string): Promise<number | null> {
  try {
    const result = await fetchJson<{ created_timestamp?: unknown }>(
      `https://frontend-api-v3.pump.fun/coins/${mint}`,
      { headers: GECKO_HEADERS }
    );
    const created = Number(result?.created_timestamp);
    return Number.isFinite(created) ? created : null;
  } catch {
    return null;
  }
}

async function pumpFunHistory(mint: string, interval: string): Promise<Candle[]> {
  const fine = await pumpFunCandles(mint, interval);
  const created = await pumpCreatedMs(mint);
  const coversLaunch = Boolean(fine.length) && (created == null || fine[0].time <= created + 2 * intervalMs(interval));
  const looksCapped = fine.length >= 200;
  if (fine.length && coversLaunch && (created != null || !looksCapped)) return fine;

  const hourly = await pumpFunCandles(mint, "1h");
  const cutoff = fine[0]?.time;
  const olderHourly = cutoff == null ? hourly : hourly.filter((row) => row.time < cutoff);
  let merged = mergeCandles(fine, olderHourly);

  const oldest = merged[0]?.time;
  const stillAfterLaunch = created != null && oldest != null && oldest > created + 4 * 3600e3;
  const hourlyLooksCapped = created == null && hourly.length >= 200;
  if (stillAfterLaunch || hourlyLooksCapped) {
    const fourH = await pumpFunCandles(mint, "4h");
    const left = merged[0]?.time;
    const olderFour = left == null ? fourH : fourH.filter((row) => row.time < left);
    merged = mergeCandles(merged, olderFour);
  }
  return merged;
}

async function pumpFunCandles(mint: string, interval: string): Promise<Candle[]> {
  try {
    if (interval === "1d") {
      try {
        const daily = await fetchPumpFunSeries(mint, "1d");
        if (daily.length) return daily;
      } catch {
        /* pump.fun interval=1d is 400 */
      }
      return await fetchPumpFunSeries(mint, "4h");
    }
    const mapped = interval === "1m" || interval === "5m" || interval === "15m" || interval === "1h" || interval === "4h"
      ? interval
      : "5m";
    return await fetchPumpFunSeries(mint, mapped);
  } catch {
    return [];
  }
}

async function safeGeckoCandles(pairAddress: string | undefined, interval: string): Promise<Candle[]> {
  if (!pairAddress || isGeckoBlocked()) return [];
  try {
    return await geckoCandles(pairAddress, interval);
  } catch (error) {
    noteGeckoError(error);
    return [];
  }
}

function usableCandles(rows: Candle[]) {
  return rows.length > 1;
}

export async function resolveGeckoCandles(
  mint: string,
  pairs: DexPair[],
  interval: string,
  notes: string[]
): Promise<{ candles: Candle[]; pair?: DexPair }> {
  const ranked = rankCandlePairs(pairs);
  const primary = ranked[0];
  let geckoCandles: Candle[] = [];
  if (primary?.pairAddress && !isGeckoBlocked()) {
    geckoCandles = await safeGeckoCandles(primary.pairAddress, interval);
  }

  const geckoSpanMs = geckoCandles.length > 1
    ? geckoCandles[geckoCandles.length - 1].time - geckoCandles[0].time
    : 0;
  const skipPumpHistory = geckoCandles.length >= 1500 || geckoSpanMs >= 6 * 86400e3;
  const pump = skipPumpHistory ? [] : await pumpFunHistory(mint, interval);
  const merged = mergeCandles(geckoCandles, pump);
  if (usableCandles(merged)) {
    if (!usableCandles(geckoCandles)) notes.push("OHLCV from pump.fun (gecko empty)");
    else if (pump.length && merged[0].time < geckoCandles[0].time) notes.push("history backfilled to launch");
    return { candles: merged, pair: primary };
  }

  if (isGeckoBlocked()) return { candles: [] };

  const rest = ranked.slice(primary?.pairAddress ? 1 : 0).slice(0, 2);
  const tried = new Set(ranked.slice(0, 1 + rest.length).map((item) => item.pairAddress).filter(Boolean) as string[]);
  for (const pair of rest) {
    if (isGeckoBlocked()) return { candles: [] };
    const candles = await safeGeckoCandles(pair.pairAddress, interval);
    if (usableCandles(candles)) {
      notes.push(`OHLCV from ${pair.dexId || "alt"} pool (best pair empty)`);
      return { candles, pair };
    }
  }

  // Token-level /ohlcv is Gecko Pro (401). Skip it and use the public pool list.
  if (isGeckoBlocked()) return { candles: [] };
  try {
    const extra = await geckoTokenPoolPairs(mint);
    let used = 0;
    for (const pair of extra) {
      if (isGeckoBlocked()) break;
      if (!pair.pairAddress || tried.has(pair.pairAddress)) continue;
      tried.add(pair.pairAddress);
      const candles = await safeGeckoCandles(pair.pairAddress, interval);
      if (usableCandles(candles)) {
        notes.push(`OHLCV from Gecko pool ${pair.pairAddress.slice(0, 6)}… (dex list empty)`);
        return { candles, pair };
      }
      used += 1;
      if (used >= 2) break;
    }
  } catch (error) {
    noteGeckoError(error);
  }

  return { candles: [] };
}

function pairsFromMarket(market: OnchainMarket): DexPair[] {
  const provider = record(market.provider);
  const rows = Array.isArray(provider.dex_pairs) ? provider.dex_pairs : [];
  const reconstructed = rows.map((item) => {
    const row = record(item);
    return {
      chainId: "solana",
      dexId: String(row.dex || row.dexId || "") || undefined,
      pairAddress: String(row.pair || row.pairAddress || "") || undefined,
      priceUsd: row.price_usd != null ? String(row.price_usd) : row.priceUsd != null ? String(row.priceUsd) : undefined,
      volume: { h24: num(row.volume_24h_usd) ?? num(record(row.volume).h24) ?? 0 },
      liquidity: { usd: num(row.liquidity_usd) ?? num(record(row.liquidity).usd) ?? 0 }
    } as DexPair;
  }).filter((pair) => pair.pairAddress);
  if (market.pairAddress && !reconstructed.some((pair) => pair.pairAddress === market.pairAddress)) {
    reconstructed.unshift({
      chainId: "solana",
      pairAddress: market.pairAddress,
      dexId: market.dex || undefined
    });
  }
  return reconstructed;
}

const tradesCache = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();

type GeckoTradeRow = { attributes?: Record<string, unknown> };

export async function geckoPoolTrades(pairAddress: string) {
  const cached = tradesCache.get(pairAddress);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}/trades`;
  const result = await fetchJson<{ data?: GeckoTradeRow[] }>(url, { headers: GECKO_HEADERS });
  const trades: PoolTrade[] = [];
  for (const row of result.data || []) {
    const attrs = row.attributes || {};
    const kind = attrs.kind === "buy" || attrs.kind === "sell" ? attrs.kind : null;
    const volumeUsd = Number(attrs.volume_in_usd);
    const time = Date.parse(String(attrs.block_timestamp || ""));
    if (!kind || !Number.isFinite(volumeUsd) || !Number.isFinite(time)) continue;
    trades.push({
      time,
      kind,
      volumeUsd,
      txHash: String(attrs.tx_hash || "")
    });
  }
  const window = computeCvd(trades);
  const value = {
    pair: pairAddress,
    source: "geckoterminal",
    observedAt: Date.now(),
    windowCount: window.trades.length,
    ...window
  };
  tradesCache.set(pairAddress, { expiresAt: Date.now() + 15_000, value });
  return value;
}

function toolData(result: ToolResult) {
  return result.ok ? result.data : { error: result.error };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function tokenSymbolFromSearch(data: unknown, fallback = "TOKEN") {
  const tokens = record(data).tokens;
  const first = Array.isArray(tokens) && tokens[0] && typeof tokens[0] === "object" ? record(tokens[0]) : {};
  const symbol = String(first.symbol || "").trim();
  return symbol || fallback;
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

type Board = {
  get_indicators: unknown;
  intelligence_signals: unknown;
  top_movers: unknown;
  anomalies: unknown;
  macro: unknown;
};

const BOARD_TTL_MS = 30_000;
const MARKET_TTL_MS = 45_000;
const emptyBoard = (): Board => ({
  get_indicators: {},
  intelligence_signals: {},
  top_movers: {},
  anomalies: {},
  macro: {}
});

let boardCache: { expiresAt: number; value: Board } | undefined;
let boardInflight: Promise<Board> | undefined;

export async function getBoard(): Promise<Board> {
  if (boardCache && boardCache.expiresAt > Date.now()) return boardCache.value;
  if (boardInflight) return boardInflight;
  boardInflight = (async () => {
    if (!config.clawpump.apiKey) {
      const value = emptyBoard();
      boardCache = { expiresAt: Date.now() + BOARD_TTL_MS, value };
      return value;
    }
    const [indicators, signals, movers, anomalies, macro] = await Promise.all([
      clawpumpMcp.call("get_indicators"),
      clawpumpMcp.call("intelligence_signals"),
      clawpumpMcp.call("get_market_signals", { type: "top-movers" }),
      clawpumpMcp.call("get_market_signals", { type: "anomalies" }),
      clawpumpMcp.call("get_market_signals", { type: "macro" })
    ]);
    const value: Board = {
      get_indicators: toolData(indicators),
      intelligence_signals: toolData(signals),
      top_movers: toolData(movers),
      anomalies: toolData(anomalies),
      macro: toolData(macro)
    };
    boardCache = { expiresAt: Date.now() + BOARD_TTL_MS, value };
    return value;
  })().finally(() => { boardInflight = undefined; });
  return boardInflight;
}

async function mintTools(mint: string) {
  if (!config.clawpump.apiKey) return { search: undefined as ToolResult | undefined, intelligence: undefined as ToolResult | undefined, arbitrage: undefined as ToolResult | undefined };
  const [search, intelligence, arbitrage] = await Promise.all([
    clawpumpMcp.call("token_search", { query: mint }),
    clawpumpMcp.call("intelligence_market", { token: mint }),
    clawpumpMcp.call("arbitrage_prices", { input_mint: config.usdcMint, output_mint: mint })
  ]);
  return { search, intelligence, arbitrage };
}

function assembleMarket(
  mint: string,
  pair: DexPair | undefined,
  pairs: DexPair[],
  candles: Candle[],
  tools: Awaited<ReturnType<typeof mintTools>>,
  board: Board,
  notes: string[]
): OnchainMarket {
  const toolCalls = [tools.search, tools.intelligence, tools.arbitrage].filter((item): item is ToolResult => Boolean(item));
  const failedTools = toolCalls.filter((result) => !result.ok);
  if (failedTools.length) notes.push(...failedTools.map((result) => `${result.tool}: ${result.error}`));

  const provider: Record<string, unknown> = {
    ...board,
    token_search: tools.search ? toolData(tools.search) : {},
    intelligence_market: tools.intelligence ? toolData(tools.intelligence) : {},
    arbitrage: tools.arbitrage ? toolData(tools.arbitrage) : {},
    token_image_url: pair?.info?.imageUrl || null,
    dex_pairs: pairs.slice(0, 16).map((item) => ({
      dex: item.dexId,
      pair: item.pairAddress,
      liquidity_usd: item.liquidity?.usd,
      volume_24h_usd: item.volume?.h24,
      price_usd: Number(item.priceUsd)
    }))
  };
  const intelligence = record(provider.intelligence_market);
  const changes = record(intelligence.price_changes) as Record<string, number>;
  const searchSymbol = tokenSymbolFromSearch(provider.token_search, "");
  const symbol = pair?.baseToken?.symbol || searchSymbol || "TOKEN";
  const name = pair?.baseToken?.name || symbol;
  const priceUsd = num(intelligence.price_usd) ?? num(pair?.priceUsd);
  const change24hPct = changes["24h"] != null ? changes["24h"] * 100 : pair?.priceChange?.h24 ?? null;
  const volume24hUsd = num(intelligence.turnover_24h_usd) ?? num(pair?.volume?.h24);
  const liquidityUsd = num(intelligence.total_liquidity_usd) ?? num(pair?.liquidity?.usd);
  const marketCapUsd = num(intelligence.market_cap_usd) ?? num(pair?.marketCap);
  const fdvUsd = num(intelligence.fdv_usd) ?? num(pair?.fdv);
  const mcpOk = toolCalls.some((item) => item.ok);
  return {
    instrumentId: `solana:${mint}:spot`,
    mint,
    symbol,
    name,
    quoteSymbol: "USD",
    priceUsd,
    change24hPct,
    volume24hUsd,
    liquidityUsd,
    marketCapUsd,
    fdvUsd,
    pairAddress: pair?.pairAddress || null,
    dex: pair?.dexId || null,
    observedAt: Date.now(),
    source: mcpOk ? "ClawPump + on-chain fallback" : "on-chain public fallback",
    degraded: failedTools.length > 0 || !pair,
    notes,
    provider,
    candles,
    signals: [
      { label: "5M", value: changes["5m"] == null ? "—" : `${(changes["5m"] * 100).toFixed(2)}%`, tone: (changes["5m"] || 0) >= 0 ? "positive" : "negative" },
      { label: "1H", value: changes["1h"] == null ? "—" : `${(changes["1h"] * 100).toFixed(2)}%`, tone: (changes["1h"] || 0) >= 0 ? "positive" : "negative" },
      { label: "4H", value: changes["4h"] == null ? "—" : `${(changes["4h"] * 100).toFixed(2)}%`, tone: (changes["4h"] || 0) >= 0 ? "positive" : "negative" },
      { label: "HOLDERS", value: num(intelligence.holders) || "—", tone: "neutral" },
      { label: "POOLS", value: num(intelligence.total_pools) || pairs.length || "—", tone: "neutral" },
      { label: "TURNOVER / LIQ", value: liquidityUsd ? `${((volume24hUsd || 0) / liquidityUsd).toFixed(2)}×` : "—", tone: "neutral" }
    ]
  };
}

const marketInflight = new Map<string, Promise<OnchainMarket>>();

export async function getOnchainMarket(mint: string, interval = "5m"): Promise<OnchainMarket> {
  const cacheKey = `${mint}:${interval}`;
  const cached = marketCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const pending = marketInflight.get(cacheKey);
  if (pending) return pending;
  const work = loadOnchainMarket(mint, interval, cacheKey).finally(() => marketInflight.delete(cacheKey));
  marketInflight.set(cacheKey, work);
  return work;
}

async function loadOnchainMarket(mint: string, interval: string, cacheKey: string): Promise<OnchainMarket> {
  if (interval !== "5m") {
    const base = await getOnchainMarket(mint, "5m");
    const notes = [...(base.notes || [])];
    let candles = await safeGeckoCandles(base.pairAddress || undefined, interval);
    let pairAddress = base.pairAddress;
    let dex = base.dex;
    if (!usableCandles(candles)) {
      const resolved = await resolveGeckoCandles(mint, pairsFromMarket(base), interval, notes);
      if (usableCandles(resolved.candles)) {
        candles = resolved.candles;
        if (resolved.pair?.pairAddress) {
          pairAddress = resolved.pair.pairAddress || pairAddress;
          dex = resolved.pair.dexId || dex;
        }
      } else {
        candles = base.candles;
      }
    }
    const result = { ...base, candles, pairAddress, dex, notes, observedAt: Date.now() };
    marketCache.set(cacheKey, { expiresAt: Date.now() + MARKET_TTL_MS, value: result });
    return result;
  }

  const notes: string[] = [];
  // Dex/Gecko start immediately and never wait on ClawPump.
  const dexP = dexSnapshot(mint).catch((error) => {
    notes.push(`Public market fallback unavailable: ${errorMessage(error)}`);
    return { pair: undefined as DexPair | undefined, pairs: [] as DexPair[] };
  });
  const toolsP = mintTools(mint);
  const boardP = getBoard();

  const snapshot = await dexP;
  const candlesP = resolveGeckoCandles(mint, snapshot.pairs, interval, notes).catch((error) => {
    notes.push(`OHLCV fallback unavailable: ${errorMessage(error)}`);
    return { candles: [] as Candle[], pair: undefined as DexPair | undefined };
  });
  const [resolved, tools, board] = await Promise.all([candlesP, toolsP, boardP]);

  if (!snapshot.pair && !tools.search && mint === config.ansemMint) {
    const fallback = mockAnsemMarket(mint);
    fallback.notes = notes.length ? notes : fallback.notes;
    return fallback;
  }

  const chartPair = resolved.pair || snapshot.pair;
  const result = assembleMarket(mint, chartPair, snapshot.pairs, resolved.candles, tools, board, notes);
  const ttl = resolved.candles.length > 1 ? MARKET_TTL_MS : 8_000;
  marketCache.set(cacheKey, { expiresAt: Date.now() + ttl, value: result });
  return result;
}

const marketCache = new Map<string, { expiresAt: number; value: OnchainMarket }>();
const trenchesCache = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();

/** Cached 5m market provider blob for a mint without fetching; null when nothing is cached. */
export function peekMarketProvider(mint: string): Record<string, unknown> | null {
  const cached = marketCache.get(`${mint}:5m`);
  return cached ? record(cached.value.provider) : null;
}

function cachedIntelligenceHolders(mint: string): number | null {
  for (const key of [`${mint}:5m`, `${mint}:1m`, `${mint}:15m`]) {
    const intel = record(record(marketCache.get(key)?.value.provider).intelligence_market);
    const count = Number(intel.holders);
    if (Number.isFinite(count) && count > 0) return count;
  }
  return null;
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const urls = [config.rpc.primary, config.rpc.fallback].filter(Boolean) as string[];
  let last = "Solana RPC unavailable";
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload
      });
      const body = await response.json().catch(() => null) as RpcEnvelope<T> | null;
      if (!response.ok) {
        last = `RPC ${response.status}`;
        continue;
      }
      if (body?.error) {
        last = body.error.message || "RPC error";
        continue;
      }
      if (body && "result" in body) return body.result as T;
      last = "Empty RPC result";
    } catch (error) {
      last = errorMessage(error);
    }
  }
  throw new Error(last);
}

export async function getTrenches(sort: TrenchSort = "hot") {
  void getBoard();
  const cached = trenchesCache.get(sort);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const data = await fetchJson<Record<string, unknown>>(`https://clawpump.tech/api/tokens?sort=${sort}&limit=60`);
  const value = {
    observedAt: Date.now(),
    source: "clawpump.tech/api/tokens",
    ...data,
    sort
  };
  trenchesCache.set(sort, { expiresAt: Date.now() + 30_000, value });
  return value;
}

export async function getHolders(mint: string) {
  const holderCount = cachedIntelligenceHolders(mint);
  if (/api\.mainnet-beta\.solana\.com/.test(config.rpc.primary) && !config.rpc.fallback) {
    return {
      mint,
      holders: [],
      holderCount,
      top1Pct: null,
      top10Pct: null,
      source: holderCount != null ? "intelligence_market" : "public-rpc-skipped",
      ...(holderCount == null ? { error: "holders RPC skipped on public endpoint" } : {})
    };
  }
  try {
    const largest = await rpcCall<{ value?: TokenAmount[] }>("getTokenLargestAccounts", [mint]);
    const supply = await rpcCall<{ value?: SupplyAmount }>("getTokenSupply", [mint]).catch(() => null);
    const rows = (largest.value || []).slice(0, 20);
    const total = Number(supply?.value?.uiAmount);
    const hasTotal = Number.isFinite(total) && total > 0;
    const holders = rows.map((row) => {
      const uiAmount = Number(row.uiAmount);
      const finite = Number.isFinite(uiAmount);
      return {
        address: String(row.address || ""),
        amount: String(row.amount ?? ""),
        uiAmount: finite ? uiAmount : null,
        pct: finite && hasTotal ? (uiAmount / total) * 100 : null
      };
    });
    const top1Pct = holders[0]?.pct ?? null;
    const top10Pct = hasTotal
      ? holders.slice(0, 10).reduce((sum, row) => sum + (row.pct || 0), 0)
      : null;
    return {
      mint,
      holders,
      holderCount,
      top1Pct,
      top10Pct,
      source: "getTokenLargestAccounts"
    };
  } catch (error) {
    return {
      mint,
      holders: [],
      holderCount,
      top1Pct: null,
      top10Pct: null,
      error: errorMessage(error)
    };
  }
}

export const trenchSorts = TRENCH_SORTS;
