import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { FlowPrint, PairRow } from "../../shared/wire.js";
import { FlowLedger, MINUTE_MS } from "../flow/ledger.js";
import type { RegistryResult } from "../flow/registry.js";
import {
  DEFAULT_BAR_COUNT,
  FLOW_SOURCE,
  buildTokenFlowResponse,
  flowParamsSchema,
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
    expect(d.subscribe).not.toHaveBeenCalled();
  });
});
