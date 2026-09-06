import { describe, expect, it } from "vitest";
import type { FlowCandlesResponse, FlowWindow, LaunchRow, MarketResponse, TapePrint, TokenFlowResponse } from "../../shared/wire";
import {
  candleSeriesKey, eventMarkerInput, flowBias, flowReadoutCells, flowSignature, hasLiveTape, launchRowFor, livePrintsAfter,
  marketIntervalFor, ownTapeInterval, selectCandles, spanLabel, stableChartFlow, visibleIntervals, windowByLabel
} from "./deskFlow";

const FATCOIN = "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01";
const NOW = 1_788_717_300_000;

function flow(overrides: Partial<TokenFlowResponse> = {}): TokenFlowResponse {
  return {
    chain: "robinhood", address: FATCOIN, interval: "1m", anchor: "window",
    bars: [{ t: NOW - 120_000, buyUsd: 10, sellUsd: 4, buys: 2, sells: 1, unpricedBuys: 0, unpricedSells: 0, delta: 6, cvd: 6 }, { t: NOW - 60_000, buyUsd: 1, sellUsd: 5, buys: 1, sells: 2, unpricedBuys: 0, unpricedSells: 1, delta: -4, cvd: 2 }],
    pairs: [],
    coverage: { fraction: 0.5, firstPrintAt: NOW - 600_000, volumeShare: null, tierAPairs: 1, totalPairs: 2 },
    counts: { m5: null, h1: null, h6: null, h24: null },
    observedAt: NOW,
    source: "test",
    ...overrides
  };
}

function window(label: FlowWindow["label"], net: number, extra: Partial<FlowWindow> = {}): FlowWindow {
  return { label, buyUsd: Math.max(net, 0), sellUsd: Math.max(-net, 0), net, buys: 3, sells: 2, unpriced: 0, aggressor: null, ...extra };
}

function market(overrides: Partial<MarketResponse> = {}): MarketResponse {
  return {
    instrument: { chain: "robinhood", address: FATCOIN, symbol: "FAT", name: "Fatcoin", image: null, socials: [], websites: [] },
    priceUsd: 0.02, marketCapUsd: 20_000_000, fdvUsd: null, liquidityUsd: 1, volume24Usd: 1, change24Pct: 0, primaryPair: null,
    candles: [{ time: NOW - 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }], interval: "1m", observedAt: NOW - 5000, source: "gecko", degraded: false, notes: [],
    ...overrides
  };
}

function own(overrides: Partial<FlowCandlesResponse> = {}): FlowCandlesResponse {
  return {
    chain: "robinhood", address: FATCOIN, interval: "15s", candles: [{ time: NOW - 15_000, open: 0.02, high: 0.02, low: 0.02, close: 0.02, volume: 12 }],
    source: "own tape", spanMs: 186_000, prints: 200, priced: 180, firstPrintAt: NOW - 186_000, pricedBySource: { own: 180 }, observedAt: NOW - 1000, ...overrides
  };
}

describe("intervals", () => {
  it("maps sub-minute chips to own-tape intervals and 1m upstream data", () => {
    expect(ownTapeInterval("5S")).toBe("5s");
    expect(ownTapeInterval("15s")).toBe("15s");
    expect(ownTapeInterval("1M")).toBeNull();
    expect(marketIntervalFor("15S")).toBe("1m");
    expect(marketIntervalFor("4H")).toBe("4h");
  });
  it("shows sub-minute chips only with a live tape", () => {
    expect(visibleIntervals(false)).toEqual(["1M", "5M", "15M", "1H", "4H", "1D"]);
    expect(visibleIntervals(true)[0]).toBe("5S");
    expect(hasLiveTape(null)).toBe(false);
    expect(hasLiveTape(flow({ coverage: { fraction: 0, firstPrintAt: null, volumeShare: null, tierAPairs: 0, totalPairs: 0 } }))).toBe(false);
    expect(hasLiveTape(flow({ coverage: { fraction: 0, firstPrintAt: null, volumeShare: null, tierAPairs: 0, totalPairs: 0 }, tape: [{ pair: "p", dex: "d", tx: "t", time: NOW, side: "buy", usd: 1, source: "own" }] }))).toBe(true);
    expect(hasLiveTape(flow())).toBe(true);
  });
});

