import type { Chain, FlowPrint, SmartCoverage, SmartFill, TraderKind, TraderRef } from "../../shared/wire.js";
import { MONAD_MAINNET } from "../../shared/chains.js";
import { config } from "../config.js";
import { FlowLedger, type LedgerStats } from "../flow/ledger.js";
import type { StreamPollerLike } from "../launch/monad/stream.js";
import { errorMessage } from "../lib/http.js";
import { POOL_MANAGER } from "../tape/monad/pools.js";
import { isAddress } from "../tape/monad/rpc.js";
import { ZERO_ADDRESS, traderFromReceipt, type ReceiptLike } from "./attribute.js";
import { TraderBook, type BookSize, type RecordResult, type TraderFill, type TraderTapeRow } from "./book.js";
import { Erc20Meta, type Erc20MetaStats } from "./erc20Meta.js";
import { HandleBook, type HandleBookStats, type HandleDirectoryEntry, type HandleEntry } from "./handles.js";
import { SmartWalletClassifier } from "./identity.js";
import { LruMap } from "./lru.js";
import { ReceiptFetcher } from "./receipts.js";
import type { TransferFeedStats } from "./transferFeed.js";
import { alertSink } from "../alerts/sink.js";
import { buildCoverage } from "./coverage.js";
import { orderWatchList } from "./watchOrder.js";

/**
 * Receipt + eth_getCode lookups past this pass the batch through unannotated (the general ledger never waits); a lookup
 * that settles later still records its fill in the book and the SMART ledger (see recordLate) and counts as `late`.
 */
export const ANNOTATE_DEADLINE_MS = 2_000;
/**
 * New user-op senders classified per minute; the rest are dropped and counted. Classification is a local book lookup
 * on Monad (no RPC), so the cap only bounds bookkeeping under a burst of account-abstraction traffic.
 */
export const DISCOVER_CAP_PER_MINUTE = 60;
/** Lookups queued on the classification lane past which discovery drops its batch and per-print lookups of unknown wallets are deferred. */
export const DISCOVER_MAX_PENDING = 20;
/** Smart-money wallets remembered; the least recently seen are forgotten past this. */
export const DEFAULT_POPULATION_MAX = 20_000;
/** ERC-4337 EntryPoint v0.7 (canonical CREATE2 address, deployed on Monad): its UserOperationEvent names smart-account traders. */
export const ENTRY_POINT = "0x0000000071727de22e5e9d8baf0edac6f37da032";
/** ERC-4337 EntryPoint v0.6, still used by older smart accounts. */
export const ENTRY_POINT_V06 = "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789";
/** tx.to addresses that are routers / relays, never a trader: EntryPoints, Multicall3, Kuru Flow, nad.fun routers. */
export const KNOWN_RELAYS: readonly string[] = [
  ENTRY_POINT,
  ENTRY_POINT_V06,
  MONAD_MAINNET.multicall3,
  ...[MONAD_MAINNET.kuru.flowEntrypoint, MONAD_MAINNET.kuru.flowRouter, MONAD_MAINNET.kuru.router, MONAD_MAINNET.uniswap.universalRouter].filter((address): address is string => Boolean(address)),
  ...(MONAD_MAINNET.nadfun ? [MONAD_MAINNET.nadfun.curveRouter, MONAD_MAINNET.nadfun.dexRouter] : [])
];
/** Every count this service exposes is "seen by this server", never "all smart money on Monad". */
export const SMART_POPULATION_LABEL = "smart-money wallets seen by this server";
/** Seeded wallets come from Nansen's smart-money DEX trades or the user's watchlist and are watched by the transfer legs at once. */
export const SEEDED_POPULATION_LABEL = "wallets seeded from Nansen smart money on Monad and your watchlist";
export const SEED_PROVENANCE_NANSEN = "nansen";
export const SEED_PROVENANCE_WATCHLIST = "watchlist";
/** Seeded wallets are classified a few at a time so a large Nansen refresh never stalls per-print attribution. */
export const SEED_DRAIN_MS = 10_000;
export const SEED_DRAIN_BATCH = 5;
export const SEED_MAX_ATTEMPTS = 3;
/** Kinds the SMART tape/board/flow block show: verified SMART plus seeded-awaiting-check (tagged, never as SMART). "other" and null never. */
export const TAPE_KINDS: readonly TraderKind[] = ["smart", "seeded"];
const SEEDED_MAX = 5_000;
const SMART_LEDGER_PAIRS = 256;
const DISCOVERED_MAX = 20_000;
const PAIR_META_MAX = 4_096;
const MINUTE_MS = 60_000;

