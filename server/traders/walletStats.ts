import type { Chain, FlowPrint, TraderKind } from "../../shared/wire.js";
import { wilsonLower } from "./wilson.js";

/**
 * "smart" only after the smart-money label check proved the wallet; "other" means checked and not SMART;
 * null means never checked.
 */
export type { TraderKind } from "../../shared/wire.js";

/** A flow print attributed to a wallet. `trader` is normalised by the caller (lowercase 0x on Monad). */
export type TraderFill = Omit<FlowPrint, "trader"> & {
  trader: string;
  token: string;
  handle?: string | null;
  followers?: number | null;
  kind?: TraderKind | null;
  /** How usd was tied to a transfer-decoded fill (R4): the wallet's own quote leg or the custody hub's; absent when usd came with the print or is null. */
  usdVia?: "wallet_leg" | "hub_leg";
};

/** Per (chain, wallet, token) totals. Priced counts gate round trips so unpriced fills never fake a loss. */
export type Position = {
  buys: number;
  sells: number;
  pricedBuys: number;
  pricedSells: number;
  buyUsd: number;
  sellUsd: number;
};

export type TraderIdentity = { handle: string | null; followers: number | null; kind: TraderKind | null };

/** Mutable per-wallet accumulator; `positions` is insertion-ordered and bounded by the book. */
export type WalletState = {
  chain: Chain;
  wallet: string;
  fills: number;
  buys: number;
  sells: number;
  buyUsd: number;
  sellUsd: number;
  positions: Map<string, Position>;
  firstSeenAt: number;
  lastSeenAt: number;
  identity: TraderIdentity;
};

/** Realized round trips: a token with priced buys and priced sells is one closed trade; win = sellUsd > buyUsd. */
export type RoundTrips = { closed: number; wins: number };

export type TraderRow = {
  chain: Chain;
  wallet: string;
  handle: string | null;
  followers: number | null;
  kind: TraderKind | null;
  fills: number;
  buyUsd: number;
  sellUsd: number;
  netUsd: number;
  /** Fills with usd null: counted in `fills`, absent from buyUsd/sellUsd/netUsd (never folded as $0 knowingly). */
  unpriced: number;
  /** Realized-partial: counts tokens with both sides filled, ignoring any remaining position. */
  closed: number;
  wins: number;
  /** Wilson lower bound of wins/closed; null under WILSON_MIN_N closed trades. */
  wilsonLow: number | null;
  lastSeenAt: number;
};

export type TraderStats = TraderRow & { buys: number; sells: number; tokens: number; firstSeenAt: number };

export function emptyPosition(): Position {
  return { buys: 0, sells: 0, pricedBuys: 0, pricedSells: 0, buyUsd: 0, sellUsd: 0 };
}

export function pricedUsd(fill: Pick<FlowPrint, "usd">): number | null {
  return fill.usd !== null && Number.isFinite(fill.usd) ? fill.usd : null;
}

/** Returns a new position with the fill folded in. Counts every fill; sums only priced ones. */
export function foldPosition(position: Position, fill: TraderFill): Position {
  const usd = pricedUsd(fill);
  const priced = usd === null ? 0 : 1;
  if (fill.side === "buy") {
    return {
      ...position,
      buys: position.buys + 1,
      pricedBuys: position.pricedBuys + priced,
      buyUsd: position.buyUsd + (usd ?? 0)
    };
  }
  return {
    ...position,
    sells: position.sells + 1,
    pricedSells: position.pricedSells + priced,
    sellUsd: position.sellUsd + (usd ?? 0)
  };
}

export function isClosed(position: Position): boolean {
  return position.pricedBuys > 0 && position.pricedSells > 0;
}

export function isWin(position: Position): boolean {
  return position.sellUsd > position.buyUsd;
}

export function roundTrips(positions: Iterable<Position>): RoundTrips {
  let closed = 0;
  let wins = 0;
  for (const position of positions) {
    if (!isClosed(position)) continue;
    closed += 1;
    if (isWin(position)) wins += 1;
  }
  return { closed, wins };
}

/** Latest non-null value wins; a null never erases something already known. */
export function mergeIdentity(prev: TraderIdentity, fill: TraderFill): TraderIdentity {
  return {
    handle: fill.handle ?? prev.handle,
    followers: Number.isFinite(fill.followers) ? (fill.followers as number) : prev.followers,
    kind: fill.kind ?? prev.kind
  };
}

export function emptyWallet(fill: TraderFill): WalletState {
  return {
    chain: fill.chain,
    wallet: fill.trader,
    fills: 0,
    buys: 0,
    sells: 0,
    buyUsd: 0,
    sellUsd: 0,
    positions: new Map(),
    firstSeenAt: fill.time,
    lastSeenAt: fill.time,
    identity: { handle: null, followers: null, kind: null }
  };
}

/** Folds one fill into the wallet in place. A new token beyond `maxTokens` evicts the oldest-inserted position. */
export function foldWallet(state: WalletState, fill: TraderFill, maxTokens: number): void {
  const usd = pricedUsd(fill) ?? 0;
  state.fills += 1;
  if (fill.side === "buy") {
    state.buys += 1;
    state.buyUsd += usd;
  } else {
    state.sells += 1;
    state.sellUsd += usd;
  }
  const existing = state.positions.get(fill.token);
  if (!existing) evictOldestPositions(state.positions, maxTokens - 1);
  state.positions.set(fill.token, foldPosition(existing ?? emptyPosition(), fill));
  state.firstSeenAt = Math.min(state.firstSeenAt, fill.time);
  state.lastSeenAt = Math.max(state.lastSeenAt, fill.time);
  state.identity = mergeIdentity(state.identity, fill);
}

function evictOldestPositions(positions: Map<string, Position>, keep: number): void {
  while (positions.size > Math.max(0, keep)) {
    const oldest = positions.keys().next().value;
    if (oldest === undefined) break;
    positions.delete(oldest);
  }
}

export function toRow(state: WalletState): TraderRow {
  const { closed, wins } = roundTrips(state.positions.values());
  return {
    chain: state.chain,
    wallet: state.wallet,
    handle: state.identity.handle,
    followers: state.identity.followers,
    kind: state.identity.kind,
    fills: state.fills,
    buyUsd: state.buyUsd,
    sellUsd: state.sellUsd,
    netUsd: state.buyUsd - state.sellUsd,
    unpriced: unpricedFills(state.positions.values()),
    closed,
    wins,
    wilsonLow: wilsonLower(wins, closed),
    lastSeenAt: state.lastSeenAt
  };
}

function unpricedFills(positions: Iterable<Position>): number {
  let unpriced = 0;
  for (const position of positions) unpriced += position.buys + position.sells - position.pricedBuys - position.pricedSells;
  return unpriced;
}

export function toStats(state: WalletState): TraderStats {
  return {
    ...toRow(state),
    buys: state.buys,
    sells: state.sells,
    tokens: state.positions.size,
    firstSeenAt: state.firstSeenAt
  };
}
