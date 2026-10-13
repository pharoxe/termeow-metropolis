import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chain } from "../../shared/wire.js";
import { FlowLedger } from "../flow/ledger.js";
import type { TokenProfile } from "../sources/dexscreenerProfiles.js";
import type { TokenBatch, TokenBatchRow } from "../sources/dexscreenerTokens.js";
import type { ExtraLeg, LogsHandler, PollerStats, RawLog } from "../tape/monad/poller.js";
import { DEXSCREENER_TOKENS_SOURCE, DISCOVERY_LAUNCHPAD } from "./enrich.js";
import { LaunchIndex } from "./index.js";
import { ADDRESSES, NADFUN_TOPICS, QUOTES } from "./monad/pads.js";
import { BLOCK_MS, MONAD_LAUNCH_SOURCE, MonadLaunchStream, estimateBlockTimeMs, launchPairId } from "./monad/stream.js";
import { ENRICH_BATCH, LaunchService } from "./service.js";

const NOW = 1_800_000_000_000;
const HEAD = 56_030_000;
const MON_USD = 3.5;

const MEAO = "0x90f4707151fde7b2acddc0ef68281d1bffe2e2a5";
const OTHER = "0xe9a58a8a449d57a2d91e59e7d14a07f3c61b95de";
const CREATOR = "0x1111111111111111111111111111111111111111";
const POOL = "0x3333333333333333333333333333333333333333";
const TRADER = "0x4444444444444444444444444444444444444444";

const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const uint = (value: bigint) => value.toString(16).padStart(64, "0");
let logIndex = 0;
function log(topics: string[], data: string, block = HEAD - 10): RawLog {
  logIndex += 1;
  return { address: ADDRESSES.nadfunCurve, topics, data, blockNumber: `0x${block.toString(16)}`, blockHash: "0x0", transactionHash: `0x${logIndex.toString(16)}`, transactionIndex: "0x0", logIndex: `0x${logIndex.toString(16)}` } as RawLog;
}
/** CurveCreate with empty name/symbol/uri heads pointing at zero-length strings. */
function launch(token: string, block = HEAD - 10): RawLog {
  const words = [uint(192n), uint(224n), uint(256n), uint(1n), uint(2n), uint(3n), uint(0n), uint(0n), uint(0n)];
  return log([NADFUN_TOPICS.CurveCreate, topic(CREATOR), topic(token), topic(POOL)], `0x${words.join("")}`, block);
}
function trade(token: string, side: "buy" | "sell", monWei: bigint, tokens: bigint, block = HEAD - 5): RawLog {
  const [amountIn, amountOut] = side === "buy" ? [monWei, tokens] : [tokens, monWei];
  return log([side === "buy" ? NADFUN_TOPICS.CurveBuy : NADFUN_TOPICS.CurveSell, topic(TRADER), topic(token)], `0x${uint(amountIn)}${uint(amountOut)}`, block);
}
function graduate(token: string, block = HEAD - 1): RawLog {
  return log([NADFUN_TOPICS.CurveGraduate, topic(token), topic(POOL)], "0x", block);
}

class FakePoller {
  legs: ExtraLeg[] = [];
  handler: LogsHandler | null = null;
  started = 0;
  stopped = 0;
  setExtraLegs(legs: ExtraLeg[]): void {
    this.legs = legs;
  }
  start(onLogs: LogsHandler): void {
    this.handler = onLogs;
    this.started += 1;
  }
  stop(): void {
    this.stopped += 1;
  }
  stats(): PollerStats {
    return { cursor: HEAD, head: HEAD, polls: 1, logs: 0, dropped: 0, errors: 0, lastError: null, lastOkAt: NOW - 500, rpcCalls: 1, blockedUntil: null };
  }
}

function blockTimeOf(block: number): number {
  return NOW - (HEAD - block) * 400;
}

