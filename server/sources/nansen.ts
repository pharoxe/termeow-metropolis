import { config } from "../config.js";
import { errorMessage, fetchJson } from "../lib/http.js";

/**
 * Nansen API v1 (docs.nansen.ai) on chain "monad": smart-money netflows, smart-money DEX trades (trailing 24 h), token
 * flow intelligence by wallet segment, and wallet labels. Every endpoint is a POST with an `apikey` header and costs
 * credits, so responses are cached per request body and every caller degrades to an honest "unavailable" without a key.
 */
export const NANSEN_SOURCE = "nansen";
export const NANSEN_CHAIN = "monad";

export type SmartMoneyNetflow = {
  token: string;
  symbol: string | null;
  netFlow1hUsd: number | null;
  netFlow24hUsd: number | null;
  netFlow7dUsd: number | null;
  traderCount: number | null;
  marketCapUsd: number | null;
  tokenAgeDays: number | null;
  sectors: string[];
};

export type SmartMoneyTrade = {
  time: number;
  tx: string;
  trader: string;
  label: string | null;
  boughtToken: string;
  boughtSymbol: string | null;
  soldToken: string;
  soldSymbol: string | null;
  valueUsd: number | null;
};

export type FlowSegment = "smart_trader" | "whale" | "top_pnl" | "public_figure" | "fresh_wallets" | "exchange";
export type TokenFlowIntelligence = Record<FlowSegment, { netFlowUsd: number | null; wallets: number | null }>;
export type WalletLabel = { label: string; category: string | null };

export type NansenResult<T> = { source: typeof NANSEN_SOURCE; observedAt: number; data: T; error: string | null; configured: boolean };

export type NansenClientOptions = {
  apiKey?: string;
  apiUrl: string;
  fetchJsonImpl?: typeof fetchJson;
  now?: () => number;
  ttlMs?: number;
};

const SEGMENTS: FlowSegment[] = ["smart_trader", "whale", "top_pnl", "public_figure", "fresh_wallets", "exchange"];
const CACHE_MAX = 300;

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function address(value: unknown): string | null {
  const raw = text(value);
  return raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : null;
}

function rows(body: unknown): Record<string, unknown>[] {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : null;
  return Array.isArray(data) ? data.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object") : [];
}

export function parseNetflows(body: unknown): SmartMoneyNetflow[] {
  return rows(body).flatMap((row) => {
    const token = address(row.token_address);
    if (!token) return [];
    return [{
      token,
      symbol: text(row.token_symbol),
      netFlow1hUsd: num(row.net_flow_1h_usd),
      netFlow24hUsd: num(row.net_flow_24h_usd),
      netFlow7dUsd: num(row.net_flow_7d_usd),
      traderCount: num(row.trader_count),
      marketCapUsd: num(row.market_cap_usd),
      tokenAgeDays: num(row.token_age_days),
      sectors: Array.isArray(row.token_sectors) ? row.token_sectors.filter((item): item is string => typeof item === "string") : []
    }];
  });
}

export function parseDexTrades(body: unknown): SmartMoneyTrade[] {
  return rows(body).flatMap((row) => {
    const trader = address(row.trader_address);
    const boughtToken = address(row.token_bought_address);
    const soldToken = address(row.token_sold_address);
    const time = Date.parse(String(row.block_timestamp ?? ""));
    if (!trader || !boughtToken || !soldToken || !Number.isFinite(time)) return [];
    return [{
      time,
      tx: text(row.transaction_hash) ?? "",
      trader,
      label: text(row.trader_address_label),
      boughtToken,
      boughtSymbol: text(row.token_bought_symbol),
      soldToken,
      soldSymbol: text(row.token_sold_symbol),
      valueUsd: num(row.trade_value_usd)
    }];
  });
}

export function parseFlowIntelligence(body: unknown): TokenFlowIntelligence {
  const first = rows(body)[0] ?? ((body && typeof body === "object" ? body : {}) as Record<string, unknown>);
  return Object.fromEntries(SEGMENTS.map((segment) => [segment, {
    netFlowUsd: num(first[`${segment}_net_flow_usd`]),
    wallets: num(first[`${segment}_wallet_count`])
  }])) as TokenFlowIntelligence;
}

