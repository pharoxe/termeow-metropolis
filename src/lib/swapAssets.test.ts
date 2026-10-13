import { describe, expect, it } from "vitest";
import { MON_ASSET, isNativeAddress, monadFundingAssets, swapMints } from "./swapAssets";

const TARGET = "0x1111111111111111111111111111111111111111";
const HELD = "0x2222222222222222222222222222222222222222";

describe("swap assets", () => {
  it("keeps MON first and exposes positive wallet tokens except the chart token", () => {
    expect(monadFundingAssets([
      { mint: "MON", symbol: "MON", name: "Monad", amount: 2, decimals: 18, priceUsd: 1, valueUsd: 2 },
      { mint: TARGET.toUpperCase().replace("0X", "0x"), symbol: "TGT", name: "Target", amount: 4, decimals: 18, priceUsd: null, valueUsd: null },
      { mint: HELD, symbol: "usdC", name: "USD Coin", amount: 5, decimals: 6, priceUsd: 1, valueUsd: 5 }
    ], TARGET)).toEqual([{ ...MON_ASSET, balance: 2 }, { address: HELD, symbol: "USDC", name: "USD Coin", decimals: 6, balance: 5 }]);
  });

  it("treats the 0xEeee sentinel and the zero address as native MON", () => {
    expect(isNativeAddress(MON_ASSET.address.toLowerCase())).toBe(true);
    expect(isNativeAddress("0x0000000000000000000000000000000000000000")).toBe(true);
    expect(isNativeAddress(HELD)).toBe(false);
  });

  it("flips the target and settlement for sells", () => {
    expect(swapMints("sell", "target", "settlement")).toEqual({ inputMint: "target", outputMint: "settlement" });
  });
});
