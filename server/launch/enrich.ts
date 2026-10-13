import type { Chain, LaunchRow } from "../../shared/wire.js";
import type { TokenProfile } from "../sources/dexscreenerProfiles.js";
import type { TokenBatchRow } from "../sources/dexscreenerTokens.js";
import { UNKNOWN_LAUNCHPAD, type LaunchUpsert } from "./index.js";

export const DEXSCREENER_TOKENS_SOURCE = "dexscreener tokens/v1";
/** Symbol read from the token contract itself (erc20Meta symbol() eth_call); the contract carries no launch name field the desk reads. */
export const ERC20_META_SOURCE = "erc20 symbol() via rpc";
/** Launchpad recorded for a token first seen on a DexScreener profile/boost feed: the feed does not say where it launched. */
export const DISCOVERY_LAUNCHPAD = "dexscreener-profile";

/** Pure builders turning one source row into a LaunchUpsert. Nulls stay null; sources carry the population label. */

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

/**
 * R6: symbol from the ERC-20 contract for a Monad row no source has named (DexScreener profile rows carry none;
 * nad.fun CurveCreate names its own tokens). Only `symbol` is written: erc20Meta reads symbol()/decimals(), not name(), so `name` stays null.
 * Null when the lookup is unresolved or the contract has no readable symbol, so the caller upserts nothing.
 */
export function erc20MetaUpsert(token: string, entry: { symbol: string | null } | null): LaunchUpsert | null {
  if (!entry || entry.symbol === null) return null;
  return { chain: "monad", token, symbol: entry.symbol, sources: [ERC20_META_SOURCE] };
}
