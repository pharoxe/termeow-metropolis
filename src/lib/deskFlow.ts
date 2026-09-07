import type { FeedHealth, FeedSourceHealth, FlowCandleInterval, FlowCandlesResponse, FlowWindow, LaunchRow, MarketCandle, MarketResponse, SystemHealth, TapePrint, TokenFlowResponse } from "../../shared/wire";
import type { InstrumentRef } from "./address";
import { formatIst } from "./chartTime";
import type { EventMarkerInput } from "./chartMarkers";
import type { FlowChartInput } from "./flowChart";
import { buildChartFlowInput, durationLabel, EM_DASH, printAgeLabel } from "./flowPanel";
import { money, signedMoney } from "./format";
import { sameInstrument } from "./instrument";

/**
 * Pure desk-page derivations for the R4 chart wire-up: which candle source feeds the chart per interval, which prints
 * are live (not yet in the candle feed), the reference-stable flow input, and the readout strip cells built from the
 * flow windows. No React, no Date.now(): callers pass `now`. Every label names its window or population.
 */

const CHART_INTERVALS = ["5S", "15S", "1M", "5M", "15M", "1H", "4H", "1D"] as const;
type ChartInterval = (typeof CHART_INTERVALS)[number];
const OWN_TAPE_INTERVALS: Record<string, FlowCandleInterval> = { "5S": "5s", "15S": "15s" };
/** Own-tape candles come from this server's in-memory ring; polling them is cheap and never hits an upstream. */
export const OWN_TAPE_POLL_MS = 5_000;
/** Market interval used for metadata (price, mcap) and the fallback series while a sub-minute chart is selected. */
export const SUB_MINUTE_MARKET_INTERVAL = "1m";
export const LAUNCH_POLL_MS = 120_000;

export function ownTapeInterval(label: string): FlowCandleInterval | null {
  return OWN_TAPE_INTERVALS[label.toUpperCase()] ?? null;
}

/** Lower-case interval for /api/market and /api/flow/token; sub-minute charts fall back to 1m upstream data. */
export function marketIntervalFor(label: string): string {
  return ownTapeInterval(label) ? SUB_MINUTE_MARKET_INTERVAL : label.toLowerCase();
}

/** A live tape exists when the ledger has covered any of the window or holds any print for this token. */
export function hasLiveTape(flow: TokenFlowResponse | null | undefined): boolean {
  if (!flow) return false;
  return (flow.coverage?.fraction ?? 0) > 0 || (flow.tape?.length ?? 0) > 0;
}

/** Interval chips: sub-minute only when a live tape can serve them. */
export function visibleIntervals(liveTape: boolean): ChartInterval[] {
  return CHART_INTERVALS.filter((label) => liveTape || !ownTapeInterval(label));
}

export type CandleSource = "market" | "own tape";
export type ActiveCandles = {
  candles: MarketCandle[];
  source: CandleSource;
  /** When the feed observed these candles; prints after it are live. Null when nothing has loaded. */
  observedAt: number | null;
  /** Visible note: the fallback reason when the own-tape route served no candles, or the registry's partial-source error while own-tape candles are on screen. */
  note: string | null;
  /** Coverage label for the own-tape series (priced/prints, span, producers); null for market candles. */
  label: string | null;
};

export function spanLabel(ms: number | null | undefined): string {
  return ms == null || !Number.isFinite(ms) || ms <= 0 ? EM_DASH : durationLabel(ms);
}

function ownTapeNote(own: FlowCandlesResponse | null): string {
  if (!own) return "NO OWN TAPE · loading";
  if (own.error) return `NO OWN TAPE · ${own.error}`;
  return `NO OWN TAPE · ${own.priced} priced of ${own.prints} ring prints`;
}

/** "own 170 · geckoterminal 10" when a producer other than this server's decoder priced any of the bars; empty otherwise. */
function producersLabel(own: FlowCandlesResponse): string {
  const entries = Object.entries(own.pricedBySource ?? {}).filter(([, count]) => (count ?? 0) > 0);
  if (entries.every(([source]) => source === "own")) return "";
  return ` · PRICED BY ${entries.map(([source, count]) => `${source} ${count}`).join(" · ")}`;
}

/**
 * One source per series: own-tape candles whenever the route served any (a partial registry error such as a Gecko
 * backoff does not invalidate ring prints; it is shown as a note), else the 1m market candles with a visible note. Never mixed.
 */
