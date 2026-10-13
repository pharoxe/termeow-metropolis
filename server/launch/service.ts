import type { Chain, LaunchRow } from "../../shared/wire.js";
import { config } from "../config.js";
import { flowCollector } from "../flow/collector.js";
import type { RegistryPool } from "../flow/registry.js";
import { errorMessage } from "../lib/http.js";
import {
  DEXSCREENER_BOOSTS_SOURCE,
  DEXSCREENER_PROFILES_SOURCE,
  fetchLatestBoosts,
  fetchLatestProfiles,
  type TokenProfile
} from "../sources/dexscreenerProfiles.js";
import { fetchTokenBatches, type TokenBatch } from "../sources/dexscreenerTokens.js";
import { BlockTimeCache } from "../tape/monad/blocks.js";
import { MonadLogPoller } from "../tape/monad/poller.js";
import { EvmQuotePrice } from "../tape/monad/price.js";
import { AlertingLaunchIndex } from "../alerts/launchIndex.js";
import { alertSink } from "../alerts/sink.js";
import { withTraderHooks } from "../traders/launchHooks.js";
import { getTraderService } from "../traders/service.js";
import { DEXSCREENER_TOKENS_SOURCE, ERC20_META_SOURCE, erc20MetaUpsert, profileUpsert, tokenBatchUpsert } from "./enrich.js";
import { pickEnrichBatch, pruneAttempts } from "./enrichBatch.js";
import { LaunchIndex, launchKey, type LaunchIndexStats, type LaunchListQuery } from "./index.js";
import { MONAD_LAUNCH_SOURCE, MonadLaunchStream, launchRegistryPool, type MonadLaunchStreamStats } from "./monad/stream.js";

export const REFRESH_INTERVAL_MS = 60_000;
/** Tokens per chain sent to DexScreener tokens/v1 each refresh (two calls of 30), picked by enrichment staleness. */
export const ENRICH_BATCH = 60;
export const ENRICH_WINDOW_MS = 24 * 3_600_000;
/** Unnamed Monad rows sent to erc20Meta per refresh, newest first; two paced eth_calls each on the low lane. */
export const NAME_BATCH = 20;
const LOG_THROTTLE_MS = 60_000;
const CHAINS: Chain[] = ["monad"];

export type LaunchSourceHealth = { name: string; lastOkAt: number | null; lastError: string | null };
export type MonadStreamLike = { start(): void; stop(): void; stats(): MonadLaunchStreamStats };
type Health = { lastOkAt: number | null; lastError: string | null; lastLoggedAt: number };

export type LaunchServiceDeps = {
  index?: LaunchIndex;
  now?: () => number;
  log?: (msg: string) => void;
  /** Factory for the Monad stream; return null to run without it. */
  monad?: (index: LaunchIndex, log: (msg: string) => void) => MonadStreamLike | null;
  fetchProfiles?: () => Promise<TokenProfile[]>;
  fetchBoosts?: () => Promise<TokenProfile[]>;
  fetchTokenBatches?: (chain: Chain, addresses: string[]) => Promise<TokenBatch>;
  /** Symbol lookups for unnamed Monad rows; defaults to the trader service's erc20Meta (cached, paced, low lane). */
  erc20Meta?: Erc20MetaLike;
  refreshMs?: number;
};

export type Erc20MetaLike = { resolve(token: string): Promise<{ symbol: string | null } | null> };

export type LaunchServiceStatus = {
  started: boolean;
  sources: LaunchSourceHealth[];
  index: LaunchIndexStats;
  monad: MonadLaunchStreamStats | null;
};

/** Token behind a curve pseudo-pair: nad.fun names it in the pair ("nadfun:<token>"); per-token-curve pads are looked up on the index. */
function tokenForCurvePair(index: LaunchIndex, pair: string): string | null {
  const colon = pair.indexOf(":");
  if (colon <= 0) return null;
  const pad = pair.slice(0, colon);
  const id = pair.slice(colon + 1).toLowerCase();
  if (pad === "nadfun") return id;
  const row = index.list({ chain: "monad", windowMs: ENRICH_WINDOW_MS }).find((candidate) => candidate.curve?.toLowerCase() === id);
  return row?.token ?? null;
}

