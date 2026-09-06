import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chain, FlowPrint, PairRow } from "../../shared/wire.js";
import { UpstreamError } from "../lib/http.js";
import type { PumpTradesPage, WalkPumpOptions, WalkPumpResult } from "../sources/pumpfun.js";
import type { RobinhoodOwnTapeStats } from "../tape/robinhood/ownTape.js";
import type { OwnTapeStats } from "../tape/solana/ownTape.js";
import {
  BACKFILL_RETRY_MS,
  FlowCollector,
  GECKO_POLL_MS,
  MAX_SUBSCRIPTIONS,
  SUBSCRIPTION_TTL_MS,
  type CollectorDeps,
  type OwnTapeLike,
  type RobinhoodOwnTapeLike
} from "./collector.js";
import { FlowLedger } from "./ledger.js";

const MINT = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const PUMP = `pumpfun:${MINT}`;
const POOL = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";
const PUMPSWAP_POOL = "FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC";
const START = 1_800_000_000_000;
const OWN_STATS: OwnTapeStats = {
  prints: 3,
  unattributed: 1,
  skipped: 0,
  lastPrintAt: START - 1000,
  mints: 1,
  lastError: null,
  subscriber: { connected: true, mints: 1, reconnects: 0, lastFrameAt: START - 500, lastError: null },
  reader: { queued: 0, inFlight: false, read: 3, dropped: 0, missing: 0, rateLimited: 0, maxQueueSeen: 1, lastError: null },
  price: { cached: 1, lastOkAt: START - 2000, lastError: null }
};
const EVM_TOKEN = "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01";
const EVM_POOL = "0x353F2BD390D8db7BFC9B3dD389F8B71e8DF524fa";
const RH_STATS: RobinhoodOwnTapeStats = {
  prints: 2,
  undecoded: 0,
  untimed: 0,
  lastPrintAt: START - 500,
  tokens: 1,
  pools: 1,
  lastError: null,
  poller: { cursor: 10, head: 10, polls: 1, logs: 2, dropped: 0, errors: 0, lastError: "rpc 429 rate limited", lastOkAt: START, rpcCalls: 1, blockedUntil: null },
  blocks: { cached: 1, inFlight: 0, hits: 1, misses: 1, failures: 0, lastError: null },
  price: { cached: 1, lastOkAt: START, lastError: null },
  resolve: { lastError: null, decimalsCached: 2 }
};

function row(pairAddress: string, tier: PairRow["tier"]): PairRow {
  return {
    chain: "solana",
    dex: "raydium",
    pairAddress,
    baseMint: MINT,
    quoteMint: null,
    liquidityUsd: null,
    volume24Usd: null,
    share24: null,
    txns: { m5: null, h1: null, h6: null, h24: null },
    tier,
    sources: ["dexscreener"]
  };
}

function print(pair: string, tx: string, time: number, source: FlowPrint["source"]): FlowPrint {
  return { chain: "solana", pair, tx, time, side: "buy", usd: 1, source };
}

function harness(overrides: Partial<CollectorDeps> = {}) {
  let now = START;
  const ledger = new FlowLedger({ now: () => now });
  const log = vi.fn();
  const geckoPoolTrades = vi.fn(async (_chain: Chain, pool: string) => [print(pool, `g-${pool}-${now}`, now, "geckoterminal")]);
  const fetchPumpTradesPage = vi.fn(async (mint: string): Promise<PumpTradesPage> => ({
    prints: [print(`pumpfun:${mint}`, `p-${now}`, now, "pumpfun")],
    nextCursor: null,
    hasMore: false
  }));
  const walkPumpTradesBack = vi.fn(async (mint: string, opts: WalkPumpOptions): Promise<WalkPumpResult> => {
    opts.onPage?.([print(`pumpfun:${mint}`, "backfill-1", START - 3_600_000, "pumpfun")]);
    return { pages: 1, prints: 1, oldestMs: START - 3_600_000, nextCursor: null, stoppedBy: "end" };
  });
  const tape: { [K in keyof OwnTapeLike]: ReturnType<typeof vi.fn> } = { track: vi.fn(), untrack: vi.fn(), stats: vi.fn(() => OWN_STATS), stop: vi.fn() };
  const rhTape: { [K in keyof RobinhoodOwnTapeLike]: ReturnType<typeof vi.fn> } = { track: vi.fn(), untrack: vi.fn(), stats: vi.fn(() => RH_STATS), stop: vi.fn() };
  const collector = new FlowCollector({
    ledger, now: () => now, log, geckoPoolTrades, fetchPumpTradesPage, walkPumpTradesBack, ownTape: () => tape, ownTapeRobinhood: () => rhTape, ...overrides
  });
  return { collector, ledger, log, geckoPoolTrades, fetchPumpTradesPage, walkPumpTradesBack, tape, rhTape, advance: (ms: number) => { now += ms; } };
}

