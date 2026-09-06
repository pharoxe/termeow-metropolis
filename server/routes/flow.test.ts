import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { FlowPrint, PairRow } from "../../shared/wire.js";
import { FlowLedger, MINUTE_MS } from "../flow/ledger.js";
import type { RegistryResult } from "../flow/registry.js";
import {
  DEFAULT_BAR_COUNT,
  FLOW_SOURCE,
  TAPE_LIMIT,
  buildTokenFlowResponse,
  flowParamsSchema,
  recentTape,
  resolveFlowParams,
  type FlowParams,
  type FlowRouteDeps
} from "./flow.js";

const MINT = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const POOL = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";
const NOW = 1_800_000_000_000;
const FIVE_MIN = 5 * MINUTE_MS;

function row(pairAddress: string, tier: PairRow["tier"], share24: number | null, extra: Partial<PairRow> = {}): PairRow {
  return {
    chain: "solana",
    dex: "raydium",
    pairAddress,
    baseMint: MINT,
    quoteMint: null,
    liquidityUsd: 1000,
    volume24Usd: 5000,
    share24,
    txns: { m5: { buys: 2, sells: 1 }, h1: null, h6: null, h24: null },
    tier,
    sources: ["dexscreener"],
    ...extra
  };
}

function print(pair: string, tx: string, time: number, side: FlowPrint["side"], usd: number): FlowPrint {
  return { chain: "solana", pair, tx, time, side, usd, source: "geckoterminal" };
}

function params(overrides: Partial<FlowParams> = {}): FlowParams {
  return { chain: "solana", address: MINT, interval: "5m", anchor: "window", fromMs: NOW - 2 * FIVE_MIN, toMs: NOW, ...overrides };
}

function deps(overrides: Partial<FlowRouteDeps> = {}, ledger = new FlowLedger({ now: () => NOW })): FlowRouteDeps & { subscribe: ReturnType<typeof vi.fn> } {
  const subscribe = vi.fn();
  const registry: RegistryResult = { pairs: [row(POOL, "A", 1)], observedAt: NOW - 1000, stale: false };
  return {
    registry: vi.fn(async () => registry),
    collector: { ledger, subscribe, launchMs: () => null },
    sessionStartMs: NOW - 60 * MINUTE_MS,
    now: () => NOW,
    subscribe,
    ...overrides
  };
}

describe("resolveFlowParams", () => {
  it("applies defaults: 5m interval, window anchor, to=now, from=300 bars back", () => {
    const resolved = resolveFlowParams({ chain: "solana", address: MINT }, {}, NOW);
    expect(resolved).toEqual({ chain: "solana", address: MINT, interval: "5m", anchor: "window", fromMs: NOW - DEFAULT_BAR_COUNT * FIVE_MIN, toMs: NOW });
  });

  it("parses explicit interval, anchor and window from query strings", () => {
    const resolved = resolveFlowParams({ chain: "solana", address: MINT }, { interval: "1h", anchor: "session", from: "100", to: "200" }, NOW);
    expect(resolved).toMatchObject({ interval: "1h", anchor: "session", fromMs: 100, toMs: 200 });
  });

  it("accepts robinhood with a lowercased EVM address and rejects anything else on that chain", () => {
    const resolved = resolveFlowParams({ chain: "robinhood", address: "0x12D5ee7917cA430073C3A638ee1e6f0648A98a01" }, {}, NOW);
    expect(resolved).toMatchObject({ chain: "robinhood", address: "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01" });
    expect(() => resolveFlowParams({ chain: "robinhood", address: "0xabc" }, {}, NOW)).toThrow(ZodError);
    expect(flowParamsSchema.safeParse({ chain: "robinhood", address: MINT }).success).toBe(false);
    expect(flowParamsSchema.safeParse({ chain: "solana", address: "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01" }).success).toBe(false);
  });

  it("rejects non-base58 addresses, unknown intervals and inverted windows", () => {
    expect(() => resolveFlowParams({ chain: "solana", address: "0OIl" }, {}, NOW)).toThrow(ZodError);
    expect(() => resolveFlowParams({ chain: "solana", address: MINT }, { interval: "2m" }, NOW)).toThrow(ZodError);
    expect(() => resolveFlowParams({ chain: "solana", address: MINT }, { from: "200", to: "100" }, NOW)).toThrow(ZodError);
  });
});

