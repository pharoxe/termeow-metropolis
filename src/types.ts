export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type OnchainMarket = {
  instrumentId: string;
  mint: string;
  symbol: string;
  name: string;
  quoteSymbol: string;
  priceUsd: number | null;
  change24hPct: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  pairAddress: string | null;
  dex: string | null;
  observedAt: number;
  source: string;
  degraded: boolean;
  notes: string[];
  provider: unknown;
  candles: Candle[];
  signals: Array<{ label: string; value: number | string | boolean | null; tone: "positive" | "negative" | "neutral" }>;
};

export type PublicConfig = {
  network: "mainnet" | "testnet";
  chain: { id: number; caip2: string; name: string; nativeSymbol: string; explorer: string; rpcUrl: string; blockMs: number };
  rpcEndpoint: string;
  routers: Array<{ id: "kuru" | "0x"; label: string; available: boolean; chains: Array<"monad"> }>;
  tokens: { wmon: string; usdc: string; ausd: string | null };
  /** Token the desk opens on first visit (WMON unless the server overrides it). */
  featuredToken: string;
  privyEnabled: boolean;
  integrations: Record<string, string | number | boolean>;
};
