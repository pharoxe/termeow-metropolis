import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chain, FlowPrint, PairRow } from "../../shared/wire.js";
import { UpstreamError } from "../lib/http.js";
import type { MonadOwnTapeStats } from "../tape/monad/ownTape.js";
import {
  FlowCollector,
  GECKO_POLL_MS,
  MAX_SUBSCRIPTIONS,
  GECKO_POLL_SLOW_MS,
  IDLE_MS,
  type CollectorDeps,
  type MonadOwnTapeLike
} from "./collector.js";
import { OWN_FRESH_MS } from "./feedHealth.js";
import { FlowLedger } from "./ledger.js";

const TOKEN = "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01";
const POOL = "0x353f2bd390d8db7bfc9b3dd389f8b71e8df524fa";
const POOL2 = "0x7ba7d2a2000000000000000000000000000000b2";
const CURVE = `nadfun:${TOKEN}`;
const START = 1_800_000_000_000;
/** A healthy own poller: last ok poll now, no backoff. */
const MON_STATS: MonadOwnTapeStats = {
  prints: 2,
  undecoded: 0,
  untimed: 0,
  lastPrintAt: START - 500,
  tokens: 1,
  pools: 1,
  lastError: null,
  poller: { cursor: 10, head: 10, polls: 1, logs: 2, dropped: 0, errors: 0, lastError: null, lastOkAt: START, rpcCalls: 1, blockedUntil: null },
  blocks: { cached: 1, inFlight: 0, hits: 1, misses: 1, failures: 0, lastError: null },
  price: { cached: 1, lastOkAt: START, lastError: null },
  resolve: { lastError: null, decimalsCached: 2 }
};
/** An own poller that never polled successfully: Gecko stays on the fast cadence and no cadence log is written. */
const DOWN_STATS: MonadOwnTapeStats = { ...MON_STATS, lastPrintAt: null, poller: { ...MON_STATS.poller, lastOkAt: null, lastError: "rpc 429 rate limited" } };

function row(pairAddress: string, tier: PairRow["tier"]): PairRow {
  return {
    chain: "monad",
    dex: "uniswap",
    pairAddress,
    baseMint: TOKEN,
    quoteMint: null,
    liquidityUsd: null,
    volume24Usd: null,
    share24: null,
    txns: { m5: null, h1: null, h6: null, h24: null },
    tier,
    sources: ["dexscreener"]
  };
}

function print(pair: string, tx: string, time: number): FlowPrint {
  return { chain: "monad", pair, tx, time, side: "buy", usd: 1, source: "geckoterminal" };
}

function harness(overrides: Partial<CollectorDeps> = {}, stats: MonadOwnTapeStats = DOWN_STATS) {
  let now = START;
  const ledger = new FlowLedger({ now: () => now });
  const log = vi.fn();
  const geckoPoolTrades = vi.fn(async (_chain: Chain, pool: string) => [print(pool, `g-${pool}-${now}`, now)]);
  const tape: { [K in keyof MonadOwnTapeLike]: ReturnType<typeof vi.fn> } = { track: vi.fn(), untrack: vi.fn(), stats: vi.fn(() => stats), stop: vi.fn() };
  const collector = new FlowCollector({ ledger, now: () => now, log, geckoPoolTrades, ownTapeMonad: () => tape, ...overrides });
  return { collector, ledger, log, geckoPoolTrades, tape, advance: (ms: number) => { now += ms; } };
}

const active: FlowCollector[] = [];
function track<T extends { collector: FlowCollector }>(h: T): T {
  active.push(h.collector);
  return h;
}

afterEach(() => {
  while (active.length) active.pop()?.stop();
});

