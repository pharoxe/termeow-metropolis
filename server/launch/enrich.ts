import type { Chain, LaunchRow } from "../../shared/wire.js";
import type { TokenProfile } from "../sources/dexscreenerProfiles.js";
import type { TokenBatchRow } from "../sources/dexscreenerTokens.js";
import { TRENCHES_SOURCE, type TrenchToken } from "../sources/trenches.js";
import { UNKNOWN_LAUNCHPAD, type LaunchUpsert } from "./index.js";
import type { SolanaLaunch } from "./solana/pumpportal.js";

export const PUMPPORTAL_SOURCE = "pumpportal";
export const DEXSCREENER_TOKENS_SOURCE = "dexscreener tokens/v1";
/** Symbol read from the token contract itself (erc20Meta symbol() eth_call); the contract carries no launch name field the desk reads. */
export const ERC20_META_SOURCE = "erc20 symbol() via rpc";
/** Launchpad recorded for a token first seen on a DexScreener profile/boost feed: the feed does not say where it launched. */
export const DISCOVERY_LAUNCHPAD = "dexscreener-profile";

/** Pure builders turning one source row into a LaunchUpsert. Nulls stay null; sources carry the population label. */

export function solanaLaunchUpsert(launch: SolanaLaunch): LaunchUpsert {
  return {
    chain: "solana",
    token: launch.token,
    launchpad: launch.launchpad,
    creator: launch.creator,
    curve: launch.curve,
    name: launch.name || null,
    symbol: launch.symbol || null,
    createdAt: launch.createdAt,
    tx: launch.tx,
    sources: [PUMPPORTAL_SOURCE]
  };
}

/**
 * A profile/boost row for a chain the desk models. Unknown tokens get the discovery launchpad and `createdAt`
 * defaults to the observation time (LaunchIndex fills it); known rows only gain the icon and the source label.
 */
export function profileUpsert(profile: TokenProfile, source: string, known: boolean): LaunchUpsert | null {
  if (profile.chain === null) return null;
  const base: LaunchUpsert = { chain: profile.chain, token: profile.address, image: profile.icon, sources: [source] };
  return known ? base : { ...base, launchpad: DISCOVERY_LAUNCHPAD };
}

/**
 * DexScreener best-pair figures for a known row; the pair becomes `pool` and `createdAt` is corrected only for discovery
 * rows. `pricedAt` (the fetch time) is stamped only when the pair actually carried a price.
 */
export function tokenBatchUpsert(chain: Chain, existing: LaunchRow, row: TokenBatchRow, pricedAt: number): LaunchUpsert {
  const discovered = existing.launchpad === DISCOVERY_LAUNCHPAD || existing.launchpad === UNKNOWN_LAUNCHPAD;
  const createdAt = discovered && row.pairCreatedAt !== null && row.pairCreatedAt < existing.createdAt ? row.pairCreatedAt : undefined;
  return {
    chain,
    token: existing.token,
    symbol: row.symbol || null,
    name: row.name || null,
    image: row.image,
    pool: row.pairAddress,
    priceUsd: row.priceUsd,
    marketCapUsd: row.marketCapUsd ?? row.fdvUsd,
    liquidityUsd: row.liquidityUsd,
    volume24Usd: row.volume24Usd,
    change24Pct: row.change24Pct,
    pricedAt: row.priceUsd === null ? null : pricedAt,
    ...(createdAt !== undefined ? { createdAt } : {}),
    sources: [DEXSCREENER_TOKENS_SOURCE]
  };
}

/** The wire `tracked` shape needs whole numbers; when the site omits any of them the field stays null rather than 0. */
export function trackedFrom(row: TrenchToken): LaunchRow["tracked"] {
  if (row.buyers === null || row.usdIn === null || row.usdOut === null) return null;
  const buyer = row.firstBuyer;
  const firstBuyer = buyer && buyer.handle !== null && buyer.at !== null ? { handle: buyer.handle, followers: buyer.followers, at: buyer.at } : null;
  return { buyers: row.buyers, usdIn: row.usdIn, usdOut: row.usdOut, firstBuyer, honeypot: row.honeypot };
}

/**
 * robinhoodtrenches row merged into a Robinhood launch. A token the index has never seen becomes a row with launchpad
 * "unknown" dated by its DexScreener pair creation (or first tracked buy); known rows keep their on-chain identity.
 */
export function trenchUpsert(row: TrenchToken, existing: LaunchRow | null, observedAt: number): LaunchUpsert {
  const base: LaunchUpsert = {
    chain: "robinhood",
    token: row.address,
    symbol: row.symbol || null,
    name: row.name || null,
    priceUsd: row.priceUsd,
    liquidityUsd: row.liquidityUsd,
    volume24Usd: row.volume24Usd,
    change24Pct: row.change24Pct,
    pricedAt: row.priceUsd === null ? null : observedAt,
    tracked: trackedFrom(row),
    isStock: row.isStock,
    sources: [TRENCHES_SOURCE]
  };
  if (existing) return base;
  return { ...base, launchpad: UNKNOWN_LAUNCHPAD, createdAt: row.pairCreatedAt ?? row.firstAt ?? observedAt };
}

/**
 * R6: symbol from the ERC-20 contract for a Robinhood row no source has named (Pons events and DexScreener profile
 * rows carry none). Only `symbol` is written: erc20Meta reads symbol()/decimals(), not name(), so `name` stays null.
 * Null when the lookup is unresolved or the contract has no readable symbol, so the caller upserts nothing.
 */
export function erc20MetaUpsert(token: string, entry: { symbol: string | null } | null): LaunchUpsert | null {
  if (!entry || entry.symbol === null) return null;
  return { chain: "robinhood", token, symbol: entry.symbol, sources: [ERC20_META_SOURCE] };
}
