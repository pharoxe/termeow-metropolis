import type { Chain, FeedHealth, PairRow } from "../../shared/wire.js";
import { errorMessage } from "../lib/http.js";
import { geckoBlockedUntilMs, geckoPoolTrades } from "../sources/gecko.js";
import { fetchPumpTradesPage, walkPumpTradesBack, type WalkPumpResult } from "../sources/pumpfun.js";
import { createRobinhoodOwnTapeFromConfig, type RobinhoodOwnTapeStats } from "../tape/robinhood/ownTape.js";
import { createOwnTapeFromConfig, type OwnTapeStats } from "../tape/solana/ownTape.js";
import { poolRefsFromRegistry, type PoolRef } from "../tape/solana/parseSwap.js";
import { feedHealthOf, ownTapeHealthy } from "./feedHealth.js";
import { FlowLedger, HOUR_MS, pairKey } from "./ledger.js";

export const COLLECTOR_TICK_MS = 5_000;
/** Gecko pool-trade cadence when Gecko is the only tape for a token (Solana, or a Robinhood own poller that is down). */
export const GECKO_POLL_MS = 15_000;
/** Cadence on Robinhood while the own poller is healthy: the own tape is primary there, Gecko only cross-checks. */
export const GECKO_POLL_SLOW_MS = 60_000;
/** A token nobody asked about for this long is evicted (own tape untracked, Gecko polling stopped); its ledger data stays. */
export const IDLE_MS = 90_000;
/** Focused instruments only: the desk shows one, the candles route shares it, and a just-switched-away token may linger. */
export const MAX_SUBSCRIPTIONS = 4;
/** Registry snapshots remembered for evicted tokens so the flow route can still serve their ledger ring when the registry is down. */
export const REMEMBERED_PAIRS_MAX = 64;
export const BACKFILL_WINDOW_MS = 48 * HOUR_MS;
export const BACKFILL_MAX_PAGES = 60;
export const BACKFILL_PAGE_DELAY_MS = 500;
export const BACKFILL_RETRY_MS = 60_000;
const LOG_THROTTLE_MS = 60_000;
const PUMP_PREFIX = "pumpfun:";

export type SourceName = "pumpfun" | "geckoterminal";
export type SourceHealth = { lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null };
/** Own-tape health: `tape` is null until the token is tracked (or when the tape is broken); shape follows the chain. */
export type OwnHealthStats = OwnTapeStats | RobinhoodOwnTapeStats;
export type OwnSourceHealth = SourceHealth & { tape: OwnHealthStats | null };
export type OwnTapeLike = {
  track(mint: string, pools: PoolRef[]): void;
  untrack(mint: string): void;
  stats(mint?: string): OwnTapeStats;
  stop(): void;
};
/** The Robinhood tape resolves its own pool refs from registry rows, so it takes PairRow[] rather than PoolRef[]. */
export type RobinhoodOwnTapeLike = {
  track(address: string, pairs: PairRow[]): void;
  untrack(address: string): void;
  stats(address?: string): RobinhoodOwnTapeStats;
  stop(): void;
};
/** Chain-neutral view of a tape as the collector drives it: registry rows in, chain-shaped stats out. */
type ChainTape = Omit<RobinhoodOwnTapeLike, "stats"> & { stats(address: string): OwnHealthStats };
type OwnFault = { message: string; at: number };
export type BackfillState = {
  pair: string;
  startedAt: number;
  finishedAt: number | null;
  result: WalkPumpResult | null;
  error: string | null;
};
type GeckoMode = "fast" | "slow";
export type CollectorStatus = {
  subscribed: boolean;
  lastRequestedAt: number | null;
  tierAPairs: number;
  sources: Record<SourceName, SourceHealth> & { own: OwnSourceHealth };
  feedHealth: FeedHealth;
  backfill: BackfillState | null;
  launchMs: number | null;
};

