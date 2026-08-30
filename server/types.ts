export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type MarketMetric = number | string | boolean | null;

export type OnchainMarket = {
  instrumentId: string;
  mint: string;
  symbol: string;
  name: string;
  quoteSymbol: "USD";
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
  signals: Array<{ label: string; value: MarketMetric; tone: "positive" | "negative" | "neutral" }>;
};

export type ToolResult = {
  ok: boolean;
  tool: string;
  data?: unknown;
  error?: string;
};
