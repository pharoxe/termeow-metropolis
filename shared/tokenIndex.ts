import type { Chain } from "./wire.js";

export type TokenIndexSource = "seeded" | "launch-index" | "market";

export interface IndexedToken {
  chain: Chain;
  address: string;
  symbol: string;
  name?: string;
  imageUrl?: string;
  aliases: string[];
  source: TokenIndexSource;
  priority: number;
  observedAt: number;
  /** High-confidence symbol/address mapping supplied by a curated list or trusted upstream tag. */
  verified?: boolean;
  verificationSource?: string;
}

export interface TokenResolution {
  query: string;
  indexed: boolean;
  match: IndexedToken | null;
  matches: IndexedToken[];
  ambiguous: boolean;
}
