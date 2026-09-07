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
  /** Attributed trader wallet when the receipt named one (R3); absent when unattributed. */
  trader?: TraderRef;
  /** USD per token at this print, from the print's own amounts and quote price; null or absent when the source gives none. Never carried over from another print. */
  price?: number | null;
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
  /** Newest Tier A prints across pairs from the ledger ring, time desc, at most 40. */
  tape?: TapePrint[];
  /** FOMO trader fills for this token when the trader service is running; absent otherwise. */
  fomo?: TokenFlowFomo;
};

// ---- Chain-neutral market (GET /api/market/:chain/:address) ----

/** One priced or unpriced Tier A print from the ledger ring, dex resolved from the registry PairRow. */
export type TapePrint = { pair: string; dex: string; tx: string; time: number; side: Side; usd: number | null; source: FlowPrint["source"]; trader?: TraderRef; price?: number | null };

export type MarketCandle = { time: number; open: number; high: number; low: number; close: number; volume: number };

// ---- Own-tape candles (GET /api/flow/candles/:chain/:address) ----

export type FlowCandleInterval = "5s" | "15s" | "1m";

/**
 * Candles built only from ledger ring prints that carry `price` (OHLC = price, volume = summed usd); buckets with no
 * priced print are absent, never filled. `prints` counts every ring print merged, `priced` those that made candles;
 * `spanMs` is newest minus oldest priced print. The ring is 200 prints per pair, so this is minutes of history, not hours.
 */
export type FlowCandlesResponse = {
  chain: Chain;
  address: string;
  interval: FlowCandleInterval;
  candles: MarketCandle[];
  source: "own tape";
  spanMs: number;
  prints: number;
  priced: number;
  firstPrintAt: number | null;
  /** Priced prints per producer (only sources with at least one priced print); the rings hold every Tier A source, not just this server's decoder. */
  pricedBySource: Partial<Record<FlowPrint["source"], number>>;
  observedAt: number;
  stale?: boolean;
  error?: string;
};

/**
 * One instrument on either chain. Solana adapts getOnchainMarket (ClawPump intel rides in `provider`);
 * Robinhood assembles DexScreener pairs + GeckoTerminal pool OHLCV. `stale`/`error` follow the read-route contract.
 */
export type MarketResponse = {
  instrument: {
    chain: Chain;
    address: string;
    symbol: string;
    name: string;
    image: string | null;
    socials: Array<{ type: string; url: string }>;
    websites: string[];
  };
  priceUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  volume24Usd: number | null;
  change24Pct: number | null;
  primaryPair: { dex: string; pairAddress: string; quoteSymbol: string | null } | null;
  candles: MarketCandle[];
  interval: string;
  observedAt: number;
  source: string;
  degraded: boolean;
  notes: string[];
  provider?: unknown;
  stale?: boolean;
  error?: string;
};

// ---- Launches (GET /api/launches) ----

/**
 * One launchpad token on either chain as the launch index knows it. Nulls mean "not exposed by any source yet";
 * `tracked` is populated only from an external tracked-trader population (label it, e.g. "robinhoodtrenches").
 */
export type LaunchRow = {
  chain: Chain;
  launchpad: string;
  token: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  creator: string | null;
  curve: string | null;
  pool: string | null;
  createdAt: number;
  tx: string;
  graduatedAt: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24Usd: number | null;
  change24Pct: number | null;
  /** When priceUsd/marketCapUsd were last refreshed by a pricing source (ms); null until any source has priced the row. */
  pricedAt: number | null;
  curveBuys: number;
  curveSells: number;
  curveNetUsd: number | null;
  tracked: {
    buyers: number;
    usdIn: number;
    usdOut: number;
    firstBuyer: { handle: string; followers: number | null; at: number } | null;
    honeypot: boolean | null;
  } | null;
  sources: string[];
  observedAt: number;
};

export type LaunchesResponse = {
  launches: LaunchRow[];
  window: string;
  chain: "all" | Chain;
  observedAt: number;
  sources: Array<{ name: string; lastOkAt: number | null; lastError: string | null }>;
  /** True when the list hit the route cap: older rows inside `window` were cut and only the newest are returned. */
  truncated?: boolean;
  stale?: boolean;
  error?: string;
};

