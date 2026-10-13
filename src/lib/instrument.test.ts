import { describe, expect, it } from "vitest";
import type { MarketResponse, TapePrint } from "../../shared/wire";
import {
  brandSuffix, instrumentLabel, isEmptyMarket, isValidInstrument, legacyMarket, sameInstrument, tapeRows, tradeLinks
} from "./instrument";

const SOLANA_MINT = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const FATCOIN = "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01";

function market(overrides: Partial<MarketResponse> = {}): MarketResponse {
  return {
    instrument: { chain: "monad", address: FATCOIN, symbol: "FAT", name: "Fatcoin", image: null, socials: [], websites: [] },
    priceUsd: 0.5,
    marketCapUsd: 1000,
    fdvUsd: null,
    liquidityUsd: 200,
    volume24Usd: 50,
    change24Pct: -3,
    primaryPair: { dex: "uniswap", pairAddress: "0xpair", quoteSymbol: "WETH" },
    candles: [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
    interval: "5m",
    observedAt: 10,
    source: "dexscreener + geckoterminal",
    degraded: false,
    notes: [],
    ...overrides
  };
}

describe("instrument labels", () => {
  it("names the chain on the slab and the brand", () => {
    expect(instrumentLabel("monad")).toBe("MONAD SPOT");
    expect(brandSuffix("monad")).toBe("mon");
  });
});

describe("isValidInstrument / sameInstrument", () => {
  it("validates per chain", () => {
    expect(isValidInstrument({ chain: "monad", address: FATCOIN })).toBe(true);
    expect(isValidInstrument({ chain: "monad", address: SOLANA_MINT })).toBe(false);
  });
  it("compares Monad addresses case-insensitively", () => {
    expect(sameInstrument({ chain: "monad", address: FATCOIN }, { chain: "monad", address: FATCOIN.toUpperCase().replace("0X", "0x") })).toBe(true);
    expect(sameInstrument({ chain: "monad", address: FATCOIN }, { chain: "monad", address: "0x0000000000000000000000000000000000000001" })).toBe(false);
  });
});

describe("tradeLinks", () => {
  it("builds the Kuru, nad.fun, explorer and DexScreener pair links", () => {
    expect(tradeLinks(FATCOIN, "0xpair")).toEqual({
      kuru: `https://www.kuru.io/swap?to=${FATCOIN}`,
      nadfun: `https://nad.fun/tokens/${FATCOIN}`,
      dexscreener: "https://dexscreener.com/monad/0xpair",
      explorer: `https://monadvision.com/token/${FATCOIN}`
    });
  });
  it("falls back to the token page when no primary pair is known", () => {
    expect(tradeLinks(FATCOIN, null).dexscreener).toBe(`https://dexscreener.com/monad/${FATCOIN}`);
  });
});

describe("legacyMarket", () => {
  it("maps the neutral shape back onto the legacy panel shape without inventing values", () => {
    const legacy = legacyMarket(market({ provider: { a: 1 } }));
    expect(legacy.mint).toBe(FATCOIN);
    expect(legacy.symbol).toBe("FAT");
    expect(legacy.change24hPct).toBe(-3);
    expect(legacy.volume24hUsd).toBe(50);
    expect(legacy.pairAddress).toBe("0xpair");
    expect(legacy.dex).toBe("uniswap");
    expect(legacy.provider).toEqual({ a: 1 });
    expect(legacy.fdvUsd).toBeNull();
    expect(legacy.signals).toEqual([]);
  });
  it("keeps pair and dex null when there is no primary pair", () => {
    const legacy = legacyMarket(market({ primaryPair: null, provider: undefined }));
    expect(legacy.pairAddress).toBeNull();
    expect(legacy.dex).toBeNull();
    expect(legacy.provider).toBeUndefined();
  });
});

describe("isEmptyMarket", () => {
  it("is true only for the error envelope with no price and no candles", () => {
    expect(isEmptyMarket(market({ error: "boom", candles: [], priceUsd: null }))).toBe(true);
    expect(isEmptyMarket(market({ error: "stale", stale: true }))).toBe(false);
    expect(isEmptyMarket(market({ candles: [], priceUsd: null }))).toBe(false);
  });
});

describe("tapeRows", () => {
  const print: TapePrint = { pair: "p", dex: "uniswap", tx: "t1", time: 5, side: "sell", usd: null, source: "own" };
  it("maps the ledger tape and keeps unpriced prints null", () => {
    expect(tapeRows([print])).toEqual([{ key: "p:t1", side: "sell", usd: null, time: 5 }]);
  });
  it("is empty when the tape is empty or absent (no legacy fallback)", () => {
    expect(tapeRows([])).toEqual([]);
    expect(tapeRows(undefined)).toEqual([]);
  });
  it("caps at the limit", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ ...print, tx: `t${index}`, time: index }));
    expect(tapeRows(many, 14)).toHaveLength(14);
  });
});
