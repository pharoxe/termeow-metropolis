import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../api/client";
import type { OnchainMarket, PublicConfig } from "../types";
import { MarketChart, type ChartScaleMode, type IndicatorSet, type MarketChartHandle } from "../components/MarketChart";
import { IndicatorBar } from "../components/IndicatorBar";
import { ExecutionRail } from "../components/ExecutionRail";
import { AuthControls } from "../auth/AuthControls";
import { money, pct } from "../lib/format";
import { atr, macd, rsi } from "../lib/indicators";
import { MINT_RE } from "../lib/mint";
import { extractAddress, type InstrumentRef } from "../lib/address";
import { brandSuffix, instrumentKey, isEmptyMarket, isValidInstrument, legacyMarket, sameInstrument, tapeRows } from "../lib/instrument";
import { mcapScale, scaleCandlesToMcap } from "../lib/mcap";
import type { FlowCandlesResponse, LaunchRow, MarketResponse, TokenFlowResponse } from "../../shared/wire";
import { buildFomoMarkers } from "../lib/fomoMarkers";
import { buildEventMarkers } from "../lib/chartMarkers";
import { parseIntervalMs } from "../lib/chartTime";
import type { LiveCandleStats } from "../lib/liveCandle";
import { analysisFlowFromWindows } from "../lib/agenticAnalysis";
import {
  LAUNCH_POLL_MS, OWN_TAPE_POLL_MS, biasTone, candleSeriesKey, eventMarkerInput, flowReadoutCells, hasLiveTape, launchRowFor,
  livePrintsAfter, marketIntervalFor, ownTapeInterval, selectCandles, stableChartFlow, visibleIntervals, SUB_MINUTE_MARKET_INTERVAL, type StableFlow
} from "../lib/deskFlow";
import { DrawingToolbar, type DrawingsApi, type DrawingsSnapshot } from "../chart/drawings";
import { BothSidesPanel, MarketStrips, SocialPanel, WatchPanel } from "../components/DeskPanels";
import { FomoTapePanel } from "../components/FomoTapePanel";
import { ThemeToggle, useTheme } from "../components/ThemeToggle";
import { FeatureSection } from "../features/WorkspaceFeatures";
import { AccountScreen } from "../components/AccountScreens";
import { AgenticAnalysisPanel } from "../components/AgenticAnalysis";
import { SfxToggle, useNotifications } from "../components/NotificationSystem";
import { useFundingNetwork } from "../features/NetworkContext";

type ChartUnit = "price" | "mcap";
type Row = Record<string, unknown>;
const initialIndicators: IndicatorSet = {
  ema: true, bollinger: false, vwap: true, sr: true, volume: true, cvd: true, rsi: false, macd: false, obv: false
};
const CHART_UNIT_KEY = "desk-chart-unit";
const CHART_SCALE_KEY = "desk-chart-scale";

/** localStorage-backed choice among `allowed`; the fallback on a missing/foreign value or an unavailable store (private mode). */
function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return allowed.find((value) => value === stored) ?? fallback;
  } catch {
    return fallback;
  }
}
function persistStored(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore quota / private mode */ }
}
const readChartUnit = () => readStored<ChartUnit>(CHART_UNIT_KEY, ["price", "mcap"], "mcap");
const persistChartUnit = (unit: ChartUnit) => persistStored(CHART_UNIT_KEY, unit);
const readChartScale = () => readStored<ChartScaleMode>(CHART_SCALE_KEY, ["linear", "log"], "linear");
const persistChartScale = (mode: ChartScaleMode) => persistStored(CHART_SCALE_KEY, mode);

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function array(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item && typeof item === "object")) : [];
}
function lastValue(values: Array<number | null>) {
  for (let index = values.length - 1; index >= 0; index -= 1) if (values[index] != null) return values[index];
  return null;
}

