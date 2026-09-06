import { describe, expect, it } from "vitest";
import { extractAddress, isEvmAddress } from "./address";

const mint = "7GCihgDB8fe6KNjn2MYtkzAcoN2JNtPayhQbkK5Lpump";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ansem = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const solPair = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const fatcoin = "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01";
const fatcoinMixed = "0x12D5EE7917Ca430073C3A638ee1E6F0648a98A01";
const poolId = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const POOL_ERROR = { error: "paste the token address, not the pool" };

const sol = (address: string) => ({ chain: "solana", address });
const rh = (address: string) => ({ chain: "robinhood", address });

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
    expect(extractAddress(`  "${mint}"  `)).toEqual(sol(mint));
    expect(extractAddress(`'${usdc}'`)).toEqual(sol(usdc));
    expect(extractAddress("`" + ansem + "`")).toEqual(sol(ansem));
    expect(extractAddress(`  "${fatcoin}"  `)).toEqual(rh(fatcoin));
  });

  it("routes bare base58 (32-44) to solana as given", () => {
    expect(extractAddress(mint)).toEqual(sol(mint));
    expect(extractAddress(ansem)).toEqual(sol(ansem));
  });

  it("routes bare 0x + 40 hex to robinhood, lowercased", () => {
    expect(extractAddress(fatcoin)).toEqual(rh(fatcoin));
    expect(extractAddress(fatcoinMixed)).toEqual(rh(fatcoin));
  });

  it("accepts the solana: scheme via the mint helper", () => {
    expect(extractAddress(`solana:${usdc}`)).toEqual(sol(usdc));
    expect(extractAddress(`solana://${mint}`)).toEqual(sol(mint));
  });
});

describe("extractAddress: DexScreener", () => {
  it("dexscreener.com/solana/<mint> → solana, ignoring query and hash", () => {
    expect(extractAddress(`https://dexscreener.com/solana/${mint}?embed=1#chart`)).toEqual(sol(mint));
    expect(extractAddress(`https://www.dexscreener.com/solana/${usdc}`)).toEqual(sol(usdc));
  });

  it("dexscreener.com/solana/<pair> → solana with the pair address as given (server resolves)", () => {
    expect(extractAddress(`https://dexscreener.com/solana/${solPair}`)).toEqual(sol(solPair));
  });

  it("dexscreener.com/robinhood/<0x40> → robinhood, lowercased, any host prefix or scheme", () => {
    expect(extractAddress(`https://dexscreener.com/robinhood/${fatcoin}`)).toEqual(rh(fatcoin));
    expect(extractAddress(`https://www.dexscreener.com/robinhood/${fatcoinMixed}?t=1#x`)).toEqual(rh(fatcoin));
    expect(extractAddress(`dexscreener.com/robinhood/${fatcoin}`)).toEqual(rh(fatcoin));
    expect(extractAddress(`  "dexscreener.com/robinhood/${fatcoin}/"  `)).toEqual(rh(fatcoin));
  });

  it("dexscreener.com/robinhood/<0x64 poolId> → pool error", () => {
    expect(extractAddress(`https://dexscreener.com/robinhood/${poolId}`)).toEqual(POOL_ERROR);
    expect(extractAddress(`dexscreener.com/robinhood/${poolId.toUpperCase().replace("0X", "0x")}`)).toEqual(POOL_ERROR);
  });

  it("dexscreener.com/robinhood/<garbage> → null", () => {
    expect(extractAddress("https://dexscreener.com/robinhood/not-an-address")).toBeNull();
    expect(extractAddress("https://dexscreener.com/robinhood")).toBeNull();
  });
});

describe("extractAddress: GeckoTerminal and explorers", () => {
  it("geckoterminal.com/robinhood/pools/<pool> → pool error", () => {
    expect(extractAddress(`https://www.geckoterminal.com/robinhood/pools/${poolId}`)).toEqual(POOL_ERROR);
    expect(extractAddress(`https://geckoterminal.com/robinhood/pools/${fatcoin}`)).toEqual(POOL_ERROR);
  });

  it("geckoterminal.com/robinhood/tokens/<0x40> → robinhood", () => {
    expect(extractAddress(`https://www.geckoterminal.com/robinhood/tokens/${fatcoinMixed}`)).toEqual(rh(fatcoin));
  });

  it("geckoterminal.com/robinhood/<other> → null", () => {
    expect(extractAddress("https://www.geckoterminal.com/robinhood/trending")).toBeNull();
  });

  it("robinhoodchain.blockscout.com/token/<0x40> → robinhood", () => {
    expect(extractAddress(`https://robinhoodchain.blockscout.com/token/${fatcoinMixed}`)).toEqual(rh(fatcoin));
    expect(extractAddress(`robinhoodchain.blockscout.com/token/${fatcoin}?tab=holders`)).toEqual(rh(fatcoin));
  });

  it("robinscan.io/token/<0x40> → robinhood", () => {
    expect(extractAddress(`https://robinscan.io/token/${fatcoin}`)).toEqual(rh(fatcoin));
    expect(extractAddress(`https://www.robinscan.io/token/${fatcoinMixed}`)).toEqual(rh(fatcoin));
  });

  it("explorer paths that are not /token/<0x40> → null", () => {
    expect(extractAddress(`https://robinscan.io/tx/${poolId}`)).toBeNull();
    expect(extractAddress(`https://robinhoodchain.blockscout.com/address/${fatcoin}`)).toBeNull();
    expect(extractAddress("https://robinscan.io/token/nope")).toBeNull();
  });
});

describe("extractAddress: Solana URL forms delegate to extractSolanaMint", () => {
  it("pulls mints out of every URL form mint.test.ts accepts", () => {
    const urls = [
      `https://dexscreener.com/solana/${mint}?embed=1#chart`,
      `https://www.dexscreener.com/solana/${usdc}`,
      `https://pump.fun/${mint}`,
      `https://pump.fun/coin/${mint}?foo=1`,
      `https://birdeye.so/token/${usdc}?chain=solana`,
      `https://www.geckoterminal.com/solana/tokens/${mint}`,
      `https://axiom.trade/meme/${mint}`,
      `https://photon-sol.tinyastro.io/en/lp/${mint}`,
      `https://gmgn.ai/sol/token/${mint}`,
      `https://gmgn.ai/sol/token/xScP1abc_${mint}`
    ];
    for (const url of urls) {
      expect(extractAddress(url), url).toEqual(sol(url.includes(usdc) ? usdc : mint));
    }
  });

  it("accepts scheme-less pastes and quoted URLs", () => {
    expect(extractAddress(`  "dexscreener.com/solana/${mint}"  `)).toEqual(sol(mint));
  });
});

describe("extractAddress: fall-through", () => {
  it("returns null for tickers, empty input, and unknown-chain EVM URLs", () => {
    expect(extractAddress("BONK")).toBeNull();
    expect(extractAddress("")).toBeNull();
    expect(extractAddress("   ")).toBeNull();
    expect(extractAddress(`https://dexscreener.com/ethereum/${fatcoin}`)).toBeNull();
    expect(extractAddress(`${fatcoin} is the one`)).toBeNull();
  });

  it("never returns the mint helper's Solana-only error", () => {
    const result = extractAddress(`https://dexscreener.com/base/${fatcoin}`);
    expect(result).toBeNull();
  });
});
