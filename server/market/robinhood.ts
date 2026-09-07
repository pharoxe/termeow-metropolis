import type { CandleSourceInfo, Chain, MarketResponse, PairRow } from "../../shared/wire.js";
import type { Candle } from "../types.js";
import type { DexScreenerPair, RawTokenPairsResult, TokenPairsResult } from "../sources/dexscreener.js";
import { GECKO_OHLCV_PAGE_LIMIT, type GeckoOhlcvInterval, type GeckoOhlcvOptions } from "../sources/gecko.js";
import { errorMessage } from "../lib/http.js";
import { UNKNOWN_SYMBOL, num, socialLinks, text, websiteLinks } from "./envelope.js";
import type { ChainCandlesResult } from "./robinhood/chainCandles.js";
import { CANDLE_SOURCE_GECKO } from "./robinhood/swapCandles.js";

export const ROBINHOOD_MARKET_SOURCE = "dexscreener + geckoterminal";
/** Same depth as the Solana path: at most two 1000-row pages, the second only when the first was full. */
export const CANDLE_PAGES = 2;
const CHAIN: Chain = "robinhood";
/** Provenance notes the chain path always emits; they describe the series rather than a degradation. */
const INFORMATIONAL_NOTE = /^(candles from |USD via current |\d+ own-tape print)/;

export type RobinhoodMarketDeps = {
  getTokenPairs: (chain: Chain, address: string) => Promise<TokenPairsResult>;
  geckoPoolOhlcv: (network: Chain, pool: string, interval: GeckoOhlcvInterval, opts?: GeckoOhlcvOptions) => Promise<Candle[]>;
  /** Raw DexScreener token-pairs body for symbol/name/image/socials/priceUsd/change/fdv/mcap; metadata degrades when absent. */
  fetchDexPairsRaw?: (chain: Chain, address: string) => Promise<RawTokenPairsResult>;
  /** R6: candles from the primary pool's own Swap logs ("chain swaps"); throws with a reason -> GeckoTerminal fallback, labelled. */
  chainCandles?: (primary: PairRow, interval: GeckoOhlcvInterval) => Promise<ChainCandlesResult>;
  now?: () => number;
};

type LoadedCandles = { value: Candle[]; notes: string[]; source: string; candleSource?: CandleSourceInfo; stale?: boolean };

type Loaded<T> = { value: T; note: string | null };

function sameAddress(left: string | undefined, right: string): boolean {
  return String(left || "").toLowerCase() === right.toLowerCase();
}

function byDepth(a: PairRow, b: PairRow): number {
  const liquidity = (b.liquidityUsd ?? -Infinity) - (a.liquidityUsd ?? -Infinity);
  if (liquidity !== 0) return liquidity;
  return (b.volume24Usd ?? -Infinity) - (a.volume24Usd ?? -Infinity);
}

/** Deepest pool where the token is the base side; null when the registry has none. */
export function primaryPairOf(address: string, pairs: PairRow[]): PairRow | null {
  return [...pairs].filter((pair) => sameAddress(pair.baseMint, address)).sort(byDepth)[0] ?? null;
}

async function loadRaw(address: string, deps: RobinhoodMarketDeps): Promise<Loaded<DexScreenerPair[]>> {
  if (!deps.fetchDexPairsRaw) return { value: [], note: "DexScreener token metadata not requested" };
  try {
    const raw = await deps.fetchDexPairsRaw(CHAIN, address);
    return { value: raw.pairs, note: raw.stale ? `DexScreener token metadata stale: ${raw.error ?? "unknown"}` : null };
  } catch (error) {
    return { value: [], note: `DexScreener token metadata unavailable: ${errorMessage(error)}` };
  }
}

