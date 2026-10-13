import type { FlowPrint } from "../../../shared/wire.js";
import type { EvmLog } from "../../tape/monad/decode.js";
import { hexToNumber } from "../../tape/monad/rpc.js";
import { NADFUN_TOPICS, QUOTES, padOfAddress, type DynamicEmitters, type LaunchpadId } from "./pads.js";

/**
 * Pure decoders for Monad launchpad logs (nad.fun BondingCurve). Layouts follow the published ABI
 * (github.com/Naddotfun/contract-v3-abi IBondingCurve.json); anything outside them returns null rather than a guess.
 * Amounts stay raw base units; `quoteWei` is the MON leg (nad.fun curves always quote native MON, 18 decimals).
 */
export type RawLog = EvmLog;

type EventBase = { chain: "monad"; launchpad: LaunchpadId; tx: string; block: number; logIndex: number };

export type LaunchCreatedEvent = EventBase & {
  kind: "launch";
  token: string;
  creator: string | null;
  /** Pseudo emitter "nadfun:<token>"; nad.fun has one shared curve contract, so there is no per-token curve address. */
  curve: string | null;
  /** DEX pool the token graduates into (CurveCreate topic3). */
  pool: string | null;
  quote: string | null;
  name: string | null;
  symbol: string | null;
  uri: string | null;
};

export type LaunchTradeEvent = EventBase & {
  kind: "trade";
  token: string;
  /** Pseudo id "nadfun:<token>": the ledger pair for the curve-phase tape. */
  curve: string;
  side: "buy" | "sell";
  /** CurveBuy/CurveSell topic1: the recipient the router traded for (the user's wallet). */
  trader: string | null;
  tokenAmount: bigint | null;
  /** Raw MON base units (18 decimals). */
  quoteAmount: bigint | null;
  quote: string | null;
  /** quoteAmount when `quote` is MON-denominated; null otherwise (never re-denominated). */
  quoteWei: bigint | null;
};

export type LaunchGraduationEvent = EventBase & {
  kind: "graduation";
  token: string | null;
  curve: string | null;
  pool: string | null;
};

export type LaunchEvent = LaunchCreatedEvent | LaunchTradeEvent | LaunchGraduationEvent;

export type DecodeContext = { curveTokens: DynamicEmitters };

const WORD_HEX = 64;
const WORD_BYTES = 32;
const ADDRESS_HEX = 40;
const MON_LIKE_QUOTES = new Set<string>([QUOTES.nativeMon, QUOTES.wmon]);
const utf8 = new TextDecoder("utf-8", { fatal: false });

function stripHex(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/** ABI data split into 32-byte words; null when the payload is not whole words of hex. */
function dataWords(data: string): string[] | null {
  const raw = stripHex(data);
  if (raw.length % WORD_HEX !== 0 || (raw.length > 0 && !/^[0-9a-fA-F]+$/.test(raw))) return null;
  const words: string[] = [];
  for (let i = 0; i < raw.length; i += WORD_HEX) words.push(raw.slice(i, i + WORD_HEX));
  return words;
}

function wordAddress(word: string | undefined): string | null {
  if (typeof word !== "string" || word.length !== WORD_HEX) return null;
  return `0x${word.slice(WORD_HEX - ADDRESS_HEX).toLowerCase()}`;
}

function wordUint(word: string | undefined): bigint | null {
  return typeof word === "string" && word.length === WORD_HEX ? BigInt(`0x${word}`) : null;
}

function topicAddress(log: RawLog, index: number): string | null {
  const topic = log.topics[index];
  return typeof topic === "string" ? wordAddress(stripHex(topic)) : null;
}

/**
 * ABI string whose head word sits at `headWord`; the offset is relative to word `base` (0 for top-level fields).
 * Empty strings and anything out of range decode to null.
 */
function abiString(words: string[], headWord: number, base = 0): string | null {
  const offset = wordUint(words[headWord]);
  if (offset === null || offset % BigInt(WORD_BYTES) !== 0n) return null;
  const lengthWord = base + Number(offset / BigInt(WORD_BYTES));
  const length = wordUint(words[lengthWord]);
  if (length === null || length === 0n || length > BigInt(WORD_BYTES * 64)) return null;
  const hex = words.slice(lengthWord + 1).join("").slice(0, Number(length) * 2);
  if (hex.length !== Number(length) * 2) return null;
  const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], (pair) => parseInt(pair, 16));
  const text = utf8.decode(bytes).replace(/\0+$/g, "");
  return text.length > 0 ? text : null;
}