/** R3: the launch poller also carries the EntryPoint user-op leg and curve trades are trader-annotated before ingest. */
function liveMonadStream(index: LaunchIndex, log: (msg: string) => void): MonadLaunchStream {
  const rpcUrl = config.monad.rpcUrl;
  const hooked = withTraderHooks({
    poller: new MonadLogPoller({ rpcUrl, log, name: "launch" }),
    ledger: flowCollector.ledger,
    traders: getTraderService(),
    tokenOf: (pair) => tokenForCurvePair(index, pair),
    log
  });
  return new MonadLaunchStream({
    index,
    ledger: hooked.ledger,
    poller: hooked.poller,
    blocks: new BlockTimeCache({ rpcUrl }),
    prices: new EvmQuotePrice({ chain: "monad" }),
    log
  });
}

/**
 * One process-wide launch feed: nad.fun curve logs on Monad, DexScreener profile/boost discovery and 60s enrichment
 * (DexScreener prices, ERC-20 symbols) all writing one LaunchIndex.
 * Started lazily by the first request and kept running; every source failure lands in status() and a throttled log.
 */
export class LaunchService {
  readonly index: LaunchIndex;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly deps: LaunchServiceDeps;
  private readonly health = new Map<string, Health>();
  /** launchKey -> when the token was last sent to DexScreener tokens/v1, priced or not; drives batch rotation. */
  private readonly nameAttemptAt = new Map<string, number>();
  private readonly enrichAttemptAt = new Map<string, number>();
  private monad: MonadStreamLike | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private started = false;

  constructor(deps: LaunchServiceDeps = {}) {
    this.deps = deps;
    this.index = deps.index ?? new AlertingLaunchIndex(alertSink);
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((msg) => console.warn(msg));
  }

  /** Idempotent: opens the chain feeds, runs one refresh now and then every REFRESH_INTERVAL_MS. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.monad = this.guarded("rpc:monad", () => (this.deps.monad ?? liveMonadStream)(this.index, this.log)) ?? null;
    this.monad?.start();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.deps.refreshMs ?? REFRESH_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.monad?.stop();
    this.started = false;
  }

  list(query: LaunchListQuery): LaunchRow[] {
    return this.index.list(query);
  }

  /**
   * Curve-phase pseudo-pair for the flow registry (Monad only); [] when the token has no curve tape or has already
   * graduated (the curve stops trading once the real pool exists, so the pseudo-pair must not hold a Tier A slot).
   */
  curvePairsFor(chain: Chain, address: string): RegistryPool[] {
    if (chain !== "monad") return [];
    const row = this.index.get(chain, address);
    if (!row || row.graduatedAt !== null) return [];
    const pool = launchRegistryPool(row.launchpad, row.token, row.curve);
    return pool ? [pool] : [];
  }

  status(): LaunchServiceStatus {
    return {
      started: this.started,
      sources: this.sources(),
      index: this.index.stats(),
      monad: this.monad?.stats() ?? null
    };
  }

  /** Discovery + enrichment round; safe to call directly, never overlaps itself, never throws. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await Promise.all([this.discover(DEXSCREENER_PROFILES_SOURCE), this.discover(DEXSCREENER_BOOSTS_SOURCE)]);
      await this.enrichPrices();
      await this.enrichNames();
    } finally {
      this.refreshing = false;
    }
  }

  private async discover(source: string): Promise<void> {
    const load = source === DEXSCREENER_BOOSTS_SOURCE ? (this.deps.fetchBoosts ?? fetchLatestBoosts) : (this.deps.fetchProfiles ?? fetchLatestProfiles);
    try {
      for (const profile of await load()) {
        if (profile.chain === null) continue;
        const upsert = profileUpsert(profile, source, this.index.get(profile.chain, profile.address) !== null);
        if (upsert) this.index.upsert(upsert);
      }
      this.ok(source);
    } catch (error) {
      this.fail(source, error);
    }
  }

  private async enrichPrices(): Promise<void> {
    const load = this.deps.fetchTokenBatches ?? fetchTokenBatches;
    try {
      for (const chain of CHAINS) await this.enrichChain(chain, load);
      this.ok(DEXSCREENER_TOKENS_SOURCE);
    } catch (error) {
      this.fail(DEXSCREENER_TOKENS_SOURCE, error);
    }
  }

  /**
   * One chain's batch: never-attempted tokens first (newest first), then the least recently attempted, so a pad that
   * launches faster than ENRICH_BATCH per minute cannot keep older rows from ever being re-priced. Every token sent is
   * stamped as attempted whether or not DexScreener listed it; a throwing fetch stamps nothing so the batch is retried.
   */
  private async enrichChain(chain: Chain, load: NonNullable<LaunchServiceDeps["fetchTokenBatches"]>): Promise<void> {
    const candidates = this.index.tokens(chain, ENRICH_WINDOW_MS);
    pruneAttempts(this.enrichAttemptAt, chain, candidates);
    const tokens = pickEnrichBatch(candidates, (token) => this.enrichAttemptAt.get(launchKey(chain, token)) ?? null, ENRICH_BATCH);
    if (!tokens.length) return;
    const batch = await load(chain, tokens);
    const attemptedAt = this.now();
    for (const token of tokens) {
      this.enrichAttemptAt.set(launchKey(chain, token), attemptedAt);
      const row = batch.get(token.toLowerCase());
      const existing = this.index.get(chain, token);
      if (row && existing) this.index.upsert(tokenBatchUpsert(chain, existing, row, attemptedAt));
    }
  }