export type CollectorDeps = {
  ledger?: FlowLedger;
  now?: () => number;
  log?: (message: string) => void;
  geckoPoolTrades?: typeof geckoPoolTrades;
  fetchPumpTradesPage?: typeof fetchPumpTradesPage;
  walkPumpTradesBack?: typeof walkPumpTradesBack;
  /** Factory for the own tape, invoked lazily on the first solana subscribe; defaults to config.rpc.primary. */
  ownTape?: (ledger: FlowLedger, log: (message: string) => void) => OwnTapeLike;
  /** Factory for the Robinhood own tape, invoked lazily on the first robinhood subscribe; defaults to config.robinhood.rpcUrl. */
  ownTapeRobinhood?: (ledger: FlowLedger, log: (message: string) => void) => RobinhoodOwnTapeLike;
};

type Subscription = {
  chain: Chain;
  address: string;
  pairs: PairRow[];
  lastRequestedAt: number;
  polledAt: Record<string, number>;
  sources: Record<SourceName, SourceHealth>;
  lastLoggedAt: Record<SourceName, number>;
  geckoMode: GeckoMode;
};

function emptyHealth(): SourceHealth {
  return { lastOkAt: null, lastError: null, lastErrorAt: null };
}

function emptySources(): Record<SourceName, SourceHealth> {
  return { pumpfun: emptyHealth(), geckoterminal: emptyHealth() };
}

function newSubscription(chain: Chain, address: string, pairs: PairRow[], now: number): Subscription {
  return { chain, address, pairs, lastRequestedAt: now, polledAt: {}, sources: emptySources(), lastLoggedAt: { pumpfun: 0, geckoterminal: 0 }, geckoMode: "fast" };
}

function pumpMint(pair: PairRow): string | null {
  return pair.pairAddress.startsWith(PUMP_PREFIX) ? pair.pairAddress.slice(PUMP_PREFIX.length) : null;
}

function tierA(pairs: PairRow[]): PairRow[] {
  return pairs.filter((pair) => pair.tier === "A");
}

function geckoPollMsFor(mode: GeckoMode): number {
  return mode === "slow" ? GECKO_POLL_SLOW_MS : GECKO_POLL_MS;
}

function solanaChainTape(tape: OwnTapeLike): ChainTape {
  return {
    track: (address, pairs) => tape.track(address, poolRefsFromRegistry(pairs, address)),
    untrack: (address) => tape.untrack(address),
    stats: (address) => tape.stats(address),
    stop: () => tape.stop()
  };
}

/** First error across the tape's transports, whichever chain shape it reports. */
function tapeError(tape: OwnHealthStats): string | null {
  if ("subscriber" in tape) return tape.lastError ?? tape.subscriber.lastError ?? tape.reader.lastError ?? tape.price.lastError;
  return tape.lastError ?? tape.poller.lastError ?? tape.blocks.lastError ?? tape.resolve.lastError ?? tape.price.lastError;
}

/** A backfill runs once per token; a walk that failed is retried BACKFILL_RETRY_MS after it stopped. */
function backfillDue(state: BackfillState | undefined, now: number): boolean {
  if (!state) return true;
  return state.error !== null && state.finishedAt !== null && now - state.finishedAt >= BACKFILL_RETRY_MS;
}

/**
 * Polls trade prints for subscribed tokens into one shared FlowLedger: the pump.fun pseudo-pair every tick,
 * other Tier A pools via GeckoTerminal (background class) every GECKO_POLL_MS, or every GECKO_POLL_SLOW_MS on
 * Robinhood while the own poller is healthy. Tokens idle for IDLE_MS are evicted. Never throws from a tick.
 */