function baseOf(log: RawLog, launchpad: LaunchpadId): EventBase {
  return {
    chain: "monad",
    launchpad,
    tx: log.transactionHash,
    block: hexToNumber(log.blockNumber),
    logIndex: hexToNumber(log.logIndex)
  };
}

/** Ledger/emitter key for a nad.fun token's curve phase. */
export function nadfunCurveKey(token: string): string {
  return `nadfun:${token.toLowerCase()}`;
}

/** CurveCreate: topics creator / token / pool; data name, symbol, tokenURI (dynamic), virtualMon, virtualToken, targetTokenAmount. */
function nadfunLaunch(log: RawLog, words: string[]): LaunchEvent | null {
  const token = topicAddress(log, 2);
  if (!token || words.length < 6) return null;
  return {
    ...baseOf(log, "nadfun"),
    kind: "launch",
    token,
    creator: topicAddress(log, 1),
    curve: nadfunCurveKey(token),
    pool: topicAddress(log, 3),
    quote: QUOTES.nativeMon,
    name: abiString(words, 0),
    symbol: abiString(words, 1),
    uri: abiString(words, 2)
  };
}

/** CurveBuy (MON in, tokens out) / CurveSell (tokens in, MON out): topics sender / token; data amountIn, amountOut. */
function nadfunTrade(log: RawLog, words: string[], side: "buy" | "sell", ctx: DecodeContext): LaunchEvent | null {
  const token = topicAddress(log, 2);
  if (!token || words.length < 2) return null;
  const amountIn = wordUint(words[0]);
  const amountOut = wordUint(words[1]);
  const curve = nadfunCurveKey(token);
  const known = ctx.curveTokens.get(curve)?.quote;
  const quote = known === undefined || known === null ? QUOTES.nativeMon : known;
  const quoteAmount = side === "buy" ? amountIn : amountOut;
  return {
    ...baseOf(log, "nadfun"),
    kind: "trade",
    token,
    curve,
    side,
    trader: topicAddress(log, 1),
    tokenAmount: side === "buy" ? amountOut : amountIn,
    quoteAmount,
    quote,
    quoteWei: MON_LIKE_QUOTES.has(quote) ? quoteAmount : null
  };
}

function nadfunGraduation(log: RawLog): LaunchEvent | null {
  const token = topicAddress(log, 1);
  if (!token) return null;
  return { ...baseOf(log, "nadfun"), kind: "graduation", token, curve: nadfunCurveKey(token), pool: topicAddress(log, 2) };
}

/** One launchpad log to an event, or null for anything this decoder does not understand (CurveSync, strangers). */
export function decodeLaunchLog(log: RawLog, ctx: DecodeContext): LaunchEvent | null {
  if (padOfAddress(log.address) !== "nadfun") return null;
  const topic0 = String(log.topics[0] || "").toLowerCase();
  const words = dataWords(log.data);
  if (words === null) return null;
  if (topic0 === NADFUN_TOPICS.CurveCreate) return nadfunLaunch(log, words);
  if (topic0 === NADFUN_TOPICS.CurveBuy) return nadfunTrade(log, words, "buy", ctx);
  if (topic0 === NADFUN_TOPICS.CurveSell) return nadfunTrade(log, words, "sell", ctx);
  if (topic0 === NADFUN_TOPICS.CurveGraduate) return nadfunGraduation(log);
  return null;
}

const WEI_PER_MON = 1e18;

/** Ledger print for a curve trade: pair = event.curve ("nadfun:<token>"). `monUsd` prices the MON leg. */
export function toFlowPrint(event: LaunchTradeEvent, timeMs: number, monUsd: number | null): FlowPrint {
  const priceable = monUsd !== null && Number.isFinite(monUsd) && monUsd > 0 && event.quoteWei !== null;
  const usd = priceable ? (Number(event.quoteWei) / WEI_PER_MON) * monUsd : null;
  return {
    chain: "monad",
    pair: event.curve,
    tx: event.tx,
    time: timeMs,
    side: event.side,
    usd: usd !== null && Number.isFinite(usd) ? usd : null,
    source: "own"
  };
}
