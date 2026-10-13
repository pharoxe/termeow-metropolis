import { describe, expect, it } from "vitest";
import { extractAddress, isEvmAddress } from "./address";

const mint = "7GCihgDB8fe6KNjn2MYtkzAcoN2JNtPayhQbkK5Lpump";
const fatcoin = "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01";
const fatcoinMixed = "0x12D5EE7917Ca430073C3A638ee1E6F0648a98A01";
const poolId = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const POOL_ERROR = { error: "paste the token address, not the pool" };

const mon = (address: string) => ({ chain: "monad", address });

describe("isEvmAddress", () => {
  it("accepts 0x + 40 hex in any case, with surrounding whitespace", () => {
    expect(isEvmAddress(fatcoin)).toBe(true);
    expect(isEvmAddress(`  ${fatcoinMixed}  `)).toBe(true);
  });

  it("rejects non-addresses, short hex, and 64-hex pool ids", () => {
    expect(isEvmAddress(mint)).toBe(false);
    expect(isEvmAddress("0x1234")).toBe(false);
    expect(isEvmAddress(poolId)).toBe(false);
    expect(isEvmAddress("")).toBe(false);
  });
});

describe("extractAddress: bare addresses", () => {
  it("trims and strips wrapping quotes", () => {
    expect(extractAddress(`  "${fatcoin}"  `)).toEqual(mon(fatcoin));
    expect(extractAddress(`'${fatcoinMixed}'`)).toEqual(mon(fatcoin));
    expect(extractAddress("`" + fatcoin + "`")).toEqual(mon(fatcoin));
  });

  it("routes bare 0x + 40 hex to monad, lowercased", () => {
    expect(extractAddress(fatcoin)).toEqual(mon(fatcoin));
    expect(extractAddress(fatcoinMixed)).toEqual(mon(fatcoin));
  });

  it("does not accept Solana base58 mints", () => {
    expect(extractAddress(mint)).toBeNull();
    expect(extractAddress(`https://pump.fun/coin/${mint}`)).toBeNull();
  });
});

describe("extractAddress: DexScreener", () => {
  it("dexscreener.com/monad/<0x40> → monad, lowercased, any host prefix or scheme", () => {
    expect(extractAddress(`https://dexscreener.com/monad/${fatcoin}`)).toEqual(mon(fatcoin));
    expect(extractAddress(`https://www.dexscreener.com/monad/${fatcoinMixed}?t=1#x`)).toEqual(mon(fatcoin));
    expect(extractAddress(`dexscreener.com/monad/${fatcoin}`)).toEqual(mon(fatcoin));
    expect(extractAddress(`  "dexscreener.com/monad/${fatcoin}/"  `)).toEqual(mon(fatcoin));
  });

  it("dexscreener.com/monad/<0x64 poolId> → pool error", () => {
    expect(extractAddress(`https://dexscreener.com/monad/${poolId}`)).toEqual(POOL_ERROR);
    expect(extractAddress(`dexscreener.com/monad/${poolId.toUpperCase().replace("0X", "0x")}`)).toEqual(POOL_ERROR);
  });

  it("dexscreener.com/monad/<garbage> → null", () => {
    expect(extractAddress("https://dexscreener.com/monad/not-an-address")).toBeNull();
    expect(extractAddress("https://dexscreener.com/monad")).toBeNull();
  });
});

describe("extractAddress: GeckoTerminal, explorers and nad.fun", () => {
  it("geckoterminal.com/monad/pools/<pool> → pool error", () => {
    expect(extractAddress(`https://www.geckoterminal.com/monad/pools/${poolId}`)).toEqual(POOL_ERROR);
    expect(extractAddress(`https://geckoterminal.com/monad/pools/${fatcoin}`)).toEqual(POOL_ERROR);
  });

  it("geckoterminal.com/monad/tokens/<0x40> → monad", () => {
    expect(extractAddress(`https://www.geckoterminal.com/monad/tokens/${fatcoinMixed}`)).toEqual(mon(fatcoin));
  });

  it("geckoterminal.com/monad/<other> → null", () => {
    expect(extractAddress("https://www.geckoterminal.com/monad/trending")).toBeNull();
  });

  it("monadvision.com and monadscan.com token or address pages → monad", () => {
    expect(extractAddress(`https://monadvision.com/token/${fatcoinMixed}`)).toEqual(mon(fatcoin));
    expect(extractAddress(`monadscan.com/address/${fatcoin}?tab=holders`)).toEqual(mon(fatcoin));
    expect(extractAddress(`https://monadvision.com/tx/${poolId}`)).toBeNull();
    expect(extractAddress("https://monadscan.com/token/nope")).toBeNull();
  });

  it("nad.fun token links → monad", () => {
    expect(extractAddress(`https://nad.fun/tokens/${fatcoinMixed}`)).toEqual(mon(fatcoin));
    expect(extractAddress(`nad.fun/token/${fatcoin}`)).toEqual(mon(fatcoin));
  });
});

describe("extractAddress: fall-through", () => {
  it("returns null for tickers and empty input", () => {
    expect(extractAddress("BONK")).toBeNull();
    expect(extractAddress("")).toBeNull();
    expect(extractAddress("   ")).toBeNull();
  });

  it("pulls a bare 0x address out of other text and unknown links", () => {
    expect(extractAddress(`${fatcoinMixed} is the one`)).toEqual(mon(fatcoin));
    expect(extractAddress(`https://dexscreener.com/ethereum/${fatcoin}`)).toEqual(mon(fatcoin));
  });
});