/**
 * What attribution needs beyond the print: the traded token, the pair's dex label, the decoded Swap token amount
 * (disambiguates bundled multi-trader txs) and, for logs that already name the wallet (launchpad curve trades),
 * `trader`: a string skips the receipt path, null means "known to be unattributable", undefined means "read the receipt".
 */
export type PrintMeta = { token: string; dex: string; amount?: bigint; trader?: string | null };
export type MetaOf = (print: FlowPrint) => PrintMeta | null;
export type AnnotateContext = { pools?: Iterable<string>; routers?: Iterable<string>; meta: MetaOf };
export type RecordOptions = { includeOther?: boolean };
export type RecordCounts = { smart: number; other: number };
export type DiscoverResult = { checked: number; dropped: number; smart: number };

export type ClassifierLike = {
  classify(address: string, opts?: { priority?: "high" | "low" }): Promise<TraderKind | null>;
  peek(address: string): TraderKind | undefined;
  stats(): unknown;
};
export type ReceiptsLike = { get(tx: string): Promise<(ReceiptLike & { to?: string | null }) | null>; stats(): unknown };
export type HandlesLike = {
  get(address: string): HandleEntry | null;
  stats(): HandleBookStats;
  /** Restart persistence (HandleBook implements both; test doubles may omit them). */
  learned?(): [string, HandleEntry][];
  restoreLearned?(entries: [string, HandleEntry][]): number;
  refresh?(force?: boolean): Promise<void>;
  directory?(limit?: number): HandleDirectoryEntry[];
  /** Watchlist wallets (armed monitor_wallet automations) tracked like smart money. */
  watch?(addresses: string[]): number;
};
/** The R4 transfer feed as the service sees it: attached by launchHooks, read for status. */
export type TransferFeedHandle = { wrapPoller(poller: StreamPollerLike): StreamPollerLike; stats(): TransferFeedStats };

export type TraderServiceOptions = {
  rpcUrl?: string;
  classifier?: ClassifierLike;
  receipts?: ReceiptsLike;
  handles?: HandlesLike;
  book?: TraderBook;
  smartLedger?: FlowLedger;
  erc20Meta?: Erc20Meta;
  now?: () => number;
  deadlineMs?: number;
  discoverCap?: number;
  populationMax?: number;
  log?: (msg: string) => void;
};

export type TraderServiceCounters = {
  annotated: number;
  smart: number;
  other: number;
  noMeta: number;
  noReceipt: number;
  unattributed: number;
  /** Bundled txs where several traders' legs tied and no amount hint separated them. */
  ambiguous: number;
  deadlined: number;
  /** Deadlined prints whose lookup settled afterwards and reached the book / SMART ledger through recordLate. */
  late: number;
  classifyFailed: number;
  /** Prints whose unknown wallet was not looked up because the classification lane was already at DISCOVER_MAX_PENDING. */
  classifyDeferred: number;
  discoverChecked: number;
  discoverDropped: number;
  /** Seeded wallets whose smart-money check ran / passed / gave up after SEED_MAX_ATTEMPTS. */
  seedChecked: number;
  seedSmart: number;
  seedFailed: number;
  /** Earlier book fills of a seeded wallet the SMART ledger accepted when its check passed (ledger duplicates not counted). */
  seedReingested: number;
  /** R4 transfer fills accepted by the book; `transferUnproven` were recorded with kind "seeded" (check pending) and kept out of the SMART ledger. */
  transferFills: number;
  transferUnproven: number;
};

/** classified = passed the smart-money check here (populationLabel); seeded = on the Nansen list, watched by the transfer legs, check pending or passed. */
export type PopulationStatus = {
  classified: number;
  seeded: number;
  seedQueue: number;
  seededLabel: typeof SEEDED_POPULATION_LABEL;
};

