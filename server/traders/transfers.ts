import type { Side } from "../../shared/wire.js";
import { QUOTES } from "../launch/monad/pads.js";
import type { ExtraLeg } from "../tape/monad/poller.js";
import { TRANSFER_TOPIC, USER_OPERATION_EVENT_TOPIC, ZERO_ADDRESS } from "./attribute.js";
import { ENTRY_POINT } from "./service.js";

const ENTRY_POINT_LOWER = ENTRY_POINT.toLowerCase();

/**
 * Wallets per eth_getLogs topic OR-list. Topic-list ceilings on Monad's public RPCs are not documented; the earlier EVM
 * deployment proved 1,000-address lists, so 200 keeps a wide margin while the legs stay inside the 100-block range cap.
 */
export const TRANSFER_CHUNK = 200;
/**
 * Chunks per direction the poller batch carries; wallets past chunk * maxChunks are counted as overflow, never silently
 * dropped, and the order in which they fill the slots is the caller's (TraderService.transferWallets: seeded/named,
 * then most recent fill, then most recently verified). 3 x 200 x 2 directions = 6 legs of ~14 kB each.
 */
export const TRANSFER_MAX_CHUNKS = 3;
/** Wallets the legs can carry at these sizes (600); the population past it is overflow. */
export const TRANSFER_WATCH_CAP = TRANSFER_CHUNK * TRANSFER_MAX_CHUNKS;
/** Pair id for a SMART fill whose pool is unknown (chain-wide Transfer decode): "smart:<token>". */
export const SMART_PAIR_PREFIX = "smart:";
/**
 * Custody hub legs: some social-trading apps settle through a custody hub instead of the user's wallet, so the hub's
 * stable legs are the only cash a log can tie to a fill. No such app is configured on Monad, so the hub is unset and
 * every fill is priced from the wallet's own quote Transfer (or left unpriced). Set these to enable a hub pattern.
 */
export const CUSTODY_HUB: string | null = null;
export const CUSTODY_FUNDING: string | null = null;
export const CUSTODY_SINK: string | null = null;

export type QuoteToken = { symbol: string; decimals: number };
/** Cash legs visible as ERC-20 Transfers on Monad: WMON (18), USDC (6), AUSD (6). Native MON leaves no Transfer. */
export const QUOTE_TOKENS: ReadonlyMap<string, QuoteToken> = new Map([
  [QUOTES.wmon, { symbol: "WMON", decimals: 18 }],
  [QUOTES.usdc, { symbol: "USDC", decimals: 6 }],
  ...(QUOTES.ausd ? [[QUOTES.ausd, { symbol: "AUSD", decimals: 6 }] as [string, QuoteToken]] : [])
]);

export type TransferLegs = { legs: ExtraLeg[]; wallets: number; overflow: number };

/** The log fields the decoder reads; poller RawLogs and receipt logs both satisfy it. Order of the array is node order. */
export type TransferLogLike = { address: string; topics: string[]; data: string; logIndex?: string; blockNumber?: string };

export type DecodeContext = {
  /** Lowercase wallets whose token legs count as fills. */
  population: ReadonlySet<string>;
  quotes?: ReadonlyMap<string, QuoteToken>;
  /** USD per quote unit, or null when unknown (usd then stays null). */
  quotePrice: (quote: string) => number | null;
  /** Token decimals when known (erc20Meta); null leaves units and price null. */
  decimalsOf: (token: string) => number | null;
};

/** How usd was tied to the fill: the wallet's own quote Transfer, or the custody hub legs in the same user-op segment. */
export type UsdVia = "wallet_leg" | "hub_leg";

export type TransferFill = {
  tx: string;
  wallet: string;
  token: string;
  side: Side;
  block: number | null;
  /** Whole tokens when decimals are known; null otherwise. */
  units: number | null;
  quote: string | null;
  usd: number | null;
  /** Null when no cash leg could be tied to the fill (usd stays null). */
  usdVia: UsdVia | null;
  price: number | null;
};

