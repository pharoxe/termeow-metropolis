import { describe, expect, it } from "vitest";
import type { FlowPrint, PairRow } from "../../shared/wire.js";
import { FlowLedger, HOUR_MS, MINUTE_MS } from "./ledger.js";
import { coverageShare, intervalToMs, isFlowInterval, sumSeries, tokenFlow, weightedCoverage } from "./aggregate.js";
import type { TokenFlowInput } from "./aggregate.js";
import { buildRegistry } from "./registry.js";

const T0 = 1_700_000_400_000; // minute-aligned
const NOW = T0 + HOUR_MS;

function print(pair: string, time: number, side: "buy" | "sell", usd: number | null): FlowPrint {
  return { chain: "solana", pair, tx: `${pair}-${time}-${side}-${usd}`, time, side, usd, source: "geckoterminal" };
}

function pairRow(pairAddress: string, tier: "A" | "B", share24: number | null): PairRow {
  return {
    chain: "solana",
    dex: "raydium",
    pairAddress,
    baseMint: "MINT",
    quoteMint: null,
    liquidityUsd: null,
    volume24Usd: null,
    share24,
    txns: { m5: null, h1: null, h6: null, h24: null },
    tier,
    sources: ["dexscreener"]
  };
}

function seedLedger(): FlowLedger {
  const ledger = new FlowLedger({ now: () => NOW });
  ledger.ingest([
    print("A1", T0 - 2 * HOUR_MS, "buy", 1000), // before session, after launch
    print("A1", T0 - 10 * MINUTE_MS, "buy", 100), // inside session, before window
    print("A2", T0 - 10 * MINUTE_MS, "sell", 30),
    print("A1", T0, "buy", 10),
    print("A2", T0, "buy", 5),
    print("A1", T0 + MINUTE_MS, "sell", 4),
    print("A2", T0 + 2 * MINUTE_MS, "sell", 6),
    print("A2", T0 + 2 * MINUTE_MS, "buy", null),
    print("B1", T0, "buy", 999)
  ]);
  return ledger;
}

function baseInput(ledger: FlowLedger, over: Partial<TokenFlowInput> = {}): TokenFlowInput {
  return {
    ledger,
    chain: "solana",
    address: "MINT",
    pairs: [pairRow("A1", "A", 0.6), pairRow("A2", "A", 0.2), pairRow("B1", "B", 0.2)],
    interval: "1m",
    fromMs: T0,
    toMs: T0 + 4 * MINUTE_MS,
    anchor: "window",
    sessionStartMs: T0 - 20 * MINUTE_MS,
    launchMs: T0 - 3 * HOUR_MS,
    ...over
  };
}

describe("intervalToMs", () => {
  it("maps every supported interval", () => {
    expect(intervalToMs("1m")).toBe(MINUTE_MS);
    expect(intervalToMs("5m")).toBe(5 * MINUTE_MS);
    expect(intervalToMs("15m")).toBe(15 * MINUTE_MS);
    expect(intervalToMs("1h")).toBe(HOUR_MS);
    expect(intervalToMs("4h")).toBe(4 * HOUR_MS);
    expect(intervalToMs("1d")).toBe(24 * HOUR_MS);
  });

  it("rejects unknown intervals", () => {
    expect(isFlowInterval("2m")).toBe(false);
    expect(isFlowInterval("toString")).toBe(false);
    expect(() => tokenFlow(baseInput(seedLedger(), { interval: "2m" }))).toThrow(RangeError);
  });
});