export class FlowCollector {
  readonly ledger: FlowLedger;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly fetchGecko: typeof geckoPoolTrades;
  private readonly fetchPump: typeof fetchPumpTradesPage;
  private readonly walkPump: typeof walkPumpTradesBack;
  private readonly makeOwnTape: (ledger: FlowLedger, log: (message: string) => void) => OwnTapeLike;
  private readonly makeOwnTapeRobinhood: (ledger: FlowLedger, log: (message: string) => void) => RobinhoodOwnTapeLike;
  private ownTapes = new Map<Chain, ChainTape>();
  private ownTracked = new Set<string>();
  private ownFaults = new Map<Chain, OwnFault>();
  private ownLoggedAt = 0;
  private subs = new Map<string, Subscription>();
  private rememberedPairs = new Map<string, PairRow[]>();
  private backfills = new Map<string, BackfillState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(deps: CollectorDeps = {}) {
    this.ledger = deps.ledger ?? new FlowLedger();
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((message) => console.warn(message));
    this.fetchGecko = deps.geckoPoolTrades ?? geckoPoolTrades;
    this.fetchPump = deps.fetchPumpTradesPage ?? fetchPumpTradesPage;
    this.walkPump = deps.walkPumpTradesBack ?? walkPumpTradesBack;
    this.makeOwnTape = deps.ownTape ?? createOwnTapeFromConfig;
    this.makeOwnTapeRobinhood = deps.ownTapeRobinhood ?? createRobinhoodOwnTapeFromConfig;
  }

  /** Marks interest; pairs replace the previous registry snapshot. Starts the tick loop on first call. */
  subscribe(chain: Chain, address: string, pairs: PairRow[]): void {
    const key = pairKey(chain, address);
    const now = this.now();
    const existing = this.subs.get(key);
    if (!existing) this.makeRoom(now);
    this.subs.set(key, existing ? { ...existing, pairs, lastRequestedAt: now } : newSubscription(chain, address, pairs, now));
    this.maybeBackfill(key, chain, pairs, now);
    this.trackOwn(key, chain, address, pairs);
    this.start();
  }

  status(chain: Chain, address: string): CollectorStatus {
    const sub = this.subs.get(pairKey(chain, address));
    const now = this.now();
    const sources = sub?.sources ?? emptySources();
    const own = this.ownHealth(sub);
    return {
      subscribed: sub !== undefined,
      lastRequestedAt: sub?.lastRequestedAt ?? null,
      tierAPairs: sub ? tierA(sub.pairs).length : 0,
      sources: { ...sources, own },
      feedHealth: feedHealthOf({ sources, own, geckoBlockedUntil: geckoBlockedUntilMs(now), now }),
      backfill: this.backfills.get(pairKey(chain, address)) ?? null,
      launchMs: this.launchMs(chain, address)
    };
  }

  /** Registry rows last handed to subscribe() for this token, kept after eviction; null when never subscribed. */
  pairsOf(chain: Chain, address: string): PairRow[] | null {
    const key = pairKey(chain, address);
    return this.subs.get(key)?.pairs ?? this.rememberedPairs.get(key) ?? null;
  }

  /** Oldest pump print, known only when the backfill walked the whole feed to its end. */
  launchMs(chain: Chain, address: string): number | null {
    const backfill = this.backfills.get(pairKey(chain, address));
    if (!backfill || backfill.result?.stoppedBy !== "end") return null;
    return this.ledger.firstPrintAt(chain, backfill.pair);
  }

  subscriptions(): string[] {
    return [...this.subs.keys()];
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopOwn();
  }

  /** One polling round: evicts tokens idle past IDLE_MS, then polls every remaining subscription. Safe to call directly. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      this.reapIdle(now);
      await Promise.all([...this.subs.values()].map((sub) => this.pollSubscription(sub, now)));
    } finally {
      this.ticking = false;
    }
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), COLLECTOR_TICK_MS);
    this.timer.unref?.();
  }

  private makeRoom(now: number): void {
    while (this.subs.size >= MAX_SUBSCRIPTIONS) {
      const victim = [...this.subs.entries()].sort((a, b) => a[1].lastRequestedAt - b[1].lastRequestedAt)[0];
      if (!victim) return;
      this.evict(victim[0], victim[1], now, `cap ${MAX_SUBSCRIPTIONS}`);
    }
  }

  /** Drops a subscription: own tape untracked, Gecko polling stops, the registry snapshot is remembered for the route. */
  private evict(key: string, sub: Subscription, now: number, reason: string): void {
    this.subs.delete(key);
    this.remember(key, sub.pairs);
    this.untrackOwn(key, sub.chain, sub.address);
    this.log(`flow collector: dropping ${key} (idle ${Math.round((now - sub.lastRequestedAt) / 1000)}s, ${reason})`);
  }

