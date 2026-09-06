import { config, integrationStatus } from "../../config.js";
import type { FlowLedger } from "../../flow/ledger.js";
import { errorMessage } from "../../lib/http.js";
import { parseSwapTransaction, RAYDIUM_V4_AUTHORITY, tokenDeltas, type ParseResult, type PoolRef } from "./parseSwap.js";
import { QuotePriceCache, SOL_MINT, type QuotePriceStatus } from "./price.js";
import { TransactionReader, type ReaderMeta, type ReaderStats, type TransactionHandler } from "./reader.js";
import { SolanaLogSubscriber, type SignatureHandler, type SubscriberStatus } from "./subscribe.js";

/** Helius free tier allows 10 rps; keep headroom for the rest of the app. Public RPC tolerates ~1 rps. */
export const HELIUS_RPS = 8;
export const PUBLIC_RPS = 1;

/** The slices of the three transports the tape drives; tests inject fakes through these seams. */
export type SubscriberLike = {
  subscribe(mint: string, onSignature: SignatureHandler): void;
  unsubscribe(mint: string): void;
  status(): SubscriberStatus;
  close(): void;
};
export type ReaderLike = {
  enqueue(sig: string, meta: ReaderMeta): boolean;
  start(onTransaction: TransactionHandler): void;
  stop(): void;
  stats(): ReaderStats;
};
export type PriceLike = {
  prime(mints: string[]): Promise<void>;
  get(mint: string): number | null;
  status(): QuotePriceStatus;
};

export type OwnTapeOptions = {
  rpcUrl: string;
  rps: number;
  ledger: FlowLedger;
  log?: (msg: string) => void;
  now?: () => number;
  subscriber?: SubscriberLike;
  reader?: ReaderLike;
  prices?: PriceLike;
  parse?: typeof parseSwapTransaction;
};

export type OwnTapeCounters = { prints: number; unattributed: number; skipped: number; lastPrintAt: number | null };

export type OwnTapeStats = OwnTapeCounters & {
  subscriber: SubscriberStatus;
  reader: ReaderStats;
  price: QuotePriceStatus;
  mints: number;
  lastError: string | null;
};

type MintState = OwnTapeCounters & { pools: PoolRef[] };

function emptyCounters(): OwnTapeCounters {
  return { prints: 0, unattributed: 0, skipped: 0, lastPrintAt: null };
}

function laterOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function sumCounters(total: OwnTapeCounters, state: OwnTapeCounters): OwnTapeCounters {
  return {
    prints: total.prints + state.prints,
    unattributed: total.unattributed + state.unattributed,
    skipped: total.skipped + state.skipped,
    lastPrintAt: laterOf(total.lastPrintAt, state.lastPrintAt)
  };
}

/** Quote-side mints that moved on a tracked pool's vault in this tx, plus SOL for the native-lamport fallback. */
function quoteMintsOf(tx: unknown, mint: string, pools: PoolRef[]): string[] {
  const owners = new Set([RAYDIUM_V4_AUTHORITY, ...pools.map((pool) => pool.pairAddress)]);
  const moved = tokenDeltas(tx)
    .filter((delta) => delta.mint !== mint && delta.delta !== 0 && delta.owner !== null && owners.has(delta.owner))
    .map((delta) => delta.mint);
  return [...new Set([SOL_MINT, ...moved])];
}

export function ownTapeRps(primaryRpc: string): number {
  return primaryRpc === "helius" ? HELIUS_RPS : PUBLIC_RPS;
}

/** Tape against config.rpc.primary, paced for the provider integrationStatus() reports. */
export function createOwnTapeFromConfig(ledger: FlowLedger, log?: (msg: string) => void): SolanaOwnTape {
  return new SolanaOwnTape({ rpcUrl: config.rpc.primary, rps: ownTapeRps(integrationStatus().primaryRpc), ledger, log });
}

