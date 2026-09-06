import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chain } from "../../shared/wire.js";
import { FlowLedger } from "../flow/ledger.js";
import type { TokenProfile } from "../sources/dexscreenerProfiles.js";
import type { TokenBatch, TokenBatchRow } from "../sources/dexscreenerTokens.js";
import { TRENCHES_SOURCE, type TrenchToken, type TrenchTokensResult } from "../sources/trenches.js";
import type { ExtraLeg, LogsHandler, PollerStats, RawLog } from "../tape/robinhood/poller.js";
import { DEXSCREENER_TOKENS_SOURCE, DISCOVERY_LAUNCHPAD, PUMPPORTAL_SOURCE } from "./enrich.js";
import { LaunchIndex, UNKNOWN_LAUNCHPAD } from "./index.js";
import { ADDRESSES, QUOTES } from "./robinhood/pads.js";
import { ROBINHOOD_LAUNCH_SOURCE, RobinhoodLaunchStream, estimateBlockTimeMs, launchPairId } from "./robinhood/stream.js";
import { ENRICH_BATCH, LaunchService } from "./service.js";
import { parseCreateFrame, type SolanaLaunch } from "./solana/pumpportal.js";

const NOW = 1_800_000_000_000;
const HEAD = 56_030_000;
const ETH_USD = 4_000;

function fixture(name: string): RawLog[] {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), "utf8")) as RawLog[];
}

const PONS_LAUNCH = fixture("pons-TokenLaunched");
const CURVE_BUY = fixture("pons-curve-CurveBuy");
const CURVE_SELL = fixture("pons-curve-CurveSell");
const POOL_GRADUATED = fixture("pons-PoolGraduated");
const FLAP_BOUGHT = fixture("flap-TokenBought");
const TRENCH_CREATE = fixture("trench-TokenCreate");
const TRENCH_PURCHASE = fixture("trench-TokenPurchase");

const MEAO = "0x90f4707151fde7b2acddc0ef68281d1bffe2e2a5";
const MEAO_CURVE = "0x9a6d239adb8ccf1e9eb8f0722cfac6bbda410b7b";
const ETH_TOKEN = "0xe9a58a8a449d57a2d91e59e7d14a07f3c61b95de";
const ETH_CURVE = "0xc8dcae0c56ce86a3a776af1000cf7d9bfc6a8f13";
const GRADUATED = "0x8f5ef8c3d77c1b89fda82fc910ede9f809de524b";

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
  return NOW - (HEAD - block) * 100;
}

function stream(overrides: { blocks?: (block: number) => Promise<number | null>; maxEmitters?: number } = {}) {
  const index = new LaunchIndex({ now: () => NOW });
  const ledger = new FlowLedger({ now: () => NOW });
  const poller = new FakePoller();
  const timeMs = vi.fn(overrides.blocks ?? (async (block: number) => blockTimeOf(block)));
  const prices = {
    prime: vi.fn(async () => undefined),
    get: (quote: string) => (quote === QUOTES.usdg ? 1 : quote === QUOTES.nativeEth || quote === QUOTES.weth ? ETH_USD : null),
    status: () => ({ cached: 1, lastOkAt: NOW, lastError: null })
  };
  const log = vi.fn();
  const s = new RobinhoodLaunchStream({
    index,
    ledger,
    poller,
    blocks: { timeMs, stats: () => ({ cached: 0, inFlight: 0, hits: 0, misses: 0, failures: 0, lastError: null }) },
    prices,
    now: () => NOW,
    log,
    ...(overrides.maxEmitters !== undefined ? { maxEmitters: overrides.maxEmitters } : {})
  });
  s.start();
  const feed = (logs: RawLog[]) => s.handleLogs(logs, HEAD);
  return { s, index, ledger, poller, timeMs, prices, log, feed };
}

