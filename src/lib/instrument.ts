import type { Chain, MarketResponse, Side, TapePrint } from "../../shared/wire";
import type { OnchainMarket } from "../types";
import type { InstrumentRef } from "./address";
import { isEvmAddress } from "./address";

/** Pure helpers for the desk's one-instrument model. No React, no Date.now(). */

export const TAPE_ROW_LIMIT = 14;

export function instrumentLabel(_chain: Chain): "MONAD SPOT" {
  return "MONAD SPOT";
}

export function brandSuffix(_chain: Chain): "mon" {
  return "mon";
}

export function isValidInstrument(ref: InstrumentRef): boolean {
  return ref.chain === "monad" && isEvmAddress(ref.address);
}

/** Monad addresses are hex and compared case-insensitively. */
export function sameInstrument(a: InstrumentRef, b: InstrumentRef): boolean {
  return a.chain === b.chain && a.address.toLowerCase() === b.address.toLowerCase();
}

export function instrumentKey(ref: InstrumentRef): string {
  return `${ref.chain}:${ref.address.toLowerCase()}`;
}

/** Monad link-outs: Kuru (native venue), nad.fun, DexScreener (token page without a pair) and the explorer. */
export function tradeLinks(address: string, pairAddress: string | null): { kuru: string; nadfun: string; dexscreener: string; explorer: string } {
  return {
    kuru: `https://www.kuru.io/swap?to=${address}`,
    nadfun: `https://nad.fun/tokens/${address}`,
    dexscreener: `https://dexscreener.com/monad/${pairAddress || address}`,
    explorer: `https://monadvision.com/token/${address}`
  };
}

/** The neutral market as the legacy panels expect it. Numbers pass through; nothing is invented. */
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

/** FLOW panel TYPE column: the ledger tape (Tier A prints, newest first as served); empty when the ledger has none. */
export function tapeRows(tape: TapePrint[] | undefined, limit = TAPE_ROW_LIMIT): TapeRow[] {
  return (tape ?? []).slice(0, limit).map(fromPrint);
}
