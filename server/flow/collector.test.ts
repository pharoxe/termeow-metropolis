import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowPrint, PairRow } from "../../shared/wire.js";
import { UpstreamError } from "../lib/http.js";
import type { PumpTradesPage, WalkPumpOptions, WalkPumpResult } from "../sources/pumpfun.js";
import { BACKFILL_RETRY_MS, FlowCollector, GECKO_POLL_MS, MAX_SUBSCRIPTIONS, SUBSCRIPTION_TTL_MS, type CollectorDeps } from "./collector.js";
import { FlowLedger } from "./ledger.js";

const MINT = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const PUMP = `pumpfun:${MINT}`;
const POOL = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";
const START = 1_800_000_000_000;

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
  const geckoPoolTrades = vi.fn(async (_chain: "solana" | "robinhood", pool: string) => [print(pool, `g-${pool}-${now}`, now, "geckoterminal")]);
  const fetchPumpTradesPage = vi.fn(async (mint: string): Promise<PumpTradesPage> => ({
    prints: [print(`pumpfun:${mint}`, `p-${now}`, now, "pumpfun")],
    nextCursor: null,
    hasMore: false
  }));
  const walkPumpTradesBack = vi.fn(async (mint: string, opts: WalkPumpOptions): Promise<WalkPumpResult> => {
    opts.onPage?.([print(`pumpfun:${mint}`, "backfill-1", START - 3_600_000, "pumpfun")]);
    return { pages: 1, prints: 1, oldestMs: START - 3_600_000, nextCursor: null, stoppedBy: "end" };
  });
  const collector = new FlowCollector({ ledger, now: () => now, log, geckoPoolTrades, fetchPumpTradesPage, walkPumpTradesBack, ...overrides });
  return { collector, ledger, log, geckoPoolTrades, fetchPumpTradesPage, walkPumpTradesBack, advance: (ms: number) => { now += ms; } };
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
