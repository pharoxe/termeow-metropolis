import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { FlowPrint, PairRow } from "../../shared/wire.js";
import { FlowLedger, MINUTE_MS } from "../flow/ledger.js";
import type { RegistryResult } from "../flow/registry.js";
import { buildFlowCandlesResponse, candlesQuerySchema, resolveCandlesParams, type CandlesParams, type CandlesRouteDeps } from "./flowCandles.js";

const MINT = "0x9c0000000000000000000000000000000000beef";
const POOL = "0x8500000000000000000000000000000000000001";
const NOW = 1_800_000_000_000;

function row(pairAddress: string, tier: PairRow["tier"], extra: Partial<PairRow> = {}): PairRow {
  return {
    chain: "monad",
    dex: "kuru",
    pairAddress,
    baseMint: MINT,
    quoteMint: null,
    liquidityUsd: 1000,
    volume24Usd: 5000,
    share24: 1,
    txns: { m5: null, h1: null, h6: null, h24: null },
    tier,
    sources: ["dexscreener"],
    ...extra
  };
}

function print(pair: string, tx: string, time: number, side: FlowPrint["side"], usd: number | null, price?: number | null): FlowPrint {
  return { chain: "monad", pair, tx, time, side, usd, source: "own", ...(price === undefined ? {} : { price }) };
}

function params(overrides: Partial<CandlesParams> = {}): CandlesParams {
  return { chain: "monad", address: MINT, interval: "15s", ...overrides };
}

function deps(overrides: Partial<CandlesRouteDeps> = {}, ledger = new FlowLedger({ now: () => NOW })): CandlesRouteDeps & { subscribe: ReturnType<typeof vi.fn> } {
  const subscribe = vi.fn();
  const registry: RegistryResult = { pairs: [row(POOL, "A")], observedAt: NOW - 1000, stale: false };
  return { registry: vi.fn(async () => registry), collector: { ledger, subscribe, launchMs: () => null }, now: () => NOW, subscribe, ...overrides };
}

describe("resolveCandlesParams", () => {
  it("defaults the interval to 15s and accepts 5s / 15s / 1m only", () => {
    expect(resolveCandlesParams({ chain: "monad", address: MINT }, {})).toEqual({ chain: "monad", address: MINT, interval: "15s" });
    expect(resolveCandlesParams({ chain: "monad", address: MINT }, { interval: "5s" }).interval).toBe("5s");
    expect(resolveCandlesParams({ chain: "monad", address: MINT }, { interval: "1m" }).interval).toBe("1m");
    expect(() => resolveCandlesParams({ chain: "monad", address: MINT }, { interval: "5m" })).toThrow(ZodError);
    expect(candlesQuerySchema.safeParse({ interval: "1h" }).success).toBe(false);
  });

  it("lowercases monad addresses and rejects the wrong shape per chain", () => {
    expect(resolveCandlesParams({ chain: "monad", address: "0x12D5ee7917cA430073C3A638ee1e6f0648A98a01" }, undefined)).toEqual({
      chain: "monad",
      address: "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01",
      interval: "15s"
    });
    expect(() => resolveCandlesParams({ chain: "monad", address: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump" }, {})).toThrow(ZodError);
    expect(() => resolveCandlesParams({ chain: "solana", address: MINT }, {})).toThrow(ZodError);
  });
});

describe("buildFlowCandlesResponse", () => {
  it("subscribes with the registry pairs and returns ring candles from priced prints only", async () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([
      print(POOL, "a", NOW - 40_000, "buy", 100, 0.25),
      print(POOL, "b", NOW - 35_000, "sell", 30, 0.24),
      print(POOL, "c", NOW - 10_000, "buy", 10, null),
      print(POOL, "d", NOW - 5_000, "buy", 10)
    ]);
    const d = deps({}, ledger);
    const response = await buildFlowCandlesResponse(params(), d);
    expect(d.subscribe).toHaveBeenCalledWith("monad", MINT, [row(POOL, "A")]);
    expect(response).toEqual({
      chain: "monad",
      address: MINT,
      interval: "15s",
      candles: [{ time: NOW - 45_000, open: 0.25, high: 0.25, low: 0.24, close: 0.24, volume: 130 }],
      source: "own tape",
      spanMs: 5_000,
      prints: 4,
      priced: 2,
      firstPrintAt: NOW - 40_000,
      pricedBySource: { own: 2 },
      observedAt: NOW
    });
  });

  it("uses the requested bucket (1m) and never fills empty buckets", async () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([print(POOL, "a", NOW - 10 * MINUTE_MS, "buy", 1, 1), print(POOL, "b", NOW - MINUTE_MS, "buy", 1, 2)]);
    const response = await buildFlowCandlesResponse(params({ interval: "1m" }), deps({}, ledger));
    expect(response.candles.map((candle) => candle.time)).toEqual([NOW - 10 * MINUTE_MS, NOW - MINUTE_MS]);
    expect(response.spanMs).toBe(9 * MINUTE_MS);
  });

  it("subscribes the collector without launchpad pseudo-pairs while still reading their rings", async () => {
    const ledger = new FlowLedger({ now: () => NOW });
    const CURVE = "pons:0xcurve";
    ledger.ingest([print(CURVE, "c1", NOW - 1000, "buy", 40, 0.001)]);
    const curve = row(CURVE, "A", { dex: "pons", sources: ["launchpad"] });
    const d = deps({ registry: async () => ({ pairs: [row(POOL, "A"), curve], observedAt: NOW, stale: false }) }, ledger);
    const response = await buildFlowCandlesResponse(params(), d);
    expect(d.subscribe).toHaveBeenCalledWith("monad", MINT, [row(POOL, "A")]);
    expect(response.candles).toHaveLength(1);
    expect(response.candles[0]).toMatchObject({ open: 0.001, volume: 40 });
  });

  it("answers 200-shaped with error for an untracked token and never subscribes", async () => {
    const d = deps({ registry: async () => { throw new Error("dexscreener: down; geckoterminal: down; clawpump: down"); } });
    const response = await buildFlowCandlesResponse(params(), d);
    expect(response).toEqual({
      chain: "monad",
      address: MINT,
      interval: "15s",
      candles: [],
      source: "own tape",
      spanMs: 0,
      prints: 0,
      priced: 0,
      firstPrintAt: null,
      pricedBySource: {},
      observedAt: NOW,
      error: "untracked: dexscreener: down; geckoterminal: down; clawpump: down"
    });
    expect(d.subscribe).not.toHaveBeenCalled();
  });

  it("names a token with no known pair untracked instead of blaming a partial source, and never subscribes it", async () => {
    const d = deps({ registry: async () => ({ pairs: [], observedAt: NOW, stale: false, error: "geckoterminal: GeckoTerminal backoff active after 429" }) });
    const response = await buildFlowCandlesResponse(params(), d);
    expect(response.error).toBe("untracked: no pairs known for this token (geckoterminal: GeckoTerminal backoff active after 429)");
    expect(response.candles).toEqual([]);
    expect(d.subscribe).not.toHaveBeenCalled();
  });

  it("passes through stale registry results with their error and an empty ledger as zero candles", async () => {
    const d = deps({ registry: async () => ({ pairs: [row(POOL, "A")], observedAt: NOW - 90_000, stale: true, error: "geckoterminal: 429" }) });
    const response = await buildFlowCandlesResponse(params(), d);
    expect(response).toMatchObject({ stale: true, error: "geckoterminal: 429", candles: [], prints: 0, priced: 0, firstPrintAt: null, spanMs: 0 });
    expect(d.subscribe).toHaveBeenCalledTimes(1);
  });
});
