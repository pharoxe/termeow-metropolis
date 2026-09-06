import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FlowPrint, PairRow } from "../../../shared/wire.js";
import type { AnnotateContext } from "../../traders/service.js";
import type { BlockTimeStats } from "./blocks.js";
import { FlowLedger, MINUTE_MS } from "../../flow/ledger.js";
import { decodeSwapLog, SWAP_TOPICS } from "./decode.js";
import type { LogsHandler, PollerStats, RawLog } from "./poller.js";
import { NATIVE_ETH, POOL_MANAGER, type EvmPoolRef } from "./pools.js";
import { RobinhoodOwnTape, type BlockTimeLike, type EvmPriceLike, type PollerLike } from "./ownTape.js";
import type { EvmQuotePriceStatus } from "./price.js";

const FATCOIN = "0x12D5ee7917cA430073C3A638ee1e6f0648A98a01";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
/** DexScreener's checksum-case pairAddress: the registry stores it verbatim and own prints must reuse it. */
const V3_PAIR = "0x353F2BD390D8db7BFC9B3dD389F8B71e8DF524fa";
const V4_PAIR = "0x70b5b746dc36c648893dafdf4b98d708a07673dfc1b3a0bb9dd70e36c0569f68";
const V3_BLOCK = 55_900_104;
const NOW = 1_788_690_000_000;

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${file}`, import.meta.url), "utf8")) as T;
}

function receiptSwapLog(file: string, topic: string): RawLog {
  const log = loadJson<{ logs: RawLog[] }>(file).logs.find((entry) => entry.topics[0] === topic);
  if (!log) throw new Error(`no swap log in ${file}`);
  return log;
}

const V3_LOG = receiptSwapLog("v3-0x353f2bd3-0x6715fb00.json", SWAP_TOPICS.v3);
const V4_FOREIGN_LOG = receiptSwapLog("v4-0x70b5b746-0x67e9b286.json", SWAP_TOPICS.v4);
const V3_BLOCK_MS = Number(BigInt(loadJson<{ timestamp: string }>("block-55900104.json").timestamp)) * 1000;
/** USDG leg of the v3 fixture swap (GeckoTerminal: 20.660502 USDG in, FATCOIN out). */
const V3_USDG_IN = 20.660502;

const REFS: Record<string, EvmPoolRef> = {
  [V3_PAIR.toLowerCase()]: {
    kind: "v3",
    pair: V3_PAIR.toLowerCase(),
    ledgerPair: V3_PAIR,
    logAddress: V3_PAIR.toLowerCase(),
    dex: "uniswap",
    token: FATCOIN.toLowerCase(),
    quote: USDG,
    tokenIsCurrency0: true,
    tokenDecimals: 18,
    quoteDecimals: 6,
    fee: 3000
  },
  [V4_PAIR]: {
    kind: "v4",
    pair: V4_PAIR,
    ledgerPair: V4_PAIR,
    logAddress: POOL_MANAGER,
    dex: "uniswap",
    token: FATCOIN.toLowerCase(),
    quote: NATIVE_ETH,
    tokenIsCurrency0: false,
    tokenDecimals: 18,
    quoteDecimals: 18,
    fee: null
  }
};

function row(pairAddress: string, tier: PairRow["tier"], quoteMint = USDG): PairRow {
  return {
    chain: "robinhood",
    dex: "uniswap",
    pairAddress,
    baseMint: FATCOIN,
    quoteMint,
    liquidityUsd: null,
    volume24Usd: null,
    share24: null,
    txns: { m5: null, h1: null, h6: null, h24: null },
    tier,
    sources: ["dexscreener"]
  };
}

const POLLER_STATS: PollerStats = { cursor: 1, head: 1, polls: 1, logs: 0, dropped: 0, errors: 0, lastError: null, lastOkAt: NOW, rpcCalls: 1, blockedUntil: null };
const BLOCK_STATS: BlockTimeStats = { cached: 0, inFlight: 0, hits: 0, misses: 0, failures: 0, lastError: null };
const PRICE_STATUS: EvmQuotePriceStatus = { cached: 0, lastOkAt: null, lastError: null };

class FakePoller implements PollerLike {
  filters: Array<{ addresses: string[]; poolIds: string[] }> = [];
  handler: LogsHandler | null = null;
  starts = 0;
  stops = 0;
  setFilter(addresses: string[], poolIds: string[]): void {
    this.filters = [...this.filters, { addresses, poolIds }];
  }
  start(onLogs: LogsHandler): void {
    this.starts += 1;
    this.handler = onLogs;
  }
  stop(): void {
    this.stops += 1;
  }
  stats(): PollerStats {
    return POLLER_STATS;
  }
  emit(logs: RawLog[]): void {
    this.handler?.(logs, 1);
  }
  last(): { addresses: string[]; poolIds: string[] } | undefined {
    return this.filters.at(-1);
  }
}

class FakeBlocks implements BlockTimeLike {
  constructor(private readonly table: Record<number, number>) {}
  async timeMs(blockNumber: number): Promise<number | null> {
    return this.table[blockNumber] ?? null;
  }
  stats(): BlockTimeStats {
    return BLOCK_STATS;
  }
}

class FakePrices implements EvmPriceLike {
  primed: string[][] = [];
  constructor(private readonly table: Record<string, number>) {}
  async prime(quotes: string[]): Promise<void> {
    this.primed = [...this.primed, quotes];
  }
  get(quote: string): number | null {
    return this.table[quote.toLowerCase()] ?? null;
  }
  status(): EvmQuotePriceStatus {
    return PRICE_STATUS;
  }
}

function harness(overrides: Partial<ConstructorParameters<typeof RobinhoodOwnTape>[0]> = {}) {
  const ledger = new FlowLedger({ now: () => NOW });
  const poller = new FakePoller();
  const blocks = new FakeBlocks({ [V3_BLOCK]: V3_BLOCK_MS });
  const prices = new FakePrices({ [USDG]: 1, [NATIVE_ETH]: 2500 });
  const log = vi.fn();
  const resolve = vi.fn(async (pair: PairRow) => REFS[pair.pairAddress.toLowerCase()] ?? null);
  const resolveStatus = () => ({ lastError: "unresolved pool", decimalsCached: 0 });
  const tape = new RobinhoodOwnTape({
    rpcUrl: "https://rpc.example.test", ledger, log, now: () => NOW, poller, blocks, prices, resolve, resolveStatus, resolveStaggerMs: 0, ...overrides
  });
  return { tape, ledger, poller, blocks, prices, log, resolve };
}

type Filter = { addresses: string[]; poolIds: string[] };
const V3_ONLY: Filter = { addresses: [V3_PAIR.toLowerCase()], poolIds: [] };
const V3_AND_V4: Filter = { addresses: [V3_PAIR.toLowerCase()], poolIds: [V4_PAIR] };

/** Pools resolve one at a time, so wait for the filter the resolvable rows should end in rather than the first start. */
async function tracked(h: ReturnType<typeof harness>, pairs: PairRow[], filter: Filter): Promise<void> {
  h.tape.track(FATCOIN, pairs);
  await vi.waitFor(() => expect(h.poller.last()).toEqual(filter));
}

describe("RobinhoodOwnTape", () => {
  it("resolves Tier A pools, unions the poller filter, and turns a v3 Swap log into a print under the registry pair id", async () => {
    const h = harness();
    await tracked(h, [row(V3_PAIR, "A"), row(V4_PAIR, "A", NATIVE_ETH), row("0x0000000000000000000000000000000000000abc", "B")], V3_AND_V4);
    expect(h.resolve).toHaveBeenCalledTimes(2);
    expect(h.poller.starts).toBe(1);
    expect(h.prices.primed.at(-1)).toEqual([USDG, NATIVE_ETH]);

    h.poller.emit([V3_LOG]);
    await vi.waitFor(() => expect(h.ledger.pairs()).toContain(`robinhood:${V3_PAIR}`));
    const bucket = h.ledger.series("robinhood", V3_PAIR, MINUTE_MS, V3_BLOCK_MS - MINUTE_MS, V3_BLOCK_MS + MINUTE_MS);
    expect(bucket).toHaveLength(1);
    expect(bucket[0]).toMatchObject({ buys: 1, sells: 0, unpricedBuys: 0 });
    expect(bucket[0].buyUsd).toBeCloseTo(V3_USDG_IN, 5);
    expect(h.tape.stats(FATCOIN)).toMatchObject({ prints: 1, undecoded: 0, untimed: 0, lastPrintAt: NOW, tokens: 1, pools: 2, lastError: null });

    const geckoDuplicate = { chain: "robinhood" as const, pair: V3_PAIR, tx: V3_LOG.transactionHash, time: V3_BLOCK_MS, side: "buy" as const, usd: 20.66, source: "geckoterminal" as const };
    expect(h.ledger.ingest([geckoDuplicate])).toEqual({ accepted: 0, duplicates: 1 });
  });

  it("resolves Tier A pools one at a time and starts polling as soon as the first pool is known", async () => {
    const pending: Array<{ pair: PairRow; release: (ref: EvmPoolRef | null) => void }> = [];
    const resolve = vi.fn((pair: PairRow) => new Promise<EvmPoolRef | null>((release) => pending.push({ pair, release })));
    const release = (ref: EvmPoolRef | null) => pending.shift()?.release(ref);
    const h = harness({ resolve });
    h.tape.track(FATCOIN, [row(V3_PAIR, "A"), row(V4_PAIR, "A", NATIVE_ETH), row("0x00000000000000000000000000000000000000ff", "A")]);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(h.poller.starts).toBe(0);
    release(REFS[V3_PAIR.toLowerCase()]);
    await vi.waitFor(() => expect(h.poller.last()).toEqual(V3_ONLY));
    expect(h.poller.starts).toBe(1);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(resolve).toHaveBeenCalledTimes(2);
    release(REFS[V4_PAIR]);
    await vi.waitFor(() => expect(h.poller.last()).toEqual(V3_AND_V4));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    release(null);
    await vi.waitFor(() => expect(h.tape.stats().lastError).toBe("pool 0x00000000000000000000000000000000000000ff: unresolved pool"));
    expect(resolve.mock.calls.map(([pair]) => pair.pairAddress)).toEqual([V3_PAIR, V4_PAIR, "0x00000000000000000000000000000000000000ff"]);
    expect(h.poller.starts).toBe(1);
  });

  it("re-tracking reuses resolved refs, and a token with no Tier A rows is untracked", async () => {
    const h = harness();
    await tracked(h, [row(V3_PAIR, "A")], V3_ONLY);
    h.tape.track(FATCOIN, [row(V3_PAIR, "A")]);
    await Promise.resolve();
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.tape.stats().tokens).toBe(1);
    h.tape.track(FATCOIN, [row(V3_PAIR, "B")]);
    expect(h.tape.stats().tokens).toBe(0);
    expect(h.poller.last()).toEqual({ addresses: [], poolIds: [] });
  });

  it("drops v4 logs for pool ids outside the tracked set and counts logs whose block time is unknown", async () => {
    const h = harness();
    await tracked(h, [row(V3_PAIR, "A"), row(V4_PAIR, "A", NATIVE_ETH)], V3_AND_V4);
    h.poller.emit([V4_FOREIGN_LOG, { ...V3_LOG, blockNumber: "0x1", transactionHash: "0xuntimed" }]);
    await vi.waitFor(() => expect(h.tape.stats(FATCOIN).untimed).toBe(1));
    expect(h.tape.stats(FATCOIN)).toMatchObject({ prints: 0, undecoded: 0 });
    expect(h.ledger.pairs()).toEqual([]);
  });

  it("skips a pool that fails to resolve, logs it once, and keeps the others", async () => {
    const h = harness();
    await tracked(h, [row(V3_PAIR, "A"), row("0x00000000000000000000000000000000000000ff", "A")], V3_ONLY);
    await vi.waitFor(() => expect(h.tape.stats().lastError).toBe("pool 0x00000000000000000000000000000000000000ff: unresolved pool"));
    expect(h.poller.last()).toEqual(V3_ONLY);
    expect(h.log).toHaveBeenCalledTimes(1);
    h.tape.track(FATCOIN, [row(V3_PAIR, "A"), row("0x00000000000000000000000000000000000000ff", "A")]);
    await Promise.resolve();
    expect(h.resolve).toHaveBeenCalledTimes(2);
  });

  it("untrack removes the token's pools from the filter and stops the poller when nothing is left", async () => {
    const h = harness();
    await tracked(h, [row(V3_PAIR, "A")], V3_ONLY);
    h.tape.track("0x00000000000000000000000000000000000000ee", [{ ...row(V4_PAIR, "A", NATIVE_ETH), baseMint: "0x00000000000000000000000000000000000000ee" }]);
    await vi.waitFor(() => expect(h.poller.last()?.poolIds).toEqual([V4_PAIR]));
    expect(h.poller.stops).toBe(0);
    h.tape.untrack(FATCOIN);
    expect(h.poller.last()).toEqual({ addresses: [], poolIds: [V4_PAIR] });
    expect(h.poller.stops).toBe(0);
    h.tape.untrack("0x00000000000000000000000000000000000000EE");
    expect(h.poller.last()).toEqual({ addresses: [], poolIds: [] });
    expect(h.poller.stops).toBe(1);
    h.tape.untrack("never-tracked");
    expect(h.poller.stops).toBe(1);
  });

  it("a decoder throw is recorded and does not stop the rest of the batch", async () => {
    const decode = vi.fn((log: Parameters<typeof decodeSwapLog>[0], pools: Parameters<typeof decodeSwapLog>[1], ctx: Parameters<typeof decodeSwapLog>[2]) => {
      if (log.transactionHash === "0xbad") throw new Error("boom");
      return decodeSwapLog(log, pools, ctx);
    });
    const h = harness({ decode });
    await tracked(h, [row(V3_PAIR, "A")], V3_ONLY);
    h.poller.emit([{ ...V3_LOG, transactionHash: "0xbad", logIndex: "0x1" }, V3_LOG]);
    await vi.waitFor(() => expect(h.tape.stats(FATCOIN).prints).toBe(1));
    expect(h.tape.stats(FATCOIN)).toMatchObject({ undecoded: 1, lastError: "decode 0xbad: boom" });
    expect(h.log).toHaveBeenCalledWith("robinhood own tape: decode 0xbad: boom");
  });

  it("stop clears tracked tokens and stops the poller; stats expose every transport", async () => {
    const h = harness();
    await tracked(h, [row(V3_PAIR, "A")], V3_ONLY);
    h.tape.stop();
    expect(h.poller.stops).toBe(1);
    expect(h.tape.stats()).toMatchObject({ tokens: 0, pools: 0, poller: POLLER_STATS, blocks: BLOCK_STATS, price: PRICE_STATUS, resolve: { lastError: "unresolved pool" } });
  });
});

describe("RobinhoodOwnTape trader annotation (R3)", () => {
  const TRADER = { address: "0x06de9c48b1e639ed5c13ec8fbd4080a38e39f2d1", kind: "fomo" as const, handle: "AvgJoesCrypto", followers: 1200 };

  function fakeTraders(behaviour: "annotate" | "throw") {
    const calls: Array<{ prints: FlowPrint[]; pools: string[]; metas: Array<ReturnType<AnnotateContext["meta"]>> }> = [];
    const recorded: FlowPrint[][] = [];
    return {
      calls,
      recorded,
      annotate: async (prints: FlowPrint[], ctx: AnnotateContext) => {
        calls.push({ prints, pools: [...(ctx.pools ?? [])], metas: prints.map((print) => ctx.meta(print)) });
        if (behaviour === "throw") throw new Error("rpc down");
        return prints.map((print) => ({ ...print, trader: TRADER }));
      },
      record: (prints: FlowPrint[]) => {
        recorded.push(prints);
      }
    };
  }

  it("runs annotate between decode and ingest with token, dex and the Swap amount, then records the annotated prints", async () => {
    const traders = fakeTraders("annotate");
    const h = harness({ traders });
    await tracked(h, [row(V3_PAIR, "A")], V3_ONLY);
    h.poller.emit([V3_LOG]);
    await vi.waitFor(() => expect(h.ledger.pairs()).toContain(`robinhood:${V3_PAIR}`));
    expect(traders.calls).toHaveLength(1);
    expect(traders.calls[0].pools).toEqual([V3_PAIR.toLowerCase()]);
    expect(traders.calls[0].metas[0]).toMatchObject({ token: FATCOIN.toLowerCase(), dex: "uniswap" });
    expect(typeof traders.calls[0].metas[0]?.amount).toBe("bigint");
    expect(h.ledger.recentPrints("robinhood", V3_PAIR)[0].trader).toEqual(TRADER);
    expect(traders.recorded[0][0].trader).toEqual(TRADER);
  });

  it("ingests unannotated and records the error when the service throws; no service means no annotation at all", async () => {
    const traders = fakeTraders("throw");
    const h = harness({ traders });
    await tracked(h, [row(V3_PAIR, "A")], V3_ONLY);
    h.poller.emit([V3_LOG]);
    await vi.waitFor(() => expect(h.ledger.pairs()).toContain(`robinhood:${V3_PAIR}`));
    expect(h.ledger.recentPrints("robinhood", V3_PAIR)[0].trader).toBeUndefined();
    expect(h.tape.stats().lastError).toBe("annotate: rpc down");
    const plain = harness();
    await tracked(plain, [row(V3_PAIR, "A")], V3_ONLY);
    plain.poller.emit([V3_LOG]);
    await vi.waitFor(() => expect(plain.ledger.pairs()).toContain(`robinhood:${V3_PAIR}`));
    expect(plain.ledger.recentPrints("robinhood", V3_PAIR)[0].trader).toBeUndefined();
  });
});
