import type { FlowPrint, PairRow } from "../../../shared/wire.js";
import { config } from "../../config.js";
import type { FlowLedger } from "../../flow/ledger.js";
import { errorMessage } from "../../lib/http.js";
import { getTraderService, type AnnotateContext, type MetaOf, type PrintMeta } from "../../traders/service.js";
import { BlockTimeCache, type BlockTimeStats } from "./blocks.js";
import { decodeSwapLeg, decodeSwapLog, type EvmPoolRef as DecodePoolRef } from "./decode.js";
import { RobinhoodLogPoller, type LogsHandler, type PollerStats, type RawLog } from "./poller.js";
import { POOL_MANAGER, poolResolveStatus, resolvePoolRef, type EvmPoolRef, type PoolResolveStatus } from "./pools.js";
import { EvmQuotePrice, type EvmQuotePriceStatus } from "./price.js";
import { PoolResolveQueue, poolKey, type PoolResolver } from "./resolveQueue.js";
import { hexToNumber } from "./rpc.js";

/** The slices of the transports the tape drives; tests inject fakes through these seams. */
export type PollerLike = {
  setFilter(addresses: string[], poolIds: string[]): void;
  start(onLogs: LogsHandler): void;
  stop(): void;
  stats(): PollerStats;
};
export type BlockTimeLike = {
  timeMs(blockNumber: number): Promise<number | null>;
  stats(): BlockTimeStats;
};
/** R3 trader attribution seam: the shared TraderService in production, null in tests and when it is not wired. */
export type TraderAnnotatorLike = {
  annotate(prints: FlowPrint[], ctx: AnnotateContext): Promise<FlowPrint[]>;
  record(prints: FlowPrint[], meta: MetaOf): unknown;
};
export type EvmPriceLike = {
  prime(quotes: string[]): Promise<void>;
  get(quote: string): number | null;
  status(): EvmQuotePriceStatus;
};
export type RobinhoodOwnTapeOptions = {
  rpcUrl: string;
  ledger: FlowLedger;
  log?: (msg: string) => void;
  now?: () => number;
  poller?: PollerLike;
  blocks?: BlockTimeLike;
  prices?: EvmPriceLike;
  resolve?: PoolResolver;
  resolveStatus?: () => PoolResolveStatus;
  /** Pause between two pool resolutions (RESOLVE_STAGGER_MS by default; tests pass 0). */
  resolveStaggerMs?: number;
  decode?: typeof decodeSwapLog;
  /** Omitted (or null) means prints are ingested unannotated; the live tape passes the shared TraderService. */
  traders?: TraderAnnotatorLike | null;
};

export type RobinhoodOwnTapeCounters = {
  prints: number;
  /** Logs the poller delivered that decoded to nothing (or threw) for this token's pools. */
  undecoded: number;
  /** Swap logs dropped because their block timestamp could not be read. */
  untimed: number;
  lastPrintAt: number | null;
};

export type RobinhoodOwnTapeStats = RobinhoodOwnTapeCounters & {
  tokens: number;
  pools: number;
  lastError: string | null;
  poller: PollerStats;
  blocks: BlockTimeStats;
  price: EvmQuotePriceStatus;
  resolve: PoolResolveStatus;
};

type TokenState = RobinhoodOwnTapeCounters & { rows: PairRow[] };
type IndexedPool = { ref: DecodePoolRef; token: string };

function emptyCounters(): RobinhoodOwnTapeCounters {
  return { prints: 0, undecoded: 0, untimed: 0, lastPrintAt: null };
}

function laterOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function sumCounters(total: RobinhoodOwnTapeCounters, state: RobinhoodOwnTapeCounters): RobinhoodOwnTapeCounters {
  return {
    prints: total.prints + state.prints,
    undecoded: total.undecoded + state.undecoded,
    untimed: total.untimed + state.untimed,
    lastPrintAt: laterOf(total.lastPrintAt, state.lastPrintAt)
  };
}

/** The decoder's view of a resolved pool: keyed by the lowercase id, ledgerPair verbatim from the registry. */
function toDecodeRef(ref: EvmPoolRef): DecodePoolRef {
  return { ...ref, pairAddress: ref.pair };
}

/** Token, dex and the fill's token leg in base units (the hint that separates several traders' fills bundled into one tx). */
function printMeta(log: RawLog, pools: Map<string, DecodePoolRef>, token: string): PrintMeta {
  const decoded = decodeSwapLeg(log, pools);
  return { token, dex: decoded?.pool.dex ?? "", ...(decoded ? { amount: decoded.leg.tokenAmount } : {}) };
}

function blockOf(blockNumber: string): number | null {
  try {
    return hexToNumber(blockNumber);
  } catch {
    return null;
  }
}

/** Tape against config.robinhood.rpcUrl (ROBINHOOD_RPC_URL, public Robinhood Chain RPC by default). */
export function createRobinhoodOwnTapeFromConfig(ledger: FlowLedger, log?: (msg: string) => void): RobinhoodOwnTape {
  return new RobinhoodOwnTape({ rpcUrl: config.robinhood.rpcUrl, ledger, log, traders: getTraderService() });
}

