import type { TraderKind } from "../../shared/wire.js";
import { config } from "../config.js";
import type { StreamPollerLike } from "../launch/robinhood/stream.js";
import { errorMessage } from "../lib/http.js";
import { BlockTimeCache, type BlockTimeStats } from "../tape/robinhood/blocks.js";
import type { ExtraLeg, LogsHandler, RawLog } from "../tape/robinhood/poller.js";
import { EvmQuotePrice, type EvmQuotePriceStatus } from "../tape/robinhood/price.js";
import type { TraderFill } from "./book.js";
import type { Erc20MetaEntry } from "./erc20Meta.js";
import type { HandleEntry } from "./handles.js";
import { LruMap } from "./lru.js";
import {
  buildTransferLegs,
  decodeTxTransfers,
  fomoPair,
  groupLogsByTx,
  isTransferLog,
  transferFillKey,
  type DecodeContext,
  type SkipCounts,
  type TransferFill,
  type TransferLegs,
  type TransferLogLike
} from "./transfers.js";

/** How often the feed re-reads the population (legs rebuild when its version moved). */
export const LEGS_CHECK_MS = 5_000;
/** Batches waiting behind a stalled receipt/block lookup (RPC 429 backoff) past which new batches are dropped and counted. */
export const MAX_QUEUED_BATCHES = 50;
export const SEEN_FILLS = 5_000;
const CHAIN = "robinhood" as const;

export type TransferReceiptLike = { logs: TransferLogLike[] };
export type TransferPricesLike = { prime(quotes: string[]): Promise<void>; get(quote: string): number | null; status(): EvmQuotePriceStatus };
export type TransferBlocksLike = { timeMs(blockNumber: number): Promise<number | null>; stats(): BlockTimeStats };

/** The slice of TraderService the feed drives; tests inject a fake. */
export type TransferFeedTraders = {
  /** Lowercase wallets to watch: classified FOMO plus seeded (robinhoodtrenches) minus those proven "other". */
  transferWallets(): string[];
  /** Bumps whenever transferWallets() would change. */
  populationVersion(): number;
  peekKind(wallet: string): TraderKind | null;
  receipts: { get(tx: string): Promise<TransferReceiptLike | null> };
  /** `refresh` is called once at start so the traders list (and its seeds) load before the first fill arrives. */
  handles: { get(address: string): HandleEntry | null; refresh?(): Promise<void> };
  erc20Meta: { get(token: string): Erc20MetaEntry | null; resolve(token: string): Promise<Erc20MetaEntry | null> };
  recordTransferFills(fills: TraderFill[]): { accepted: number; duplicates: number; rejected: number };
};

export type TransferFeedOptions = {
  traders: TransferFeedTraders;
  rpcUrl?: string;
  blocks?: TransferBlocksLike;
  prices?: TransferPricesLike;
  now?: () => number;
  log?: (msg: string) => void;
  checkMs?: number;
};

export type TransferFeedCounters = {
  batches: number;
  batchesDropped: number;
  logsSeen: number;
  /** Fills recorded in the book (first sighting). */
  fills: number;
  /** Fills already known (feed ring or book, incl. R3 receipt attribution of the same tx+wallet+token). */
  duplicates: number;
  /** Recorded fills with usd null: no cash leg tied to the wallet's segment, or the quote had no price. */
  unpriced: number;
  /** Fills dropped because the block time could not be read (never estimated). */
  untimed: number;
  transfersSkipped: number;
  foreignSegment: number;
  unpaired: number;
  /** Txs decoded from the batch view only because the receipt was unavailable (usd null). */
  receiptsMissing: number;
};

export type TransferFeedStats = TransferFeedCounters & {
  legs: number;
  wallets: number;
  overflow: number;
  populationVersion: number;
  queued: number;
  lastOkAt: number | null;
  lastError: string | null;
  blocks: BlockTimeStats;
  price: EvmQuotePriceStatus;
};

function emptyCounters(): TransferFeedCounters {
  return { batches: 0, batchesDropped: 0, logsSeen: 0, fills: 0, duplicates: 0, unpriced: 0, untimed: 0, transfersSkipped: 0, foreignSegment: 0, unpaired: 0, receiptsMissing: 0 };
}