describe("tokenFlow bars", () => {
  it("sums Tier A pairs bucket-wise and excludes Tier B", () => {
    const { bars, pairs } = tokenFlow(baseInput(seedLedger()));
    expect(bars.map((b) => [b.t, b.buyUsd, b.sellUsd, b.buys, b.sells, b.unpricedBuys])).toEqual([
      [T0, 15, 0, 2, 0, 0],
      [T0 + MINUTE_MS, 0, 4, 0, 1, 0],
      [T0 + 2 * MINUTE_MS, 0, 6, 1, 1, 1]
    ]);
    expect(bars.map((b) => b.delta)).toEqual([15, -4, -6]);
    expect(bars.map((b) => b.cvd)).toEqual([15, 11, 5]);
    const byPair = Object.fromEntries(pairs.map((p) => [p.pairAddress, p.bars]));
    expect(byPair.B1).toEqual([]);
    expect(byPair.A1.map((b) => [b.t, b.delta])).toEqual([
      [T0, 10],
      [T0 + MINUTE_MS, -4]
    ]);
    expect(byPair.A2.map((b) => [b.t, b.delta])).toEqual([
      [T0, 5],
      [T0 + 2 * MINUTE_MS, -6]
    ]);
    expect(pairs.map((p) => p.pairAddress)).toEqual(["A1", "A2", "B1"]);
  });

  it("token bars equal the sum of per-pair bars at every bucket", () => {
    const { bars, pairs } = tokenFlow(baseInput(seedLedger(), { interval: "5m", fromMs: T0 - 15 * MINUTE_MS }));
    const tierA = pairs.filter((p) => p.tier === "A");
    for (const bar of bars) {
      const parts = tierA.map((p) => p.bars.find((b) => b.t === bar.t));
      const delta = parts.reduce((acc, b) => acc + (b?.delta ?? 0), 0);
      expect(bar.delta).toBe(delta);
    }
    expect(bars.map((b) => [b.t, b.delta])).toEqual([
      [T0 - 10 * MINUTE_MS, 70],
      [T0, 5]
    ]);
  });

  it("does not double count a pump token whose PumpSwap pool is also in the registry", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    const same = [print("SWAP", T0, "buy", 100), print("SWAP", T0 + MINUTE_MS, "sell", 40)];
    ledger.ingest([...same, ...same.map((p) => ({ ...p, pair: "pumpfun:MINT", source: "pumpfun" as const }))]);
    const swap: PairRow = { ...pairRow("SWAP", "B", null), dex: "pumpswap", volume24Usd: 50 };
    const other: PairRow = { ...pairRow("OTHER", "B", null), dex: "meteora", volume24Usd: 50 };
    const pairs = buildRegistry({ chain: "solana", address: "MINT", dexPairs: [swap, other], geckoPools: [], clawTopPools: null, pumpPool: "pumpfun:MINT" });
    const { bars, coverage } = tokenFlow(baseInput(ledger, { pairs }));
    expect(bars.map((b) => [b.buyUsd, b.sellUsd, b.buys, b.sells])).toEqual([[100, 0, 1, 0], [0, 40, 0, 1]]);
    expect(coverage).toMatchObject({ tierAPairs: 2, totalPairs: 3, volumeShare: 1 });
  });

  it("folds a 1m window into a single 5m bar", () => {
    const { bars } = tokenFlow(baseInput(seedLedger(), { interval: "5m" }));
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ t: T0, buyUsd: 15, sellUsd: 10, delta: 5, cvd: 5 });
  });
});

describe("tokenFlow anchors", () => {
  it("window: cvd starts at zero on the first bar", () => {
    const { bars } = tokenFlow(baseInput(seedLedger(), { anchor: "window" }));
    expect(bars[0].cvd).toBe(15);
  });

  it("session: opening cvd is the Tier A delta from sessionStartMs to fromMs", () => {
    const { bars, pairs } = tokenFlow(baseInput(seedLedger(), { anchor: "session" }));
    expect(bars.map((b) => b.cvd)).toEqual([85, 81, 75]);
    const byPair = Object.fromEntries(pairs.map((p) => [p.pairAddress, p.bars]));
    expect(byPair.A1[0].cvd).toBe(110);
    expect(byPair.A2[0].cvd).toBe(-25);
    expect(byPair.A1[0].cvd + byPair.A2[0].cvd).toBe(bars[0].cvd);
  });

  it("session: no opening when the session starts inside the window", () => {
    const { bars } = tokenFlow(baseInput(seedLedger(), { anchor: "session", sessionStartMs: T0 + MINUTE_MS }));
    expect(bars[0].cvd).toBe(15);
  });

  it("launch: opening cvd runs from launchMs, or from epoch when unknown", () => {
    const known = tokenFlow(baseInput(seedLedger(), { anchor: "launch" }));
    expect(known.bars.map((b) => b.cvd)).toEqual([1085, 1081, 1075]);
    const unknown = tokenFlow(baseInput(seedLedger(), { anchor: "launch", launchMs: null }));
    expect(unknown.bars.map((b) => b.cvd)).toEqual([1085, 1081, 1075]);
    const late = tokenFlow(baseInput(seedLedger(), { anchor: "launch", launchMs: T0 - HOUR_MS }));
    expect(late.bars.map((b) => b.cvd)).toEqual([85, 81, 75]);
  });
});

