import type { WalletAsset } from "../../shared/portfolio";

export const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
export const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export type SwapAsset = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  balance?: number;
};

export const SOL_ASSET: SwapAsset = { address: WRAPPED_SOL, symbol: "SOL", name: "Solana", decimals: 9 };
export const ETH_ASSET: SwapAsset = { address: NATIVE_ETH, symbol: "ETH", name: "Ether", decimals: 18 };

export function solanaFundingAssets(assets: readonly WalletAsset[], targetMint: string): SwapAsset[] {
  const byAddress = new Map<string, SwapAsset>([[WRAPPED_SOL, SOL_ASSET]]);
  for (const asset of assets) {
    const address = asset.mint === "SOL" ? WRAPPED_SOL : asset.mint;
    if (address === targetMint || !asset.symbol || asset.amount <= 0) continue;
    byAddress.set(address, { address, symbol: asset.symbol.toUpperCase(), name: asset.name, decimals: asset.decimals, balance: asset.amount });
  }
  return [...byAddress.values()];
}

export function swapMints(side: "buy" | "sell", target: string, settlement: string) {
  return side === "buy" ? { inputMint: settlement, outputMint: target } : { inputMint: target, outputMint: settlement };
}
