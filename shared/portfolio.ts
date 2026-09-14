export type WalletAsset = { mint: string; symbol: string; name: string; imageUrl?: string | null; amount: number; decimals: number; priceUsd: number | null; valueUsd: number | null };
export type WalletPortfolio = { walletAddress: string; assets: WalletAsset[]; partial: boolean; valuationUnavailable: boolean };
