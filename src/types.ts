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
  network: string;
  rpcEndpoint: string;
  routers: Array<{ id: "0x" | "clawpump"; label: string; available: boolean }>;
  ansemMint: string;
  usdcMint: string;
  privyEnabled: boolean;
  integrations: Record<string, string | boolean>;
};
