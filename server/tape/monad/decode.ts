import type { FlowPrint } from "../../../shared/wire.js";
import { perTokenPrice } from "../../flow/printPrice.js";
import { POOL_MANAGER } from "./pools.js";

/**
 * Uniswap Swap event decoders for Monad (chain id 143).
 * Sign conventions were verified against GeckoTerminal trades on 2026-09-06 (see __fixtures__/index.json):
 *  - v2: token In > 0 => user sold; token Out > 0 => user bought.
 *  - v3: amounts are POOL deltas; token amount < 0 => the pool sent it => user bought.
 *  - v4: amounts are SWAPPER deltas (BalanceDelta); token amount > 0 => user received it => user bought.
 */
export const SWAP_TOPICS = {
  v2: "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  v3: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  v4: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
} as const;

export type SwapKind = keyof typeof SWAP_TOPICS;

/**
 * A Tier A pool to decode Swap logs for. `ledgerPair` must be the registry row's pairAddress string
 * verbatim (DexScreener checksum-case for v2/v3 pools, lowercase 64-hex poolId for v4) so that Gecko
 * fallback prints for the same tx dedupe in the ledger.
 */
export type EvmPoolRef = {
  pair: string;
  pairAddress: string;
  dex: string;
  ledgerPair: string;
  kind: SwapKind;
  token: string;
  quote: string;
  tokenIsCurrency0: boolean;
  tokenDecimals: number;
  quoteDecimals: number;
};

/** The subset of an eth_getLogs / receipt log entry the decoder reads. */
export type EvmLog = {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
  logIndex: string;
};

export type DecodeContext = {
  /** Block timestamp in ms (log.blockTimestamp is 0x0 on this chain; use eth_getBlockByNumber). */
  timeMs: number;
  /** USD price of one whole quote unit, or null when it cannot be priced honestly. */
  quoteUsd: (quote: string) => number | null;
};

type SwapLeg = { tokenAmount: bigint; quoteAmount: bigint; side: "buy" | "sell" };

const WORD_HEX = 64;
const WORDS_BY_KIND: Record<SwapKind, number> = { v2: 4, v3: 5, v4: 6 };
const KIND_BY_TOPIC = new Map<string, SwapKind>(
  (Object.entries(SWAP_TOPICS) as Array<[SwapKind, string]>).map(([kind, topic]) => [topic, kind])
);

