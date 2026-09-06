import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../api/client";
import type { Candle, OnchainMarket, PublicConfig } from "../types";
import { MarketChart, type IndicatorSet, type MarketChartHandle } from "../components/MarketChart";
import { IndicatorBar } from "../components/IndicatorBar";
import { SpotTradeTicket } from "../components/SpotTradeTicket";
import { PerpTradeTicket } from "../components/PerpTradeTicket";
import { AuthControls } from "../auth/AuthControls";
import { money, pct, signedMoney } from "../lib/format";
import { atr, macd, rsi } from "../lib/indicators";
import { extractSolanaMint, MINT_RE } from "../lib/mint";
import { mcapScale, scaleCandlesToMcap } from "../lib/mcap";
import { AuditChips, BothSidesPanel, MarketStrips, ResearchPanel, SocialPanel, WatchPanel } from "../components/DeskPanels";
import { ThemeToggle, useTheme } from "../components/ThemeToggle";
import { FeatureSection } from "../features/WorkspaceFeatures";
import SpecularButton from "../components/effects/SpecularButton";
import Grainient from "../components/effects/Grainient";
import { AccountScreen } from "../components/AccountScreens";
import { AgenticAnalysisPanel } from "../components/AgenticAnalysis";
import { SfxToggle, useNotifications } from "../components/NotificationSystem";

type Mode = "spot" | "perp";
type ChartUnit = "price" | "mcap";
type Row = Record<string, unknown>;
const initialIndicators: IndicatorSet = {
  ema: true, bollinger: false, vwap: true, sr: true, volume: true, cvd: true, rsi: false, macd: false, obv: false
};
const intervals = ["1M", "5M", "15M", "1H", "4H", "1D"];
const CHART_UNIT_KEY = "desk-chart-unit";

