import type { Chain, FeedHealth, PairRow } from "../../shared/wire.js";
import { errorMessage } from "../lib/http.js";
import { geckoBlockedUntilMs, geckoPoolTrades } from "../sources/gecko.js";
import { createMonadOwnTapeFromConfig, type MonadOwnTapeStats } from "../tape/monad/ownTape.js";
import { feedHealthOf, ownTapeHealthy } from "./feedHealth.js";
import { FlowLedger, pairKey } from "./ledger.js";

export const COLLECTOR_TICK_MS = 5_000;
/** Gecko pool-trade cadence when Gecko is the only tape for a token (the Monad own poller is down or still warming). */
export const GECKO_POLL_MS = 15_000;
/** Cadence on Monad while the own poller is healthy: the own tape is primary there, Gecko only cross-checks. */
export const GECKO_POLL_SLOW_MS = 60_000;
/** A token nobody asked about for this long is evicted (own tape untracked, Gecko polling stopped); its ledger data stays. */
export const IDLE_MS = 90_000;
/** Focused instruments only: the desk shows one, the candles route shares it, and a just-switched-away token may linger. */
export const MAX_SUBSCRIPTIONS = 4;
/** Registry snapshots remembered for evicted tokens so the flow route can still serve their ledger ring when the registry is down. */
export const REMEMBERED_PAIRS_MAX = 64;
const LOG_THROTTLE_MS = 60_000;

export type SourceName = "geckoterminal";
export type SourceHealth = { lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null };
/** Own-tape health: `tape` is null until the token is tracked (or when the tape is broken). */
export type OwnHealthStats = MonadOwnTapeStats;
export type OwnSourceHealth = SourceHealth & { tape: OwnHealthStats | null };
/** The Monad tape resolves its own pool refs from registry rows, so it takes PairRow[] rather than PoolRef[]. */
export type MonadOwnTapeLike = {
  track(address: string, pairs: PairRow[]): void;
  untrack(address: string): void;
  stats(address?: string): MonadOwnTapeStats;
  stop(): void;
};
/** Chain-neutral view of a tape as the collector drives it: registry rows in, chain-shaped stats out. */
type ChainTape = Omit<MonadOwnTapeLike, "stats"> & { stats(address: string): OwnHealthStats };
type OwnFault = { message: string; at: number };
type GeckoMode = "fast" | "slow";
export type CollectorStatus = {
  subscribed: boolean;
  lastRequestedAt: number | null;
  tierAPairs: number;
  sources: Record<SourceName, SourceHealth> & { own: OwnSourceHealth };
  feedHealth: FeedHealth;
  launchMs: number | null;
};

export type CollectorDeps = {
  ledger?: FlowLedger;
  now?: () => number;
  log?: (message: string) => void;
  geckoPoolTrades?: typeof geckoPoolTrades;
  /** Factory for the Monad own tape, invoked lazily on the first monad subscribe; defaults to config.monad.rpcUrl. */
  ownTapeMonad?: (ledger: FlowLedger, log: (message: string) => void) => MonadOwnTapeLike;
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
  return { geckoterminal: emptyHealth() };
}

function newSubscription(chain: Chain, address: string, pairs: PairRow[], now: number): Subscription {
  return { chain, address, pairs, lastRequestedAt: now, polledAt: {}, sources: emptySources(), lastLoggedAt: { geckoterminal: 0 }, geckoMode: "fast" };
}

function tierA(pairs: PairRow[]): PairRow[] {
  return pairs.filter((pair) => pair.tier === "A");
}

function geckoPollMsFor(mode: GeckoMode): number {
  return mode === "slow" ? GECKO_POLL_SLOW_MS : GECKO_POLL_MS;
}

/** First error across the tape's transports. */
function tapeError(tape: OwnHealthStats): string | null {
  return tape.lastError ?? tape.poller.lastError ?? tape.blocks.lastError ?? tape.resolve.lastError ?? tape.price.lastError;
}

