import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FlowPrint, PairRow, TapePrint } from "../../shared/wire";
import { parsePumpTradesResponse } from "../sources/pumpfun";
import { parseSwapTransaction, type PoolRef } from "../tape/solana/parseSwap";
import { CANDLE_INTERVAL_MS, candlePairs, candlesForToken, isPriced, mergeRingPrints, printCandles } from "./candles";
import { FlowLedger, MINUTE_MS } from "./ledger";

/**
 * Real prints only: Solana own-tape prints parsed from the measured getTransaction fixtures (ANSEM, 2026-09-06 08:37–08:57 UTC)
 * and pump v2 rows from the measured swap-api fixture; registry rows from the captured /api/flow/token response.
 */
const MINT = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_USD_AT_FIXTURES = 105.13;
const PUMP_PAIR = `pumpfun:${MINT}`;
const POOL_4PAN = "4pANrqEvjad4xEghrCbAAJfBm8KyNvYMKk1cuGW8erE4";
const POOL_CNTP = "CNTPTpytHK9txrsPCvaEnc3PoN9ZVWDDcSnFSZZonMue";
const POOL_BETLT = "BetLT47eFXDZnjM1cmZhQ4oNJkYaPZYH5yv6atfPfAri";
const POOL_H76F = "H76FDoKbidtHPk8D6swx9mksaAGHuUxVN9PZPSKNU7b7";
const POOL_XX3G = "xx3geLdL3ZPHpTwHYY61G4TFoAvf1rrGvEt6u9CiSbS";
const POOL_6E7V = "6e7V9eegCHw997T72MxgwwJipZ6GJyZF8NvjkzT1rvpN";
const POOL_FNZK = "FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC";
const NOW = 1_788_720_000_000;

const T_0837_35 = Date.parse("2026-09-06T08:37:35.000Z");
const T_0838_02 = Date.parse("2026-09-06T08:38:02.000Z");
const T_0838_33 = Date.parse("2026-09-06T08:38:33.000Z");
const T_0839_18 = Date.parse("2026-09-06T08:39:18.000Z");
const T_0839_58 = Date.parse("2026-09-06T08:39:58.000Z");
const T_0857_06 = Date.parse("2026-09-06T08:57:06.000Z");
const T_0857_35 = Date.parse("2026-09-06T08:57:35.000Z");
const MIN = (iso: string) => Date.parse(iso);

function loadJson<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as T;
}

const POOLS: PoolRef[] = [
  [POOL_CNTP, "orca"],
  [POOL_4PAN, "meteora"],
  [POOL_6E7V, "meteora"],
  [POOL_BETLT, "meteora"],
  [POOL_H76F, "raydium-clmm"],
  [POOL_XX3G, "meteora"]
].map(([pair, dex]) => ({ pair, pairAddress: pair, dex, ledgerPair: pair }));
POOLS.push({ pair: POOL_FNZK, pairAddress: POOL_FNZK, dex: "pumpswap", ledgerPair: PUMP_PAIR });

function quotePriceUsd(mint: string): number | null {
  if (mint === SOL) return SOL_USD_AT_FIXTURES;
  if (mint === USDC) return 1;
  return null;
}

/** Every own-tape print the measured Solana fixtures yield, in fixture-index order (pool order within a tx). */
function solanaFixturePrints(): FlowPrint[] {
  const index = loadJson<Array<{ file: string }>>("../tape/solana/__fixtures__/index.json");
  const seen = new Set<string>();
  return index.flatMap((entry) => {
    if (seen.has(entry.file)) return [];
    seen.add(entry.file);
    const tx = loadJson<unknown>(`../tape/solana/__fixtures__/${entry.file}`);
    return parseSwapTransaction(tx, { mint: MINT, pools: POOLS, quotePriceUsd }).prints;
  });
}

function pumpFixturePrints(): FlowPrint[] {
  return parsePumpTradesResponse(loadJson<unknown>("../sources/__fixtures__/pumpfun-trades.json"), "MintPumpFixture1111111111111111111111111111").prints;
}

type FlowFixture = { pairs: Array<PairRow & { bars: unknown[] }>; tape: TapePrint[] };

function ansemRegistryRows(): PairRow[] {
  return loadJson<FlowFixture>("./__fixtures__/r4/flow_solana_ansem_1m.json").pairs.map(({ bars: _bars, ...row }) => row);
}

/** The captured wire tape (40 pumpfun/gecko prints, none priced) as ledger prints. */
function ansemTapePrints(): FlowPrint[] {
  return loadJson<FlowFixture>("./__fixtures__/r4/flow_solana_ansem_1m.json").tape.map(({ dex: _dex, ...print }) => ({ chain: "solana", ...print }));
}

