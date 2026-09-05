import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { OnchainMarket, PublicConfig } from "../types";
import { MarketChart, type IndicatorSet } from "../components/MarketChart";
import { IndicatorBar } from "../components/IndicatorBar";
import { SpotTradeTicket } from "../components/SpotTradeTicket";
import { SessionPermission } from "../auth/SessionPermission";
import { money, pct, signedMoney } from "../lib/format";
import { atr, macd, rsi } from "../lib/indicators";
import { mcapScale, scaleCandlesToMcap } from "../lib/mcap";
import { BothSidesPanel, MarketStrips, ResearchPanel, SignalRadar, ToolHealth, WatchPanel } from "../components/DeskPanels";

const initialIndicators: IndicatorSet = {
  ema: true,
  bollinger: false,
  vwap: true,
  sr: true,
  volume: true,
  cvd: true,
  rsi: false,
  macd: false,
  obv: false
};

function lastValue(values: Array<number | null>) {
  for (let index = values.length - 1; index >= 0; index -= 1) if (values[index] != null) return values[index];
  return null;
}

export function OnchainPage({ config }: { config: PublicConfig }) {
  const [market, setMarket] = useState<OnchainMarket | null>(null);
  const [error, setError] = useState("");
  const [indicators, setIndicators] = useState(initialIndicators);
  const [interval, setIntervalValue] = useState("5M");
  const [cvdState, setCvdState] = useState<{ cvd: number | null; buyUsd: number; sellUsd: number; series: Array<{ time: number; value: number }>; failed: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => api.market(config.ansemMint, interval.toLowerCase())
      .then((value) => { if (active) { setMarket(value); setError(""); } })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : String(reason)));
    load();
    const timer = setInterval(load, 45_000);
    return () => { active = false; clearInterval(timer); };
  }, [config.ansemMint, interval]);

  useEffect(() => {
    const pair = market?.pairAddress;
    if (!pair) {
      setCvdState(null);
      return;
    }
    let active = true;
    const load = () => api.trades(pair)
      .then((value) => {
        if (!active) return;
        setCvdState({ cvd: value.cvd, buyUsd: value.buyUsd, sellUsd: value.sellUsd, series: value.series || [], failed: false });
      })
      .catch(() => { if (active) setCvdState({ cvd: null, buyUsd: 0, sellUsd: 0, series: [], failed: true }); });
    load();
    const timer = setInterval(load, 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [market?.pairAddress]);

  const scale = market ? mcapScale(market) : { mcap: null, supply: null, source: null as "mcap" | "fdv" | null };
  const candles = useMemo(
    () => (market ? scaleCandlesToMcap(market.candles, scale.supply) : []),
    [market, scale.supply]
  );
  const compactLevels = Boolean(scale.source);
  const cvdSeries = cvdState && !cvdState.failed ? cvdState.series : undefined;

  const technicals = useMemo(() => {
    if (!candles.length) return null;
    const closes = candles.map((candle) => candle.close);
    const macdLines = macd(closes);
    return {
      rsi: lastValue(rsi(closes)),
      macd: lastValue(macdLines.line),
      signal: lastValue(macdLines.signal),
      atr: lastValue(atr(candles)),
      high: Math.max(...candles.slice(-96).map((candle) => candle.high)),
      low: Math.min(...candles.slice(-96).map((candle) => candle.low))
    };
  }, [candles]);

  if (error && !market) return <main className="loading-state"><h1>ANSEM DATA UNAVAILABLE</h1><p>{error}</p></main>;
  if (!market) return <main className="loading-state"><span className="loader" /><p>Loading ANSEM/USD desk from Solana and ClawPump…</p></main>;

  return (
    <main className="onchain-desk">
      <MarketStrips market={market} />
      <div className="desk-grid">
        <WatchPanel market={market} />
        <section className="panel chart-panel">
          <div className="ph chart-head">
            <span className="pt">ANSEM/USD</span>
            <span className={scale.source ? "chip" : "chip warn"}>{scale.source ? "MCAP" : "PRICE (NO MCAP)"}</span>
            <span className="intervals">{["1M", "5M", "15M", "1H", "4H", "1D"].map((item) => <button key={item} className={interval === item ? "on" : ""} onClick={() => setIntervalValue(item)}>{item}</button>)}</span>
            <span className="chart-price">{money(scale.source ? scale.mcap : market.priceUsd, compactLevels)} <i className={(market.change24hPct || 0) < 0 ? "dn" : "up"}>{pct(market.change24hPct)}</i></span>
            <span className="pm">{market.candles.length} BARS · SOURCE {interval}</span>
          </div>
          <IndicatorBar value={indicators} onChange={setIndicators} />
          <MarketChart candles={candles} indicators={indicators} cvdSeries={cvdSeries} />
          <div className="chart-readout">
            <span>RSI14 <b>{technicals?.rsi?.toFixed(2) || "—"}</b></span>
            <span>MACD <b>{technicals?.macd?.toPrecision(4) || "—"}</b></span>
            <span>SIGNAL <b>{technicals?.signal?.toPrecision(4) || "—"}</b></span>
            <span>ATR14 <b>{money(technicals?.atr, compactLevels)}</b></span>
            <span>S96 <b>{money(technicals?.low, compactLevels)}</b></span>
            <span>R96 <b>{money(technicals?.high, compactLevels)}</b></span>
            <span>CVD <b>{cvdState?.failed || cvdState?.cvd == null ? "—" : signedMoney(cvdState.cvd)}</b></span>
            <span>BUY <b className="up">{cvdState && !cvdState.failed ? money(cvdState.buyUsd, true) : "—"}</b></span>
            <span>SELL <b className="dn">{cvdState && !cvdState.failed ? money(cvdState.sellUsd, true) : "—"}</b></span>
          </div>
        </section>
        <aside className="execution-rail">
          <div className="instrument-slab">
            <div><span className="asset-icon">A</span><span><b>{scale.source ? money(scale.mcap, true) : money(market.priceUsd)}</b><small>{market.symbol}/USD {scale.source ? money(market.priceUsd) : ""} · {market.name} · SOLANA SPOT</small></span></div>
            <span className={market.degraded ? "feed-state warning" : "feed-state"}>{market.degraded ? "PARTIAL" : "LIVE"} · 45S</span>
          </div>
          <ToolHealth market={market} />
          <BothSidesPanel market={market} />
          <SpotTradeTicket config={config} />
          <SessionPermission />
          <section className="panel agent-placeholder">
            <div className="ph"><span className="pt">THESIS AGENT</span><span className="pm">MARKET CONTEXT</span></div>
            <p>ClawPump evidence and order-preview tools are available in the workspace.</p>
          </section>
        </aside>
        <SignalRadar market={market} />
        <ResearchPanel market={market} />
      </div>
      {error && <div className="toast-inline">REFRESH DEGRADED · {error}</div>}
    </main>
  );
}