export function parseLabels(body: unknown): WalletLabel[] {
  return rows(body).flatMap((row) => {
    const label = text(row.label);
    return label ? [{ label, category: text(row.category) }] : [];
  });
}

/** True for labels Nansen uses for its smart-money cohorts ("Smart Trader", "30D Smart Trader", "Fund", ...). */
export function isSmartLabel(label: string | null | undefined): boolean {
  return Boolean(label && /smart|fund|top pnl|whale/i.test(label));
}

export class NansenClient {
  private readonly apiKey?: string;
  private readonly apiUrl: string;
  private readonly fetchJsonImpl: typeof fetchJson;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { at: number; body: unknown }>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private calls = 0;
  private lastError: string | null = null;

  constructor(opts: NansenClientOptions) {
    this.apiKey = opts.apiKey;
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.fetchJsonImpl = opts.fetchJsonImpl ?? fetchJson;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  stats() {
    return { configured: this.configured, calls: this.calls, cached: this.cache.size, lastError: this.lastError };
  }

  async netflows(opts: { limit?: number } = {}): Promise<NansenResult<SmartMoneyNetflow[]>> {
    return this.run("/smart-money/netflow", {
      chains: [NANSEN_CHAIN],
      filters: { include_stablecoins: false, include_native_tokens: false },
      pagination: { page: 1, per_page: Math.min(100, opts.limit ?? 50) },
      order_by: [{ field: "net_flow_24h_usd", direction: "DESC" }]
    }, parseNetflows, []);
  }

  async dexTrades(opts: { token?: string; limit?: number } = {}): Promise<NansenResult<SmartMoneyTrade[]>> {
    return this.run("/smart-money/dex-trades", {
      chains: [NANSEN_CHAIN],
      ...(opts.token ? { filters: { token_address: opts.token } } : {}),
      pagination: { page: 1, per_page: Math.min(500, opts.limit ?? 200) }
    }, parseDexTrades, []);
  }

  async flowIntelligence(token: string, timeframe: "5m" | "1h" | "6h" | "12h" | "1d" | "7d" = "1d"): Promise<NansenResult<TokenFlowIntelligence | null>> {
    return this.run("/tgm/flow-intelligence", { chain: NANSEN_CHAIN, token_address: token, timeframe }, parseFlowIntelligence, null);
  }

  async labels(wallet: string): Promise<NansenResult<WalletLabel[]>> {
    return this.run("/profiler/address/labels", { address: wallet, chain: NANSEN_CHAIN, pagination: { page: 1, per_page: 20 } }, parseLabels, []);
  }

  private async run<T>(path: string, body: unknown, parse: (body: unknown) => T, empty: T): Promise<NansenResult<T>> {
    const observedAt = this.now();
    if (!this.apiKey) return { source: NANSEN_SOURCE, observedAt, data: empty, error: "NANSEN_API_KEY is not configured", configured: false };
    const key = `${path}:${JSON.stringify(body)}`;
    const cached = this.cache.get(key);
    if (cached && observedAt - cached.at < this.ttlMs) return { source: NANSEN_SOURCE, observedAt: cached.at, data: parse(cached.body), error: null, configured: true };
    try {
      let request = this.pending.get(key);
      if (!request) {
        this.calls += 1;
        request = this.fetchJsonImpl<unknown>(`${this.apiUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: this.apiKey },
          body: JSON.stringify(body)
        }).finally(() => this.pending.delete(key));
        this.pending.set(key, request);
      }
      const result = await request;
      this.cache.set(key, { at: this.now(), body: result });
      while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      this.lastError = null;
      return { source: NANSEN_SOURCE, observedAt: this.now(), data: parse(result), error: null, configured: true };
    } catch (error) {
      this.lastError = errorMessage(error);
      // A recent answer beats an empty panel while Nansen is briefly unavailable.
      if (cached) return { source: NANSEN_SOURCE, observedAt: cached.at, data: parse(cached.body), error: this.lastError, configured: true };
      return { source: NANSEN_SOURCE, observedAt, data: empty, error: this.lastError, configured: true };
    }
  }
}

let shared: NansenClient | null = null;
/** Process-wide client built from config on first use so tests never touch the network. */
export function getNansen(): NansenClient {
  if (!shared) shared = new NansenClient({ apiKey: config.nansen.apiKey, apiUrl: config.nansen.apiUrl });
  return shared;
}