  private remember(key: string, pairs: PairRow[]): void {
    this.rememberedPairs.delete(key);
    this.rememberedPairs.set(key, pairs);
    while (this.rememberedPairs.size > REMEMBERED_PAIRS_MAX) {
      const oldest = this.rememberedPairs.keys().next().value;
      if (oldest === undefined) return;
      this.rememberedPairs.delete(oldest);
    }
  }

  private maybeBackfill(key: string, chain: Chain, pairs: PairRow[], now: number): void {
    if (!backfillDue(this.backfills.get(key), now)) return;
    const pump = tierA(pairs).find((pair) => pumpMint(pair) !== null);
    const mint = pump ? pumpMint(pump) : null;
    if (!pump || !mint) return;
    this.backfills.set(key, { pair: pump.pairAddress, startedAt: now, finishedAt: null, result: null, error: null });
    void this.runBackfill(key, chain, mint);
  }

  private async runBackfill(key: string, chain: Chain, mint: string): Promise<void> {
    try {
      const result = await this.walkPump(mint, {
        untilMs: this.now() - BACKFILL_WINDOW_MS,
        maxPages: BACKFILL_MAX_PAGES,
        pageDelayMs: BACKFILL_PAGE_DELAY_MS,
        onPage: (prints) => void this.ledger.ingest(prints)
      });
      this.finishBackfill(key, { result, error: null });
    } catch (error) {
      this.finishBackfill(key, { result: null, error: errorMessage(error) });
      this.fail(key, "pumpfun", error);
    }
  }

  private finishBackfill(key: string, outcome: Pick<BackfillState, "result" | "error">): void {
    const state = this.backfills.get(key);
    if (state) this.backfills.set(key, { ...state, ...outcome, finishedAt: this.now() });
  }

  private pollSubscription(sub: Subscription, now: number): Promise<unknown> {
    const key = pairKey(sub.chain, sub.address);
    const pollMs = this.geckoPollMs(key, sub, now);
    const tasks = tierA(sub.pairs).map((pair) => {
      const mint = pumpMint(pair);
      if (mint !== null) return this.pollPump(key, sub.chain, mint);
      return this.geckoDue(sub, pair.pairAddress, now, pollMs) ? this.pollGecko(key, sub, pair.pairAddress, now) : Promise.resolve();
    });
    return Promise.all(tasks);
  }

  /** Robinhood: slow cadence while the own poller is healthy (own tape primary), fast otherwise; Solana is always fast. */
  private geckoPollMs(key: string, sub: Subscription, now: number): number {
    const mode: GeckoMode = sub.chain === "robinhood" && ownTapeHealthy(this.ownHealth(sub), now) ? "slow" : "fast";
    if (mode !== sub.geckoMode) {
      this.patch(key, (current) => ({ ...current, geckoMode: mode }));
      this.log(`flow collector: gecko cadence ${key}: ${mode} (${geckoPollMsFor(mode) / 1000}s, own tape ${mode === "slow" ? "healthy" : "down"})`);
    }
    return geckoPollMsFor(mode);
  }

  private geckoDue(sub: Subscription, pair: string, now: number, pollMs: number): boolean {
    return now - (sub.polledAt[pair] ?? Number.NEGATIVE_INFINITY) >= pollMs;
  }

  private async pollPump(key: string, chain: Chain, mint: string): Promise<void> {
    try {
      const page = await this.fetchPump(mint);
      this.ledger.ingest(page.prints);
      this.ok(key, "pumpfun");
    } catch (error) {
      this.fail(key, "pumpfun", error);
    }
  }

  /** Gecko prints are oriented to the focused token (`token`), since a pool may hold it as its quote leg. */
  private async pollGecko(key: string, sub: Subscription, pair: string, now: number): Promise<void> {
    this.patch(key, (sub) => ({ ...sub, polledAt: { ...sub.polledAt, [pair]: now } }));
    try {
      const prints = await this.fetchGecko(sub.chain, pair, { priority: "background", token: sub.address });
      this.ledger.ingest(prints);
      this.ok(key, "geckoterminal");
    } catch (error) {
      this.fail(key, "geckoterminal", error);
    }
  }