/**
 * Own Robinhood Chain tape: one eth_getLogs poller over the union of every tracked token's Tier A pools ->
 * decodeSwapLog with the block clock from BlockTimeCache -> ledger.ingest. Prints reuse the registry's pairAddress
 * verbatim, so the ledger's (chain, tx, pair) dedupe collapses a swap also seen by the Gecko fallback.
 * Pool resolution (token0/token1/fee/decimals) runs one pool at a time through PoolResolveQueue and is cached per
 * pool; a pool that fails is skipped and retried by the queue's own timer with a doubling delay. Nothing here throws
 * out of a handler.
 */
const POOL_ID_IN_MESSAGE = /0x[0-9a-f]{40,64}/g;

/** null when `message` names a pool address and none of `rows` is that pool; a message naming no pool is kept as is. */
export function scopedError(message: string | null, rows: readonly PairRow[]): string | null {
  if (message === null) return null;
  const named = message.toLowerCase().match(POOL_ID_IN_MESSAGE);
  if (!named) return message;
  const own = new Set(rows.map((row) => row.pairAddress.toLowerCase()));
  return named.some((id) => own.has(id)) ? message : null;
}

export class RobinhoodOwnTape {
  private readonly ledger: FlowLedger;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly poller: PollerLike;
  private readonly blocks: BlockTimeLike;
  private readonly prices: EvmPriceLike;
  private readonly resolveStatus: () => PoolResolveStatus;
  private readonly decode: typeof decodeSwapLog;
  private readonly traders: TraderAnnotatorLike | null;
  private readonly queue: PoolResolveQueue;
  private readonly tokens = new Map<string, TokenState>();
  /** Pool id (lowercase contract or poolId) -> decoder ref; the first token to track a pool owns its prints. */
  private index = new Map<string, IndexedPool>();
  private polling = false;
  private lastError: string | null = null;
  private readonly handler: LogsHandler = (logs) => {
    this.onLogs(logs).catch((error) => this.fail(`logs: ${errorMessage(error)}`));
  };

  constructor(opts: RobinhoodOwnTapeOptions) {
    this.ledger = opts.ledger;
    this.log = opts.log ?? ((msg) => console.warn(msg));
    this.now = opts.now ?? (() => Date.now());
    this.poller = opts.poller ?? new RobinhoodLogPoller({ rpcUrl: opts.rpcUrl, log: this.log, now: this.now });
    this.blocks = opts.blocks ?? new BlockTimeCache({ rpcUrl: opts.rpcUrl });
    this.prices = opts.prices ?? new EvmQuotePrice({ chain: "robinhood", now: this.now });
    this.resolveStatus = opts.resolveStatus ?? poolResolveStatus;
    this.decode = opts.decode ?? decodeSwapLog;
    this.traders = opts.traders ?? null;
    const resolve: PoolResolver = opts.resolve ?? ((row) => resolvePoolRef(row, { rpcUrl: opts.rpcUrl }));
    this.queue = new PoolResolveQueue({
      resolve,
      resolveStatus: this.resolveStatus,
      rows: () => [...this.tokens.values()].flatMap((state) => state.rows),
      onChange: () => this.applyFilter(),
      onError: (message) => this.fail(message),
      now: this.now,
      staggerMs: opts.resolveStaggerMs
    });
  }

  /** Idempotent: replaces the token's pool rows (Tier A only) and queues their resolution; no Tier A rows untracks. */
  track(address: string, pairs: PairRow[]): void {
    const rows = pairs.filter((row) => row.tier === "A");
    if (rows.length === 0) {
      this.untrack(address);
      return;
    }
    const token = address.toLowerCase();
    const existing = this.tokens.get(token);
    this.tokens.set(token, existing ? { ...existing, rows } : { ...emptyCounters(), rows });
    this.queue.request(rows);
    this.applyFilter();
  }

  untrack(address: string): void {
    if (!this.tokens.delete(address.toLowerCase())) return;
    this.applyFilter();
  }

  /**
   * Counters for one token, or summed over every tracked token when omitted. Per token, a tape-wide error that names
   * another token's pool (resolve failures carry the pool address) is not this token's error and is left out.
   */
  stats(address?: string): RobinhoodOwnTapeStats {
    const state = address === undefined ? undefined : this.tokens.get(address.toLowerCase());
    const states = address === undefined ? [...this.tokens.values()] : state ? [state] : [];
    const scope = state ? (message: string | null) => scopedError(message, state.rows) : (message: string | null) => message;
    const resolve = this.resolveStatus();
    return {
      ...states.reduce(sumCounters, emptyCounters()),
      tokens: this.tokens.size,
      pools: this.index.size,
      lastError: scope(this.lastError),
      poller: this.poller.stats(),
      blocks: this.blocks.stats(),
      price: this.prices.status(),
      resolve: { ...resolve, lastError: scope(resolve.lastError) }
    };
  }

  stop(): void {
    this.tokens.clear();
    this.index = new Map();
    this.queue.stop();
    this.stopPolling();
  }