export type TraderServiceStatus = {
  population: PopulationStatus;
  populationLabel: typeof SMART_POPULATION_LABEL;
  handles: HandleBookStats;
  classifier: unknown;
  receipts: unknown;
  book: BookSize;
  smartLedger: LedgerStats;
  counters: TraderServiceCounters;
  /** Null until launchHooks attaches the transfer feed (the launch service has not started). */
  transfers: TransferFeedStats | null;
  erc20Meta: Erc20MetaStats;
  lastError: string | null;
};

type PairMeta = { token: string; dex: string };
export type SeedEntry = { address: string; provenance: string; at: number; attempts: number };

/** Restart persistence (server/persist): verified population, seeded list and learned handles, each oldest first. */
export type TraderServiceSnapshot = { population: string[]; seeded: SeedEntry[]; handlesLearned: [string, HandleEntry][] };
export type TraderServiceRestoreCounts = { population: number; seeded: number; seedQueue: number; handlesLearned: number };

function emptyCounters(): TraderServiceCounters {
  return { annotated: 0, smart: 0, other: 0, noMeta: 0, noReceipt: 0, unattributed: 0, ambiguous: 0, deadlined: 0, late: 0, classifyFailed: 0, classifyDeferred: 0, discoverChecked: 0, discoverDropped: 0, seedChecked: 0, seedSmart: 0, seedFailed: 0, seedReingested: 0, transferFills: 0, transferUnproven: 0 };
}

function pairMetaKey(chain: Chain, pair: string): string {
  return `${chain}:${pair}`;
}

/** Monad addresses are lowercased for every key; kept for symmetry with earlier multi-chain builds. */
function normalizeAddress(chain: Chain, address: string): string {
  return chain === "monad" ? address.toLowerCase() : address;
}

/** Dex from a launchpad pseudo-pair ("pons:0x..." -> "pons"); empty when the pair is a plain pool address. */
export function dexFromPair(pair: string): string {
  const colon = pair.indexOf(":");
  return colon > 0 ? pair.slice(0, colon) : "";
}

/** Resolves to true when `work` settles first, false when the deadline fires first; the timer never keeps the process alive. */
function raceDeadline(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    const settle = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    work.then(settle, settle);
  });
}

function toTraderFill(print: FlowPrint, trader: TraderRef, token: string): TraderFill {
  return {
    ...print,
    trader: trader.address,
    token: normalizeAddress(print.chain, token),
    handle: trader.handle,
    followers: trader.followers,
    kind: trader.kind
  };
}

/** Wire fill from a book tape row; `kind` falls back to "other" only for rows the book never classified (kind-filtered tapes never hit it). */
export function toSmartFill(row: TraderTapeRow, dex: string, followers: number | null, symbol?: string | null): SmartFill {
  return {
    chain: row.chain,
    token: row.token,
    pair: row.pair,
    dex,
    tx: row.tx,
    time: row.time,
    side: row.side,
    usd: row.usd,
    trader: { address: row.trader, kind: row.kind ?? "other", handle: row.handle, followers },
    ...(symbol === undefined ? {} : { symbol }),
    ...(typeof row.price === "number" ? { price: row.price } : {}),
    ...(typeof row.quantity === "number" ? { quantity: row.quantity } : {}),
    ...(row.usdVia ? { usdVia: row.usdVia } : {})
  };
}

/** A recorded fill as a FlowPrint for the SMART ledger; only called for wallets whose smart-money check passed (the fill's own stale kind is ignored). */
export function toSmartPrint(fill: TraderFill): FlowPrint {
  const { trader, token: _token, handle, followers, kind: _kind, usdVia: _usdVia, ...print } = fill;
  return { ...print, trader: { address: trader, kind: "smart", handle: handle ?? null, followers: followers ?? null } };
}

/**
 * Process-wide trader identity: receipt -> wallet -> smart-money label check -> Nansen label, plus the
 * SMART-only ledger (so flowWindows works unchanged) and the per-wallet book. Monad-only by construction
 * (eth_getCode); a Solana print is passed through untouched. Nothing here throws to a caller.
 */