describe("launchPairId / estimateBlockTimeMs", () => {
  it("prefixes curve emitters for Pons/Bags, tokens for Flap/Trench, and null for pads without a curve tape", () => {
    expect(launchPairId("pons", MEAO, MEAO_CURVE.toUpperCase())).toBe(`pons:${MEAO_CURVE}`);
    expect(launchPairId("bags", "0xT", "0xAmm")).toBe("bags:0xamm");
    expect(launchPairId("flap", "0xToKen", null)).toBe("flap:0xtoken");
    expect(launchPairId("trench", "0xToKen", "0xcurve")).toBe("trench:0xtoken");
    expect(launchPairId("pons", MEAO, null)).toBeNull();
    expect(launchPairId("pools-trade", MEAO, null)).toBeNull();
    expect(launchPairId("pump.fun", "mint", null)).toBeNull();
  });

  it("places a block relative to the head at ~100ms per block and never in the future", () => {
    expect(estimateBlockTimeMs(HEAD, HEAD, NOW)).toBe(NOW);
    expect(estimateBlockTimeMs(HEAD - 1000, HEAD, NOW)).toBe(NOW - Math.round(1000 * 100.7));
    expect(estimateBlockTimeMs(HEAD + 5, HEAD, NOW)).toBe(NOW);
  });
});

describe("RobinhoodLaunchStream legs", () => {
  it("starts the poller with factory, router and (empty) emitter legs and re-sends legs once a curve is learned", async () => {
    const { poller, feed } = stream();
    expect(poller.started).toBe(1);
    expect(poller.legs).toHaveLength(3);
    expect(poller.legs[0].addresses).toContain(ADDRESSES.ponsFactory);
    expect(poller.legs[0].addresses).toContain(ADDRESSES.bagsFactory);
    expect(poller.legs[1].addresses).toEqual([ADDRESSES.flapRouter, ADDRESSES.trenchProxy]);
    expect(poller.legs[2].addresses).toEqual([]);
    await feed([PONS_LAUNCH[0]]);
    expect(poller.legs[2].addresses).toEqual([MEAO_CURVE]);
    expect(poller.legs[2].topics[0]).toHaveLength(4);
  });

  it("bounds the emitter set and drops the least recently active curve first", async () => {
    const { poller, feed, s } = stream({ maxEmitters: 2 });
    await feed(PONS_LAUNCH.slice(0, 3));
    expect(s.stats().emitters).toBe(2);
    expect(poller.legs[2].addresses).not.toContain(MEAO_CURVE);
  });

  it("re-sends the filter when a launch at the cap swaps one emitter for another (same size, new membership)", async () => {
    const { poller, feed } = stream({ maxEmitters: 2 });
    await feed(PONS_LAUNCH.slice(0, 2));
    const before = [...poller.legs[2].addresses];
    await feed([PONS_LAUNCH[2]]);
    expect(poller.legs[2].addresses).toHaveLength(2);
    expect(poller.legs[2].addresses).not.toEqual(before);
    expect(poller.legs[2].addresses).toContain("0x1b9bbd7ef3de430534e766bf5ab234be035880db");
    // A trade on an already-known curve changes nothing and does not re-send.
    const sent = poller.legs;
    await feed([CURVE_BUY[1]]);
    expect(poller.legs).toBe(sent);
  });
});

