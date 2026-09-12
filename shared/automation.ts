export type AutomationChain = "solana" | "robinhood";
export type AutomationKind = "swap" | "monitor_deployer" | "conditional_swap";
export type AutomationStatus = "pending_approval" | "armed" | "executing" | "completed" | "cancelled" | "failed";

export interface AutomationIntent {
  kind: AutomationKind;
  chain: AutomationChain;
  tokenAddress: string;
  tokenSymbol?: string;
  tokenName?: string;
  tokenLogoUrl?: string;
  trackedWallet?: string;
  trackedWalletUsername?: string;
  side?: "buy" | "sell";
  router?: "0x" | "jupiter";
  amountMode?: "fixed" | "wallet_percent";
  amount?: string;
  allocationPercent?: number;
  maxSlippageBps?: number;
  durationHours?: number;
  marketCapMinUsd?: number;
  marketCapMaxUsd?: number;
  condition?: string;
  description: string;
}

export interface AutomationRecord {
  id: string;
  userId: string;
  intent: AutomationIntent;
  status: AutomationStatus;
  source: "elevenlabs_voice" | "terminal";
  conversationId?: string;
  contextDigest?: string;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  cancelledAt?: number;
  approvalMethod?: "privy_passkey_mfa";
  failure?: string;
  transactionHash?: string;
}

export interface TerminalAgentSnapshot {
  route?: string;
  chain?: AutomationChain;
  token?: { address: string; symbol?: string; name?: string; logoUrl?: string };
  chart?: {
    timeframe: string;
    unit?: "price" | "mcap";
    scale?: "linear" | "log";
    priceUsd?: number | null;
    marketCapUsd?: number | null;
    change24Pct?: number | null;
    visibleFrom?: number | null;
    visibleTo?: number | null;
    latestCandle?: { time: number; open: number; high: number; low: number; close: number; volume?: number } | null;
    loadedBars?: number;
  };
  indicators?: { rsi14?: number | null; macd?: number | null; signal?: number | null; atr14?: number | null; support?: number | null; resistance?: number | null };
  flow?: { buyUsd?: number | null; sellUsd?: number | null; deltaUsd?: number | null; trades?: number | null; regime?: string };
  wallet?: { connected: boolean; network?: AutomationChain };
  observedAt?: number;
}
