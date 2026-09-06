import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FlowPrint } from "../../../shared/wire.js";
import { FlowLedger, MINUTE_MS } from "../../flow/ledger.js";
import { pumpPoolFor } from "../../sources/pumpfun.js";
import { HELIUS_RPS, PUBLIC_RPS, SolanaOwnTape, ownTapeRps, type PriceLike, type ReaderLike, type SubscriberLike } from "./ownTape.js";
import type { PoolRef } from "./parseSwap.js";
import { SOL_MINT } from "./price.js";
import type { ReaderMeta, ReaderStats, TransactionHandler } from "./reader.js";
import type { SignatureHandler, SubscriberStatus } from "./subscribe.js";

const MINT = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const PUMPSWAP_POOL = "FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC";
const METEORA_4PAN = "4pANrqEvjad4xEghrCbAAJfBm8KyNvYMKk1cuGW8erE4";
const TX = "2ZxiypZRyMCYyiGJgKLuRC4H4L97kkDC6VWaVFMxc1Jv97kopxb9UH6YNJHEPbgPAZi8W7cYGXK7494YKLxn2zNo";
const BLOCK_MS = 1_788_683_958_000;
const NOW = BLOCK_MS + 5_000;
const SOL_USD = 105.13;
/** WSOL vault delta on the pumpswap leg of the fixture (see __fixtures__/index.json). */
const PUMP_LEG_SOL = 2.908797459;

const fixture: unknown = JSON.parse(readFileSync(new URL("./__fixtures__/pumpswap-FnzKY6x7-2ZxiypZR.json", import.meta.url), "utf8"));

const POOLS: PoolRef[] = [
  { pair: PUMPSWAP_POOL, pairAddress: PUMPSWAP_POOL, dex: "pumpswap", ledgerPair: pumpPoolFor(MINT) },
  { pair: METEORA_4PAN, pairAddress: METEORA_4PAN, dex: "meteora", ledgerPair: METEORA_4PAN }
];

class FakeSubscriber implements SubscriberLike {
  handlers = new Map<string, SignatureHandler>();
  unsubscribed: string[] = [];
  closed = 0;
  subscribe(mint: string, onSignature: SignatureHandler): void {
    this.handlers.set(mint, onSignature);
  }
  unsubscribe(mint: string): void {
    this.handlers.delete(mint);
    this.unsubscribed = [...this.unsubscribed, mint];
  }
  status(): SubscriberStatus {
    return { connected: true, mints: this.handlers.size, reconnects: 0, lastFrameAt: null, lastError: null };
  }
  close(): void {
    this.closed += 1;
  }
  emit(mint: string, sig: string, slot = 1): void {
    this.handlers.get(mint)?.(sig, slot);
  }
}

class FakeReader implements ReaderLike {
  queue: Array<{ sig: string; meta: ReaderMeta }> = [];
  handler: TransactionHandler | null = null;
  starts = 0;
  stops = 0;
  enqueue(sig: string, meta: ReaderMeta): boolean {
    this.queue = [...this.queue, { sig, meta }];
    return true;
  }
  start(onTransaction: TransactionHandler): void {
    this.starts += 1;
    this.handler = onTransaction;
  }
  stop(): void {
    this.stops += 1;
    this.handler = null;
  }
  stats(): ReaderStats {
    return { queued: this.queue.length, inFlight: false, read: 0, dropped: 0, missing: 0, rateLimited: 0, maxQueueSeen: 0, lastError: null };
  }
  deliver(tx: unknown, meta: ReaderMeta): void {
    this.handler?.(tx, meta);
  }
}

class FakePrices implements PriceLike {
  primed: string[][] = [];
  constructor(private readonly table: Record<string, number>) {}
  async prime(mints: string[]): Promise<void> {
    this.primed = [...this.primed, mints];
  }
  get(mint: string): number | null {
    return this.table[mint] ?? null;
  }
  status() {
    return { cached: Object.keys(this.table).length, lastOkAt: null, lastError: null };
  }
}