const active: FlowCollector[] = [];
function track<T extends { collector: FlowCollector }>(h: T): T {
  active.push(h.collector);
  return h;
}

afterEach(() => {
  while (active.length) active.pop()?.stop();
});

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("FlowCollector", () => {
  it("starts lazily on first subscribe and stops on stop()", () => {
    const h = track(harness());
    expect(h.collector.isRunning()).toBe(false);
    h.collector.subscribe("solana", MINT, [row(POOL, "A")]);
    expect(h.collector.isRunning()).toBe(true);
    h.collector.stop();
    expect(h.collector.isRunning()).toBe(false);
  });

  it("polls the pump pseudo-pair every tick and gecko pools every GECKO_POLL_MS", async () => {
    const h = track(harness());
    h.collector.subscribe("solana", MINT, [row(PUMP, "A"), row(POOL, "A"), row("tierB", "B")]);
    await h.collector.tick();
    expect(h.fetchPumpTradesPage).toHaveBeenCalledTimes(1);
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(1);
    expect(h.geckoPoolTrades).toHaveBeenCalledWith("solana", POOL, { priority: "low" });
    h.advance(5_000);
    await h.collector.tick();
    expect(h.fetchPumpTradesPage).toHaveBeenCalledTimes(2);
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(1);
    h.advance(GECKO_POLL_MS - 5_000);
    await h.collector.tick();
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(2);
    expect(h.ledger.pairs()).toEqual(expect.arrayContaining([`solana:${PUMP}`, `solana:${POOL}`]));
    expect(h.ledger.pairs()).not.toContain("solana:tierB");
  });

  it("backfills a pump-launched mint once and exposes launchMs when the walk reached the end", async () => {
    const h = track(harness());
    h.collector.subscribe("solana", MINT, [row(PUMP, "A")]);
    h.collector.subscribe("solana", MINT, [row(PUMP, "A")]);
    await flush();
    expect(h.walkPumpTradesBack).toHaveBeenCalledTimes(1);
    expect(h.walkPumpTradesBack.mock.calls[0][1]).toMatchObject({ untilMs: START - 48 * 3_600_000, maxPages: 60, pageDelayMs: 500 });
    expect(h.ledger.firstPrintAt("solana", PUMP)).toBe(START - 3_600_000);
    const status = h.collector.status("solana", MINT);
    expect(status.backfill?.result?.stoppedBy).toBe("end");
    expect(status.launchMs).toBe(START - 3_600_000);
  });

  it("does not report launchMs when the backfill stopped early", async () => {
    const h = track(harness({
      walkPumpTradesBack: async (): Promise<WalkPumpResult> => ({ pages: 60, prints: 6000, oldestMs: START - 1000, nextCursor: "x", stoppedBy: "maxPages" })
    }));
    h.collector.subscribe("solana", MINT, [row(PUMP, "A")]);
    await flush();
    expect(h.collector.launchMs("solana", MINT)).toBeNull();
  });

  it("retries a failed backfill on a later subscribe once BACKFILL_RETRY_MS has passed", async () => {
    const h = track(harness());
    h.walkPumpTradesBack.mockRejectedValueOnce(new UpstreamError("Upstream returned 429", 429));
    h.collector.subscribe("solana", MINT, [row(PUMP, "A")]);
    await flush();
    expect(h.collector.status("solana", MINT).backfill).toMatchObject({ error: "Upstream returned 429", finishedAt: START });
    h.collector.subscribe("solana", MINT, [row(PUMP, "A")]);
    h.advance(BACKFILL_RETRY_MS - 1);
    h.collector.subscribe("solana", MINT, [row(PUMP, "A")]);
    expect(h.walkPumpTradesBack).toHaveBeenCalledTimes(1);
    h.advance(1);
    h.collector.subscribe("solana", MINT, [row(PUMP, "A")]);
    await flush();
    expect(h.walkPumpTradesBack).toHaveBeenCalledTimes(2);
    expect(h.collector.status("solana", MINT).backfill).toMatchObject({ error: null, result: { stoppedBy: "end" } });
    expect(h.collector.launchMs("solana", MINT)).toBe(START - 3_600_000);
  });

  it("records per-source health, never throws from a tick, and throttles logs to once per minute", async () => {
    const h = track(harness({
      geckoPoolTrades: async () => { throw new UpstreamError("GeckoTerminal request budget exhausted", 429); }
    }));
    h.collector.subscribe("solana", MINT, [row(PUMP, "A"), row(POOL, "A")]);
    await expect(h.collector.tick()).resolves.toBeUndefined();
    let status = h.collector.status("solana", MINT);
    expect(status.sources.pumpfun).toMatchObject({ lastOkAt: START, lastError: null });
    expect(status.sources.geckoterminal).toMatchObject({ lastOkAt: null, lastError: "GeckoTerminal request budget exhausted", lastErrorAt: START });
    expect(h.log).toHaveBeenCalledTimes(1);
    h.advance(GECKO_POLL_MS);
    await h.collector.tick();
    expect(h.log).toHaveBeenCalledTimes(1);
    h.advance(60_000);
    await h.collector.tick();
    expect(h.log).toHaveBeenCalledTimes(2);
    status = h.collector.status("solana", MINT);
    expect(status.tierAPairs).toBe(2);
    expect(h.collector.status("solana", "unknown")).toMatchObject({ subscribed: false, lastRequestedAt: null, backfill: null, launchMs: null });
  });

  it("skips subscriptions not requested within the TTL", async () => {
    const h = track(harness());
    h.collector.subscribe("solana", MINT, [row(PUMP, "A")]);
    h.advance(SUBSCRIPTION_TTL_MS + 1);
    await h.collector.tick();
    expect(h.fetchPumpTradesPage).not.toHaveBeenCalled();
    h.collector.subscribe("solana", MINT, [row(PUMP, "A")]);
    await h.collector.tick();
    expect(h.fetchPumpTradesPage).toHaveBeenCalledTimes(1);
  });

  it("caps subscriptions and drops the least recently requested with a log line", () => {
    const h = track(harness());
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i += 1) {
      h.collector.subscribe("solana", `mint${i}`, [row(`pool${i}`, "A")]);
      h.advance(1000);
    }
    h.collector.subscribe("solana", "mint0", [row("pool0", "A")]);
    h.advance(1000);
    h.collector.subscribe("solana", "fresh", [row("poolFresh", "A")]);
    expect(h.collector.subscriptions()).toHaveLength(MAX_SUBSCRIPTIONS);
    expect(h.collector.subscriptions()).not.toContain("solana:mint1");
    expect(h.collector.subscriptions()).toContain("solana:mint0");
    expect(h.collector.subscriptions()).toContain("solana:fresh");
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("dropping solana:mint1"));
  });
});

