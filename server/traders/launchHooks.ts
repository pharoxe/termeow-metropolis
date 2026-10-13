import type { FlowPrint } from "../../shared/wire.js";
import { NADFUN_TOPICS } from "../launch/monad/pads.js";
import { launchPairId, type StreamLedgerLike, type StreamPollerLike } from "../launch/monad/stream.js";
import type { ExtraLeg, LogsHandler, RawLog } from "../tape/monad/poller.js";
import { USER_OPERATION_EVENT_TOPIC } from "./attribute.js";
import { LruMap } from "./lru.js";
import { ENTRY_POINT, TraderService, dexFromPair, type AnnotateContext, type MetaOf, type RecordOptions } from "./service.js";
import { TransferFeed } from "./transferFeed.js";

/** The one extra leg the launch poller carries for trader discovery: every UserOperationEvent at the EntryPoint. */
export const USER_OP_LEG: ExtraLeg = { addresses: [ENTRY_POINT], topics: [[USER_OPERATION_EVENT_TOPIC]] };
/** Curve-trade traders remembered between the poller batch and the stream's later ledger.ingest of the same prints. */
export const CURVE_TRADER_RING = 2_048;
const CURVE_TOKEN_CACHE = 2_048;
const WORD_HEX = 64;

export type CurveTrader = { key: string; trader: string | null; token: string | null };

/** The slice of TraderService the hooks drive; tests inject a fake. */
export type TraderHooksLike = {
  annotate(prints: FlowPrint[], ctx: AnnotateContext): Promise<FlowPrint[]>;
  record(prints: FlowPrint[], meta: MetaOf, opts?: RecordOptions): unknown;
  discover(senders: string[]): Promise<unknown>;
};

export type TraderHooksOptions = {
  poller: StreamPollerLike;
  ledger: StreamLedgerLike;
  traders: TraderHooksLike;
  /** Token behind a launchpad pseudo-pair the log itself did not name; null when unknown. */
  tokenOf: (pair: string) => string | null;
  /** R4 chain-wide Transfer feed wrapping the poller; undefined = the TraderService's own feed (created on first use, none for a fake), null = off. */
  transfers?: TransferFeedLike | null;
  log?: (msg: string) => void;
};

export type TransferFeedLike = { wrapPoller(poller: StreamPollerLike): StreamPollerLike };

/** The live service gets one TransferFeed for the process; a test fake (not a TraderService) gets none. */
function liveTransferFeed(traders: TraderHooksLike, log: (msg: string) => void): TransferFeedLike | null {
  if (!(traders instanceof TraderService)) return null;
  return traders.transfers ?? traders.attachTransfers(new TransferFeed({ traders, log }));
}

function topicAddress(log: RawLog, index: number): string | null {
  const topic = log.topics[index];
  return typeof topic === "string" && topic.length === 2 + WORD_HEX ? `0x${topic.slice(-40).toLowerCase()}` : null;
}

function dataWord(log: RawLog, index: number): string | null {
  const raw = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
  const word = raw.slice(index * WORD_HEX, (index + 1) * WORD_HEX);
  return word.length === WORD_HEX ? word : null;
}

function wordAddress(word: string | null): string | null {
  return word === null || !/^[0-9a-fA-F]{64}$/.test(word) ? null : `0x${word.slice(-40).toLowerCase()}`;
}

/** Print key the stream will emit for this trade: tx + launchPairId. */
export function curveTradeKey(print: Pick<FlowPrint, "tx" | "pair">): string {
  return `${print.tx.toLowerCase()}:${print.pair.toLowerCase()}`;
}

/**
 * The wallet a launchpad trade log names, keyed like the print the stream emits for it. Layout follows
 * server/launch/monad/decode.ts: nad.fun CurveBuy / CurveSell carry the wallet in topic1 and the token in topic2.
 */
