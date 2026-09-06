import { fetchJson, UpstreamError } from "../lib/http.js";
import type { Chain, FlowPrint, Side } from "../../shared/wire.js";
import type { Candle } from "../types.js";

export const GECKO_BASE_URL = "https://api.geckoterminal.com/api/v2";
export const GECKO_HEADERS = {
  Accept: "application/json",
  "User-Agent": "terminal-v-solana/0.2"
};
export const GECKO_BUCKET_LIMIT = 25;
export const GECKO_BUCKET_WINDOW_MS = 60_000;
export const GECKO_MAX_WAIT_MS = 20_000;
export const GECKO_BLOCK_MS = 20_000;

export type GeckoPriority = "high" | "low";
export type GeckoGetOptions = { priority?: GeckoPriority };

type Waiter = {
  priority: GeckoPriority;
  enqueuedAt: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

let geckoBlockedUntil = 0;
let sent: number[] = [];
let queue: Waiter[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight = new Map<string, Promise<unknown>>();

export function isGeckoBlocked() {
  return Date.now() < geckoBlockedUntil;
}

export function noteGeckoError(error: unknown) {
  if (error instanceof UpstreamError && error.status === 429) {
    geckoBlockedUntil = Date.now() + GECKO_BLOCK_MS;
  }
}

export function resetGeckoBackoff() {
  geckoBlockedUntil = 0;
}

/** Testing hook: clears the token bucket, the FIFO queue and in-flight dedupe. */
export function resetGeckoBucket() {
  if (timer) clearTimeout(timer);
  timer = null;
  const pending = queue;
  sent = [];
  queue = [];
  inflight = new Map();
  for (const waiter of pending) waiter.reject(budgetError());
}

function budgetError() {
  return new UpstreamError("GeckoTerminal request budget exhausted", 429);
}

function blockedError() {
  return new UpstreamError("GeckoTerminal backoff active after 429", 429);
}

function pruneSent(now: number) {
  sent = sent.filter((at) => at > now - GECKO_BUCKET_WINDOW_MS);
}

function estimateWait(now: number, ahead: number) {
  pruneSent(now);
  const free = GECKO_BUCKET_LIMIT - sent.length;
  if (ahead < free) return 0;
  const index = ahead - free;
  if (index >= sent.length) return Number.POSITIVE_INFINITY;
  return sent[index] + GECKO_BUCKET_WINDOW_MS - now;
}

function countAhead(priority: GeckoPriority) {
  return priority === "high" ? queue.filter((waiter) => waiter.priority === "high").length : queue.length;
}

function enqueue(waiter: Waiter) {
  if (waiter.priority === "low") {
    queue = [...queue, waiter];
    return;
  }
  const lastHigh = queue.reduce((index, item, position) => (item.priority === "high" ? position : index), -1);
  queue = [...queue.slice(0, lastHigh + 1), waiter, ...queue.slice(lastHigh + 1)];
}

function grant(waiter: Waiter, now: number) {
  if (isGeckoBlocked()) return waiter.reject(blockedError());
  if (now - waiter.enqueuedAt > GECKO_MAX_WAIT_MS) return waiter.reject(budgetError());
  sent = [...sent, now];
  waiter.resolve();
}

function pump() {
  const now = Date.now();
  pruneSent(now);
  while (queue.length && sent.length < GECKO_BUCKET_LIMIT) {
    const [head, ...rest] = queue;
    queue = rest;
    grant(head, now);
  }
  schedule(now);
}

function schedule(now: number) {
  if (timer || !queue.length || !sent.length) return;
  const delay = Math.max(0, sent[0] + GECKO_BUCKET_WINDOW_MS - now);
  timer = setTimeout(() => {
    timer = null;
    pump();
  }, delay);
}

function acquire(priority: GeckoPriority): Promise<void> {
  const now = Date.now();
  const wait = estimateWait(now, countAhead(priority));
  if (wait > GECKO_MAX_WAIT_MS) return Promise.reject(budgetError());
  return new Promise<void>((resolve, reject) => {
    enqueue({ priority, enqueuedAt: now, resolve, reject });
    pump();
  });
}

async function send<T>(url: string, priority: GeckoPriority): Promise<T> {
  await acquire(priority);
  try {
    return await fetchJson<T>(url, { headers: GECKO_HEADERS });
  } catch (error) {
    noteGeckoError(error);
    throw error;
  }
}

/** Rate-limited, deduped GET against the GeckoTerminal v2 API. `path` starts with "/networks/...". */
export function geckoGet<T>(path: string, opts: GeckoGetOptions = {}): Promise<T> {
  if (isGeckoBlocked()) return Promise.reject(blockedError());
  const url = `${GECKO_BASE_URL}${path}`;
  const existing = inflight.get(url);
  if (existing) return existing as Promise<T>;
  const request = send<T>(url, opts.priority ?? "high").finally(() => {
    if (inflight.get(url) === request) inflight.delete(url);
  });
  inflight.set(url, request);
  return request;
}

type GeckoTradeRow = { attributes?: Record<string, unknown> };

function toSide(value: unknown): Side | null {
  return value === "buy" || value === "sell" ? value : null;
}

function toUsd(value: unknown): number | null {
  if (value == null || value === "") return null;
  const usd = Number(value);
  return Number.isFinite(usd) ? usd : null;
}

export function normalizeGeckoTrade(row: GeckoTradeRow, chain: Chain, pair: string): FlowPrint | null {
  const attrs = row.attributes || {};
  const side = toSide(attrs.kind);
  const time = Date.parse(String(attrs.block_timestamp || ""));
  const tx = String(attrs.tx_hash || "").trim();
  if (!side || !Number.isFinite(time) || !tx) return null;
  return { chain, pair, tx, time, side, usd: toUsd(attrs.volume_in_usd), source: "geckoterminal" };
}

export async function geckoPoolTrades(network: Chain, pool: string, opts: GeckoGetOptions = {}): Promise<FlowPrint[]> {
  const result = await geckoGet<{ data?: GeckoTradeRow[] }>(`/networks/${network}/pools/${pool}/trades`, opts);
  const prints: FlowPrint[] = [];
  for (const row of result.data || []) {
    const print = normalizeGeckoTrade(row, network, pool);
    if (print) prints.push(print);
  }
  return prints;
}

export type GeckoTokenPool = {
  dex: string;
  pairAddress: string;
  liquidityUsd: number | null;
  volume24Usd: number | null;
};

type GeckoPoolRow = {
  attributes?: { address?: string; reserve_in_usd?: unknown; volume_usd?: { h24?: unknown } };
  relationships?: { dex?: { data?: { id?: string } } };
};

export async function geckoTokenPools(network: Chain, token: string, opts: GeckoGetOptions = {}): Promise<GeckoTokenPool[]> {
  const result = await geckoGet<{ data?: GeckoPoolRow[] }>(`/networks/${network}/tokens/${token}/pools?page=1`, opts);
  const seen = new Set<string>();
  const pools: GeckoTokenPool[] = [];
  for (const row of result.data || []) {
    const pairAddress = String(row.attributes?.address || "").trim();
    if (!pairAddress || seen.has(pairAddress)) continue;
    seen.add(pairAddress);
    pools.push({
      dex: String(row.relationships?.dex?.data?.id || ""),
      pairAddress,
      liquidityUsd: toUsd(row.attributes?.reserve_in_usd),
      volume24Usd: toUsd(row.attributes?.volume_usd?.h24)
    });
  }
  return pools;
}

// ---- Pool OHLCV ----

export const GECKO_OHLCV_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type GeckoOhlcvInterval = (typeof GECKO_OHLCV_INTERVALS)[number];
/** GeckoTerminal caps one OHLCV page at 1000 rows. */
export const GECKO_OHLCV_PAGE_LIMIT = 1000;

const OHLCV_UNITS: Record<GeckoOhlcvInterval, { unit: "minute" | "hour" | "day"; aggregate: number }> = {
  "1m": { unit: "minute", aggregate: 1 },
  "5m": { unit: "minute", aggregate: 5 },
  "15m": { unit: "minute", aggregate: 15 },
  "1h": { unit: "hour", aggregate: 1 },
  "4h": { unit: "hour", aggregate: 4 },
  "1d": { unit: "day", aggregate: 1 }
};

/** `beforeTs` is epoch seconds, as the API takes it; `limit` is clamped to 1..1000. */
export type GeckoOhlcvOptions = GeckoGetOptions & { limit?: number; beforeTs?: number };

type GeckoOhlcvBody = { data?: { attributes?: { ohlcv_list?: unknown } } };

/** `ohlcv_list` rows are [seconds, o, h, l, c, v] newest first; returns ms times, ascending, deduped by time, non-finite rows dropped. */
export function mapGeckoOhlcv(rows: unknown): Candle[] {
  if (!Array.isArray(rows)) return [];
  const byTime = new Map<number, Candle>();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const candle: Candle = {
      time: Number(row[0]) * 1000,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5])
    };
    if (!Object.values(candle).every(Number.isFinite)) continue;
    byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function ohlcvQuery(opts: GeckoOhlcvOptions, aggregate: number): URLSearchParams {
  const limit = Math.min(GECKO_OHLCV_PAGE_LIMIT, Math.max(1, Math.floor(opts.limit ?? GECKO_OHLCV_PAGE_LIMIT)));
  const params = new URLSearchParams({ aggregate: String(aggregate), limit: String(limit) });
  if (opts.beforeTs && Number.isFinite(opts.beforeTs)) params.set("before_timestamp", String(Math.floor(opts.beforeTs)));
  return params;
}

/** One page of pool candles on any GeckoTerminal network through the shared bucket. */
export async function geckoPoolOhlcv(network: Chain, pool: string, interval: GeckoOhlcvInterval, opts: GeckoOhlcvOptions = {}): Promise<Candle[]> {
  const { unit, aggregate } = OHLCV_UNITS[interval];
  const path = `/networks/${network}/pools/${pool}/ohlcv/${unit}?${ohlcvQuery(opts, aggregate)}`;
  const result = await geckoGet<GeckoOhlcvBody>(path, { priority: opts.priority });
  return mapGeckoOhlcv(result.data?.attributes?.ohlcv_list);
}