export class TraderService {
  readonly classifier: ClassifierLike;
  readonly receipts: ReceiptsLike;
  readonly handles: HandlesLike;
  readonly book: TraderBook;
  readonly smartLedger: FlowLedger;
  /** Lowercase wallets that passed the smart-money check on this server (LRU-bounded); the value is the address itself. */
  readonly population: LruMap<string, string>;
  /** Wallets taken from a trusted list (robinhoodtrenches traders) ahead of their own smart-money check; watched by the transfer legs. */
  readonly seeded = new LruMap<string, SeedEntry>(SEEDED_MAX);
  readonly erc20Meta: Erc20Meta;
  /** The R4 transfer feed once launchHooks attached it. */
  transfers: TransferFeedHandle | null = null;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private readonly discoverCap: number;
  private readonly log: (msg: string) => void;
  private readonly discovered = new LruMap<string, true>(DISCOVERED_MAX);
  private readonly pairMeta = new LruMap<string, PairMeta>(PAIR_META_MAX);
  private budget = { minute: -1, used: 0 };
  private counters = emptyCounters();
  private lastError: string | null = null;
  /** Bumped whenever transferWallets() would answer differently; the feed rebuilds its legs on change. */
  private version = 0;
  private seedQueue: string[] = [];
  private seedTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a drain batch is classifying, so a seed() arriving mid-drain cannot start a second concurrent batch. */
  private seedDraining = false;

  constructor(opts: TraderServiceOptions = {}) {
    const rpcUrl = opts.rpcUrl ?? config.monad.rpcUrl;
    this.receipts = opts.receipts ?? new ReceiptFetcher({ rpcUrl, now: opts.now });
    const handles = opts.handles ?? new HandleBook({ now: opts.now, onTraders: (wallets) => void this.seed(wallets, SEED_PROVENANCE_NANSEN) });
    this.handles = handles;
    this.classifier = opts.classifier ?? new SmartWalletClassifier({ isTracked: (address) => handles.get(address) !== null });
    this.book = opts.book ?? new TraderBook({ now: opts.now });
    this.smartLedger = opts.smartLedger ?? new FlowLedger({ maxPairs: SMART_LEDGER_PAIRS, now: opts.now });
    this.erc20Meta = opts.erc20Meta ?? new Erc20Meta({ rpcUrl, now: opts.now });
    this.population = new LruMap(opts.populationMax ?? DEFAULT_POPULATION_MAX);
    this.now = opts.now ?? (() => Date.now());
    this.deadlineMs = opts.deadlineMs ?? ANNOTATE_DEADLINE_MS;
    this.discoverCap = opts.discoverCap ?? DISCOVER_CAP_PER_MINUTE;
    this.log = opts.log ?? ((msg) => console.warn(msg));
  }

  /**
   * Returns the same prints (same order) with `trader` set where the wallet resolved before the deadline. Only
   * Monad prints without a trader are looked at; lookups still running at the deadline pass through unannotated
   * here, and whatever they resolve afterwards is recorded by recordLate (the caller's record() only sees the early ones).
   */
  async annotate(prints: FlowPrint[], ctx: AnnotateContext): Promise<FlowPrint[]> {
    const pending = prints.filter((print) => print.chain === "monad" && print.trader === undefined);
    if (pending.length === 0) return prints;
    const exclude = this.excludes(ctx);
    const resolved = new Map<FlowPrint, TraderRef>();
    const work = Promise.all(
      pending.map((print) =>
        this.resolve(print, ctx.meta, exclude)
          .then((ref) => {
            if (ref) resolved.set(print, ref);
          })
          .catch((error) => this.fail(`annotate ${print.tx}: ${errorMessage(error)}`))
      )
    );
    const finished = await raceDeadline(work, this.deadlineMs);
    if (!finished) {
      this.counters.deadlined += pending.length - resolved.size;
      this.recordLate(work, resolved, new Set(resolved.keys()), ctx.meta);
    }
    this.counters.annotated += resolved.size;
    return prints.map((print) => {
      const trader = resolved.get(print);
      return trader ? { ...print, trader } : print;
    });
  }

  /** SMART fills go to the SMART ledger and the book; "other" fills reach the book only when `includeOther` is set. */
  record(prints: FlowPrint[], meta: MetaOf, opts: RecordOptions = {}): RecordCounts {
    const smart: FlowPrint[] = [];
    let other = 0;
    for (const print of prints) {
      const trader = print.trader;
      const info = trader ? meta(print) : null;
      if (!trader || !info) continue;
      this.pairMeta.set(pairMetaKey(print.chain, print.pair), { token: normalizeAddress(print.chain, info.token), dex: info.dex });
      if (trader.kind === "smart") {
        smart.push(print);
        const fill = toTraderFill(print, trader, info.token);
        if (this.book.record(fill) === "accepted") alertSink.fill(fill);
      } else if (opts.includeOther) {
        other += 1;
        this.book.record(toTraderFill(print, trader, info.token));
      }
    }
    if (smart.length) this.smartLedger.ingest(smart);
    this.counters.smart += smart.length;
    this.counters.other += other;
    return { smart: smart.length, other };
  }

