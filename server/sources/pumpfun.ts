import type { FlowPrint, Side } from "../../shared/wire.js";
import { createBackoff } from "../lib/backoff.js";
import { fetchJson } from "../lib/http.js";

export const PUMP_BLOCK_MS = 20_000;
const PUMP_TRADES_BASE = "https://swap-api.pump.fun/v2/coins";
const PUMP_PAGE_LIMIT = 100;
const DEFAULT_PAGE_DELAY_MS = 500;
const PUMP_HEADERS = {
  Accept: "application/json",
  "User-Agent": "terminal-v-solana/0.2"
};

export type PumpTradesPage = { prints: FlowPrint[]; nextCursor: string | null; hasMore: boolean };

export type WalkPumpOptions = {
  untilMs: number;
  maxPages: number;
  pageDelayMs?: number;
  onPage?: (prints: FlowPrint[]) => void;
  startCursor?: string;
  sleep?: (ms: number) => Promise<void>;
};

export type WalkPumpResult = {
  pages: number;
  prints: number;
  oldestMs: number | null;
  nextCursor: string | null;
  stoppedBy: "until" | "maxPages" | "end";
};

export function pumpPoolFor(mint: string): string {
  return `pumpfun:${mint}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSide(value: unknown): Side | null {
  return value === "buy" || value === "sell" ? value : null;
}

function parseUsd(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const usd = Number(value);
  return Number.isFinite(usd) ? usd : null;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function parseTrade(row: unknown, pair: string): FlowPrint | null {
  if (!isRecord(row) || typeof row.tx !== "string" || row.tx === "") return null;
  const side = parseSide(row.type);
  const time = parseTime(row.timestamp);
  if (side === null || time === null) return null;
  return { chain: "solana", pair, tx: row.tx, time, side, usd: parseUsd(row.amountUsd), source: "pumpfun" };
}

function parseCursor(pagination: unknown): { nextCursor: string | null; hasMore: boolean } {
  if (!isRecord(pagination)) return { nextCursor: null, hasMore: false };
  const nextCursor = typeof pagination.nextCursor === "string" && pagination.nextCursor !== "" ? pagination.nextCursor : null;
  return { nextCursor, hasMore: pagination.hasMore === true && nextCursor !== null };
}

/** Normalizes one measured swap-api.pump.fun trades payload. Unknown sides and unparseable timestamps are dropped. */
export function parsePumpTradesResponse(json: unknown, mint: string): PumpTradesPage {
  const pair = pumpPoolFor(mint);
  const rows = isRecord(json) && Array.isArray(json.trades) ? json.trades : [];
  const prints = rows.map((row) => parseTrade(row, pair)).filter((print): print is FlowPrint => print !== null);
  return { prints, ...parseCursor(isRecord(json) ? json.pagination : null) };
}

function pumpTradesUrl(mint: string, cursor?: string): string {
  const params = new URLSearchParams({ limit: String(PUMP_PAGE_LIMIT) });
  if (cursor) params.set("cursor", cursor);
  return `${PUMP_TRADES_BASE}/${encodeURIComponent(mint)}/trades?${params.toString()}`;
}

const backoff = createBackoff("pump.fun", PUMP_BLOCK_MS);

export const isPumpBlocked = backoff.isBlocked;
export const resetPumpBackoff = backoff.reset;

/** One trades page; rejects immediately for PUMP_BLOCK_MS after any 429 instead of hitting the host again. */
export async function fetchPumpTradesPage(mint: string, cursor?: string): Promise<PumpTradesPage> {
  if (backoff.isBlocked()) throw backoff.blockedError();
  try {
    const json = await fetchJson<unknown>(pumpTradesUrl(mint, cursor), { headers: PUMP_HEADERS });
    return parsePumpTradesResponse(json, mint);
  } catch (error) {
    backoff.noteError(error);
    throw error;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function oldestOf(prints: FlowPrint[]): number | null {
  return prints.reduce<number | null>((oldest, print) => (oldest === null || print.time < oldest ? print.time : oldest), null);
}

function minOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** Walks pages newest-to-oldest until a page reaches `untilMs`, `maxPages` is hit, or the feed ends. Resume with `startCursor`. */
export async function walkPumpTradesBack(mint: string, opts: WalkPumpOptions): Promise<WalkPumpResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const pageDelayMs = opts.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
  let cursor = opts.startCursor;
  let pages = 0;
  let prints = 0;
  let oldestMs: number | null = null;
  while (pages < opts.maxPages) {
    const page = await fetchPumpTradesPage(mint, cursor);
    pages += 1;
    prints += page.prints.length;
    const pageOldest = oldestOf(page.prints);
    oldestMs = minOrNull(oldestMs, pageOldest);
    opts.onPage?.(page.prints);
    if (pageOldest !== null && pageOldest < opts.untilMs) return { pages, prints, oldestMs, nextCursor: page.nextCursor, stoppedBy: "until" };
    if (!page.hasMore || page.nextCursor === null) return { pages, prints, oldestMs, nextCursor: null, stoppedBy: "end" };
    if (pages >= opts.maxPages) return { pages, prints, oldestMs, nextCursor: page.nextCursor, stoppedBy: "maxPages" };
    cursor = page.nextCursor;
    await sleep(pageDelayMs);
  }
  return { pages, prints, oldestMs, nextCursor: cursor ?? null, stoppedBy: "maxPages" };
}