/**
 * Own Solana tape: logsSubscribe per tracked mint -> paced getTransaction -> parseSwapTransaction -> ledger.ingest.
 * Prints carry the same pair ids the polled sources use (pump-venue legs under the pump pseudo-pair), so the
 * ledger's (chain, tx, pair) dedupe collapses a trade seen by both. Nothing here throws out of a handler.
 */
export class SolanaOwnTape {
  private readonly ledger: FlowLedger;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly subscriber: SubscriberLike;
  private readonly reader: ReaderLike;
  private readonly prices: PriceLike;
  private readonly parse: typeof parseSwapTransaction;
  private readonly mints = new Map<string, MintState>();
  private lastError: string | null = null;
  private readonly handler: TransactionHandler = (tx, meta) => {
    this.onTransaction(tx, meta).catch((error) => this.fail(`transaction ${meta.mint}: ${errorMessage(error)}`));
  };

  constructor(opts: OwnTapeOptions) {
    this.ledger = opts.ledger;
    this.log = opts.log ?? ((msg) => console.warn(msg));
    this.now = opts.now ?? (() => Date.now());
    this.subscriber = opts.subscriber ?? new SolanaLogSubscriber({ rpcUrl: opts.rpcUrl, log: this.log, now: this.now });
    this.reader = opts.reader ?? new TransactionReader({ rpcUrl: opts.rpcUrl, rps: opts.rps, now: this.now });
    this.prices = opts.prices ?? new QuotePriceCache({ now: this.now });
    this.parse = opts.parse ?? parseSwapTransaction;
  }

  /** Idempotent: replaces the pool list; subscribes the mint on first call. No pools means nothing to attribute, so it untracks. */
  track(mint: string, pools: PoolRef[]): void {
    if (pools.length === 0) {
      this.untrack(mint);
      return;
    }
    const existing = this.mints.get(mint);
    this.mints.set(mint, existing ? { ...existing, pools } : { ...emptyCounters(), pools });
    if (!existing) this.subscriber.subscribe(mint, (sig, slot) => void this.reader.enqueue(sig, { mint, slot }));
    this.reader.start(this.handler);
  }

  untrack(mint: string): void {
    if (!this.mints.delete(mint)) return;
    this.subscriber.unsubscribe(mint);
    if (this.mints.size === 0) this.reader.stop();
  }

  /** Counters for one mint, or summed over every tracked mint when omitted. */
  stats(mint?: string): OwnTapeStats {
    const states = mint === undefined ? [...this.mints.values()] : [this.mints.get(mint)].filter((state): state is MintState => state !== undefined);
    return {
      ...states.reduce(sumCounters, emptyCounters()),
      mints: this.mints.size,
      lastError: this.lastError,
      subscriber: this.subscriber.status(),
      reader: this.reader.stats(),
      price: this.prices.status()
    };
  }

  stop(): void {
    this.mints.clear();
    this.reader.stop();
    this.subscriber.close();
  }

  private async onTransaction(tx: unknown, meta: ReaderMeta): Promise<void> {
    const before = this.mints.get(meta.mint);
    if (!before) return;
    await this.prices.prime(quoteMintsOf(tx, meta.mint, before.pools));
    const state = this.mints.get(meta.mint);
    if (!state) return;
    const result = this.parse(tx, { mint: meta.mint, pools: state.pools, quotePriceUsd: (quote) => this.prices.get(quote) });
    if (result.prints.length) this.ledger.ingest(result.prints);
    this.bump(meta.mint, result);
  }

  private bump(mint: string, result: ParseResult): void {
    const state = this.mints.get(mint);
    if (!state) return;
    const printed = result.prints.length;
    this.mints.set(mint, {
      ...state,
      prints: state.prints + printed,
      unattributed: state.unattributed + result.unattributed,
      skipped: state.skipped + (result.skipped ? 1 : 0),
      lastPrintAt: printed ? this.now() : state.lastPrintAt
    });
  }

  private fail(message: string): void {
    this.lastError = message;
    this.log(`solana own tape: ${message}`);
  }
}
