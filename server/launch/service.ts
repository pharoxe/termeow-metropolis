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
import { TRENCHES_SOURCE, fetchTrenchTokens, type TrenchTokensResult, type TrenchWindow } from "../sources/trenches.js";
import { BlockTimeCache } from "../tape/robinhood/blocks.js";
import { RobinhoodLogPoller } from "../tape/robinhood/poller.js";
import { EvmQuotePrice } from "../tape/robinhood/price.js";
import { AlertingLaunchIndex } from "../alerts/launchIndex.js";
import { alertSink } from "../alerts/sink.js";
import { withTraderHooks } from "../traders/launchHooks.js";
import { getTraderService } from "../traders/service.js";
import { DEXSCREENER_TOKENS_SOURCE, ERC20_META_SOURCE, PUMPPORTAL_SOURCE, erc20MetaUpsert, profileUpsert, solanaLaunchUpsert, tokenBatchUpsert, trenchUpsert } from "./enrich.js";
import { pickEnrichBatch, pruneAttempts } from "./enrichBatch.js";
import { LaunchIndex, launchKey, type LaunchIndexStats, type LaunchListQuery } from "./index.js";
import { ROBINHOOD_LAUNCH_SOURCE, RobinhoodLaunchStream, launchRegistryPool, type RobinhoodLaunchStreamStats } from "./robinhood/stream.js";
import { PumpPortalNewTokens, type PumpPortalStatus, type SolanaLaunch } from "./solana/pumpportal.js";

export const REFRESH_INTERVAL_MS = 60_000;
/** Tokens per chain sent to DexScreener tokens/v1 each refresh (two calls of 30), picked by enrichment staleness. */
export const ENRICH_BATCH = 60;
export const ENRICH_WINDOW_MS = 24 * 3_600_000;
export const TRENCH_WINDOW: TrenchWindow = "24h";
export const TRENCH_LIMIT = 200;
/** R6: unnamed Robinhood rows sent to erc20Meta per refresh, newest first; two paced eth_calls each on the 2 rps low lane (~20 s). */
export const NAME_BATCH = 20;
const LOG_THROTTLE_MS = 60_000;
const CHAINS: Chain[] = ["solana", "robinhood"];

export type LaunchSourceHealth = { name: string; lastOkAt: number | null; lastError: string | null };
export type RobinhoodStreamLike = { start(): void; stop(): void; stats(): RobinhoodLaunchStreamStats };
export type PumpPortalLike = { start(): void; stop(): void; status(): PumpPortalStatus };
type Health = { lastOkAt: number | null; lastError: string | null; lastLoggedAt: number };

export type LaunchServiceDeps = {
  index?: LaunchIndex;
  now?: () => number;
  log?: (msg: string) => void;
  /** Factory for the Robinhood stream; return null to run without it. */
  robinhood?: (index: LaunchIndex, log: (msg: string) => void) => RobinhoodStreamLike | null;
  /** Factory for the PumpPortal client; `onLaunch` must be wired to the returned client. Return null to run without it. */
  pumpportal?: (onLaunch: (launch: SolanaLaunch) => void, log: (msg: string) => void) => PumpPortalLike | null;
  fetchProfiles?: () => Promise<TokenProfile[]>;
  fetchBoosts?: () => Promise<TokenProfile[]>;
  fetchTokenBatches?: (chain: Chain, addresses: string[]) => Promise<TokenBatch>;
  fetchTrenchTokens?: (window: TrenchWindow, limit: number) => Promise<TrenchTokensResult>;
  /** R6: symbol lookups for unnamed Robinhood rows; defaults to the trader service's erc20Meta (cached, paced, low lane). */
  erc20Meta?: Erc20MetaLike;
  refreshMs?: number;
};

export type Erc20MetaLike = { resolve(token: string): Promise<{ symbol: string | null } | null> };

export type LaunchServiceStatus = {
  started: boolean;
  sources: LaunchSourceHealth[];
  index: LaunchIndexStats;
  robinhood: RobinhoodLaunchStreamStats | null;
  pumpportal: PumpPortalStatus | null;
};

/** Token behind a curve pseudo-pair: Flap/Trench name it in the pair, Pons/Bags pairs carry the emitter, looked up on the index. */
function tokenForCurvePair(index: LaunchIndex, pair: string): string | null {
  const colon = pair.indexOf(":");
  if (colon <= 0) return null;
  const pad = pair.slice(0, colon);
  const id = pair.slice(colon + 1).toLowerCase();
  if (pad === "flap" || pad === "trench") return id;
  const row = index.list({ chain: "robinhood", windowMs: ENRICH_WINDOW_MS }).find((candidate) => candidate.curve?.toLowerCase() === id);
  return row?.token ?? null;
}

/** R3: the launch poller also carries the EntryPoint user-op leg and curve trades are trader-annotated before ingest. */
function liveRobinhoodStream(index: LaunchIndex, log: (msg: string) => void): RobinhoodLaunchStream {
  const rpcUrl = config.robinhood.rpcUrl;
  const hooked = withTraderHooks({
    poller: new RobinhoodLogPoller({ rpcUrl, log }),
    ledger: flowCollector.ledger,
    traders: getTraderService(),
    tokenOf: (pair) => tokenForCurvePair(index, pair),
    log
  });
  return new RobinhoodLaunchStream({
    index,
    ledger: hooked.ledger,
    poller: hooked.poller,
    blocks: new BlockTimeCache({ rpcUrl }),
    prices: new EvmQuotePrice({ chain: "robinhood" }),
    log
  });
}