describe("RobinhoodLaunchStream events", () => {
  it("turns a Pons TokenLaunched fixture into an index row keyed by the token", async () => {
    const { index, feed, s } = stream();
    await feed([PONS_LAUNCH[0]]);
    const row = index.get("robinhood", MEAO);
    expect(row).toMatchObject({
      chain: "robinhood",
      launchpad: "pons",
      token: MEAO,
      creator: "0xa60e892ab5fbf4754e3052b7643e48a1bd6b3065",
      curve: MEAO_CURVE,
      tx: PONS_LAUNCH[0].transactionHash,
      curveBuys: 0,
      sources: [ROBINHOOD_LAUNCH_SOURCE]
    });
    expect(row?.createdAt).toBe(estimateBlockTimeMs(0x356e917, HEAD, NOW));
    expect(s.stats().launches).toBe(1);
  });

  it("ingests a USDG curve buy for a known token as a priced ledger print and counts it on the row", async () => {
    const { index, ledger, feed, timeMs } = stream();
    await feed([PONS_LAUNCH[0], CURVE_BUY[0]]);
    const pair = `pons:${MEAO_CURVE}`;
    const prints = ledger.recentPrints("robinhood", pair);
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({ chain: "robinhood", pair, tx: CURVE_BUY[0].transactionHash, side: "buy", source: "own", time: blockTimeOf(0x356e917) });
    expect(prints[0].usd).toBeCloseTo(1246.982306, 6);
    expect(index.get("robinhood", MEAO)).toMatchObject({ curveBuys: 1, curveSells: 0 });
    expect(index.get("robinhood", MEAO)?.curveNetUsd).toBeCloseTo(1246.982306, 6);
    expect(timeMs).toHaveBeenCalledTimes(1);
  });

  it("prices a native-ETH curve trade through the quote price and a sell subtracts from the net", async () => {
    const { index, ledger, feed } = stream();
    await feed([PONS_LAUNCH[1], CURVE_BUY[1]]);
    const print = ledger.recentPrints("robinhood", `pons:${ETH_CURVE}`)[0];
    expect(print.usd).toBeCloseTo(0.001 * ETH_USD, 9);
    await feed([PONS_LAUNCH[0], CURVE_SELL[0]]);
    const row = index.get("robinhood", MEAO);
    expect(row).toMatchObject({ curveBuys: 0, curveSells: 1 });
    expect(row?.curveNetUsd).toBeCloseTo(-1376.554471, 6);
    expect(ledger.recentPrints("robinhood", `pons:${MEAO_CURVE}`)[0].side).toBe("sell");
    expect(index.get("robinhood", ETH_TOKEN)?.curveBuys).toBe(1);
  });

  it("drops trades for unknown tokens before touching the ledger or the block clock", async () => {
    const { index, ledger, feed, timeMs, s } = stream();
    await feed([CURVE_BUY[0], FLAP_BOUGHT[0]]);
    expect(ledger.pairs()).toEqual([]);
    expect(timeMs).not.toHaveBeenCalled();
    expect(index.stats().rows).toBe(0);
    // The curve buy cannot even decode (its emitter was never learned); the router-emitted Flap buy decodes and is dropped.
    expect(s.stats()).toMatchObject({ trades: 0, tradesDropped: 1, undecoded: 1, prints: 0 });
  });

  it("counts a known-token trade whose block time is unreadable without ingesting it", async () => {
    const { index, ledger, feed, s } = stream({ blocks: async () => null });
    await feed([PONS_LAUNCH[0], CURVE_BUY[0]]);
    expect(index.get("robinhood", MEAO)?.curveBuys).toBe(1);
    expect(ledger.pairs()).toEqual([]);
    expect(s.stats()).toMatchObject({ trades: 1, untimed: 1, prints: 0 });
  });

  it("marks graduations on known rows and retires the curve emitter", async () => {
    const { index, feed, poller, s } = stream();
    await feed([POOL_GRADUATED[0]]);
    expect(index.get("robinhood", GRADUATED)).toBeNull();
    index.upsert({ chain: "robinhood", token: GRADUATED, launchpad: "pons", curve: "0xcurve", createdAt: NOW - 1000, tx: "0xlaunch" });
    await feed([PONS_LAUNCH[0], POOL_GRADUATED[0]]);
    expect(index.get("robinhood", GRADUATED)?.graduatedAt).toBe(blockTimeOf(0x356e91b));
    expect(poller.legs[2].addresses).toEqual([MEAO_CURVE]);
    expect(s.stats().graduations).toBe(2);
  });

  it("keeps a Trench trade unpriced (stock quote) but still counts it and ingests it under the trench pseudo-pair", async () => {
    const { index, ledger, feed } = stream();
    await feed([TRENCH_CREATE[0], TRENCH_PURCHASE[0]]);
    const token = "0x9b86fd810bbc0f8de0977838208ef4ed8437cccc";
    expect(index.get("robinhood", token)).toMatchObject({ launchpad: "trench", curveBuys: 1, curveNetUsd: null });
    const print = ledger.recentPrints("robinhood", `trench:${token}`)[0];
    expect(print).toMatchObject({ side: "buy", usd: null });
  });

  it("never throws out of the poller handler: a failing ledger is recorded and logged once a minute", async () => {
    const { s, poller, log, feed } = stream();
    await feed([PONS_LAUNCH[0]]);
    const boom = new RobinhoodLaunchStream({
      index: new LaunchIndex({ now: () => NOW }),
      ledger: { ingest: () => { throw new Error("ledger down"); } },
      poller,
      blocks: { timeMs: async () => NOW, stats: () => ({ cached: 0, inFlight: 0, hits: 0, misses: 0, failures: 0, lastError: null }) },
      prices: { prime: async () => undefined, get: () => 1, status: () => ({ cached: 0, lastOkAt: null, lastError: null }) },
      now: () => NOW,
      log
    });
    boom.start();
    expect(poller.handler).not.toBeNull();
    poller.handler?.([PONS_LAUNCH[0], CURVE_BUY[0]], HEAD);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(boom.stats().lastError).toBe("logs: ledger down");
    expect(log).toHaveBeenCalledWith("robinhood launch stream: logs: ledger down");
    expect(s.stats().lastError).toBeNull();
  });
});