export type SkipCounts = {
  /** Token legs with no cash leg whose counterparty is another tracked wallet or the zero address: a transfer/mint/burn, not a fill. */
  transfers: number;
  /** Token legs naming a wallet inside another sender's user-op segment (someone sent it tokens). */
  foreignSegment: number;
  /** Fills left unpriced because the segment held several token legs or several cash legs on that side, or a hub leg could not be tied to one hub-custodied leg of one wallet. */
  unpaired: number;
};

export type DecodeResult = { fills: TransferFill[]; skipped: SkipCounts };

type Transfer = { token: string; from: string; to: string; amount: bigint };
type Segment = { sender: string | null; transfers: Transfer[] };
type Group = { token: string; side: Side; amount: bigint; counterparties: Set<string> };

const WORD = /^0x[0-9a-fA-F]{64}$/;

export function emptySkips(): SkipCounts {
  return { transfers: 0, foreignSegment: 0, unpaired: 0 };
}

export function smartPair(token: string): string {
  return `${SMART_PAIR_PREFIX}${token.toLowerCase()}`;
}

export function padTopic(address: string): string {
  return `0x${"0".repeat(24)}${address.toLowerCase().slice(2)}`;
}

/**
 * Two chain-wide legs per chunk of the population: Transfer to any wallet (topics[2]) and Transfer from any wallet
 * (topics[1]). No address filter: the poller sends them in its one JSON-RPC batch per tick alongside its own legs.
 */
export function buildTransferLegs(population: Iterable<string>, chunk = TRANSFER_CHUNK, maxChunks = TRANSFER_MAX_CHUNKS): TransferLegs {
  const wallets = [...new Set([...population].map((wallet) => wallet.toLowerCase()))];
  const kept = wallets.slice(0, chunk * maxChunks);
  const legs: ExtraLeg[] = [];
  for (let i = 0; i < kept.length; i += chunk) {
    const topics = kept.slice(i, i + chunk).map(padTopic);
    legs.push({ addresses: [], topics: [[TRANSFER_TOPIC], null, topics] });
    legs.push({ addresses: [], topics: [[TRANSFER_TOPIC], topics] });
  }
  return { legs, wallets: kept.length, overflow: wallets.length - kept.length };
}

/** ERC-20 Transfer only: 3 topics and one 32-byte data word (ERC-721 Transfer carries 4 topics and empty data). */
export function isTransferLog(log: { topics: string[]; data: string }): boolean {
  return log.topics.length === 3 && log.topics[0]?.toLowerCase() === TRANSFER_TOPIC && WORD.test(log.data);
}

function topicAddress(topic: unknown): string | null {
  return typeof topic === "string" && WORD.test(topic) ? `0x${topic.slice(-40).toLowerCase()}` : null;
}

function parseIndex(value: unknown, fallback: number): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return fallback;
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function toTransfer(log: TransferLogLike): Transfer | null {
  if (!isTransferLog(log)) return null;
  const from = topicAddress(log.topics[1]);
  const to = topicAddress(log.topics[2]);
  if (from === null || to === null) return null;
  return { token: log.address.toLowerCase(), from, to, amount: BigInt(log.data) };
}

/**
 * EntryPoint txs bundle several wallets' user-ops; a segment is the logs after the previous UserOperationEvent up to and
 * including the closing one, whose topics[2] is the sender (11/11 tracked segments named the token-leg wallet). Other
 * relay paths (relay B, Multicall3, direct EOA) form one segment with no sender constraint.
 */
function segment(logs: TransferLogLike[]): Segment[] {
  const segments: Segment[] = [];
  let current: Transfer[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() === ENTRY_POINT_LOWER && log.topics[0]?.toLowerCase() === USER_OPERATION_EVENT_TOPIC) {
      segments.push({ sender: topicAddress(log.topics[2]), transfers: current });
      current = [];
      continue;
    }
    const transfer = toTransfer(log);
    if (transfer) current.push(transfer);
  }
  if (current.length > 0 || segments.length === 0) segments.push({ sender: null, transfers: current });
  return segments;
}

