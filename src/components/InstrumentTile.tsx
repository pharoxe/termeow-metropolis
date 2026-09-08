import { useParticipants } from "../hooks/useParticipants";
import { createPortal } from 'react-dom';
import type {CrosshairBus} from '../lib/crosshairBus';
import { useResource } from '../lib/resource';
import type { ChartTileState } from '../lib/workspace';
import { ThesisActivity } from './ThesisActivity';
import { useAggregateFlow } from "../hooks/useAggregateFlow";
import { TerminalCommand } from "../components/TerminalCommand";
import { TraderInspector, TraderToolbar, TradeTape } from "../components/TraderContext";
import { useTerminal } from "../hooks/useTerminal";
import { DEFAULT_TRADE_FILTER, filterTradesWithBreakdown, tradeMarkers, type TradeFilter } from "../lib/terminal";
import type { TradeEvent } from "../../shared/terminal";
import "../components/terminal.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../api/client";
import type { OnchainMarket, PublicConfig } from "../types";
import type { SystemHealth } from "../../shared/wire";
import { MarketChart, type ChartScaleMode, type IndicatorSet, type MarketChartHandle } from "../components/MarketChart";
import { IndicatorBar } from "../components/IndicatorBar";
import { ExecutionRail } from "../components/ExecutionRail";
import { AuthControls } from "../auth/AuthControls";
import { money, pct } from "../lib/format";
import { atr, macd, rsi } from "../lib/indicators";
import { MINT_RE } from "../lib/mint";
import { extractAddress, type InstrumentRef } from "../lib/address";
import { brandSuffix, instrumentKey, isValidInstrument, legacyMarket, sameInstrument, tapeRows } from "../lib/instrument";
import { mcapScale, scaleCandlesToMcap } from "../lib/mcap";
import type { FlowCandlesResponse, LaunchRow, MarketResponse, TokenFlowResponse } from "../../shared/wire";
import { buildEventMarkers } from "../lib/chartMarkers";
import { parseIntervalMs } from "../lib/chartTime";
import type { LiveCandleStats } from "../lib/liveCandle";
import { analysisFlowFromWindows } from "../lib/agenticAnalysis";
import {
  LAUNCH_POLL_MS, OWN_TAPE_POLL_MS, aggregateReadoutCells, biasTone, candleSeriesKey, candleSourceMeta, coverageHeadline, coverageNotes, eventMarkerInput, hasLiveTape, launchRowFor,
  livePrintsAfter, marketIntervalFor, nextFlowState, noCandlesReason, ownTapeInterval, selectCandles, stableChartFlow, systemStatusLine, visibleIntervals, SUB_MINUTE_MARKET_INTERVAL, type StableFlow
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
  ema: false, bollinger: false, vwap: false, sr: false, volume: true, cvd: true, rsi: false, macd: false, obv: false
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
const readChartUnit = () => readStored<ChartUnit>(CHART_UNIT_KEY, ["price", "mcap"], "price");
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

export type TileProps={config:PublicConfig;tile:ChartTileState;isActive:boolean;slots:{header:HTMLElement;discovery:HTMLElement;context:HTMLElement;rail:HTMLElement};onInstrument:(id:string,instrument:InstrumentRef)=>void;onInterval:(id:string,interval:string)=>void;onNew:(instrument:InstrumentRef)=>void;onSection:(section:string)=>void;onReplay:(id:string,time:number|null)=>void;linkedReplay?:{source:string;time:number|null;revision:number};crosshairBus:CrosshairBus;theme:"dark"|"light";setTheme:(value:"dark"|"light")=>void;onCrosshair:(id:string,time:number|null)=>void};
export function InstrumentTile({ config,tile,isActive,slots,onInstrument,onInterval,onNew,onSection,onReplay,linkedReplay,crosshairBus,onCrosshair,theme,setTheme }: TileProps) {

  const { network, setNetwork } = useFundingNetwork();
  const { notify } = useNotifications();
  const [section, setSectionLocal] = useState("Trade");
  useEffect(()=>{if(isActive)onSection(section);},[isActive,section,onSection]);
  const setSection=(value:string)=>{setSectionLocal(value);onSection(value);};

  const instrument=tile.instrument;
  const setInstrument=(next:InstrumentRef)=>onInstrument(tile.id,next);
  const solana = instrument.chain === "solana";
  const [query, setQuery] = useState("");
  const interval=tile.interval;
  const setIntervalValue=(next:string)=>onInterval(tile.id,next);
  const [chartExpanded, setChartExpanded] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const chartRef = useRef<MarketChartHandle>(null);
  const lastNotifiedInstrument = useRef("");
  const lastNotifiedError = useRef("");
  const [indicators, setIndicators] = useState(()=>{try{return {...initialIndicators,...JSON.parse(localStorage.getItem(`tile-indicators:${tile.id}`)??'{}')};}catch{return initialIndicators;}});
  useEffect(()=>{try{localStorage.setItem(`tile-indicators:${tile.id}`,JSON.stringify(indicators));}catch{}},[indicators,tile.id]);
  const [board, setBoard] = useState<Row>({});
  const [spot, setSpot] = useState<MarketResponse | null>(null);
  const [error, setError] = useState("");
  const [trenchSort, setTrenchSort] = useState<"hot" | "new" | "mcap" | "volume">("hot");
  const [trenches, setTrenches] = useState<Row>({});
  const [holders, setHolders] = useState<Row>({});
  const [flowState, setFlowState] = useState<TokenFlowResponse | null>(null);
  /** Own-tape candles for the 5S/15S chips; null until the route answered (or while a minute+ interval is selected). */
  const capturedLoader = useRef<(()=>void)|null>(null);
  const [ownCandles, setOwnCandles] = useState<FlowCandlesResponse | null>(null);
  const [launchRows, setLaunchRows] = useState<LaunchRow[]>([]);
  const [liveStats, setLiveStats] = useState<LiveCandleStats | null>(null);
  /** GET /api/health for the toolbar status line (RPC endpoint pool + snapshot age); null until answered. */
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [drawingsApi, setDrawingsApi] = useState<DrawingsApi | null>(null);
  const [drawings, setDrawings] = useState<DrawingsSnapshot | null>(null);
  const [chartUnit, setChartUnit] = useState<ChartUnit>(()=>readStored(`tile-unit:${tile.id}`,["price","mcap"],"price"));
  const [scaleMode, setScaleMode] = useState<ChartScaleMode>(()=>readStored(`tile-scale:${tile.id}`,["linear","log"],"linear"));
  const selectChartUnit = (unit: ChartUnit) => {
    setChartUnit(unit);
    persistStored(`tile-unit:${tile.id}`,unit);
  };
  const selectScale = (mode: ChartScaleMode) => {
    setScaleMode(mode);
    persistStored(`tile-scale:${tile.id}`,mode);
  };
  const ownInterval = ownTapeInterval(interval);
  const [visibleRange, setVisibleRange] = useState<{from:number;to:number}|null>(null);
  const [tradeFilter, setTradeFilter] = useState<TradeFilter>(DEFAULT_TRADE_FILTER);
  const [followed, setFollowed] = useState<string[]>(() => {try {const value=JSON.parse(localStorage.getItem("terminal-followed")??"[]");return Array.isArray(value)?value.filter((v:unknown)=>typeof v==="string"):[];}catch{return [];}});
  const [selectedTrade, setSelectedTrade] = useState<TradeEvent|null>(null);
  const [commandsOpen,setCommandsOpen]=useState(false);
  useEffect(()=>{if(!isActive)return;const handler=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k"){event.preventDefault();setCommandsOpen(open=>!open);}};window.addEventListener("keydown",handler);return()=>window.removeEventListener("keydown",handler);},[isActive]);
  const [railTab, setRailTab] = useState<"trader"|"order">("trader");
  const [replayTime, setLocalReplay] = useState<number|null>(null);
  const replayRef=useRef(replayTime);replayRef.current=replayTime;
  const setReplayTime=(value:number|null|((previous:number|null)=>number|null))=>{const next=typeof value==='function'?value(replayRef.current):value;setLocalReplay(next);onReplay(tile.id,next);};
  useEffect(()=>{if(linkedReplay&&linkedReplay.source!==tile.id)setLocalReplay(linkedReplay.time);},[linkedReplay?.revision]);
  useEffect(()=>crosshairBus.subscribe(tile.id,time=>chartRef.current?.setCrosshair(time)),[crosshairBus,tile.id]);
  const terminal = useTerminal(instrument, visibleRange,isActive);
  const onVisibleRange = useCallback((range:{from:number;to:number}) => setVisibleRange(previous => previous?.from===range.from&&previous?.to===range.to?previous:range),[]);
  const followWallet = (key:string) => setFollowed(previous => {const next=previous.includes(key)?previous.filter(k=>k!==key):[...previous,key];try{localStorage.setItem("terminal-followed",JSON.stringify(next));queueMicrotask(()=>window.dispatchEvent(new Event("termeow-followed")));}catch{}return next;});
  useEffect(()=>{const sync=()=>{try{const value=JSON.parse(localStorage.getItem("terminal-followed")??"[]");if(Array.isArray(value))setFollowed(value.filter(v=>typeof v==="string"));}catch{}};window.addEventListener("termeow-followed",sync);return()=>window.removeEventListener("termeow-followed",sync);},[]);
  const selectTrade = (trade:TradeEvent) => {setSelectedTrade(trade);setRailTab("trader");chartRef.current?.seekTime(trade.time);};
  useEffect(()=>{setSelectedTrade(null);setVisibleRange(null);setLocalReplay(null);},[instrument.chain,instrument.address]);
  useEffect(()=>{setVisibleRange(null);},[interval]);
  useEffect(()=>{if(!isActive){setCommandsOpen(false);setAnalysisOpen(false);}},[isActive]);


  const marketQuery=useResource(`market:${instrumentKey(instrument)}:${marketIntervalFor(interval)}`,()=>api.market(instrument.chain,instrument.address,marketIntervalFor(interval)),45000);
  const flowQuery=useResource(`flow:${instrumentKey(instrument)}:${marketIntervalFor(interval)}`,()=>api.flowToken(instrument.chain,instrument.address,marketIntervalFor(interval)),15000);
  const boardQuery=useResource(isActive&&solana?'board':null,()=>api.board(),30000);
  const trenchesQuery=useResource(isActive&&solana?`trenches:${trenchSort}`:null,()=>api.trenches(trenchSort),30000);
  const holderQuery=useResource(isActive&&solana?`holders:${instrumentKey(instrument)}`:null,()=>api.holders(instrument.address),45000);
  const healthQuery=useResource('health',()=>api.health(),30000);
  const launchesQuery=useResource(`launches:${instrument.chain}`,()=>api.launches({chain:instrument.chain,window:'24h',stocks:true}),LAUNCH_POLL_MS);
  const capturedQuery=useResource(ownInterval?`captured:${instrumentKey(instrument)}:${ownInterval}`:null,()=>api.capturedCandles(instrument.chain,instrument.address,ownInterval!),OWN_TAPE_POLL_MS);
  useEffect(()=>{setSpot(marketQuery.data);setError(marketQuery.error||marketQuery.data?.error||'');},[marketQuery.data,marketQuery.error]);
  useEffect(()=>{setFlowState(flowQuery.data);},[flowQuery.data]);
  useEffect(()=>{setBoard(object(boardQuery.data));},[boardQuery.data]);
  useEffect(()=>{setTrenches(object(trenchesQuery.data));},[trenchesQuery.data]);
  useEffect(()=>{setHolders(object(holderQuery.data));},[holderQuery.data]);
  useEffect(()=>{setHealth(healthQuery.data);},[healthQuery.data]);
  useEffect(()=>{setLaunchRows(launchesQuery.data?.launches??[]);},[launchesQuery.data]);
  useEffect(()=>{setOwnCandles(capturedQuery.data);},[capturedQuery.data]);

  const feed = spot && sameInstrument(spot.instrument, instrument) ? spot : null;
  const legacy = useMemo(() => (feed ? legacyMarket(feed) : null), [feed]);
  useEffect(() => {
    if (!drawingsApi) {
      setDrawings(null);
      return;
    }
    return drawingsApi.subscribe(setDrawings);
  }, [drawingsApi]);

  useEffect(() => {
    if (!isActive || !feed || lastNotifiedInstrument.current === instrumentKey(feed.instrument)) return;
    lastNotifiedInstrument.current = instrumentKey(feed.instrument);
    notify({ title: `${feed.instrument.symbol} LOADED`, message: "Market response received. Check the source status for live trade coverage and provider availability.", tone: "success" });
  }, [feed, notify, solana, isActive]);
  useEffect(() => {
    if (!isActive || !error || lastNotifiedError.current === error) return;
    lastNotifiedError.current = error;
    notify({ title: "FEED DEGRADED", message: error, tone: "warning" });
  }, [error, notify, isActive]);
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
  const rawSpotCandles = useMemo(() => replayTime == null ? active.candles : active.candles.filter(c => c.time + (parseIntervalMs(active.source === "market" && ownInterval ? SUB_MINUTE_MARKET_INTERVAL : interval) || 60000) <= replayTime), [active.candles, active.source, ownInterval, interval, replayTime]);
  const candles = useMemo(() => {
    return useMcap ? scaleCandlesToMcap(rawSpotCandles, scale.supply) : rawSpotCandles;
  }, [rawSpotCandles, scale.supply, useMcap]);
  const seriesKey = candleSeriesKey(instrument, interval, active.source);
  /** Bar size of the series actually on screen: a sub-minute chip served by the market fallback is drawing 1m bars. */
  const activeInterval = active.source === "market" && ownInterval ? SUB_MINUTE_MARKET_INTERVAL.toUpperCase() : interval;
  const intervalMs = parseIntervalMs(activeInterval);
  // External candle inclusion is unknown. Never blend cross-venue tape into provider OHLCV.
  // Captured candles are rebuilt server-side from durable observations, including late events.
  const livePrints = useMemo(() => [], []);
  const participants=useParticipants(instrument.chain,terminal.events,selectedTrade,isActive);
  const visible = useMemo(() => filterTradesWithBreakdown(terminal.events.filter(e => replayTime==null||e.time<=replayTime), tradeFilter, followed, participants.snapshots, terminal.now), [terminal.events,tradeFilter,followed,replayTime,participants.snapshots,terminal.now]);
  const visibleTrades = visible.trades;
  const aggregate = useAggregateFlow(instrument, rawSpotCandles[0]?.time, replayTime ?? (rawSpotCandles.at(-1)?.time != null ? rawSpotCandles.at(-1)!.time+(intervalMs||60000)-1 : undefined), intervalMs||60000);
  // `coverage` carries the first captured print of the very population these bars are summed from: bars before it are
  // muted and the last uncovered candle gets the "no tape ◀" marker, so a half-covered range never reads as a full one.
  const aggregateChart = useMemo(()=>aggregate.data?{bars:aggregate.data.bars,pairs:[],coverage:{firstPrintAt:aggregate.data.firstPrintAt},candleTimes:rawSpotCandles.map(c=>c.time)}:undefined,[aggregate.data,rawSpotCandles]);
  const participantMarkers = useMemo(() => tradeMarkers(visibleTrades, rawSpotCandles, intervalMs || 60000, selectedTrade?.id??null, followed, visibleRange), [visibleTrades,rawSpotCandles,intervalMs,selectedTrade?.id,followed,visibleRange]);
  const pickCandle = (time:number) => {const candidates=visibleTrades.filter(e=>e.time>=time&&e.time<time+(intervalMs||60000));if(candidates.length){setSelectedTrade(candidates[0]);setRailTab("trader");}};

  const liveTape = hasLiveTape(flowState) || terminal.recent.length > 0;
  const intervals = visibleIntervals(liveTape || Boolean(ownInterval));
  const chartTitle = feed ? `${feed.instrument.symbol}/USD` : `LOADING ${instrument.address.slice(0, 6)}…`;
  const chartPrice = replayTime != null ? candles.at(-1)?.close : useMcap ? scale.mcap : feed?.priceUsd;
  const chartPriceCompact = useMcap;
  const chartChange = replayTime != null ? undefined : feed?.change24Pct;
  const chartUnitLabel = hasMcap ? (useMcap ? "EST. MCAP" : "USD") : "NO MCAP";
  const chartSub = replayTime == null && hasMcap ? (useMcap ? money(feed?.priceUsd) : money(scale.mcap, true)) : null;
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
  const chartMarkers = useMemo(()=>[...events.markers.filter(m=>m.shape==="square"),...participantMarkers.markers],[events.markers,participantMarkers.markers]);
  const eventsMeta = [events.dropped ? `+${events.dropped} large prints capped` : "", events.beforeRange ? `${events.beforeRange} events off-chart` : ""].filter(Boolean).join(" · ");
  const liveMeta = liveStats && livePrints.length ? `LIVE ${liveStats.applied} ticked · ${liveStats.volumeOnly} vol-only` : "";
  const analysisFlow = useMemo(() => analysisFlowFromWindows(flowState?.windows), [flowState?.windows]);
  const sourceLabel = active.source === "own tape" ? "OWN TAPE" : feed?.primaryPair?.dex || feed?.source || "GECKO";
  /** R6 provenance: which series the market candles are and how far the chain backfill reaches. */
  const provenanceMeta = candleSourceMeta(feed, active.source);
  const statusLine = systemStatusLine(health, Date.now());
  /** What the aggregate sums cover, said in the readout itself rather than only inside the coverage disclosure. */
  const aggregateWindow = `the ${candles.length} loaded ${activeInterval} bars`;
  const aggregateState = useMemo(() => ({ error: aggregate.error, data: aggregate.data ? { capturedPools: aggregate.data.capturedPools, knownPools: aggregate.data.knownPools, buyUsd: aggregate.data.buyUsd, sellUsd: aggregate.data.sellUsd, delta: aggregate.data.delta, trades: aggregate.data.trades, unpriced: aggregate.data.unpriced } : null }), [aggregate.error, aggregate.data]);
  const aggregateCells = aggregateReadoutCells(aggregateState, aggregateWindow);
  /** The five caveat lines that used to stack above the canvas, folded into one disclosure; the headline counts the partial ones. */
  const seriesMeta = [provenanceMeta, active.label, liveMeta, eventsMeta].filter(Boolean).join(" · ");
  const coverage = useMemo(() => coverageNotes({
    series: { bars: candles.length, source: sourceLabel, interval: activeInterval, meta: seriesMeta, note: active.note ?? null },
    aggregate: aggregateState,
    launch: launchRow ? { launchpad: launchRow.launchpad, createdAt: launchRow.createdAt } : null,
    replay: replayTime != null,
    baselines: { checked: participants.snapshots.filter(s => s.checkedAt != null).length, total: participants.snapshots.length, refreshMs: participants.refreshMs, error: participants.error }
  }), [candles.length, sourceLabel, activeInterval, seriesMeta, active.note, aggregateState, launchRow, replayTime, participants.snapshots, participants.refreshMs, participants.error]);

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

  const mintLabel = `${instrument.address.slice(0, 4)}…${instrument.address.slice(-4)}`;
  const spotLoading = !feed;
  const scannerSearch = <form className="persistent-ca-search" role="search" onSubmit={event=>{event.preventDefault();void submitQuery();}}>
    <label htmlFor="market-ca">CONTRACT / TOKEN</label>
    <input id="market-ca" className="command-input" value={query} aria-label="Paste a Solana or Robinhood contract address" placeholder="Paste contract address · Enter to open" spellCheck={false} autoComplete="off" onChange={event=>setQuery(event.target.value)}/>
    <button type="submit">OPEN ↵</button>
    <button type="button" onClick={()=>{const parsed=extractAddress(query);if(parsed&&!("error" in parsed))onNew(parsed);else setError("Paste a valid contract address to open a new chart");}}>NEW CHART ＋</button>
  </form>;

  return (
    <div className="instrument-tile">
      {isActive && createPortal(<>
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
      {scannerSearch}
      {legacy && <MarketStrips market={legacy} onPick={focusSolana} />}
      {section !== "Trade" && <AccountScreen section="Portfolio" onBack={() => setSection("Trade")} />}
      </>,slots.header)}
      {isActive && createPortal(<>
        <WatchPanel

          market={{ provider: mergedProvider } as OnchainMarket}
          selected={instrument.address}
          activeInstrument={instrument}
          onSpot={focusSolana}
          onInstrument={focusInstrument}
          onNewChart={onNew}
          trenches={trenchRows}
          onTrenchSort={setTrenchSort}
        />
      </>,slots.discovery)}
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
            </div>
            <div className="chart-head-right">
              <span className="chart-hero">
                <b className={`chart-price${useMcap ? " mcap-value" : ""}`}>{money(chartPrice, chartPriceCompact)}</b>
                <i className={(chartChange || 0) < 0 ? "dn" : "up"}>{pct(chartChange)}</i>
                {chartUnitLabel && <em className={chartUnitLabel === "NO MCAP" ? "chart-unit warn" : "chart-unit"}>{chartUnitLabel}</em>}
                {chartSub && <small className={`chart-sub${!useMcap ? " mcap-value" : ""}`}>{chartSub}</small>}
              </span>
              <button type="button" className="analyze-trigger" title="Synthesize token data into executable trade setups" disabled={!solana || !feed || !feed.candles.length} onClick={() => { setAnalysisOpen(true); notify({ title: `ANALYZING ${feed?.instrument.symbol || "TOKEN"}`, message: "Synthesizing momentum, Tier A net flow, liquidity, whale flow, and project intelligence.", tone: "success" }); }}>✦ ANALYZE</button>
            </div>
          </div>
          <details className="chart-coverage">
            <summary title={coverage.map(note => `${note.label}${note.partial ? " (partial or unknown)" : ""}: ${note.detail}`).join("\n")}>COVERAGE <small role="status" className={coverage.some(note => note.partial) ? "is-partial" : undefined}>{coverageHeadline(coverage)}</small></summary>
            <dl className="coverage-notes">
              {coverage.map(note => <div key={note.key} className={note.partial ? "is-partial" : undefined}>
                <dt>{note.label}{note.partial ? <i title="Partial or unknown coverage" aria-label="partial or unknown coverage"> ●</i> : null}</dt>
                <dd>{note.detail}{note.key === "event" && launchRow ? <button type="button" onClick={()=>chartRef.current?.seekTime(launchRow.createdAt)}>SEEK {new Date(launchRow.createdAt).toLocaleDateString("en-GB")}</button> : null}</dd>
              </div>)}
            </dl>
          </details>
          <ThesisActivity instrument={instrument} compact />
          <IndicatorBar value={indicators} onChange={setIndicators} />
          <div className="chart-tools" role="group" aria-label="Chart navigation tools">
            <span className="chart-tool-status" id="chart-navigation-help" title="Drag to pan · scroll/pinch to zoom · drag either axis to scale · double-click an axis to reset · focus chart for +/− and arrow keys">DRAG · SCROLL TO ZOOM</span>
            {statusLine ? <span className="chart-tool-status system-status" title={statusLine.title}>{statusLine.text}</span> : null}
            <button type="button" title="Zoom in" aria-label="Zoom chart in" onClick={() => chartRef.current?.zoomIn()}>＋</button>
            <button type="button" title="Zoom out" aria-label="Zoom chart out" onClick={() => chartRef.current?.zoomOut()}>−</button>
            <button type="button" title="Jump to the latest candle" onClick={() => chartRef.current?.goToRealtime()}>LIVE</button>
            <button type="button" title={chartExpanded ? "Exit expanded chart" : "Expand chart"} aria-pressed={chartExpanded} onClick={() => setChartExpanded((expanded) => !expanded)}>{chartExpanded ? "CLOSE" : "EXPAND"}</button>
            <details className="tool-overflow">
              <summary title="Drawing tools, candle height, and view controls">TOOLS ▾</summary>
              <div className="tool-overflow-menu">
                <DrawingToolbar tool={drawings?.tool ?? null} count={drawings?.count ?? 0} onTool={(tool) => drawingsApi?.setTool(tool)} onClear={() => drawingsApi?.clear()} />
                <button type="button" aria-label="Increase candle height" title="Make candles taller (Shift + scroll also scales price)" onClick={() => chartRef.current?.tallerCandles()}>HEIGHT ＋</button>
                <button type="button" aria-label="Decrease candle height" title="Make candles shorter" onClick={() => chartRef.current?.shorterCandles()}>HEIGHT −</button>
                <button type="button" title="Unlock vertical movement; drag the chart to pan price and time. Reset restores automatic scaling." onClick={() => chartRef.current?.freeMove()}>FREE MOVE</button>
                <button type="button" title="Fit all loaded price history" onClick={() => chartRef.current?.fitHistory()}>FIT ALL</button>
                <button type="button" title="Restore automatic price scaling and the latest candles" onClick={() => chartRef.current?.resetView()}>RESET</button>
                <button type="button" onClick={()=>setCommandsOpen(true)} title="Command palette (Ctrl/Cmd K)">⌘ K</button>
              </div>
            </details>
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
            eventMarkers={chartMarkers}
            flow={aggregateChart}
            onSelectTime={pickCandle}
            onCrosshairTime={time=>onCrosshair(tile.id,time)}
            onVisibleRange={onVisibleRange}
            compactAxis={useMcap}
            theme={theme}
            legendLabel={chartTitle}
            drawingsKey={`${tile.id}:${instrumentKey(instrument)}`}
            onDrawings={setDrawingsApi}
          /> : <div className="integration-empty"><h2>NO CANDLES YET</h2><p>{noCandlesReason(feed, error)}</p></div>}
          <div className="chart-readout">
            <span>RSI14 <b>{technicals?.rsi?.toFixed(2) || "—"}</b></span>
            <span>MACD <b>{technicals?.macd?.toPrecision(4) || "—"}</b></span>
            <span>SIGNAL <b>{technicals?.signal?.toPrecision(4) || "—"}</b></span>
            <span>ATR14 <b>{money(technicals?.atr, chartPriceCompact)}</b></span>
            <span>SUP <b>{money(technicals?.low, chartPriceCompact)}</b></span>
            <span>RES <b>{money(technicals?.high, chartPriceCompact)}</b></span>
            {aggregateCells.map(cell => <span key={cell.key} title={cell.title}>{cell.label} <b className={cell.tone}>{cell.value}</b></span>)}
            <span>REGIME <b className={biasTone(regimeLabel)}>{regimeLabel}</b></span>
          </div>
        </section>
        {isActive && createPortal(<>
        <aside className="execution-rail terminal-rail">
          <div className="rail-tabs"><button className={railTab==="trader"?"active":""} onClick={()=>setRailTab("trader")}>TRADER CONTEXT</button><button className={railTab==="order"?"active":""} onClick={()=>setRailTab("order")}>ORDER &amp; PROJECT</button></div>
          {railTab==="trader"?<TraderInspector baseline={participants.snapshots.find(s=>s.chain===selectedTrade?.chain&&s.wallet===selectedTrade?.wallet)} event={selectedTrade} events={terminal.events.filter(e=>replayTime==null||e.time<=replayTime)} candles={rawSpotCandles} intervalMs={intervalMs||60000} followed={followed} onFollow={followWallet} onSelect={selectTrade} onClose={()=>setSelectedTrade(null)}/>:<ExecutionRail instrument={instrument} feed={feed} legacy={legacy} iconUrl={tokenIconUrl} config={config} />}
        </aside>
        </>,slots.rail)}
        {isActive && createPortal(<>
        <div className="terminal-tape-slot">
          <TraderToolbar filter={tradeFilter} onFilter={setTradeFilter} status={replayTime?"REPLAY":terminal.status} connected={terminal.connected} matched={terminal.matched} loaded={visibleTrades.length} unplaced={participantMarkers.unplaced} following={followed.length} onClear={()=>setTradeFilter(DEFAULT_TRADE_FILTER)} paused={replayTime!=null} onPause={()=>setReplayTime(time=>time==null?Date.now():null)} breakdown={visible.breakdown} />
          <TradeTape events={visibleTrades} selected={selectedTrade?.id??null} onSelect={selectTrade} loading={terminal.loading} hasMore={Boolean(terminal.nextCursor)} onMore={terminal.loadMore} paused={replayTime!=null} replayTime={replayTime} onReplay={setReplayTime} error={terminal.error}/>
        </div>
        <ThesisActivity instrument={instrument} />
        <FeatureSection id="social" className="radar-panel" meta={<span className="social-live"><i /> LIVE</span>}>
        {legacy && solana ? <SocialPanel
          market={{ ...legacy, provider: mergedProvider }}
          trench={focusedTrench}
          onPick={focusSolana}
        /> : solana ? (
          <section className="panel radar-panel social-panel">
            <p className="empty-copy">Fetching KOL, narrative, and social links for this mint.</p>
          </section>
        ) : <FomoTapePanel onInstrument={focusInstrument} onNewChart={onNew} />}
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
      </>,slots.context)}
      <TerminalCommand open={commandsOpen} onClose={()=>setCommandsOpen(false)} events={terminal.events} onSelect={selectTrade} onAction={action=>{if(action==="live"){setReplayTime(null);chartRef.current?.goToRealtime();}if(action==="fit")chartRef.current?.fitHistory();if(action==="reset")chartRef.current?.resetView();if(action==="expand")setChartExpanded(v=>!v);if(action==="replay")setReplayTime(t=>t==null?Date.now():null);}} />
      {legacy && solana && <AgenticAnalysisPanel open={analysisOpen} market={legacy} candles={legacy.candles} flow={analysisFlow} provider={analysisProvider} config={config} onClose={() => setAnalysisOpen(false)} />}
    </div>
  );
}