  /**
   * Monad rows still without a symbol after every feed (DexScreener profile rows, curve-phase tokens
   * DexScreener does not list) ask the contract itself. erc20Meta caches hits forever and failures for 10 min, so
   * rotate unresolved tokens across rounds; at most NAME_BATCH lookups per round bound the RPC cost.
   */
  private async enrichNames(): Promise<void> {
    const meta = this.deps.erc20Meta ?? getTraderService().erc20Meta;
    const candidates = this.index.list({ chain: "monad", windowMs: ENRICH_WINDOW_MS }).filter((row) => row.symbol === null).map((row) => row.token);
    pruneAttempts(this.nameAttemptAt, "monad", candidates);
    const tokens = pickEnrichBatch(candidates, (token) => this.nameAttemptAt.get(launchKey("monad", token)) ?? null, NAME_BATCH);
    if (!tokens.length) return;
    for (const token of tokens) this.nameAttemptAt.set(launchKey("monad", token), this.now());
    const entries = await Promise.allSettled(tokens.map((token) => meta.resolve(token)));
    entries.forEach((entry, index) => {
      if (entry.status !== "fulfilled") return;
      const upsert = erc20MetaUpsert(tokens[index], entry.value);
      if (upsert) this.index.upsert(upsert);
    });
    const failed = entries.find((entry) => entry.status === "rejected");
    if (entries.some((entry) => entry.status === "fulfilled")) this.ok(ERC20_META_SOURCE);
    if (failed?.status === "rejected") this.fail(ERC20_META_SOURCE, failed.reason);
  }

  private sources(): LaunchSourceHealth[] {
    const polled = [DEXSCREENER_PROFILES_SOURCE, DEXSCREENER_BOOSTS_SOURCE, DEXSCREENER_TOKENS_SOURCE, ERC20_META_SOURCE].map((name) => {
      const health = this.health.get(name);
      return { name, lastOkAt: health?.lastOkAt ?? null, lastError: health?.lastError ?? null };
    });
    const poller = this.monad?.stats().poller;
    return [
      { name: MONAD_LAUNCH_SOURCE, lastOkAt: poller?.lastOkAt ?? null, lastError: this.health.get(MONAD_LAUNCH_SOURCE)?.lastError ?? poller?.lastError ?? null },
      ...polled
    ];
  }

  private guarded<T>(source: string, make: () => T): T | undefined {
    try {
      return make();
    } catch (error) {
      this.fail(source, error);
      return undefined;
    }
  }

  private ok(source: string): void {
    const previous = this.health.get(source);
    this.health.set(source, { lastOkAt: this.now(), lastError: null, lastLoggedAt: previous?.lastLoggedAt ?? 0 });
  }

  /** Records the error; `okAt` lets a source that returned rows with an error (stale last-good) still count a success. */
  private fail(source: string, error: unknown, okAt: number | null = null): void {
    const previous = this.health.get(source);
    const message = errorMessage(error);
    const now = this.now();
    const shouldLog = now - (previous?.lastLoggedAt ?? 0) >= LOG_THROTTLE_MS;
    if (shouldLog) this.log(`launch service: ${source}: ${message}`);
    this.health.set(source, {
      lastOkAt: okAt ?? previous?.lastOkAt ?? null,
      lastError: message,
      lastLoggedAt: shouldLog ? now : (previous?.lastLoggedAt ?? 0)
    });
  }
}

let shared: LaunchService | null = null;
let onCreate: ((service: LaunchService) => void) | null = null;

/** Restart persistence hook (server/persist/live.ts): runs once on the shared service after construction, before start() (at once when it already exists). */
export function setLaunchServiceHook(hook: ((service: LaunchService) => void) | null): void {
  onCreate = hook;
  if (shared && hook) hook(shared);
}

/** Process-wide service, started on first use; routes and the flow registry read from it. */
export function getLaunchService(): LaunchService {
  if (!shared) {
    shared = new LaunchService();
    onCreate?.(shared);
    shared.start();
  }
  return shared;
}
