import type { Chain, FlowPrint, FomoFill, TraderKind, TraderRef } from "../../shared/wire.js";
import { config } from "../config.js";
import { FlowLedger, type LedgerStats } from "../flow/ledger.js";
import { errorMessage } from "../lib/http.js";
import { POOL_MANAGER } from "../tape/robinhood/pools.js";
import { isAddress } from "../tape/robinhood/rpc.js";
import { ZERO_ADDRESS, traderFromReceipt, type ReceiptLike } from "./attribute.js";
import { TraderBook, type BookSize, type TraderFill, type TraderTapeRow } from "./book.js";
import { HandleBook, type HandleBookStats, type HandleEntry } from "./handles.js";
import { AccountClassifier } from "./identity.js";
import { LruMap } from "./lru.js";
import { ReceiptFetcher } from "./receipts.js";

/**
 * Receipt + eth_getCode lookups past this pass the batch through unannotated (the general ledger never waits); a lookup
 * that settles later still records its fill in the book and the FOMO ledger (see recordLate) and counts as `late`.
 */
export const ANNOTATE_DEADLINE_MS = 2_000;
/**
 * New user-op senders classified per minute; the rest are dropped and counted (~285 distinct senders/min measured
 * chain-wide). 200/min saturated the 4 rps eth_getCode lane on the public RPC and starved per-print lookups
 * (2,241 queued, 3,655 deadlined in 40 min on 2026-09-06), so discovery runs at a quarter of the lane, low priority.
 */
export const DISCOVER_CAP_PER_MINUTE = 60;
/** Lookups queued on the eth_getCode lane past which discovery drops its batch and per-print lookups of unknown wallets are deferred. */
export const DISCOVER_MAX_PENDING = 20;
/** FOMO wallets remembered; the least recently seen are forgotten past this. */
export const DEFAULT_POPULATION_MAX = 20_000;
export const ENTRY_POINT = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";
export const RELAY_B = "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be";
/** tx.to addresses measured on the robinhoodtrenches tape 2026-09-06 (EntryPoint, relay B, Multicall3, 0x45b62633-fed bundlers): never a trader. */
export const KNOWN_RELAYS: readonly string[] = [
  ENTRY_POINT,
  RELAY_B,
  "0xca11bde05977b3631167028862be2a173976ca11",
  "0xe0c0c31d6413dafffdf99f45f9c07bc8d5245fcc",
  "0x87f85bd5feedad14d8850c20b9250ad9bd283a12",
  "0x6621fbc88edb5c37e87c82b65bfa17be0003d59d",
  "0xe5eac6b2143c7d6eb2e242fc1c8e43b24eef4d46"
];
/** Every count this service exposes is "seen by this server", never "all of fomo.family". */
export const FOMO_POPULATION_LABEL = "FOMO wallets seen by this server";
const FOMO_LEDGER_PAIRS = 256;
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
export type RecordCounts = { fomo: number; other: number };
export type DiscoverResult = { checked: number; dropped: number; fomo: number };

export type ClassifierLike = {
  classify(address: string, opts?: { priority?: "high" | "low" }): Promise<TraderKind | null>;
  peek(address: string): TraderKind | undefined;
  stats(): unknown;
};
export type ReceiptsLike = { get(tx: string): Promise<(ReceiptLike & { to?: string | null }) | null>; stats(): unknown };
export type HandlesLike = { get(address: string): HandleEntry | null; stats(): HandleBookStats };

export type TraderServiceOptions = {
  rpcUrl?: string;
  classifier?: ClassifierLike;
  receipts?: ReceiptsLike;
  handles?: HandlesLike;
  book?: TraderBook;
  fomoLedger?: FlowLedger;
  now?: () => number;
  deadlineMs?: number;
  discoverCap?: number;
  populationMax?: number;
  log?: (msg: string) => void;
};

