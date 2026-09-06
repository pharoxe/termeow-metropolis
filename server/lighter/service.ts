import type { FlowBar, FlowWindow } from "../../shared/wire.js";
import { intervalToMs, isFlowInterval } from "../flow/aggregate.js";
import { alignTo, type LedgerStats } from "../flow/ledger.js";
import { errorMessage } from "../lib/http.js";
import {
  fetchBookSnapshot,
  fetchFunding,
  fetchRecentTrades,
  getMarkets,
  type BookSnapshot,
  type CachedResult,
  type Level,
  type LighterFunding,
  type LighterMarket,
  type LighterTrade
} from "../sources/lighter.js";
import { midAndSpread } from "./book.js";
import { LighterFlow } from "./flow.js";
import { LighterStream, type LighterStreamStatus, type MarketStreamStatus, type WebSocketLike } from "./stream.js";

export const TAKER_SIDE_LABEL = "LIGHTER · TAKER SIDE";
export const BOOTSTRAP_TRADES = 100;
export const FUNDING_TTL_MS = 5 * 60_000;
/** REST book fallback is shared across callers and reused this long, so a 2s panel poll never stacks upstream calls. */
export const BOOK_REST_TTL_MS = 1_500;
export const FLOW_LOOKBACK_BARS = 120;
const DEFAULT_DEPTH = 20;
const DEFAULT_TRADE_LIMIT = 50;
const MAX_MARKET_ID = 1_000_000;

/** REST seam; tests inject fakes, production uses sources/lighter.ts. */
export type LighterApi = {
  getMarkets: () => Promise<CachedResult<LighterMarket[]>>;
  fetchRecentTrades: (marketId: number, limit?: number) => Promise<LighterTrade[]>;
  fetchBookSnapshot: (marketId: number, depth?: number) => Promise<BookSnapshot>;
  fetchFunding: (marketId: number) => Promise<LighterFunding | null>;
};

export type LighterServiceOptions = {
  api?: Partial<LighterApi>;
  makeSocket?: (url: string) => WebSocketLike;
  now?: () => number;
  log?: (msg: string) => void;
};

type Failable = { stale?: boolean; error?: string };

export type MarketsResult = Failable & { markets: LighterMarket[]; observedAt: number | null };
export type BookResult = Failable & {
  marketId: number;
  asks: Level[];
  bids: Level[];
  mid: number | null;
  spreadBps: number | null;
  updatedAt: number | null;
  source: "stream" | "rest" | null;
};
export type TradesResult = Failable & { marketId: number; trades: LighterTrade[]; population: typeof TAKER_SIDE_LABEL; source: "stream" | "rest" | null };
export type FlowResult = Failable & { marketId: number; interval: string; bars: FlowBar[]; windows: FlowWindow[]; coverage: { firstPrintAt: number | null }; observedAt: number };
export type FundingResult = Failable & { marketId: number; funding: LighterFunding | null; observedAt: number | null };
export type ServiceStatus = { stream: LighterStreamStatus; ledger: LedgerStats; bootstrapped: number[]; lastError: string | null; market?: MarketStreamStatus | null };

type FundingCache = { value: LighterFunding | null; observedAt: number };
type RestBook = { at: number; snapshot: Promise<BookSnapshot> };

function validMarketId(marketId: unknown): marketId is number {
  return typeof marketId === "number" && Number.isInteger(marketId) && marketId >= 0 && marketId <= MAX_MARKET_ID;
}

function emptyBook(marketId: number, error?: string): BookResult {
  return { marketId, asks: [], bids: [], mid: null, spreadBps: null, updatedAt: null, source: null, ...(error ? { error } : {}) };
}

/**
 * Singleton-friendly wiring of the websocket stream, the Lighter flow ledger and the REST adapter. Every method
 * returns a value with optional `stale`/`error` fields and never throws; the stream starts lazily on first use.
 */
export class LighterService {
  readonly stream: LighterStream;
  readonly flowLedger: LighterFlow;
  private readonly api: LighterApi;
  private readonly now: () => number;
  private readonly bootstraps = new Map<number, Promise<string | undefined>>();
  private readonly fundingCache = new Map<number, FundingCache>();
  private readonly restBooks = new Map<string, RestBook>();
  private lastError: string | null = null;

  constructor(opts: LighterServiceOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.api = { getMarkets: () => getMarkets(this.now), fetchRecentTrades, fetchBookSnapshot, fetchFunding, ...opts.api };
    this.flowLedger = new LighterFlow();
    this.stream = new LighterStream({
      makeSocket: opts.makeSocket,
      now: this.now,
      log: opts.log,
      onTrades: (marketId, trades) => this.flowLedger.ingestTrades(marketId, trades)
    });
  }

  async markets(): Promise<MarketsResult> {
    try {
      const result = await this.api.getMarkets();
      return { markets: result.value, observedAt: result.observedAt, stale: result.stale, ...(result.error ? { error: result.error } : {}) };
    } catch (error) {
      return { markets: [], observedAt: null, stale: true, error: this.fail(error) };
    }
  }

  /** Merged stream book when a snapshot has arrived on the live connection; otherwise one REST snapshot, labelled. */
  async book(marketId: number, depth = DEFAULT_DEPTH): Promise<BookResult> {
    if (!validMarketId(marketId)) return emptyBook(Number(marketId), "invalid marketId");
    await this.ensure(marketId);
    const live = this.stream.getBook(marketId, depth);
    if (live) return { marketId, ...live, source: "stream" };
    const rest = this.restBook(marketId, depth);
    try {
      const snapshot = await rest.snapshot;
      return { marketId, ...snapshot, ...midAndSpread(snapshot.asks, snapshot.bids), updatedAt: rest.at, source: "rest", stale: true };
    } catch (error) {
      return { ...emptyBook(marketId, this.fail(error)), stale: true };
    }
  }