function stream(overrides: { blocks?: (block: number) => Promise<number | null> } = {}) {
  const index = new LaunchIndex({ now: () => NOW });
  const ledger = new FlowLedger({ now: () => NOW });
  const poller = new FakePoller();
  const timeMs = vi.fn(overrides.blocks ?? (async (block: number) => blockTimeOf(block)));
  const prices = {
    prime: vi.fn(async () => undefined),
    get: (quote: string) => (quote === QUOTES.nativeMon || quote === QUOTES.wmon ? MON_USD : quote === QUOTES.usdc ? 1 : null),
    status: () => ({ cached: 1, lastOkAt: NOW, lastError: null })
  };
  const logFn = vi.fn();
  const s = new MonadLaunchStream({
    index,
    ledger,
    poller,
    blocks: { timeMs, stats: () => ({ cached: 0, inFlight: 0, hits: 0, misses: 0, failures: 0, lastError: null }) },
    prices,
    now: () => NOW,
    log: logFn
  });
  s.start();
  const feed = (logs: RawLog[]) => s.handleLogs(logs, HEAD);
  return { s, index, ledger, poller, timeMs, prices, log: logFn, feed };
}

describe("launchPairId / estimateBlockTimeMs", () => {
  it("keys nad.fun curve tapes by token and gives pads without a curve tape no pair", () => {
    expect(launchPairId("nadfun", MEAO.toUpperCase().replace("0X", "0x"), null)).toBe(`nadfun:${MEAO}`);
    expect(launchPairId("dexscreener-profile", MEAO, null)).toBeNull();
    expect(launchPairId("unknown", MEAO, "0xcurve")).toBeNull();
  });

  it("places a block relative to the head at the Monad block interval and never in the future", () => {
    expect(estimateBlockTimeMs(HEAD, HEAD, NOW)).toBe(NOW);
    expect(estimateBlockTimeMs(HEAD - 1000, HEAD, NOW)).toBe(Math.round(NOW - 1000 * BLOCK_MS));
    expect(estimateBlockTimeMs(HEAD + 5, HEAD, NOW)).toBe(NOW);
  });
});

describe("MonadLaunchStream", () => {
  it("starts the poller with the shared BondingCurve legs: launch + graduation, then trades", () => {
    const { poller } = stream();
    expect(poller.started).toBe(1);
    expect(poller.legs).toHaveLength(2);
    expect(poller.legs[0]).toEqual({ addresses: [ADDRESSES.nadfunCurve], topics: [[NADFUN_TOPICS.CurveCreate, NADFUN_TOPICS.CurveGraduate]] });
    expect(poller.legs[1]).toEqual({ addresses: [ADDRESSES.nadfunCurve], topics: [[NADFUN_TOPICS.CurveBuy, NADFUN_TOPICS.CurveSell]] });
  });

  it("turns a CurveCreate into an index row keyed by the token", async () => {
    const { index, feed, s } = stream();
    await feed([launch(MEAO)]);
    expect(index.get("monad", MEAO)).toMatchObject({ chain: "monad", launchpad: "nadfun", token: MEAO, creator: CREATOR, curve: `nadfun:${MEAO}`, pool: POOL, createdAt: estimateBlockTimeMs(HEAD - 10, HEAD, NOW), sources: [MONAD_LAUNCH_SOURCE] });
    expect(s.stats()).toMatchObject({ launches: 1, emitters: 1 });
  });

  it("prices a MON curve buy for a known token, ingests it on the nadfun pseudo-pair and counts it on the row", async () => {
    const { index, ledger, feed, s } = stream();
    await feed([launch(MEAO), trade(MEAO, "buy", 2n * 10n ** 18n, 10n ** 21n), trade(MEAO, "sell", 10n ** 18n, 10n ** 20n)]);
    const prints = ledger.recentPrints("monad", `nadfun:${MEAO}`);
    expect(prints.map((p) => [p.side, p.usd, p.time]).sort()).toEqual([["buy", 2 * MON_USD, blockTimeOf(HEAD - 5)], ["sell", MON_USD, blockTimeOf(HEAD - 5)]]);
    expect(index.get("monad", MEAO)).toMatchObject({ curveBuys: 1, curveSells: 1, curveNetUsd: MON_USD });
    expect(s.stats()).toMatchObject({ trades: 2, prints: 2, tradesDropped: 0 });
  });

  it("drops trades for unknown tokens before touching the ledger or the block clock", async () => {
    const { feed, s, timeMs } = stream();
    await feed([trade(OTHER, "buy", 10n ** 18n, 1n)]);
    expect(s.stats()).toMatchObject({ trades: 0, tradesDropped: 1, prints: 0 });
    expect(timeMs).not.toHaveBeenCalled();
  });

  it("counts a known-token trade whose block time is unreadable without ingesting it", async () => {
    const { feed, s, index } = stream({ blocks: async () => null });
    await feed([launch(MEAO), trade(MEAO, "buy", 10n ** 18n, 1n)]);
    expect(s.stats()).toMatchObject({ trades: 1, untimed: 1, prints: 0 });
    expect(index.get("monad", MEAO)?.curveBuys).toBe(1);
  });

  it("marks graduations on known rows and retires the curve emitter", async () => {
    const { feed, s, index } = stream();
    await feed([launch(MEAO)]);
    await feed([graduate(MEAO)]);
    expect(index.get("monad", MEAO)).toMatchObject({ graduatedAt: blockTimeOf(HEAD - 1), pool: POOL });
    expect(s.stats()).toMatchObject({ graduations: 1, emitters: 0 });
  });

  it("counts logs it cannot decode", async () => {
    const { feed, s } = stream();
    await feed([log([NADFUN_TOPICS.CurveSync, topic(MEAO)], `0x${uint(1n)}${uint(2n)}${uint(3n)}${uint(4n)}`)]);
    expect(s.stats().undecoded).toBe(1);
  });

  it("never throws out of the poller handler: a failing ledger is recorded and logged once a minute", async () => {
    const { s, poller, log: logFn } = stream();
    const boom = new MonadLaunchStream({
      index: new LaunchIndex({ now: () => NOW }),
      ledger: { ingest: () => { throw new Error("ledger down"); } },
      poller,
      blocks: { timeMs: async () => NOW, stats: () => ({ cached: 0, inFlight: 0, hits: 0, misses: 0, failures: 0, lastError: null }) },
      prices: { prime: async () => undefined, get: () => 1, status: () => ({ cached: 0, lastOkAt: null, lastError: null }) },
      now: () => NOW,
      log: logFn
    });
    boom.start();
    expect(poller.handler).not.toBeNull();
    poller.handler?.([launch(MEAO), trade(MEAO, "buy", 10n ** 18n, 1n)], HEAD);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(boom.stats().lastError).toBe("logs: ledger down");
    expect(logFn).toHaveBeenCalledWith("monad launch stream: logs: ledger down");
    expect(s.stats().lastError).toBeNull();
  });
});

