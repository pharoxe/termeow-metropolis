import type { Side } from "../../shared/wire.js";

/** The slice of a trader-book tape row the fold reads (TraderTapeRow satisfies it). */
export type HolderFill = { token: string; trader: string; side: Side; time: number };

/**
 * Distinct wallets with at least one buy fill per token at or after `since`. The input is the book's SMART-kind tape, so
 * a count here means "verified-SMART wallets this server saw buying", not an on-chain holder count: no balance is read and
 * a wallet that later sold still counts as a buyer. Tokens are keyed lowercase.
 */
export function smartBuyersByToken(fills: readonly HolderFill[], since: number): Map<string, number> {
  const buyers = new Map<string, Set<string>>();
  for (const fill of fills) {
    if (fill.side !== "buy" || !(fill.time >= since)) continue;
    const token = fill.token.toLowerCase();
    const set = buyers.get(token) ?? new Set<string>();
    set.add(fill.trader.toLowerCase());
    buyers.set(token, set);
  }
  return new Map([...buyers.entries()].map(([token, set]) => [token, set.size]));
}