describe("buildTokenFlowResponse", () => {
  it("subscribes with registry pairs and aggregates ledger prints into bars and counts", async () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([
      print(POOL, "a", NOW - 2 * FIVE_MIN + 1000, "buy", 100),
      print(POOL, "b", NOW - FIVE_MIN + 1000, "sell", 30),
      print(POOL, "c", NOW - FIVE_MIN + 2000, "buy", 10)
    ]);
    const d = deps({}, ledger);
    const response = await buildTokenFlowResponse(params(), d);
    expect(d.subscribe).toHaveBeenCalledWith("solana", MINT, [row(POOL, "A", 1)]);
    expect(response.source).toBe(FLOW_SOURCE);
    expect(response.observedAt).toBe(NOW);
    expect(response.error).toBeUndefined();
    expect(response.stale).toBeUndefined();
    expect(response.bars.map((bar) => [bar.t, bar.delta, bar.cvd])).toEqual([
      [NOW - 2 * FIVE_MIN, 100, 100],
      [NOW - FIVE_MIN, -20, 80]
    ]);
    expect(response.pairs).toHaveLength(1);
    expect(response.pairs[0].bars).toHaveLength(2);
    expect(response.coverage).toMatchObject({ tierAPairs: 1, totalPairs: 1, volumeShare: 1 });
    expect(response.counts).toEqual({ m5: { buys: 2, sells: 1 }, h1: null, h6: null, h24: null });
  });

  it("anchors cvd at the session start when anchor=session", async () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([print(POOL, "early", NOW - 30 * MINUTE_MS, "buy", 500), print(POOL, "in", NOW - FIVE_MIN + 1000, "sell", 100)]);
    const d = deps({}, ledger);
    const window = await buildTokenFlowResponse(params({ anchor: "window" }), d);
    const session = await buildTokenFlowResponse(params({ anchor: "session" }), d);
    expect(window.bars.at(-1)?.cvd).toBe(-100);
    expect(session.bars.at(-1)?.cvd).toBe(400);
    expect(session.anchor).toBe("session");
  });

  it("uses the collector's launch time when anchor=launch", async () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([print(POOL, "genesis", NOW - 3 * 60 * MINUTE_MS, "buy", 50), print(POOL, "in", NOW - FIVE_MIN + 1000, "buy", 5)]);
    const launchMs = vi.fn(() => NOW - 4 * 60 * MINUTE_MS);
    const d = deps({}, ledger);
    const response = await buildTokenFlowResponse(params({ anchor: "launch" }), { ...d, collector: { ...d.collector, launchMs } });
    expect(launchMs).toHaveBeenCalledWith("solana", MINT);
    expect(response.bars.at(-1)?.cvd).toBe(55);
  });

  it("adds windows, large prints, sinceAnchor and source chips computed from the ledger and collector", async () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([print(POOL, "big", NOW - 2 * FIVE_MIN + 1000, "buy", 1500), print(POOL, "small", NOW - 30_000, "sell", 30)]);
    const status = vi.fn(() => ({
      sources: {
        pumpfun: { lastOkAt: NOW - 5000, lastError: null, lastErrorAt: null },
        geckoterminal: { lastOkAt: null, lastError: "geckoterminal: 429", lastErrorAt: NOW - 1000 },
        own: { lastOkAt: NOW - 2000, lastError: null, lastErrorAt: null, tape: { prints: 7 } }
      }
    }));
    const d = deps({}, ledger);
    const response = await buildTokenFlowResponse(params(), { ...d, collector: { ...d.collector, status } });
    expect(status).toHaveBeenCalledWith("solana", MINT);
    expect(response.windows?.map((w) => [w.label, w.net, w.buys, w.sells, w.aggressor])).toEqual([
      ["1m", -30, 0, 1, 0],
      ["5m", -30, 0, 1, 0],
      ["15m", 1470, 1, 1, 1500 / 1530],
      ["1h", 1470, 1, 1, 1500 / 1530]
    ]);
    expect(response.largePrints).toEqual([{ pair: POOL, dex: "raydium", tx: "big", time: NOW - 2 * FIVE_MIN + 1000, side: "buy", usd: 1500, source: "geckoterminal" }]);
    expect(response.sinceAnchor).toEqual({ startMs: NOW - 2 * FIVE_MIN, net: 1470, buyUsd: 1500, sellUsd: 30, prints: 2 });
    expect(response.sources).toEqual([
      { name: "pumpfun", lastOkAt: NOW - 5000, lastError: null },
      { name: "geckoterminal", lastOkAt: null, lastError: "geckoterminal: 429" },
      { name: "own", lastOkAt: NOW - 2000, lastError: null, prints: 7 }
    ]);
  });

  it("omits sources when the collector has no status(), and nulls sinceAnchor.startMs for an unknown launch", async () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([print(POOL, "a", NOW - 1000, "buy", 10)]);
    const d = deps({}, ledger);
    const response = await buildTokenFlowResponse(params({ anchor: "launch" }), d);
    expect(response.sources).toBeUndefined();
    expect(response.sinceAnchor).toEqual({ startMs: null, net: 0, buyUsd: 0, sellUsd: 0, prints: 0 });
    expect(response.windows).toHaveLength(4);
    const session = await buildTokenFlowResponse(params({ anchor: "session" }), d);
    expect(session.sinceAnchor).toMatchObject({ startMs: NOW - 60 * MINUTE_MS, net: 10, prints: 1 });
  });

  it("degrades to 200 + error (bars intact, side outputs omitted) when the collector status throws", async () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([print(POOL, "a", NOW - FIVE_MIN + 1000, "buy", 10)]);
    const d = deps({}, ledger);
    const status = vi.fn(() => { throw new Error("shape mismatch"); });
    const response = await buildTokenFlowResponse(params(), { ...d, collector: { ...d.collector, status } });
    expect(response.bars).toHaveLength(1);
    expect(response.error).toBe("side outputs: shape mismatch");
    expect(response.windows).toBeUndefined();
    expect(response.sources).toBeUndefined();
  });

  it("passes through stale registry results with their error", async () => {
    const d = deps({ registry: async () => ({ pairs: [row(POOL, "A", 1)], observedAt: NOW - 90_000, stale: true, error: "geckoterminal: 429" }) });
    const response = await buildTokenFlowResponse(params(), d);
    expect(response.stale).toBe(true);
    expect(response.error).toBe("geckoterminal: 429");
    expect(d.subscribe).toHaveBeenCalledTimes(1);
  });

  it("returns an empty 200 envelope when the registry fails with nothing cached", async () => {
    const d = deps({ registry: async () => { throw new Error("dexscreener: down; geckoterminal: down; clawpump: down"); } });
    const response = await buildTokenFlowResponse(params(), d);
    expect(response).toMatchObject({
      chain: "solana",
      address: MINT,
      interval: "5m",
      anchor: "window",
      bars: [],
      pairs: [],
      coverage: { fraction: 0, firstPrintAt: null, volumeShare: null, tierAPairs: 0, totalPairs: 0 },
      counts: { m5: null, h1: null, h6: null, h24: null },
      observedAt: NOW,
      source: FLOW_SOURCE,
      error: "dexscreener: down; geckoterminal: down; clawpump: down"
    });
    expect(response.windows).toBeUndefined();
    expect(response.sources).toBeUndefined();
    expect(d.subscribe).not.toHaveBeenCalled();
  });
});