function groupTokenLegs(transfers: Transfer[], wallet: string, quotes: ReadonlyMap<string, QuoteToken>): Group[] {
  const groups = new Map<string, Group>();
  for (const transfer of transfers) {
    if (quotes.has(transfer.token) || transfer.from === transfer.to) continue;
    const side: Side | null = transfer.to === wallet ? "buy" : transfer.from === wallet ? "sell" : null;
    if (side === null) continue;
    const key = `${transfer.token}:${side}`;
    const counterparty = side === "buy" ? transfer.from : transfer.to;
    const group = groups.get(key);
    if (group) {
      group.amount += transfer.amount;
      group.counterparties.add(counterparty);
    } else {
      groups.set(key, { token: transfer.token, side, amount: transfer.amount, counterparties: new Set([counterparty]) });
    }
  }
  return [...groups.values()];
}

/** The wallet's own quote Transfers on the cash side of `side` (buy pays quote out, sell receives it). */
function walletCashLegs(transfers: Transfer[], wallet: string, side: Side, quotes: ReadonlyMap<string, QuoteToken>): Transfer[] {
  return transfers.filter((transfer) => quotes.has(transfer.token) && (side === "buy" ? transfer.from === wallet : transfer.to === wallet));
}

/** Custody hub legs (stable quotes only): FUNDING -> HUB is a buy's cost, HUB -> SINK a sell's proceeds. */
function hubCashLegs(transfers: Transfer[], side: Side): Transfer[] {
  return transfers.filter(
    (transfer) => CUSTODY_HUB !== null && QUOTE_TOKENS.has(transfer.token) && (side === "buy" ? transfer.from === CUSTODY_FUNDING && transfer.to === CUSTODY_HUB : transfer.from === CUSTODY_HUB && transfer.to === CUSTODY_SINK)
  );
}

function units(raw: bigint, decimals: number | null): number | null {
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 77) return null;
  const value = Number(raw) / 10 ** decimals;
  return Number.isFinite(value) ? value : null;
}

type CashPick = { leg: Transfer; via: UsdVia } | { leg: null; via: null; ambiguous: boolean };

/** The custody pattern: the token leg pairs the wallet with HUB and nothing else (buy: hub -> wallet, sell: wallet -> hub). */
function hubCustodied(group: Group): boolean {
  return CUSTODY_HUB !== null && group.counterparties.size === 1 && group.counterparties.has(CUSTODY_HUB);
}

/**
 * Exactly one token leg on this side and exactly one cash leg pairs them; anything else stays unpriced. The wallet's own
 * quote Transfer comes first. The hub stable legs stand in only for a hub-custodied token leg when the segment holds one
 * tracked wallet: a wallet trading straight against a pool or a segment shared by several wallets cannot claim the hub's cash.
 */
function pickCash(segmentTransfers: Transfer[], wallet: string, group: Group, sideGroups: number, segmentWallets: number, quotes: ReadonlyMap<string, QuoteToken>): CashPick {
  const own = walletCashLegs(segmentTransfers, wallet, group.side, quotes);
  if (own.length > 0) return sideGroups === 1 && own.length === 1 ? { leg: own[0], via: "wallet_leg" } : { leg: null, via: null, ambiguous: true };
  const hub = hubCashLegs(segmentTransfers, group.side);
  if (hub.length === 0) return { leg: null, via: null, ambiguous: false };
  if (sideGroups !== 1 || hub.length !== 1 || segmentWallets !== 1 || !hubCustodied(group)) return { leg: null, via: null, ambiguous: true };
  return { leg: hub[0], via: "hub_leg" };
}

function toFill(tx: string, block: number | null, wallet: string, group: Group, pick: CashPick, ctx: DecodeContext, quotes: ReadonlyMap<string, QuoteToken>): TransferFill {
  const quote = pick.leg ? pick.leg.token : null;
  const quoteUnits = pick.leg ? units(pick.leg.amount, quotes.get(pick.leg.token)?.decimals ?? null) : null;
  const quoteUsd = quote ? ctx.quotePrice(quote) : null;
  const usd = quoteUnits !== null && quoteUsd !== null && Number.isFinite(quoteUnits * quoteUsd) ? quoteUnits * quoteUsd : null;
  const tokenUnits = units(group.amount, ctx.decimalsOf(group.token));
  const price = usd !== null && tokenUnits !== null && tokenUnits > 0 ? usd / tokenUnits : null;
  return { tx, wallet, token: group.token, side: group.side, block, units: tokenUnits, quote, usd, usdVia: pick.via, price };
}

