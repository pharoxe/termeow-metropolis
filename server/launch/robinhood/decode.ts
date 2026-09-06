import type { FlowPrint } from "../../../shared/wire.js";
import type { EvmLog } from "../../tape/robinhood/decode.js";
import { hexToNumber } from "../../tape/robinhood/rpc.js";
import {
  ADDRESSES,
  BAGS_TOPICS,
  FLAP_TOPICS,
  PONS_TOPICS,
  POOLS_TRADE_TOPICS,
  QUOTES,
  TRENCH_TOPICS,
  padOfAddress,
  type DynamicEmitters,
  type LaunchpadId
} from "./pads.js";

/**
 * Pure decoders for Robinhood Chain launchpad logs. Layouts were derived from real logs and receipts
 * (server/launch/__fixtures__/index.json "layouts"); anything outside them returns null rather than a guess.
 * Amounts stay raw base units; `quoteWei` is set only when the quote is ETH-denominated (native ETH or WETH).
 */
export type RawLog = EvmLog;

type EventBase = { chain: "robinhood"; launchpad: LaunchpadId; tx: string; block: number; logIndex: number };

export type LaunchCreatedEvent = EventBase & {
  kind: "launch";
  token: string;
  creator: string | null;
  /** Per-token curve / AMM contract when the pad has one; null for pools.trade (already a v4 pool) and Flap. */
  curve: string | null;
  pool: string | null;
  /** Quote asset when the launch event exposes it (Pons pairToken, Trench stock/USDG); null otherwise. */
  quote: string | null;
  name: string | null;
  symbol: string | null;
  uri: string | null;
};

export type LaunchTradeEvent = EventBase & {
  kind: "trade";
  token: string;
  /** Emitter address for Pons/Bags; pseudo id "<pad>:<token>" for router-emitted pads (Flap, Trench). */
  curve: string;
  side: "buy" | "sell";
  /** Wallet when the log exposes it; null for Bags, whose log only carries the router. */
  trader: string | null;
  tokenAmount: bigint | null;
  /** Raw quote base units in whatever `quote` is (6-dec USDG, 18-dec ETH/WETH/stock tokens). */
  quoteAmount: bigint | null;
  quote: string | null;
  /** quoteAmount when `quote` is native ETH or WETH; null otherwise (never re-denominated). */
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
const ETH_LIKE_QUOTES = new Set<string>([QUOTES.nativeEth, QUOTES.weth]);
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
 * ABI string whose head word sits at `headWord`; the offset is relative to word `base` (0 for top-level
 * fields, the tuple start for tuple members). Empty strings and anything out of range decode to null.
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
    chain: "robinhood",
    launchpad,
    tx: log.transactionHash,
    block: hexToNumber(log.blockNumber),
    logIndex: hexToNumber(log.logIndex)
  };
}

function quoteFor(ctx: DecodeContext, key: string, fallback: string | null): string | null {
  const known = ctx.curveTokens.get(key)?.quote;
  return known === undefined ? fallback : known;
}

function quoteWeiOf(quote: string | null, amount: bigint | null): bigint | null {
  return quote !== null && ETH_LIKE_QUOTES.has(quote) ? amount : null;
}

type TradeLeg = {
  token: string;
  curve: string;
  side: "buy" | "sell";
  trader: string | null;
  tokenAmount: bigint | null;
  quoteAmount: bigint | null;
  quote: string | null;
};

function trade(log: RawLog, launchpad: LaunchpadId, leg: TradeLeg): LaunchTradeEvent {
  return { ...baseOf(log, launchpad), kind: "trade", ...leg, quoteWei: quoteWeiOf(leg.quote, leg.quoteAmount) };
}

