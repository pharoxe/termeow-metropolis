import { fetchJson, UpstreamError } from "../lib/http.js";
import type { Chain, FlowPrint, Side } from "../../shared/wire.js";
import { perTokenPrice } from "../flow/printPrice.js";
import type { Candle } from "../types.js";

/**
 * Keyless GeckoTerminal by default (30 calls/min per IP, shared with everything else on that IP). COINGECKO_API_KEY moves
 * the same paths to CoinGecko's on-chain API with a per-key budget: COINGECKO_API_PLAN=demo for the free Demo key,
 * anything else for a paid plan (pro-api, ~500 calls/min).
 */
const COINGECKO_KEY = process.env.COINGECKO_API_KEY?.trim() || undefined;
const COINGECKO_DEMO = process.env.COINGECKO_API_PLAN?.trim().toLowerCase() === "demo";
export const GECKO_BASE_URL = !COINGECKO_KEY ? "https://api.geckoterminal.com/api/v2"
  : COINGECKO_DEMO ? "https://api.coingecko.com/api/v3/onchain" : "https://pro-api.coingecko.com/api/v3/onchain";
export const GECKO_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "termeow-monad/0.3",
  ...(COINGECKO_KEY ? { [COINGECKO_DEMO ? "x-cg-demo-api-key" : "x-cg-pro-api-key"]: COINGECKO_KEY } : {})
};
/** Keyless traffic draws 429s well under the documented 30/min, and each 429 blocks every class for GECKO_BLOCK_MS. */
export const GECKO_BUCKET_LIMIT = !COINGECKO_KEY ? 10 : COINGECKO_DEMO ? 28 : 400;
export const GECKO_BUCKET_WINDOW_MS = 60_000;
export const GECKO_MAX_WAIT_MS = 20_000;
export const GECKO_BLOCK_MS = 20_000;
/** Slots of the bucket only the focused class may take; discovery and background see a bucket of LIMIT - RESERVE. */
export const GECKO_RESERVE_FOCUSED = COINGECKO_KEY ? 5 : 4;

/**
 * Budget classes, served strictly in this order: `focused` (candles/pools of the instrument on screen), `discovery`
 * (trending/new lists), `background` (pool-trade polling behind the own tape). "high"/"low" are the pre-R6 names.
 */
export type GeckoClass = "focused" | "discovery" | "background";
export type GeckoPriority = GeckoClass | "high" | "low";
export type GeckoGetOptions = { priority?: GeckoPriority };
/** `token`: the focused token; when set, side and price are read relative to it (a pool may hold it as the quote leg). */
export type GeckoTradesOptions = GeckoGetOptions & { token?: string };

const CLASS_RANK: Record<GeckoClass, number> = { focused: 0, discovery: 1, background: 2 };

