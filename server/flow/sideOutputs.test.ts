import { describe, expect, it } from "vitest";
import type { FlowPrint, PairRow } from "../../shared/wire.js";
import { FLOW_WINDOW_LABELS, flowWindows, largePrints, sinceAnchor } from "./aggregate.js";
import { FlowLedger, HOUR_MS, MINUTE_MS, alignTo } from "./ledger.js";

const NOW = 1_700_000_400_000 + 30_000; // 30s past a minute boundary
const M = (n: number) => NOW - n * MINUTE_MS;

function print(pair: string, time: number, side: "buy" | "sell", usd: number | null, tx = `${pair}-${time}-${side}-${usd}`): FlowPrint {
  return { chain: "monad", pair, tx, time, side, usd, source: "geckoterminal" };
}

function pairRow(pairAddress: string, tier: "A" | "B", dex = "kuru"): PairRow {
  return {
    chain: "monad",
    dex,
    pairAddress,
    baseMint: "MINT",
    quoteMint: null,
    liquidityUsd: null,
    volume24Usd: null,
    share24: null,
    txns: { m5: null, h1: null, h6: null, h24: null },
    tier,
    sources: ["dexscreener"]
  };
}

const PAIRS = [pairRow("A1", "A"), pairRow("A2", "A", "nadfun"), pairRow("B1", "B")];

function seed(): FlowLedger {
  const ledger = new FlowLedger({ now: () => NOW });
  ledger.ingest([
    print("A1", M(0), "buy", 100), // current minute
    print("A2", M(0), "sell", 40),
    print("A2", M(0), "buy", null), // unpriced, current minute
    print("A1", M(3), "sell", 10), // inside 5m, outside 1m
    print("A2", M(3), "sell", null),
    print("A1", M(12), "buy", 1000), // inside 15m
    print("A2", M(45), "sell", 5000), // inside 1h
    print("A1", M(90), "buy", 7), // outside every window
    print("B1", M(0), "buy", 99_999) // Tier B never counts
  ]);
  return ledger;
}

describe("flowWindows", () => {
  it("returns the four labels in order", () => {
    expect(flowWindows(seed(), "monad", PAIRS, NOW).map((w) => w.label)).toEqual(FLOW_WINDOW_LABELS);
    expect(FLOW_WINDOW_LABELS).toEqual(["1m", "5m", "15m", "1h"]);
  });

  it("sums minute buckets across Tier A pairs with unpriced counted, never priced", () => {
    const [m1, m5, m15, h1] = flowWindows(seed(), "monad", PAIRS, NOW);
    expect(m1).toEqual({ label: "1m", buyUsd: 100, sellUsd: 40, net: 60, buys: 2, sells: 1, unpriced: 1, aggressor: 100 / 140 });
    expect(m5).toEqual({ label: "5m", buyUsd: 100, sellUsd: 50, net: 50, buys: 2, sells: 3, unpriced: 2, aggressor: 100 / 150 });
    expect(m15).toMatchObject({ buyUsd: 1100, sellUsd: 50, net: 1050, buys: 3, sells: 3, unpriced: 2 });
    expect(h1).toMatchObject({ buyUsd: 1100, sellUsd: 5050, net: -3950, buys: 3, sells: 4, unpriced: 2, aggressor: 1100 / 6150 });
  });

  it("keeps a print in the minute bucket that straddles an unaligned window start", () => {
    const fromMs = NOW - MINUTE_MS;
    const straddle = fromMs + 15_000; // at/after fromMs, but its minute bucket starts before fromMs
    expect(alignTo(straddle, MINUTE_MS)).toBeLessThan(fromMs);
    expect(straddle).toBeGreaterThanOrEqual(fromMs);
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([print("A1", straddle, "buy", 250)]);
    const [m1] = flowWindows(ledger, "monad", PAIRS, NOW);
    expect(m1).toMatchObject({ label: "1m", buyUsd: 250, buys: 1, aggressor: 1 });
    expect(sinceAnchor(ledger, "monad", PAIRS, fromMs, NOW)).toEqual({ startMs: fromMs, net: 250, buyUsd: 250, sellUsd: 0, prints: 1 });
  });

  it("reports aggressor null (not 0) when nothing priced traded, and zeros on an empty ledger", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([print("A1", M(0), "buy", null)]);
    const [m1] = flowWindows(ledger, "monad", PAIRS, NOW);
    expect(m1).toEqual({ label: "1m", buyUsd: 0, sellUsd: 0, net: 0, buys: 1, sells: 0, unpriced: 1, aggressor: null });
    expect(flowWindows(new FlowLedger(), "monad", PAIRS, NOW).every((w) => w.aggressor === null && w.buys === 0)).toBe(true);
  });
});

describe("largePrints", () => {
  it("applies the usd threshold inclusively, skips unpriced, orders newest first and tags the pair's dex", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([
      print("A1", M(5), "buy", 1000, "exact"),
      print("A1", M(1), "sell", 999.99, "under"),
      print("A2", M(2), "sell", 2500, "big"),
      print("A2", M(0), "buy", null, "unpriced"),
      print("B1", M(0), "buy", 50_000, "tierB")
    ]);
    const out = largePrints(ledger, "monad", PAIRS);
    expect(out.map((p) => p.tx)).toEqual(["big", "exact"]);
    expect(out[0]).toEqual({ pair: "A2", dex: "nadfun", tx: "big", time: M(2), side: "sell", usd: 2500, source: "geckoterminal" });
  });

  it("honours minUsd and limit and returns [] with no Tier A pairs", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([1, 2, 3, 4].map((i) => print("A1", M(i), "buy", i * 100, `t${i}`)));
    expect(largePrints(ledger, "monad", PAIRS, 200, 2).map((p) => p.tx)).toEqual(["t2", "t3"]);
    expect(largePrints(ledger, "monad", PAIRS, 200, 0)).toEqual([]);
    expect(largePrints(ledger, "monad", [pairRow("B1", "B")], 0)).toEqual([]);
  });
});

describe("sinceAnchor", () => {
  it("returns zeros with startMs null when the anchor is unknown", () => {
    expect(sinceAnchor(seed(), "monad", PAIRS, null, NOW)).toEqual({ startMs: null, net: 0, buyUsd: 0, sellUsd: 0, prints: 0 });
    expect(sinceAnchor(seed(), "monad", PAIRS, Number.NaN, NOW).startMs).toBeNull();
  });

  it("sums Tier A minute buckets from the anchor start to now", () => {
    const start = M(15) - 1;
    expect(sinceAnchor(seed(), "monad", PAIRS, start, NOW)).toEqual({ startMs: start, net: 1050, buyUsd: 1100, sellUsd: 50, prints: 6 });
    expect(sinceAnchor(seed(), "monad", PAIRS, NOW - 2 * HOUR_MS, NOW)).toEqual({ startMs: NOW - 2 * HOUR_MS, net: -3943, buyUsd: 1107, sellUsd: 5050, prints: 8 });
  });
});