export function selectCandles(interval: string, market: MarketResponse | null, own: FlowCandlesResponse | null): ActiveCandles {
  const marketCandles = market?.candles ?? [];
  if (!ownTapeInterval(interval)) return { candles: marketCandles, source: "market", observedAt: market?.observedAt ?? null, note: null, label: null };
  if (own && own.candles.length) {
    return {
      candles: own.candles,
      source: "own tape",
      observedAt: own.observedAt,
      note: own.error ? `OWN TAPE · registry: ${own.error}` : null,
      label: `OWN TAPE · ${own.priced}/${own.prints} PRICED · ${spanLabel(own.spanMs)} SPAN${producersLabel(own)}`
    };
  }
  return { candles: marketCandles, source: "market", observedAt: market?.observedAt ?? null, note: ownTapeNote(own), label: null };
}

/** Identity of the candle stream; the source is part of it so an own-tape → market fallback resets the series instead of blending. */
export function candleSeriesKey(instrument: InstrumentRef, interval: string, source: CandleSource): string {
  return `${instrument.chain}:${instrument.address}:${interval}:${source}`;
}

/** Prints the candle feed has not seen: strictly after its observedAt. Nothing when the feed time is unknown (no double counting). */
export function livePrintsAfter(tape: TapePrint[] | undefined, sinceMs: number | null): TapePrint[] {
  if (!tape || sinceMs == null || !Number.isFinite(sinceMs)) return [];
  return tape.filter((print) => print.time > sinceMs);
}

function lastOf<T>(items: ReadonlyArray<T>): T | undefined {
  return items.length ? items[items.length - 1] : undefined;
}

/** Changes only when the chart-relevant part of the flow poll changed: bar count/tail, coverage, pair set, candle span. */
export function flowSignature(flow: TokenFlowResponse, candles: ReadonlyArray<{ time: number }>): string {
  const last = lastOf(flow.bars);
  const pairs = flow.pairs.map((pair) => `${pair.pairAddress}:${pair.tier}:${pair.bars.length}:${lastOf(pair.bars)?.t ?? ""}:${lastOf(pair.bars)?.cvd ?? ""}`).join(",");
  return [
    flow.bars.length, last?.t ?? "", last?.buyUsd ?? "", last?.sellUsd ?? "", last?.cvd ?? "",
    flow.coverage.fraction, flow.coverage.firstPrintAt ?? "", pairs,
    candles.length, candles[0]?.time ?? "", lastOf(candles)?.time ?? ""
  ].join("|");
}

export type StableFlow = { signature: string; input: FlowChartInput };

/** Reuses the previous chart input when the signature matches so the chart's in-place path sees a stable reference. */
export function stableChartFlow(previous: StableFlow | null, flow: TokenFlowResponse | null, candles: ReadonlyArray<{ time: number }>): StableFlow | null {
  if (!flow) return null;
  const signature = flowSignature(flow, candles);
  if (previous && previous.signature === signature) return previous;
  return { signature, input: buildChartFlowInput(flow, candles) };
}

export function windowByLabel(windows: FlowWindow[] | undefined, label: FlowWindow["label"]): FlowWindow | null {
  return windows?.find((window) => window.label === label) ?? null;
}

export type FlowBias = "BUY" | "SELL" | "FLAT";

export function flowBias(net: number | null | undefined): FlowBias | null {
  if (net == null || !Number.isFinite(net)) return null;
  return net > 0 ? "BUY" : net < 0 ? "SELL" : "FLAT";
}

export type Tone = "up" | "dn" | "";

export function biasTone(bias: FlowBias | string | null | undefined): Tone {
  const key = String(bias ?? "").toLowerCase();
  if (key === "buy" || key === "bullish") return "up";
  if (key === "sell" || key === "bearish") return "dn";
  return "";
}

function signTone(value: number | null | undefined): Tone {
  if (value == null || !Number.isFinite(value)) return "";
  return value > 0 ? "up" : value < 0 ? "dn" : "";
}

export type ReadoutCell = { key: string; label: string; value: string; tone: Tone };

/**
 * Chart readout cells from the flow response (Tier A ledger). Windows are rolling and end at observedAt; the anchor
 * cells sum from the flow anchor (WINDOW = first bar of the polled range). Missing data renders an em-dash, never 0.
 */