// ---- FOMO trader fills (R3, optional block on GET /api/flow/token) ----

/**
 * One fill attributed to a trader wallet. `kind` is "fomo" only when the wallet passed the EIP-7702 designator
 * check on this server, "seeded" while a robinhoodtrenches-listed wallet still awaits that check (never shown as FOMO);
 * `handle`/`followers` come from the robinhoodtrenches trader population and stay null otherwise.
 */
export type FomoFill = {
  chain: Chain;
  token: string;
  pair: string;
  dex: string;
  tx: string;
  time: number; // ms epoch
  side: Side;
  usd: number | null;
  trader: TraderRef;
  /** Token symbol when the launch index knows it (cross-token tape); absent otherwise. */
  symbol?: string | null;
  /** USD per token at the fill when the print carried one; null or absent otherwise. */
  price?: number | null;
  /** Transfer-decoded fills only: usd from the wallet's own quote Transfer ("wallet_leg") or the custody hub's USDG leg ("hub_leg"); absent when usd came with the print or is null. */
  usdVia?: "wallet_leg" | "hub_leg";
};

/** Optional FOMO block on TokenFlowResponse: `population` = FOMO wallets seen by this server, `handles` = robinhoodtrenches handles known; seeded fills ride in `fills` tagged "seeded", `windows` sum verified-FOMO fills only. */
export type TokenFlowFomo = { fills: FomoFill[]; windows: FlowWindow[]; population: number; handles: number };

// ---- Trader identity (R3: server/traders) ----

/**
 * "fomo" only when eth_getCode(wallet) equals the EIP-7702 FOMO designator on this server; "other" when the check said
 * otherwise; "seeded" when the wallet is on the robinhoodtrenches traders list and the check has not answered here yet.
 * A seeded wallet is never shown as FOMO; the classifier itself only ever writes fomo/other.
 */
export type TraderKind = "fomo" | "other" | "seeded";
/** A wallet attributed to a print. `handle`/`followers` come from the robinhoodtrenches population and stay null otherwise. */
export type TraderRef = { address: string; kind: TraderKind; handle: string | null; followers: number | null };

// ---- FOMO routes (GET /api/fomo/tape, GET /api/fomo/board) ----

export type FomoChainScope = "all" | Chain;
export type FomoBoardWindow = "1h" | "24h" | "7d";

/** Newest FOMO and seeded fills across every tracked token as this server saw them; `population` = FOMO wallets seen here. */
export type FomoTapeResponse = {
  chain: FomoChainScope;
  fills: FomoFill[];
  population: number;
  handles: number;
  observedAt: number;
  stale?: boolean;
  error?: string;
};

/** One wallet on the board. netUsd = buyUsd - sellUsd (net flow into tokens, not P&L); closed/wins are realized-partial round trips. */
export type FomoBoardRow = {
  chain: Chain;
  wallet: string;
  handle: string | null;
  followers: number | null;
  fills: number;
  buyUsd: number;
  sellUsd: number;
  netUsd: number;
  /** Fills with usd null: in `fills`, absent from the usd totals (a wallet whose fills are all unpriced ranks at netUsd 0 for lack of dollars, not because it moved none). */
  unpriced: number;
  closed: number;
  wins: number;
  /** Wilson lower bound of wins/closed; null under 5 closed trades. */
  wilsonLow: number | null;
  lastSeenAt: number;
  profileUrl: string | null;
  /** Verbatim from the book: "fomo" (7702 check passed here), "seeded" (listed, check pending), null when never classified. */
  kind: TraderKind | null;
};

export type FomoBoardResponse = {
  chain: FomoChainScope;
  window: FomoBoardWindow;
  rows: FomoBoardRow[];
  population: number;
  /** Always name the population: "FOMO wallets seen by this server". */
  populationLabel: string;
  /** Oldest fill still in the ring when the window reaches past it (numbers are truncated, not lifetime); null otherwise. */
  truncatedAt: number | null;
  observedAt: number;
  stale?: boolean;
  error?: string;
};
