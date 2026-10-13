import type { FlowPrint } from "../../../shared/wire.js";
import type { RegistryPool } from "../../flow/registry.js";
import { errorMessage } from "../../lib/http.js";
import type { BlockTimeStats } from "../../tape/monad/blocks.js";
import type { ExtraLeg, LogsHandler, PollerStats, RawLog } from "../../tape/monad/poller.js";
import type { EvmQuotePriceStatus } from "../../tape/monad/price.js";
import type { LaunchIndex } from "../index.js";
import {
  decodeLaunchLog,
  toFlowPrint,
  type LaunchCreatedEvent,
  type LaunchEvent,
  type LaunchGraduationEvent,
  type LaunchTradeEvent
} from "./decode.js";
import { MONAD_MAINNET } from "../../../shared/chains.js";
import { LAUNCHPADS, QUOTES, launchAddresses, type DynamicEmitters, type LaunchpadId } from "./pads.js";

export const MONAD_LAUNCH_SOURCE = "rpc:monad";
/** Curve / AMM emitters kept in the eth_getLogs address filter; least recently active drop first. */
export const DEFAULT_MAX_EMITTERS = 400;
/** Monad mean block interval (~300 ms). Used only to place a log relative to the poll head. */
export const BLOCK_MS = MONAD_MAINNET.blockMs;
const LOG_THROTTLE_MS = 60_000;
/** USDC and AUSD on Monad both carry 6 decimals. */
const STABLE_DECIMALS = 6;
const STABLE_QUOTES = new Set<string>([QUOTES.usdc, QUOTES.ausd].filter(Boolean));
const MON_LIKE = new Set<string>([QUOTES.nativeMon, QUOTES.wmon]);
/** Pads whose trade logs come from one static contract and name the token in a topic (nad.fun's shared BondingCurve). */
const ROUTER_PADS: ReadonlySet<LaunchpadId> = new Set(["nadfun"]);
/** Pads whose trade logs come from a per-token contract learned at launch. None on Monad today; kept for the next pad. */
const DYNAMIC_PADS: ReadonlySet<LaunchpadId> = new Set<LaunchpadId>();

export type StreamPollerLike = {
  setExtraLegs(legs: ExtraLeg[]): void;
  start(onLogs: LogsHandler): void;
  stop(): void;
  stats(): PollerStats;
};
export type StreamBlocksLike = { timeMs(blockNumber: number): Promise<number | null>; stats(): BlockTimeStats };
export type StreamPricesLike = { prime(quotes: string[]): Promise<void>; get(quote: string): number | null; status(): EvmQuotePriceStatus };
export type StreamLedgerLike = { ingest(prints: FlowPrint[]): unknown };

export type MonadLaunchStreamOptions = {
  index: LaunchIndex;
  ledger: StreamLedgerLike;
  poller: StreamPollerLike;
  blocks: StreamBlocksLike;
  prices: StreamPricesLike;
  maxEmitters?: number;
  now?: () => number;
  log?: (msg: string) => void;
};

export type MonadLaunchStreamCounters = {
  launches: number;
  trades: number;
  /** Trades for tokens the index does not know: never priced, never ingested (bounds the ledger). */
  tradesDropped: number;
  /** Known-token trades whose block time could not be read; counted on the row but not ingested. */
  untimed: number;
  graduations: number;
  prints: number;
  undecoded: number;
};

export type MonadLaunchStreamStats = MonadLaunchStreamCounters & {
  emitters: number;
  lastEventAt: number | null;
  lastError: string | null;
  poller: PollerStats;
  blocks: BlockTimeStats;
  price: EvmQuotePriceStatus;
};

function emptyCounters(): MonadLaunchStreamCounters {
  return { launches: 0, trades: 0, tradesDropped: 0, untimed: 0, graduations: 0, prints: 0, undecoded: 0 };
}

/**
 * Ledger pair id for a launchpad's curve-phase tape: "<pad>:<emitter>" for per-token-contract pads and "<pad>:<token>"
 * for shared-contract pads (nad.fun). Prefixed so nothing downstream mistakes it for a DEX pool address.
 */
export function launchPairId(launchpad: string, token: string, curve: string | null): string | null {
  if (DYNAMIC_PADS.has(launchpad as LaunchpadId)) return curve ? `${launchpad}:${curve.toLowerCase()}` : null;
  if (ROUTER_PADS.has(launchpad as LaunchpadId)) return `${launchpad}:${token.toLowerCase()}`;
  return null;
}

/** Registry pool row for a launchpad pair; liquidity/volume are unknown on a curve and stay null. */
export function launchRegistryPool(launchpad: string, token: string, curve: string | null): RegistryPool | null {
  const pairAddress = launchPairId(launchpad, token, curve);
  return pairAddress ? { dex: launchpad, pairAddress, liquidityUsd: null, volume24Usd: null } : null;
}

