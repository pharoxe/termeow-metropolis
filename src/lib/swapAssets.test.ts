import { describe, expect, it } from "vitest";
import { SOL_ASSET, solanaFundingAssets, swapMints } from "./swapAssets";

describe("swap assets", () => {
  it("keeps SOL first and exposes positive wallet tokens except the chart token", () => {
    expect(solanaFundingAssets([
      { mint: "SOL", symbol: "SOL", name: "Solana", amount: 2, decimals: 9, priceUsd: 1, valueUsd: 2 },
      { mint: "target", symbol: "TGT", name: "Target", amount: 4, decimals: 6, priceUsd: null, valueUsd: null },
      { mint: "held", symbol: "usdC", name: "USD Coin", amount: 5, decimals: 6, priceUsd: 1, valueUsd: 5 }
    ], "target")).toEqual([{ ...SOL_ASSET, balance: 2 }, { address: "held", symbol: "USDC", name: "USD Coin", decimals: 6, balance: 5 }]);
  });

  it("flips the target and settlement for sells", () => {
    expect(swapMints("sell", "target", "settlement")).toEqual({ inputMint: "target", outputMint: "settlement" });
  });
});