describe("FlowCollector", () => {
  it("starts lazily on first subscribe and stops on stop()", () => {
    const h = track(harness());
    expect(h.collector.isRunning()).toBe(false);
    h.collector.subscribe("monad", TOKEN, [row(POOL, "A")]);
    expect(h.collector.isRunning()).toBe(true);
    h.collector.stop();
    expect(h.collector.isRunning()).toBe(false);
  });

  it("polls Tier A pools every GECKO_POLL_MS, never the curve pseudo-pair or Tier B", async () => {
    const h = track(harness());
    h.collector.subscribe("monad", TOKEN, [row(CURVE, "A"), row(POOL, "A"), row("0xtierb", "B")]);
    await h.collector.tick();
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(1);
    expect(h.geckoPoolTrades).toHaveBeenCalledWith("monad", POOL, { priority: "background", token: TOKEN });
    h.advance(5_000);
    await h.collector.tick();
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(1);
    h.advance(GECKO_POLL_MS - 5_000);
    await h.collector.tick();
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(2);
    expect(h.ledger.pairs()).toContain(`monad:${POOL}`);
    expect(h.ledger.pairs()).not.toContain("monad:0xtierb");
    expect(h.collector.launchMs("monad", TOKEN)).toBeNull();
  });

  it("records per-source health, never throws from a tick, and throttles logs to once per minute", async () => {
    const h = track(harness({
      geckoPoolTrades: async () => { throw new UpstreamError("GeckoTerminal request budget exhausted", 429); }
    }));
    h.collector.subscribe("monad", TOKEN, [row(POOL, "A")]);
    await expect(h.collector.tick()).resolves.toBeUndefined();
    let status = h.collector.status("monad", TOKEN);
    expect(status.sources.geckoterminal).toMatchObject({ lastOkAt: null, lastError: "GeckoTerminal request budget exhausted", lastErrorAt: START });
    expect(h.log).toHaveBeenCalledTimes(1);
    h.advance(GECKO_POLL_MS);
    await h.collector.tick();
    expect(h.log).toHaveBeenCalledTimes(1);
    h.advance(60_000);
    await h.collector.tick();
    expect(h.log).toHaveBeenCalledTimes(2);
    status = h.collector.status("monad", TOKEN);
    expect(status.tierAPairs).toBe(1);
    expect(h.collector.status("monad", "0xunknown")).toMatchObject({ subscribed: false, lastRequestedAt: null, launchMs: null });
  });

  it("evicts a subscription idle past IDLE_MS, keeps its ledger data and remembers its pairs for pairsOf()", async () => {
    const h = track(harness());
    h.collector.subscribe("monad", TOKEN, [row(POOL, "A")]);
    await h.collector.tick();
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(1);
    h.advance(IDLE_MS + 1);
    await h.collector.tick();
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(1);
    expect(h.collector.subscriptions()).toEqual([]);
    expect(h.collector.status("monad", TOKEN).subscribed).toBe(false);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining(`dropping monad:${TOKEN} (idle 90s, idle > 90s)`));
    expect(h.ledger.recentPrints("monad", POOL)).toHaveLength(1);
    expect(h.collector.pairsOf("monad", TOKEN)).toEqual([row(POOL, "A")]);
    expect(h.collector.pairsOf("monad", "0xnever")).toBeNull();
    h.collector.subscribe("monad", TOKEN, [row(POOL2, "A")]);
    await h.collector.tick();
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(2);
    expect(h.collector.pairsOf("monad", TOKEN)).toEqual([row(POOL2, "A")]);
  });

  it("stops one token's Tier A pools from costing Gecko once the next CA is focused and it goes idle", async () => {
    const h = track(harness());
    h.collector.subscribe("monad", "0xfirst", [row("0xf1", "A"), row("0xf2", "A"), row("0xf3", "A"), row("0xf4", "A")]);
    await h.collector.tick();
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(4);
    h.advance(IDLE_MS + 1);
    h.collector.subscribe("monad", "0xsecond", [row("0xs1", "A")]);
    await h.collector.tick();
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(5);
    expect(h.geckoPoolTrades.mock.calls.slice(4).map((call) => call[1])).toEqual(["0xs1"]);
    expect(h.collector.subscriptions()).toEqual(["monad:0xsecond"]);
  });

  it("reports feed health in status()", async () => {
    const h = track(harness({}, MON_STATS));
    h.collector.subscribe("monad", TOKEN, [row(POOL, "A")]);
    await h.collector.tick();
    expect(h.collector.status("monad", TOKEN).feedHealth).toEqual({
      own: { ok: true, lastOkAt: START, lastError: null, nextRetryAt: null },
      gecko: { ok: true, lastOkAt: START, lastError: null, nextRetryAt: null }
    });
    expect(h.collector.status("monad", "0xunknown").feedHealth).toEqual({
      own: { ok: false, lastOkAt: null, lastError: null, nextRetryAt: null },
      gecko: { ok: false, lastOkAt: null, lastError: null, nextRetryAt: null }
    });
  });

  it("caps subscriptions and drops the least recently requested with a log line", () => {
    const h = track(harness());
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i += 1) {
      h.collector.subscribe("monad", `0xmint${i}`, [row(`0xpool${i}`, "A")]);
      h.advance(1000);
    }
    h.collector.subscribe("monad", "0xmint0", [row("0xpool0", "A")]);
    h.advance(1000);
    h.collector.subscribe("monad", "0xfresh", [row("0xpoolfresh", "A")]);
    expect(h.collector.subscriptions()).toHaveLength(MAX_SUBSCRIPTIONS);
    expect(h.collector.subscriptions()).not.toContain("monad:0xmint1");
    expect(h.collector.subscriptions()).toContain("monad:0xmint0");
    expect(h.collector.subscriptions()).toContain("monad:0xfresh");
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("dropping monad:0xmint1"));
  });
});