export type TraderServiceCounters = {
  annotated: number;
  fomo: number;
  other: number;
  noMeta: number;
  noReceipt: number;
  unattributed: number;
  /** Bundled txs where several traders' legs tied and no amount hint separated them. */
  ambiguous: number;
  deadlined: number;
  /** Deadlined prints whose lookup settled afterwards and reached the book / FOMO ledger through recordLate. */
  late: number;
  classifyFailed: number;
  /** Prints whose unknown wallet was not looked up because the eth_getCode lane was already at DISCOVER_MAX_PENDING. */
  classifyDeferred: number;
  discoverChecked: number;
  discoverDropped: number;
};

export type TraderServiceStatus = {
  population: number;
  populationLabel: typeof FOMO_POPULATION_LABEL;
  handles: HandleBookStats;
  classifier: unknown;
  receipts: unknown;
  book: BookSize;
  fomoLedger: LedgerStats;
  counters: TraderServiceCounters;
  lastError: string | null;
};

type PairMeta = { token: string; dex: string };

function emptyCounters(): TraderServiceCounters {
  return { annotated: 0, fomo: 0, other: 0, noMeta: 0, noReceipt: 0, unattributed: 0, ambiguous: 0, deadlined: 0, late: 0, classifyFailed: 0, classifyDeferred: 0, discoverChecked: 0, discoverDropped: 0 };
}

function pairMetaKey(chain: Chain, pair: string): string {
  return `${chain}:${pair}`;
}

/** Robinhood addresses are lowercased for every key; Solana base58 is case-sensitive and left alone. */
function normalizeAddress(chain: Chain, address: string): string {
  return chain === "robinhood" ? address.toLowerCase() : address;
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
export function toFomoFill(row: TraderTapeRow, dex: string, followers: number | null, symbol?: string | null): FomoFill {
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
    ...(symbol === undefined ? {} : { symbol })
  };
}

/**
 * Process-wide trader identity: receipt -> wallet -> EIP-7702 designator check -> robinhoodtrenches handle, plus the
 * FOMO-only ledger (so flowWindows works unchanged) and the per-wallet book. Robinhood-only by construction
 * (eth_getCode); a Solana print is passed through untouched. Nothing here throws to a caller.
 */
export class TraderService {
  readonly classifier: ClassifierLike;
  readonly receipts: ReceiptsLike;
  readonly handles: HandlesLike;
  readonly book: TraderBook;
  readonly fomoLedger: FlowLedger;
  /** Lowercase wallets that passed the designator check on this server (LRU-bounded). */
  readonly population: LruMap<string, true>;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private readonly discoverCap: number;
  private readonly log: (msg: string) => void;
  private readonly discovered = new LruMap<string, true>(DISCOVERED_MAX);
  private readonly pairMeta = new LruMap<string, PairMeta>(PAIR_META_MAX);
  private budget = { minute: -1, used: 0 };
  private counters = emptyCounters();
  private lastError: string | null = null;

  constructor(opts: TraderServiceOptions = {}) {
    const rpcUrl = opts.rpcUrl ?? config.robinhood.rpcUrl;
    this.classifier = opts.classifier ?? new AccountClassifier({ rpcUrl, now: opts.now });
    this.receipts = opts.receipts ?? new ReceiptFetcher({ rpcUrl, now: opts.now });
    this.handles = opts.handles ?? new HandleBook({ now: opts.now });
    this.book = opts.book ?? new TraderBook({ now: opts.now });
    this.fomoLedger = opts.fomoLedger ?? new FlowLedger({ maxPairs: FOMO_LEDGER_PAIRS, now: opts.now });
    this.population = new LruMap(opts.populationMax ?? DEFAULT_POPULATION_MAX);
    this.now = opts.now ?? (() => Date.now());
    this.deadlineMs = opts.deadlineMs ?? ANNOTATE_DEADLINE_MS;
    this.discoverCap = opts.discoverCap ?? DISCOVER_CAP_PER_MINUTE;
    this.log = opts.log ?? ((msg) => console.warn(msg));
  }