function readChartUnit(): ChartUnit {
  try {
    return localStorage.getItem(CHART_UNIT_KEY) === "price" ? "price" : "mcap";
  } catch {
    return "mcap";
  }
}
function persistChartUnit(unit: ChartUnit) {
  try { localStorage.setItem(CHART_UNIT_KEY, unit); } catch { /* ignore quota / private mode */ }
}

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
function asCandles(value: unknown): Candle[] {
  return array(value).map((item) => ({
    time: Number(item.time), open: Number(item.open), high: Number(item.high),
    low: Number(item.low), close: Number(item.close), volume: Number(item.volume)
  })).filter((item) => Object.values(item).every(Number.isFinite));
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
function tapeSpanLabel(spanMs: number) {
  if (!(spanMs > 0)) return "TAPE";
  if (spanMs >= TWO_HOURS_MS) return "2H";
  if (spanMs >= 3_600_000) return `${Math.round(spanMs / 3_600_000)}H`;
  return `${Math.max(1, Math.round(spanMs / 60_000))}M`;
}
function flowClass(bias: string) {
  const key = bias.toLowerCase();
  if (key === "buy" || key === "bullish") return "up";
  if (key === "sell" || key === "bearish") return "dn";
  return "";
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

function TokenIcon({ symbol, src }: { symbol: string; src: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <span className={`asset-icon${src && !failed ? " has-image" : ""}`}>{src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : (symbol || "T").slice(0, 1)}</span>;
}

export function DeskPage({ config, initialMode = "spot" }: { config: PublicConfig; initialMode?: Mode }) {
  const [theme, setTheme] = useTheme();
  const { notify } = useNotifications();
  const [section, setSection] = useState("Trade");
  const [searchOpen, setSearchOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [mint, setMint] = useState(config.ansemMint);
  const [perpSymbol, setPerpSymbol] = useState("SOL-PERP");
  const [query, setQuery] = useState(initialMode === "perp" ? "SOL-PERP" : "");
  const [interval, setIntervalValue] = useState("15M");
  const [chartExpanded, setChartExpanded] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const chartRef = useRef<MarketChartHandle>(null);
  const lastNotifiedMint = useRef("");
  const lastNotifiedError = useRef("");
  const [indicators, setIndicators] = useState(initialIndicators);
  const [board, setBoard] = useState<Row>({});
  const [spot, setSpot] = useState<OnchainMarket | null>(null);
  const [perps, setPerps] = useState<Row[]>([]);
  const [perpResult, setPerpResult] = useState<Row>({});
  const [account, setAccount] = useState<Row>({});
  const [error, setError] = useState("");
  const [trenchSort, setTrenchSort] = useState<"hot" | "new" | "mcap" | "volume">("hot");
  const [trenches, setTrenches] = useState<Row>({});
  const [holders, setHolders] = useState<Row>({});
  const [cvdState, setCvdState] = useState<{
    cvd: number | null; buyUsd: number; sellUsd: number; series: Array<{ time: number; value: number }>;
    trades: import("../types").PoolTrade[]; buyCount: number; sellCount: number;
    buyCountRecent: number; sellCountRecent: number; buyUsdRecent: number; sellUsdRecent: number;
    spanMs: number; flow: "buy" | "sell" | "flat"; failed: boolean;
  } | null>(null);
  const [chartUnit, setChartUnit] = useState<ChartUnit>(readChartUnit);
  const selectChartUnit = (unit: ChartUnit) => {
    setChartUnit(unit);
    persistChartUnit(unit);
  };

  useEffect(() => {
    let active = true;
    const load = () => api.board().then((value) => { if (active) setBoard(object(value)); }).catch(() => undefined);
    load();
    const timer = setInterval(load, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    api.perpsMarkets().then((result) => setPerps(array(object(object(result).data).markets))).catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    const load = () => api.trenches(trenchSort).then((value) => { if (active) setTrenches(object(value)); }).catch(() => { if (active) setTrenches({ tokens: [], error: "trenches unavailable" }); });
    load();
    const timer = setInterval(load, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [trenchSort]);

  useEffect(() => {
    if (mode !== "spot") return;
    let active = true;
    setHolders({});
    const load = () => api.holders(mint).then((value) => { if (active) setHolders(object(value)); }).catch(() => { if (active) setHolders({ holders: [], error: "holders unavailable" }); });
    load();
    const timer = setInterval(load, 45_000);
    return () => { active = false; clearInterval(timer); };
  }, [mode, mint]);

  useEffect(() => {
    if (mode !== "spot") return;
    let active = true;
    setSpot((current) => (current?.mint === mint ? current : null));
    const requested = mint;
    const load = () => api.market(requested, interval.toLowerCase())
      .then((value) => { if (active && value.mint === requested) { setSpot(value); setError(""); } })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : String(reason)));
    load();
    const timer = setInterval(load, 45_000);
    return () => { active = false; clearInterval(timer); };
  }, [mode, mint, interval]);

  useEffect(() => {
    if (mode !== "perp") return;
    setError("");
    Promise.allSettled([api.perpMarket(perpSymbol), api.perpAccount()]).then(([marketState, accountState]) => {
      if (marketState.status === "fulfilled") setPerpResult(marketState.value);
      else setError(marketState.reason instanceof Error ? marketState.reason.message : String(marketState.reason));
      if (accountState.status === "fulfilled") setAccount(accountState.value);
    });
  }, [mode, perpSymbol]);

  const tradePair = mode === "spot" && spot?.mint === mint ? spot?.pairAddress || "" : "";
  useEffect(() => {
    if (!tradePair) {
      setCvdState(null);
      return;
    }
    let active = true;
    const load = () => api.trades(tradePair)
      .then((value) => {
        if (!active) return;
        setCvdState({
          cvd: value.cvd,
          buyUsd: value.buyUsd,
          sellUsd: value.sellUsd,
          series: value.series || [],
          trades: value.trades || [],
          buyCount: value.buyCount ?? 0,
          sellCount: value.sellCount ?? 0,
          buyCountRecent: value.buyCountRecent ?? 0,
          sellCountRecent: value.sellCountRecent ?? 0,
          buyUsdRecent: value.buyUsdRecent ?? 0,
          sellUsdRecent: value.sellUsdRecent ?? 0,
          spanMs: value.spanMs ?? 0,
          flow: value.flow || "flat",
          failed: false
        });
      })
      .catch(() => {
        if (active) setCvdState({
          cvd: null, buyUsd: 0, sellUsd: 0, series: [], trades: [],
          buyCount: 0, sellCount: 0, buyCountRecent: 0, sellCountRecent: 0,
          buyUsdRecent: 0, sellUsdRecent: 0, spanMs: 0, flow: "flat", failed: true
        });
      });
    load();
    const timer = setInterval(load, 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [tradePair]);

  const perpData = object(perpResult.data);
  const perpMarket = object(perpData.market);
  const perpPrice = object(perpData.priceSummary);
  const perpTrend = object(perpData.priceTrend);
  const perpFees = object(perpMarket.fees);
  const perpFunding = object(perpMarket.funding);
  const perpCandles = useMemo(() => asCandles(perpData.candles), [perpData.candles]);
  const orderbook = object(perpData.orderbook);
  const bids = array(orderbook.bids);
  const asks = array(orderbook.asks);
  const accountData = object(account.data);
  const feed = spot?.mint === mint ? spot : null;
  useEffect(() => {
    if (!feed || lastNotifiedMint.current === feed.mint) return;
    lastNotifiedMint.current = feed.mint;
    notify({ title: `${feed.symbol} ONLINE`, message: "Chart, project intelligence, pools, and social flow are synchronized.", tone: "success" });
  }, [feed, notify]);
  useEffect(() => {
    if (!error || lastNotifiedError.current === error) return;
    lastNotifiedError.current = error;
    notify({ title: "FEED DEGRADED", message: error, tone: "warning" });
  }, [error, notify]);
  const trenchRows = array(trenches.tokens);
  const focusedTrench = trenchRows.find((item) => String(item.mintAddress) === mint) || null;
  const mergedProvider = { ...board, ...object(feed?.provider) };
  const tokenIconUrl = providerImageUrl([focusedTrench, feed?.provider]);
  const analysisProvider = { ...mergedProvider, holders, trenches };
  const clawSentiment = String(object(mergedProvider.get_indicators).sentiment || "").trim();
  const regimeLabel = clawSentiment ? clawSentiment.toUpperCase() : "—";
  const liveCvd = cvdState && !cvdState.failed ? cvdState : null;
  const deltaUsd = liveCvd ? liveCvd.buyUsdRecent - liveCvd.sellUsdRecent : null;
  const spanLabel = tapeSpanLabel(liveCvd?.spanMs ?? 0);
  const flowBias = liveCvd?.flow || "flat";
  const scale = feed ? mcapScale(feed) : { mcap: null, supply: null, source: null as "mcap" | "fdv" | null };
  const hasMcap = Boolean(scale.source && scale.supply);
  const useMcap = mode === "spot" && chartUnit === "mcap" && hasMcap;
  const rawSpotCandles = feed?.candles;
  const candles = useMemo(() => {
    if (mode === "perp") return perpCandles;
    return useMcap ? scaleCandlesToMcap(rawSpotCandles || [], scale.supply) : (rawSpotCandles || []);
  }, [mode, perpCandles, rawSpotCandles, scale.supply, useMcap]);
  const chartTitle = mode === "perp" ? perpSymbol : feed ? `${feed.symbol}/USD` : `LOADING ${mint.slice(0, 6)}…`;
  const chartPrice = mode === "perp" ? Number(perpPrice.mark || perpData.markPrice) : (useMcap ? scale.mcap : feed?.priceUsd);
  const chartPriceCompact = useMcap;
  const chartChange = mode === "perp" ? Number(perpTrend.changePct) : feed?.change24hPct;
  const chartUnitLabel = mode === "spot" ? (hasMcap ? (useMcap ? "MCAP" : "USD") : "NO MCAP") : null;
  const chartSub = mode === "spot" && hasMcap ? (useMcap ? money(feed?.priceUsd) : money(scale.mcap, true)) : null;
  const cvdValue = cvdState && !cvdState.failed ? cvdState.cvd : null;
  const cvdSeries = cvdState && !cvdState.failed ? cvdState.series : undefined;
  const sourceLabel = mode === "perp" ? "PHOENIX" : (feed?.dex || feed?.source || "GECKO");

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

  const focusSpot = (nextMint: string, symbol?: string) => {
    if (!MINT_RE.test(nextMint)) return;
    if (nextMint !== mint) notify({ title: `OPENING ${symbol?.toUpperCase() || "TOKEN"}`, message: "Loading the selected contract and its live market context.", tone: "info" });
    setMode("spot");
    setMint(nextMint);
    setSpot((current) => (current?.mint === nextMint ? current : null));
    setQuery(symbol ? symbol.toUpperCase() : nextMint);
    setError("");
  };
  const focusPerp = (symbol: string) => {
    notify({ title: `OPENING ${symbol}`, message: "Switching to the Phoenix perpetual market.", tone: "info" });
    setMode("perp");
    setPerpSymbol(symbol);
    setQuery(symbol);
  };
  const submitQuery = async () => {
    const text = query.trim();
    if (!text) return;
    const parsed = extractSolanaMint(text);
    if (parsed && "error" in parsed) { setError(parsed.error); return; }
    if (parsed && "mint" in parsed) { focusSpot(parsed.mint); return; }
    const upper = text.toUpperCase();
    const perpHit = perps.find((item) => String(item.perpSymbol).toUpperCase() === upper || String(item.perpSymbol).toUpperCase() === `${upper}-PERP`);
    if (perpHit) { focusPerp(String(perpHit.perpSymbol)); return; }
    const trenchHit = trenchRows.find((item) => {
      const symbol = String(item.symbol || "").toUpperCase();
      const name = String(item.name || "").toUpperCase();
      const mintAddress = String(item.mintAddress || item.mint || item.contract || "");
      return symbol === upper || name === upper || mintAddress === text || mintAddress.toUpperCase() === upper;
    });
    const trenchMint = String(trenchHit?.mintAddress || trenchHit?.mint || trenchHit?.contract || "");
    if (trenchHit && MINT_RE.test(trenchMint)) { focusSpot(trenchMint, String(trenchHit.symbol || text)); return; }
    try {
      const result = await api.search(text);
      const data = object(result.data);
      const rows = array(data.tokens || data.results || data.matches).concat(array(result.data));
      const hit = rows.find((item) => {
        const symbol = String(item.symbol || "").toUpperCase();
        return symbol === upper || MINT_RE.test(String(item.address || item.mint || item.contract || ""));
      }) || rows.find((item) => MINT_RE.test(String(item.address || item.mint || item.contract || "")));
      const found = String(hit?.address || hit?.mint || hit?.contract || "");
      if (found && MINT_RE.test(found)) focusSpot(found, String(hit?.symbol || text));
      else setError(`No mint found for ${text}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const openPastedContract = (event: ClipboardEvent<HTMLInputElement>) => {
    const parsed = extractSolanaMint(event.clipboardData.getData("text"));
    if (!parsed || "error" in parsed) return;
    event.preventDefault();
    setQuery(parsed.mint);
    focusSpot(parsed.mint);
  };

  const mintLabel = `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  const spotLoading = mode === "spot" && !feed;
  const scannerSearch = <div className="scanner-search">
    <AnimatePresence initial={false} mode="wait">
      {!searchOpen ? <motion.button key="scanner-closed" type="button" className="scanner-search-head" aria-label="Discover markets" aria-expanded="false" aria-controls="scanner-search-field" initial={{ opacity: 0, scaleX: 0.22 }} animate={{ opacity: 1, scaleX: 1 }} exit={{ opacity: 0, scaleX: 0.22 }} transition={{ type: "spring", stiffness: 520, damping: 32 }} style={{ transformOrigin: "right center" }} onClick={() => setSearchOpen(true)}><span>Discover markets</span><span className="search-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
      </span></motion.button> : <motion.form key="scanner-open" id="scanner-search-field" className="command-form" initial={{ opacity: 0, scaleX: 0.2 }} animate={{ opacity: 1, scaleX: 1 }} exit={{ opacity: 0, scaleX: 0.2 }} transition={{ type: "spring", stiffness: 520, damping: 31 }} style={{ transformOrigin: "right center" }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false); }} onSubmit={event => { event.preventDefault(); void submitQuery(); }}>
        <input autoFocus className="command-input" value={query} aria-label="Paste Solana contract address" placeholder="Paste contract address" spellCheck={false} autoComplete="off" onPaste={openPastedContract} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if(event.key === "Escape") setSearchOpen(false); }} />
        <button className="search-submit" type="submit" aria-label="Open token"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg></button>
        <button className="search-close" type="button" aria-label="Close market search" onClick={() => setSearchOpen(false)}>×</button>
      </motion.form>}
    </AnimatePresence>
  </div>;

  return (
    <main className="onchain-desk">
      <div className="desk-grainient" aria-hidden="true"><Grainient color1="#12472c" color2="#080e0b" color3="#248e59" lightMode={theme === "light"} timeSpeed={0.08} grainAmount={0.035} contrast={1} /></div>
      <header className="app-header desk-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">▦</span><strong>termeow</strong><b>sol</b>
        </div>
        <nav className="primary-navigation" aria-label="Main navigation">{["Trade", "Automation", "Portfolio", "Referrals", "Leaderboard"].map(item => <button key={item} aria-current={section === item ? "page" : undefined} className={section === item ? "active" : ""} onClick={() => setSection(item)}>{item}</button>)}</nav>
        <nav className="mode-switch" aria-label="Trading product">
          <SpecularButton size="sm" radius={4} tint="#39ff88" tintOpacity={mode === "spot" ? 0.16 : 0} textColor="var(--text)" lineColor="#8affb4" autoAnimate={mode === "spot"} className={mode === "spot" ? "active" : ""} onClick={() => { setMode("spot"); setSection("Trade"); notify({ title: "ONCHAIN DESK", message: "Spot execution and Solana intelligence are active.", tone: "info" }); }}>ONCHAIN</SpecularButton>
          <SpecularButton size="sm" radius={4} tint="#39ff88" tintOpacity={mode === "perp" ? 0.16 : 0} textColor="var(--text)" lineColor="#8affb4" autoAnimate={mode === "perp"} className={mode === "perp" ? "active" : ""} onClick={() => { setMode("perp"); setSection("Trade"); notify({ title: "PERPS DESK", message: "Phoenix perpetual markets are active.", tone: "info" }); }}>PERPS</SpecularButton>
        </nav>
        <ThemeToggle theme={theme} onChange={setTheme} />
        <SfxToggle />
        <AuthControls />
      </header>
      {feed && <MarketStrips market={feed} onPick={focusSpot} />}
      {section !== "Trade" && <AccountScreen section={section as "Automation" | "Portfolio" | "Referrals" | "Leaderboard"} onBack={() => setSection("Trade")} />}
      <div className="desk-grid" style={section !== "Trade" ? {display:"none"} : undefined}>
        <WatchPanel
          search={scannerSearch}
          market={{ provider: mergedProvider } as OnchainMarket}
          selected={mode === "perp" ? perpSymbol : mint}
          onSpot={focusSpot}
          trenches={trenchRows}
          onTrenchSort={setTrenchSort}
        />
        <section className={`panel chart-panel${chartExpanded ? " chart-expanded" : ""}`}>
          <div className="ph chart-head">
            <div className="chart-head-left">
              <span className="pt">{chartTitle}</span>
              {mode === "spot" && (
                <span className="unit-toggle" role="group" aria-label="Chart unit">
                  <button type="button" className={!useMcap ? "on" : ""} onClick={() => selectChartUnit("price")}>PRICE</button>
                  <button type="button" className={useMcap ? "on" : ""} disabled={!hasMcap} onClick={() => selectChartUnit("mcap")}>MCAP</button>
                </span>
              )}
              {mode === "spot" && <span className="intervals">{intervals.map((item) => <button key={item} className={interval === item ? "on" : ""} onClick={() => setIntervalValue(item)}>{item}</button>)}</span>}
            </div>
            <div className="chart-head-right">
              <span className="chart-hero">
                <b className={`chart-price${useMcap ? " mcap-value" : ""}`}>{money(chartPrice, chartPriceCompact)}</b>
                <i className={(chartChange || 0) < 0 ? "dn" : "up"}>{pct(chartChange)}</i>
                {chartUnitLabel && <em className={chartUnitLabel === "NO MCAP" ? "chart-unit warn" : "chart-unit"}>{chartUnitLabel}</em>}
                {chartSub && <small className={`chart-sub${!useMcap ? " mcap-value" : ""}`}>{chartSub}</small>}
              </span>
              <span className="chart-meta">{candles.length} BARS · {sourceLabel} · {mode === "perp" ? "1H" : interval}</span>
            </div>
          </div>
          <IndicatorBar value={indicators} onChange={setIndicators} />
          <div className="chart-tools" role="toolbar" aria-label="Chart navigation tools">
            <span className="chart-tool-status" title="Drag to pan. Scroll or pinch to zoom.">PAN · CROSSHAIR</span>
            <button type="button" title="Zoom in" aria-label="Zoom chart in" onClick={() => chartRef.current?.zoomIn()}>＋</button>
            <button type="button" title="Zoom out" aria-label="Zoom chart out" onClick={() => chartRef.current?.zoomOut()}>−</button>
            <button type="button" title="Restore the close candle view" onClick={() => chartRef.current?.resetView()}>RESET</button>
            <button type="button" title="Jump to the latest candle" onClick={() => chartRef.current?.goToRealtime()}>LIVE</button>
            {mode === "spot" && <button type="button" className="analyze-trigger" title="Synthesize token data into executable trade setups" disabled={!feed || !feed.candles.length} onClick={() => { setAnalysisOpen(true); notify({ title: `ANALYZING ${feed?.symbol || "TOKEN"}`, message: "Synthesizing momentum, CVD, liquidity, whale flow, and project intelligence.", tone: "success" }); }}>✦ ANALYZE</button>}
            <button type="button" title={chartExpanded ? "Exit expanded chart" : "Expand chart"} aria-pressed={chartExpanded} onClick={() => setChartExpanded((expanded) => !expanded)}>{chartExpanded ? "CLOSE" : "EXPAND"}</button>
          </div>
          {spotLoading ? (
            <div className="integration-empty chart-loading"><span className="notification-pixel chart-loader" aria-hidden="true"><i /><i /><i /><i /></span><h2>LOADING {mintLabel}</h2><p>{error || "Fetching chart, intel, holders, and social for this contract."}</p></div>
          ) : candles.length ? <MarketChart ref={chartRef} candles={candles} indicators={indicators} cvdSeries={cvdSeries} compactAxis={useMcap} theme={theme} /> : <div className="integration-empty"><h2>NO CANDLES YET</h2><p>{error || "No OHLCV on Gecko for this mint's pools."}</p></div>}
          <div className="chart-readout">
            <span>RSI14 <b>{technicals?.rsi?.toFixed(2) || "—"}</b></span>
            <span>MACD <b>{technicals?.macd?.toPrecision(4) || "—"}</b></span>
            <span>SIGNAL <b>{technicals?.signal?.toPrecision(4) || "—"}</b></span>
            <span>ATR14 <b>{money(technicals?.atr, chartPriceCompact)}</b></span>
            <span>SUP <b>{money(technicals?.low, chartPriceCompact)}</b></span>
            <span>RES <b>{money(technicals?.high, chartPriceCompact)}</b></span>
            <span>DELTA <b className={deltaUsd == null ? "" : deltaUsd >= 0 ? "up" : "dn"}>{deltaUsd == null ? "—" : signedMoney(deltaUsd)}</b></span>
            <span>CVD <b className={cvdValue == null ? "" : cvdValue >= 0 ? "up" : "dn"}>{cvdValue == null ? "—" : signedMoney(cvdValue)}</b></span>
            <span>BUY <b className="up">{liveCvd ? money(liveCvd.buyUsd, true) : "—"}</b></span>
            <span>SELL <b className="dn">{liveCvd ? money(liveCvd.sellUsd, true) : "—"}</b></span>
            <span>FLOW <b className={liveCvd ? flowClass(flowBias) : ""}>{liveCvd ? flowBias.toUpperCase() : "—"}</b></span>
            <span>{spanLabel} <b>B{liveCvd ? liveCvd.buyCountRecent : "—"}/S{liveCvd ? liveCvd.sellCountRecent : "—"}</b></span>
            <span>TAPE SENT <b className={liveCvd ? flowClass(flowBias) : ""}>{liveCvd ? flowBias.toUpperCase() : "—"}</b></span>
            <span>REGIME <b className={flowClass(regimeLabel)}>{regimeLabel}</b></span>
          </div>
        </section>
        <aside className="execution-rail">
          {mode === "spot" && feed ? (
            <>
              <div className="instrument-slab">
                <div><TokenIcon symbol={feed.symbol} src={tokenIconUrl} /><span><b className={scale.source ? "mcap-value" : ""}>{scale.source ? money(scale.mcap, true) : money(feed.priceUsd)}</b><small>{feed.symbol}/USD {scale.source ? money(feed.priceUsd) : ""} · {feed.name} · SOLANA SPOT</small><AuditChips market={feed} /></span></div>
              </div>
              <FeatureSection id="execution" className="trade-execution-section"><SpotTradeTicket key={mint} config={config} mint={mint} symbol={feed.symbol} /></FeatureSection>
              <FeatureSection id="research"><ResearchPanel market={feed} /></FeatureSection>
            </>
          ) : mode === "spot" ? (
            <>
              <div className="instrument-slab">
                <div><span className="asset-icon">…</span><span><b>LOADING {mintLabel}</b><small>{mint} · SOLANA SPOT</small></span></div>
              </div>
              <FeatureSection id="execution" className="trade-execution-section"><SpotTradeTicket key={mint} config={config} mint={mint} symbol="TOKEN" /></FeatureSection>
              <FeatureSection id="research"><section className="panel project-info-panel"><div className="ph"><span className="pt">PROJECT INFORMATION</span><span className="pm">LOADING</span></div><p className="empty-copy">Fetching project intelligence for this contract.</p></section></FeatureSection>
            </>
          ) : (
            <>
              <section className="panel perp-risk">
                <div className="ph"><span className="pt">MARKET RISK</span><span className="pm">PHOENIX · LIVE</span></div>
                <dl>
                  <div><dt>MARK / MID</dt><dd>{money(Number(perpPrice.mark || perpData.markPrice))} / {money(Number(perpPrice.orderbookMid))}</dd></div>
                  <div><dt>SPREAD</dt><dd>{Number(perpPrice.spreadBps).toFixed(2)} BPS</dd></div>
                  <div><dt>RANGE HIGH / LOW</dt><dd>{money(Number(perpTrend.high))} / {money(Number(perpTrend.low))}</dd></div>
                  <div><dt>MAKER / TAKER</dt><dd>{(Number(perpFees.maker) * 100).toFixed(3)}% / {(Number(perpFees.taker) * 100).toFixed(3)}%</dd></div>
                  <div><dt>MAX FUND / H</dt><dd>{Number.isFinite(Number(perpFunding.maxRatePerIntervalPercentage)) ? `${Number(perpFunding.maxRatePerIntervalPercentage).toFixed(4)}%` : "—"}</dd></div>
                  <div><dt>OI CAP LOTS</dt><dd>{String(perpMarket.openInterestCapBaseLots || "—")}</dd></div>
                </dl>
              </section>
              <FeatureSection id="execution" className="trade-execution-section"><PerpTradeTicket key={perpSymbol} config={config} symbol={perpSymbol} />
              <section className="panel account-board"><div className="ph"><span className="pt">AGENT ACCOUNT</span><span className="pm">READ ONLY</span></div><pre>{Object.keys(accountData).length ? JSON.stringify(accountData, null, 2) : "No initialized Phoenix account state returned."}</pre></section>
              </FeatureSection>
            </>
          )}
        </aside>
        <FeatureSection id={mode === "spot" ? "social" : "flow"} className="radar-panel" meta={mode === "spot" ? <span className="social-live"><i /> LIVE</span> : undefined}>
        {mode === "spot" && feed ? <SocialPanel
          market={{ ...feed, provider: mergedProvider }}
          trench={focusedTrench}
          flow={{ bias: flowBias, buyCount: liveCvd?.buyCountRecent || 0, sellCount: liveCvd?.sellCountRecent || 0, spanLabel }}
          onPick={focusSpot}
        /> : mode === "spot" ? (
          <section className="panel radar-panel social-panel">
            <p className="empty-copy">Fetching KOL, narrative, and social links for this mint.</p>
          </section>
        ) : (
          <section className="panel orderbook-panel radar-panel">
            <div className="ph"><span className="pt">ORDER BOOK</span><span className="pm">RESTING · CANCELLABLE</span></div>
            <div className="book-split"><div><b className="up">BIDS · PRICE / QTY</b>{bids.slice(0, 12).map((row, index) => <p key={index}><span>{String(row.price ?? row[0] ?? "—")}</span><b>{String(row.quantity ?? row.size ?? row[1] ?? "—")}</b></p>)}</div><div><b className="dn">ASKS · PRICE / QTY</b>{asks.slice(0, 12).map((row, index) => <p key={index}><span>{String(row.price ?? row[0] ?? "—")}</span><b>{String(row.quantity ?? row.size ?? row[1] ?? "—")}</b></p>)}</div></div>
            {!bids.length && !asks.length && <p className="empty-copy">Order-book levels were not returned in this response.</p>}
          </section>
        )}
        </FeatureSection>
        {mode === "spot" && feed ? <BothSidesPanel
          market={feed}
          trades={liveCvd?.trades || []}
          flow={flowBias}
          buyCount={liveCvd?.buyCount || 0}
          sellCount={liveCvd?.sellCount || 0}
          buyCountRecent={liveCvd?.buyCountRecent || 0}
          sellCountRecent={liveCvd?.sellCountRecent || 0}
          spanLabel={spanLabel}
        /> : mode === "spot" ? (
          <section className="panel sides-panel flow-panel research-panel">
            <div className="ph"><span className="pt">LIQUIDITY &amp; ORDER FLOW</span><span className="pm">LOADING {mintLabel}</span></div>
            <p className="empty-copy">Fetching pool and tape intelligence for this contract.</p>
          </section>
        ) : <FeatureSection id="research" className="research-panel">
          <section className="panel research-panel">
            <div className="ph"><span className="pt">CONTRACT · FUNDING · LIQUIDATION</span><span className="pm">PHOENIX ISOLATED PERPS</span></div>
            <div className="radar-grid">
              <div><small>MARKET PUBKEY</small><strong title={String(perpMarket.marketPubkey)}>{String(perpMarket.marketPubkey || "—")}</strong></div>
              <div><small>ASSET ID</small><strong>{String(perpMarket.assetId ?? "—")}</strong></div>
              <div><small>BASE LOT DECIMALS</small><strong>{String(perpMarket.baseLotsDecimals ?? "—")}</strong></div>
              <div><small>MAX LIQ SIZE LOTS</small><strong>{String(perpMarket.maxLiquidationSizeBaseLots || "—")}</strong></div>
            </div>
          </section>
        </FeatureSection>}
      </div>
      {feed && <AgenticAnalysisPanel open={analysisOpen} market={feed} candles={feed.candles} cvd={liveCvd} provider={analysisProvider} onClose={() => setAnalysisOpen(false)} />}
    </main>
  );
}