function stripHex(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/** Two's complement decode of a `bits`-wide integer from a hex word. Works for int256 and sign-extended int128 alike. */
export function toSignedBigInt(hex: string, bits: number): bigint {
  const raw = stripHex(hex);
  if (raw === "" || !/^[0-9a-fA-F]+$/.test(raw)) throw new Error(`toSignedBigInt: not hex: ${hex}`);
  const unsigned = BigInt(`0x${raw}`);
  const width = BigInt(bits);
  const limit = 1n << width;
  const value = unsigned & (limit - 1n);
  return value >= 1n << (width - 1n) ? value - limit : value;
}

/** Stable dedupe key for a poller that may see the same log twice (overlapping block ranges, retries). */
export function logKey(log: Pick<EvmLog, "transactionHash" | "logIndex">): string {
  return `${log.transactionHash}:${log.logIndex}`;
}

/** Splits ABI-encoded event data into 32-byte words; null when it is not a whole number of words. */
function dataWords(data: string): string[] | null {
  const raw = stripHex(data);
  if (raw.length === 0 || raw.length % WORD_HEX !== 0 || !/^[0-9a-fA-F]+$/.test(raw)) return null;
  const words: string[] = [];
  for (let i = 0; i < raw.length; i += WORD_HEX) words.push(raw.slice(i, i + WORD_HEX));
  return words;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** v2 Swap(sender, amount0In, amount1In, amount0Out, amount1Out, to): unsigned in/out legs. */
function decodeV2(words: string[], tokenIsCurrency0: boolean): SwapLeg | null {
  const [in0, in1, out0, out1] = words.map((word) => BigInt(`0x${word}`));
  const tokenIn = tokenIsCurrency0 ? in0 : in1;
  const tokenOut = tokenIsCurrency0 ? out0 : out1;
  const quoteIn = tokenIsCurrency0 ? in1 : in0;
  const quoteOut = tokenIsCurrency0 ? out1 : out0;
  if (tokenIn > 0n) return { tokenAmount: tokenIn, quoteAmount: quoteOut, side: "sell" };
  if (tokenOut > 0n) return { tokenAmount: tokenOut, quoteAmount: quoteIn, side: "buy" };
  return null;
}

/** v3 Swap(sender, recipient, int256 amount0, int256 amount1, ...): pool perspective, negative = pool sent. */
function decodeV3(words: string[], tokenIsCurrency0: boolean): SwapLeg | null {
  const amount0 = toSignedBigInt(words[0], 256);
  const amount1 = toSignedBigInt(words[1], 256);
  const token = tokenIsCurrency0 ? amount0 : amount1;
  const quote = tokenIsCurrency0 ? amount1 : amount0;
  if (token === 0n) return null;
  return { tokenAmount: abs(token), quoteAmount: abs(quote), side: token < 0n ? "buy" : "sell" };
}

/** v4 Swap(id, sender, int128 amount0, int128 amount1, sqrtPriceX96, liquidity, tick, fee): swapper perspective, positive = user received. */
function decodeV4(words: string[], tokenIsCurrency0: boolean): SwapLeg | null {
  const amount0 = toSignedBigInt(words[0], 128);
  const amount1 = toSignedBigInt(words[1], 128);
  const token = tokenIsCurrency0 ? amount0 : amount1;
  const quote = tokenIsCurrency0 ? amount1 : amount0;
  if (token === 0n) return null;
  return { tokenAmount: abs(token), quoteAmount: abs(quote), side: token > 0n ? "buy" : "sell" };
}

function decodeLeg(kind: SwapKind, words: string[], tokenIsCurrency0: boolean): SwapLeg | null {
  if (kind === "v2") return decodeV2(words, tokenIsCurrency0);
  if (kind === "v3") return decodeV3(words, tokenIsCurrency0);
  return decodeV4(words, tokenIsCurrency0);
}

/** Pool map key for a log: the emitting contract for v2/v3, the poolId topic for v4 (emitted by the PoolManager). */
function poolKeyOf(log: EvmLog, kind: SwapKind): string | null {
  if (kind !== "v4") return log.address.toLowerCase();
  if (log.address.toLowerCase() !== POOL_MANAGER) return null;
  const poolId = log.topics[1];
  return typeof poolId === "string" && poolId.length === 2 + WORD_HEX ? poolId.toLowerCase() : null;
}

/** Whole quote units as a float; precision loss beyond 2^53 base units is irrelevant at USD granularity. */
function quoteUnits(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

function usdOf(leg: SwapLeg, pool: EvmPoolRef, ctx: DecodeContext): number | null {
  const price = ctx.quoteUsd(pool.quote);
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  const usd = quoteUnits(leg.quoteAmount, pool.quoteDecimals) * price;
  return Number.isFinite(usd) ? usd : null;
}

/** The raw legs of a known pool's Swap log (base units, side); null when it is not a tracked pool's swap. */
export function decodeSwapLeg(log: EvmLog, pools: Map<string, EvmPoolRef>): { pool: EvmPoolRef; leg: SwapLeg } | null {
  const topic0 = log.topics[0];
  const kind = typeof topic0 === "string" ? KIND_BY_TOPIC.get(topic0.toLowerCase()) : undefined;
  if (!kind) return null;
  const key = poolKeyOf(log, kind);
  const pool = key === null ? undefined : pools.get(key);
  if (!pool || pool.kind !== kind) return null;
  const words = dataWords(log.data);
  if (!words || words.length < WORDS_BY_KIND[kind]) return null;
  const leg = decodeLeg(kind, words, pool.tokenIsCurrency0);
  return leg ? { pool, leg } : null;
}

/**
 * Decodes one Swap log into a FlowPrint, or null when the log is not a known pool's swap.
 * One print per matching log: a multi-hop tx yields one print per pool it touched, and the
 * ledger's (chain, tx, pair) dedupe keeps them apart.
 */
export function decodeSwapLog(log: EvmLog, pools: Map<string, EvmPoolRef>, ctx: DecodeContext): FlowPrint | null {
  const decoded = decodeSwapLeg(log, pools);
  if (!decoded) return null;
  const { pool, leg } = decoded;
  const usd = usdOf(leg, pool, ctx);
  return {
    chain: "monad",
    pair: pool.ledgerPair,
    tx: log.transactionHash,
    time: ctx.timeMs,
    side: leg.side,
    usd,
    source: "own",
    eventId: logKey(log),
    quantity: Math.abs(quoteUnits(leg.tokenAmount, pool.tokenDecimals)),
    ...perTokenPrice(usd, quoteUnits(leg.tokenAmount, pool.tokenDecimals))
  };
}
