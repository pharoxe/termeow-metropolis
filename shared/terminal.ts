import type { Chain, FeedHealth, MarketCandle, Side, TraderKind } from "./wire";
export type TradeEvent = {
  id: string; revision: number; chain: Chain; token: string; pair: string; dex: string;
  tx: string; time: number; receivedAt: number; side: Side; usd: number | null; price: number | null;
  wallet: string | null; handle: string | null; kind: TraderKind | null;
  followers?: number | null; // Sourced public count; absent in older archived observations.
  identitySource: string; source: string; granularity: "execution" | "transaction-pool" | "wallet-net";
  quantity: number | null;
  /**
   * Where `quantity` came from, and how much of a claim it is:
   * "decoded" - the producer read the token amount off the chain (Solana swap delta, Robinhood Transfer units);
   * "derived" - this row's own usd divided by this row's own price, both decoded here ("own" source): exact arithmetic the reader can re-check, not a guess;
   * "provider-estimated" - the same division over a provider's usd and price, so it inherits whatever that provider rounded;
   * "estimated" - a row archived before the split above, when both of those were labelled the same way; the inputs' provenance was not recorded, so it is not re-interpreted here;
   * "unknown" - no basis at all, and `quantity` is null. Never 0.
   */
  quantitySource: "decoded" | "derived" | "provider-estimated" | "estimated" | "unknown";
  confirmation: "observed"; // No finality assertion without a verified block/finality watermark.
};
export type TradeHistory = {
  events: TradeEvent[]; matched: number; nextCursor: string | null; revision: number;
  from: number; to: number; observedAt: number; firstObservedAt: number | null;
  coverage: "captured-only"; error?: string;
};
export type TerminalSnapshot = {
  chain: Chain; token: string; revision: number; observedAt: number;
  events: TradeEvent[]; health: FeedHealth | null; archiveError: string | null;
};
export type CapturedCandles = {
  chain: Chain; address: string; interval: "5s" | "15s" | "1m"; candles: MarketCandle[];
  revision: number; observedAt: number; source: "own tape"; spanMs: number; prints: number; priced: number;
  firstPrintAt: number | null; pricedBySource: Record<string, number>; error?: string;
};
export function chainKey(chain: Chain, value: string): string {
  return chain === "robinhood" ? value.toLowerCase() : value;
}