  /** Classifies user-op senders never seen before, at most `discoverCap` new ones per minute; SMART ones join the population. */
  async discover(senders: string[]): Promise<DiscoverResult> {
    const fresh = [...new Set(senders.map((sender) => sender.trim().toLowerCase()))].filter((sender) => isAddress(sender) && !this.discovered.has(sender));
    const allowed = this.lanePending() >= DISCOVER_MAX_PENDING ? 0 : this.takeBudget(fresh.length);
    const checked = fresh.slice(0, allowed);
    const dropped = fresh.length - allowed;
    for (const address of checked) this.discovered.set(address, true);
    this.counters.discoverChecked += checked.length;
    this.counters.discoverDropped += dropped;
    let smart = 0;
    await Promise.all(
      checked.map(async (address) => {
        const kind = await this.classifier.classify(address, { priority: "low" }).catch(() => null);
        if (kind === "smart") {
          this.admit(address);
          smart += 1;
        } else if (kind === null) {
          this.discovered.delete(address);
        }
      })
    );
    return { checked: checked.length, dropped, smart };
  }

  /** Dex label remembered for a recorded pair, else derived from a launchpad pseudo-pair prefix, else "". */
  dexOf(chain: Chain, pair: string): string {
    return this.pairMeta.get(pairMetaKey(chain, pair))?.dex ?? dexFromPair(pair);
  }

  status(): TraderServiceStatus {
    return {
      population: { classified: this.population.size, seeded: this.seeded.size, seedQueue: this.seedQueue.length, seededLabel: SEEDED_POPULATION_LABEL },
      populationLabel: SMART_POPULATION_LABEL,
      handles: this.handles.stats(),
      classifier: this.classifier.stats(),
      receipts: this.receipts.stats(),
      book: this.book.size(),
      smartLedger: this.smartLedger.stats(),
      counters: { ...this.counters },
      transfers: this.transfers?.stats() ?? null,
      erc20Meta: this.erc20Meta.stats(),
      lastError: this.lastError
    };
  }

  /**
   * R4 seeding: wallets from a trusted list join the transfer-leg population at once (provenance kept) and are queued
   * for a low-priority smart-money check; only a passed check makes them SMART. Returns how many were new.
   */
  seed(wallets: string[], provenance: string): number {
    let added = 0;
    for (const raw of wallets) {
      const address = raw.trim().toLowerCase();
      if (!isAddress(address) || this.seeded.has(address)) continue;
      this.seeded.set(address, { address, provenance, at: this.now(), attempts: 0 });
      added += 1;
      if (this.classifier.peek(address) === undefined) this.seedQueue = [...this.seedQueue, address];
    }
    if (added > 0) {
      this.version += 1;
      this.scheduleSeedDrain();
    }
    return added;
  }

  /** Wallets the user armed an automation on: labelled "watched", seeded into the transfer legs, classified as tracked. */
  watchWallets(wallets: string[]): number {
    const seeded = this.seed(wallets, SEED_PROVENANCE_WATCHLIST);
    this.handles.watch?.(wallets);
    return seeded;
  }

  /**
   * Wallets the transfer legs should watch, in watch order: classified SMART plus seeded ones not yet
   * proven "other"; seeded/named first, then most recent fill in the book, then most recently verified. The legs cap
   * the list (TRANSFER_WATCH_CAP) from the front, so the order decides who is overflow.
   */
  transferWallets(): string[] {
    const verified = [...this.population.values()].reverse();
    const verifiedRank = new Map(verified.map((wallet, index) => [wallet, index]));
    const seeded = [...this.seeded.values()].filter((entry) => this.classifier.peek(entry.address) !== "other").map((entry) => entry.address);
    return orderWatchList([...verified, ...seeded], {
      priority: (wallet) => this.seeded.has(wallet) || this.handles.get(wallet) !== null,
      lastFillAt: (wallet) => this.book.stats("monad", wallet)?.lastSeenAt ?? null,
      verifiedRank: (wallet) => verifiedRank.get(wallet) ?? null
    });
  }