  private ok(key: string, source: SourceName): void {
    const now = this.now();
    this.patch(key, (sub) => ({ ...sub, sources: { ...sub.sources, [source]: { ...sub.sources[source], lastOkAt: now, lastError: null } } }));
  }

  private fail(key: string, source: SourceName, error: unknown): void {
    const now = this.now();
    const message = errorMessage(error);
    this.patch(key, (sub) => {
      const shouldLog = now - sub.lastLoggedAt[source] >= LOG_THROTTLE_MS;
      if (shouldLog) this.log(`flow collector: ${source} ${key}: ${message}`);
      return {
        ...sub,
        sources: { ...sub.sources, [source]: { ...sub.sources[source], lastError: message, lastErrorAt: now } },
        lastLoggedAt: shouldLog ? { ...sub.lastLoggedAt, [source]: now } : sub.lastLoggedAt
      };
    });
  }

  private patch(key: string, update: (sub: Subscription) => Subscription): void {
    const sub = this.subs.get(key);
    if (sub) this.subs.set(key, update(sub));
  }

  /** One lazily created tape per chain; the factory may throw, which withOwnTape reports as a fault. */
  private ownTapeFor(chain: Chain): ChainTape {
    const existing = this.ownTapes.get(chain);
    if (existing) return existing;
    const tape = chain === "robinhood" ? this.makeOwnTapeRobinhood(this.ledger, this.log) : solanaChainTape(this.makeOwnTape(this.ledger, this.log));
    this.ownTapes.set(chain, tape);
    return tape;
  }

  /** Runs one own-tape call; a throw is recorded and logged (throttled) and never reaches the caller. */
  private withOwnTape(chain: Chain, action: (tape: ChainTape) => void): void {
    try {
      action(this.ownTapeFor(chain));
      this.ownFaults.delete(chain);
    } catch (error) {
      const now = this.now();
      const fault = { message: errorMessage(error), at: now };
      this.ownFaults.set(chain, fault);
      if (now - this.ownLoggedAt < LOG_THROTTLE_MS) return;
      this.ownLoggedAt = now;
      this.log(`flow collector: own tape: ${fault.message}`);
    }
  }

  private trackOwn(key: string, chain: Chain, address: string, pairs: PairRow[]): void {
    this.withOwnTape(chain, (tape) => {
      tape.track(address, pairs);
      this.ownTracked.add(key);
    });
  }

  private untrackOwn(key: string, chain: Chain, address: string): void {
    if (!this.ownTracked.delete(key)) return;
    this.withOwnTape(chain, (tape) => tape.untrack(address));
  }

  /** Idle subscriptions keep their ledger data but stop costing Gecko budget and own-tape RPC. */
  private reapIdle(now: number): void {
    for (const [key, sub] of this.subs) {
      if (now - sub.lastRequestedAt > IDLE_MS) this.evict(key, sub, now, `idle > ${IDLE_MS / 1000}s`);
    }
  }

  private stopOwn(): void {
    const tapes = [...this.ownTapes.values()];
    this.ownTapes.clear();
    this.ownTracked.clear();
    for (const tape of tapes) {
      try {
        tape.stop();
      } catch (error) {
        this.log(`flow collector: own tape stop: ${errorMessage(error)}`);
      }
    }
  }

  private ownStats(chain: Chain, address: string): OwnHealthStats | null {
    let stats: OwnHealthStats | null = null;
    this.withOwnTape(chain, (tape) => {
      stats = tape.stats(address);
    });
    return stats;
  }

  private ownHealth(sub: Subscription | undefined): OwnSourceHealth {
    const tracked = sub !== undefined && this.ownTracked.has(pairKey(sub.chain, sub.address));
    const tape = sub && tracked ? this.ownStats(sub.chain, sub.address) : null;
    const fault = sub ? this.ownFaults.get(sub.chain) : undefined;
    return {
      lastOkAt: tape?.lastPrintAt ?? null,
      lastError: fault?.message ?? (tape ? tapeError(tape) : null),
      lastErrorAt: fault?.at ?? null,
      tape
    };
  }
}

export const flowCollector = new FlowCollector();