/**
 * Polls trade prints for subscribed tokens into one shared FlowLedger: the own Monad log tape is primary, and Tier A
 * pools are cross-checked via GeckoTerminal (background class) every GECKO_POLL_MS, or every GECKO_POLL_SLOW_MS
 * while the own poller is healthy. Tokens idle for IDLE_MS are evicted. Never throws from a tick.
 */
export class FlowCollector {
  readonly ledger: FlowLedger;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly fetchGecko: typeof geckoPoolTrades;
  private readonly makeOwnTapeMonad: (ledger: FlowLedger, log: (message: string) => void) => MonadOwnTapeLike;
  private ownTapes = new Map<Chain, ChainTape>();
  private ownTracked = new Set<string>();
  private ownFaults = new Map<Chain, OwnFault>();
  private ownLoggedAt = 0;
  private subs = new Map<string, Subscription>();
  private rememberedPairs = new Map<string, PairRow[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(deps: CollectorDeps = {}) {
    this.ledger = deps.ledger ?? new FlowLedger();
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((message) => console.warn(message));
    this.fetchGecko = deps.geckoPoolTrades ?? geckoPoolTrades;
    this.makeOwnTapeMonad = deps.ownTapeMonad ?? createMonadOwnTapeFromConfig;
  }

  /** Marks interest; pairs replace the previous registry snapshot. Starts the tick loop on first call. */
  subscribe(chain: Chain, address: string, pairs: PairRow[]): void {
    const key = pairKey(chain, address);
    const now = this.now();
    const existing = this.subs.get(key);
    if (!existing) this.makeRoom(now);
    this.subs.set(key, existing ? { ...existing, pairs, lastRequestedAt: now } : newSubscription(chain, address, pairs, now));
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
      launchMs: this.launchMs(chain, address)
    };
  }

  /** Registry rows last handed to subscribe() for this token, kept after eviction; null when never subscribed. */
  pairsOf(chain: Chain, address: string): PairRow[] | null {
    const key = pairKey(chain, address);
    return this.subs.get(key)?.pairs ?? this.rememberedPairs.get(key) ?? null;
  }

  /** Launch time from a full curve history; the Monad tape does not walk back to launch, so this stays null. */
  launchMs(_chain: Chain, _address: string): number | null {
    return null;
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

  private pollSubscription(sub: Subscription, now: number): Promise<unknown> {
    const key = pairKey(sub.chain, sub.address);
    const pollMs = this.geckoPollMs(key, sub, now);
    // Launchpad curve pseudo-pairs ("nadfun:<token>") exist only on the own tape; Gecko has nothing to poll for them.
    const tasks = tierA(sub.pairs).filter((pair) => !pair.pairAddress.includes(":")).map((pair) =>
      this.geckoDue(sub, pair.pairAddress, now, pollMs) ? this.pollGecko(key, sub, pair.pairAddress, now) : Promise.resolve());
    return Promise.all(tasks);
  }

  /** Slow cadence while the own poller is healthy (own tape primary), fast otherwise. */
  private geckoPollMs(key: string, sub: Subscription, now: number): number {
    const mode: GeckoMode = ownTapeHealthy(this.ownHealth(sub), now) ? "slow" : "fast";
    if (mode !== sub.geckoMode) {
      this.patch(key, (current) => ({ ...current, geckoMode: mode }));
      this.log(`flow collector: gecko cadence ${key}: ${mode} (${geckoPollMsFor(mode) / 1000}s, own tape ${mode === "slow" ? "healthy" : "down"})`);
    }
    return geckoPollMsFor(mode);
  }

  private geckoDue(sub: Subscription, pair: string, now: number, pollMs: number): boolean {
    return now - (sub.polledAt[pair] ?? Number.NEGATIVE_INFINITY) >= pollMs;
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
    const tape = this.makeOwnTapeMonad(this.ledger, this.log);
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