/** ms clock for `block` placed relative to the poll head (`headBlock` ~ now on a 300 ms chain); never in the future. */
export function estimateBlockTimeMs(block: number, headBlock: number, now: number): number {
  return Math.min(now, Math.round(now - Math.max(0, headBlock - block) * BLOCK_MS));
}

function topicsOf(pick: (pad: (typeof LAUNCHPADS)[number]) => string[], pads?: ReadonlySet<LaunchpadId>): string[] {
  return [...new Set(LAUNCHPADS.filter((pad) => !pads || pads.has(pad.id)).flatMap(pick))];
}

/**
 * Monad launchpad stream (nad.fun): rides extra eth_getLogs legs on its own poller, decodes launch / trade /
 * graduation logs and writes them into the LaunchIndex. Curve trades of tokens the index knows become ledger prints
 * (block clock from BlockTimeCache, MON priced by EvmQuotePrice as WMON, USDC/AUSD at 1); everything else is counted and dropped.
 * Nothing here throws out of the poller handler.
 */
export class MonadLaunchStream {
  private readonly index: LaunchIndex;
  private readonly ledger: StreamLedgerLike;
  private readonly poller: StreamPollerLike;
  private readonly blocks: StreamBlocksLike;
  private readonly prices: StreamPricesLike;
  private readonly maxEmitters: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  /** Insertion order is recency order: a touched emitter is re-inserted, eviction drops the first key. */
  private readonly emitters: DynamicEmitters = new Map();
  private counters = emptyCounters();
  private lastEventAt: number | null = null;
  private lastError: string | null = null;
  private lastLoggedAt = 0;
  private running = false;
  /** Set whenever emitter membership changes, so the poller filter is re-sent once per batch (size alone can hide an add+evict). */
  private legsDirty = false;
  private readonly handler: LogsHandler = (logs, headBlock) => {
    this.handleLogs(logs, headBlock).catch((error) => this.fail(`logs: ${errorMessage(error)}`));
  };

  constructor(opts: MonadLaunchStreamOptions) {
    this.index = opts.index;
    this.ledger = opts.ledger;
    this.poller = opts.poller;
    this.blocks = opts.blocks;
    this.prices = opts.prices;
    this.maxEmitters = Math.max(1, opts.maxEmitters ?? DEFAULT_MAX_EMITTERS);
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((msg) => console.warn(msg));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.poller.setExtraLegs(this.legs());
    this.poller.start(this.handler);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.poller.stop();
  }

  stats(): MonadLaunchStreamStats {
    return {
      ...this.counters,
      emitters: this.emitters.size,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      poller: this.poller.stats(),
      blocks: this.blocks.stats(),
      price: this.prices.status()
    };
  }

  /** The legs the poller appends: pad contracts (launch + graduation), shared curves (trades), learned emitters (trades, when any). */
  legs(): ExtraLeg[] {
    const emitterAddresses = [...this.emitters.keys()].filter((key) => key.startsWith("0x"));
    const legs: ExtraLeg[] = [
      { addresses: launchAddresses(), topics: [topicsOf((pad) => [...pad.launchTopics, ...pad.graduationTopics])] },
      { addresses: LAUNCHPADS.filter((pad) => ROUTER_PADS.has(pad.id)).flatMap((pad) => pad.addresses), topics: [topicsOf((pad) => pad.tradeTopics, ROUTER_PADS)] }
    ];
    if (emitterAddresses.length && DYNAMIC_PADS.size) legs.push({ addresses: emitterAddresses, topics: [topicsOf((pad) => pad.tradeTopics, DYNAMIC_PADS)] });
    return legs;
  }

  /** One poller batch: decode in log order (a launch registers its emitter before the same batch's trades), then apply. */
  async handleLogs(logs: RawLog[], headBlock: number): Promise<void> {
    const events = this.decodeBatch(logs, headBlock);
    const trades = events.filter((event): event is LaunchTradeEvent => event.kind === "trade" && this.known(event.token));
    this.counters.tradesDropped += events.filter((event) => event.kind === "trade").length - trades.length;
    const graduations = events.filter((event): event is LaunchGraduationEvent => event.kind === "graduation");
    const times = await this.blockTimes([...trades, ...graduations].map((event) => event.block));
    await this.prices.prime([...new Set(trades.map((trade) => trade.quote).filter((quote): quote is string => quote !== null && MON_LIKE.has(quote)))]);
    for (const graduation of graduations) this.onGraduation(graduation, times.get(graduation.block) ?? estimateBlockTimeMs(graduation.block, headBlock, this.now()));
    const prints = trades.flatMap((trade) => this.onTrade(trade, times.get(trade.block) ?? null));
    if (prints.length) {
      this.ledger.ingest(prints);
      this.counters.prints += prints.length;
    }
    if (this.legsDirty && this.running) {
      this.legsDirty = false;
      this.poller.setExtraLegs(this.legs());
    }
  }