function providerImageUrl(value: unknown): string | null {
  const imageKeys = new Set(["token_image_url", "image_url", "imageUrl", "logo_url", "logoUrl", "icon_url", "iconUrl", "image", "logo", "icon"]);
  const visit = (current: unknown, depth = 0): string | null => {
    if (!current || depth > 6) return null;
    if (Array.isArray(current)) {
      for (const item of current) { const found = visit(item, depth + 1); if (found) return found; }
      return null;
    }
    if (typeof current !== "object") return null;
    for (const [key, child] of Object.entries(current as Row)) {
      if (imageKeys.has(key) && typeof child === "string" && /^https?:\/\//i.test(child)) return child;
    }
    for (const child of Object.values(current as Row)) { const found = visit(child, depth + 1); if (found) return found; }
    return null;
  };
  return visit(value);
}

export function DeskPage({ config }: { config: PublicConfig }) {
  const [theme, setTheme] = useTheme();
  const { network, setNetwork } = useFundingNetwork();
  const { notify } = useNotifications();
  const [section, setSection] = useState("Trade");
  const [searchOpen, setSearchOpen] = useState(false);
  const [instrument, setInstrument] = useState<InstrumentRef>({ chain: "solana", address: config.ansemMint });
  const solana = instrument.chain === "solana";
  const [query, setQuery] = useState("");
  const [interval, setIntervalValue] = useState("15M");
  const [chartExpanded, setChartExpanded] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const chartRef = useRef<MarketChartHandle>(null);
  const lastNotifiedInstrument = useRef("");
  const lastNotifiedError = useRef("");
  const [indicators, setIndicators] = useState(initialIndicators);
  const [board, setBoard] = useState<Row>({});
  const [spot, setSpot] = useState<MarketResponse | null>(null);
  const [error, setError] = useState("");
  const [trenchSort, setTrenchSort] = useState<"hot" | "new" | "mcap" | "volume">("hot");
  const [trenches, setTrenches] = useState<Row>({});
  const [holders, setHolders] = useState<Row>({});
  const [flowState, setFlowState] = useState<TokenFlowResponse | null>(null);
  /** Own-tape candles for the 5S/15S chips; null until the route answered (or while a minute+ interval is selected). */
  const [ownCandles, setOwnCandles] = useState<FlowCandlesResponse | null>(null);
  const [launchRows, setLaunchRows] = useState<LaunchRow[]>([]);
  const [liveStats, setLiveStats] = useState<LiveCandleStats | null>(null);
  const [drawingsApi, setDrawingsApi] = useState<DrawingsApi | null>(null);
  const [drawings, setDrawings] = useState<DrawingsSnapshot | null>(null);
  const [chartUnit, setChartUnit] = useState<ChartUnit>(readChartUnit);
  const [scaleMode, setScaleMode] = useState<ChartScaleMode>(readChartScale);
  const selectChartUnit = (unit: ChartUnit) => {
    setChartUnit(unit);
    persistChartUnit(unit);
  };
  const selectScale = (mode: ChartScaleMode) => {
    setScaleMode(mode);
    persistChartScale(mode);
  };
  const ownInterval = ownTapeInterval(interval);

  useEffect(() => {
    if (!solana) { setBoard({}); return; }
    let active = true;
    const load = () => api.board().then((value) => { if (active) setBoard(object(value)); }).catch(() => undefined);
    load();
    const timer = setInterval(load, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [solana]);

  useEffect(() => {
    if (!solana) { setTrenches({}); return; }
    let active = true;
    const load = () => api.trenches(trenchSort).then((value) => { if (active) setTrenches(object(value)); }).catch(() => { if (active) setTrenches({ tokens: [], error: "trenches unavailable" }); });
    load();
    const timer = setInterval(load, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [trenchSort, solana]);

  useEffect(() => {
    setHolders({});
    if (!solana) return;
    let active = true;
    const load = () => api.holders(instrument.address).then((value) => { if (active) setHolders(object(value)); }).catch(() => { if (active) setHolders({ holders: [], error: "holders unavailable" }); });
    load();
    const timer = setInterval(load, 45_000);
    return () => { active = false; clearInterval(timer); };
  }, [instrument, solana]);

  useEffect(() => {
    let active = true;
    const requested = instrument;
    setSpot((current) => (current && sameInstrument(current.instrument, requested) ? current : null));
    const load = () => api.market(requested.chain, requested.address, marketIntervalFor(interval))
      .then((value) => {
        if (!active || !sameInstrument(value.instrument, requested)) return;
        setError(value.error || "");
        if (!isEmptyMarket(value)) setSpot(value);
      })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : String(reason)));
    load();
    const timer = setInterval(load, 45_000);
    return () => { active = false; clearInterval(timer); };
  }, [instrument, interval]);

  const feed = spot && sameInstrument(spot.instrument, instrument) ? spot : null;
  const legacy = useMemo(() => (feed ? legacyMarket(feed) : null), [feed]);
  // Own-tape candles (this server's priced ring prints) for the sub-minute chips; a failed call is a visible error envelope, never fabricated bars.
  useEffect(() => {
    setOwnCandles(null);
    if (!ownInterval || !isValidInstrument(instrument)) return;
    let active = true;
    const requested = instrument;
    const load = () => api.flowCandles(requested.chain, requested.address, ownInterval)
      .then((value) => { if (active) setOwnCandles(value); })
      .catch((reason) => {
        if (!active) return;
        const error = reason instanceof Error ? reason.message : String(reason);
        setOwnCandles({ chain: requested.chain, address: requested.address, interval: ownInterval, candles: [], source: "own tape", spanMs: 0, prints: 0, priced: 0, firstPrintAt: null, pricedBySource: {}, observedAt: Date.now(), error });
      });
    load();
    const timer = setInterval(load, OWN_TAPE_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [instrument, ownInterval]);

  // Launch index rows for the focused chain: launch/graduation markers come from the row whose token is the focused address, if any.
  useEffect(() => {
    setLaunchRows([]);
    if (!isValidInstrument(instrument)) return;
    let active = true;
    const load = () => api.launches({ chain: instrument.chain, window: "24h", stocks: true })
      .then((value) => { if (active) setLaunchRows(value.launches ?? []); })
      .catch(() => undefined);
    load();
    const timer = setInterval(load, LAUNCH_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [instrument]);

  useEffect(() => {
    if (!drawingsApi) {
      setDrawings(null);
      return;
    }
    return drawingsApi.subscribe(setDrawings);
  }, [drawingsApi]);

  useEffect(() => {
    if (!isValidInstrument(instrument)) {
      setFlowState(null);
      return;
    }
    let active = true;
    const load = () => api.flowToken(instrument.chain, instrument.address, marketIntervalFor(interval))
      .then((value) => {
        if (active) setFlowState((previous) => (value.error && previous ? previous : value));
      })
      .catch(() => {
        if (active) setFlowState(null);
      });
    load();
    const timer = setInterval(load, 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [instrument, interval]);

  useEffect(() => {
    if (!feed || lastNotifiedInstrument.current === instrumentKey(feed.instrument)) return;
    lastNotifiedInstrument.current = instrumentKey(feed.instrument);
    notify({ title: `${feed.instrument.symbol} ONLINE`, message: solana ? "Chart, project intelligence, pools, and social flow are synchronized." : "Chart and flow are live. Project intel and execution are Solana-only.", tone: "success" });
  }, [feed, notify, solana]);
  useEffect(() => {
    if (!error || lastNotifiedError.current === error) return;
    lastNotifiedError.current = error;
    notify({ title: "FEED DEGRADED", message: error, tone: "warning" });
  }, [error, notify]);
  const trenchRows = array(trenches.tokens);
  const focusedTrench = solana ? trenchRows.find((item) => String(item.mintAddress) === instrument.address) || null : null;
  const mergedProvider = solana ? { ...board, ...object(feed?.provider) } : {};
  const tokenIconUrl = feed?.instrument.image ?? providerImageUrl([focusedTrench, feed?.provider]);
  const analysisProvider = { ...mergedProvider, holders, trenches };
  const clawSentiment = String(object(mergedProvider.get_indicators).sentiment || "").trim();
  const regimeLabel = clawSentiment ? clawSentiment.toUpperCase() : "—";
  const tape = useMemo(() => tapeRows(flowState?.tape), [flowState?.tape]);
  const scale = feed ? mcapScale(feed) : { mcap: null, supply: null, source: null as "mcap" | "fdv" | null };
  const hasMcap = Boolean(scale.source && scale.supply);
  const useMcap = chartUnit === "mcap" && hasMcap;
  /** One candle source per series: own tape for 5S/15S when served, else the market feed (with a visible note). */
  const active = useMemo(() => selectCandles(interval, feed, ownCandles), [interval, feed, ownCandles]);
  const rawSpotCandles = active.candles;
  const candles = useMemo(() => {
    return useMcap ? scaleCandlesToMcap(rawSpotCandles, scale.supply) : rawSpotCandles;
  }, [rawSpotCandles, scale.supply, useMcap]);
  const seriesKey = candleSeriesKey(instrument, interval, active.source);
  /** Bar size of the series actually on screen: a sub-minute chip served by the market fallback is drawing 1m bars. */
  const activeInterval = active.source === "market" && ownInterval ? SUB_MINUTE_MARKET_INTERVAL.toUpperCase() : interval;
  const intervalMs = parseIntervalMs(activeInterval);
  const livePrints = useMemo(() => livePrintsAfter(flowState?.tape, active.observedAt), [flowState?.tape, active.observedAt]);
  const liveTape = hasLiveTape(flowState);
  const intervals = visibleIntervals(liveTape || Boolean(ownInterval));
  const chartTitle = feed ? `${feed.instrument.symbol}/USD` : `LOADING ${instrument.address.slice(0, 6)}…`;
  const chartPrice = useMcap ? scale.mcap : feed?.priceUsd;
  const chartPriceCompact = useMcap;
  const chartChange = feed?.change24Pct;
  const chartUnitLabel = hasMcap ? (useMcap ? "MCAP" : "USD") : "NO MCAP";
  const chartSub = hasMcap ? (useMcap ? money(feed?.priceUsd) : money(scale.mcap, true)) : null;
  // Reference-stable across flow polls whose bars/coverage/candle span did not change, so the chart takes its in-place path.
  const chartFlowRef = useRef<StableFlow | null>(null);
  const chartFlow = useMemo(() => {
    const next = stableChartFlow(chartFlowRef.current, flowState, candles);
    chartFlowRef.current = next;
    return next?.input;
  }, [flowState, candles]);
  const launchRow = useMemo(() => launchRowFor(launchRows, instrument), [launchRows, instrument]);
  const events = useMemo(
    () => buildEventMarkers(eventMarkerInput(launchRow, flowState), chartFlow?.candleTimes ?? [], { theme }),
    [launchRow, flowState, chartFlow?.candleTimes, theme]
  );
  const eventsMeta = [events.dropped ? `+${events.dropped} large prints capped` : "", events.beforeRange ? `${events.beforeRange} events off-chart` : ""].filter(Boolean).join(" · ");
  const liveMeta = liveStats && livePrints.length ? `LIVE ${liveStats.applied} ticked · ${liveStats.volumeOnly} vol-only` : "";
  const readout = flowReadoutCells(flowState);
  const analysisFlow = useMemo(() => analysisFlowFromWindows(flowState?.windows), [flowState?.windows]);
  /** FOMO arrows ride the candle series; `dropped` is surfaced in the chart meta so a capped view never looks complete. */
  const fomo = useMemo(
    () => buildFomoMarkers(flowState?.fomo?.fills ?? [], chartFlow?.candleTimes ?? [], { theme }),
    [flowState?.fomo?.fills, chartFlow?.candleTimes, theme]
  );
  const fomoMeta = [fomo.markers.length - fomo.seeded > 0 ? `${fomo.markers.length - fomo.seeded} FOMO` : "", fomo.seeded ? `${fomo.seeded} SEEDED` : "", fomo.dropped ? `+${fomo.dropped} more` : "", fomo.beforeRange ? `${fomo.beforeRange} off-chart` : ""].filter(Boolean).join(" ");
  const sourceLabel = active.source === "own tape" ? "OWN TAPE" : feed?.primaryPair?.dex || feed?.source || "GECKO";

  const technicals = useMemo(() => {
    if (!candles.length) return null;
    const closes = candles.map((candle) => candle.close);
    const macdLines = macd(closes);
    return {
      rsi: lastValue(rsi(closes)),
      macd: lastValue(macdLines.line),
      signal: lastValue(macdLines.signal),
      atr: lastValue(atr(candles)),
      high: Math.max(...candles.map((candle) => candle.high)),
      low: Math.min(...candles.map((candle) => candle.low))
    };
  }, [candles]);

  const focusInstrument = (next: InstrumentRef, symbol?: string) => {
    if (!isValidInstrument(next)) return;
    if (!sameInstrument(next, instrument)) notify({ title: `OPENING ${symbol?.toUpperCase() || "TOKEN"}`, message: "Loading the selected contract and its live market context.", tone: "info" });
    setInstrument(next);
    setSpot((current) => (current && sameInstrument(current.instrument, next) ? current : null));
    setFlowState(null);
    setQuery(symbol ? symbol.toUpperCase() : next.address);
    setError("");
  };
  /** ClawPump lists, movers, and ticker search only ever yield Solana mints. */
  const focusSolana = (nextMint: string, symbol?: string) => focusInstrument({ chain: "solana", address: nextMint }, symbol);
  const submitQuery = async () => {
    const text = query.trim();
    if (!text) return;
    const parsed = extractAddress(text);
    if (parsed && "error" in parsed) { setError(parsed.error); return; }
    if (parsed) { focusInstrument(parsed); return; }
    const upper = text.toUpperCase();
    const trenchHit = trenchRows.find((item) => {
      const symbol = String(item.symbol || "").toUpperCase();
      const name = String(item.name || "").toUpperCase();
      const mintAddress = String(item.mintAddress || item.mint || item.contract || "");
      return symbol === upper || name === upper || mintAddress === text || mintAddress.toUpperCase() === upper;
    });
    const trenchMint = String(trenchHit?.mintAddress || trenchHit?.mint || trenchHit?.contract || "");
    if (trenchHit && MINT_RE.test(trenchMint)) { focusSolana(trenchMint, String(trenchHit.symbol || text)); return; }
    try {
      const result = await api.search(text);
      const data = object(result.data);
      const rows = array(data.tokens || data.results || data.matches).concat(array(result.data));
      const hit = rows.find((item) => {
        const symbol = String(item.symbol || "").toUpperCase();
        return symbol === upper || MINT_RE.test(String(item.address || item.mint || item.contract || ""));
      }) || rows.find((item) => MINT_RE.test(String(item.address || item.mint || item.contract || "")));
      const found = String(hit?.address || hit?.mint || hit?.contract || "");
      if (found && MINT_RE.test(found)) focusSolana(found, String(hit?.symbol || text));
      else setError(`No mint found for ${text}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const openPastedContract = (event: ClipboardEvent<HTMLInputElement>) => {
    const parsed = extractAddress(event.clipboardData.getData("text"));
    if (!parsed || "error" in parsed) return;
    event.preventDefault();
    setQuery(parsed.address);
    focusInstrument(parsed);
  };

  const mintLabel = `${instrument.address.slice(0, 4)}…${instrument.address.slice(-4)}`;
  const spotLoading = !feed;
  const scannerSearch = <div className="scanner-search">
    <AnimatePresence initial={false} mode="sync">
      {!searchOpen ? <motion.button key="scanner-closed" type="button" className="scanner-search-head" aria-label="Discover markets" aria-expanded="false" aria-controls="scanner-search-field" initial={{ opacity: 0, scaleX: 0.22 }} animate={{ opacity: 1, scaleX: 1 }} exit={{ opacity: 0, scaleX: 0.22 }} transition={{ type: "spring", stiffness: 1500, damping: 70, mass: 0.22 }} style={{ transformOrigin: "right center" }} onClick={() => setSearchOpen(true)}><span>Discover markets</span><span className="search-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
      </span></motion.button> : <motion.form key="scanner-open" id="scanner-search-field" className="command-form" initial={{ opacity: 0, scaleX: 0.2 }} animate={{ opacity: 1, scaleX: 1 }} exit={{ opacity: 0, scaleX: 0.2 }} transition={{ type: "spring", stiffness: 1500, damping: 70, mass: 0.22 }} style={{ transformOrigin: "right center" }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false); }} onSubmit={event => { event.preventDefault(); void submitQuery(); }}>
        <input autoFocus className="command-input" value={query} aria-label="Paste a Solana or Robinhood contract address" placeholder="Paste contract address" spellCheck={false} autoComplete="off" onPaste={openPastedContract} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if(event.key === "Escape") setSearchOpen(false); }} />
        <button className="search-submit" type="submit" aria-label="Open token"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg></button>
        <button className="search-close" type="button" aria-label="Close market search" onClick={() => setSearchOpen(false)}>×</button>
      </motion.form>}
    </AnimatePresence>
  </div>;

  return (
    <main className="onchain-desk">
      <div className="desk-grainient" aria-hidden="true" />
      <header className="app-header desk-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">▦</span><strong>termeow</strong><b>{brandSuffix(instrument.chain)}</b>
        </div>
        <nav className="primary-navigation" aria-label="Main navigation">{["Trade", "Portfolio"].map(item => <button key={item} aria-current={section === item ? "page" : undefined} className={section === item ? "active" : ""} onClick={() => setSection(item)}>{item}</button>)}</nav>
        <nav className="mode-switch funding-network-picker header-network-picker" aria-label="Funding network">
          <button type="button" className={network === "robinhood" ? "active" : ""} aria-pressed={network === "robinhood"} onClick={() => { setNetwork("robinhood"); notify({ title: "ROBINHOOD WALLET", message: "ETH funding is selected. Solana execution remains disabled until you switch back.", tone: "info" }); }}>ROBINHOOD</button>
          <button type="button" className={network === "solana" ? "active" : ""} aria-pressed={network === "solana"} onClick={() => { setNetwork("solana"); notify({ title: "SOLANA WALLET", message: "SOL funding and Solana spot execution are selected.", tone: "info" }); }}>SOLANA</button>
        </nav>
        <ThemeToggle theme={theme} onChange={setTheme} />
        <SfxToggle />
        <AuthControls />
      </header>
      {legacy && <MarketStrips market={legacy} onPick={focusSolana} />}
      {section !== "Trade" && <AccountScreen section="Portfolio" onBack={() => setSection("Trade")} />}
      <div className="desk-grid" style={section !== "Trade" ? {display:"none"} : undefined}>
        <WatchPanel
          search={scannerSearch}
          market={{ provider: mergedProvider } as OnchainMarket}
          selected={instrument.address}
          onSpot={focusSolana}
          onInstrument={focusInstrument}
          trenches={trenchRows}
          onTrenchSort={setTrenchSort}
        />
        <section className={`panel chart-panel${chartExpanded ? " chart-expanded" : ""}`}>
          <div className="ph chart-head">
            <div className="chart-head-left">
              <span className="pt">{chartTitle}</span>
              <span className="unit-toggle" role="group" aria-label="Chart unit">
                  <button type="button" className={!useMcap ? "on" : ""} onClick={() => selectChartUnit("price")}>PRICE</button>
                  <button type="button" className={useMcap ? "on" : ""} disabled={!hasMcap} onClick={() => selectChartUnit("mcap")}>MCAP</button>
              </span>
              <span className="unit-toggle" role="group" aria-label="Price scale">
                  <button type="button" className={scaleMode === "linear" ? "on" : ""} onClick={() => selectScale("linear")}>LIN</button>
                  <button type="button" className={scaleMode === "log" ? "on" : ""} onClick={() => selectScale("log")}>LOG</button>
              </span>
              <span className="intervals">{intervals.map((item) => <button key={item} className={interval === item ? "on" : ""} title={ownTapeInterval(item) ? "Own-tape candles (priced ring prints, minutes of history)" : undefined} onClick={() => setIntervalValue(item)}>{item}</button>)}</span>
              <button type="button" className="analyze-trigger" title="Synthesize token data into executable trade setups" disabled={!solana || !feed || !feed.candles.length} onClick={() => { setAnalysisOpen(true); notify({ title: `ANALYZING ${feed?.instrument.symbol || "TOKEN"}`, message: "Synthesizing momentum, Tier A net flow, liquidity, whale flow, and project intelligence.", tone: "success" }); }}>✦ ANALYZE</button>
            </div>
            <div className="chart-head-right">
              <span className="chart-hero">
                <b className={`chart-price${useMcap ? " mcap-value" : ""}`}>{money(chartPrice, chartPriceCompact)}</b>
                <i className={(chartChange || 0) < 0 ? "dn" : "up"}>{pct(chartChange)}</i>
                {chartUnitLabel && <em className={chartUnitLabel === "NO MCAP" ? "chart-unit warn" : "chart-unit"}>{chartUnitLabel}</em>}
                {chartSub && <small className={`chart-sub${!useMcap ? " mcap-value" : ""}`}>{chartSub}</small>}
              </span>
              <span className="chart-meta">{candles.length} BARS · {sourceLabel} · {activeInterval}{active.label ? ` · ${active.label}` : ""}{liveMeta ? ` · ${liveMeta}` : ""}{eventsMeta ? ` · ${eventsMeta}` : ""}{fomoMeta ? ` · ${fomoMeta}` : ""}</span>
              {active.note && <span className="chart-meta chart-note" role="status">{active.note}</span>}
            </div>
          </div>
          <IndicatorBar value={indicators} onChange={setIndicators} />
          <div className="chart-tools" role="toolbar" aria-label="Chart navigation tools">
            <span className="chart-tool-status" title="Drag to pan. Scroll or pinch to zoom.">PAN · CROSSHAIR</span>
            <DrawingToolbar tool={drawings?.tool ?? null} count={drawings?.count ?? 0} onTool={(tool) => drawingsApi?.setTool(tool)} onClear={() => drawingsApi?.clear()} />
            <button type="button" title="Zoom in" aria-label="Zoom chart in" onClick={() => chartRef.current?.zoomIn()}>＋</button>
            <button type="button" title="Zoom out" aria-label="Zoom chart out" onClick={() => chartRef.current?.zoomOut()}>−</button>
            <button type="button" title="Restore the close candle view" onClick={() => chartRef.current?.resetView()}>RESET</button>
            <button type="button" title="Jump to the latest candle" onClick={() => chartRef.current?.goToRealtime()}>LIVE</button>
            <button type="button" title={chartExpanded ? "Exit expanded chart" : "Expand chart"} aria-pressed={chartExpanded} onClick={() => setChartExpanded((expanded) => !expanded)}>{chartExpanded ? "CLOSE" : "EXPAND"}</button>
          </div>
          {spotLoading ? (
            <div className="integration-empty chart-loading"><span className="notification-pixel chart-loader" aria-hidden="true"><i /><i /><i /><i /></span><h2>LOADING {mintLabel}</h2><p>{error || "Fetching chart, intel, holders, and social for this contract."}</p></div>
          ) : candles.length ? <MarketChart
            ref={chartRef}
            candles={candles}
            indicators={indicators}
            seriesKey={seriesKey}
            intervalMs={intervalMs}
            livePrints={livePrints}
            mcapScale={useMcap ? scale.supply : null}
            onLiveStats={setLiveStats}
            scaleMode={scaleMode}
            eventMarkers={events.markers}
            flow={chartFlow}
            fomoMarkers={fomo.markers}
            compactAxis={useMcap}
            theme={theme}
            legendLabel={chartTitle}
            drawingsKey={instrumentKey(instrument)}
            onDrawings={setDrawingsApi}
          /> : <div className="integration-empty"><h2>NO CANDLES YET</h2><p>{error || "No OHLCV on Gecko for this token's pools."}</p></div>}
          <div className="chart-readout">
            <span>RSI14 <b>{technicals?.rsi?.toFixed(2) || "—"}</b></span>
            <span>MACD <b>{technicals?.macd?.toPrecision(4) || "—"}</b></span>
            <span>SIGNAL <b>{technicals?.signal?.toPrecision(4) || "—"}</b></span>
            <span>ATR14 <b>{money(technicals?.atr, chartPriceCompact)}</b></span>
            <span>SUP <b>{money(technicals?.low, chartPriceCompact)}</b></span>
            <span>RES <b>{money(technicals?.high, chartPriceCompact)}</b></span>
            {readout.map((cell) => <span key={cell.key} title="Tier A pairs · ledger">{cell.label} <b className={cell.tone}>{cell.value}</b></span>)}
            <span>REGIME <b className={biasTone(regimeLabel)}>{regimeLabel}</b></span>
          </div>
        </section>
        <aside className="execution-rail">
          <ExecutionRail instrument={instrument} feed={feed} legacy={legacy} iconUrl={tokenIconUrl} config={config} />
        </aside>
        <FeatureSection id="social" className="radar-panel" meta={<span className="social-live"><i /> LIVE</span>}>
        {legacy && solana ? <SocialPanel
          market={{ ...legacy, provider: mergedProvider }}
          trench={focusedTrench}
          onPick={focusSolana}
        /> : solana ? (
          <section className="panel radar-panel social-panel">
            <p className="empty-copy">Fetching KOL, narrative, and social links for this mint.</p>
          </section>
        ) : <FomoTapePanel onInstrument={focusInstrument} />}
        </FeatureSection>
        {legacy ? <BothSidesPanel
          market={legacy}
          tape={tape}
          coverage={flowState?.coverage}
          tokenFlow={flowState}
        /> : (
          <section className="panel sides-panel flow-panel research-panel">
            <div className="ph"><span className="pt">LIQUIDITY &amp; ORDER FLOW</span><span className="pm">LOADING {mintLabel}</span></div>
            <p className="empty-copy">Fetching pool and tape intelligence for this contract.</p>
          </section>
        )}
      </div>
      {legacy && solana && <AgenticAnalysisPanel open={analysisOpen} market={legacy} candles={legacy.candles} flow={analysisFlow} provider={analysisProvider} config={config} onClose={() => setAnalysisOpen(false)} />}
    </main>
  );
}