  /**
   * Wallets the transfer legs must not drop when the SMART classifier outgrows the watch budget: seeded handles,
   * named wallets, and any wallet already in the book. Anonymous never-filled SMART stay behind them and do not
   * count as overflow.
   */
  watchPriority(wallet: string): boolean {
    const key = wallet.toLowerCase();
    if (this.seeded.has(key)) return true;
    if (this.handles.get(key) !== null) return true;
    return this.book.stats("monad", key)?.lastSeenAt != null;
  }

  /** R5 coverage every SMART route carries: legs' watched count against transferWallets(), seeded-pending named apart, plus the named handles. */
  coverage(): SmartCoverage {
    const wallets = this.transferWallets();
    const seeded = wallets.filter((wallet) => !this.population.has(wallet)).length;
    return buildCoverage({ watched: this.transfers?.stats().wallets ?? 0, population: wallets.length, seeded, named: this.handles.stats().entries });
  }

  populationVersion(): number {
    return this.version;
  }

  snapshot(): TraderServiceSnapshot {
    return { population: [...this.population.values()], seeded: [...this.seeded.values()].map((entry) => ({ ...entry })), handlesLearned: this.handles.learned?.() ?? [] };
  }

  /**
   * Restart persistence: population and seeded entries come back as they were (wallets already known here win); seeded
   * wallets without a classifier answer re-queue for their smart-money check exactly as a fresh seed() would. The version bumps
   * once so the transfer feed rebuilds its legs. No RPC, no fills, no alerts.
   */
  restore(snapshot: TraderServiceSnapshot): TraderServiceRestoreCounts {
    const counts = { population: 0, seeded: 0, seedQueue: 0, handlesLearned: 0 };
    for (const raw of snapshot.population) {
      const address = raw.trim().toLowerCase();
      if (!isAddress(address) || this.population.has(address)) continue;
      this.population.set(address, address);
      counts.population += 1;
    }
    for (const entry of snapshot.seeded) {
      const address = entry.address.trim().toLowerCase();
      if (!isAddress(address) || this.seeded.has(address)) continue;
      this.seeded.set(address, { ...entry, address });
      counts.seeded += 1;
      if (this.classifier.peek(address) === undefined) {
        this.seedQueue = [...this.seedQueue, address];
        counts.seedQueue += 1;
      }
    }
    counts.handlesLearned = this.handles.restoreLearned?.(snapshot.handlesLearned) ?? 0;
    if (counts.population + counts.seeded > 0) this.version += 1;
    if (counts.seedQueue > 0) this.scheduleSeedDrain();
    return counts;
  }

  /**
   * Kind for the wallet without any RPC: the classifier's answer when it has one, "smart" for a population member whose
   * classifier entry was evicted (never downgraded), "seeded" for a listed wallet still awaiting its check, null otherwise.
   */
  peekKind(wallet: string): TraderKind | null {
    const key = wallet.toLowerCase();
    const known = this.classifier.peek(key);
    if (known) return known;
    if (this.population.has(key)) return "smart";
    return this.seeded.has(key) ? "seeded" : null;
  }

  attachTransfers<T extends TransferFeedHandle>(feed: T): T {
    this.transfers = feed;
    return feed;
  }

  /**
   * R4 transfer fills (pair "smart:<token>", dex ""): every accepted fill enters the book; only fills of a wallet whose
   * smart-money check passed reach the SMART ledger, the rest are counted as transferUnproven. The book's tx+trader+token+side
   * key also rejects a fill R3 already attributed from a tracked pool. Each fill is recorded with the wallet's kind as
   * of now (the feed snapshots peekKind early in a batch; the seed drain may verify the wallet before the batch lands).
   */
  recordTransferFills(fills: TraderFill[]): RecordResult {
    const result = { accepted: 0, duplicates: 0, rejected: 0 };
    const smart: FlowPrint[] = [];
    for (const snapshot of fills) {
      const fill = snapshot.kind === "smart" ? snapshot : { ...snapshot, kind: this.peekKind(snapshot.trader) ?? snapshot.kind };
      const outcome = this.book.record(fill);
      if (outcome === "duplicate") result.duplicates += 1;
      else if (outcome === "rejected") result.rejected += 1;
      if (outcome !== "accepted") continue;
      result.accepted += 1;
      this.pairMeta.set(pairMetaKey(fill.chain, fill.pair), { token: fill.token, dex: "" });
      if (fill.kind === "smart") smart.push(toSmartPrint(fill));
      else this.counters.transferUnproven += 1;
      alertSink.fill(fill);
    }
    if (smart.length) this.smartLedger.ingest(smart);
    this.counters.transferFills += result.accepted;
    return result;
  }