describe("FlowCollector own tape", () => {
  const registry = () => [row(CURVE, "A"), row(POOL, "A"), row("0xtierb", "B")];

  it("tracks registry rows on every subscribe and reports own-tape health under sources.own", () => {
    const h = track(harness({}, MON_STATS));
    h.collector.subscribe("monad", TOKEN, registry());
    expect(h.tape.track).toHaveBeenCalledWith(TOKEN, registry());
    h.collector.subscribe("monad", TOKEN, [row(POOL, "A")]);
    expect(h.tape.track).toHaveBeenLastCalledWith(TOKEN, [row(POOL, "A")]);
    expect(h.collector.status("monad", TOKEN).sources.own).toEqual({ lastOkAt: START - 500, lastError: null, lastErrorAt: null, tape: MON_STATS });
    expect(h.tape.stats).toHaveBeenCalledWith(TOKEN);
    expect(h.collector.status("monad", "0xunknown").sources.own).toEqual({ lastOkAt: null, lastError: null, lastErrorAt: null, tape: null });
  });

  it("surfaces the poller's error on sources.own", () => {
    const h = track(harness());
    h.collector.subscribe("monad", TOKEN, registry());
    expect(h.collector.status("monad", TOKEN).sources.own).toEqual({ lastOkAt: null, lastError: "rpc 429 rate limited", lastErrorAt: null, tape: DOWN_STATS });
  });

  it("untracks when a subscription goes idle or is evicted, and stops the tape with the collector", async () => {
    const h = track(harness());
    h.collector.subscribe("monad", TOKEN, registry());
    h.advance(IDLE_MS + 1);
    await h.collector.tick();
    expect(h.tape.untrack).toHaveBeenCalledWith(TOKEN);
    await h.collector.tick();
    expect(h.tape.untrack).toHaveBeenCalledTimes(1);
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i += 1) {
      h.collector.subscribe("monad", `0xmint${i}`, [row(`0xpool${i}`, "A")]);
      h.advance(1000);
    }
    h.collector.subscribe("monad", "0xfresh", [row("0xpoolfresh", "A")]);
    expect(h.tape.untrack).toHaveBeenCalledWith("0xmint0");
    h.collector.stop();
    expect(h.tape.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps polling when the tape or its factory throws, and surfaces the fault in sources.own", async () => {
    const h = track(harness());
    h.tape.track.mockImplementation(() => {
      throw new Error("tape down");
    });
    expect(() => h.collector.subscribe("monad", TOKEN, registry())).not.toThrow();
    await expect(h.collector.tick()).resolves.toBeUndefined();
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(1);
    expect(h.collector.status("monad", TOKEN).sources.own).toEqual({ lastOkAt: null, lastError: "tape down", lastErrorAt: START, tape: null });
    expect(h.log).toHaveBeenCalledWith("flow collector: own tape: tape down");
    h.collector.subscribe("monad", TOKEN, registry());
    expect(h.log).toHaveBeenCalledTimes(1);

    const broken = track(harness({ ownTapeMonad: () => { throw new Error("no rpc"); } }));
    broken.collector.subscribe("monad", TOKEN, registry());
    await expect(broken.collector.tick()).resolves.toBeUndefined();
    expect(broken.geckoPoolTrades).toHaveBeenCalledTimes(1);
    expect(broken.collector.status("monad", TOKEN).sources.own).toMatchObject({ lastError: "no rpc", tape: null });
  });
});

