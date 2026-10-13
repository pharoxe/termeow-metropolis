import type { WalletAsset } from "../../shared/portfolio";

/** Native MON as the desk names it in quotes (0x and wallet UIs use the 0xEeee… sentinel; the server maps it for Kuru). */
export const NATIVE_MON = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export type SwapAsset = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  balance?: number;
};

export const MON_ASSET: SwapAsset = { address: NATIVE_MON, symbol: "MON", name: "Monad", decimals: 18 };

export function isNativeAddress(address: string): boolean {
  const value = address.toLowerCase();
  return value === NATIVE_MON.toLowerCase() || value === "0x0000000000000000000000000000000000000000";
}

/** MON first, then every other positive wallet balance except the token being traded. */
export function monadFundingAssets(assets: readonly WalletAsset[], target: string): SwapAsset[] {
  const byAddress = new Map<string, SwapAsset>([[NATIVE_MON.toLowerCase(), MON_ASSET]]);
  for (const asset of assets) {
    const address = asset.mint === "MON" ? NATIVE_MON : asset.mint;
    if (address.toLowerCase() === target.toLowerCase() || !asset.symbol || asset.amount <= 0) continue;
    byAddress.set(address.toLowerCase(), { address, symbol: asset.symbol.toUpperCase(), name: asset.name, decimals: asset.decimals, balance: asset.amount });
  }
  return [...byAddress.values()];
}

export function swapMints(side: "buy" | "sell", target: string, settlement: string) {
  return side === "buy" ? { inputMint: settlement, outputMint: target } : { inputMint: target, outputMint: settlement };
}