type Waiter = {
  cls: GeckoClass;
  enqueuedAt: number;
  resolve: () => void;
  reject: (error: Error) => void;
};
let geckoBlockedUntil = 0;
let sent: number[] = [];
let queue: Waiter[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight = new Map<string, Promise<unknown>>();

export function toGeckoClass(priority: GeckoPriority | undefined): GeckoClass {
  if (priority === "low") return "background";
  if (priority === "high" || priority === undefined) return "focused";
  return priority;
}

export function isGeckoBlocked() {
  return Date.now() < geckoBlockedUntil;
}

/** Epoch ms until which every Gecko call is refused after an upstream 429; null when not blocked. */
export function geckoBlockedUntilMs(now = Date.now()): number | null {
  return geckoBlockedUntil > now ? geckoBlockedUntil : null;
}

export function noteGeckoError(error: unknown) {
  if (error instanceof UpstreamError && error.status === 429) {
    geckoBlockedUntil = Date.now() + GECKO_BLOCK_MS;
  }
}

export function resetGeckoBackoff() {
  geckoBlockedUntil = 0;
}

/** Testing hook: clears the token bucket, the class-ordered queue and in-flight dedupe. */
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

/** Slots this class may fill: the focused class sees the whole bucket, the others leave the reserve untouched. */
function capacityFor(cls: GeckoClass): number {
  return cls === "focused" ? GECKO_BUCKET_LIMIT : GECKO_BUCKET_LIMIT - GECKO_RESERVE_FOCUSED;
}

function estimateWait(now: number, ahead: number, cls: GeckoClass) {
  pruneSent(now);
  const free = capacityFor(cls) - sent.length;
  if (ahead < free) return 0;
  const index = ahead - free;
  if (index >= sent.length) return Number.POSITIVE_INFINITY;
  return sent[index] + GECKO_BUCKET_WINDOW_MS - now;
}

/** Waiters served before a new one of `cls`: every waiter of an equal or higher class. */
function countAhead(cls: GeckoClass) {
  return queue.filter((waiter) => CLASS_RANK[waiter.cls] <= CLASS_RANK[cls]).length;
}

function enqueue(waiter: Waiter) {
  const last = queue.reduce((index, item, position) => (CLASS_RANK[item.cls] <= CLASS_RANK[waiter.cls] ? position : index), -1);
  queue = [...queue.slice(0, last + 1), waiter, ...queue.slice(last + 1)];
}

function grant(waiter: Waiter, now: number) {
  if (isGeckoBlocked()) return waiter.reject(blockedError());
  if (now - waiter.enqueuedAt > GECKO_MAX_WAIT_MS) return waiter.reject(budgetError());
  sent = [...sent, now];
  waiter.resolve();
}

/** The queue is class-ordered, so once the head cannot fit under its capacity nothing behind it can either. */
function pump() {
  const now = Date.now();
  pruneSent(now);
  while (queue.length && sent.length < capacityFor(queue[0].cls)) {
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
  timer.unref?.();
}

function acquire(cls: GeckoClass): Promise<void> {
  const now = Date.now();
  const wait = estimateWait(now, countAhead(cls), cls);
  if (wait > GECKO_MAX_WAIT_MS) return Promise.reject(budgetError());
  return new Promise<void>((resolve, reject) => {
    enqueue({ cls, enqueuedAt: now, resolve, reject });
    pump();
  });
}

async function send<T>(url: string, cls: GeckoClass): Promise<T> {
  await acquire(cls);
  try {
    return await fetchJson<T>(url, { headers: GECKO_HEADERS });
  } catch (error) {
    noteGeckoError(error);
    throw error;
  }
}

/** Rate-limited, deduped GET against the GeckoTerminal v2 API. `path` starts with "/networks/...". */
export function geckoGet<T>(path: string, opts: GeckoGetOptions = {}): Promise<T> {
  const cls = toGeckoClass(opts.priority);
  if (isGeckoBlocked()) return Promise.reject(blockedError());
  const url = `${GECKO_BASE_URL}${path}`;
  const existing = inflight.get(url);
  if (existing) return existing as Promise<T>;
  const request = send<T>(url, cls).finally(() => {
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

function sameToken(chain: Chain, a: unknown, b: string): boolean {
  if (typeof a !== "string" || !a) return false;
  return chain === "monad" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Side and whole-unit amount of the focused token's leg. Gecko's `kind` is relative to the pool's base token, so with
 * a `token` the legs are matched by address (from_token_address / to_token_address); a row that names the token on
 * neither leg is not this token's trade. Without a `token` (or without leg addresses) the base leg follows `kind`.
 */
function tokenLeg(attrs: Record<string, unknown>, chain: Chain, kind: Side, token?: string): { side: Side; amount: number | null } | null {
  const hasAddresses = typeof attrs.from_token_address === "string" && typeof attrs.to_token_address === "string";
  if (token && hasAddresses) {
    if (sameToken(chain, attrs.to_token_address, token)) return { side: "buy", amount: toUsd(attrs.to_token_amount) };
    if (sameToken(chain, attrs.from_token_address, token)) return { side: "sell", amount: toUsd(attrs.from_token_amount) };
    return null;
  }
  return { side: kind, amount: toUsd(kind === "buy" ? attrs.to_token_amount : attrs.from_token_amount) };
}

export function normalizeGeckoTrade(row: GeckoTradeRow, chain: Chain, pair: string, token?: string): FlowPrint | null {
  const attrs = row.attributes || {};
  const kind = toSide(attrs.kind);
  const time = Date.parse(String(attrs.block_timestamp || ""));
  const tx = String(attrs.tx_hash || "").trim();
  if (!kind || !Number.isFinite(time) || !tx) return null;
  const leg = tokenLeg(attrs, chain, kind, token);
  if (!leg) return null;
  const usd = toUsd(attrs.volume_in_usd);
  return { chain, pair, tx, time, side: leg.side, usd, source: "geckoterminal", ...perTokenPrice(usd, leg.amount) };
}

export async function geckoPoolTrades(network: Chain, pool: string, opts: GeckoTradesOptions = {}): Promise<FlowPrint[]> {
  const result = await geckoGet<{ data?: GeckoTradeRow[] }>(`/networks/${network}/pools/${pool}/trades`, { priority: opts.priority });
  const prints: FlowPrint[] = [];
  for (const row of result.data || []) {
    const print = normalizeGeckoTrade(row, network, pool, opts.token);
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

/** How long a page of candles is reused before asking GeckoTerminal again: about one bar, never under 30 s. */
const OHLCV_FRESH_MS: Record<GeckoOhlcvInterval, number> = { "1m": 30_000, "5m": 60_000, "15m": 120_000, "1h": 300_000, "4h": 900_000, "1d": 1_800_000 };
/** A page this old is still served when GeckoTerminal is rate limited, so a chart degrades to stale rather than empty. */
const OHLCV_STALE_MS = 6 * 3_600_000;
const OHLCV_CACHE_MAX = 400;
const ohlcvCache = new Map<string, { at: number; candles: Candle[] }>();

/** One page of pool candles on any GeckoTerminal network through the shared bucket, cached per page. */
export async function geckoPoolOhlcv(network: Chain, pool: string, interval: GeckoOhlcvInterval, opts: GeckoOhlcvOptions = {}): Promise<Candle[]> {
  const { unit, aggregate } = OHLCV_UNITS[interval];
  const path = `/networks/${network}/pools/${pool}/ohlcv/${unit}?${ohlcvQuery(opts, aggregate)}`;
  const cached = ohlcvCache.get(path);
  if (cached && Date.now() - cached.at < OHLCV_FRESH_MS[interval]) return cached.candles;
  try {
    const result = await geckoGet<GeckoOhlcvBody>(path, { priority: opts.priority });
    const candles = mapGeckoOhlcv(result.data?.attributes?.ohlcv_list);
    ohlcvCache.delete(path);
    ohlcvCache.set(path, { at: Date.now(), candles });
    if (ohlcvCache.size > OHLCV_CACHE_MAX) ohlcvCache.delete(ohlcvCache.keys().next().value!);
    return candles;
  } catch (error) {
    if (cached && Date.now() - cached.at < OHLCV_STALE_MS) return cached.candles;
    throw error;
  }
}