describe("FlowCollector own tape", () => {
  const registry = () => [row(PUMP, "A"), { ...row(PUMPSWAP_POOL, "B"), dex: "pumpswap" }, row(POOL, "A"), row("tierB", "B")];

  it("tracks Tier A pool refs on every solana subscribe and reports own-tape health under sources.own", () => {
    const h = track(harness());
    h.collector.subscribe("solana", MINT, registry());
    expect(h.tape.track).toHaveBeenCalledWith(MINT, [
      { pair: PUMPSWAP_POOL, pairAddress: PUMPSWAP_POOL, dex: "pumpswap", ledgerPair: PUMP },
      { pair: POOL, pairAddress: POOL, dex: "raydium", ledgerPair: POOL }
    ]);
    h.collector.subscribe("solana", MINT, [row(POOL, "A")]);
    expect(h.tape.track).toHaveBeenLastCalledWith(MINT, [{ pair: POOL, pairAddress: POOL, dex: "raydium", ledgerPair: POOL }]);
    expect(h.collector.status("solana", MINT).sources.own).toEqual({ lastOkAt: START - 1000, lastError: null, lastErrorAt: null, tape: OWN_STATS });
    expect(h.tape.stats).toHaveBeenCalledWith(MINT);
    expect(h.collector.status("solana", "unknown").sources.own).toEqual({ lastOkAt: null, lastError: null, lastErrorAt: null, tape: null });
  });

  it("untracks when a subscription expires or is evicted, and stops the tape with the collector", async () => {
    const h = track(harness());
    h.collector.subscribe("solana", MINT, registry());
    h.advance(SUBSCRIPTION_TTL_MS + 1);
    await h.collector.tick();
    expect(h.tape.untrack).toHaveBeenCalledWith(MINT);
    await h.collector.tick();
    expect(h.tape.untrack).toHaveBeenCalledTimes(1);
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i += 1) {
      h.collector.subscribe("solana", `mint${i}`, [row(`pool${i}`, "A")]);
      h.advance(1000);
    }
    h.collector.subscribe("solana", "fresh", [row("poolFresh", "A")]);
    expect(h.tape.untrack).toHaveBeenCalledWith("mint0");
    h.collector.stop();
    expect(h.tape.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps polling when the tape or its factory throws, and surfaces the fault in sources.own", async () => {
    const h = track(harness());
    h.tape.track.mockImplementation(() => {
      throw new Error("tape down");
    });
    expect(() => h.collector.subscribe("solana", MINT, registry())).not.toThrow();
    await expect(h.collector.tick()).resolves.toBeUndefined();
    expect(h.fetchPumpTradesPage).toHaveBeenCalledTimes(1);
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(1);
    expect(h.collector.status("solana", MINT).sources.own).toEqual({ lastOkAt: null, lastError: "tape down", lastErrorAt: START, tape: null });
    expect(h.log).toHaveBeenCalledWith("flow collector: own tape: tape down");
    h.collector.subscribe("solana", MINT, registry());
    expect(h.log).toHaveBeenCalledTimes(1);

    const broken = track(harness({ ownTape: () => { throw new Error("no rpc"); } }));
    broken.collector.subscribe("solana", MINT, registry());
    await expect(broken.collector.tick()).resolves.toBeUndefined();
    expect(broken.fetchPumpTradesPage).toHaveBeenCalledTimes(1);
    expect(broken.collector.status("solana", MINT).sources.own).toMatchObject({ lastError: "no rpc", tape: null });
  });
});