function parseBlock(value: unknown): number | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function hasSkips(skipped: SkipCounts): boolean {
  return skipped.transfers + skipped.foreignSegment + skipped.unpaired > 0;
}

/**
 * Chain-wide FOMO fills: wraps the launch poller so its one batch per tick also carries the population's Transfer legs
 * (server/traders/transfers.ts), strips the Transfer logs before the stream sees them and decodes them per tx against
 * the full receipt (the batch only holds the logs naming a wallet; the cash legs never do). Every fill goes through
 * TraderService.recordTransferFills as pair "fomo:<token>". Batches are processed in order on one promise chain; a
 * batch that fails lands in lastError and the next one runs. Never throws into the poller.
 */
export class TransferFeed {
  private readonly traders: TransferFeedTraders;
  private readonly blocks: TransferBlocksLike;
  private readonly prices: TransferPricesLike;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly checkMs: number;
  private readonly seen = new LruMap<string, true>(SEEN_FILLS);
  private inner: StreamPollerLike | null = null;
  private baseLegs: ExtraLeg[] = [];
  private built: TransferLegs = { legs: [], wallets: 0, overflow: 0 };
  private appliedVersion = -1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private counters = emptyCounters();
  private lastOkAt: number | null = null;
  private lastError: string | null = null;

  constructor(opts: TransferFeedOptions) {
    const rpcUrl = opts.rpcUrl ?? config.robinhood.rpcUrl;
    this.traders = opts.traders;
    this.blocks = opts.blocks ?? new BlockTimeCache({ rpcUrl });
    this.prices = opts.prices ?? new EvmQuotePrice({ chain: CHAIN });
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((msg) => console.warn(msg));
    this.checkMs = opts.checkMs ?? LEGS_CHECK_MS;
  }

  /** The poller the launch stream should use: same API, transfer legs appended, Transfer logs diverted here. */
  wrapPoller(poller: StreamPollerLike): StreamPollerLike {
    this.inner = poller;
    return {
      setExtraLegs: (legs) => {
        this.baseLegs = legs;
        this.applyLegs(true);
      },
      start: (onLogs: LogsHandler) => {
        void this.traders.handles.refresh?.();
        this.startTimer();
        poller.start((logs, head) => this.split(logs, head, onLogs));
      },
      stop: () => {
        this.stopTimer();
        poller.stop();
      },
      stats: () => poller.stats()
    };
  }

  /** Queues one batch of Transfer logs; the returned promise settles when the batch is processed (tests await it). */
  handleLogs(logs: RawLog[], headBlock: number): Promise<void> {
    if (this.queued >= MAX_QUEUED_BATCHES) {
      this.counters.batchesDropped += 1;
      return Promise.resolve();
    }
    this.queued += 1;
    this.queue = this.queue
      .then(() => this.process(logs, headBlock))
      .catch((error) => this.fail(`batch: ${errorMessage(error)}`))
      .finally(() => {
        this.queued -= 1;
      });
    return this.queue;
  }

  stats(): TransferFeedStats {
    return {
      ...this.counters,
      legs: this.built.legs.length,
      wallets: this.built.wallets,
      overflow: this.built.overflow,
      populationVersion: this.appliedVersion,
      queued: this.queued,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      blocks: this.blocks.stats(),
      price: this.prices.status()
    };
  }

  /** Rebuilds the legs when the population moved and pushes them (with the stream's own legs) to the real poller. */
  applyLegs(force: boolean): void {
    const version = this.traders.populationVersion();
    if (!force && version === this.appliedVersion) return;
    if (version !== this.appliedVersion) {
      this.built = buildTransferLegs(this.traders.transferWallets());
      this.appliedVersion = version;
    }
    this.inner?.setExtraLegs([...this.baseLegs, ...this.built.legs]);
  }

