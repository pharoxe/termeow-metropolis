import type { Chain, FlowBar, FlowPrint, FlowWindow, PairRow } from "../../shared/wire.js";
import { FLOW_INTERVALS, flowWindows, intervalToMs, isFlowInterval, type FlowInterval } from "../flow/aggregate.js";
import { FlowLedger, toBars, type IngestResult } from "../flow/ledger.js";
import type { LighterTrade } from "../sources/lighter.js";

/** Venue id used as the ledger chain key; see the comment on `Chain` in shared/wire.ts. */
export const LIGHTER_CHAIN: Chain = "lighter";
export const LIGHTER_DEX = "lighter";
export { FLOW_INTERVALS };

export type LighterFlowResult = {
  bars: FlowBar[];
  windows: FlowWindow[];
  coverage: { firstPrintAt: number | null };
};

export function marketPair(marketId: number): string {
  return String(marketId);
}

/** Maps taker-side trades to ledger prints: side = takerSide, tx = trade id, usd stays null when the venue gave none. */
export function toFlowPrints(marketId: number, trades: LighterTrade[]): FlowPrint[] {
  return trades.map((trade) => ({
    chain: LIGHTER_CHAIN,
    pair: marketPair(marketId),
    tx: trade.id,
    time: trade.time,
    side: trade.takerSide,
    usd: trade.usd,
    source: "lighter"
  }));
}

/** Synthetic Tier A pair row so aggregate.flowWindows can treat one market as one pool; unknown fields stay null. */
export function marketPairRow(marketId: number): PairRow {
  return {
    chain: LIGHTER_CHAIN,
    dex: LIGHTER_DEX,
    pairAddress: marketPair(marketId),
    baseMint: marketPair(marketId),
    quoteMint: null,
    liquidityUsd: null,
    volume24Usd: null,
    share24: null,
    txns: { m5: null, h1: null, h6: null, h24: null },
    tier: "A",
    sources: ["lighter"]
  };
}

/** A dedicated flow ledger for Lighter markets; prints are keyed by chain "lighter" and pair = String(marketId). */
export class LighterFlow {
  readonly ledger: FlowLedger;

  constructor(ledger?: FlowLedger) {
    this.ledger = ledger ?? new FlowLedger();
  }

  ingestTrades(marketId: number, trades: LighterTrade[]): IngestResult {
    return this.ledger.ingest(toFlowPrints(marketId, trades));
  }

  flow(marketId: number, interval: FlowInterval | string, fromMs: number, toMs: number, nowMs: number): LighterFlowResult {
    if (!isFlowInterval(interval)) throw new RangeError(`unknown flow interval: ${interval}`);
    const pair = marketPair(marketId);
    const bucketMs = intervalToMs(interval);
    const series = this.ledger.series(LIGHTER_CHAIN, pair, bucketMs, fromMs, toMs);
    return {
      bars: toBars(series, bucketMs),
      windows: flowWindows(this.ledger, LIGHTER_CHAIN, [marketPairRow(marketId)], nowMs),
      coverage: { firstPrintAt: this.ledger.firstPrintAt(LIGHTER_CHAIN, pair) }
    };
  }

  firstPrintAt(marketId: number): number | null {
    return this.ledger.firstPrintAt(LIGHTER_CHAIN, marketPair(marketId));
  }
}
