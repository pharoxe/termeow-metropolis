import { describe, expect, it } from "vitest";
import type { FlowCandlesResponse, FlowWindow, LaunchRow, MarketResponse, TapePrint, TokenFlowResponse } from "../../shared/wire";
import {
  aggregateReadoutCells, allFeedsDown, candleSeriesKey, candleSourceMeta, coverageHeadline, coverageNotes, eventMarkerInput, feedHealthChips, flowBias, flowReadoutCells, flowSignature, hasLiveTape, launchRowFor, livePrintsAfter,
  marketIntervalFor, nextFlowState, noCandlesReason, ownTapeInterval, selectCandles, spanLabel, stableChartFlow, systemStatusLine, tapeEmptyCopy, visibleIntervals, windowByLabel
} from "./deskFlow";
import type { CoverageInput } from "./deskFlow";
import { EM_DASH } from "./flowPanel";

const FATCOIN = "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01";
const NOW = 1_788_717_300_000;

function flow(overrides: Partial<TokenFlowResponse> = {}): TokenFlowResponse {
  return {
    chain: "monad", address: FATCOIN, interval: "1m", anchor: "window",
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
    instrument: { chain: "monad", address: FATCOIN, symbol: "FAT", name: "Fatcoin", image: null, socials: [], websites: [] },
    priceUsd: 0.02, marketCapUsd: 20_000_000, fdvUsd: null, liquidityUsd: 1, volume24Usd: 1, change24Pct: 0, primaryPair: null,
    candles: [{ time: NOW - 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }], interval: "1m", observedAt: NOW - 5000, source: "gecko", degraded: false, notes: [],
    ...overrides
  };
}