  private split(logs: RawLog[], head: number, onLogs: LogsHandler): void {
    const mine = logs.filter(isTransferLog);
    if (mine.length > 0) void this.handleLogs(mine, head);
    const rest = logs.filter((log) => !isTransferLog(log));
    if (rest.length > 0) onLogs(rest, head);
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.checkMs);
    this.timer.unref?.();
    this.tick();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    try {
      this.applyLegs(false);
    } catch (error) {
      this.fail(`legs: ${errorMessage(error)}`);
    }
  }

  private context(population: ReadonlySet<string>): DecodeContext {
    return {
      population,
      quotePrice: (quote) => this.prices.get(quote),
      decimalsOf: (token) => this.traders.erc20Meta.get(token)?.decimals ?? null
    };
  }

  private async process(logs: RawLog[], _head: number): Promise<void> {
    this.counters.batches += 1;
    this.counters.logsSeen += logs.length;
    const population = new Set(this.traders.transferWallets());
    const ctx = this.context(population);
    const rows: TraderFill[] = [];
    for (const [tx, txLogs] of groupLogsByTx(logs)) {
      const partial = decodeTxTransfers(tx, txLogs, ctx);
      if (partial.fills.length === 0 && !hasSkips(partial.skipped)) continue;
      const fresh = partial.fills.filter((fill) => !this.seen.has(transferFillKey(CHAIN, fill)));
      if (partial.fills.length > 0 && fresh.length === 0) {
        this.counters.duplicates += partial.fills.length;
        continue;
      }
      const block = parseBlock(txLogs[0]?.blockNumber);
      const full = await this.decodeWithReceipt(tx, partial, ctx);
      this.countSkips(full.skipped);
      for (const fill of full.fills) rows.push(...(await this.toRow(fill, block)));
    }
    if (rows.length > 0) {
      const outcome = this.traders.recordTransferFills(rows);
      this.counters.fills += outcome.accepted;
      this.counters.duplicates += outcome.duplicates;
    }
    this.lastOkAt = this.now();
  }

  /** Full-receipt decode with token decimals and the WETH price primed first; falls back to the batch view when the receipt is unavailable. */
  private async decodeWithReceipt(tx: string, partial: ReturnType<typeof decodeTxTransfers>, ctx: DecodeContext): Promise<ReturnType<typeof decodeTxTransfers>> {
    const receipt = await this.traders.receipts.get(tx).catch(() => null);
    if (!receipt) {
      this.counters.receiptsMissing += 1;
      return partial;
    }
    const first = decodeTxTransfers(tx, receipt.logs, ctx);
    const quotes = [...new Set(first.fills.map((fill) => fill.quote).filter((quote): quote is string => quote !== null))];
    const tokens = [...new Set(first.fills.map((fill) => fill.token))];
    await Promise.all([this.prices.prime(quotes), ...tokens.map((token) => this.traders.erc20Meta.resolve(token))]);
    return decodeTxTransfers(tx, receipt.logs, ctx);
  }

  private async toRow(fill: TransferFill, block: number | null): Promise<TraderFill[]> {
    const key = transferFillKey(CHAIN, fill);
    if (this.seen.has(key)) {
      this.counters.duplicates += 1;
      return [];
    }
    const at = fill.block ?? block;
    const time = at === null ? null : await this.blocks.timeMs(at);
    if (time === null) {
      this.counters.untimed += 1;
      return [];
    }
    this.seen.set(key, true);
    if (fill.usd === null) this.counters.unpriced += 1;
    const handle = this.traders.handles.get(fill.wallet);
    return [
      {
        chain: CHAIN,
        pair: fomoPair(fill.token),
        tx: fill.tx,
        time,
        side: fill.side,
        usd: fill.usd,
        source: "own",
        price: fill.price,
        ...(fill.usdVia ? { usdVia: fill.usdVia } : {}),
        trader: fill.wallet,
        token: fill.token,
        handle: handle?.handle ?? null,
        followers: handle?.followers ?? null,
        kind: this.traders.peekKind(fill.wallet)
      }
    ];
  }

  private countSkips(skipped: SkipCounts): void {
    this.counters.transfersSkipped += skipped.transfers;
    this.counters.foreignSegment += skipped.foreignSegment;
    this.counters.unpaired += skipped.unpaired;
  }

  private fail(message: string): void {
    this.lastError = message;
    this.log(`transfer feed: ${message}`);
  }
}
