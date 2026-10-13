import type { Chain, FlowPrint, FlowWindow, SmartFill, PairRow } from "../../shared/wire.js";
import { smartPair } from "../traders/transfers.js";
import { FLOW_WINDOW_LABELS, WINDOW_MS } from "./aggregate.js";

/**
 * SMART fills for one focused token (R4 wire stage). Two stores can hold the same fill: the trader book (token-keyed,
 * pools and the "smart:<token>" pseudo-pair) and the SMART ledger ring (pair-keyed, one ring per pair, deduped by tx
 * only within a pair). This module merges both, keeps one row per tx+wallet+side, and sums the windows from the merged
 * list so a fill seen by R3 under a pool pair and by R4 under "smart:<token>" is never counted twice. Pure; no I/O.
 */

/** Book rows pulled for the merge: enough for a 1h window at the busiest tokens seen; the wire tape is sliced afterwards. */
export const SMART_MERGE_LIMIT = 2000;

export type SmartLedgerLike = { recentPrints(chain: string, pair: string, limit?: number): FlowPrint[] };

/** tx + wallet + side: a bundled user-op can hold one wallet's buy and sell of the same token in one tx, and those are two fills. */
export function smartFillKey(fill: Pick<SmartFill, "tx" | "trader" | "side">): string {
  return `${fill.tx.toLowerCase()}:${fill.trader.address.toLowerCase()}:${fill.side}`;
}

function fromPrint(chain: Chain, token: string, print: FlowPrint, dex: string): SmartFill | null {
  if (!print.trader) return null;
  return {
    chain,
    token,
    pair: print.pair,
    dex,
    tx: print.tx,
    time: print.time,
    side: print.side,
    usd: print.usd,
    trader: print.trader,
    ...(typeof print.price === "number" && Number.isFinite(print.price) ? { price: print.price } : {})
  };
}

/** SMART-ledger ring prints of the token's Tier A pairs plus its "smart:<token>" pseudo-pair, as wire fills; prints without a trader are skipped. */
export function ledgerSmartFills(ledger: SmartLedgerLike, chain: Chain, token: string, pairs: PairRow[], dexOf: (pair: string) => string): SmartFill[] {
  const keys = [...pairs.filter((pair) => pair.tier === "A").map((pair) => pair.pairAddress), smartPair(token)];
  const out: SmartFill[] = [];
  for (const pair of keys) {
    for (const print of ledger.recentPrints(chain, pair)) {
      const fill = fromPrint(chain, token, print, dexOf(pair));
      if (fill) out.push(fill);
    }
  }
  return out;
}

/** Earlier lists win on a tx+wallet+side collision (pass the book first: its rows carry symbol and handle). Newest first. */
export function mergeSmartFills(...lists: SmartFill[][]): SmartFill[] {
  const seen = new Set<string>();
  const out: SmartFill[] = [];
  for (const list of lists) {
    for (const fill of list) {
      const key = smartFillKey(fill);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(fill);
    }
  }
  return out.sort((a, b) => b.time - a.time);
}

/** Rolling totals over the merged fills ending at nowMs. Unpriced fills are counted, never priced; `aggressor` is null when nothing is priced. */
export function smartWindowsFromFills(fills: SmartFill[], nowMs: number): FlowWindow[] {
  return FLOW_WINDOW_LABELS.map((label) => {
    const fromMs = nowMs - WINDOW_MS[label];
    const inWindow = fills.filter((fill) => Number.isFinite(fill.time) && fill.time >= fromMs && fill.time <= nowMs);
    const priced = (side: SmartFill["side"]) => inWindow.filter((fill) => fill.side === side && typeof fill.usd === "number" && Number.isFinite(fill.usd));
    const buyUsd = priced("buy").reduce((sum, fill) => sum + (fill.usd as number), 0);
    const sellUsd = priced("sell").reduce((sum, fill) => sum + (fill.usd as number), 0);
    const buys = inWindow.filter((fill) => fill.side === "buy").length;
    const sells = inWindow.length - buys;
    const gross = buyUsd + sellUsd;
    return {
      label,
      buyUsd,
      sellUsd,
      net: buyUsd - sellUsd,
      buys,
      sells,
      unpriced: inWindow.length - priced("buy").length - priced("sell").length,
      aggressor: gross === 0 ? null : buyUsd / gross
    };
  });
}
