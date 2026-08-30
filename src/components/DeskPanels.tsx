import { useMemo, useState } from "react";
import type { OnchainMarket } from "../types";
import { money, pct } from "../lib/format";

type Row = Record<string, unknown>;

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function rows(value: unknown, keys: string[]): Row[] {
  const source = record(value);
  for (const key of keys) {
    if (Array.isArray(source[key])) return (source[key] as unknown[]).filter((item): item is Row => Boolean(item && typeof item === "object"));
  }
  return [];
}

function clean(value: unknown) {
  return String(value ?? "—").replace(/<[^>]*>/g, "");
}

function compact(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? money(number, true) : "—";
}

function changeClass(value: unknown) {
  return Number(value) < 0 ? "dn" : "up";
}

export function MarketStrips({ market }: { market: OnchainMarket }) {
  const provider = record(market.provider);
  const indicators = record(provider.get_indicators);
  const intelligence = record(provider.intelligence_market);
  const pools = rows(intelligence, ["top_pools"]);
  const movers = rows(provider.top_movers, ["signals", "movers"]).slice(0, 8);
  const sentiment = String(indicators.sentiment || "unknown").toUpperCase();
  return (
    <>
      <div className="ticker-tape">
        <div className="ticker-inner">
          <span><b>ANSEM</b> {money(market.priceUsd)} <i className={changeClass(market.change24hPct)}>{pct(market.change24hPct)}</i></span>
          {movers.map((item) => <span key={String(item.contract || item.symbol)}><b>{clean(item.symbol)}</b> {money(Number(item.price_usd))} <i className={changeClass(item.change_24h)}>{pct(Number(item.change_24h) * 100)}</i></span>)}
        </div>
      </div>
      <div className="desk-strip">
        <b>REGIME</b><span className={sentiment === "BULLISH" ? "up" : sentiment === "BEARISH" ? "dn" : "amber"}>{sentiment}</span>
        <span>SOL <i className={changeClass(record(indicators.sol).change_24h)}>{pct(Number(record(indicators.sol).change_24h))}</i></span>
        <span>ANSEM 5M <i className={changeClass(record(intelligence.price_changes)["5m"])}>{pct(Number(record(intelligence.price_changes)["5m"]) * 100)}</i></span>
        <span>1H <i className={changeClass(record(intelligence.price_changes)["1h"])}>{pct(Number(record(intelligence.price_changes)["1h"]) * 100)}</i></span>
        <span>4H <i className={changeClass(record(intelligence.price_changes)["4h"])}>{pct(Number(record(intelligence.price_changes)["4h"]) * 100)}</i></span>
        <span>TURNOVER/LIQ <i>{market.liquidityUsd ? ((market.volume24hUsd || 0) / market.liquidityUsd).toFixed(2) : "—"}×</i></span>
      </div>
      <div className="desk-strip venue-strip">
        <b>VENUES</b><span>{Number(intelligence.total_pools) || pools.length} POOLS</span>
        {pools.slice(0, 5).map((pool) => <span key={String(pool.pool_address)}>{clean(pool.protocol)} <i>{compact(pool.liquidity_usd)}</i></span>)}
      </div>
    </>
  );
}

type WatchTab = "WATCH" | "MOVERS" | "SIGNALS" | "ANOMALIES" | "POOLS";

export function WatchPanel({ market }: { market: OnchainMarket }) {
  const [tab, setTab] = useState<WatchTab>("WATCH");
  const provider = record(market.provider);
  const intelligence = record(provider.intelligence_market);
  const sourceRows = tab === "MOVERS" ? rows(provider.top_movers, ["signals", "movers"])
    : tab === "SIGNALS" ? rows(provider.intelligence_signals, ["signals"])
    : tab === "ANOMALIES" ? rows(provider.anomalies, ["gems", "signals"])
    : tab === "POOLS" ? rows(intelligence, ["top_pools"])
    : [{ symbol: market.symbol, name: market.name, price_usd: market.priceUsd, change_24h: (market.change24hPct || 0) / 100, market_cap_usd: market.marketCapUsd, signal: "Vertical-slice focus" }];
  return (
    <section className="panel watch-panel">
      <div className="ph"><div className="tabs">{(["WATCH", "MOVERS", "SIGNALS", "ANOMALIES", "POOLS"] as WatchTab[]).map((item) => <button key={item} className={tab === item ? "on" : ""} onClick={() => setTab(item)}>{item}</button>)}</div><span className="pm">CLAWPUMP · SOL</span></div>
      <div className="panel-scroll">
        {tab === "POOLS" ? (
          <table className="terminal-table"><thead><tr><th>VENUE / PAIR</th><th className="r">LIQ</th></tr></thead><tbody>{sourceRows.map((item) => <tr key={String(item.pool_address)}><td><b>{clean(item.protocol)}</b><small>{clean(item.token0)}/{clean(item.token1)}</small></td><td className="r">{compact(item.liquidity_usd)}</td></tr>)}</tbody></table>
        ) : (
          <table className="terminal-table"><thead><tr><th>SYMBOL / SIGNAL</th><th className="r">PRICE</th><th className="r">24H</th></tr></thead><tbody>{sourceRows.slice(0, 24).map((item, index) => <tr key={String(item.contract || item.symbol || index)}><td><b>{clean(item.symbol || item.name)}</b><small>{clean(item.signal || item.name)}</small></td><td className="r">{money(Number(item.price_usd))}</td><td className={`r ${changeClass(item.change_24h)}`}>{item.change_24h == null ? "—" : pct(Number(item.change_24h) * 100)}</td></tr>)}</tbody></table>
        )}
        {!sourceRows.length && <p className="empty-copy">No rows returned by this ClawPump feed.</p>}
      </div>
    </section>
  );
}