const prints = solanaFixturePrints();
const pump = pumpFixturePrints();

describe("fixture prints carry prices", () => {
  it("yields 12 Solana own prints, all priced near the measured ANSEM price band (0.26–0.27 USD)", () => {
    expect(prints).toHaveLength(12);
    expect(prints.every(isPriced)).toBe(true);
    for (const print of prints) {
      expect(print.price as number).toBeGreaterThan(0.26);
      expect(print.price as number).toBeLessThan(0.271);
    }
    // pumpswap-2ZxiypZR: ANSEM vault -1141.773729, WSOL vault +2.908797459 (index.json note) at 105.13 USD/SOL.
    const pumpBuy = prints.find((print) => print.pair === PUMP_PAIR && print.time === T_0839_18) as FlowPrint;
    expect(pumpBuy.price).toBeCloseTo((2.908797459 * SOL_USD_AT_FIXTURES) / 1141.773729, 9);
  });

  it("pump v2 rows price as amountUsd / baseAmount and leave the unpriced row without a price", () => {
    expect(pump.map((print) => print.price)).toEqual([152.3 / 1233700.5, 48.1 / 391000, undefined]);
    expect("price" in pump[2]).toBe(false);
  });
});

describe("printCandles", () => {
  it("builds one 1m bar from the pump fixture's two priced prints and skips the unpriced one", () => {
    const candles = printCandles(pump, MINUTE_MS);
    expect(candles).toEqual([
      {
        time: MIN("2026-09-06T08:15:00.000Z"),
        open: 48.1 / 391000,
        high: 152.3 / 1233700.5,
        low: 48.1 / 391000,
        close: 152.3 / 1233700.5,
        volume: 152.3 + 48.1
      }
    ]);
  });

  it("at 5s the pump prints split into two bars with no bar for the unpriced print's bucket", () => {
    const candles = printCandles(pump, CANDLE_INTERVAL_MS["5s"]);
    expect(candles.map((candle) => candle.time)).toEqual([MIN("2026-09-06T08:15:35.000Z"), MIN("2026-09-06T08:15:40.000Z")]);
    expect(candles[0]).toMatchObject({ open: 48.1 / 391000, close: 48.1 / 391000, volume: 48.1 });
    expect(candles[1]).toMatchObject({ open: 152.3 / 1233700.5, close: 152.3 / 1233700.5, volume: 152.3 });
  });

  it("leaves the 08:40–08:56 gap empty and folds same-minute prints into OHLC with summed usd", () => {
    const candles = printCandles(prints, MINUTE_MS);
    expect(candles.map((candle) => candle.time)).toEqual([
      MIN("2026-09-06T08:37:00.000Z"),
      MIN("2026-09-06T08:38:00.000Z"),
      MIN("2026-09-06T08:39:00.000Z"),
      MIN("2026-09-06T08:57:00.000Z")
    ]);
    const at0838 = candles[1];
    const cntp = prints.find((print) => print.pair === POOL_CNTP && print.time === T_0838_02) as FlowPrint;
    const pan = prints.find((print) => print.pair === POOL_4PAN && print.time === T_0838_02) as FlowPrint;
    const pumpBuy = prints.find((print) => print.pair === PUMP_PAIR && print.time === T_0838_33) as FlowPrint;
    expect(at0838.open).toBe(cntp.price);
    expect(at0838.high).toBe(pan.price);
    expect(at0838.low).toBe(pumpBuy.price);
    expect(at0838.close).toBe(pumpBuy.price);
    expect(at0838.volume).toBeCloseTo((cntp.usd as number) + (pan.usd as number) + (pumpBuy.usd as number), 9);
    expect(at0838.volume).toBeCloseTo(2688.67, 1);
  });

  it("orders input by time before folding: a shuffled input yields the same buckets, highs, lows and volumes", () => {
    const shuffled = [prints[7], prints[2], prints[11], prints[0], prints[9], prints[4], prints[1], prints[10], prints[3], prints[8], prints[6], prints[5]];
    const sorted = printCandles(prints, 15_000);
    const strip = (candle: { time: number; high: number; low: number; volume: number }) => [candle.time, candle.high, candle.low, candle.volume];
    // open/close of a bucket whose prints share one block time follow input order (block time is the finest clock the tape has).
    expect(printCandles(shuffled, 15_000).map(strip)).toEqual(sorted.map(strip));
    expect(sorted).toHaveLength(7);
  });

  it("never fabricates a bar without a priced print", () => {
    expect(printCandles(ansemTapePrints(), MINUTE_MS)).toEqual([]);
    expect(printCandles([], MINUTE_MS)).toEqual([]);
  });

  it("rejects a non-positive bucket", () => {
    expect(() => printCandles(prints, 0)).toThrow(RangeError);
    expect(() => printCandles(prints, Number.NaN)).toThrow(RangeError);
  });
});

