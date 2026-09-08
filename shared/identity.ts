import type {Chain} from './wire.js';

/** Which FomoScan read produced a record. Every one of these costs 250 CU, unlike address resolution at 50,000. */
export type IdentitySource='fomoscan-board'|'pump-board'|'pump-profile'|'fomo-profile';
export type BoardKind='fomoscan-traders'|'pump-traders';

/** A wallet with a name attached to it, and where that name came from. */
export type TraderIdentity={
  chain:Chain;wallet:string;handle:string|null;displayName:string|null;twitter:string|null;
  followers:number|null;userId:string|null;source:IdentitySource;observedAt:number;
};

/**
 * One row of a ranking snapshot.
 *
 * `pnlUsd` on the pump board is realized plus unrealized and is routinely dominated by the unrealized leg — the
 * top-ranked wallet in the 2026-09-08 fixture shows +$1,758,491 unrealized against -$1,124 realized. Keep the legs
 * apart: a combined figure presented as a result would claim a profit that has not been taken.
 */
export type TraderRanking={
  board:BoardKind;window:string;rank:number;chain:Chain;wallet:string;capturedAt:number;
  pnlUsd:number|null;realizedPnlUsd:number|null;unrealizedPnlUsd:number|null;returnPct:number|null;
  volumeUsd:number|null;trades:number|null;uniqueTokens:number|null;winRate:number|null;
  avgHoldSeconds:number|null;tokensCreated:number|null;walletFirstSeenAt:number|null;
};

/**
 * A board as it stood at one instant. `walletsRanked` and `coverage` are the population the ranking was drawn from:
 * a board is the top of a sweep, never the top of everyone trading.
 */
export type BoardSnapshot={
  board:BoardKind;window:string;capturedAt:number;count:number;
  walletsRanked:number|null;coverage:number|null;complete:boolean|null;
  identities:TraderIdentity[];rankings:TraderRanking[];
};

export type IdentityCoverage={
  identities:number;byChain:Record<Chain,number>;bySource:Record<IdentitySource,number>;
  boards:Array<{board:BoardKind;window:string;capturedAt:number;count:number;walletsRanked:number|null}>;
  /** Wallets this server has seen trade, and how many of them the registry can name. */
  observedWallets:Record<Chain,{seen:number;named:number}>|null;
  budget:{period:string;spent:number;budget:number;allowance:number;accountRemaining:number|null;checkedAt:number|null}|null;
  refusedForBudget:number;
  lastError:string|null;
};
