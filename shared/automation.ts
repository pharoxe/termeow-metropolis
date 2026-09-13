export type AutomationChain = "solana" | "robinhood";
export type AutomationKind = "swap" | "monitor_deployer" | "monitor_wallet" | "monitor_x_launch" | "conditional_swap";
export type AutomationStatus = "pending_approval" | "armed" | "executing" | "completed" | "cancelled" | "failed";

export interface LinkedExitCondition {
  id: string;
  type: "take_profit_pct" | "stop_loss_pct" | "trailing_stop_pct" | "market_cap" | "custom";
  value?: number;
  condition: string;
  sellPercent: number;
  slippageBps?: number;
  activateAfter: "entry_confirmed";
}

export interface AutomationIntent {
  kind: AutomationKind;
  chain: AutomationChain;
  /** Omitted for any-token wallet trackers; populated from the observed trade when entry fires. */
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenName?: string;
  tokenLogoUrl?: string;
  trackedWallet?: string;
  trackedWalletUsername?: string;
  trackedXAccount?: string;
  side?: "buy" | "sell";
  router?: "0x" | "jupiter";
  amountMode?: "fixed" | "wallet_percent";
  amount?: string;
  allocationPercent?: number;
  maxSlippageBps?: number;
  durationHours?: number;
  marketCapMinUsd?: number;
  marketCapMaxUsd?: number;
  /** Maximum fill drift from the tracked trader's observed entry. */
  entryPriceTolerancePct?: number;
  slippageBps?: number;
  condition?: string;
  /** Dormant until a successful entry transaction is reported. */
  exitConditions?: LinkedExitCondition[];
  description: string;
}

export interface UserAutomationPreferences {
  userId: string;
  trackedTraders: Array<{ handle: string; chain: AutomationChain; wallet: string; uses: number; lastUsedAt: number }>;
  favoriteTraders?: Array<{ handle: string; chain: AutomationChain; wallet: string; followers?: number | null }>;
  favoriteTokens?: Array<{ symbol: string; chain?: AutomationChain; address?: string; name?: string }>;
  defaultAllocationPercent?: number;
  defaultSlippageBps?: number;
  defaultDurationHours?: number;
  onboardingCompletedAt?: number;
  lastTrade?: { side: "buy" | "sell"; symbol?: string; chain: AutomationChain; completedAt: number; transactionHash?: string };
  updatedAt: number;
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
  /** Linked exits become eligible only after the entry transaction has completed successfully. */
  activeExitConditions?: LinkedExitCondition[];
  lastSignal?: { source: "wallet" | "x"; eventId: string; tokenAddress: string; observedAt: number; sourceUrl?: string; entryReferencePriceUsd?: number };
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
    /** Locally derived from loaded bars so voice analysis needs no extra RPC or model-side arithmetic. */
    structure?: {
      recentRally: {
        swingLow: number;
        swingHigh: number;
        swingLowTime: number;
        swingHighTime: number;
        retracement0382: number;
        retracement05: number;
        retracement0618: number;
        invalidationBelow: number;
        bars: number;
        confidence: "low" | "medium" | "high";
      } | null;
      calculation: "visible-loaded-bars";
    };
  };
  indicators?: { rsi14?: number | null; macd?: number | null; signal?: number | null; atr14?: number | null; support?: number | null; resistance?: number | null };
  flow?: { buyUsd?: number | null; sellUsd?: number | null; deltaUsd?: number | null; trades?: number | null; regime?: string };
  wallet?: { connected: boolean; network?: AutomationChain };
  observedAt?: number;
}
