import { describe, expect, it } from "vitest";
import type { FlowWindow, LargePrint, SourceChip, TokenFlowResponse } from "../../shared/wire";
import {
  buildChartFlowInput,
  EM_DASH,
  largePrintRow,
  printAgeLabel,
  sinceAnchorLine,
  sourceChipState,
  windowRow
} from "./flowPanel";

const NOW = 1_800_000_000_000;

function chip(over: Partial<SourceChip> = {}): SourceChip {
  return { name: "pumpfun", lastOkAt: null, lastError: null, ...over };
}

describe("printAgeLabel", () => {
  it("scales seconds, minutes, hours and days", () => {
    expect(printAgeLabel(NOW - 12_000, NOW)).toBe("12s");
    expect(printAgeLabel(NOW - 3 * 60_000, NOW)).toBe("3m");
    expect(printAgeLabel(NOW - 2 * 3_600_000, NOW)).toBe("2h");
    expect(printAgeLabel(NOW - 3 * 86_400_000, NOW)).toBe("3d");
  });

  it("never reports 0s and clamps future times", () => {
    expect(printAgeLabel(NOW, NOW)).toBe("1s");
    expect(printAgeLabel(NOW + 5_000, NOW)).toBe("1s");
  });

  it("uses an em-dash for unknown times", () => {
    expect(printAgeLabel(null, NOW)).toBe(EM_DASH);
    expect(printAgeLabel(Number.NaN, NOW)).toBe(EM_DASH);
  });
});

describe("sourceChipState", () => {
  it("maps source names to the panel labels", () => {
    expect(sourceChipState(chip({ name: "own" }), NOW).label).toBe("OWN");
    expect(sourceChipState(chip({ name: "pumpfun" }), NOW).label).toBe("PUMP");
    expect(sourceChipState(chip({ name: "geckoterminal" }), NOW).label).toBe("GECKO");
  });

  it("is good when the last ok is within 60s and there is no error", () => {
    const state = sourceChipState(chip({ lastOkAt: NOW - 30_000 }), NOW);
    expect(state.tone).toBe("good");
    expect(state.title).toBe("PUMP · last ok 30s ago");
  });

  it("is warn when an error exists but the last ok is within 5 minutes", () => {
    const state = sourceChipState(chip({ lastOkAt: NOW - 4 * 60_000, lastError: "429" }), NOW);
    expect(state.tone).toBe("warn");
    expect(state.title).toBe("PUMP · last ok 4m ago · 429");
  });

  it("is warn when there is no error but the last ok is older than 60s", () => {
    expect(sourceChipState(chip({ lastOkAt: NOW - 61_000 }), NOW).tone).toBe("warn");
  });

  it("is bad when an error exists and the last ok is stale or absent", () => {
    expect(sourceChipState(chip({ lastOkAt: NOW - 6 * 60_000, lastError: "timeout" }), NOW).tone).toBe("bad");
    const never = sourceChipState(chip({ lastError: "boom" }), NOW);
    expect(never.tone).toBe("bad");
    expect(never.title).toBe("PUMP · never ok · boom");
  });

  it("is off when the source has never succeeded and has no error", () => {
    const state = sourceChipState(chip({ name: "own" }), NOW);
    expect(state.tone).toBe("off");
    expect(state.title).toBe("OWN · never ok");
  });

  it("appends the own tape print counter when present", () => {
    const state = sourceChipState(chip({ name: "own", lastOkAt: NOW - 1_000, prints: 17 }), NOW);
    expect(state.title).toBe("OWN · last ok 1s ago · 17 prints");
  });
});