describe("tokenFlow coverage", () => {
  const from = T0 - HOUR_MS;
  const to = T0 + 4 * MINUTE_MS;
  const a2Fraction = (14 * MINUTE_MS) / (to - from);

  it("weights per-pair fractions by share24 when every Tier A share is known", () => {
    const { coverage } = tokenFlow(baseInput(seedLedger(), { fromMs: from, toMs: to }));
    expect(coverage.fraction).toBeCloseTo(0.75 * 1 + 0.25 * a2Fraction, 12);
    expect(coverage.firstPrintAt).toBe(T0 - 2 * HOUR_MS);
    expect(coverage.volumeShare).toBeCloseTo(0.8, 12);
    expect(coverage.tierAPairs).toBe(2);
    expect(coverage.totalPairs).toBe(3);
  });

  it("falls back to equal weights when a Tier A share is unknown", () => {
    const pairs = [pairRow("A1", "A", 0.6), pairRow("A2", "A", null), pairRow("B1", "B", 0.2)];
    const { coverage } = tokenFlow(baseInput(seedLedger(), { pairs, fromMs: from, toMs: to }));
    expect(coverage.fraction).toBeCloseTo((1 + a2Fraction) / 2, 12);
    expect(coverage.volumeShare).toBeNull();
  });

  it("reports empty coverage when there are no Tier A pairs", () => {
    const pairs = [pairRow("B1", "B", 1)];
    const { bars, coverage } = tokenFlow(baseInput(seedLedger(), { pairs }));
    expect(bars).toEqual([]);
    expect(coverage).toEqual({ fraction: 0, firstPrintAt: null, volumeShare: null, tierAPairs: 0, totalPairs: 1 });
  });

  it("gives zero coverage to a Tier A pair the ledger has never seen", () => {
    const pairs = [pairRow("A1", "A", 0.5), pairRow("ZZ", "A", 0.5)];
    const { coverage } = tokenFlow(baseInput(seedLedger(), { pairs }));
    expect(coverage.fraction).toBeCloseTo(0.5, 12);
    expect(coverage.firstPrintAt).toBe(T0 - 2 * HOUR_MS);
  });
});

describe("helpers", () => {
  it("sumSeries unions bucket times and sorts ascending", () => {
    const bucket = (t: number, buyUsd: number) => ({ t, buyUsd, sellUsd: 0, buys: 1, sells: 0, unpricedBuys: 0, unpricedSells: 0 });
    const out = sumSeries([[bucket(20, 1), bucket(10, 2)], [bucket(20, 3)], []]);
    expect(out.map((b) => [b.t, b.buyUsd, b.buys])).toEqual([
      [10, 2, 1],
      [20, 4, 2]
    ]);
  });

  it("coverageShare clamps to one and ignores Tier B", () => {
    expect(coverageShare([pairRow("A1", "A", 0.7), pairRow("A2", "A", 0.5), pairRow("B1", "B", 0.3)])).toBe(1);
    expect(coverageShare([])).toBeNull();
  });

  it("weightedCoverage uses equal weights when shares sum to zero", () => {
    const merged = weightedCoverage([
      { fraction: 1, firstPrintAt: 5, share24: 0 },
      { fraction: 0, firstPrintAt: null, share24: 0 }
    ]);
    expect(merged).toEqual({ fraction: 0.5, firstPrintAt: 5 });
  });
});
