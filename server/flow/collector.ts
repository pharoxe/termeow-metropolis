import type { Chain, PairRow } from "../../shared/wire.js";
import { errorMessage } from "../lib/http.js";
import { geckoPoolTrades } from "../sources/gecko.js";
import { fetchPumpTradesPage, walkPumpTradesBack, type WalkPumpResult } from "../sources/pumpfun.js";
import { FlowLedger, HOUR_MS, pairKey } from "./ledger.js";

export const COLLECTOR_TICK_MS = 5_000;
export const GECKO_POLL_MS = 15_000;
export const SUBSCRIPTION_TTL_MS = 10 * 60_000;
export const MAX_SUBSCRIPTIONS = 8;
export const BACKFILL_WINDOW_MS = 48 * HOUR_MS;
export const BACKFILL_MAX_PAGES = 60;
export const BACKFILL_PAGE_DELAY_MS = 500;
export const BACKFILL_RETRY_MS = 60_000;
const LOG_THROTTLE_MS = 60_000;
const PUMP_PREFIX = "pumpfun:";

export type SourceName = "pumpfun" | "geckoterminal";
export type SourceHealth = { lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null };
export type BackfillState = {
  pair: string;
  startedAt: number;
  finishedAt: number | null;
  result: WalkPumpResult | null;
  error: string | null;
};
export type CollectorStatus = {
  subscribed: boolean;
  lastRequestedAt: number | null;
  tierAPairs: number;
  sources: Record<SourceName, SourceHealth>;
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
};

type Subscription = {
  chain: Chain;
  address: string;
  pairs: PairRow[];
  lastRequestedAt: number;
  polledAt: Record<string, number>;
  sources: Record<SourceName, SourceHealth>;
  lastLoggedAt: Record<SourceName, number>;
};

function emptyHealth(): SourceHealth {
  return { lastOkAt: null, lastError: null, lastErrorAt: null };
}

function emptySources(): Record<SourceName, SourceHealth> {
  return { pumpfun: emptyHealth(), geckoterminal: emptyHealth() };
}

function newSubscription(chain: Chain, address: string, pairs: PairRow[], now: number): Subscription {
  return { chain, address, pairs, lastRequestedAt: now, polledAt: {}, sources: emptySources(), lastLoggedAt: { pumpfun: 0, geckoterminal: 0 } };
}

function pumpMint(pair: PairRow): string | null {
  return pair.pairAddress.startsWith(PUMP_PREFIX) ? pair.pairAddress.slice(PUMP_PREFIX.length) : null;
}

function tierA(pairs: PairRow[]): PairRow[] {
  return pairs.filter((pair) => pair.tier === "A");
}

/** A backfill runs once per token; a walk that failed is retried BACKFILL_RETRY_MS after it stopped. */
function backfillDue(state: BackfillState | undefined, now: number): boolean {
  if (!state) return true;
  return state.error !== null && state.finishedAt !== null && now - state.finishedAt >= BACKFILL_RETRY_MS;
}

/**
 * Polls trade prints for subscribed tokens into one shared FlowLedger: the pump.fun pseudo-pair every tick,
 * other Tier A pools via GeckoTerminal every GECKO_POLL_MS (low priority). Never throws from a tick.
 */
export class FlowCollector {
  readonly ledger: FlowLedger;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly fetchGecko: typeof geckoPoolTrades;
  private readonly fetchPump: typeof fetchPumpTradesPage;
  private readonly walkPump: typeof walkPumpTradesBack;
  private subs = new Map<string, Subscription>();
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
  }

  /** Marks interest; pairs replace the previous registry snapshot. Starts the tick loop on first call. */
  subscribe(chain: Chain, address: string, pairs: PairRow[]): void {
    const key = pairKey(chain, address);
    const now = this.now();
    const existing = this.subs.get(key);
    if (!existing) this.makeRoom(now);
    this.subs.set(key, existing ? { ...existing, pairs, lastRequestedAt: now } : newSubscription(chain, address, pairs, now));
    this.maybeBackfill(key, chain, pairs, now);
    this.start();
  }

  status(chain: Chain, address: string): CollectorStatus {
    const sub = this.subs.get(pairKey(chain, address));
    return {
      subscribed: sub !== undefined,
      lastRequestedAt: sub?.lastRequestedAt ?? null,
      tierAPairs: sub ? tierA(sub.pairs).length : 0,
      sources: sub?.sources ?? emptySources(),
      backfill: this.backfills.get(pairKey(chain, address)) ?? null,
      launchMs: this.launchMs(chain, address)
    };
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
  }

  /** One polling round over every subscription requested within SUBSCRIPTION_TTL_MS. Safe to call directly. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      await Promise.all(this.active(now).map((sub) => this.pollSubscription(sub, now)));
    } finally {
      this.ticking = false;
    }
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), COLLECTOR_TICK_MS);
    this.timer.unref?.();
  }

  private active(now: number): Subscription[] {
    return [...this.subs.values()].filter((sub) => now - sub.lastRequestedAt <= SUBSCRIPTION_TTL_MS);
  }

  private makeRoom(now: number): void {
    while (this.subs.size >= MAX_SUBSCRIPTIONS) {
      const victim = [...this.subs.entries()].sort((a, b) => a[1].lastRequestedAt - b[1].lastRequestedAt)[0];
      if (!victim) return;
      this.subs.delete(victim[0]);
      this.log(`flow collector: dropping ${victim[0]} (idle ${Math.round((now - victim[1].lastRequestedAt) / 1000)}s, cap ${MAX_SUBSCRIPTIONS})`);
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
    const tasks = tierA(sub.pairs).map((pair) => {
      const mint = pumpMint(pair);
      if (mint !== null) return this.pollPump(key, sub.chain, mint);
      return this.geckoDue(sub, pair.pairAddress, now) ? this.pollGecko(key, sub.chain, pair.pairAddress, now) : Promise.resolve();
    });
    return Promise.all(tasks);
  }

  private geckoDue(sub: Subscription, pair: string, now: number): boolean {
    return now - (sub.polledAt[pair] ?? Number.NEGATIVE_INFINITY) >= GECKO_POLL_MS;
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

  private async pollGecko(key: string, chain: Chain, pair: string, now: number): Promise<void> {
    this.patch(key, (sub) => ({ ...sub, polledAt: { ...sub.polledAt, [pair]: now } }));
    try {
      const prints = await this.fetchGecko(chain, pair, { priority: "low" });
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
}

export const flowCollector = new FlowCollector();