describe("selectCandles", () => {
  it("serves market candles for minute+ intervals with the feed's observedAt", () => {
    const active = selectCandles("1M", market(), own());
    expect(active).toMatchObject({ source: "market", observedAt: NOW - 5000, note: null, label: null });
    expect(active.candles).toHaveLength(1);
  });
  it("serves own-tape candles for 15S when the route answered with candles, labelled by priced/prints/span", () => {
    const active = selectCandles("15S", market(), own());
    expect(active.source).toBe("own tape");
    expect(active.observedAt).toBe(NOW - 1000);
    expect(active.label).toBe("OWN TAPE · 180/200 PRICED · 3m SPAN");
    expect(active.note).toBeNull();
    expect(active.candles[0].volume).toBe(12);
  });
  it("keeps served own-tape candles through a partial registry error (shown as a note) and names other producers in the label", () => {
    const partial = selectCandles("15S", market(), own({ error: "geckoterminal: GeckoTerminal backoff active after 429", pricedBySource: { own: 170, geckoterminal: 10 } }));
    expect(partial.source).toBe("own tape");
    expect(partial.note).toBe("OWN TAPE · registry: geckoterminal: GeckoTerminal backoff active after 429");
    expect(partial.label).toBe("OWN TAPE · 180/200 PRICED · 3m SPAN · PRICED BY own 170 · geckoterminal 10");
  });
  it("falls back to the market series with a visible note on error, on zero candles, and while loading — never mixing", () => {
    expect(selectCandles("5S", market(), own({ error: "untracked: down", candles: [] }))).toMatchObject({ source: "market", note: "NO OWN TAPE · untracked: down", observedAt: NOW - 5000 });
    expect(selectCandles("5S", market(), own({ candles: [], priced: 0, prints: 7 })).note).toBe("NO OWN TAPE · 0 priced of 7 ring prints");
    expect(selectCandles("5S", market(), null).note).toBe("NO OWN TAPE · loading");
    expect(selectCandles("5S", null, null).candles).toEqual([]);
  });
  it("keys the series by source so a fallback resets instead of blending", () => {
    const ref = { chain: "robinhood" as const, address: FATCOIN };
    expect(candleSeriesKey(ref, "15S", "own tape")).not.toBe(candleSeriesKey(ref, "15S", "market"));
  });
  it("formats spans", () => {
    expect(spanLabel(0)).toBe("—");
    expect(spanLabel(42_000)).toBe("42s");
    expect(spanLabel(2_352_000)).toBe("39m");
    expect(spanLabel(7_200_000)).toBe("2h");
  });
});

describe("livePrintsAfter", () => {
  const tape: TapePrint[] = [
    { pair: "p", dex: "d", tx: "a", time: NOW, side: "buy", usd: 1, source: "own" },
    { pair: "p", dex: "d", tx: "b", time: NOW - 10_000, side: "sell", usd: 1, source: "own" }
  ];
  it("keeps only prints strictly after the feed's observedAt and nothing when that time is unknown", () => {
    expect(livePrintsAfter(tape, NOW - 5000).map((p) => p.tx)).toEqual(["a"]);
    expect(livePrintsAfter(tape, NOW)).toEqual([]);
    expect(livePrintsAfter(tape, null)).toEqual([]);
    expect(livePrintsAfter(undefined, NOW - 60_000)).toEqual([]);
  });
});

describe("stableChartFlow", () => {
  const candles = [{ time: NOW - 120_000 }, { time: NOW - 60_000 }];
  it("returns the same object for a poll whose bars, coverage and candle span did not change", () => {
    const first = stableChartFlow(null, flow(), candles);
    const second = stableChartFlow(first, flow({ observedAt: NOW + 15_000, tape: [] }), candles);
    expect(second).toBe(first);
    expect(first?.input.candleTimes).toEqual([NOW - 120_000, NOW - 60_000]);
  });
  it("rebuilds when a bar's tail, the coverage or the candle span changes", () => {
    const first = stableChartFlow(null, flow(), candles);
    const bars = flow().bars.map((bar, index, all) => (index === all.length - 1 ? { ...bar, cvd: 9 } : bar));
    expect(stableChartFlow(first, flow({ bars }), candles)).not.toBe(first);
    expect(stableChartFlow(first, flow({ coverage: { ...flow().coverage, fraction: 0.6 } }), candles)).not.toBe(first);
    expect(stableChartFlow(first, flow(), [...candles, { time: NOW }])).not.toBe(first);
    expect(stableChartFlow(first, null, candles)).toBeNull();
    expect(flowSignature(flow(), candles)).toContain(String(NOW - 60_000));
  });
});