/** TokenLaunched(token, curve, deployer; pairToken, launchConfigId, graduationThreshold). */
function ponsLaunch(log: RawLog, words: string[]): LaunchEvent | null {
  const token = topicAddress(log, 1);
  const curve = topicAddress(log, 2);
  if (!token || !curve) return null;
  return {
    ...baseOf(log, "pons"),
    kind: "launch",
    token,
    creator: topicAddress(log, 3),
    curve,
    pool: null,
    quote: wordAddress(words[0]),
    name: null,
    symbol: null,
    uri: null
  };
}

/** LaunchSwept / PoolGraduated: topic1 token. The v4 pool id is not in either event. */
function ponsGraduation(log: RawLog): LaunchEvent | null {
  const token = topicAddress(log, 1);
  if (!token) return null;
  return { ...baseOf(log, "pons"), kind: "graduation", token, curve: null, pool: null };
}

function ponsFactory(log: RawLog, topic0: string): LaunchEvent | null {
  const words = dataWords(log.data);
  if (!words) return null;
  if (topic0 === PONS_TOPICS.TokenLaunched) return ponsLaunch(log, words);
  if (topic0 === PONS_TOPICS.LaunchSwept || topic0 === PONS_TOPICS.PoolGraduated) return ponsGraduation(log);
  return null;
}

/** CurveBuy(buyer, recipient; quoteIn, tokensOut, fee, tax) / CurveSell(seller, recipient; tokensIn, quoteOut, fee, tax). */
function ponsCurveTrade(log: RawLog, curve: string, token: string, topic0: string, ctx: DecodeContext): LaunchEvent | null {
  const words = dataWords(log.data);
  if (!words || words.length < 2) return null;
  const quote = quoteFor(ctx, curve, null);
  if (topic0 === PONS_TOPICS.CurveBuy) {
    const leg = { token, curve, side: "buy" as const, trader: topicAddress(log, 2), quote };
    return trade(log, "pons", { ...leg, quoteAmount: wordUint(words[0]), tokenAmount: wordUint(words[1]) });
  }
  if (topic0 === PONS_TOPICS.CurveSell) {
    const leg = { token, curve, side: "sell" as const, trader: topicAddress(log, 1), quote };
    return trade(log, "pons", { ...leg, tokenAmount: wordUint(words[0]), quoteAmount: wordUint(words[1]) });
  }
  return null;
}

/** Factory TokenCreated: only the indexed token. Metadata overload: token + (description, link, image, socials) tuple. */
function poolsTrade(log: RawLog, topic0: string): LaunchEvent | null {
  const words = dataWords(log.data);
  if (!words) return null;
  const common = { ...baseOf(log, "pools-trade"), kind: "launch" as const, creator: null, curve: null, pool: null };
  const empty = { quote: null, name: null, symbol: null };
  if (topic0 === POOLS_TRADE_TOPICS.TokenCreated) {
    const token = topicAddress(log, 1);
    return token ? { ...common, token, ...empty, uri: null } : null;
  }
  if (topic0 !== POOLS_TRADE_TOPICS.MetadataTokenCreated || words.length < 6) return null;
  const token = wordAddress(words[0]);
  const tupleOffset = wordUint(words[1]);
  if (!token || tupleOffset === null || tupleOffset % BigInt(WORD_BYTES) !== 0n) return null;
  const tupleStart = Number(tupleOffset / BigInt(WORD_BYTES));
  // Tuple fields: 0 description, 1 link, 2 image URI, 3 socials JSON — offsets are relative to the tuple start.
  const uri = abiString(words, tupleStart + 2, tupleStart);
  return { ...common, token, ...empty, uri };
}

/** TokenCreated(ts, creator, tokenIndex, token, name, symbol, metadataCid) — no topics. */
function flapLaunch(log: RawLog, words: string[]): LaunchEvent | null {
  const token = wordAddress(words[3]);
  if (!token || words.length < 7) return null;
  const cid = abiString(words, 6);
  return {
    ...baseOf(log, "flap"),
    kind: "launch",
    token,
    creator: wordAddress(words[1]),
    curve: null,
    pool: null,
    quote: null,
    name: abiString(words, 4),
    symbol: abiString(words, 5),
    uri: cid
  };
}

