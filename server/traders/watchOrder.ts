/**
 * Which wallets get a transfer-leg slot when the population outgrows the legs (server/traders/transfers.ts caps the
 * watched set). Pure ordering; the service supplies the facts. Nothing is dropped here: the caller counts what falls
 * past the cap as overflow.
 */

export type WatchRank = {
  /** Seeded (robinhoodtrenches list) or carrying a known handle: watched before anonymous wallets. */
  priority(wallet: string): boolean;
  /** Time of the wallet's last fill in the book, null when it never filled here. */
  lastFillAt(wallet: string): number | null;
  /** 0 for the most recently verified wallet, rising with age; null when the classifier never verified it. */
  verifiedRank(wallet: string): number | null;
};

type Keyed = { wallet: string; priority: number; lastFill: number; verified: number; index: number };

function key(wallet: string, index: number, rank: WatchRank): Keyed {
  return {
    wallet,
    priority: rank.priority(wallet) ? 0 : 1,
    lastFill: rank.lastFillAt(wallet) ?? Number.NEGATIVE_INFINITY,
    verified: rank.verifiedRank(wallet) ?? Number.POSITIVE_INFINITY,
    index
  };
}

function compare(a: Keyed, b: Keyed): number {
  return a.priority - b.priority || b.lastFill - a.lastFill || a.verified - b.verified || a.index - b.index;
}

/**
 * Lowercased, deduped wallets in watch order: priority wallets first, then by last fill (newest first), then by
 * verification recency, ties keeping input order. Returns a new array; the input is not touched.
 */
export function orderWatchList(wallets: Iterable<string>, rank: WatchRank): string[] {
  const unique = [...new Set([...wallets].map((wallet) => wallet.toLowerCase()))];
  return unique
    .map((wallet, index) => key(wallet, index, rank))
    .sort(compare)
    .map((entry) => entry.wallet);
}