export function curveTrader(log: RawLog): CurveTrader | null {
  const topic0 = log.topics[0]?.toLowerCase();
  if (topic0 === NADFUN_TOPICS.CurveBuy || topic0 === NADFUN_TOPICS.CurveSell) {
    const token = topicAddress(log, 2);
    const pair = token ? launchPairId("nadfun", token, null) : null;
    return token && pair ? { key: `${log.transactionHash.toLowerCase()}:${pair}`, trader: topicAddress(log, 1), token } : null;
  }
  return null;
}

export function isUserOpLog(log: RawLog): boolean {
  return log.address.toLowerCase() === ENTRY_POINT && log.topics[0]?.toLowerCase() === USER_OPERATION_EVENT_TOPIC;
}

/** Distinct UserOperationEvent senders (topics[2]) in a batch. */
export function userOpSenders(logs: RawLog[]): string[] {
  const out = new Set<string>();
  for (const log of logs) {
    if (!isUserOpLog(log)) continue;
    const sender = topicAddress(log, 2);
    if (sender) out.add(sender);
  }
  return [...out];
}

/**
 * Wraps the launch stream's poller and ledger so R3 rides on the existing loop: the poller gains the EntryPoint
 * user-op leg (senders -> traders.discover, the logs themselves never reach the stream), remembers the wallet each
 * curve-trade log names, and the ledger classifies that wallet (no receipt) before ingesting. Batches are ingested in
 * order through one promise chain; a batch past the annotate deadline is ingested unannotated. Never throws.
 */
export function withTraderHooks(input: TraderHooksOptions): { poller: StreamPollerLike; ledger: StreamLedgerLike } {
  const log = input.log ?? ((msg) => console.warn(msg));
  const feed = input.transfers === undefined ? liveTransferFeed(input.traders, log) : input.transfers;
  const opts = feed ? { ...input, poller: feed.wrapPoller(input.poller) } : input;
  const traders = new LruMap<string, CurveTrader>(CURVE_TRADER_RING);
  const tokens = new LruMap<string, string>(CURVE_TOKEN_CACHE);
  const tokenOf = (pair: string): string | null => {
    const hit = tokens.get(pair);
    if (hit) return hit;
    const found = opts.tokenOf(pair);
    if (found) tokens.set(pair, found);
    return found;
  };
  const meta: MetaOf = (print) => {
    const known = traders.get(curveTradeKey(print));
    const token = known?.token ?? tokenOf(print.pair);
    if (!token) return null;
    return { token, dex: dexFromPair(print.pair), trader: known ? known.trader : null };
  };
  let queue: Promise<unknown> = Promise.resolve();
  const process = async (prints: FlowPrint[]): Promise<void> => {
    let annotated = prints;
    try {
      annotated = await opts.traders.annotate(prints, { meta });
    } catch (error) {
      log(`trader hooks: annotate: ${(error as Error)?.message ?? String(error)}`);
    }
    opts.ledger.ingest(annotated);
    try {
      opts.traders.record(annotated, meta);
    } catch (error) {
      log(`trader hooks: record: ${(error as Error)?.message ?? String(error)}`);
    }
  };
  const poller: StreamPollerLike = {
    setExtraLegs: (legs) => opts.poller.setExtraLegs([...legs, USER_OP_LEG]),
    start: (onLogs: LogsHandler) =>
      opts.poller.start((logs, head) => {
        const rest: RawLog[] = [];
        for (const entry of logs) {
          if (isUserOpLog(entry)) continue;
          const found = curveTrader(entry);
          if (found) traders.set(found.key, found);
          rest.push(entry);
        }
        const senders = userOpSenders(logs);
        if (senders.length) void opts.traders.discover(senders).catch((error) => log(`trader hooks: discover: ${(error as Error)?.message ?? String(error)}`));
        if (rest.length) onLogs(rest, head);
      }),
    stop: () => opts.poller.stop(),
    stats: () => opts.poller.stats()
  };
  const ledger: StreamLedgerLike = {
    ingest: (prints) => {
      queue = queue.then(() => process(prints)).catch((error) => log(`trader hooks: ingest: ${(error as Error)?.message ?? String(error)}`));
      return queue;
    }
  };
  return { poller, ledger };
}