// ---- LaunchService ----

function profile(chain: TokenProfile["chain"], address: string, icon: string | null = "https://cdn.dexscreener.com/i.png"): TokenProfile {
  return { chain, address, icon, description: null, links: [], url: `https://dexscreener.com/${chain}/${address}`, boostTotal: null };
}

function batchRow(overrides: Partial<TokenBatchRow> = {}): TokenBatchRow {
  return {
    symbol: "MEAO",
    name: "Make Everyone An Owner",
    image: "https://img/meao.png",
    priceUsd: 0.0000123,
    marketCapUsd: 12_300,
    fdvUsd: 12_300,
    liquidityUsd: 4_000,
    volume24Usd: 9_000,
    change24Pct: 12.5,
    pairAddress: "0xpair",
    dex: "uniswap",
    pairCreatedAt: NOW - 3_600_000,
    ...overrides
  };
}

function service(overrides: Partial<ConstructorParameters<typeof LaunchService>[0]> = {}) {
  const index = new LaunchIndex({ now: () => NOW });
  const monad = { start: vi.fn(), stop: vi.fn(), stats: vi.fn(() => ({ poller: { lastOkAt: NOW - 100, lastError: null } }) as never) };
  const log = vi.fn();
  const svc = new LaunchService({
    index,
    now: () => NOW,
    log,
    monad: () => monad,
    fetchProfiles: async () => [],
    fetchBoosts: async () => [],
    fetchTokenBatches: async () => new Map() as TokenBatch,
    erc20Meta: { resolve: async () => null },
    refreshMs: 60_000,
    ...overrides
  });
  return { svc, index, monad, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LaunchService lifecycle", () => {
  it("starts the Monad feed once, runs a refresh immediately, and stops it", async () => {
    const fetchProfiles = vi.fn(async () => [] as TokenProfile[]);
    const { svc, monad } = service({ fetchProfiles });
    svc.start();
    svc.start();
    await Promise.resolve();
    expect(monad.start).toHaveBeenCalledTimes(1);
    expect(fetchProfiles).toHaveBeenCalledTimes(1);
    expect(svc.status().started).toBe(true);
    svc.stop();
    expect(monad.stop).toHaveBeenCalledTimes(1);
    expect(svc.status().started).toBe(false);
  });

  it("survives a feed factory that throws and reports it as that source's error", () => {
    const { svc, log } = service({ monad: () => { throw new Error("no rpc"); } });
    svc.start();
    const rpc = svc.status().sources.find((source) => source.name === MONAD_LAUNCH_SOURCE);
    expect(rpc).toEqual({ name: MONAD_LAUNCH_SOURCE, lastOkAt: null, lastError: "no rpc" });
    expect(log).toHaveBeenCalledWith("launch service: rpc:monad: no rpc");
    expect(svc.status().monad).toBeNull();
    svc.stop();
  });
});

