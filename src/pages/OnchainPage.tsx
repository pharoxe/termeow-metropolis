import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { OnchainMarket, PublicConfig } from "../types";
import { MarketChart, type IndicatorSet } from "../components/MarketChart";
import { IndicatorBar } from "../components/IndicatorBar";
import { SpotTradeTicket } from "../components/SpotTradeTicket";
import { SessionPermission } from "../auth/SessionPermission";
import { money, pct } from "../lib/format";
import { atr, macd, rsi } from "../lib/indicators";
import { BothSidesPanel, MarketStrips, ResearchPanel, SignalRadar, ToolHealth, WatchPanel } from "../components/DeskPanels";

const initialIndicators: IndicatorSet = {
  ema: true,
  bollinger: false,
  vwap: true,
  sr: true,
  volume: true,
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

  useEffect(() => {
    let active = true;
    const load = () => api.market(config.ansemMint, interval.toLowerCase())
      .then((value) => { if (active) { setMarket(value); setError(""); } })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : String(reason)));
    load();
    const timer = setInterval(load, 45_000);
    return () => { active = false; clearInterval(timer); };
  }, [config.ansemMint, interval]);

  const technicals = useMemo(() => {
    if (!market?.candles.length) return null;
    const closes = market.candles.map((candle) => candle.close);
    const macdLines = macd(closes);
    return {
      rsi: lastValue(rsi(closes)),
      macd: lastValue(macdLines.line),
      signal: lastValue(macdLines.signal),
      atr: lastValue(atr(market.candles)),
      high: Math.max(...market.candles.slice(-96).map((candle) => candle.high)),
      low: Math.min(...market.candles.slice(-96).map((candle) => candle.low))
    };
  }, [market]);

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
            <span className="intervals">{["1M", "5M", "15M", "1H", "4H", "1D"].map((item) => <button key={item} className={interval === item ? "on" : ""} onClick={() => setIntervalValue(item)}>{item}</button>)}</span>
            <span className="chart-price">{money(market.priceUsd)} <i className={(market.change24hPct || 0) < 0 ? "dn" : "up"}>{pct(market.change24hPct)}</i></span>
            <span className="pm">{market.candles.length} BARS · SOURCE {interval}</span>
          </div>
          <IndicatorBar value={indicators} onChange={setIndicators} />
          <MarketChart candles={market.candles} indicators={indicators} />
          <div className="chart-readout">
            <span>RSI14 <b>{technicals?.rsi?.toFixed(2) || "—"}</b></span>
            <span>MACD <b>{technicals?.macd?.toPrecision(4) || "—"}</b></span>
            <span>SIGNAL <b>{technicals?.signal?.toPrecision(4) || "—"}</b></span>
            <span>ATR14 <b>{money(technicals?.atr)}</b></span>
            <span>S96 <b>{money(technicals?.low)}</b></span>
            <span>R96 <b>{money(technicals?.high)}</b></span>
          </div>
        </section>
        <aside className="execution-rail">
          <div className="instrument-slab">
            <div><span className="asset-icon">A</span><span><b>{market.symbol}/USD</b><small>{market.name} · SOLANA SPOT</small></span></div>
            <span className={market.degraded ? "feed-state warning" : "feed-state"}>{market.degraded ? "PARTIAL" : "LIVE"} · 45S</span>
          </div>
          <ToolHealth market={market} />
          <BothSidesPanel market={market} />
          <SpotTradeTicket config={config} />
          <SessionPermission />
          <section className="panel agent-placeholder">
            <div className="ph"><span className="pt">THESIS AGENT</span><span className="pm">VOICE-READY BOUNDARY</span></div>
            <p>ClawPump evidence and order-preview tools are live. ElevenLabs transport remains intentionally deferred.</p>
          </section>
        </aside>
        <SignalRadar market={market} />
        <ResearchPanel market={market} />
      </div>
      {error && <div className="toast-inline">REFRESH DEGRADED · {error}</div>}
    </main>
  );
}