  async trades(marketId: number, limit = DEFAULT_TRADE_LIMIT): Promise<TradesResult> {
    if (!validMarketId(marketId)) return { marketId: Number(marketId), trades: [], population: TAKER_SIDE_LABEL, source: null, error: "invalid marketId" };
    const bootstrapError = await this.ensure(marketId);
    const trades = this.stream.getTrades(marketId, limit);
    const source = trades.length > 0 ? "stream" : null;
    return { marketId, trades, population: TAKER_SIDE_LABEL, source, ...(bootstrapError ? { stale: true, error: bootstrapError } : {}) };
  }

  async flow(marketId: number, interval = "1m"): Promise<FlowResult> {
    const nowMs = this.now();
    const base = { marketId: Number(marketId), interval, bars: [], windows: [], coverage: { firstPrintAt: null }, observedAt: nowMs };
    if (!validMarketId(marketId)) return { ...base, error: "invalid marketId" };
    if (!isFlowInterval(interval)) return { ...base, error: `unknown flow interval: ${interval}` };
    const bootstrapError = await this.ensure(marketId);
    try {
      const bucketMs = intervalToMs(interval);
      const fromMs = alignTo(nowMs - FLOW_LOOKBACK_BARS * bucketMs, bucketMs);
      const result = this.flowLedger.flow(marketId, interval, fromMs, nowMs, nowMs);
      return { marketId, interval, ...result, observedAt: nowMs, ...(bootstrapError ? { stale: true, error: bootstrapError } : {}) };
    } catch (error) {
      return { ...base, error: this.fail(error) };
    }
  }

  /** Latest hourly funding, cached 5 minutes per market with last-good retention. */
  async funding(marketId: number): Promise<FundingResult> {
    if (!validMarketId(marketId)) return { marketId: Number(marketId), funding: null, observedAt: null, error: "invalid marketId" };
    const cached = this.fundingCache.get(marketId);
    if (cached && this.now() - cached.observedAt < FUNDING_TTL_MS) return { marketId, funding: cached.value, observedAt: cached.observedAt, stale: false };
    try {
      const value = await this.api.fetchFunding(marketId);
      const entry = { value, observedAt: this.now() };
      this.fundingCache.set(marketId, entry);
      return { marketId, funding: value, observedAt: entry.observedAt, stale: false };
    } catch (error) {
      const message = this.fail(error);
      if (cached) return { marketId, funding: cached.value, observedAt: cached.observedAt, stale: true, error: message };
      return { marketId, funding: null, observedAt: null, stale: true, error: message };
    }
  }

  status(marketId?: number): ServiceStatus {
    const base = { stream: this.stream.status(), ledger: this.flowLedger.ledger.stats(), bootstrapped: [...this.bootstraps.keys()], lastError: this.lastError };
    return validMarketId(marketId) ? { ...base, market: this.stream.marketStatus(marketId) } : base;
  }

  stop(): void {
    this.stream.stop();
    this.bootstraps.clear();
    this.restBooks.clear();
  }

  /** One in-flight/recent REST snapshot per (market, depth); a rejected fetch is dropped so the next poll retries. */
  private restBook(marketId: number, depth: number): RestBook {
    const key = `${marketId}:${depth}`;
    const cached = this.restBooks.get(key);
    if (cached && this.now() - cached.at < BOOK_REST_TTL_MS) return cached;
    const entry: RestBook = { at: this.now(), snapshot: this.api.fetchBookSnapshot(marketId, depth) };
    this.restBooks.set(key, entry);
    entry.snapshot.catch(() => {
      if (this.restBooks.get(key) === entry) this.restBooks.delete(key);
    });
    return entry;
  }

  /** Subscribes (or re-touches) the market and runs the one-time REST bootstrap; resolves to an error message, never rejects. */
  private ensure(marketId: number): Promise<string | undefined> {
    if (!this.stream.isSubscribed(marketId)) this.bootstraps.delete(marketId);
    this.stream.subscribe(marketId);
    this.stream.touch(marketId);
    const pending = this.bootstraps.get(marketId);
    if (pending) return pending;
    const run = this.bootstrap(marketId).then((error) => {
      if (error) this.bootstraps.delete(marketId);
      return error;
    });
    this.bootstraps.set(marketId, run);
    return run;
  }

  private async bootstrap(marketId: number): Promise<string | undefined> {
    try {
      const trades = await this.api.fetchRecentTrades(marketId, BOOTSTRAP_TRADES);
      this.stream.seedTrades(marketId, trades);
      this.flowLedger.ingestTrades(marketId, trades);
      return undefined;
    } catch (error) {
      return this.fail(error);
    }
  }

  private fail(error: unknown): string {
    this.lastError = errorMessage(error);
    return this.lastError;
  }
}

let singleton: LighterService | null = null;

/** Lazily constructed process-wide service; the websocket only opens once a market is first requested. */
export function getLighterService(): LighterService {
  if (!singleton) singleton = new LighterService();
  return singleton;
}

export function resetLighterService(): void {
  singleton?.stop();
  singleton = null;
}