describe("LaunchService discovery and enrichment", () => {
  it("creates honestly labelled discovery rows for unknown profile/boost tokens and only decorates known ones", async () => {
    const known = "0xaaaa000000000000000000000000000000000001";
    const fresh = "0xbbbb000000000000000000000000000000000002";
    const boosted = "0xeeee000000000000000000000000000000000005";
    const { svc, index } = service({
      fetchProfiles: async () => [profile("monad", known), profile("monad", fresh), profile(null, "0xother")],
      fetchBoosts: async () => [profile("monad", boosted, null)]
    });
    index.upsert({ chain: "monad", token: known, launchpad: "nadfun", createdAt: NOW - 1000, tx: "0xtx", sources: [MONAD_LAUNCH_SOURCE] });
    await svc.refresh();
    expect(index.get("monad", known)).toMatchObject({ launchpad: "nadfun", image: "https://cdn.dexscreener.com/i.png", sources: [MONAD_LAUNCH_SOURCE, "dexscreener token-profiles"] });
    expect(index.get("monad", fresh)).toMatchObject({ launchpad: DISCOVERY_LAUNCHPAD, createdAt: NOW, tx: "", sources: ["dexscreener token-profiles"] });
    expect(index.get("monad", boosted)).toMatchObject({ launchpad: DISCOVERY_LAUNCHPAD, image: null, sources: ["dexscreener token-boosts"] });
    expect(index.stats().rows).toBe(3);
  });

  it("enriches the newest tokens per chain from DexScreener batches, keyed case-insensitively", async () => {
    const fetchTokenBatches = vi.fn(async (chain: Chain, addresses: string[]): Promise<TokenBatch> =>
      chain === "monad" && addresses.map((address) => address.toLowerCase()).includes(MEAO) ? new Map([[MEAO, batchRow()]]) : new Map()
    );
    const { svc, index } = service({ fetchTokenBatches });
    index.upsert({ chain: "monad", token: MEAO.toUpperCase().replace("0X", "0x"), launchpad: "nadfun", createdAt: NOW - 1000, tx: "0xtx" });
    await svc.refresh();
    expect(fetchTokenBatches).toHaveBeenCalledTimes(1);
    expect(index.get("monad", MEAO)).toMatchObject({
      launchpad: "nadfun",
      symbol: "MEAO",
      name: "Make Everyone An Owner",
      image: "https://img/meao.png",
      pool: "0xpair",
      priceUsd: 0.0000123,
      marketCapUsd: 12_300,
      liquidityUsd: 4_000,
      volume24Usd: 9_000,
      change24Pct: 12.5,
      pricedAt: NOW,
      createdAt: NOW - 1000
    });
    expect(index.get("monad", MEAO)?.sources).toContain(DEXSCREENER_TOKENS_SOURCE);
  });

  it("rotates the enrichment batch by staleness so a fast pad cannot starve older rows of price refreshes", async () => {
    const sent: string[][] = [];
    const fetchTokenBatches = vi.fn(async (_chain: Chain, addresses: string[]): Promise<TokenBatch> => {
      sent.push(addresses);
      return new Map();
    });
    let clock = NOW;
    const index = new LaunchIndex({ now: () => clock });
    const { svc } = service({ index, now: () => clock, fetchTokenBatches });
    const token = (i: number) => `0x${String(i).padStart(40, "0")}`;
    for (let i = 0; i < ENRICH_BATCH + 10; i += 1) index.upsert({ chain: "monad", token: token(i), launchpad: "nadfun", createdAt: NOW - i * 1_000, tx: "0x" });
    await svc.refresh();
    expect(sent[0]).toHaveLength(ENRICH_BATCH);
    expect(sent[0]![0]).toBe(token(0));
    expect(sent[0]).not.toContain(token(ENRICH_BATCH));

    clock = NOW + 60_000;
    for (let i = ENRICH_BATCH + 10; i < ENRICH_BATCH + 15; i += 1) index.upsert({ chain: "monad", token: token(i), launchpad: "nadfun", createdAt: clock - (ENRICH_BATCH + 15 - i), tx: "0x" });
    await svc.refresh();
    const second = sent[1]!;
    expect(second.slice(0, 5)).toEqual([token(ENRICH_BATCH + 14), token(ENRICH_BATCH + 13), token(ENRICH_BATCH + 12), token(ENRICH_BATCH + 11), token(ENRICH_BATCH + 10)]);
    expect(second.slice(5, 15)).toEqual(Array.from({ length: 10 }, (_, k) => token(ENRICH_BATCH + k)));
    expect(second.slice(15)).toEqual(Array.from({ length: ENRICH_BATCH - 15 }, (_, k) => token(k)));
    expect(second).toHaveLength(ENRICH_BATCH);
  });

  it("dates discovery rows by the DexScreener pair creation but never rewinds on-chain launches", async () => {
    const discovered = "0xcccc000000000000000000000000000000000003";
    const { svc, index } = service({
      fetchProfiles: async () => [profile("monad", discovered)],
      fetchTokenBatches: async (chain) => (chain === "monad" ? new Map([[discovered, batchRow({ pairCreatedAt: NOW - 7_200_000 })]]) : new Map())
    });
    await svc.refresh();
    expect(index.get("monad", discovered)?.createdAt).toBe(NOW - 7_200_000);
  });

  it("records per-source health: failures are stored and logged once a minute, stale last-good keeps lastOkAt", async () => {
    const { svc, log } = service({
      fetchProfiles: async () => { throw new Error("profiles 429"); }
    });
    await svc.refresh();
    await svc.refresh();
    const byName = new Map(svc.status().sources.map((source) => [source.name, source]));
    expect(byName.get("dexscreener token-profiles")).toEqual({ name: "dexscreener token-profiles", lastOkAt: null, lastError: "profiles 429" });
    expect(byName.get("dexscreener token-boosts")).toEqual({ name: "dexscreener token-boosts", lastOkAt: NOW, lastError: null });
    expect(log.mock.calls.filter(([message]) => String(message).includes("profiles 429"))).toHaveLength(1);
  });

  it("reports chain-feed health from the stream stats", () => {
    const { svc } = service();
    svc.start();
    const byName = new Map(svc.status().sources.map((source) => [source.name, source]));
    expect(byName.get(MONAD_LAUNCH_SOURCE)).toEqual({ name: MONAD_LAUNCH_SOURCE, lastOkAt: NOW - 100, lastError: null });
    expect(svc.status().sources).toHaveLength(5);
    svc.stop();
  });
});