export function flowReadoutCells(flow: TokenFlowResponse | null): ReadoutCell[] {
  const w5 = windowByLabel(flow?.windows, "5m");
  const w1h = windowByLabel(flow?.windows, "1h");
  const since = flow?.sinceAnchor && flow.sinceAnchor.startMs != null ? flow.sinceAnchor : null;
  const anchor = (flow?.anchor ?? "window").toUpperCase();
  const bias = flowBias(w1h?.net);
  return [
    { key: "net5m", label: "NET 5M", value: w5 ? signedMoney(w5.net) : EM_DASH, tone: signTone(w5?.net) },
    { key: "net1h", label: "NET 1H", value: w1h ? signedMoney(w1h.net) : EM_DASH, tone: signTone(w1h?.net) },
    { key: "cvd", label: `CVD ${anchor}`, value: since ? signedMoney(since.net) : EM_DASH, tone: signTone(since?.net) },
    { key: "buy", label: `BUY ${anchor}`, value: since ? money(since.buyUsd, true) : EM_DASH, tone: since ? "up" : "" },
    { key: "sell", label: `SELL ${anchor}`, value: since ? money(since.sellUsd, true) : EM_DASH, tone: since ? "dn" : "" },
    { key: "flow1h", label: "FLOW 1H", value: bias ?? EM_DASH, tone: biasTone(bias) },
    { key: "bs1h", label: "1H B/S", value: w1h ? `B${w1h.buys}/S${w1h.sells}${w1h.unpriced ? ` (${w1h.unpriced}u)` : ""}` : EM_DASH, tone: "" }
  ];
}

/** The launch-index row for the focused token, if the 24h launches list carries it. */
export function launchRowFor(rows: LaunchRow[] | undefined, instrument: InstrumentRef): LaunchRow | null {
  return rows?.find((row) => sameInstrument({ chain: row.chain, address: row.token }, instrument)) ?? null;
}

/** Launch/graduation from the launch index; else the flow anchor start only when the poll was anchored at launch. Large prints from the flow. */
export function eventMarkerInput(launch: LaunchRow | null, flow: TokenFlowResponse | null): EventMarkerInput {
  const anchoredLaunch = flow?.anchor === "launch" && flow.sinceAnchor?.startMs != null ? { createdAt: flow.sinceAnchor.startMs, launchpad: "" } : null;
  return {
    launch: launch ? { createdAt: launch.createdAt, launchpad: launch.launchpad } : anchoredLaunch,
    graduation: launch?.graduatedAt != null ? { time: launch.graduatedAt } : null,
    largePrints: flow?.largePrints ?? []
  };
}

// ---- R6: candle provenance, no-candles reason, feed health, last-good flow, system status ----

/** "07 Sep 09:12 IST" for chart meta (formatIst without the year). */
const shortIst = (ms: number | null | undefined): string => formatIst(ms, "minute", true, false);

/**
 * Chart meta for the market series: "CHAIN SWAPS · 1,840 BARS · FROM 07 Sep 09:12 IST" (plus BACKFILLING / PARTIAL when
 * the fill is not complete, STALE HEAD when the last top-up failed) or "GECKOTERMINAL · FALLBACK · 200 BARS"; null for
 * own-tape series (they carry their own label) and for the legacy path without candleSource.
 */
export function candleSourceMeta(market: MarketResponse | null, source: CandleSource): string | null {
  const info = market?.candleSource;
  if (!info || source !== "market") return null;
  const parts = [info.kind.toUpperCase()];
  if (info.kind === "geckoterminal") parts.push("FALLBACK");
  parts.push(`${info.coverage.bars.toLocaleString("en-US")} BARS`);
  if (info.coverage.fromMs != null) parts.push(`FROM ${shortIst(info.coverage.fromMs)}`);
  if (info.coverage.backfilling) parts.push("BACKFILLING");
  else if (info.kind === "chain swaps" && !info.coverage.complete) parts.push("PARTIAL");
  if (info.kind === "chain swaps" && market?.stale) parts.push("STALE HEAD");
  if (info.live > 0) parts.push(`${info.live} LIVE PRINTS`);
  return parts.join(" · ");
}

/** Why the chart is empty, from the route's own notes (never a generic Gecko guess when the server said something else). */
export function noCandlesReason(market: MarketResponse | null, error: string): string {
  if (market?.candleSource?.coverage.backfilling) return `Chain swap backfill running (${market.candleSource.coverage.prints} swaps so far) · bars appear on the next read.`;
  const notes = (market?.notes ?? []).filter((note) => /candle|ohlcv|swap|pool|curve|print/i.test(note));
  if (notes.length) return notes.join(" · ");
  if (market?.error) return market.error;
  if (error) return error;
  return market ? `No candles from ${market.source}.` : "No candle source has answered yet.";
}

export type FeedHealthChip = { key: keyof FeedHealth; label: "OWN" | "GECKO" | "PUMP"; tone: "good" | "warn" | "bad" | "off"; title: string };
const FEED_LABELS: Record<keyof FeedHealth, FeedHealthChip["label"]> = { own: "OWN", gecko: "GECKO", pumpfun: "PUMP" };