function harness(overrides: Partial<ConstructorParameters<typeof SolanaOwnTape>[0]> = {}) {
  const ledger = new FlowLedger({ now: () => NOW });
  const subscriber = new FakeSubscriber();
  const reader = new FakeReader();
  const prices = new FakePrices({ [SOL_MINT]: SOL_USD });
  const log = vi.fn();
  const tape = new SolanaOwnTape({ rpcUrl: "https://rpc.test", rps: 1, ledger, log, now: () => NOW, subscriber, reader, prices, ...overrides });
  return { tape, ledger, subscriber, reader, prices, log };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function bucketOf(ledger: FlowLedger, pair: string) {
  const buckets = ledger.series("solana", pair, MINUTE_MS, BLOCK_MS - MINUTE_MS, BLOCK_MS + MINUTE_MS);
  return buckets.find((bucket) => bucket.buys + bucket.sells > 0) ?? null;
}

function pumpV2Print(): FlowPrint {
  return { chain: "solana", pair: pumpPoolFor(MINT), tx: TX, time: BLOCK_MS, side: "buy", usd: 306.12, source: "pumpfun" };
}

describe("SolanaOwnTape", () => {
  it("routes a signature through the reader into prints under each pool's ledgerPair", async () => {
    const h = harness();
    h.tape.track(MINT, POOLS);
    expect(h.reader.starts).toBe(1);
    h.subscriber.emit(MINT, TX, 42);
    expect(h.reader.queue).toEqual([{ sig: TX, meta: { mint: MINT, slot: 42 } }]);
    h.reader.deliver(fixture, { mint: MINT, slot: 42 });
    await flush();
    expect(h.prices.primed[0]).toContain(SOL_MINT);
    expect(bucketOf(h.ledger, pumpPoolFor(MINT))).toMatchObject({ buys: 1, sells: 0 });
    expect(bucketOf(h.ledger, pumpPoolFor(MINT))?.buyUsd).toBeCloseTo(PUMP_LEG_SOL * SOL_USD, 6);
    expect(bucketOf(h.ledger, METEORA_4PAN)).toMatchObject({ buys: 1, sells: 0 });
    expect(h.ledger.pairs()).not.toContain(`solana:${PUMPSWAP_POOL}`);
    expect(h.tape.stats(MINT)).toMatchObject({ prints: 2, unattributed: 0, skipped: 0, lastPrintAt: NOW, mints: 1, lastError: null });
    expect(h.log).not.toHaveBeenCalled();
  });

  it("dedupes a pump-venue print against the identical pump v2 print in either order", async () => {
    const first = harness();
    first.ledger.ingest([pumpV2Print()]);
    first.tape.track(MINT, POOLS);
    first.reader.deliver(fixture, { mint: MINT, slot: 1 });
    await flush();
    expect(bucketOf(first.ledger, pumpPoolFor(MINT))).toMatchObject({ buys: 1, buyUsd: 306.12 });
    expect(bucketOf(first.ledger, METEORA_4PAN)).toMatchObject({ buys: 1 });

    const second = harness();
    second.tape.track(MINT, POOLS);
    second.reader.deliver(fixture, { mint: MINT, slot: 1 });
    await flush();
    expect(second.ledger.ingest([pumpV2Print()])).toEqual({ accepted: 0, duplicates: 1 });
    expect(bucketOf(second.ledger, pumpPoolFor(MINT))).toMatchObject({ buys: 1 });
  });

  it("track is idempotent, replaces the pool list, and an empty list untracks", async () => {
    const h = harness();
    h.tape.track(MINT, POOLS);
    h.tape.track(MINT, [POOLS[1]]);
    expect(h.subscriber.handlers.size).toBe(1);
    expect(h.reader.starts).toBe(2);
    h.reader.deliver(fixture, { mint: MINT, slot: 1 });
    await flush();
    expect(h.ledger.pairs()).toEqual([`solana:${METEORA_4PAN}`]);
    h.tape.track(MINT, []);
    expect(h.subscriber.unsubscribed).toEqual([MINT]);
    expect(h.tape.stats().mints).toBe(0);
  });

  it("untrack unsubscribes the mint and stops the reader once nothing is tracked", () => {
    const h = harness();
    h.tape.track(MINT, POOLS);
    h.tape.track("other", [POOLS[1]]);
    h.tape.untrack(MINT);
    expect(h.subscriber.unsubscribed).toEqual([MINT]);
    expect(h.reader.stops).toBe(0);
    h.tape.untrack(MINT);
    expect(h.subscriber.unsubscribed).toEqual([MINT]);
    h.tape.untrack("other");
    expect(h.reader.stops).toBe(1);
    expect(h.tape.stats()).toMatchObject({ mints: 0, prints: 0 });
  });

  it("ignores transactions for mints that are no longer tracked", async () => {
    const h = harness();
    h.tape.track(MINT, POOLS);
    h.reader.deliver(fixture, { mint: "other", slot: 1 });
    await flush();
    expect(h.prices.primed).toEqual([]);
    expect(h.ledger.pairs()).toEqual([]);
  });

  it("counts skipped transactions and never throws from the handler", async () => {
    const parse = vi.fn(() => {
      throw new Error("parser exploded");
    });
    const h = harness({ parse });
    h.tape.track(MINT, POOLS);
    h.reader.deliver(fixture, { mint: MINT, slot: 1 });
    await flush();
    expect(h.tape.stats(MINT).lastError).toBe(`transaction ${MINT}: parser exploded`);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("parser exploded"));

    const failed = harness();
    failed.tape.track(MINT, POOLS);
    const record = fixture as { meta: Record<string, unknown> };
    failed.reader.deliver({ ...record, meta: { ...record.meta, err: { InstructionError: [0, "Custom"] } } }, { mint: MINT, slot: 1 });
    await flush();
    expect(failed.tape.stats(MINT)).toMatchObject({ prints: 0, skipped: 1, lastPrintAt: null });
    expect(failed.ledger.pairs()).toEqual([]);
  });

  it("stop() drops every mint, stops the reader and closes the subscriber", () => {
    const h = harness();
    h.tape.track(MINT, POOLS);
    h.tape.stop();
    expect(h.reader.stops).toBe(1);
    expect(h.subscriber.closed).toBe(1);
    expect(h.tape.stats().mints).toBe(0);
  });

  it("composes the real transports by default without touching the network", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    const tape = new SolanaOwnTape({ rpcUrl: "https://api.mainnet-beta.solana.com", rps: PUBLIC_RPS, ledger, log: () => undefined });
    expect(tape.stats()).toMatchObject({ mints: 0, subscriber: { connected: false }, reader: { queued: 0 }, price: { cached: 0 } });
    tape.stop();
  });

  it("picks the reader rate from the primary RPC provider", () => {
    expect(ownTapeRps("helius")).toBe(HELIUS_RPS);
    expect(ownTapeRps("public")).toBe(PUBLIC_RPS);
    expect(ownTapeRps("anything else")).toBe(PUBLIC_RPS);
  });
});
