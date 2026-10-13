import { describe, expect, it } from "vitest";
import type { FlowPrint, PairRow } from "../../shared/wire";
import { CANDLE_INTERVAL_MS, candlePairs, candlesForToken, isPriced, mergeRingPrints, printCandles } from "./candles";
import { FlowLedger, MINUTE_MS } from "./ledger";
import { LAUNCHPAD_SOURCE } from "./registry";

/** Synthetic Monad prints: two Tier A pools, one Tier B pool and a nad.fun curve pseudo-pair. */
const TOKEN = "0x9c0000000000000000000000000000000000beef";
const POOL_A = "0xaaaa000000000000000000000000000000000001";
const POOL_B = "0xbbbb000000000000000000000000000000000002";
const POOL_TIER_B = "0xcccc000000000000000000000000000000000003";
const CURVE = `nadfun:${TOKEN}`;
const T0 = Date.parse("2026-09-06T08:37:00.000Z");
const NOW = T0 + 30 * MINUTE_MS;

function print(pair: string, tx: string, time: number, side: FlowPrint["side"], usd: number | null, price?: number, source: FlowPrint["source"] = "own"): FlowPrint {
  return { chain: "monad", pair, tx, time, side, usd, source, ...(price === undefined ? {} : { price }) };
}

function row(pairAddress: string, tier: PairRow["tier"], extra: Partial<PairRow> = {}): PairRow {
  return {
    chain: "monad", dex: "kuru", pairAddress, baseMint: TOKEN, quoteMint: null, liquidityUsd: null, volume24Usd: null, share24: null,
    txns: { m5: null, h1: null, h6: null, h24: null }, tier, sources: ["dexscreener"], ...extra
  };
}

const ROWS: PairRow[] = [row(POOL_A, "A"), row(POOL_TIER_B, "B"), row(POOL_B, "A"), row(CURVE, "B", { dex: "nadfun", sources: [LAUNCHPAD_SOURCE] })];

const PRINTS: FlowPrint[] = [
  print(POOL_A, "a1", T0 + 35_000, "buy", 10, 0.26),
  print(POOL_B, "b1", T0 + 62_000, "sell", 5, 0.27),
  print(CURVE, "c1", T0 + 93_000, "buy", 20, 0.25),
  print(POOL_A, "a2", T0 + 138_000, "buy", 4, 0.265),
  print(CURVE, "c2", T0 + 138_000, "sell", 6, 0.262),
  print(POOL_A, "a3", T0 + 20 * MINUTE_MS + 6_000, "buy", 8, 0.3),
  print(POOL_TIER_B, "x1", T0 + 40_000, "buy", 999, 9.9)
];

describe("printCandles", () => {
  it("folds priced prints into OHLC per bucket and sums usd as volume", () => {
    const candles = printCandles(PRINTS.slice(0, 3), MINUTE_MS);
    expect(candles).toEqual([
      { time: T0, open: 0.26, high: 0.26, low: 0.26, close: 0.26, volume: 10 },
      { time: T0 + MINUTE_MS, open: 0.27, high: 0.27, low: 0.25, close: 0.25, volume: 25 }
    ]);
  });

  it("is order-independent across buckets and skips unpriced prints", () => {
    const unpriced = print(POOL_A, "u", T0 + 10_000, "buy", 50);
    expect(isPriced(unpriced)).toBe(false);
    expect(printCandles([...PRINTS].reverse().concat(unpriced), CANDLE_INTERVAL_MS["15s"]).map((c) => c.time)).toEqual(
      printCandles(PRINTS, CANDLE_INTERVAL_MS["15s"]).map((c) => c.time)
    );
    expect(printCandles([unpriced], MINUTE_MS)).toEqual([]);
    expect(printCandles([], MINUTE_MS)).toEqual([]);
  });

  it("rejects a non-positive bucket", () => {
    expect(() => printCandles(PRINTS, 0)).toThrow(RangeError);
    expect(() => printCandles(PRINTS, Number.NaN)).toThrow(RangeError);
  });
});

describe("candlesForToken over the ledger rings", () => {
  it("selects Tier A rows plus launchpad pseudo-pairs", () => {
    expect(candlePairs(ROWS).map((r) => r.pairAddress)).toEqual([POOL_A, POOL_B, CURVE]);
  });

  it("merges the Tier A and curve rings time-ascending, drops Tier B prints, and reports span over priced prints", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest(PRINTS);
    const merged = mergeRingPrints(ledger, "monad", ROWS);
    expect(merged.map((p) => p.tx)).toEqual(["a1", "b1", "c1", "a2", "c2", "a3"]);
    const built = candlesForToken(ledger, ROWS, "monad", MINUTE_MS);
    expect(built).toMatchObject({ prints: 6, priced: 6, firstPrintAt: T0 + 35_000, spanMs: 20 * MINUTE_MS - 29_000, pricedBySource: { own: 6 }, source: "own tape" });
    expect(built.candles.map((c) => c.time)).toEqual([T0, T0 + MINUTE_MS, T0 + 2 * MINUTE_MS, T0 + 20 * MINUTE_MS]);
    expect(built.candles[2]).toEqual({ time: T0 + 2 * MINUTE_MS, open: 0.265, high: 0.265, low: 0.262, close: 0.262, volume: 10 });
  });

  it("counts unpriced ring prints and discloses other producers' priced prints", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([...PRINTS, print(POOL_A, "g1", T0 + 36_000, "buy", 3, 0.261, "geckoterminal"), print(POOL_B, "g2", T0 + 63_000, "sell", 2, undefined, "geckoterminal")]);
    const built = candlesForToken(ledger, ROWS, "monad", MINUTE_MS);
    expect(built.prints).toBe(8);
    expect(built.priced).toBe(7);
    expect(built.pricedBySource).toEqual({ own: 6, geckoterminal: 1 });
  });

  it("returns an empty, zeroed result for a ledger with no rings", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    expect(candlesForToken(ledger, ROWS, "monad", MINUTE_MS)).toEqual({ candles: [], prints: 0, priced: 0, firstPrintAt: null, spanMs: 0, pricedBySource: {}, source: "own tape" });
    expect(candlesForToken(ledger, [], "monad", 5_000).candles).toEqual([]);
  });
});