describe("tape", () => {
  const POOL_B = "PoolBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const POOL_TIER_B = "PoolCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

  it("merges Tier A pairs newest first with the PairRow dex, keeps unpriced prints and skips Tier B", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([
      print(POOL, "a1", NOW - 3000, "buy", 10),
      { ...print(POOL_B, "b1", NOW - 1000, "sell", 0), usd: null, source: "own" },
      print(POOL, "a2", NOW - 2000, "sell", 20),
      print(POOL_TIER_B, "c1", NOW - 500, "buy", 999)
    ]);
    const pairs = [row(POOL, "A", 0.5), row(POOL_B, "A", 0.5, { dex: "meteora" }), row(POOL_TIER_B, "B", null)];
    expect(recentTape(ledger, "solana", pairs)).toEqual([
      { pair: POOL_B, dex: "meteora", tx: "b1", time: NOW - 1000, side: "sell", usd: null, source: "own" },
      { pair: POOL, dex: "raydium", tx: "a2", time: NOW - 2000, side: "sell", usd: 20, source: "geckoterminal" },
      { pair: POOL, dex: "raydium", tx: "a1", time: NOW - 3000, side: "buy", usd: 10, source: "geckoterminal" }
    ]);
  });

  it("caps the merged tape at TAPE_LIMIT (40) across pairs", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([
      ...Array.from({ length: 30 }, (_, index) => print(POOL, `a${index}`, NOW - index * 10, "buy", 1)),
      ...Array.from({ length: 30 }, (_, index) => print(POOL_B, `b${index}`, NOW - index * 10 - 5, "sell", 1))
    ]);
    const tape = recentTape(ledger, "solana", [row(POOL, "A", 0.5), row(POOL_B, "A", 0.5)]);
    expect(TAPE_LIMIT).toBe(40);
    expect(tape).toHaveLength(40);
    expect(tape[0].tx).toBe("a0");
    expect(tape.every((item, index) => index === 0 || tape[index - 1].time >= item.time)).toBe(true);
    expect(recentTape(ledger, "solana", [row(POOL, "A", 1)], 5)).toHaveLength(5);
  });

  it("rides on the flow response as a side output and is absent on the empty envelope", async () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([print(POOL, "x", NOW - 1000, "buy", 5)]);
    const response = await buildTokenFlowResponse(params(), deps({}, ledger));
    expect(response.tape).toEqual([{ pair: POOL, dex: "raydium", tx: "x", time: NOW - 1000, side: "buy", usd: 5, source: "geckoterminal" }]);
    const failed = await buildTokenFlowResponse(params(), deps({ registry: async () => { throw new Error("down"); } }));
    expect(failed.tape).toBeUndefined();
  });
});