describe("candlesForToken over the ledger rings", () => {
  const rows = ansemRegistryRows();

  it("selects Tier A rows plus launchpad pseudo-pairs from the captured registry", () => {
    expect(candlePairs(rows).map((row) => row.pairAddress)).toEqual([POOL_6E7V, POOL_4PAN, PUMP_PAIR, POOL_BETLT, "BNEeD53WYjj8qfHEZtbUXyc1eL1cQv5HLb5H6yKgN7eo"]);
    const curve: PairRow = { ...rows[0], pairAddress: "pons:0xcurve", dex: "pons", tier: "B", sources: ["launchpad"] };
    expect(candlePairs([curve]).map((row) => row.pairAddress)).toEqual(["pons:0xcurve"]);
  });

  it("merges the Tier A rings time-ascending, drops Tier B prints, and reports span over priced prints only", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest(prints);
    const merged = mergeRingPrints(ledger, "solana", rows);
    expect(merged.map((print) => [print.pair, print.time])).toEqual([
      [POOL_4PAN, T_0837_35],
      [POOL_4PAN, T_0838_02],
      [PUMP_PAIR, T_0838_33],
      [POOL_4PAN, T_0839_18],
      [PUMP_PAIR, T_0839_18],
      [POOL_BETLT, T_0857_06],
      [POOL_BETLT, T_0857_35]
    ]);
    const built = candlesForToken(ledger, rows, "solana", MINUTE_MS);
    expect(built).toMatchObject({ prints: 7, priced: 7, firstPrintAt: T_0837_35, spanMs: 20 * MINUTE_MS, pricedBySource: { own: 7 }, source: "own tape" });
    expect(built.candles.map((candle) => candle.time)).toEqual([
      MIN("2026-09-06T08:37:00.000Z"),
      MIN("2026-09-06T08:38:00.000Z"),
      MIN("2026-09-06T08:39:00.000Z"),
      MIN("2026-09-06T08:57:00.000Z")
    ]);
    const pan = prints.find((print) => print.pair === POOL_4PAN && print.time === T_0838_02) as FlowPrint;
    const pumpBuy = prints.find((print) => print.pair === PUMP_PAIR && print.time === T_0838_33) as FlowPrint;
    expect(built.candles[1]).toEqual({ time: MIN("2026-09-06T08:38:00.000Z"), open: pan.price, high: pan.price, low: pumpBuy.price, close: pumpBuy.price, volume: (pan.usd as number) + (pumpBuy.usd as number) });
    expect(built.candles[0].volume).toBeCloseTo(32.4091, 3);
  });

  it("counts unpriced ring prints (the captured wire tape) without letting them shape bars or the span", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    const tape = ansemTapePrints();
    ledger.ingest([...prints, ...tape]);
    const tierA = new Set(candlePairs(rows).map((row) => row.pairAddress));
    const tapeOnTierA = tape.filter((print) => tierA.has(print.pair)).length;
    expect(tapeOnTierA).toBeGreaterThan(0);
    const built = candlesForToken(ledger, rows, "solana", MINUTE_MS);
    expect(built.prints).toBe(7 + tapeOnTierA);
    expect(built.priced).toBe(7);
    expect(built.spanMs).toBe(20 * MINUTE_MS);
    expect(built.firstPrintAt).toBe(T_0837_35);
    expect(built.pricedBySource).toEqual({ own: 7 });
    expect(built.candles).toHaveLength(4);
  });

  it("discloses priced prints from other producers folded into the same bars", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([...prints, ...ansemTapePrints().slice(0, 2).map((print, i) => ({ ...print, pair: POOL_4PAN, source: "geckoterminal" as const, price: 0.26, tx: `g${i}` }))]);
    const built = candlesForToken(ledger, rows, "solana", MINUTE_MS);
    expect(built.pricedBySource).toEqual({ own: 7, geckoterminal: 2 });
    expect(built.priced).toBe(9);
  });

  it("returns an empty, zeroed result for an unknown token or a ledger with no rings", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    expect(candlesForToken(ledger, rows, "solana", MINUTE_MS)).toEqual({
      candles: [],
      prints: 0,
      priced: 0,
      firstPrintAt: null,
      spanMs: 0,
      pricedBySource: {},
      source: "own tape"
    });
    expect(candlesForToken(ledger, [], "robinhood", 5_000).candles).toEqual([]);
  });
});