describe("windowRow", () => {
  const base: FlowWindow = { label: "5m", buyUsd: 1500, sellUsd: 250, net: 1250, buys: 7, sells: 3, unpriced: 0, aggressor: 0.857 };

  it("formats money, counts and the aggressor share", () => {
    const row = windowRow(base);
    expect(row.label).toBe("5M");
    expect(row.buy).toBe("$1.5K");
    expect(row.sell).toBe("$250");
    expect(row.net).toBe("+$1.25K");
    expect(row.netTone).toBe("up");
    expect(row.prints).toBe("10");
    expect(row.aggr).toBe("86%");
  });

  it("marks negative net, flags unpriced prints and dashes a null aggressor", () => {
    const row = windowRow({ ...base, buyUsd: 0, sellUsd: 0, net: -40, unpriced: 2, aggressor: null });
    expect(row.net).toBe("-$40");
    expect(row.netTone).toBe("dn");
    expect(row.prints).toBe("10 (2u)");
    expect(row.aggr).toBe(EM_DASH);
  });

  it("has no tone when net is zero", () => {
    expect(windowRow({ ...base, net: 0 }).netTone).toBe("");
  });
});

describe("largePrintRow", () => {
  const print: LargePrint = { pair: "pairA", dex: "pumpswap", tx: "tx1", time: NOW - 90_000, side: "buy", usd: 2400, source: "pumpfun" };

  it("formats a buy with dex and age", () => {
    expect(largePrintRow(print, NOW)).toEqual({ key: "pairA:tx1", side: "BUY", tone: "up", usd: "$2.4K", dex: "PUMPSWAP", age: "2m" });
  });

  it("formats a sell and dashes a missing dex", () => {
    const row = largePrintRow({ ...print, side: "sell", dex: "" }, NOW);
    expect(row.side).toBe("SELL");
    expect(row.tone).toBe("dn");
    expect(row.dex).toBe(EM_DASH);
  });
});

describe("sinceAnchorLine", () => {
  it("prints the signed net and print count for a known anchor", () => {
    expect(sinceAnchorLine("session", { startMs: 1, net: 320, buyUsd: 500, sellUsd: 180, prints: 12 })).toBe("SINCE SESSION net +$320 · 12 prints");
    expect(sinceAnchorLine("window", { startMs: 1, net: -75, buyUsd: 0, sellUsd: 75, prints: 1 })).toBe("SINCE WINDOW net -$75 · 1 prints");
  });

  it("does not present zeros as a total when the anchor start is unknown", () => {
    expect(sinceAnchorLine("launch", { startMs: null, net: 0, buyUsd: 0, sellUsd: 0, prints: 0 })).toBe("SINCE LAUNCH — · anchor unknown");
  });

  it("dashes when the server sent no sinceAnchor", () => {
    expect(sinceAnchorLine("launch", undefined)).toBe("SINCE LAUNCH —");
  });
});

describe("buildChartFlowInput", () => {
  const bar = { t: 0, buyUsd: 0, sellUsd: 0, buys: 0, sells: 0, unpricedBuys: 0, unpricedSells: 0, delta: 0, cvd: 0 };
  const pair = (pairAddress: string, tier: "A" | "B") => ({
    chain: "solana" as const, dex: "x", pairAddress, baseMint: "m", quoteMint: null, liquidityUsd: null, volume24Usd: null, share24: null,
    txns: { m5: null, h1: null, h6: null, h24: null }, tier, sources: [], bars: [bar]
  });
  const flow = {
    chain: "solana", address: "m", interval: "1m", anchor: "window", bars: [bar],
    pairs: [pair("b1", "B"), pair("a1", "A"), pair("b2", "B"), pair("a2", "A")],
    coverage: { fraction: 1, firstPrintAt: 5, volumeShare: null, tierAPairs: 2, totalPairs: 4 },
    counts: { m5: null, h1: null, h6: null, h24: null }, observedAt: NOW, source: "ledger"
  } as TokenFlowResponse;

  it("puts Tier A pairs first, keeping relative order, and forwards bars and coverage", () => {
    const input = buildChartFlowInput(flow, []);
    expect(input.pairs.map((p) => p.pairAddress)).toEqual(["a1", "a2", "b1", "b2"]);
    expect(input.bars).toBe(flow.bars);
    expect(input.coverage).toBe(flow.coverage);
    expect(flow.pairs[0].pairAddress).toBe("b1");
  });

  it("normalises candle times to ms whether given in seconds or ms", () => {
    const input = buildChartFlowInput(flow, [{ time: 1_700_000_000 }, { time: 1_700_000_060_000 }]);
    expect(input.candleTimes).toEqual([1_700_000_000_000, 1_700_000_060_000]);
  });
});
