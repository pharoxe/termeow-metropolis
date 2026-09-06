import { useEffect, useState, type ReactNode } from "react";
import { FeatureSection } from "../features/WorkspaceFeatures";
import type { OnchainMarket, PoolTrade } from "../types";
import { money, pct, shortAddress } from "../lib/format";
import { mcapScale, rowMarketCap, rowTokenPrice } from "../lib/mcap";
import { coverageChipLabel } from "../lib/flowSeries";
import type { FlowCoverage } from "../../shared/wire";

type Row = Record<string, unknown>;
type WatchTab = "TRENCHES" | "KOL" | "MOVERS" | "WHALES" | "HOLDERS" | "PERPS";
type TrenchSort = "hot" | "new" | "mcap" | "volume";

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
  return String(value ?? "—").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim() || "—";
}

function compact(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? money(number, true) : "—";
}

function changeClass(value: unknown) {
  return Number(value) < 0 ? "dn" : "up";
}

function asChangePct(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.abs(number) > 5 ? number : number * 100;
}

function formatAge(seconds: number) {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}M`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}H`;
  return `${Math.round(seconds / 86_400)}D`;
}

function printAge(time: number) {
  const ms = Math.max(0, Date.now() - time);
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function flowTone(value: string) {
  const key = value.toLowerCase();
  if (key === "buy" || key === "bullish") return "up";
  if (key === "sell" || key === "bearish") return "dn";
  return "";
}

function tokenAmt(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toLocaleString(undefined, { maximumFractionDigits: number >= 1 ? 2 : 4 });
}

export function AuditChips({ market }: { market: OnchainMarket }) {
  const provider = record(market.provider);
  const token = rows(provider.token_search, ["tokens"])[0] || {};
  const intelligence = record(provider.intelligence_market);
  const verified = token.verified === true;
  const source = String(token.source || "").replace(/_/g, " ").toUpperCase();
  const holders = Number(intelligence.holders);
  const pools = Number(intelligence.total_pools);
  const age = Number(intelligence.age_seconds);
  return (
    <span className="audit-chips">
      <span className={verified ? "chip good" : "chip warn"}>{verified ? "VERIFIED" : "UNVERIFIED"}</span>
      {source && source !== "—" && <span className="chip">{source}</span>}
      {Number.isFinite(holders) && holders > 0 && <span className="chip">HOLDERS {holders.toLocaleString()}</span>}
      {Number.isFinite(pools) && pools > 0 && <span className="chip">POOLS {pools}</span>}
      {Number.isFinite(age) && age > 0 && <span className="chip">AGE {formatAge(age)}</span>}
    </span>
  );
}

export function MarketStrips({ market, onPick }: { market: OnchainMarket; onPick?: (mint: string, symbol?: string) => void }) {
  const provider = record(market.provider);
  const movers = rows(provider.top_movers, ["signals", "movers"]).slice(0, 8);
  return (
    <div className="ticker-tape">
      <div className="ticker-inner">
        <span><b>{market.symbol}</b> {money(mcapScale(market).mcap ?? market.priceUsd, true)} <i className={changeClass(market.change24hPct)}>{pct(market.change24hPct)}</i></span>
        {movers.map((item) => <span key={String(item.contract || item.symbol)} role="button" onClick={() => { const mint = String(item.contract || ""); if (mint) onPick?.(mint, clean(item.symbol)); }}><b>{clean(item.symbol)}</b> {rowMarketCap(item) != null ? compact(rowMarketCap(item)) : money(Number(item.price_usd))} <i className={changeClass(asChangePct(item.change_24h))}>{pct(asChangePct(item.change_24h))}</i></span>)}
      </div>
    </div>
  );
}

export function WatchPanel({
  market, perps = [], mode = "spot", selected, onSpot, onPerp,
  trenches = [], trenchSort = "hot", onTrenchSort, holders, search
}: {
  market?: OnchainMarket | null;
  perps?: Row[];
  mode?: "spot" | "perp";
  selected?: string;
  onSpot?: (mint: string, symbol?: string) => void;
  onPerp?: (symbol: string) => void;
  trenches?: Row[];
  trenchSort?: TrenchSort;
  onTrenchSort?: (sort: TrenchSort) => void;
  holders?: Row;
  search?: ReactNode;
}) {
  const [tab, setTab] = useState<WatchTab>(mode === "perp" ? "PERPS" : "TRENCHES");
  useEffect(() => { setTab(mode === "perp" ? "PERPS" : "TRENCHES"); }, [mode]);
  const provider = record(market?.provider);
  const holderRows = rows(holders, ["holders"]);
  const gems = rows(provider.anomalies, ["gems", "signals"]);
  const focusedInGems = gems.some((item) => String(item.contract) === selected);
  const top1 = Number(holders?.top1Pct);
  const top10 = Number(holders?.top10Pct);
  const sourceRows = tab === "TRENCHES" ? trenches
    : tab === "KOL" ? rows(provider.intelligence_signals, ["signals"])
    : tab === "MOVERS" ? rows(provider.top_movers, ["signals", "movers"])
    : tab === "WHALES" ? gems
    : tab === "HOLDERS" ? holderRows
    : tab === "PERPS" ? perps
    : [];
  const pickSpot = (item: Row) => {
    const mint = String(item.contract || item.mint || item.mintAddress || item.token_address || item.address || "");
    if (mint) onSpot?.(mint, clean(item.symbol || item.name));
  };
  return (
    <section className="panel watch-panel">
      {search}
      <div className="ph">
        <div className="tabs">{(["TRENCHES", "KOL", "MOVERS", "WHALES", "HOLDERS", "PERPS"] as WatchTab[]).map((item) => <button key={item} className={tab === item ? "on" : ""} onClick={() => setTab(item)}>{item}</button>)}</div>
        <span className="pm">CLICK TO LOAD</span>
      </div>
      {tab === "TRENCHES" && (
        <div className="tabs trench-sorts">{(["hot", "new", "mcap", "volume"] as TrenchSort[]).map((item) => <button key={item} className={trenchSort === item ? "on" : ""} onClick={() => onTrenchSort?.(item)}>{item.toUpperCase()}</button>)}</div>
      )}
      {tab === "HOLDERS" && (
        <div className="conc-row">
          <span>TOP1 <b>{Number.isFinite(top1) ? `${top1.toFixed(1)}%` : "—"}</b></span>
          <span>TOP10 <b>{Number.isFinite(top10) ? `${top10.toFixed(1)}%` : "—"}</b></span>
          <span>COUNT <b>{holders?.holderCount != null ? Number(holders.holderCount).toLocaleString() : "—"}</b></span>
          {holders?.error ? <span className="amber">{clean(holders.error)}</span> : null}
        </div>
      )}
      {tab === "WHALES" && (
        <div className="conc-row">
          <span>{focusedInGems ? <b className="amber">FOCUSED MINT IN GEM TAPE</b> : "FOCUSED MINT NOT IN CURRENT GEM TAPE"}</span>
          {Number.isFinite(top10) && top10 > 0 && <span>HOLD TOP10 <b>{top10.toFixed(1)}%</b></span>}
        </div>
      )}
      <div className="panel-scroll">
        {tab === "PERPS" ? (
          <table className="terminal-table"><thead><tr><th>MARKET</th><th className="r">MAX LEV</th></tr></thead><tbody>{sourceRows.slice(0, 76).map((item) => <tr className={String(item.perpSymbol) === selected ? "selected" : ""} key={String(item.perpSymbol)} onClick={() => onPerp?.(String(item.perpSymbol))}><td><b>{clean(item.perpSymbol)}</b><small>{clean(item.displayName || item.category)}</small></td><td className="r">{String(item.maxLeverage || "—")}×</td></tr>)}</tbody></table>
        ) : tab === "TRENCHES" ? (
          <table className="terminal-table"><thead><tr><th>TOKEN / SOCIAL</th><th className="r">MCAP / VOL</th></tr></thead><tbody>{sourceRows.slice(0, 48).map((item) => {
            const mint = String(item.mintAddress || "");
            return <tr className={mint && mint === selected ? "selected" : ""} key={mint || String(item.symbol)} onClick={() => pickSpot(item)}>
              <td><b>{clean(item.symbol)}</b><small>{item.isGraduated ? "GRAD" : "BOND"}{item.xVerified ? " · X✓" : ""} {clean(item.agentXUsername || item.xVerifiedHandle || "")}</small></td>
              <td className="r">{compact(item.marketCap)}<small>{compact(item.volume24h)}</small></td>
            </tr>;
          })}</tbody></table>
        ) : tab === "HOLDERS" ? (
          <table className="terminal-table holders-table"><thead><tr><th>ACCOUNT</th><th className="r">AMOUNT</th><th className="r">PCT</th></tr></thead><tbody>{holderRows.map((item, index) => <tr className="static" key={String(item.address || index)}>
            <td><b>{shortAddress(String(item.address || ""))}</b><small>{clean(item.address)}</small></td>
            <td className="r">{tokenAmt(item.uiAmount)}</td>
            <td className="r">{item.pct == null ? "—" : `${Number(item.pct).toFixed(2)}%`}</td>
          </tr>)}</tbody></table>
        ) : (
          <table className="terminal-table"><thead><tr><th>SYMBOL / SIGNAL</th><th className="r">MCAP</th><th className="r">24H</th></tr></thead><tbody>{sourceRows.slice(0, 24).map((item, index) => {
            const mint = String(item.contract || item.mint || item.mintAddress || "");
            const change = asChangePct(item.change_24h);
            const cap = rowMarketCap(item);
            const px = rowTokenPrice(item);
            return <tr className={mint && mint === selected ? "selected" : ""} key={String(item.contract || item.symbol || index)} onClick={() => pickSpot(item)}><td><b>{clean(item.symbol || item.name)}</b><small>{clean(item.signal || item.name)}{item.chain && String(item.chain) !== "sol" ? ` · ${String(item.chain).toUpperCase()}` : ""}</small></td><td className="r">{cap != null ? compact(cap) : "—"}{px != null ? <small>{money(px)}</small> : null}</td><td className={`r ${change == null ? "" : changeClass(change)}`}>{change == null ? "—" : pct(change)}</td></tr>;
          })}</tbody></table>
        )}
        {!sourceRows.length && <p className="empty-copy">{tab === "HOLDERS" && holders?.error ? clean(holders.error) : "No rows returned by this feed."}</p>}
      </div>
    </section>
  );
}

export function SocialPanel({ market, trench, flow }: {
  market: OnchainMarket;
  trench?: Row | null;
  flow?: { bias: string; buyCount: number; sellCount: number; spanLabel: string };
}) {
  const provider = record(market.provider);
  const intelligence = record(provider.intelligence_market);
  const indicators = record(provider.get_indicators);
  const signals = rows(provider.intelligence_signals, ["signals"]);
  const matching = signals.filter((item) => String(item.contract) === market.mint);
  const tags = Array.isArray(intelligence.narrative_tags) ? intelligence.narrative_tags.map((tag) => String(tag)) : [];
  const twitter = trench ? String(trench.twitter || "") : "";
  const telegram = trench ? String(trench.telegram || "") : "";
  const handle = trench ? clean(trench.xVerifiedHandle || trench.agentXUsername || "") : "";
  const sent = String(indicators.sentiment || "").trim();
  const sentLabel = sent ? sent.toUpperCase() : "—";
  return (
    <section className="panel radar-panel social-panel">
      <div className="ph"><span className="pt">SOCIAL</span><span className="pm">NARRATIVE · KOL · LINKS</span></div>
      <div className="sentiment-strip">
        <span>REGIME <b className={flowTone(sentLabel)}>{sentLabel}</b></span>
        {flow ? <span>TAPE SENT <b className={flowTone(flow.bias)}>{flow.bias.toUpperCase()}</b> {flow.spanLabel} B{flow.buyCount}/S{flow.sellCount}</span> : null}
        <span className={matching.length ? "up" : ""}>{matching.length ? "KOL HIT" : "NO KOL HIT"}</span>
      </div>
      <div className="panel-scroll">
        <article className="narrative"><b>NARRATIVE</b><p>{clean(intelligence.narratives || "No narrative returned.")}</p><small>{tags.length ? tags.join(" · ") : "SOLANA"}</small></article>
        {matching.map((item, index) => <article className="news-row" key={String(item.contract || index)}><b>KOL · {clean(item.symbol)}</b><p>{clean(item.signal)}</p></article>)}
        {!matching.length && <p className="empty-copy">No KOL hit on this mint in the current tape.</p>}
        {trench && (
          <div className="social-links">
            {trench.xVerified ? <span className="chip good">X VERIFIED {handle !== "—" ? handle : ""}</span> : null}
            {twitter && twitter !== "null" ? <a href={twitter} target="_blank" rel="noreferrer">TWITTER</a> : null}
            {telegram && telegram !== "null" ? <a href={telegram} target="_blank" rel="noreferrer">TELEGRAM</a> : null}
            {!twitter && !telegram && !trench.xVerified && <span className="chip">NO SOCIAL LINKS IN TRENCHES</span>}
          </div>
        )}
      </div>
    </section>
  );
}

export function SignalRadar({ market, trench }: { market: OnchainMarket; trench?: Row | null }) {
  return <SocialPanel market={market} trench={trench} />;
}

export function BothSidesPanel({
  market,
  trades = [],
  flow = "flat",
  buyCount = 0,
  sellCount = 0,
  buyCountRecent,
  sellCountRecent,
  coverage
}: {
  market: OnchainMarket;
  trades?: PoolTrade[];
  flow?: string;
  buyCount?: number;
  sellCount?: number;
  buyCountRecent?: number;
  sellCountRecent?: number;
  spanLabel?: string;
  coverage?: FlowCoverage;
}) {
  const provider = record(market.provider);
  const intelligence = record(provider.intelligence_market);
  const indicators = record(provider.get_indicators);
  const pools = rows(intelligence, ["top_pools"]).slice().sort((a, b) => (Number(b.liquidity_usd) || 0) - (Number(a.liquidity_usd) || 0));
  const tape = [...trades].sort((a, b) => b.time - a.time || b.txHash.localeCompare(a.txHash)).slice(0, 14);
  const liqs = pools.map((pool) => Number(pool.liquidity_usd) || 0);
  const maxLiq = Math.max(0, ...liqs);
  const totalLiq = liqs.reduce((sum, value) => sum + value, 0)
    || Number(intelligence.total_liquidity_usd || market.liquidityUsd)
    || 0;
  const sentRaw = String(indicators.sentiment || "").trim();
  const regimeLabel = sentRaw ? sentRaw.toUpperCase() : "—";
  const tapeSent = String(flow || "flat").toUpperCase();
  const tapeBuys = buyCountRecent ?? buyCount;
  const tapeSells = sellCountRecent ?? sellCount;
  return (
    <section className="panel sides-panel flow-panel">
      <div className="ph"><span className="pt">FLOW</span><span className="sd-sym">{market.symbol}</span><span className="pm">TAPE · POOLS · SENT</span></div>
      {coverage ? <p className="pm"><span className="chip">{coverageChipLabel(coverage)}</span></p> : null}
      <div className="flow-columns">
        <FeatureSection id="flow" className="tape-col">
          <h3>TAPE</h3>
          {tape.length
            ? tape.map((trade) => (
              <p className={`tape-row ${trade.kind === "buy" ? "up" : "dn"}`} key={trade.txHash || `${trade.time}-${trade.kind}`}>
                <span>{trade.kind === "buy" ? "BUY" : "SELL"}</span>
                <b>{money(trade.volumeUsd, true)}</b>
                <em>{printAge(trade.time)}</em>
              </p>
            ))
            : <p className="empty-copy">No pool prints in this window.</p>}
        </FeatureSection>
        <FeatureSection id="pools" className="pools-col">
          <h3>POOLS</h3>
          {pools.length
            ? pools.map((pool, index) => {
              const liq = Number(pool.liquidity_usd) || 0;
              const width = maxLiq > 0 ? (liq / maxLiq) * 100 : 0;
              const label = clean(pool.protocol || pool.dex || pool.name);
              return (
                <div className="pool-row" key={String(pool.pool_address || pool.name || index)}>
                  <div><span>{label}</span><b>{compact(liq)}</b></div>
                  <i className="pool-bar"><i style={{ width: `${width}%` }} /></i>
                </div>
              );
            })
            : <p className="empty-copy">No pool breakdown.</p>}
        </FeatureSection>
      </div>
      <p className="flow-footer">
        FLOW <b className={flowTone(flow)}>{String(flow || "flat").toUpperCase()}</b>
        {" · "}TAPE B{tapeBuys}/S{tapeSells}
        {" · "}LIQ {compact(totalLiq)}
        {" · "}SENT <b className={flowTone(tapeSent)}>{tapeSent}</b>
        {" · "}REGIME <b className={flowTone(regimeLabel)}>{regimeLabel}</b>
      </p>
      <p className="method-note">Tape is Gecko pool prints (last ~300), not a full-day reconstruction. Pool liquidity is cancellable/movable and should not be treated as guaranteed execution depth.</p>
    </section>
  );
}

export function ResearchPanel({ market }: { market: OnchainMarket }) {
  const provider = record(market.provider);
  const intelligence = record(provider.intelligence_market);
  const newsPayload = record(provider.news);
  const news = rows(provider.news, ["articles", "news", "items"]);
  const newsError = newsPayload.error ? clean(newsPayload.error) : "";
  return (
    <section className="panel research-panel">
      <div className="ph"><span className="pt">NEWS · RESEARCH</span><span className="pm">MATERIAL · SOURCED</span></div>
      <div className="panel-scroll">
        {news.slice(0, 8).map((item, index) => <article className="news-row" key={String(item.id || item.url || index)}><b>{clean(item.title || item.headline)}</b><p>{clean(item.summary || item.description)}</p></article>)}
        {!news.length && (
          <>
            <article className="narrative"><b>CLAWPUMP NARRATIVE</b><p>{clean(intelligence.narratives || "No narrative returned.")}</p><small>{Array.isArray(intelligence.narrative_tags) ? intelligence.narrative_tags.join(" · ") : "SOLANA"}</small></article>
            <p className="empty-copy">News feed unconfigured{newsError ? ` · ${newsError}` : ""}.</p>
          </>
        )}
      </div>
    </section>
  );
}

export function ToolHealth({ market }: { market: OnchainMarket }) {
  const provider = record(market.provider);
  const tools = ["token_search", "get_indicators", "intelligence_market", "intelligence_signals", "top_movers", "anomalies", "macro", "arbitrage"];
  for (const extra of ["trenches", "holders"]) {
    if (extra in provider) tools.push(extra);
  }
  return <div className="tool-health">{tools.map((name) => <span key={name} className={record(provider[name]).error ? "bad" : "good"}>{name.replace("intelligence_", "intel/").replace("get_", "")}</span>)}</div>;
}

export function venueSpreadHint(pairPrice: unknown, intelPrice: unknown, impliedRate: unknown, arbUsd: unknown) {
  const price = Number(pairPrice);
  const intel = Number(intelPrice);
  if (!Number.isFinite(price) || !Number.isFinite(intel) || intel === 0) return "";
  const vsIntel = ((price - intel) / intel) * 10_000;
  const implied = Number(impliedRate);
  const output = Number(arbUsd);
  const arbRef = Number.isFinite(output) && output > 0
    ? output
    : Number.isFinite(implied) && implied > 0
      ? (Math.abs(implied - intel) / intel < 0.5 ? implied : 1 / implied)
      : null;
  const vsArb = arbRef && arbRef > 0 ? ((price - arbRef) / arbRef) * 10_000 : null;
  const bps = Math.abs(vsIntel) >= 1 ? vsIntel : (vsArb ?? 0);
  if (!Number.isFinite(bps) || Math.abs(bps) < 1) return "";
  return `${bps >= 0 ? "+" : ""}${bps.toFixed(0)}bp`;
}

