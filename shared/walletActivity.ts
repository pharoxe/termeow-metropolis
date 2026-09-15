import type { Chain } from "./wire";

export interface WalletActivityItem {
  signature: string;
  observedAt: number;
  status: "confirmed" | "failed";
  kind: "swap" | "transfer" | "transaction";
  feeNative?: number;
  nativeTransfers: Array<{ from: string; to: string; amount: number }>;
  tokenTransfers: Array<{ mint?: string; from?: string; to?: string; amount?: number }>;
  tokenBalanceChanges: Array<{ mint: string; amount: number }>;
  programs: string[];
}

export interface WalletActivityResponse {
  chain: Chain;
  walletAddress: string;
  observedAt: number;
  source: string;
  items: WalletActivityItem[];
  partial: boolean;
}