/**
 * One process-wide launch feed: Robinhood launchpad logs, PumpPortal creates, DexScreener profile/boost discovery
 * and 60s enrichment (DexScreener prices, robinhoodtrenches tracked traders) all writing one LaunchIndex.
 * Started lazily by the first request and kept running; every source failure lands in status() and a throttled log.
 */
export class LaunchService {
  readonly index: LaunchIndex;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly deps: LaunchServiceDeps;
  private readonly health = new Map<string, Health>();
  /** launchKey -> when the token was last sent to DexScreener tokens/v1, priced or not; drives batch rotation. */
  private readonly enrichAttemptAt = new Map<string, number>();
  private robinhood: RobinhoodStreamLike | null = null;
  private pumpportal: PumpPortalLike | null = null;
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
    this.robinhood = this.guarded("rpc:robinhood", () => (this.deps.robinhood ?? liveRobinhoodStream)(this.index, this.log)) ?? null;
    this.robinhood?.start();
    const makePump = this.deps.pumpportal ?? ((onLaunch, log) => new PumpPortalNewTokens({ onLaunch, log }));
    this.pumpportal = this.guarded(PUMPPORTAL_SOURCE, () => makePump((launch) => this.onSolanaLaunch(launch), this.log)) ?? null;
    this.pumpportal?.start();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.deps.refreshMs ?? REFRESH_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.robinhood?.stop();
    this.pumpportal?.stop();
    this.started = false;
  }

  list(query: LaunchListQuery): LaunchRow[] {
    return this.index.list(query);
  }

  /**
   * Curve-phase pseudo-pair for the flow registry (Robinhood only); [] when the token has no curve tape or has already
   * graduated (the curve stops trading once the real pool exists, so the pseudo-pair must not hold a Tier A slot).
   */
  curvePairsFor(chain: Chain, address: string): RegistryPool[] {
    if (chain !== "robinhood") return [];
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
      robinhood: this.robinhood?.stats() ?? null,
      pumpportal: this.pumpportal?.status() ?? null
    };
  }

  /** Discovery + enrichment round; safe to call directly, never overlaps itself, never throws. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await Promise.all([this.discover(DEXSCREENER_PROFILES_SOURCE), this.discover(DEXSCREENER_BOOSTS_SOURCE), this.enrichTrenches()]);
      await this.enrichPrices();
      await this.enrichNames();
    } finally {
      this.refreshing = false;
    }
  }

  private onSolanaLaunch(launch: SolanaLaunch): void {
    try {
      this.index.upsert(solanaLaunchUpsert(launch));
      this.ok(PUMPPORTAL_SOURCE);
    } catch (error) {
      this.fail(PUMPPORTAL_SOURCE, error);
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
   * R6: Robinhood rows still without a symbol after every feed (Pons events, DexScreener profile rows, curve-phase tokens
   * DexScreener does not list) ask the contract itself. erc20Meta caches hits forever and failures for 10 min, so
   * re-asking the same tokens each round is free; at most NAME_BATCH newest rows per round bound the RPC cost.
   */
  private async enrichNames(): Promise<void> {
    const meta = this.deps.erc20Meta ?? getTraderService().erc20Meta;
    const unnamed = this.index.list({ chain: "robinhood", windowMs: ENRICH_WINDOW_MS }).filter((row) => row.symbol === null).slice(0, NAME_BATCH);
    if (!unnamed.length) return;
    try {
      const entries = await Promise.all(unnamed.map((row) => meta.resolve(row.token)));
      unnamed.forEach((row, index) => {
        const upsert = erc20MetaUpsert(row.token, entries[index]);
        if (upsert) this.index.upsert(upsert);
      });
      this.ok(ERC20_META_SOURCE);
    } catch (error) {
      this.fail(ERC20_META_SOURCE, error);
    }
  }

  private async enrichTrenches(): Promise<void> {
    const load = this.deps.fetchTrenchTokens ?? fetchTrenchTokens;
    try {
      const result = await load(TRENCH_WINDOW, TRENCH_LIMIT);
      const observedAt = this.now();
      for (const row of result.rows) this.index.upsert(trenchUpsert(row, this.index.get("robinhood", row.address), observedAt));
      if (result.error) this.fail(TRENCHES_SOURCE, new Error(result.error), result.stale ? null : this.now());
      else this.ok(TRENCHES_SOURCE);
    } catch (error) {
      this.fail(TRENCHES_SOURCE, error);
    }
  }

  private sources(): LaunchSourceHealth[] {
    const polled = [DEXSCREENER_PROFILES_SOURCE, DEXSCREENER_BOOSTS_SOURCE, DEXSCREENER_TOKENS_SOURCE, TRENCHES_SOURCE, ERC20_META_SOURCE].map((name) => {
      const health = this.health.get(name);
      return { name, lastOkAt: health?.lastOkAt ?? null, lastError: health?.lastError ?? null };
    });
    const poller = this.robinhood?.stats().poller;
    const pump = this.pumpportal?.status();
    return [
      { name: ROBINHOOD_LAUNCH_SOURCE, lastOkAt: poller?.lastOkAt ?? null, lastError: this.health.get(ROBINHOOD_LAUNCH_SOURCE)?.lastError ?? poller?.lastError ?? null },
      { name: PUMPPORTAL_SOURCE, lastOkAt: pump?.lastFrameAt ?? null, lastError: this.health.get(PUMPPORTAL_SOURCE)?.lastError ?? pump?.lastError ?? null },
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