// ---- LaunchService ----

const CREATE_FRAME = {
  signature: "5igNature",
  mint: "43F8mXf6iejR6VLQmD65UAg49MpL5yL8suHGtUj4pump",
  traderPublicKey: "GSENXFmXHcKApbBKg5fqjwtkEaigHp8q63vAudp2t4g9",
  txType: "create",
  initialBuy: 3485709.524202,
  solAmount: 0.097774557,
  bondingCurveKey: "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s",
  marketCapSol: 30.5,
  name: "Fixture",
  symbol: "FIX",
  uri: "https://ipfs.io/ipfs/x",
  is_mayhem_mode: true,
  pool: "pump"
};

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

function trench(overrides: Partial<TrenchToken> = {}): TrenchToken {
  return {
    address: MEAO,
    symbol: "MEAO",
    name: "meao",
    isStock: false,
    traders: 24,
    buyers: 24,
    usdIn: 34_155.94,
    usdOut: 0,
    netUsd: 34_155.94,
    firstAt: NOW - 2_000_000,
    lastAt: NOW - 1_000,
    priceUsd: 0.0000037,
    liquidityUsd: 30.04,
    change24Pct: 807,
    volume24Usd: 82_603.7,
    pairUrl: null,
    pairCreatedAt: NOW - 2_100_000,
    buys24: 197,
    sells24: 10,
    honeypot: true,
    firstBuyer: { at: NOW - 2_000_000, priceUsd: 4.15e-7, handle: "fmpumpguy", followers: 65_621 },
    sinceFirstBuyPct: 790,
    holders: 24,
    ...overrides
  };
}

function trenchResult(rows: TrenchToken[], extra: Partial<TrenchTokensResult> = {}): TrenchTokensResult {
  return { rows, source: TRENCHES_SOURCE, window: "24h", observedAt: NOW, stale: false, ...extra };
}

type PumpHook = (launch: SolanaLaunch) => void;

