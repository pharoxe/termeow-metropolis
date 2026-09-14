import { describe, expect, it, vi } from "vitest";
import { robinhoodWalletPortfolio } from "./robinhoodWalletPortfolio";

describe("robinhoodWalletPortfolio", () => {
  it("combines native ETH and indexed ERC-20 balances", async () => {
    const load = vi.fn(async (url: string) => url.includes("blockscout") ? [{
      value: "2500000",
      token: { address_hash: "0x1111111111111111111111111111111111111111", decimals: "6", symbol: "USDC", name: "USD Coin", icon_url: "https://img.example/usdc.png", exchange_rate: "1" }
    }] : { result: "0xde0b6b3a7640000" });
    const result = await robinhoodWalletPortfolio("0x2222222222222222222222222222222222222222", load as never);
    expect(result.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ mint: "ETH", symbol: "ETH", amount: 1 }),
      expect.objectContaining({ symbol: "USDC", amount: 2.5, valueUsd: 2.5, imageUrl: "https://img.example/usdc.png" })
    ]));
    expect(result.partial).toBe(false);
  });

  it("returns partial native holdings when the token index is unavailable", async () => {
    const load = vi.fn(async (url: string) => {
      if (url.includes("blockscout")) throw new Error("index down");
      return { result: "0x1" };
    });
    const result = await robinhoodWalletPortfolio("0x2222222222222222222222222222222222222222", load as never);
    expect(result.partial).toBe(true);
    expect(result.assets[0]?.symbol).toBe("ETH");
  });
});
