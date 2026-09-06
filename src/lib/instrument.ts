import type { Chain, MarketResponse, Side, TapePrint } from "../../shared/wire";
import type { OnchainMarket, PoolTrade } from "../types";
import type { InstrumentRef } from "./address";
import { isEvmAddress } from "./address";
import { MINT_RE } from "./mint";

/** Pure helpers for the desk's one-instrument model. No React, no Date.now(). */

export const TAPE_ROW_LIMIT = 14;

export function instrumentLabel(chain: Chain): "SOLANA SPOT" | "ROBINHOOD SPOT" {
  return chain === "solana" ? "SOLANA SPOT" : "ROBINHOOD SPOT";
}

export function brandSuffix(chain: Chain): "sol" | "rhc" {
  return chain === "solana" ? "sol" : "rhc";
}

export function isValidInstrument(ref: InstrumentRef): boolean {
  return ref.chain === "solana" ? MINT_RE.test(ref.address) : isEvmAddress(ref.address);
}

/** Robinhood addresses are hex and compared case-insensitively; Solana base58 is case-sensitive. */
export function sameInstrument(a: InstrumentRef, b: InstrumentRef): boolean {
  if (a.chain !== b.chain) return false;
  return a.chain === "robinhood" ? a.address.toLowerCase() === b.address.toLowerCase() : a.address === b.address;
}

export function instrumentKey(ref: InstrumentRef): string {
  return `${ref.chain}:${ref.chain === "robinhood" ? ref.address.toLowerCase() : ref.address}`;
}

/** Robinhood link-outs. Uniswap param names are kept as specified; DexScreener falls back to the token page without a pair. */
export function tradeLinks(address: string, pairAddress: string | null): { uniswap: string; dexscreener: string } {
  return {
    uniswap: `https://app.uniswap.org/swap?chain=robinhood&outputCurrency=${address}`,
    dexscreener: `https://dexscreener.com/robinhood/${pairAddress || address}`
  };
}

/** The neutral market as the ClawPump panels still expect it. Numbers pass through; nothing is invented. */
export function legacyMarket(m: MarketResponse): OnchainMarket {
  return {
    instrumentId: `${m.instrument.chain}:${m.instrument.address}`,
    mint: m.instrument.address,
    symbol: m.instrument.symbol,
    name: m.instrument.name,
    quoteSymbol: "USD",
    priceUsd: m.priceUsd,
    change24hPct: m.change24Pct,
    volume24hUsd: m.volume24Usd,
    liquidityUsd: m.liquidityUsd,
    marketCapUsd: m.marketCapUsd,
    fdvUsd: m.fdvUsd,
    pairAddress: m.primaryPair?.pairAddress ?? null,
    dex: m.primaryPair?.dex ?? null,
    observedAt: m.observedAt,
    source: m.source,
    degraded: m.degraded,
    notes: m.notes,
    provider: m.provider,
    candles: m.candles,
    signals: []
  };
}

/** The read-route failure envelope: an error with nothing priced and no candles. Last-good stale responses are not empty. */
export function isEmptyMarket(m: MarketResponse): boolean {
  return Boolean(m.error) && !m.stale && m.priceUsd == null && m.candles.length === 0;
}

export type TapeRow = { key: string; side: Side; usd: number | null; time: number };

function fromPrint(print: TapePrint): TapeRow {
  return { key: `${print.pair}:${print.tx}`, side: print.side, usd: print.usd, time: print.time };
}

function fromTrade(trade: PoolTrade): TapeRow {
  return { key: trade.txHash || `${trade.time}-${trade.kind}`, side: trade.kind, usd: trade.volumeUsd, time: trade.time };
}

/** FLOW panel TYPE column: the ledger tape when it has prints, else the legacy Solana pool trades, newest first. */
export function tapeRows(tape: TapePrint[] | undefined, legacy: PoolTrade[], limit = TAPE_ROW_LIMIT): TapeRow[] {
  if (tape && tape.length) return tape.slice(0, limit).map(fromPrint);
  return [...legacy]
    .sort((a, b) => b.time - a.time || b.txHash.localeCompare(a.txHash))
    .slice(0, limit)
    .map(fromTrade);
}