function service(overrides: Partial<ConstructorParameters<typeof LaunchService>[0]> = {}) {
  const index = new LaunchIndex({ now: () => NOW });
  const hooks: { pump: PumpHook | null } = { pump: null };
  const robinhood = { start: vi.fn(), stop: vi.fn(), stats: vi.fn(() => ({ poller: { lastOkAt: NOW - 100, lastError: null } }) as never) };
  const pump = { start: vi.fn(), stop: vi.fn(), status: vi.fn(() => ({ connected: true, launches: 0, reconnects: 0, framesSeen: 1, lastFrameAt: NOW - 50, lastLaunchAt: null, lastError: null })) };
  const log = vi.fn();
  const svc = new LaunchService({
    index,
    now: () => NOW,
    log,
    robinhood: () => robinhood,
    pumpportal: (onLaunch) => {
      hooks.pump = onLaunch;
      return pump;
    },
    fetchProfiles: async () => [],
    fetchBoosts: async () => [],
    fetchTokenBatches: async () => new Map() as TokenBatch,
    fetchTrenchTokens: async () => trenchResult([]),
    refreshMs: 60_000,
    ...overrides
  });
  return { svc, index, hooks, robinhood, pump, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LaunchService lifecycle", () => {
  it("starts both chain feeds once, runs a refresh immediately, and stops them", async () => {
    const fetchProfiles = vi.fn(async () => [] as TokenProfile[]);
    const { svc, robinhood, pump } = service({ fetchProfiles });
    svc.start();
    svc.start();
    await Promise.resolve();
    expect(robinhood.start).toHaveBeenCalledTimes(1);
    expect(pump.start).toHaveBeenCalledTimes(1);
    expect(fetchProfiles).toHaveBeenCalledTimes(1);
    expect(svc.status().started).toBe(true);
    svc.stop();
    expect(robinhood.stop).toHaveBeenCalledTimes(1);
    expect(pump.stop).toHaveBeenCalledTimes(1);
    expect(svc.status().started).toBe(false);
  });

  it("survives a feed factory that throws and reports it as that source's error", () => {
    const { svc, log } = service({ robinhood: () => { throw new Error("no rpc"); } });
    svc.start();
    const rpc = svc.status().sources.find((source) => source.name === ROBINHOOD_LAUNCH_SOURCE);
    expect(rpc).toEqual({ name: ROBINHOOD_LAUNCH_SOURCE, lastOkAt: null, lastError: "no rpc" });
    expect(log).toHaveBeenCalledWith("launch service: rpc:robinhood: no rpc");
    expect(svc.status().robinhood).toBeNull();
    svc.stop();
  });
});

describe("LaunchService Solana", () => {
  it("upserts PumpPortal creates as pump.fun rows", () => {
    const { svc, hooks, index } = service();
    svc.start();
    const launch = parseCreateFrame(CREATE_FRAME, NOW - 5_000);
    expect(launch).not.toBeNull();
    hooks.pump?.(launch as SolanaLaunch);
    expect(index.get("solana", CREATE_FRAME.mint)).toMatchObject({
      chain: "solana",
      launchpad: "pump.fun",
      token: CREATE_FRAME.mint,
      creator: CREATE_FRAME.traderPublicKey,
      curve: CREATE_FRAME.bondingCurveKey,
      name: "Fixture",
      symbol: "FIX",
      createdAt: NOW - 5_000,
      tx: "5igNature",
      sources: [PUMPPORTAL_SOURCE]
    });
    expect(svc.list({ chain: "solana", windowMs: 60_000 })).toHaveLength(1);
    expect(svc.curvePairsFor("solana", CREATE_FRAME.mint)).toEqual([]);
    svc.stop();
  });
});

