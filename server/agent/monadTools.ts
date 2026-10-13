import { z } from "zod";
import { config } from "../config.js";
import { errorMessage, fetchJson } from "../lib/http.js";
import { getNansen } from "../sources/nansen.js";
import { nadfunToken } from "../sources/nadfun.js";
import { getPerpl } from "../sources/perpl.js";
import { KuruFlowClient } from "../trading/kuru.js";
import { EVM_RECIPIENT } from "./credits.js";

/**
 * Read-only Monad research tools behind POST /api/agent/tools/research (definitions: shared/monadAgentTools.mjs).
 * Every answer is tagged execution:false and cached briefly so a chatty agent cannot fan out paid upstream calls.
 */
const evmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Expected a 0x contract").transform((value) => value.toLowerCase());
const schemas = {
  token_search: z.object({ query: z.string().trim().min(1).max(100) }).strict(),
  get_price: z.object({ tokens: z.string().max(220).transform((value) => value.split(",").map((token) => token.trim()).filter(Boolean)).pipe(z.array(evmAddress).min(1).max(5)) }).strict(),
  kuru_quote: z.object({
    token_in: evmAddress,
    token_out: evmAddress,
    amount: z.string().regex(/^[1-9]\d{0,77}$/),
    slippage_bps: z.number().int().min(1).max(500).default(50),
    wallet: evmAddress.optional()
  }).strict(),
  nadfun_token: z.object({ token: evmAddress }).strict(),
  perps_markets: z.object({}).strict(),
  smart_money_netflow: z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict(),
  smart_money_trades: z.object({ token: evmAddress.optional(), limit: z.number().int().min(1).max(50).default(20) }).strict(),
  token_flow_intelligence: z.object({ token: evmAddress, timeframe: z.enum(["5m", "1h", "6h", "12h", "1d", "7d"]).default("1d") }).strict()
};
type ToolName = keyof typeof schemas;
const TTL_MS: Record<ToolName, number> = {
  token_search: 30_000, get_price: 10_000, kuru_quote: 3_000, nadfun_token: 60_000, perps_markets: 5_000,
  smart_money_netflow: 300_000, smart_money_trades: 120_000, token_flow_intelligence: 300_000
};

export function parseResearchTool(name: string, args: unknown) {
  const upstream = name.replace(/^monad_/, "");
  if (!Object.hasOwn(schemas, upstream)) throw new Error("Research tool is not available to the agent");
  return { upstream: upstream as ToolName, args: schemas[upstream as ToolName].parse(args) as Record<string, unknown> };
}

type DexPair = {
  chainId?: string;
  pairAddress?: string;
  dexId?: string;
  url?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  marketCap?: number;
  fdv?: number;
};

function compactPair(pair: DexPair) {
  return {
    token: pair.baseToken?.address?.toLowerCase() ?? null,
    symbol: pair.baseToken?.symbol ?? null,
    name: pair.baseToken?.name ?? null,
    quote: pair.quoteToken?.symbol ?? null,
    dex: pair.dexId ?? null,
    pair: pair.pairAddress ?? null,
    priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
    liquidityUsd: pair.liquidity?.usd ?? null,
    volume24Usd: pair.volume?.h24 ?? null,
    change24Pct: pair.priceChange?.h24 ?? null,
    marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
    url: pair.url ?? null
  };
}

const kuru = new KuruFlowClient({ apiUrl: config.kuru.apiUrl });

async function run(tool: ToolName, args: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case "token_search": {
      const body = await fetchJson<{ pairs?: DexPair[] }>(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(String(args.query))}`);
      const pairs = (body.pairs ?? []).filter((pair) => pair.chainId === "monad").sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const seen = new Set<string>();
      return { candidates: pairs.filter((pair) => { const key = pair.baseToken?.address?.toLowerCase() ?? ""; if (!key || seen.has(key)) return false; seen.add(key); return true; }).slice(0, 8).map(compactPair) };
    }
    case "get_price": {
      const tokens = args.tokens as string[];
      const body = await fetchJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/monad/${tokens.join(",")}`);
      const best = new Map<string, DexPair>();
      for (const pair of Array.isArray(body) ? body : []) {
        const key = pair.baseToken?.address?.toLowerCase();
        if (!key || !tokens.includes(key)) continue;
        const current = best.get(key);
        if (!current || (pair.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) best.set(key, pair);
      }
      return { prices: tokens.map((token) => best.has(token) ? compactPair(best.get(token)!) : { token, priceUsd: null, note: "No Monad pair listed on DexScreener" }) };
    }
    case "kuru_quote": {
      // A quote needs an address for the bearer token; the treasury stands in when the agent previews without a wallet.
      const quote = await kuru.quote({
        userAddress: String(args.wallet ?? EVM_RECIPIENT),
        tokenIn: String(args.token_in),
        tokenOut: String(args.token_out),
        amount: String(args.amount),
        slippageBps: Number(args.slippage_bps)
      });
      return { router: "Kuru Flow", output: quote.output, minOut: quote.minOut, routerAddress: quote.transaction.to, note: "Preview only; amounts are smallest units of the output token." };
    }
    case "nadfun_token":
      return nadfunToken(String(args.token));
    case "perps_markets":
      return getPerpl().tickers();
    case "smart_money_netflow": {
      const result = await getNansen().netflows({ limit: Number(args.limit) });
      return { ...result, data: result.data.slice(0, Number(args.limit)) };
    }
    case "smart_money_trades": {
      const result = await getNansen().dexTrades({ token: args.token as string | undefined, limit: 100 });
      return { ...result, data: result.data.slice(0, Number(args.limit)) };
    }
    case "token_flow_intelligence":
      return getNansen().flowIntelligence(String(args.token), args.timeframe as "1d");
  }
}

const cache = new Map<string, { at: number; result: unknown }>();
const pending = new Map<string, Promise<unknown>>();

export async function runResearchTool(name: string, raw: unknown) {
  const { upstream, args } = parseResearchTool(name, raw);
  const key = JSON.stringify([upstream, args]);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS[upstream]) return cached.result;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const task = (async () => {
    try {
      const evidence = await run(upstream, args);
      const encoded = JSON.stringify(evidence);
      const compact = encoded.length <= 18_000 ? evidence : { tool: upstream, truncated: true, excerpt: encoded.slice(0, 18_000), note: "Partial provider response; do not infer omitted evidence." };
      const output = { source: "Monad research", tool: upstream, observedAt: new Date().toISOString(), execution: false, ok: true, evidence: compact };
      if (cache.size >= 200) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: Date.now(), result: output });
      return output;
    } catch (error) {
      return { source: "Monad research", tool: upstream, observedAt: new Date().toISOString(), execution: false, ok: false, error: errorMessage(error) };
    }
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