  /**
   * Returns the same prints (same order) with `trader` set where the wallet resolved before the deadline. Only
   * Robinhood prints without a trader are looked at; lookups still running at the deadline pass through unannotated
   * here, and whatever they resolve afterwards is recorded by recordLate (the caller's record() only sees the early ones).
   */
  async annotate(prints: FlowPrint[], ctx: AnnotateContext): Promise<FlowPrint[]> {
    const pending = prints.filter((print) => print.chain === "robinhood" && print.trader === undefined);
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

  /** FOMO fills go to the FOMO ledger and the book; "other" fills reach the book only when `includeOther` is set. */
  record(prints: FlowPrint[], meta: MetaOf, opts: RecordOptions = {}): RecordCounts {
    const fomo: FlowPrint[] = [];
    let other = 0;
    for (const print of prints) {
      const trader = print.trader;
      const info = trader ? meta(print) : null;
      if (!trader || !info) continue;
      this.pairMeta.set(pairMetaKey(print.chain, print.pair), { token: normalizeAddress(print.chain, info.token), dex: info.dex });
      if (trader.kind === "fomo") {
        fomo.push(print);
        this.book.record(toTraderFill(print, trader, info.token));
      } else if (opts.includeOther) {
        other += 1;
        this.book.record(toTraderFill(print, trader, info.token));
      }
    }
    if (fomo.length) this.fomoLedger.ingest(fomo);
    this.counters.fomo += fomo.length;
    this.counters.other += other;
    return { fomo: fomo.length, other };
  }

  /** Classifies user-op senders never seen before, at most `discoverCap` new ones per minute; FOMO ones join the population. */
  async discover(senders: string[]): Promise<DiscoverResult> {
    const fresh = [...new Set(senders.map((sender) => sender.trim().toLowerCase()))].filter((sender) => isAddress(sender) && !this.discovered.has(sender));
    const allowed = this.lanePending() >= DISCOVER_MAX_PENDING ? 0 : this.takeBudget(fresh.length);
    const checked = fresh.slice(0, allowed);
    const dropped = fresh.length - allowed;
    for (const address of checked) this.discovered.set(address, true);
    this.counters.discoverChecked += checked.length;
    this.counters.discoverDropped += dropped;
    let fomo = 0;
    await Promise.all(
      checked.map(async (address) => {
        const kind = await this.classifier.classify(address, { priority: "low" }).catch(() => null);
        if (kind === "fomo") {
          this.population.set(address, true);
          fomo += 1;
        } else if (kind === null) {
          this.discovered.delete(address);
        }
      })
    );
    return { checked: checked.length, dropped, fomo };
  }

  /** Dex label remembered for a recorded pair, else derived from a launchpad pseudo-pair prefix, else "". */
  dexOf(chain: Chain, pair: string): string {
    return this.pairMeta.get(pairMetaKey(chain, pair))?.dex ?? dexFromPair(pair);
  }

  status(): TraderServiceStatus {
    return {
      population: this.population.size,
      populationLabel: FOMO_POPULATION_LABEL,
      handles: this.handles.stats(),
      classifier: this.classifier.stats(),
      receipts: this.receipts.stats(),
      book: this.book.size(),
      fomoLedger: this.fomoLedger.stats(),
      counters: { ...this.counters },
      lastError: this.lastError
    };
  }

  /**
   * Keeps the deadlined lookups alive: once `work` settles, every wallet resolved after the deadline is fed through
   * record() so the fill reaches the book and the FOMO ledger. Both dedupe (book fillKey, ledger chain+tx+pair), so
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
   * A wallet already classified answers without RPC. An unknown one is looked up only while the eth_getCode lane is
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
    if (kind === "fomo") this.population.set(address, true);
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

/** Process-wide service against config.robinhood.rpcUrl, created on first use so tests never touch the network. */
export function getTraderService(): TraderService {
  if (!shared) shared = new TraderService();
  return shared;
}