  /** Newest SMART-kind fills of one token across every pair (pools and "smart:<token>"), with erc20Meta symbol and known handles. */
  fillsForToken(chain: Chain, token: string, limit: number): SmartFill[] {
    const key = normalizeAddress(chain, token);
    return this.book.tape(chain, limit, { kind: TAPE_KINDS, token: key }).map((row) => {
      const entry = this.handles.get(row.trader);
      const symbol = chain === "monad" ? (this.erc20Meta.get(row.token)?.symbol ?? null) : null;
      return toSmartFill({ ...row, handle: row.handle ?? entry?.handle ?? null }, this.dexOf(row.chain, row.pair), entry?.followers ?? null, symbol);
    });
  }

  /** First admission of a seeded wallet (from any lane: seed drain, discover, per-print kindOf) also promotes its book rows and earlier fills. */
  private admit(address: string): void {
    const fresh = !this.population.has(address);
    this.population.set(address, address);
    if (!fresh) return;
    this.version += 1;
    if (this.seeded.has(address)) this.promoteSeeded(address);
  }

  /** A seeded wallet whose check passed: its book rows are relabelled and its earlier ring fills enter the SMART ledger (once: the ledger dedupes per pair by tx, the book never re-records). */
  private promoteSeeded(address: string): void {
    this.book.classify("monad", address, "smart");
    const earlier = this.book.fillsOf("monad", address);
    if (earlier.length) this.counters.seedReingested += this.smartLedger.ingest(earlier.map(toSmartPrint)).accepted;
  }

  private scheduleSeedDrain(): void {
    if (this.seedTimer || this.seedDraining || this.seedQueue.length === 0) return;
    this.seedTimer = setTimeout(() => {
      this.seedTimer = null;
      void this.drainSeeds();
    }, SEED_DRAIN_MS);
    this.seedTimer.unref?.();
  }

  private async drainSeeds(): Promise<void> {
    const batch = this.seedQueue.slice(0, SEED_DRAIN_BATCH);
    this.seedQueue = this.seedQueue.slice(SEED_DRAIN_BATCH);
    this.seedDraining = true;
    try {
      await Promise.all(batch.map((address) => this.classifySeed(address)));
    } finally {
      this.seedDraining = false;
    }
    this.scheduleSeedDrain();
  }

  /** One seeded wallet through the low lane: SMART joins the population (admit() relabels and re-ingests), "other" relabels the rows and leaves the legs; a failure retries. */
  private async classifySeed(address: string): Promise<void> {
    const entry = this.seeded.get(address);
    if (!entry) return;
    const kind = await this.classifier.classify(address, { priority: "low" }).catch(() => null);
    this.counters.seedChecked += 1;
    if (kind === "smart") {
      this.counters.seedSmart += 1;
      this.admit(address);
      return;
    }
    if (kind === "other") {
      this.book.classify("monad", address, "other");
      this.version += 1;
      return;
    }
    const attempts = entry.attempts + 1;
    this.seeded.set(address, { ...entry, attempts });
    if (attempts < SEED_MAX_ATTEMPTS) this.seedQueue = [...this.seedQueue, address];
    else this.counters.seedFailed += 1;
  }

  /**
   * Keeps the deadlined lookups alive: once `work` settles, every wallet resolved after the deadline is fed through
   * record() so the fill reaches the book and the SMART ledger. Both dedupe (book fillKey, ledger chain+tx+pair), so
   * a caller that also records the same print is harmless; the FlowPrint already in the general ledger stays unannotated.
   */
  private recordLate(work: Promise<unknown>, resolved: Map<FlowPrint, TraderRef>, early: Set<FlowPrint>, meta: MetaOf): void {
    void work
      .then(() => {
        const late = [...resolved].filter(([print]) => !early.has(print)).map(([print, trader]) => ({ ...print, trader }));
        if (late.length === 0) return;
        this.counters.late += late.length;
        this.record(late, meta);
      })
      .catch((error) => this.fail(`late record: ${errorMessage(error)}`));
  }

