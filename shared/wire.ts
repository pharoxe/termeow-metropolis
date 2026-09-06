// Wire types shared by server/ and src/. Import type-only from either side.
export type Chain = "solana" | "robinhood";
export type Side = "buy" | "sell";

/** One pool print as ingested into the flow ledger. `usd` is null when it cannot be priced honestly. */
export type FlowPrint = {
  chain: Chain;
  pair: string;
  tx: string;
  time: number; // ms epoch
  side: Side;
  usd: number | null;
  source: "pumpfun" | "geckoterminal" | "own";
};

/** Epoch-aligned bucket (minute or hour). Unpriced prints are counted, never converted. */
export type FlowBucket = {
  t: number; // ms epoch, bucket start
  buyUsd: number;
  sellUsd: number;
  buys: number;
  sells: number;
  unpricedBuys: number;
  unpricedSells: number;
};

/** Bucket aggregated to a chart interval with the running sum from the anchor. */
export type FlowBar = FlowBucket & { delta: number; cvd: number };

export type PairTier = "A" | "B";

export type PairTxns = { buys: number; sells: number } | null;

export type PairRow = {
  chain: Chain;
  dex: string;
  pairAddress: string;
  baseMint: string;
  quoteMint: string | null;
  liquidityUsd: number | null;
  volume24Usd: number | null;
  share24: number | null; // volume24Usd / sum over pairs, null when the sum is unknown
  txns: { m5: PairTxns; h1: PairTxns; h6: PairTxns; h24: PairTxns };
  tier: PairTier;
  sources: string[]; // e.g. ["dexscreener", "geckoterminal", "clawpump", "pumpfun"]
};

export type FlowCoverage = {
  /** Share of the requested window at or after the first ingested print, 0..1. */
  fraction: number;
  firstPrintAt: number | null;
  /** Share of 24h volume carried by the pairs that have trade-level flow, 0..1, null when unknown. */
  volumeShare: number | null;
  tierAPairs: number;
  totalPairs: number;
};

/** Rolling Tier A totals over the last w ms, summed from minute buckets. `aggressor` is buyUsd/(buyUsd+sellUsd), null when both are 0. */
export type FlowWindow = {
  label: "1m" | "5m" | "15m" | "1h";
  buyUsd: number;
  sellUsd: number;
  net: number;
  buys: number;
  sells: number;
  unpriced: number;
  aggressor: number | null;
};

/** One priced Tier A print at or above the large-print threshold. */
export type LargePrint = { pair: string; dex: string; tx: string; time: number; side: Side; usd: number; source: FlowPrint["source"] };

/** Collector health per print source; `prints` is the own tape's counter when the token is tracked. */
export type SourceChip = { name: "pumpfun" | "geckoterminal" | "own"; lastOkAt: number | null; lastError: string | null; prints?: number };

/** Tier A totals from the resolved anchor start; `startMs` null means the anchor is unknown and the totals are zeros. */
export type SinceAnchor = { startMs: number | null; net: number; buyUsd: number; sellUsd: number; prints: number };

export type TokenFlowResponse = {
  chain: Chain;
  address: string;
  interval: string;
  anchor: "window" | "session" | "launch";
  bars: FlowBar[];
  pairs: Array<PairRow & { bars: FlowBar[] }>;
  coverage: FlowCoverage;
  /** All-pairs buy/sell counts per window from DexScreener, Tier B included. Counts only. */
  counts: { m5: PairTxns; h1: PairTxns; h6: PairTxns; h24: PairTxns };
  observedAt: number;
  source: string;
  stale?: boolean;
  error?: string;
  windows?: FlowWindow[];
  largePrints?: LargePrint[];
  sinceAnchor?: SinceAnchor;
  sources?: SourceChip[];
};
