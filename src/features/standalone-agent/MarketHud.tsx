import { AnimatePresence, motion } from "motion/react";
import { CandlestickSeries, ColorType, createChart, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { MarketCandle, MarketResponse } from "../../../shared/wire";
import { api } from "../../api/client";
import { money, pct } from "../../lib/format";
import { useAgent } from "../voice-agent/context/AgentProvider";
import { useAgentStore } from "../voice-agent/store/agentStore";

const toSeconds = (time: number) => Math.floor(time > 10_000_000_000 ? time / 1000 : time) as UTCTimestamp;
const bar = (candle: MarketCandle) => ({ time: toSeconds(candle.time), open: candle.open, high: candle.high, low: candle.low, close: candle.close });

function HudChart({ market }: { market: MarketResponse }) {
  const host = useRef<HTMLDivElement>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const candles = useRef<MarketCandle[]>([]);
  useEffect(() => {
    if (!host.current) return;
    const root = getComputedStyle(document.querySelector(".agent-app") || document.documentElement);
    const accent = root.getPropertyValue("--agent-lime").trim() || "#45ff88";
    const chart = createChart(host.current, {
      autoSize: true, layout: { background: { type: ColorType.Solid, color: "rgba(1,7,4,0)" }, textColor: "#769383", fontFamily: "Home Video, monospace", fontSize: 9 },
      grid: { vertLines: { color: "rgba(69,255,136,.055)" }, horzLines: { color: "rgba(69,255,136,.07)" } },
      rightPriceScale: { borderColor: "rgba(69,255,136,.18)", scaleMargins: { top: .12, bottom: .12 } },
      timeScale: { borderColor: "rgba(69,255,136,.18)", rightOffset: 4, barSpacing: 5, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: "rgba(114,245,255,.35)" }, horzLine: { color: "rgba(114,245,255,.35)" } },
      handleScroll: true, handleScale: true
    });
    series.current = chart.addSeries(CandlestickSeries, { upColor: accent, downColor: "#ff6685", borderVisible: false, wickUpColor: accent, wickDownColor: "#ff6685", priceLineColor: accent, priceLineWidth: 1 });
    const data = market.candles.map(bar);
    candles.current = market.candles;
    series.current.setData(data);
    chart.timeScale().fitContent();
    return () => { series.current = null; chart.remove(); };
  }, []);
  useEffect(() => {
    const active = series.current;
    if (!active || !market.candles.length) return;
    const before = candles.current.at(-1);
    const next = market.candles.at(-1)!;
    if (!before || toSeconds(before.time) !== toSeconds(next.time)) {
      active.setData(market.candles.map(bar));
      candles.current = market.candles;
      return;
    }
    const started = performance.now();
    let frame = 0;
    const animate = (now: number) => {
      const progress = Math.min(1, (now - started) / 280);
      const eased = 1 - Math.pow(1 - progress, 3);
      const lerp = (from: number, to: number) => from + (to - from) * eased;
      active.update({ time: toSeconds(next.time), open: lerp(before.open, next.open), high: lerp(before.high, next.high), low: lerp(before.low, next.low), close: lerp(before.close, next.close) });
      if (progress < 1) frame = requestAnimationFrame(animate);
      else candles.current = market.candles;
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [market]);
  return <div className="market-hud-chart" ref={host} aria-label={`Interactive ${market.instrument.symbol} market chart`} />;
}

export function MarketHud() {
  const hud = useAgentStore((state) => state.hudWindow);
  const setHudWindow = useAgentStore((state) => state.setHudWindow);
  const agent = useAgent();
  const [market, setMarket] = useState<MarketResponse | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!hud) { setMarket(null); return; }
    let live = true;
    const load = async () => {
      try {
        let next = await api.market(hud.chain, hud.tokenAddress, hud.timeframe);
        if (!next.candles.length) {
          const captured = await api.capturedCandles(hud.chain, hud.tokenAddress, "1m").catch(() => null);
          if (captured?.candles.length) next = { ...next, candles: captured.candles, interval: "1m", source: captured.source };
        }
        if (!live) return;
        setMarket(next); setError(next.error || "");
        const latest = next.candles.at(-1);
        agent.updateContext({ route: "/agent", chain: hud.chain, token: { address: hud.tokenAddress, symbol: next.instrument.symbol || hud.tokenSymbol, name: next.instrument.name, logoUrl: next.instrument.image || undefined }, chart: {
          timeframe: hud.timeframe, unit: "price", scale: "linear", priceUsd: next.priceUsd, marketCapUsd: next.marketCapUsd, change24Pct: next.change24Pct,
          latestCandle: latest || null, loadedBars: next.candles.length
        }, observedAt: next.observedAt });
      } catch (reason) { if (live) setError(reason instanceof Error ? reason.message : String(reason)); }
    };
    void load();
    const timer = setInterval(load, 5_000);
    return () => { live = false; clearInterval(timer); };
  }, [agent.updateContext, hud?.chain, hud?.tokenAddress, hud?.timeframe]);
  return <AnimatePresence>{hud ? <motion.aside className="market-hud" initial={{ opacity: 0, x: 80, scale: .72 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 55, scale: .85 }} transition={{ type: "spring", stiffness: 280, damping: 27 }}>
    <header><span><i /> MARKET HUD</span><button type="button" onClick={() => setHudWindow()}>×</button></header>
    <div className="market-hud-meta">
      <div>{market?.instrument.image ? <img src={market.instrument.image} alt="" /> : <span className="hud-token-fallback" />}<span><small>{hud.chain.toUpperCase()} · {(market?.interval || hud.timeframe).toUpperCase()}</small><strong>${(market?.instrument.symbol || hud.tokenSymbol || "TOKEN").replace(/^\$+/, "")}</strong></span></div>
      <div><b>{money(market?.priceUsd)}</b><em className={(market?.change24Pct || 0) < 0 ? "down" : "up"}>{pct(market?.change24Pct)}</em></div>
    </div>
    {market?.candles.length ? <HudChart market={market} /> : <div className="market-hud-empty">{error || "ACQUIRING CANDLES…"}</div>}
    <footer><span>MCAP <b>{money(market?.marketCapUsd, true)}</b></span><span>LIQ <b>{money(market?.liquidityUsd, true)}</b></span><span>VOL 24H <b>{money(market?.volume24Usd, true)}</b></span></footer>
  </motion.aside> : null}</AnimatePresence>;
}