describe("LaunchService discovery and enrichment", () => {
  it("creates honestly labelled discovery rows for unknown profile/boost tokens and only decorates known ones", async () => {
    const known = "0xaaaa000000000000000000000000000000000001";
    const fresh = "0xbbbb000000000000000000000000000000000002";
    const { svc, index } = service({
      fetchProfiles: async () => [profile("robinhood", known), profile("robinhood", fresh), profile(null, "0xother")],
      fetchBoosts: async () => [profile("solana", "BoostMint1111111111111111111111111111111111", null)]
    });
    index.upsert({ chain: "robinhood", token: known, launchpad: "pons", createdAt: NOW - 1000, tx: "0xtx", sources: [ROBINHOOD_LAUNCH_SOURCE] });
    await svc.refresh();
    expect(index.get("robinhood", known)).toMatchObject({ launchpad: "pons", image: "https://cdn.dexscreener.com/i.png", sources: [ROBINHOOD_LAUNCH_SOURCE, "dexscreener token-profiles"] });
    expect(index.get("robinhood", fresh)).toMatchObject({ launchpad: DISCOVERY_LAUNCHPAD, createdAt: NOW, tx: "", sources: ["dexscreener token-profiles"] });
    expect(index.get("solana", "BoostMint1111111111111111111111111111111111")).toMatchObject({ launchpad: DISCOVERY_LAUNCHPAD, image: null, sources: ["dexscreener token-boosts"] });
    expect(index.stats().rows).toBe(3);
  });

  it("enriches the newest tokens per chain from DexScreener batches, keyed case-insensitively", async () => {
    const fetchTokenBatches = vi.fn(async (chain: Chain, addresses: string[]): Promise<TokenBatch> =>
      chain === "robinhood" && addresses.map((address) => address.toLowerCase()).includes(MEAO) ? new Map([[MEAO, batchRow()]]) : new Map()
    );
    const { svc, index } = service({ fetchTokenBatches });
    index.upsert({ chain: "robinhood", token: MEAO.toUpperCase().replace("0X", "0x"), launchpad: "pons", createdAt: NOW - 1000, tx: "0xtx" });
    await svc.refresh();
    expect(fetchTokenBatches).toHaveBeenCalledTimes(1);
    expect(index.get("robinhood", MEAO)).toMatchObject({
      launchpad: "pons",
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
    expect(index.get("robinhood", MEAO)?.sources).toContain(DEXSCREENER_TOKENS_SOURCE);
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
    for (let i = 0; i < ENRICH_BATCH + 10; i += 1) index.upsert({ chain: "robinhood", token: token(i), launchpad: "pons", createdAt: NOW - i * 1_000, tx: "0x" });
    await svc.refresh();
    expect(sent[0]).toHaveLength(ENRICH_BATCH);
    expect(sent[0]![0]).toBe(token(0));
    expect(sent[0]).not.toContain(token(ENRICH_BATCH));

    clock = NOW + 60_000;
    for (let i = ENRICH_BATCH + 10; i < ENRICH_BATCH + 15; i += 1) index.upsert({ chain: "robinhood", token: token(i), launchpad: "pons", createdAt: clock - (ENRICH_BATCH + 15 - i), tx: "0x" });
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
      fetchProfiles: async () => [profile("robinhood", discovered)],
      fetchTokenBatches: async (chain) => (chain === "robinhood" ? new Map([[discovered, batchRow({ pairCreatedAt: NOW - 7_200_000 })]]) : new Map())
    });
    await svc.refresh();
    expect(index.get("robinhood", discovered)?.createdAt).toBe(NOW - 7_200_000);
  });

  it("merges robinhoodtrenches into `tracked` with the population label and creates unknown tokens as launchpad unknown", async () => {
    const other = "0xdddd000000000000000000000000000000000004";
    const { svc, index } = service({ fetchTrenchTokens: async () => trenchResult([trench(), trench({ address: other, isStock: true, buyers: null })]) });
    index.upsert({ chain: "robinhood", token: MEAO, launchpad: "pons", createdAt: NOW - 1000, tx: "0xtx" });
    await svc.refresh();
    const meao = index.get("robinhood", MEAO);
    expect(meao).toMatchObject({ launchpad: "pons", createdAt: NOW - 1000, symbol: "MEAO", name: "meao" });
    expect(meao?.tracked).toEqual({ buyers: 24, usdIn: 34_155.94, usdOut: 0, firstBuyer: { handle: "fmpumpguy", followers: 65_621, at: NOW - 2_000_000 }, honeypot: true });
    expect(meao?.sources).toContain(TRENCHES_SOURCE);
    expect(index.get("robinhood", other)).toMatchObject({ launchpad: UNKNOWN_LAUNCHPAD, createdAt: NOW - 2_100_000, tracked: null });
    expect(svc.list({ chain: "robinhood", windowMs: 24 * 3_600_000, includeStocks: false }).map((row) => row.token)).toEqual([MEAO]);
    expect(svc.list({ chain: "robinhood", windowMs: 24 * 3_600_000, includeStocks: true })).toHaveLength(2);
  });

  it("records per-source health: failures are stored and logged once a minute, stale last-good keeps lastOkAt", async () => {
    const { svc, log } = service({
      fetchProfiles: async () => { throw new Error("profiles 429"); },
      fetchTrenchTokens: async () => trenchResult([], { stale: true, error: "trenches 503" })
    });
    await svc.refresh();
    await svc.refresh();
    const byName = new Map(svc.status().sources.map((source) => [source.name, source]));
    expect(byName.get("dexscreener token-profiles")).toEqual({ name: "dexscreener token-profiles", lastOkAt: null, lastError: "profiles 429" });
    expect(byName.get(TRENCHES_SOURCE)).toEqual({ name: TRENCHES_SOURCE, lastOkAt: null, lastError: "trenches 503" });
    expect(byName.get("dexscreener token-boosts")).toEqual({ name: "dexscreener token-boosts", lastOkAt: NOW, lastError: null });
    expect(log.mock.calls.filter(([message]) => String(message).includes("profiles 429"))).toHaveLength(1);
  });

  it("reports chain-feed health from the stream and socket stats", () => {
    const { svc } = service();
    svc.start();
    const byName = new Map(svc.status().sources.map((source) => [source.name, source]));
    expect(byName.get(ROBINHOOD_LAUNCH_SOURCE)).toEqual({ name: ROBINHOOD_LAUNCH_SOURCE, lastOkAt: NOW - 100, lastError: null });
    expect(byName.get(PUMPPORTAL_SOURCE)).toEqual({ name: PUMPPORTAL_SOURCE, lastOkAt: NOW - 50, lastError: null });
    expect(svc.status().sources).toHaveLength(6);
    svc.stop();
  });
});

