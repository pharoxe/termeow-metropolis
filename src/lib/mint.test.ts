import { describe, expect, it } from "vitest";
import { extractSolanaMint } from "./mint";

const mint = "7GCihgDB8fe6KNjn2MYtkzAcoN2JNtPayhQbkK5Lpump";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("extractSolanaMint", () => {
  it("trims and strips wrapping quotes", () => {
    expect(extractSolanaMint(`  "${mint}"  `)).toEqual({ mint });
    expect(extractSolanaMint(`'${usdc}'`)).toEqual({ mint: usdc });
    expect(extractSolanaMint("`" + mint + "`")).toEqual({ mint });
  });

  it("rejects EVM addresses", () => {
    expect(extractSolanaMint("0x1234567890abcdef1234567890abcdef12345678")).toEqual({ error: "Solana mint only" });
    expect(extractSolanaMint("  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48  ")).toEqual({ error: "Solana mint only" });
  });

  it("accepts a bare mint and solana: scheme", () => {
    expect(extractSolanaMint(mint)).toEqual({ mint });
    expect(extractSolanaMint(`solana:${usdc}`)).toEqual({ mint: usdc });
    expect(extractSolanaMint(`solana://${mint}`)).toEqual({ mint });
  });

  it("pulls mints out of common Solana URLs and ignores query/hash", () => {
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
      expect(extractSolanaMint(url), url).toEqual({ mint: url.includes(usdc) ? usdc : mint });
    }
  });

  it("accepts scheme-less pastes and quoted URLs", () => {
    expect(extractSolanaMint(`  "dexscreener.com/solana/${mint}"  `)).toEqual({ mint });
  });

  it("returns null for tickers without a mint", () => {
    expect(extractSolanaMint("BONK")).toBeNull();
    expect(extractSolanaMint("")).toBeNull();
  });
});