/** TokenBought / TokenSold(ts, token, wallet, tokenAmount, quoteAmount, fee, postPrice) — no topics. Quote is an ERC20 (WETH or HOODon), not in the log. */
function flapTrade(log: RawLog, words: string[], side: "buy" | "sell", ctx: DecodeContext): LaunchEvent | null {
  const token = wordAddress(words[1]);
  if (!token || words.length < 5) return null;
  const curve = `flap:${token}`;
  const leg = { token, curve, side, trader: wordAddress(words[2]), quote: quoteFor(ctx, curve, null) };
  return trade(log, "flap", { ...leg, tokenAmount: wordUint(words[3]), quoteAmount: wordUint(words[4]) });
}

function flapRouter(log: RawLog, topic0: string, ctx: DecodeContext): LaunchEvent | null {
  const words = dataWords(log.data);
  if (!words) return null;
  if (topic0 === FLAP_TOPICS.TokenCreated) return flapLaunch(log, words);
  if (topic0 === FLAP_TOPICS.TokenBought) return flapTrade(log, words, "buy", ctx);
  if (topic0 === FLAP_TOPICS.TokenSold) return flapTrade(log, words, "sell", ctx);
  return null;
}

/** TokenCreate(creator, curve, token; quote, name, symbol, timestamp, tokenURI). Quote is a tokenized stock or USDG. */
function trenchLaunch(log: RawLog, words: string[]): LaunchEvent | null {
  const token = topicAddress(log, 3);
  if (!token || words.length < 5) return null;
  return {
    ...baseOf(log, "trench"),
    kind: "launch",
    token,
    creator: topicAddress(log, 1),
    curve: topicAddress(log, 2),
    pool: null,
    quote: wordAddress(words[0]),
    name: abiString(words, 1),
    symbol: abiString(words, 2),
    uri: abiString(words, 4)
  };
}

/** TokenPurchase / TokenSale(token, wallet; tokenAmount, quoteAmount, fee, ...). Emitted by the proxy, hence the pseudo curve id. */
function trenchTrade(log: RawLog, words: string[], side: "buy" | "sell", ctx: DecodeContext): LaunchEvent | null {
  const token = topicAddress(log, 1);
  if (!token || words.length < 2) return null;
  const curve = `trench:${token}`;
  const leg = { token, curve, side, trader: topicAddress(log, 2), quote: quoteFor(ctx, curve, null) };
  return trade(log, "trench", { ...leg, tokenAmount: wordUint(words[0]), quoteAmount: wordUint(words[1]) });
}

function trenchProxy(log: RawLog, topic0: string, ctx: DecodeContext): LaunchEvent | null {
  const words = dataWords(log.data);
  if (!words) return null;
  if (topic0 === TRENCH_TOPICS.TokenCreate) return trenchLaunch(log, words);
  if (topic0 === TRENCH_TOPICS.TokenPurchase) return trenchTrade(log, words, "buy", ctx);
  if (topic0 === TRENCH_TOPICS.TokenSale) return trenchTrade(log, words, "sell", ctx);
  return null;
}

/** TokenCreated(token, amm, creator; feeVault, 0, id, name, symbol, metadataURI). */
function bagsFactory(log: RawLog, topic0: string): LaunchEvent | null {
  if (topic0 !== BAGS_TOPICS.TokenCreated) return null;
  const words = dataWords(log.data);
  const token = topicAddress(log, 1);
  const curve = topicAddress(log, 2);
  if (!words || words.length < 6 || !token || !curve) return null;
  return {
    ...baseOf(log, "bags"),
    kind: "launch",
    token,
    creator: topicAddress(log, 3),
    curve,
    pool: null,
    quote: QUOTES.nativeEth,
    name: abiString(words, 3),
    symbol: abiString(words, 4),
    uri: abiString(words, 5)
  };
}