  private decodeBatch(logs: RawLog[], headBlock: number): LaunchEvent[] {
    const events: LaunchEvent[] = [];
    for (const log of logs) {
      const event = decodeLaunchLog(log, { curveTokens: this.emitters });
      if (!event) {
        this.counters.undecoded += 1;
        continue;
      }
      this.lastEventAt = this.now();
      if (event.kind === "launch") this.onLaunch(event, headBlock);
      events.push(event);
    }
    return events;
  }

  private known(token: string): boolean {
    return this.index.get("monad", token) !== null;
  }

  private onLaunch(event: LaunchCreatedEvent, headBlock: number): void {
    this.counters.launches += 1;
    this.index.upsert({
      chain: "monad",
      token: event.token,
      launchpad: event.launchpad,
      creator: event.creator,
      curve: event.curve,
      pool: event.pool,
      name: event.name,
      symbol: event.symbol,
      createdAt: estimateBlockTimeMs(event.block, headBlock, this.now()),
      tx: event.tx,
      sources: [MONAD_LAUNCH_SOURCE]
    });
    if (DYNAMIC_PADS.has(event.launchpad) && event.curve) this.remember(event.curve, event);
    if (ROUTER_PADS.has(event.launchpad)) this.remember(`${event.launchpad}:${event.token}`, event);
  }

  /** Registers (or refreshes) an emitter key; the quote comes from the launch event so trades can be priced honestly. */
  private remember(key: string, event: LaunchCreatedEvent): void {
    if (!this.emitters.has(key)) this.legsDirty = true;
    this.emitters.delete(key);
    this.emitters.set(key, { token: event.token, launchpad: event.launchpad, quote: event.quote });
    while (this.emitters.size > this.maxEmitters) {
      const oldest = this.emitters.keys().next().value;
      if (oldest === undefined) break;
      this.emitters.delete(oldest);
      this.legsDirty = true;
    }
  }

  private touch(key: string): void {
    const emitter = this.emitters.get(key);
    if (!emitter) return;
    this.emitters.delete(key);
    this.emitters.set(key, emitter);
  }

  private onTrade(event: LaunchTradeEvent, timeMs: number | null): FlowPrint[] {
    this.counters.trades += 1;
    this.touch(event.curve);
    const usd = this.priceTrade(event);
    this.index.recordTrade("monad", event.token, event.side, usd);
    const pair = launchPairId(event.launchpad, event.token, event.curve);
    if (timeMs === null || pair === null) {
      this.counters.untimed += 1;
      return [];
    }
    const print = toFlowPrint(event, timeMs, null);
    return [{ ...print, pair, usd }];
  }

  /** MON-like quotes via EvmQuotePrice (as WMON), USDC/AUSD at their stable price (1); every other quote stays unpriced. */
  private priceTrade(event: LaunchTradeEvent): number | null {
    if (event.quote === null || event.quoteAmount === null) return null;
    if (MON_LIKE.has(event.quote)) return toFlowPrint(event, 0, this.prices.get(event.quote)).usd;
    if (!STABLE_QUOTES.has(event.quote)) return null;
    const stable = this.prices.get(event.quote);
    if (stable === null) return null;
    const usd = (Number(event.quoteAmount) / 10 ** STABLE_DECIMALS) * stable;
    return Number.isFinite(usd) ? usd : null;
  }

  /** Marks the row graduated and retires its curve emitter (the curve stops trading once the pool exists). */
  private onGraduation(event: LaunchGraduationEvent, at: number): void {
    if (event.token === null) return;
    this.counters.graduations += 1;
    this.index.recordGraduation("monad", event.token, at, event.pool);
    const token = event.token.toLowerCase();
    for (const [key, emitter] of this.emitters) {
      if (emitter.token.toLowerCase() !== token || emitter.launchpad !== event.launchpad) continue;
      this.emitters.delete(key);
      this.legsDirty = true;
    }
  }

  /** One block-time lookup per distinct block; the cache joins duplicates in flight and retries before reporting null. */
  private async blockTimes(blocks: number[]): Promise<Map<number, number | null>> {
    const distinct = [...new Set(blocks)];
    const entries = await Promise.all(distinct.map(async (block): Promise<[number, number | null]> => [block, await this.blocks.timeMs(block)]));
    return new Map(entries);
  }

  private fail(message: string): void {
    this.lastError = message;
    const now = this.now();
    if (now - this.lastLoggedAt < LOG_THROTTLE_MS) return;
    this.lastLoggedAt = now;
    this.log(`monad launch stream: ${message}`);
  }
}