describe("LaunchService.curvePairsFor", () => {
  it("offers the launchpad pseudo-pair for Robinhood curve tokens and nothing otherwise", () => {
    const { svc, index } = service();
    index.upsert({ chain: "robinhood", token: MEAO, launchpad: "pons", curve: MEAO_CURVE, createdAt: NOW, tx: "0x" });
    index.upsert({ chain: "robinhood", token: "0xflap", launchpad: "flap", createdAt: NOW, tx: "0x" });
    index.upsert({ chain: "robinhood", token: "0xpool", launchpad: "pools-trade", createdAt: NOW, tx: "0x" });
    expect(svc.curvePairsFor("robinhood", MEAO.toUpperCase())).toEqual([{ dex: "pons", pairAddress: `pons:${MEAO_CURVE}`, liquidityUsd: null, volume24Usd: null }]);
    expect(svc.curvePairsFor("robinhood", "0xflap")).toEqual([{ dex: "flap", pairAddress: "flap:0xflap", liquidityUsd: null, volume24Usd: null }]);
    expect(svc.curvePairsFor("robinhood", "0xpool")).toEqual([]);
    expect(svc.curvePairsFor("robinhood", "0xunknown")).toEqual([]);
  });

  it("stops offering the curve pseudo-pair once the token has graduated to a real pool", () => {
    const { svc, index } = service();
    index.upsert({ chain: "robinhood", token: MEAO, launchpad: "pons", curve: MEAO_CURVE, createdAt: NOW, tx: "0x" });
    expect(svc.curvePairsFor("robinhood", MEAO)).toHaveLength(1);
    index.recordGraduation("robinhood", MEAO, NOW + 1, "0xv4pool");
    expect(svc.curvePairsFor("robinhood", MEAO)).toEqual([]);
    index.upsert({ chain: "robinhood", token: "0xgrad", launchpad: "flap", createdAt: NOW, tx: "0x", graduatedAt: NOW });
    expect(svc.curvePairsFor("robinhood", "0xgrad")).toEqual([]);
  });
});