/**
 * Fills of tracked wallets in one tx's logs (poller batch or full receipt). Per user-op segment and wallet: token leg =
 * Transfer of a non-quote token to (buy) or from (sell) the wallet, legs of one token and side merged; cash leg = the
 * wallet's own quote Transfer the other way, else the hub stable leg of a hub-custodied leg (when a hub is configured); usd = quote units x quote usd;
 * units/price need decimals. A token leg with no cash leg whose counterparties are all tracked wallets or the zero
 * address is a transfer, not a fill, and is counted. Pure; never throws on malformed logs (they are skipped).
 */
export function decodeTxTransfers(tx: string, logs: TransferLogLike[], ctx: DecodeContext): DecodeResult {
  const quotes = ctx.quotes ?? QUOTE_TOKENS;
  const block = parseIndexOrNull(logs.find((log) => typeof log.blockNumber === "string")?.blockNumber);
  const fills: TransferFill[] = [];
  const skipped = emptySkips();
  for (const seg of segment(logs)) {
    const wallets = new Set<string>();
    for (const transfer of seg.transfers) {
      if (ctx.population.has(transfer.from)) wallets.add(transfer.from);
      if (ctx.population.has(transfer.to)) wallets.add(transfer.to);
    }
    for (const wallet of wallets) {
      const groups = groupTokenLegs(seg.transfers, wallet, quotes);
      if (seg.sender !== null && seg.sender !== wallet) {
        skipped.foreignSegment += groups.length;
        continue;
      }
      for (const group of groups) {
        const sideGroups = groups.filter((other) => other.side === group.side).length;
        const pick = pickCash(seg.transfers, wallet, group, sideGroups, wallets.size, quotes);
        if (pick.leg === null) {
          if (pick.ambiguous) skipped.unpaired += 1;
          else if ([...group.counterparties].every((party) => party === ZERO_ADDRESS || ctx.population.has(party))) {
            skipped.transfers += 1;
            continue;
          }
        }
        fills.push(toFill(tx.toLowerCase(), block, wallet, group, pick, ctx, quotes));
      }
    }
  }
  return { fills, skipped };
}

function parseIndexOrNull(value: unknown): number | null {
  const parsed = parseIndex(value, -1);
  return parsed >= 0 ? parsed : null;
}

/** Poller/batch logs grouped by lowercase transactionHash, each group in logIndex order. */
export function groupLogsByTx<T extends TransferLogLike & { transactionHash: string }>(logs: T[]): Map<string, T[]> {
  const byTx = new Map<string, T[]>();
  for (const log of logs) {
    const tx = log.transactionHash.toLowerCase();
    const list = byTx.get(tx);
    if (list) list.push(log);
    else byTx.set(tx, [log]);
  }
  for (const group of byTx.values()) group.sort((a, b) => parseIndex(a.logIndex, 0) - parseIndex(b.logIndex, 0));
  return byTx;
}

/** Poller batch entry point: groups logs by transactionHash and decodes each tx; skip counts are summed. */
export function decodeTransferFills(logs: Array<TransferLogLike & { transactionHash: string }>, ctx: DecodeContext): DecodeResult {
  const fills: TransferFill[] = [];
  const skipped = emptySkips();
  for (const [tx, group] of groupLogsByTx(logs)) {
    const result = decodeTxTransfers(tx, group, ctx);
    fills.push(...result.fills);
    skipped.transfers += result.skipped.transfers;
    skipped.foreignSegment += result.skipped.foreignSegment;
    skipped.unpaired += result.skipped.unpaired;
  }
  return { fills, skipped };
}

/** Dedupe key across the batch view and the receipt view of the same fill. */
export function transferFillKey(chain: string, fill: Pick<TransferFill, "tx" | "wallet" | "token" | "side">): string {
  return `${chain}|${fill.tx}|${fill.wallet}|${fill.token}|${fill.side}`;
}