/** The AMM log's topic1 is msg.sender: the router in every sample (wallet lives in the receipt's Transfer), else a wallet. */
function bagsTrader(log: RawLog): string | null {
  const sender = topicAddress(log, 1);
  return sender === ADDRESSES.bagsRouter ? null : sender;
}

/** TokensBought(ethIn, ethAfterFee, tokensOut, ...) / TokensSold(tokensIn, ethOutGross, ethOutNet, ...); quote is native ETH (tx value). */
function bagsAmmTrade(log: RawLog, curve: string, token: string, topic0: string, ctx: DecodeContext): LaunchEvent | null {
  const words = dataWords(log.data);
  if (!words || words.length < 3) return null;
  const quote = quoteFor(ctx, curve, QUOTES.nativeEth);
  const trader = bagsTrader(log);
  if (topic0 === BAGS_TOPICS.TokensBought) {
    const leg = { token, curve, side: "buy" as const, trader, quote };
    return trade(log, "bags", { ...leg, quoteAmount: wordUint(words[0]), tokenAmount: wordUint(words[2]) });
  }
  if (topic0 === BAGS_TOPICS.TokensSold) {
    const leg = { token, curve, side: "sell" as const, trader, quote };
    return trade(log, "bags", { ...leg, tokenAmount: wordUint(words[0]), quoteAmount: wordUint(words[1]) });
  }
  return null;
}

function decodeStatic(pad: LaunchpadId, log: RawLog, topic0: string, ctx: DecodeContext): LaunchEvent | null {
  switch (pad) {
    case "pons":
      return ponsFactory(log, topic0);
    case "pools-trade":
      return poolsTrade(log, topic0);
    case "flap":
      return flapRouter(log, topic0, ctx);
    case "trench":
      return trenchProxy(log, topic0, ctx);
    case "bags":
      return bagsFactory(log, topic0);
  }
}

function decodeDynamic(address: string, log: RawLog, topic0: string, ctx: DecodeContext): LaunchEvent | null {
  const emitter = ctx.curveTokens.get(address);
  if (!emitter) return null;
  if (emitter.launchpad === "pons") return ponsCurveTrade(log, address, emitter.token, topic0, ctx);
  if (emitter.launchpad === "bags") return bagsAmmTrade(log, address, emitter.token, topic0, ctx);
  return null;
}

/**
 * Decodes one log into a launch / trade / graduation event, or null when the emitter or topic is not one of
 * the verified layouts. Static pads dispatch by address; Pons curves and Bags AMMs by the runtime emitter set.
 * Never throws: malformed hex yields null.
 */
export function decodeLaunchLog(log: RawLog, ctx: DecodeContext): LaunchEvent | null {
  const topic0 = log.topics[0];
  if (typeof topic0 !== "string" || typeof log.address !== "string") return null;
  const address = log.address.toLowerCase();
  const pad = padOfAddress(address);
  try {
    return pad ? decodeStatic(pad, log, topic0.toLowerCase(), ctx) : decodeDynamic(address, log, topic0.toLowerCase(), ctx);
  } catch {
    return null;
  }
}

const WEI_PER_ETH = 1e18;

/** Ledger print for a curve trade: pair = event.curve (emitter for Pons/Bags, "<pad>:<token>" for Flap/Trench). */
export function toFlowPrint(event: LaunchTradeEvent, timeMs: number, ethUsd: number | null): FlowPrint {
  const priceable = ethUsd !== null && Number.isFinite(ethUsd) && ethUsd > 0 && event.quoteWei !== null;
  const usd = priceable ? (Number(event.quoteWei) / WEI_PER_ETH) * ethUsd : null;
  return {
    chain: "robinhood",
    pair: event.curve,
    tx: event.tx,
    time: timeMs,
    side: event.side,
    usd: usd !== null && Number.isFinite(usd) ? usd : null,
    source: "own"
  };
}