  /** Rebuilds the pool index from every tracked token's resolved rows and pushes the union to the poller. */
  private applyFilter(): void {
    const index = new Map<string, IndexedPool>();
    for (const [token, state] of this.tokens) {
      for (const row of state.rows) {
        const key = poolKey(row);
        const ref = this.queue.ref(key);
        if (ref && !index.has(key)) index.set(key, { ref: toDecodeRef(ref), token });
      }
    }
    this.index = index;
    const refs = [...index.values()].map((entry) => entry.ref);
    const addresses = refs.filter((ref) => ref.kind !== "v4").map((ref) => ref.pair);
    const poolIds = refs.filter((ref) => ref.kind === "v4").map((ref) => ref.pair);
    this.poller.setFilter(addresses, poolIds);
    if (refs.length === 0) {
      this.stopPolling();
      return;
    }
    void this.prices.prime([...new Set(refs.map((ref) => ref.quote))]);
    if (!this.polling) this.poller.start(this.handler);
    this.polling = true;
  }

  private stopPolling(): void {
    if (!this.polling) return;
    this.polling = false;
    this.poller.stop();
  }

  private pools(): Map<string, DecodePoolRef> {
    return new Map([...this.index].map(([key, entry]) => [key, entry.ref]));
  }

  private async onLogs(logs: RawLog[]): Promise<void> {
    const pools = this.pools();
    const quotes = [...new Set([...pools.values()].map((ref) => ref.quote))];
    await this.prices.prime(quotes);
    const times = await this.blockTimes(logs);
    const prints: FlowPrint[] = [];
    const metas = new Map<FlowPrint, PrintMeta>();
    for (const log of logs) {
      const decoded = this.decodeOne(log, pools, times.get(log.blockNumber) ?? null);
      if (!decoded) continue;
      prints.push(decoded.print);
      metas.set(decoded.print, printMeta(log, pools, decoded.token));
    }
    if (prints.length) this.ledger.ingest(await this.annotate(prints, pools, (print) => metas.get(print) ?? null));
  }

  /** R3: attribution runs between decode and ingest; no service, a throw, or the batch deadline ingests unannotated. */
  private async annotate(prints: FlowPrint[], pools: Map<string, DecodePoolRef>, meta: MetaOf): Promise<FlowPrint[]> {
    if (!this.traders) return prints;
    try {
      const annotated = await this.traders.annotate(prints, { pools: [...pools.values()].map((ref) => ref.pair), meta });
      this.traders.record(annotated, meta);
      return annotated;
    } catch (error) {
      this.fail(`annotate: ${errorMessage(error)}`);
      return prints;
    }
  }

  /** One block-time lookup per distinct block in the batch; the cache joins duplicates in flight. */
  private async blockTimes(logs: RawLog[]): Promise<Map<string, number | null>> {
    const distinct = [...new Set(logs.map((log) => log.blockNumber))];
    const entries = await Promise.all(
      distinct.map(async (hex): Promise<[string, number | null]> => {
        const block = blockOf(hex);
        return [hex, block === null ? null : await this.blocks.timeMs(block)];
      })
    );
    return new Map(entries);
  }

  /** The print plus the token that owns the emitting pool (the same owner the counters are bumped under). */
  private decodeOne(log: RawLog, pools: Map<string, DecodePoolRef>, timeMs: number | null): { print: FlowPrint; token: string } | null {
    const owner = this.ownerOf(log);
    if (owner === null) return null;
    if (timeMs === null) {
      this.bump(owner, { untimed: 1 });
      return null;
    }
    try {
      const print = this.decode(log, pools, { timeMs, quoteUsd: (quote) => this.prices.get(quote) });
      this.bump(owner, print ? { prints: 1, lastPrintAt: this.now() } : { undecoded: 1 });
      return print ? { print, token: owner } : null;
    } catch (error) {
      this.bump(owner, { undecoded: 1 });
      this.fail(`decode ${log.transactionHash}: ${errorMessage(error)}`);
      return null;
    }
  }

  /** The token whose pool emitted this log: by contract for v2/v3, by poolId topic for v4 (PoolManager logs). */
  private ownerOf(log: RawLog): string | null {
    const address = log.address.toLowerCase();
    if (address !== POOL_MANAGER) return this.index.get(address)?.token ?? null;
    const poolId = log.topics[1];
    return typeof poolId === "string" ? (this.index.get(poolId.toLowerCase())?.token ?? null) : null;
  }

  private bump(token: string, delta: Partial<RobinhoodOwnTapeCounters>): void {
    const state = this.tokens.get(token);
    if (!state) return;
    this.tokens.set(token, {
      ...state,
      prints: state.prints + (delta.prints ?? 0),
      undecoded: state.undecoded + (delta.undecoded ?? 0),
      untimed: state.untimed + (delta.untimed ?? 0),
      lastPrintAt: delta.lastPrintAt ?? state.lastPrintAt
    });
  }

  private fail(message: string): void {
    this.lastError = message;
    this.log(`robinhood own tape: ${message}`);
  }
}
