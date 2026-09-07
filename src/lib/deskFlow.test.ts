import { describe, expect, it } from "vitest";
import type { FlowCandlesResponse, FlowWindow, LaunchRow, MarketResponse, TapePrint, TokenFlowResponse } from "../../shared/wire";
import {
  allFeedsDown, candleSeriesKey, candleSourceMeta, eventMarkerInput, feedHealthChips, flowBias, flowReadoutCells, flowSignature, hasLiveTape, launchRowFor, livePrintsAfter,
  marketIntervalFor, nextFlowState, noCandlesReason, ownTapeInterval, selectCandles, spanLabel, stableChartFlow, systemStatusLine, tapeEmptyCopy, visibleIntervals, windowByLabel
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

describe("R6 candle provenance and no-candles reason", () => {
  const chainInfo = { kind: "chain swaps" as const, backfilledFrom: { block: 56_800_228, time: NOW - 7_200_000 }, coverage: { fromMs: 1_788_780_720_000, toMs: NOW, bars: 1840, prints: 2496, complete: true, backfilling: false }, timing: "anchors", quoteUsd: 1, live: 0 };
  it("labels chain-swap candles with bar count and IST start, gecko as fallback, and nothing for own tape or legacy", () => {
    expect(candleSourceMeta(market({ candleSource: chainInfo }), "market")).toBe("CHAIN SWAPS · 1,840 BARS · FROM 07 Sep 17:02 IST");
    expect(candleSourceMeta(market({ candleSource: { ...chainInfo, coverage: { ...chainInfo.coverage, backfilling: true, complete: false } } }), "market")).toContain("BACKFILLING");
    expect(candleSourceMeta(market({ candleSource: { ...chainInfo, coverage: { ...chainInfo.coverage, complete: false }, live: 3 } }), "market")).toBe("CHAIN SWAPS · 1,840 BARS · FROM 07 Sep 17:02 IST · PARTIAL · 3 LIVE PRINTS");
    expect(candleSourceMeta(market({ candleSource: { ...chainInfo, kind: "geckoterminal", backfilledFrom: null, coverage: { ...chainInfo.coverage, bars: 200, fromMs: null } } }), "market")).toBe("GECKOTERMINAL · FALLBACK · 200 BARS");
    expect(candleSourceMeta(market({ candleSource: chainInfo }), "own tape")).toBeNull();
    expect(candleSourceMeta(market(), "market")).toBeNull();
    expect(candleSourceMeta(market({ candleSource: chainInfo, stale: true }), "market")).toBe("CHAIN SWAPS · 1,840 BARS · FROM 07 Sep 17:02 IST · STALE HEAD");
  });
  it("marks a series standing on restored swaps with the snapshot data's age as the server reports it", () => {
    const restored = { ...chainInfo, restoredAt: NOW - 300_000, snapshotAgeMs: 720_000 };
    expect(candleSourceMeta(market({ candleSource: restored }), "market")).toBe("CHAIN SWAPS · 1,840 BARS · FROM 07 Sep 17:02 IST · RESTORED · 12m OLD");
    expect(candleSourceMeta(market({ candleSource: { ...restored, coverage: { ...restored.coverage, backfilling: true, complete: false } }, stale: true }), "market")).toBe("CHAIN SWAPS · 1,840 BARS · FROM 07 Sep 17:02 IST · BACKFILLING · RESTORED · 12m OLD · STALE HEAD");
    expect(candleSourceMeta(market({ candleSource: { ...chainInfo, restoredAt: null, snapshotAgeMs: null } }), "market")).toBe("CHAIN SWAPS · 1,840 BARS · FROM 07 Sep 17:02 IST");
  });
  it("names the route's own reason for an empty chart and the running backfill", () => {
    expect(noCandlesReason(market({ candles: [], notes: ["DexScreener pairs stale: x", "OHLCV unavailable: GeckoTerminal backoff active after 429"] }), "")).toBe("OHLCV unavailable: GeckoTerminal backoff active after 429");
    expect(noCandlesReason(market({ candles: [], notes: [], candleSource: { ...chainInfo, coverage: { ...chainInfo.coverage, bars: 0, prints: 120, backfilling: true, complete: false } } }), "")).toBe("Chain swap backfill running (120 swaps so far) · bars appear on the next read.");
    expect(noCandlesReason(market({ candles: [], notes: [] }), "boom")).toBe("boom");
    expect(noCandlesReason(null, "")).toBe("No candle source has answered yet.");
  });
});

describe("R6 feed health and last-good flow", () => {
  const health = {
    own: { ok: false, lastOkAt: NOW - 40_000, lastError: "rpc 429 rate limited", nextRetryAt: NOW + 18_000 },
    gecko: { ok: false, lastOkAt: null, lastError: "GeckoTerminal backoff active after 429", nextRetryAt: null },
    pumpfun: { ok: true, lastOkAt: NOW - 2_000, lastError: null, nextRetryAt: null }
  };
  it("builds one chip per source with tone and a title naming error and retry", () => {
    const chips = feedHealthChips(health, NOW);
    expect(chips.map((chip) => [chip.label, chip.tone])).toEqual([["OWN", "warn"], ["GECKO", "bad"], ["PUMP", "good"]]);
    expect(chips[0].title).toBe("OWN · down · last ok 40s ago · rpc 429 rate limited · retry in 18s");
    expect(feedHealthChips(undefined, NOW)).toEqual([]);
    expect(allFeedsDown(health)).toBe(false);
    expect(allFeedsDown({ ...health, pumpfun: { ...health.pumpfun, ok: false } })).toBe(true);
  });
  it("explains an empty tape by the down sources", () => {
    expect(tapeEmptyCopy(flow({ feedHealth: { ...health, pumpfun: { ...health.pumpfun, ok: false } } }))).toBe("No pool prints held · every print source is down (OWN rpc 429 rate limited · GECKO GeckoTerminal backoff active after 429 · PUMP).");
    expect(tapeEmptyCopy(flow({ feedHealth: health }))).toBe("No pool prints in this window.");
    expect(tapeEmptyCopy(null)).toBe("No pool prints in this window.");
  });
  it("keeps the last-good response, marked stale, on a failed poll or an empty error envelope", () => {
    const print: TapePrint = { pair: "p", dex: "d", tx: "t", time: NOW, side: "buy", usd: 1, source: "own" };
    const good = flow({ tape: [print] });
    expect(nextFlowState(good, null, "network")).toMatchObject({ stale: true, error: "network", tape: [print] });
    expect(nextFlowState(null, null)).toBeNull();
    expect(nextFlowState(good, flow({ tape: [], error: "registry: boom" }))).toMatchObject({ stale: true, error: "registry: boom", tape: [print] });
    const fresh = flow({ tape: [print], stale: true, error: "all sources down" });
    expect(nextFlowState(good, fresh)).toBe(fresh);
    expect(nextFlowState(good, flow({ tape: [] }))).toMatchObject({ tape: [] });
  });
  it("condenses /api/health into one status line with per-endpoint detail in the title", () => {
    const line = systemStatusLine({
      restoredAt: NOW - 3_000, snapshotAge: 200_000, snapshot: { lastSaveAt: NOW - 30_000 },
      robinhoodRpc: { chainId: 4663, endpoints: [
        { url: "https://robinhood-rpc.publicnode.com", ok: true, enabled: true, disabledReason: null, chainVerified: true, logs: false, blockedUntil: null, calls: 10, rateLimited: 0, failures: 0, p50Ms: 195, lastError: null },
        { url: "https://rpc.mainnet.chain.robinhood.com/", ok: true, enabled: true, disabledReason: null, chainVerified: true, logs: true, blockedUntil: null, calls: 4, rateLimited: 1, failures: 1, p50Ms: 385.4, lastError: "upstream returned 429" },
        { url: "https://rpc.nodeflare.app/robinhood/public", ok: false, enabled: true, disabledReason: null, chainVerified: true, logs: true, blockedUntil: new Date(NOW + 20_000).toISOString(), calls: 1, rateLimited: 1, failures: 0, p50Ms: null, lastError: "rate_limited" },
        { url: "https://x.example", ok: false, enabled: false, disabledReason: "eth_chainId 1 != 4663", chainVerified: false, logs: false, blockedUntil: null, calls: 0, rateLimited: 0, failures: 0, p50Ms: null, lastError: null }
      ] },
      robinhoodTransport: { label: "MIXED", mode: "mixed", wsEnabled: true, pollers: [
        { name: "launch", mode: "ws", wsEnabled: true, httpCursor: 57_053_099, catchUpTicks: 12, wsLogs: 400, lastWsBlock: 57_053_120, ws: { connected: true, url: "wss://robinhood-rpc.publicnode.com", connectedAt: NOW - 600_000, subscriptions: 8, wantedLegs: 8, rejectedLegs: 0, reconnects: 1, lastError: null } },
        { name: "tape", mode: "http", wsEnabled: true, httpCursor: 57_053_090, catchUpTicks: 3, wsLogs: 20, lastWsBlock: 57_053_000, ws: { connected: false, url: "wss://robinhood.api.pocket.network", connectedAt: null, subscriptions: 0, wantedLegs: 2, rejectedLegs: 0, reconnects: 2, lastError: "closed (1006)" } }
      ] }
    }, NOW);
    expect(line?.text).toBe("RPC 2/4 UP · LOGS 1 · MIXED · SNAP 3m OLD");
    expect(line?.title).toMatch(/launch · prints via WS · robinhood-rpc\.publicnode\.com up since \d\d [A-Z][a-z]{2} \d\d:\d\d IST · 8\/8 legs · HTTP verified to 57053099/);
    expect(line?.title).toContain("tape · prints via HTTP · socket down · 2 reconnects · HTTP verified to 57053090 · closed (1006)");
    expect(line?.title).toContain("rpc.mainnet.chain.robinhood.com · up · logs · p50 385ms · 4 calls · 1 429 · upstream returned 429");
    expect(line?.title).toContain("rpc.nodeflare.app · blocked until");
    expect(line?.title).toContain("x.example · disabled");
    expect(line?.title).toContain("snapshot restored 3s ago, aged 3m at restore · last save 30s ago");
    // the visible age keeps growing after the restore (200 s at restore + 6 h since)
    expect(systemStatusLine({ restoredAt: NOW - 6 * 3_600_000, snapshotAge: 200_000 }, NOW)?.text).toBe("RPC POOL — · SNAP 6h OLD");
    expect(systemStatusLine({}, NOW)).toEqual({ text: "RPC POOL — · SNAP NONE", title: "no snapshot restored in this process" });
    expect(systemStatusLine(null, NOW)).toBeNull();
  });
});
