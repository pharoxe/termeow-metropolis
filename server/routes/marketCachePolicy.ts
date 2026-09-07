import type { MarketResponse } from "../../shared/wire.js";
import { CHAIN_FILL_PENDING_PREFIXES } from "../market/robinhood/chainCandles.js";

/**
 * Cache rules for the Robinhood market route (routes/market.ts), kept apart so each is testable on its own:
 * - an answer is re-read on the short TTL not only while its chain series is still backfilling, but also while it is
 *   a fallback (no candleSource) whose notes quote a first fill still running: measured 2026-09-07, every paste's first
 *   read landed before the priority fill finished, and the 45 s TTL floored "seconds to first bar" at ~50 s;
 * - a fresh answer with no candles and no candleSource never replaces a last-good one that had bars (observed once:
 *   the pair registry momentarily returned no base pool and 607 restored bars vanished for 45 s). The last-good is
 *   served stale with the fresh answer's reason and left uncached, so the next read tries again at once.
 */
export function marketCacheTtlMs(cached: MarketResponse, ttlMs: number, backfillingTtlMs: number): number {
  if (cached.candleSource?.coverage.backfilling) return backfillingTtlMs;
  if (!cached.candleSource && cached.notes.some((note) => CHAIN_FILL_PENDING_PREFIXES.some((prefix) => note.includes(prefix)))) return backfillingTtlMs;
  return ttlMs;
}

/** Null when `fresh` may be cached and served as is; otherwise the last-good answer to serve (stale, with the fresh reason) instead. */
export function lastGoodOverEmpty(lastGood: MarketResponse | undefined, fresh: MarketResponse): MarketResponse | null {
  if (!lastGood || lastGood.candles.length === 0 || fresh.candles.length > 0 || fresh.candleSource) return null;
  const reason = fresh.error ?? fresh.notes.find((note) => /candle|ohlcv|swap|pool/i.test(note)) ?? "no candles in the fresh answer";
  return { ...lastGood, stale: true, error: reason };
}
