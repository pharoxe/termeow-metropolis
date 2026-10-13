import { describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { monadWalletPortfolio } from "./monadWalletPortfolio";

const WALLET = "0x2222222222222222222222222222222222222222";
const EXTRA = "0x1111111111111111111111111111111111111111";
const ONE_MON = "0xde0b6b3a7640000";
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

describe("monadWalletPortfolio", () => {
  it("combines native MON, core tokens and caller-named ERC-20s, priced from the price feed", async () => {
    const usdc = config.network.tokens.usdc;
    const rpc = vi.fn(async (method: string, params: unknown[]) => {
      if (method === "eth_getBalance") return ONE_MON;
      const { to, data } = params[0] as { to: string; data: string };
      if (data.startsWith("0x70a08231")) return to === usdc ? word(2_500_000n) : to === EXTRA ? word(3n * 10n ** 18n) : "0x0";
      if (data === "0x313ce567") return word(18n);
      return null;
    });
    const fetchPrices = vi.fn(async () => new Map([[config.network.tokens.wmon, 2], [EXTRA, 0.5]]));
    const result = await monadWalletPortfolio(WALLET, [EXTRA.toUpperCase().replace("0X", "0x")], { rpc, fetchPrices });
    expect(result.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ mint: "MON", symbol: "MON", amount: 1, valueUsd: 2 }),
      expect.objectContaining({ mint: usdc, symbol: "USDC", amount: 2.5, valueUsd: 2.5 }),
      expect.objectContaining({ mint: EXTRA, amount: 3, valueUsd: 1.5 })
    ]));
    expect(result.partial).toBe(false);
  });

  it("returns partial native holdings when token reads and prices fail", async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === "eth_getBalance") return "0x1";
      throw new Error("rpc down");
    });
    const result = await monadWalletPortfolio(WALLET, [], { rpc, fetchPrices: async () => { throw new Error("prices down"); } });
    expect(result.partial).toBe(true);
    expect(result.assets[0]).toMatchObject({ symbol: "MON", priceUsd: null });
    expect(result.valuationUnavailable).toBe(true);
  });
});
