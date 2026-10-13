import { config } from "../config.js";
import { errorMessage, fetchJson } from "../lib/http.js";

/**
 * Perpl: fully on-chain CLOB perpetuals on Monad (docs.perpl.xyz). Read-only public market data for the agent and the
 * desk's perps context: GET /api/v1/pub/context (markets + decimals) and GET /api/v1/market-data/ticker (per-market state
 * keyed by market id, integer prices scaled by price_decimals). Field names the docs do not pin down are read
 * defensively and fall back to the documented mainnet market ids.
 */
export const PERPL_SOURCE = "perpl";

/** Documented market ids (docs.perpl.xyz REST page): mainnet and testnet differ. */
export const PERPL_MARKET_IDS: Record<"mainnet" | "testnet", Record<string, string>> = {
  mainnet: { "1": "BTC", "10": "MON", "20": "ETH", "31": "SOL", "40": "HYPE", "50": "ZEC" },
  testnet: { "16": "BTC", "32": "ETH", "48": "SOL", "64": "MON", "256": "ZEC" }
};

export type PerplMarketMeta = { id: string; symbol: string; priceDecimals: number; sizeDecimals: number };

export type PerplMarket = {
  id: string;
  symbol: string;
  markPrice: number | null;
  oraclePrice: number | null;
  lastPrice: number | null;
  bid: number | null;
  ask: number | null;
  /** Price 24 h ago, for the change figure. */
  prevPrice: number | null;
  change24Pct: number | null;
  /** Daily volume in quote units when Perpl reports `dva`. */
  volume24: number | null;
  openInterest: number | null;
  updatedAt: number | null;
};

export type PerplSnapshot = { source: typeof PERPL_SOURCE; observedAt: number; markets: PerplMarket[]; error: string | null; tradeUrl: string };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function int(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function scaled(value: unknown, decimals: number): number | null {
  const raw = int(value);
  return raw === null ? null : raw / 10 ** decimals;
}

export function parseContext(body: unknown, network: "mainnet" | "testnet"): PerplMarketMeta[] {
  const markets = isRecord(body) && Array.isArray(body.markets) ? body.markets : [];
  return markets.flatMap((raw): PerplMarketMeta[] => {
    if (!isRecord(raw)) return [];
    const id = [raw.id, raw.market_id, raw.mid].map((value) => (value === undefined || value === null ? null : String(value))).find(Boolean);
    if (!id) return [];
    const named = [raw.symbol, raw.name, raw.base, raw.base_symbol].find((value): value is string => typeof value === "string" && value.trim() !== "");
    const symbol = (named ?? PERPL_MARKET_IDS[network][id] ?? `#${id}`).replace(/[-/]?(PERP|USD[CT]?)$/i, "").toUpperCase();
    return [{ id, symbol, priceDecimals: int(raw.price_decimals) ?? 0, sizeDecimals: int(raw.size_decimals) ?? 0 }];
  });
}

export function parseTicker(body: unknown, metas: PerplMarketMeta[]): PerplMarket[] {
  const states = isRecord(body) && isRecord(body.d) ? body.d : {};
  const byId = new Map(metas.map((meta) => [meta.id, meta]));
  return Object.entries(states).flatMap(([id, raw]): PerplMarket[] => {
    const meta = byId.get(id);
    if (!meta || !isRecord(raw)) return [];
    const price = (key: string) => scaled(raw[key], meta.priceDecimals);
    const markPrice = price("mrk");
    const prevPrice = price("prv");
    const at = int(raw.at);
    return [{
      id,
      symbol: meta.symbol,
      markPrice,
      oraclePrice: price("orl"),
      lastPrice: price("lst"),
      bid: price("bid"),
      ask: price("ask"),
      prevPrice,
      change24Pct: markPrice !== null && prevPrice ? ((markPrice - prevPrice) / prevPrice) * 100 : null,
      volume24: int(raw.dva),
      openInterest: scaled(raw.oi, meta.sizeDecimals),
      updatedAt: at === null ? null : at < 1e12 ? at * 1000 : at
    }];
  });
}

export class PerplClient {
  private metas: { at: number; value: PerplMarketMeta[] } | null = null;
  private snapshot: PerplSnapshot | null = null;

  constructor(
    private readonly apiUrl: string,
    private readonly network: "mainnet" | "testnet",
    private readonly fetchJsonImpl: typeof fetchJson = fetchJson,
    private readonly now: () => number = Date.now
  ) {}

  private async markets(): Promise<PerplMarketMeta[]> {
    if (this.metas && this.now() - this.metas.at < 30 * 60_000) return this.metas.value;
    const value = parseContext(await this.fetchJsonImpl<unknown>(`${this.apiUrl}/v1/pub/context`), this.network);
    this.metas = { at: this.now(), value };
    return value;
  }

  /** Cached 5 s; a failed refresh returns the last good snapshot with the error attached. */
  async tickers(): Promise<PerplSnapshot> {
    const observedAt = this.now();
    const tradeUrl = this.network === "mainnet" ? "https://app.perpl.xyz" : "https://testnet.perpl.xyz";
    if (this.snapshot && observedAt - this.snapshot.observedAt < 5_000) return this.snapshot;
    try {
      const metas = await this.markets();
      const markets = parseTicker(await this.fetchJsonImpl<unknown>(`${this.apiUrl}/v1/market-data/ticker`), metas);
      this.snapshot = { source: PERPL_SOURCE, observedAt, markets, error: null, tradeUrl };
      return this.snapshot;
    } catch (error) {
      return { source: PERPL_SOURCE, observedAt, markets: this.snapshot?.markets ?? [], error: errorMessage(error), tradeUrl };
    }
  }
}

let shared: PerplClient | null = null;
export function getPerpl(): PerplClient {
  if (!shared) shared = new PerplClient(config.perpl.apiUrl, config.network.network);
  return shared;
}