describe("flowReadoutCells", () => {
  it("renders em-dashes without a flow response", () => {
    const cells = flowReadoutCells(null);
    expect(cells.map((cell) => cell.label)).toEqual(["NET 5M", "NET 1H", "CVD WINDOW", "BUY WINDOW", "SELL WINDOW", "FLOW 1H", "1H B/S"]);
    expect(cells.every((cell) => cell.value === "—" && cell.tone === "")).toBe(true);
  });
  it("labels windows and the anchor explicitly and never shows an unknown anchor as zero", () => {
    const cells = flowReadoutCells(flow({
      anchor: "session",
      windows: [window("1m", 1), window("5m", -250), window("15m", 0), window("1h", 1200, { buys: 7, sells: 4, unpriced: 2 })],
      sinceAnchor: { startMs: NOW - 3_600_000, net: 500, buyUsd: 900, sellUsd: 400, prints: 11 }
    }));
    const byKey = Object.fromEntries(cells.map((cell) => [cell.key, cell]));
    expect(byKey.net5m).toMatchObject({ value: "-$250", tone: "dn" });
    expect(byKey.net1h).toMatchObject({ value: "+$1.2K", tone: "up" });
    expect(byKey.cvd).toMatchObject({ label: "CVD SESSION", value: "+$500", tone: "up" });
    expect(byKey.buy).toMatchObject({ label: "BUY SESSION", value: "$900", tone: "up" });
    expect(byKey.sell).toMatchObject({ value: "$400", tone: "dn" });
    expect(byKey.flow1h).toMatchObject({ value: "BUY", tone: "up" });
    expect(byKey.bs1h.value).toBe("B7/S4 (2u)");
    const unknown = flowReadoutCells(flow({ sinceAnchor: { startMs: null, net: 0, buyUsd: 0, sellUsd: 0, prints: 0 } }));
    expect(unknown.find((cell) => cell.key === "cvd")?.value).toBe("—");
  });
  it("derives the bias from the 1h net", () => {
    expect(flowBias(5)).toBe("BUY");
    expect(flowBias(-5)).toBe("SELL");
    expect(flowBias(0)).toBe("FLAT");
    expect(flowBias(null)).toBeNull();
    expect(windowByLabel([window("1h", 3)], "5m")).toBeNull();
  });
});

describe("event marker input", () => {
  const row: LaunchRow = {
    chain: "robinhood", launchpad: "pons", token: FATCOIN.toUpperCase().replace("0X", "0x"), symbol: "FAT", name: null, image: null, creator: null, curve: null, pool: null,
    createdAt: NOW - 3_600_000, tx: "0xabc", graduatedAt: NOW - 1_800_000, priceUsd: null, marketCapUsd: null, liquidityUsd: null, volume24Usd: null, change24Pct: null,
    pricedAt: null, curveBuys: 0, curveSells: 0, curveNetUsd: null, tracked: null, sources: [], observedAt: NOW
  };
  it("finds the focused token case-insensitively on Robinhood and builds launch + graduation from the index row", () => {
    const found = launchRowFor([row], { chain: "robinhood", address: FATCOIN });
    expect(found).toBe(row);
    expect(launchRowFor([row], { chain: "solana", address: FATCOIN })).toBeNull();
    const input = eventMarkerInput(found, flow({ largePrints: [{ pair: "p", dex: "d", tx: "t", time: NOW, side: "buy", usd: 5000, source: "own" }] }));
    expect(input.launch).toEqual({ createdAt: NOW - 3_600_000, launchpad: "pons" });
    expect(input.graduation).toEqual({ time: NOW - 1_800_000 });
    expect(input.largePrints).toHaveLength(1);
  });
  it("uses the flow anchor start as launch only when the poll was anchored at launch", () => {
    const since = { startMs: NOW - 600_000, net: 0, buyUsd: 0, sellUsd: 0, prints: 0 };
    expect(eventMarkerInput(null, flow({ anchor: "window", sinceAnchor: since })).launch).toBeNull();
    expect(eventMarkerInput(null, flow({ anchor: "launch", sinceAnchor: since })).launch).toEqual({ createdAt: NOW - 600_000, launchpad: "" });
    expect(eventMarkerInput(null, flow({ anchor: "launch", sinceAnchor: { ...since, startMs: null } })).launch).toBeNull();
    expect(eventMarkerInput(null, null)).toEqual({ launch: null, graduation: null, largePrints: [] });
  });
});