describe("FlowCollector robinhood", () => {
  const evmRow = (): PairRow => ({ ...row(EVM_POOL, "A"), chain: "robinhood", baseMint: EVM_TOKEN, quoteMint: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" });

  it("tracks registry rows on the robinhood tape, polls gecko with the robinhood network, and leaves solana alone", async () => {
    const h = track(harness());
    h.collector.subscribe("robinhood", EVM_TOKEN, [evmRow()]);
    expect(h.rhTape.track).toHaveBeenCalledWith(EVM_TOKEN, [evmRow()]);
    expect(h.tape.track).not.toHaveBeenCalled();
    await h.collector.tick();
    expect(h.geckoPoolTrades).toHaveBeenCalledWith("robinhood", EVM_POOL, { priority: "low" });
    expect(h.fetchPumpTradesPage).not.toHaveBeenCalled();
    expect(h.walkPumpTradesBack).not.toHaveBeenCalled();
    const own = h.collector.status("robinhood", EVM_TOKEN).sources.own;
    expect(own).toEqual({ lastOkAt: START - 500, lastError: "rpc 429 rate limited", lastErrorAt: null, tape: RH_STATS });
    expect(h.rhTape.stats).toHaveBeenCalledWith(EVM_TOKEN);
    h.collector.subscribe("solana", MINT, [row(POOL, "A")]);
    expect(h.tape.track).toHaveBeenCalledTimes(1);
    expect(h.rhTape.track).toHaveBeenCalledTimes(1);
  });

  it("untracks expired robinhood subscriptions and stops both tapes with the collector", async () => {
    const h = track(harness());
    h.collector.subscribe("robinhood", EVM_TOKEN, [evmRow()]);
    h.collector.subscribe("solana", MINT, [row(POOL, "A")]);
    h.advance(SUBSCRIPTION_TTL_MS + 1);
    await h.collector.tick();
    expect(h.rhTape.untrack).toHaveBeenCalledWith(EVM_TOKEN);
    expect(h.tape.untrack).toHaveBeenCalledWith(MINT);
    h.collector.stop();
    expect(h.rhTape.stop).toHaveBeenCalledTimes(1);
    expect(h.tape.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps a robinhood tape fault out of solana's own health", () => {
    const h = track(harness({ ownTapeRobinhood: () => { throw new Error("no evm rpc"); } }));
    h.collector.subscribe("robinhood", EVM_TOKEN, [evmRow()]);
    h.collector.subscribe("solana", MINT, [row(POOL, "A")]);
    expect(h.collector.status("robinhood", EVM_TOKEN).sources.own).toMatchObject({ lastError: "no evm rpc", lastErrorAt: START, tape: null });
    expect(h.collector.status("solana", MINT).sources.own).toEqual({ lastOkAt: START - 1000, lastError: null, lastErrorAt: null, tape: OWN_STATS });
  });
});