describe("LaunchService.curvePairsFor", () => {
  it("offers the nad.fun pseudo-pair for Monad curve tokens and nothing otherwise", () => {
    const { svc, index } = service();
    index.upsert({ chain: "monad", token: MEAO, launchpad: "nadfun", curve: `nadfun:${MEAO}`, createdAt: NOW, tx: "0x" });
    index.upsert({ chain: "monad", token: "0xprofile", launchpad: DISCOVERY_LAUNCHPAD, createdAt: NOW, tx: "" });
    expect(svc.curvePairsFor("monad", MEAO.toUpperCase().replace("0X", "0x"))).toEqual([{ dex: "nadfun", pairAddress: `nadfun:${MEAO}`, liquidityUsd: null, volume24Usd: null }]);
    expect(svc.curvePairsFor("monad", "0xprofile")).toEqual([]);
    expect(svc.curvePairsFor("monad", "0xunknown")).toEqual([]);
  });

  it("stops offering the curve pseudo-pair once the token has graduated to a real pool", () => {
    const { svc, index } = service();
    index.upsert({ chain: "monad", token: MEAO, launchpad: "nadfun", curve: `nadfun:${MEAO}`, createdAt: NOW, tx: "0x" });
    expect(svc.curvePairsFor("monad", MEAO)).toHaveLength(1);
    index.recordGraduation("monad", MEAO, NOW + 1, "0xv3pool");
    expect(svc.curvePairsFor("monad", MEAO)).toEqual([]);
  });
});