function own(overrides: Partial<FlowCandlesResponse> = {}): FlowCandlesResponse {
  return {
    chain: "monad", address: FATCOIN, interval: "15s", candles: [{ time: NOW - 15_000, open: 0.02, high: 0.02, low: 0.02, close: 0.02, volume: 12 }],
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
  it("does not render old timeframe bars while a different interval loads", () => {
    expect(selectCandles("4H", market(), null).candles).toEqual([]);
    expect(selectCandles("5S", market(), own({ interval: "15s" })).source).toBe("market");
  });
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
    expect(selectCandles("5S", market(), own({ interval: "5s", error: "untracked: down", candles: [] }))).toMatchObject({ source: "market", note: "NO OWN TAPE · untracked: down", observedAt: NOW - 5000 });
    expect(selectCandles("5S", market(), own({ interval: "5s", candles: [], priced: 0, prints: 7 })).note).toBe("NO OWN TAPE · 0 priced of 7 ring prints");
    expect(selectCandles("5S", market(), null).note).toBe("NO OWN TAPE · loading");
    expect(selectCandles("5S", null, null).candles).toEqual([]);
  });
  it("keys the series by source so a fallback resets instead of blending", () => {
    const ref = { chain: "monad" as const, address: FATCOIN };
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
    chain: "monad", launchpad: "pons", token: FATCOIN.toUpperCase().replace("0X", "0x"), symbol: "FAT", name: null, image: null, creator: null, curve: null, pool: null,
    createdAt: NOW - 3_600_000, tx: "0xabc", graduatedAt: NOW - 1_800_000, priceUsd: null, marketCapUsd: null, liquidityUsd: null, volume24Usd: null, change24Pct: null,
    pricedAt: null, curveBuys: 0, curveSells: 0, curveNetUsd: null, tracked: null, sources: [], observedAt: NOW
  };
  it("finds the focused token case-insensitively on Monad and builds launch + graduation from the index row", () => {
    const found = launchRowFor([row], { chain: "monad", address: FATCOIN });
    expect(found).toBe(row);
    expect(launchRowFor([row], { chain: "monad", address: "0x0000000000000000000000000000000000000001" })).toBeNull();
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
    gecko: { ok: true, lastOkAt: NOW - 2_000, lastError: null, nextRetryAt: null }
  };
  const geckoDown = { ok: false, lastOkAt: null, lastError: "GeckoTerminal backoff active after 429", nextRetryAt: null };
  it("builds one chip per source with tone and a title naming error and retry", () => {
    const chips = feedHealthChips(health, NOW);
    expect(chips.map((chip) => [chip.label, chip.tone])).toEqual([["OWN", "warn"], ["GECKO", "good"]]);
    expect(chips[0].title).toBe("OWN · down · last ok 40s ago · rpc 429 rate limited · retry in 18s");
    expect(feedHealthChips(undefined, NOW)).toEqual([]);
    expect(allFeedsDown(health)).toBe(false);
    expect(allFeedsDown({ ...health, gecko: geckoDown })).toBe(true);
    expect(feedHealthChips({ ...health, gecko: geckoDown }, NOW)[1].tone).toBe("bad");
  });
  it("explains an empty tape by the down sources", () => {
    expect(tapeEmptyCopy(flow({ feedHealth: { ...health, gecko: geckoDown } }))).toBe("No pool prints held · every print source is down (OWN rpc 429 rate limited · GECKO GeckoTerminal backoff active after 429).");
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
      monadRpc: { chainId: 4663, endpoints: [
        { url: "https://monad-rpc.publicnode.com", ok: true, enabled: true, disabledReason: null, chainVerified: true, logs: false, blockedUntil: null, calls: 10, rateLimited: 0, failures: 0, p50Ms: 195, lastError: null },
        { url: "https://rpc.mainnet.chain.monad.com/", ok: true, enabled: true, disabledReason: null, chainVerified: true, logs: true, blockedUntil: null, calls: 4, rateLimited: 1, failures: 1, p50Ms: 385.4, lastError: "upstream returned 429" },
        { url: "https://rpc.nodeflare.app/monad/public", ok: false, enabled: true, disabledReason: null, chainVerified: true, logs: true, blockedUntil: new Date(NOW + 20_000).toISOString(), calls: 1, rateLimited: 1, failures: 0, p50Ms: null, lastError: "rate_limited" },
        { url: "https://x.example", ok: false, enabled: false, disabledReason: "eth_chainId 1 != 4663", chainVerified: false, logs: false, blockedUntil: null, calls: 0, rateLimited: 0, failures: 0, p50Ms: null, lastError: null }
      ] },
      monadTransport: { label: "MIXED", mode: "mixed", wsEnabled: true, pollers: [
        { name: "launch", mode: "ws", wsEnabled: true, httpCursor: 57_053_099, catchUpTicks: 12, wsLogs: 400, lastWsBlock: 57_053_120, ws: { connected: true, url: "wss://monad-rpc.publicnode.com", connectedAt: NOW - 600_000, subscriptions: 8, wantedLegs: 8, rejectedLegs: 0, reconnects: 1, lastError: null } },
        { name: "tape", mode: "http", wsEnabled: true, httpCursor: 57_053_090, catchUpTicks: 3, wsLogs: 20, lastWsBlock: 57_053_000, ws: { connected: false, url: "wss://monad.api.pocket.network", connectedAt: null, subscriptions: 0, wantedLegs: 2, rejectedLegs: 0, reconnects: 2, lastError: "closed (1006)" } }
      ] }
    }, NOW);
    expect(line?.text).toBe("RPC 2/4 UP · LOGS 1 · MIXED · SNAP 3m OLD");
    expect(line?.title).toMatch(/launch · prints via WS · monad-rpc\.publicnode\.com up since \d\d [A-Z][a-z]{2} \d\d:\d\d IST · 8\/8 legs · HTTP verified to 57053099/);
    expect(line?.title).toContain("tape · prints via HTTP · socket down · 2 reconnects · HTTP verified to 57053090 · closed (1006)");
    expect(line?.title).toContain("rpc.mainnet.chain.monad.com · up · logs · p50 385ms · 4 calls · 1 429 · upstream returned 429");
    expect(line?.title).toContain("rpc.nodeflare.app · blocked until");
    expect(line?.title).toContain("x.example · disabled");
    expect(line?.title).toContain("snapshot restored 3s ago, aged 3m at restore · last save 30s ago");
    // the visible age keeps growing after the restore (200 s at restore + 6 h since)
    expect(systemStatusLine({ restoredAt: NOW - 6 * 3_600_000, snapshotAge: 200_000 }, NOW)?.text).toBe("RPC POOL — · SNAP 6h OLD");
    expect(systemStatusLine({}, NOW)).toEqual({ text: "RPC POOL — · SNAP NONE", title: "no snapshot restored in this process" });
    expect(systemStatusLine(null, NOW)).toBeNull();
  });
});

