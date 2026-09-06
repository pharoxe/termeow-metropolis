import type { FlowBar, LighterBook, LighterFunding, LighterLevel, LighterMarket, LighterTrade } from "../../shared/wire";
import { printAgeLabel } from "./flowPanel";
import { money, pct, signedMoney } from "./format";

/** Pure derivations for the LIGHTER panel. No React, no Date.now(): callers pass `now`. Nulls render as an em-dash, never as 0. */

export const LADDER_DEPTH = 10;
export const TAPE_LIMIT = 30;
export const EM_DASH = "—";
const BPS = 10_000;

export type LadderRow = { price: number; size: number; total: number; pct: number };
/** `asks` run farthest → best (top → bottom on screen); `bids` run best → farthest. */
export type Ladder = { asks: LadderRow[]; bids: LadderRow[]; maxSize: number };

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Size bar width in percent of the largest displayed level; 0 when there is nothing to scale against. */
export function sizeBarPct(size: number, maxSize: number): number {
  if (!finite(size) || !finite(maxSize) || maxSize <= 0 || size <= 0) return 0;
  return Math.min(100, (size / maxSize) * 100);
}

function cumulative(levels: LighterLevel[]): Array<Omit<LadderRow, "pct">> {
  const rows: Array<Omit<LadderRow, "pct">> = [];
  let total = 0;
  for (const level of levels) {
    total += level.size;
    rows.push({ price: level.price, size: level.size, total });
  }
  return rows;
}

function cleanLevels(levels: LighterLevel[] | undefined): LighterLevel[] {
  return (levels ?? []).filter((level) => finite(level.price) && finite(level.size) && level.size > 0);
}

/** Top `depth` levels per side (asks ascending, bids descending) with running totals and a shared size scale. */
export function buildLadder(book: Pick<LighterBook, "asks" | "bids"> | null | undefined, depth = LADDER_DEPTH): Ladder {
  const asks = cumulative([...cleanLevels(book?.asks)].sort((a, b) => a.price - b.price).slice(0, depth));
  const bids = cumulative([...cleanLevels(book?.bids)].sort((a, b) => b.price - a.price).slice(0, depth));
  const maxSize = Math.max(0, ...asks.map((row) => row.size), ...bids.map((row) => row.size));
  const withPct = (row: Omit<LadderRow, "pct">): LadderRow => ({ ...row, pct: sizeBarPct(row.size, maxSize) });
  return { asks: asks.map(withPct).reverse(), bids: bids.map(withPct), maxSize };
}

/** (ask − bid) / mid in basis points; null unless both sides are present and positive. */
export function spreadBps(bestAsk: number | null | undefined, bestBid: number | null | undefined): number | null {
  if (!finite(bestAsk) || !finite(bestBid) || bestAsk <= 0 || bestBid <= 0) return null;
  const mid = (bestAsk + bestBid) / 2;
  return mid > 0 ? ((bestAsk - bestBid) / mid) * BPS : null;
}

export function fmtNum(value: number | null | undefined, decimals: number): string {
  if (!finite(value)) return EM_DASH;
  const digits = Math.max(0, Math.min(8, Math.round(decimals)));
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function fmtBps(value: number | null | undefined): string {
  return finite(value) ? `${value.toFixed(value < 10 ? 2 : 1)} bps` : EM_DASH;
}

/** Raw venue rate and direction, no unit assumed ("FUND 0.0012 · LONG"); em-dash when the venue gave none. */
export function fundingLine(funding: LighterFunding | null | undefined): string {
  if (!funding || !finite(funding.rate)) return `FUND ${EM_DASH}`;
  return `FUND ${funding.rate} · ${(funding.direction || "unknown").toUpperCase()}`;
}

export function bookSourceLabel(book: Pick<LighterBook, "source" | "stale" | "error"> | null | undefined): string {
  if (!book || book.source === null) return book?.error ? `NO BOOK · ${book.error}` : "NO BOOK";
  const base = book.source === "stream" ? "STREAM" : "REST";
  return book.stale ? `${base} · STALE` : base;
}

export type TapeRow = { key: string; side: "BUY" | "SELL"; tone: "up" | "dn"; price: string; size: string; usd: string; age: string; liq: boolean };

export function tapeRow(trade: LighterTrade, now: number, priceDecimals: number, sizeDecimals: number): TapeRow {
  return {
    key: trade.id,
    side: trade.takerSide === "buy" ? "BUY" : "SELL",
    tone: trade.takerSide === "buy" ? "up" : "dn",
    price: fmtNum(trade.price, priceDecimals),
    size: fmtNum(trade.size, sizeDecimals),
    usd: money(trade.usd, true),
    age: printAgeLabel(trade.time, now),
    liq: trade.liquidation
  };
}

export function tapeRows(trades: LighterTrade[], now: number, priceDecimals: number, sizeDecimals: number, limit = TAPE_LIMIT): TapeRow[] {
  return trades.slice(0, limit).map((trade) => tapeRow(trade, now, priceDecimals, sizeDecimals));
}

/** "CVD +$12.3K · 120 bars" from the last bar's running sum; a ledger with no bars says so. */
export function cvdLine(bars: FlowBar[] | null | undefined): string {
  const last = bars?.length ? bars[bars.length - 1] : null;
  if (!last) return `CVD ${EM_DASH} · no bars`;
  return `CVD ${signedMoney(last.cvd)} · ${bars!.length} bars`;
}

/** Volume-desc copy; markets without a known volume sort last, ties keep marketId order. */
export function sortMarketsByVolume(markets: LighterMarket[]): LighterMarket[] {
  return [...markets].sort((a, b) => {
    const av = finite(a.volume24Usd) ? a.volume24Usd : -1;
    const bv = finite(b.volume24Usd) ? b.volume24Usd : -1;
    return bv - av || a.marketId - b.marketId;
  });
}

export type MarketRow = { key: number; symbol: string; last: string; change: string; changeTone: "up" | "dn" | ""; vol: string };

export function marketRow(market: LighterMarket): MarketRow {
  const change = market.change24Pct;
  return {
    key: market.marketId,
    symbol: market.symbol,
    last: fmtNum(market.lastPrice, market.priceDecimals),
    change: pct(change),
    changeTone: !finite(change) || change === 0 ? "" : change > 0 ? "up" : "dn",
    vol: money(market.volume24Usd, true)
  };
}