function feedTone(source: FeedSourceHealth): FeedHealthChip["tone"] {
  if (source.ok) return "good";
  if (source.nextRetryAt != null) return "warn";
  return source.lastOkAt != null || source.lastError ? "bad" : "off";
}

/** One chip per print source from the server's feedHealth: tone by ok/backoff, title with last ok, error and retry time. */
export function feedHealthChips(health: FeedHealth | undefined, now: number): FeedHealthChip[] {
  if (!health) return [];
  return (Object.keys(FEED_LABELS) as Array<keyof FeedHealth>).filter((key) => health[key]).map((key) => {
    const source = health[key];
    const parts: string[] = [FEED_LABELS[key], source.ok ? "ok" : "down", source.lastOkAt == null ? "never ok" : `last ok ${printAgeLabel(source.lastOkAt, now)} ago`];
    if (source.lastError) parts.push(source.lastError);
    if (source.nextRetryAt != null && source.nextRetryAt > now) parts.push(`retry in ${durationLabel(source.nextRetryAt - now)}`);
    return { key, label: FEED_LABELS[key], tone: feedTone(source), title: parts.join(" · ") };
  });
}

export function allFeedsDown(health: FeedHealth | undefined): boolean {
  return Boolean(health) && !Object.values(health as FeedHealth).some((source) => source.ok);
}

/** Copy under an empty TYPE column: names the down sources instead of implying the pool is quiet. */
export function tapeEmptyCopy(flow: TokenFlowResponse | null | undefined): string {
  const health = flow?.feedHealth;
  if (health && allFeedsDown(health)) {
    const reasons = feedHealthChips(health, flow?.observedAt ?? 0).map((chip) => `${chip.label}${health[chip.key].lastError ? ` ${health[chip.key].lastError}` : ""}`);
    return `No pool prints held · every print source is down (${reasons.join(" · ")}).`;
  }
  return "No pool prints in this window.";
}

/**
 * Next flow state for the panel: a failed poll (`next` null) or an error envelope keeps the previous response, marked
 * stale with the new error, so the last-good tape stays on screen with a visible label instead of vanishing.
 */
export function nextFlowState(previous: TokenFlowResponse | null, next: TokenFlowResponse | null, failure = "flow request failed"): TokenFlowResponse | null {
  if (!next) return previous ? { ...previous, stale: true, error: failure } : null;
  if (next.error && previous && !next.tape?.length && (previous.tape?.length ?? 0) > 0) return { ...previous, stale: true, error: next.error };
  return next;
}

export type StatusLine = { text: string; title: string };

/** One line for the toolbar: "RPC 4/6 UP · LOGS 2 · SNAP 3m OLD"; the title lists every endpoint's health. */
export function systemStatusLine(health: SystemHealth | null, now: number): StatusLine | null {
  if (!health) return null;
  const pool = health.robinhoodRpc;
  const parts: string[] = [];
  const lines: string[] = [];
  if (pool) {
    const enabled = pool.endpoints.filter((endpoint) => endpoint.enabled);
    const up = enabled.filter((endpoint) => endpoint.ok);
    const logs = up.filter((endpoint) => endpoint.logs).length;
    parts.push(`RPC ${up.length}/${pool.endpoints.length} UP`, `LOGS ${logs}`);
    for (const endpoint of pool.endpoints) {
      const host = endpoint.url.replace(/^https?:\/\//, "").split("/")[0];
      const state = !endpoint.enabled ? "disabled" : endpoint.ok ? "up" : endpoint.blockedUntil ? `blocked until ${shortIst(Date.parse(endpoint.blockedUntil))}` : "down";
      lines.push(`${host} · ${state}${endpoint.logs ? " · logs" : ""} · p50 ${endpoint.p50Ms == null ? EM_DASH : `${Math.round(endpoint.p50Ms)}ms`} · ${endpoint.calls} calls · ${endpoint.rateLimited} 429${endpoint.lastError ? ` · ${endpoint.lastError}` : ""}`);
    }
  } else parts.push("RPC POOL —");
  if (health.snapshotAge != null && health.restoredAt != null) {
    // the server reports the file's age at restore time; the data has kept ageing since
    parts.push(`SNAP ${durationLabel(health.snapshotAge + Math.max(0, now - health.restoredAt))} OLD`);
    lines.push(`snapshot restored ${printAgeLabel(health.restoredAt, now)} ago, aged ${durationLabel(health.snapshotAge)} at restore${health.snapshot?.lastSaveAt != null ? ` · last save ${printAgeLabel(health.snapshot.lastSaveAt, now)} ago` : ""}`);
  } else {
    parts.push("SNAP NONE");
    lines.push("no snapshot restored in this process");
  }
  return { text: parts.join(" · "), title: lines.join("\n") };
}