export function SignalRadar({ market }: { market: OnchainMarket }) {
  const provider = record(market.provider);
  const intelligence = record(provider.intelligence_market);
  const signals = rows(provider.intelligence_signals, ["signals"]);
  const matching = signals.filter((item) => String(item.contract) === market.mint);
  const changes = record(intelligence.price_changes);
  const cards = [
    ["MOMENTUM 5M", pct(Number(changes["5m"]) * 100), Number(changes["5m"])],
    ["MOMENTUM 1H", pct(Number(changes["1h"]) * 100), Number(changes["1h"])],
    ["MOMENTUM 4H", pct(Number(changes["4h"]) * 100), Number(changes["4h"])],
    ["HOLDERS", Number(intelligence.holders).toLocaleString(), 0],
    ["ACTIVE POOLS", String(intelligence.total_pools || "—"), 0],
    ["SMART FLOW", matching.length ? clean(matching[0].signal) : "NO ANSEM-SPECIFIC HIT", matching.length]
  ] as Array<[string, string, number]>;
  return (
    <section className="panel radar-panel">
      <div className="ph"><span className="pt">SIGNAL RADAR</span><span className="pm">DESCRIPTIVE · LIVE</span></div>
      <div className="radar-grid">{cards.map(([label, value, direction]) => <div key={label}><small>{label}</small><strong className={direction < 0 ? "dn" : direction > 0 ? "up" : ""}>{value}</strong></div>)}</div>
      <p className="method-note">Momentum, wallet activity and pool coverage describe current conditions; they are not presented as a tested directional edge.</p>
    </section>
  );
}

export function BothSidesPanel({ market }: { market: OnchainMarket }) {
  const provider = record(market.provider);
  const intelligence = record(provider.intelligence_market);
  const changes = record(intelligence.price_changes);
  const turnover = Number(intelligence.turnover_24h_usd || market.volume24hUsd);
  const liquidity = Number(intelligence.total_liquidity_usd || market.liquidityUsd);
  const high = Math.max(...market.candles.map((item) => item.high));
  const low = Math.min(...market.candles.map((item) => item.low));
  const bull = [
    ["DEPTH", `${Number(intelligence.total_pools || 0)} routed pools`],
    ["LIQUIDITY", compact(liquidity)],
    ["1H MOMENTUM", pct(Number(changes["1h"]) * 100)],
    ["RANGE SUPPORT", money(low)]
  ];
  const bear = [
    ["TURNOVER", liquidity ? `${(turnover / liquidity).toFixed(2)}× liquidity` : "—"],
    ["4H MOMENTUM", pct(Number(changes["4h"]) * 100)],
    ["24H MOMENTUM", pct(Number(changes["24h"]) * 100)],
    ["RANGE RESIST", money(high)]
  ];
  return (
    <section className="panel sides-panel">
      <div className="ph"><span className="pt">BOTH SIDES</span><span className="sd-sym">ANSEM</span><span className="pm">BULL · BEAR · RISK</span></div>
      <div className="sides-columns">
        <div><h3 className="up">BULL CASE</h3>{bull.map(([label, value]) => <p key={label}><span>{label}</span><b>{value}</b></p>)}</div>
        <div><h3 className="dn">BEAR / RISK</h3>{bear.map(([label, value]) => <p key={label}><span>{label}</span><b>{value}</b></p>)}</div>
      </div>
      <p className="method-note">Range levels use the loaded 200-bar window. Pool liquidity is cancellable/movable and should not be treated as guaranteed execution depth.</p>
    </section>
  );
}

export function ResearchPanel({ market }: { market: OnchainMarket }) {
  const provider = record(market.provider);
  const intelligence = record(provider.intelligence_market);
  const news = rows(provider.news, ["articles", "news", "items"]);
  return (
    <section className="panel research-panel">
      <div className="ph"><span className="pt">NEWS · RESEARCH</span><span className="pm">MATERIAL · SOURCED</span></div>
      <div className="panel-scroll">
        <article className="narrative"><b>CLAWPUMP NARRATIVE</b><p>{clean(intelligence.narratives || "No narrative returned.")}</p><small>{Array.isArray(intelligence.narrative_tags) ? intelligence.narrative_tags.join(" · ") : "SOLANA"}</small></article>
        {news.slice(0, 8).map((item, index) => <article className="news-row" key={String(item.id || item.url || index)}><b>{clean(item.title || item.headline)}</b><p>{clean(item.summary || item.description)}</p></article>)}
        {!news.length && <p className="empty-copy">ClawPump news is unavailable; token intelligence and live on-chain evidence remain active.</p>}
      </div>
    </section>
  );
}

export function ToolHealth({ market }: { market: OnchainMarket }) {
  const provider = record(market.provider);
  const tools = ["token_search", "get_indicators", "intelligence_market", "intelligence_signals", "top_movers", "anomalies", "macro", "arbitrage", "news"];
  return <div className="tool-health">{tools.map((name) => <span key={name} className={record(provider[name]).error ? "bad" : "good"}>{name.replace("intelligence_", "intel/").replace("get_", "")}</span>)}</div>;
}
