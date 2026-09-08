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
  identities:number;
  /** Only the chains the registry actually holds rows for: identity comes off Solana boards, so `robinhood` is absent
   *  rather than 0 — the count was never observed, and a zero here would claim it was. `bySource` is seeded and total. */
  byChain:Partial<Record<Chain,number>>;bySource:Record<IdentitySource,number>;
  /** Two clocks, deliberately apart: `capturedAt` is when the board itself was sampled upstream, `observedAt` when this
   *  server read it. On 2026-09-08 the fomoscan 24h board was captured 2026-09-03 19:42Z and read 15:27Z the same day. */
  boards:Array<{board:BoardKind;window:string;capturedAt:number;count:number;walletsRanked:number|null;
    coverage:number|null;observedAt:number}>;
  /** Wallets this server has seen trade, and how many of them the registry can name. */
  observedWallets:Record<Chain,{seen:number;named:number}>|null;
  budget:{period:string;spent:number;budget:number;allowance:number;accountRemaining:number|null;checkedAt:number|null}|null;
  refusedForBudget:number;
  lastError:string|null;
};

/**
 * The state of the FomoScan key itself, not this feature's slice of it. `/v2/me` costs 0 CU and reports usage from
 * calls made outside this process, so it is the only honest input to the meter; `consumers` is every meter sharing
 * the one grant. The three account fields are null until the first poll lands — unread, never zero.
 */
export type IdentityAccountStatus={
  connected:boolean;grant:number;period:string;
  accountUsed:number|null;accountRemaining:number|null;checkedAt:number|null;
  consumers:Array<{label:string;units:number;calls:number}>;error:string|null;
};

export type IdentityCoverageResponse=IdentityCoverage&{account:IdentityAccountStatus};

/**
 * A ranked row with whatever name the registry already holds for that wallet. The join is a local SQLite read costing
 * 0 CU against rows the boards themselves deposited, so a board row and its name arrive together; `identity` is null
 * when no board we have read named that wallet, which is not a claim that the wallet has no owner.
 */
export type RankedTrader=TraderRanking&{identity:TraderIdentity|null};

/** A stored snapshot truncated to `limit`, never a fresh sweep: refreshing a board costs 250 CU and is on a timer. */
export type IdentityBoardResponse={board:BoardKind;window:string;entries:RankedTrader[]};