describe("FlowCollector gecko cadence", () => {
  it("polls gecko every GECKO_POLL_SLOW_MS while the own poller is healthy and drops to GECKO_POLL_MS when it backs off", async () => {
    const h = track(harness({}, MON_STATS));
    h.collector.subscribe("monad", TOKEN, [row(POOL, "A")]);
    await h.collector.tick();
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledWith(`flow collector: gecko cadence monad:${TOKEN}: slow (60s, own tape healthy)`);
    h.advance(GECKO_POLL_MS);
    h.tape.stats.mockReturnValue({ ...MON_STATS, poller: { ...MON_STATS.poller, lastOkAt: START + GECKO_POLL_MS } });
    h.collector.subscribe("monad", TOKEN, [row(POOL, "A")]);
    await h.collector.tick();
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(1);
    h.advance(GECKO_POLL_SLOW_MS - GECKO_POLL_MS);
    h.tape.stats.mockReturnValue({ ...MON_STATS, poller: { ...MON_STATS.poller, lastOkAt: START + GECKO_POLL_SLOW_MS } });
    h.collector.subscribe("monad", TOKEN, [row(POOL, "A")]);
    await h.collector.tick();
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(2);

    const blockedStats: MonadOwnTapeStats = { ...MON_STATS, poller: { ...MON_STATS.poller, lastOkAt: START + GECKO_POLL_SLOW_MS, lastError: "rpc 429 rate limited", blockedUntil: START + 10 * 60_000 } };
    h.tape.stats.mockReturnValue(blockedStats);
    h.advance(GECKO_POLL_MS);
    h.collector.subscribe("monad", TOKEN, [row(POOL, "A")]);
    await h.collector.tick();
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(3);
    expect(h.collector.status("monad", TOKEN).feedHealth.own).toEqual({ ok: false, lastOkAt: START + GECKO_POLL_SLOW_MS, lastError: "rpc 429 rate limited", nextRetryAt: START + 10 * 60_000 });
    expect(h.log).toHaveBeenCalledWith(`flow collector: gecko cadence monad:${TOKEN}: fast (15s, own tape down)`);
  });

  it("treats a stale own poller (no ok poll within OWN_FRESH_MS) as down and polls gecko fast", async () => {
    const h = track(harness({}, MON_STATS));
    h.collector.subscribe("monad", TOKEN, [row(POOL, "A")]);
    h.advance(OWN_FRESH_MS + 1_000);
    h.collector.subscribe("monad", TOKEN, [row(POOL, "A")]);
    await h.collector.tick();
    expect(h.collector.status("monad", TOKEN).feedHealth.own.ok).toBe(false);
    expect(h.geckoPoolTrades).toHaveBeenCalledTimes(1);
  });
});