/** Newest page first; walks back with before_timestamp only while pages come back full. Newer rows win on a time clash. */
async function walkBackCandles(deps: RobinhoodMarketDeps, pool: string, interval: GeckoOhlcvInterval): Promise<Candle[]> {
  let collected: Candle[] = [];
  let beforeTs: number | undefined;
  for (let page = 0; page < CANDLE_PAGES; page += 1) {
    const rows = await deps.geckoPoolOhlcv(CHAIN, pool, interval, { limit: GECKO_OHLCV_PAGE_LIMIT, ...(beforeTs ? { beforeTs } : {}) });
    if (!rows.length) break;
    collected = [...rows, ...collected];
    if (rows.length < GECKO_OHLCV_PAGE_LIMIT) break;
    beforeTs = Math.floor(rows[0].time / 1000);
  }
  const byTime = new Map<number, Candle>();
  for (const candle of collected) byTime.set(candle.time, candle);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function loadGeckoCandles(deps: RobinhoodMarketDeps, primary: PairRow, interval: GeckoOhlcvInterval, source: string, notes: string[]): Promise<LoadedCandles> {
  try {
    return { value: await walkBackCandles(deps, primary.pairAddress, interval), notes, source };
  } catch (error) {
    return { value: [], notes: [...notes, `OHLCV unavailable: ${errorMessage(error)}`], source };
  }
}

/**
 * R6 order: the pool's own swaps first (one series, "chain swaps"); GeckoTerminal only when that path throws, labelled
 * "geckoterminal" with the reason. Without a chainCandles dep the legacy Gecko-only behaviour and label are unchanged.
 */
async function loadCandles(deps: RobinhoodMarketDeps, primary: PairRow | null, interval: GeckoOhlcvInterval): Promise<LoadedCandles> {
  if (!primary) return { value: [], notes: ["No DexScreener pool with this token as base"], source: ROBINHOOD_MARKET_SOURCE };
  if (!deps.chainCandles) return loadGeckoCandles(deps, primary, interval, ROBINHOOD_MARKET_SOURCE, []);
  try {
    const chain = await deps.chainCandles(primary, interval);
    return { value: chain.candles, notes: chain.notes, source: chain.candleSource.kind, candleSource: chain.candleSource, stale: chain.stale };
  } catch (error) {
    return loadGeckoCandles(deps, primary, interval, CANDLE_SOURCE_GECKO, [`chain swaps unavailable: ${errorMessage(error)}; candles are GeckoTerminal pool OHLCV`]);
  }
}

/** Raw row for the primary pool (prices) and any raw row with this token as base (token metadata). */
function rawRows(raw: DexScreenerPair[], address: string, primary: PairRow | null): { pair: DexScreenerPair | null; token: DexScreenerPair | null } {
  const pair = primary ? raw.find((row) => sameAddress(row.pairAddress, primary.pairAddress)) ?? null : null;
  const token = pair ?? raw.find((row) => sameAddress(row.baseToken?.address, address)) ?? null;
  return { pair, token };
}

function instrumentOf(address: string, token: DexScreenerPair | null): MarketResponse["instrument"] {
  const symbol = text(token?.baseToken?.symbol) ?? UNKNOWN_SYMBOL;
  return {
    chain: CHAIN,
    address,
    symbol,
    name: text(token?.baseToken?.name) ?? symbol,
    image: text(token?.info?.imageUrl),
    socials: socialLinks(token?.info?.socials),
    websites: websiteLinks(token?.info?.websites)
  };
}

/**
 * DexScreener pairs choose the primary pool and give liquidity/volume; the raw row gives price, change, mcap, fdv
 * and token metadata; GeckoTerminal gives candles. Throws only when getTokenPairs has nothing (the route handles that).
 */
export async function assembleRobinhoodMarket(address: string, interval: GeckoOhlcvInterval, deps: RobinhoodMarketDeps): Promise<MarketResponse> {
  const registry = await deps.getTokenPairs(CHAIN, address);
  const primary = primaryPairOf(address, registry.pairs);
  const [raw, candles] = await Promise.all([loadRaw(address, deps), loadCandles(deps, primary, interval)]);
  const { pair, token } = rawRows(raw.value, address, primary);
  const notes = [
    registry.stale ? `DexScreener pairs stale: ${registry.error ?? "unknown"}` : null,
    raw.note,
    ...candles.notes
  ].filter((note): note is string => note !== null);
  return {
    instrument: instrumentOf(address, token),
    priceUsd: num(pair?.priceUsd),
    marketCapUsd: num(pair?.marketCap),
    fdvUsd: num(pair?.fdv),
    liquidityUsd: primary?.liquidityUsd ?? null,
    volume24Usd: primary?.volume24Usd ?? null,
    change24Pct: num(pair?.priceChange?.h24),
    primaryPair: primary ? { dex: primary.dex, pairAddress: primary.pairAddress, quoteSymbol: text(pair?.quoteToken?.symbol) } : null,
    candles: candles.value,
    interval,
    observedAt: (deps.now ?? Date.now)(),
    source: candles.source,
    degraded: notes.some((note) => !INFORMATIONAL_NOTE.test(note)),
    notes,
    ...(candles.candleSource ? { candleSource: candles.candleSource } : {}),
    // a chain series whose last top-up failed ends at the last good head: say so on the wire, not only in a note
    ...(candles.stale ? { stale: true } : {})
  };
}
