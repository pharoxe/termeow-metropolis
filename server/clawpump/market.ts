import { config } from "../config.js";
import { clawpumpMcp } from "./mcp.js";
import { fetchJson, errorMessage } from "../lib/http.js";
import { mockAnsemMarket } from "../mock/market.js";
import type { Candle, OnchainMarket, ToolResult } from "../types.js";

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
};

function bestPair(pairs: DexPair[] = []) {
  return pairs
    .filter((pair) => pair.chainId === "solana")
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
}

async function dexSnapshot(mint: string) {
  const result = await fetchJson<{ pairs?: DexPair[] }>(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  return { pair: bestPair(result.pairs), pairs: (result.pairs || []).filter((item) => item.chainId === "solana") };
}

async function geckoCandles(pairAddress?: string, interval = "5m"): Promise<Candle[]> {
  if (!pairAddress) return [];
  const intervals: Record<string, [string, number]> = {
    "1m": ["minute", 1], "5m": ["minute", 5], "15m": ["minute", 15],
    "1h": ["hour", 1], "4h": ["hour", 4], "1d": ["day", 1]
  };
  const [unit, aggregate] = intervals[interval] || intervals["5m"];
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}/ohlcv/${unit}?aggregate=${aggregate}&limit=200`;
  const result = await fetchJson<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(url);
  return (result.data?.attributes?.ohlcv_list || [])
    .map((row) => ({
      time: Number(row[0]) * 1000,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5])
    }))
    .filter((row) => Object.values(row).every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
}

function toolData(result: ToolResult) {
  return result.ok ? result.data : { error: result.error };
}

export async function getOnchainMarket(mint: string, interval = "5m"): Promise<OnchainMarket> {
  const cacheKey = `${mint}:${interval}`;
  const cached = marketCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (interval !== "5m") {
    const base = await getOnchainMarket(mint, "5m");
    const candles = await geckoCandles(base.pairAddress || undefined, interval);
    const result = { ...base, candles: candles.length > 1 ? candles : base.candles, observedAt: Date.now() };
    marketCache.set(cacheKey, { expiresAt: Date.now() + 45_000, value: result });
    return result;
  }
  const notes: string[] = [];
  const toolCalls = config.clawpump.apiKey
    ? await Promise.all([
        clawpumpMcp.call("token_search", { query: mint }),
        clawpumpMcp.call("get_indicators"),
        clawpumpMcp.call("intelligence_market", { token: mint }),
        clawpumpMcp.call("intelligence_signals"),
        clawpumpMcp.call("get_market_signals", { type: "top-movers" }),
        clawpumpMcp.call("get_market_signals", { type: "anomalies" }),
        clawpumpMcp.call("get_market_signals", { type: "macro" }),
        clawpumpMcp.call("arbitrage_prices", { input_mint: config.usdcMint, output_mint: mint }),
        clawpumpMcp.call("get_news_feed", { category: "crypto", query: "Solana ANSEM", limit: 12 })
      ])
    : [];

  let pair: DexPair | undefined;
  let pairs: DexPair[] = [];
  try {
    const snapshot = await dexSnapshot(mint);
    pair = snapshot.pair;
    pairs = snapshot.pairs;
  } catch (error) {
    notes.push(`Public market fallback unavailable: ${errorMessage(error)}`);
  }

  if (!pair && toolCalls.length === 0) {
    const fallback = mockAnsemMarket(mint);
    fallback.notes = notes.length ? notes : fallback.notes;
    return fallback;
  }

  let candles: Candle[] = [];
  try {
    candles = await geckoCandles(pair?.pairAddress, interval);
  } catch (error) {
    notes.push(`OHLCV fallback unavailable: ${errorMessage(error)}`);
  }

  const fallback = mockAnsemMarket(mint, Number(pair?.priceUsd) || undefined);
  const failedTools = toolCalls.filter((result) => !result.ok);
  if (failedTools.length) notes.push(...failedTools.map((result) => `${result.tool}: ${result.error}`));

  const provider: Record<string, unknown> = toolCalls.length ? {
    token_search: toolData(toolCalls[0]),
    get_indicators: toolData(toolCalls[1]),
    intelligence_market: toolData(toolCalls[2]),
    intelligence_signals: toolData(toolCalls[3]),
    top_movers: toolData(toolCalls[4]),
    anomalies: toolData(toolCalls[5]),
    macro: toolData(toolCalls[6]),
    arbitrage: toolData(toolCalls[7]),
    news: toolData(toolCalls[8])
  } : {};
  provider.dex_pairs = pairs.slice(0, 16).map((item) => ({
    dex: item.dexId,
    pair: item.pairAddress,
    liquidity_usd: item.liquidity?.usd,
    volume_24h_usd: item.volume?.h24,
    price_usd: Number(item.priceUsd)
  }));
  const intelligence = provider.intelligence_market as Record<string, unknown> | undefined;
  const changes = intelligence?.price_changes as Record<string, number> | undefined;
  const result: OnchainMarket = {
    ...fallback,
    name: pair?.baseToken?.name || fallback.name,
    symbol: pair?.baseToken?.symbol || fallback.symbol,
    priceUsd: Number(intelligence?.price_usd) || Number(pair?.priceUsd) || fallback.priceUsd,
    change24hPct: changes?.["24h"] != null ? changes["24h"] * 100 : pair?.priceChange?.h24 ?? fallback.change24hPct,
    volume24hUsd: Number(intelligence?.turnover_24h_usd) || pair?.volume?.h24 || fallback.volume24hUsd,
    liquidityUsd: Number(intelligence?.total_liquidity_usd) || pair?.liquidity?.usd || fallback.liquidityUsd,
    marketCapUsd: Number(intelligence?.market_cap_usd) || pair?.marketCap || fallback.marketCapUsd,
    fdvUsd: Number(intelligence?.fdv_usd) || pair?.fdv || fallback.fdvUsd,
    pairAddress: pair?.pairAddress || null,
    dex: pair?.dexId || "ClawPump",
    observedAt: Date.now(),
    source: toolCalls.some((result) => result.ok) ? "ClawPump + on-chain fallback" : "on-chain public fallback",
    degraded: failedTools.length > 0 || toolCalls.length === 0,
    notes,
    provider,
    candles: candles.length > 20 ? candles : fallback.candles
  };
  result.signals = [
    { label: "5M", value: changes?.["5m"] == null ? "—" : `${(changes["5m"] * 100).toFixed(2)}%`, tone: (changes?.["5m"] || 0) >= 0 ? "positive" : "negative" },
    { label: "1H", value: changes?.["1h"] == null ? "—" : `${(changes["1h"] * 100).toFixed(2)}%`, tone: (changes?.["1h"] || 0) >= 0 ? "positive" : "negative" },
    { label: "4H", value: changes?.["4h"] == null ? "—" : `${(changes["4h"] * 100).toFixed(2)}%`, tone: (changes?.["4h"] || 0) >= 0 ? "positive" : "negative" },
    { label: "HOLDERS", value: Number(intelligence?.holders) || "—", tone: "neutral" },
    { label: "POOLS", value: Number(intelligence?.total_pools) || pairs.length || "—", tone: "neutral" },
    { label: "TURNOVER / LIQ", value: result.liquidityUsd ? `${((result.volume24hUsd || 0) / result.liquidityUsd).toFixed(2)}×` : "—", tone: "neutral" }
  ];
  marketCache.set(cacheKey, { expiresAt: Date.now() + 45_000, value: result });
  return result;
}

const marketCache = new Map<string, { expiresAt: number; value: OnchainMarket }>();
