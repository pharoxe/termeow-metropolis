import type { PairRow } from "../../../shared/wire.js";
import { MONAD_MAINNET, NATIVE_MON as SHARED_NATIVE_MON } from "../../../shared/chains.js";
import { errorMessage } from "../../lib/http.js";
import { decodeAddress, decodeUint, ethCall, isAddress, isPoolId, isRevert } from "./rpc.js";

/** Uniswap v4 singleton on Monad (developers.uniswap.org v4 deployments): every v4 Swap log is emitted here, topics[1] = poolId. */
export const POOL_MANAGER = MONAD_MAINNET.uniswap.v4PoolManager ?? "";
/** Native MON as a v4 currency (and DexScreener quoteToken.address): no contract, so decimals() cannot be called. */
export const NATIVE_MON = SHARED_NATIVE_MON;
export const NATIVE_DECIMALS = 18;
export const DECIMALS_CACHE_MAX = 1_000;

export const SELECTORS = { token0: "0x0dfe1681", token1: "0xd21220a7", fee: "0xddca3f43", decimals: "0x313ce567" } as const;

export type EvmPoolKind = "v2" | "v3" | "v4";

/** Everything the log decoder needs about one Tier A pool; all addresses lowercase except ledgerPair. */
export type EvmPoolRef = {
  kind: EvmPoolKind;
  /** Lowercase pool id: 40-hex pair contract (v2/v3) or 64-hex poolId (v4). Match logs against this. */
  pair: string;
  /** row.pairAddress exactly as the registry stores it: the FlowPrint.pair so Gecko prints for the same tx dedupe. */
  ledgerPair: string;
  /** Contract that emits the Swap log: the pool itself for v2/v3, POOL_MANAGER for v4. */
  logAddress: string;
  dex: string;
  token: string;
  quote: string;
  tokenIsCurrency0: boolean;
  tokenDecimals: number;
  quoteDecimals: number;
  /** v3 fee() in hundredths of a bip; null for v2 (no fee()) and v4 (fee is per-swap in the log). */
  fee: number | null;
};

export type PoolResolveDeps = { rpcUrl: string; fetchImpl?: typeof fetch };
export type PoolResolveStatus = { lastError: string | null; decimalsCached: number };

/** token address (lowercase) -> decimals; insertion order is age order for the bound. */
const decimalsCache = new Map<string, number>();
let lastError: string | null = null;

function rememberDecimals(address: string, decimals: number): void {
  decimalsCache.set(address, decimals);
  while (decimalsCache.size > DECIMALS_CACHE_MAX) {
    const oldest = decimalsCache.keys().next().value;
    if (oldest === undefined) break;
    decimalsCache.delete(oldest);
  }
}

async function tokenDecimals(address: string, deps: PoolResolveDeps): Promise<number> {
  if (address === NATIVE_MON) return NATIVE_DECIMALS;
  const cached = decimalsCache.get(address);
  if (cached !== undefined) return cached;
  const decimals = decodeUint(await ethCall(deps.rpcUrl, address, SELECTORS.decimals, deps.fetchImpl));
  rememberDecimals(address, decimals);
  return decimals;
}

async function poolFee(pool: string, deps: PoolResolveDeps): Promise<number | null> {
  try {
    const raw = await ethCall(deps.rpcUrl, pool, SELECTORS.fee, deps.fetchImpl);
    return raw === "0x" ? null : decodeUint(raw);
  } catch (error) {
    if (isRevert(error)) return null;
    throw error;
  }
}

type Sides = { token: string; quote: string; dex: string; ledgerPair: string };

async function resolveContractPool(pair: string, sides: Sides, deps: PoolResolveDeps): Promise<EvmPoolRef> {
  const [token0, token1] = await Promise.all([
    ethCall(deps.rpcUrl, pair, SELECTORS.token0, deps.fetchImpl).then(decodeAddress),
    ethCall(deps.rpcUrl, pair, SELECTORS.token1, deps.fetchImpl).then(decodeAddress)
  ]);
  const tokenIsCurrency0 = token0 === sides.token;
  const matches = tokenIsCurrency0 ? token1 === sides.quote : token1 === sides.token && token0 === sides.quote;
  if (!matches) throw new Error(`pool tokens ${token0}/${token1} do not match ${sides.token}/${sides.quote}`);
  const [fee, tokenDecimalsValue, quoteDecimals] = await Promise.all([
    poolFee(pair, deps),
    tokenDecimals(sides.token, deps),
    tokenDecimals(sides.quote, deps)
  ]);
  return {
    kind: fee === null ? "v2" : "v3",
    pair,
    ledgerPair: sides.ledgerPair,
    logAddress: pair,
    dex: sides.dex,
    token: sides.token,
    quote: sides.quote,
    tokenIsCurrency0,
    tokenDecimals: tokenDecimalsValue,
    quoteDecimals,
    fee
  };
}

/** v4: currency0 < currency1 by address, native MON (address 0) always first; the poolId itself is opaque. */
async function resolveV4Pool(poolId: string, sides: Sides, deps: PoolResolveDeps): Promise<EvmPoolRef> {
  const [tokenDecimalsValue, quoteDecimals] = await Promise.all([tokenDecimals(sides.token, deps), tokenDecimals(sides.quote, deps)]);
  return {
    kind: "v4",
    pair: poolId,
    ledgerPair: sides.ledgerPair,
    logAddress: POOL_MANAGER,
    dex: sides.dex,
    token: sides.token,
    quote: sides.quote,
    tokenIsCurrency0: sides.token < sides.quote,
    tokenDecimals: tokenDecimalsValue,
    quoteDecimals,
    fee: null
  };
}

async function resolve(row: PairRow, deps: PoolResolveDeps): Promise<EvmPoolRef> {
  if (!row.quoteMint) throw new Error("quote mint missing");
  const token = row.baseMint.trim().toLowerCase();
  const quote = row.quoteMint.trim().toLowerCase();
  if (!isAddress(token) || !isAddress(quote)) throw new Error(`bad token addresses ${row.baseMint}/${row.quoteMint}`);
  if (token === quote) throw new Error("token and quote are the same address");
  const pair = row.pairAddress.trim().toLowerCase();
  const sides: Sides = { token, quote, dex: row.dex, ledgerPair: row.pairAddress };
  if (isAddress(pair)) return resolveContractPool(pair, sides, deps);
  if (isPoolId(pair)) return resolveV4Pool(pair, sides, deps);
  throw new Error(`unrecognized pair id ${row.pairAddress}`);
}

/**
 * Classify a registry row as a v2/v3 pair contract (token0/token1, fee() present only on v3) or a v4 poolId,
 * and fetch the decimals the decoder needs. Null on any failure; poolResolveStatus().lastError says why.
 */
export async function resolvePoolRef(row: PairRow, deps: PoolResolveDeps): Promise<EvmPoolRef | null> {
  try {
    const ref = await resolve(row, deps);
    lastError = null;
    return ref;
  } catch (error) {
    lastError = `${row.pairAddress}: ${errorMessage(error)}`;
    return null;
  }
}

export function poolResolveStatus(): PoolResolveStatus {
  return { lastError, decimalsCached: decimalsCache.size };
}

/** Testing only: drop the decimals cache and the last error. */
export function resetPoolCaches(): void {
  decimalsCache.clear();
  lastError = null;
}