  private excludes(ctx: AnnotateContext): Set<string> {
    const out = new Set<string>([POOL_MANAGER, ZERO_ADDRESS, ...KNOWN_RELAYS]);
    for (const address of ctx.pools ?? []) out.add(address.toLowerCase());
    for (const address of ctx.routers ?? []) out.add(address.toLowerCase());
    return out;
  }

  private async resolve(print: FlowPrint, meta: MetaOf, exclude: Set<string>): Promise<TraderRef | null> {
    const info = meta(print);
    if (!info) {
      this.counters.noMeta += 1;
      return null;
    }
    const address = info.trader === undefined ? await this.attribute(print, info, exclude) : info.trader;
    if (!address) {
      if (info.trader === null) this.counters.unattributed += 1;
      return null;
    }
    const kind = await this.kindOf(address);
    if (!kind) return null;
    return this.ref(address.toLowerCase(), kind);
  }

  /**
   * A wallet already classified answers without RPC. An unknown one is looked up only while the classification lane is
   * short (curve legs alone bring ~300 distinct traders a minute, far past a public-RPC lane); past that the print stays
   * unannotated and counts as deferred, and the wallet is looked up on its next print.
   */
  private async kindOf(address: string): Promise<TraderKind | null> {
    const known = this.classifier.peek(address);
    if (known) return known;
    if (this.lanePending() >= DISCOVER_MAX_PENDING) {
      this.counters.classifyDeferred += 1;
      return null;
    }
    const kind = await this.classifier.classify(address);
    if (!kind) this.counters.classifyFailed += 1;
    return kind;
  }

  private async attribute(print: FlowPrint, info: PrintMeta, exclude: Set<string>): Promise<string | null> {
    const receipt = await this.receipts.get(print.tx);
    if (!receipt) {
      this.counters.noReceipt += 1;
      return null;
    }
    const to = typeof receipt.to === "string" ? receipt.to.toLowerCase() : null;
    const set = to ? new Set([...exclude, to]) : exclude;
    const attribution = traderFromReceipt(receipt, { token: info.token, side: print.side, exclude: set, amount: info.amount });
    if (attribution.address) return attribution.address;
    if (attribution.candidates > 1) this.counters.ambiguous += 1;
    else this.counters.unattributed += 1;
    return null;
  }

  private ref(address: string, kind: TraderKind): TraderRef {
    if (kind === "smart") this.admit(address);
    const handle = this.handles.get(address);
    return { address, kind, handle: handle?.handle ?? null, followers: handle?.followers ?? null };
  }

  /** Lookups queued on the classifier lane right now (0 when the classifier does not report it). */
  private lanePending(): number {
    const stats = this.classifier.stats() as { pending?: unknown };
    return typeof stats.pending === "number" ? stats.pending : 0;
  }

  private takeBudget(wanted: number): number {
    const minute = Math.floor(this.now() / MINUTE_MS);
    if (minute !== this.budget.minute) this.budget = { minute, used: 0 };
    const allowed = Math.max(0, Math.min(wanted, this.discoverCap - this.budget.used));
    this.budget = { ...this.budget, used: this.budget.used + allowed };
    return allowed;
  }

  private fail(message: string): void {
    this.lastError = message;
    this.log(`trader service: ${message}`);
  }
}

let shared: TraderService | null = null;
let onCreate: ((service: TraderService) => void) | null = null;

/** Restart persistence hook (server/persist/live.ts): runs once on the shared service — at once when it already exists (routes/flow.ts builds it at import), else right after construction. */
export function setTraderServiceHook(hook: ((service: TraderService) => void) | null): void {
  onCreate = hook;
  if (shared && hook) hook(shared);
}

/** Process-wide service against config.monad.rpcUrl, created on first use so tests never touch the network. */
export function getTraderService(): TraderService {
  if (!shared) {
    shared = new TraderService();
    onCreate?.(shared);
  }
  return shared;
}