describe("coverage disclosure", () => {
  const base: CoverageInput = {
    series: { bars: 120, source: "GECKO", interval: "15M", meta: "provider OHLCV", note: null },
    aggregate: { error: "", data: { capturedPools: 4, knownPools: 4, buyUsd: 1000, sellUsd: 400, delta: 600, trades: 80, unpriced: 0 } },
    launch: { launchpad: "pump.fun", createdAt: NOW - 86_400_000 },
    replay: false,
    baselines: { checked: 12, total: 12, refreshMs: 600_000, error: "" }
  };

  it("keeps every caveat line the stacked lanes carried", () => {
    const notes = coverageNotes(base);
    expect(notes.map((note) => note.key)).toEqual(["series", "aggregate", "cvd", "event", "baselines"]);
    expect(notes[0].detail).toBe("120 BARS · GECKO · 15M · provider OHLCV");
    expect(notes[1].detail).toContain("4/4 known pools with captured trades");
    expect(notes[1].detail).toContain("0 of 80 rows unpriced and summed as 0");
    // the CVD caveat is a standing one: it qualifies the series no matter how complete the pool coverage is
    expect(notes[2].detail).toContain("pool turnover, not net wallet inflow");
    expect(notes[2].partial).toBe(true);
    expect(notes[3].detail).toBe("pump.fun launch · Provider OHLCV · trade markers may cover additional venues");
    expect(notes[4].detail).toBe("12/12 checked · refresh target 10m · up to 32 active wallets");
  });

  it("marks partial coverage rather than reading it as complete", () => {
    const partial = coverageNotes({
      ...base,
      series: { ...base.series, note: "own tape unavailable, showing 1m market bars" },
      aggregate: { error: "", data: { capturedPools: 2, knownPools: 9, buyUsd: 10, sellUsd: 4, delta: 6, trades: 12, unpriced: 3 } },
      launch: null,
      baselines: { checked: 41, total: 117, refreshMs: 600_000, error: "" }
    });
    expect(partial.filter((note) => note.partial).map((note) => note.key)).toEqual(["series", "aggregate", "cvd", "event", "baselines"]);
    expect(partial[1].detail).toContain("2/9 known pools");
    expect(partial[3].detail).toContain("No sourced launch event in the loaded index");
    expect(partial[4].detail).toContain("41/117 checked");
  });

  it("reports an unloaded or failed aggregate as unknown, never as zero", () => {
    const loading = coverageNotes({ ...base, aggregate: { error: "", data: null } });
    expect(loading[1].detail).toBe("Loading captured pool flow…");
    expect(loading[1].partial).toBe(true);
    const failed = coverageNotes({ ...base, aggregate: { error: "aggregate flow request failed", data: null } });
    expect(failed[1].detail).toBe("aggregate flow request failed");
    expect(failed[1].partial).toBe(true);
  });

  it("leads the collapsed headline with which notes are partial, then the series", () => {
    // The summary is clipped to one row, so the caveat must come before the detail an ellipsis is allowed to eat.
    expect(coverageHeadline(coverageNotes(base))).toBe("1/5 PARTIAL OR UNKNOWN: CVD · 120 BARS · GECKO · 15M · provider OHLCV");
    const worst = coverageNotes({ ...base, series: { ...base.series, bars: 0 }, aggregate: { error: "flow down", data: null }, launch: null, replay: true, baselines: { checked: 0, total: 117, refreshMs: 600_000, error: "baseline scan unavailable" } });
    expect(coverageHeadline(worst)).toContain("5/5 PARTIAL OR UNKNOWN: SERIES · AGGREGATE FLOW · CVD · EVENT CONTEXT · PARTICIPANT BASELINES");
  });

  describe("aggregate readout cells", () => {
    const window = "the 120 loaded 15M bars";
    it("names the population, the window and the rows that were summed as zero", () => {
      const cells = aggregateReadoutCells({ error: "", data: { capturedPools: 2, knownPools: 9, buyUsd: 1000, sellUsd: 400, delta: 600, trades: 80, unpriced: 12 } }, window);
      expect(cells.map((cell) => cell.label)).toEqual(["AGG BUY", "AGG SELL", "WINDOW DELTA"]);
      expect(cells[0].value).toBe("$1K (12u)");
      expect(cells[0].title).toContain("Captured pool trades only, over the 120 loaded 15M bars");
      expect(cells[0].title).toContain("2/9 known pools captured");
      expect(cells[0].title).toContain("12 of 80 rows carry no USD and are summed as 0, so this is a floor, not a total");
      expect(cells[2].tone).toBe("up");
    });
    it("shows an unloaded aggregate as unknown, never as zero", () => {
      const cells = aggregateReadoutCells({ error: "", data: null }, window);
      expect(cells.map((cell) => cell.value)).toEqual([EM_DASH, EM_DASH, EM_DASH]);
      expect(cells[0].title).toContain("not loaded yet");
    });
    it("marks the previous window's numbers stale when the poll that should have replaced them failed", () => {
      const cells = aggregateReadoutCells({ error: "Aggregate unavailable (503)", data: { capturedPools: 4, knownPools: 4, buyUsd: 1000, sellUsd: 400, delta: 600, trades: 80, unpriced: 0 } }, window);
      expect(cells[0].value).toBe("$1K · STALE");
      expect(cells[0].title).toContain("NOT CURRENT");
      expect(cells[0].title).toContain("Aggregate unavailable (503)");
    });
  });
});
