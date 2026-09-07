import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FeatureSection } from "../features/WorkspaceFeatures";
import type { OnchainMarket } from "../types";
import { money, pct } from "../lib/format";
import { mcapScale, rowMarketCap, rowTokenPrice } from "../lib/mcap";
import { coverageChipLabel } from "../lib/flowSeries";
import type { FlowCoverage, MarketResponse, TokenFlowResponse } from "../../shared/wire";
import type { TapeRow } from "../lib/instrument";
import { biasTone, feedHealthChips, tapeEmptyCopy } from "../lib/deskFlow";
import { isDiscoverTab } from "../lib/discover";
import { useFundingNetwork } from "../features/NetworkContext";
import { DiscoverTab } from "./DiscoverTab";
import type { InstrumentRef } from "../lib/address";
import { FlowSideOutputs } from "./FlowSideOutputs";
import { AlertsTab } from "./AlertsTab";
import { FomoBoardTab } from "./FomoBoardTab";
import { LaunchesTab } from "./LaunchesTab";
import { useNotifications } from "./NotificationSystem";

type Row = Record<string, unknown>;
type WatchTab = "TRENDING" | "BIGGEST MOVERS" | "SMART HOLDERS" | "NEW" | "LAUNCHES" | "FOMO" | "ALERTS";
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
  const headlineCap = mcapScale(market).mcap;
  return (
    <div className="ticker-tape">
      <div className="ticker-inner">
        <span><b>{market.symbol}</b> <strong className={headlineCap != null ? "mcap-value" : undefined}>{money(headlineCap ?? market.priceUsd, true)}</strong> <i className={changeClass(market.change24hPct)}>{pct(market.change24hPct)}</i></span>
        {movers.map((item) => {
          const cap = rowMarketCap(item);
          return <span key={String(item.contract || item.symbol)} role="button" onClick={() => { const mint = String(item.contract || ""); if (mint) onPick?.(mint, clean(item.symbol)); }}><b>{clean(item.symbol)}</b> <strong className={cap != null ? "mcap-value" : undefined}>{cap != null ? compact(cap) : money(Number(item.price_usd))}</strong> <i className={changeClass(asChangePct(item.change_24h))}>{pct(asChangePct(item.change_24h))}</i></span>;
        })}
      </div>
    </div>
  );
}

export function WatchPanel({
  market, selected, onSpot, onInstrument, trenches = [], onTrenchSort, search
}: {
  market?: OnchainMarket | null;
  selected?: string;
  onSpot?: (mint: string, symbol?: string) => void;
  /** Opens a token on its own chain (LAUNCHES rows carry Solana mints and Robinhood addresses). */
  onInstrument?: (ref: InstrumentRef, symbol?: string) => void;
  trenches?: Row[];
  onTrenchSort?: (sort: TrenchSort) => void;
  search?: ReactNode;
}) {
  const [tab, setTab] = useState<WatchTab>("TRENDING");
  /** R6: the ROBINHOOD/SOLANA toggle routes the discovery tabs; the ClawPump paths below stay Solana-only. */
  const { network } = useFundingNetwork();
  const robinhoodDiscovery = network === "robinhood" && isDiscoverTab(tab);
  const provider = record(market?.provider);
  const gems = rows(provider.anomalies, ["gems", "signals"]);
  const smartHolderRows = [...rows(provider.intelligence_signals, ["signals"]), ...gems].filter((item, index, all) => {
    const key = String(item.contract || item.mint || item.mintAddress || item.symbol || index);
    return all.findIndex((candidate, candidateIndex) => String(candidate.contract || candidate.mint || candidate.mintAddress || candidate.symbol || candidateIndex) === key) === index;
  });
  const sourceRows = tab === "TRENDING" || tab === "NEW" ? trenches
    : tab === "BIGGEST MOVERS" ? rows(provider.top_movers, ["signals", "movers"])
    : smartHolderRows;
  const selectTab = (next: WatchTab) => {
    setTab(next);
    if (next === "TRENDING") onTrenchSort?.("hot");
    if (next === "NEW") onTrenchSort?.("new");
  };
  const pickSpot = (item: Row) => {
    const mint = String(item.contract || item.mint || item.mintAddress || item.token_address || item.address || "");
    if (mint) onSpot?.(mint, clean(item.symbol || item.name));
  };
  return (
    <section className="panel watch-panel">
      {search}
      <div className="ph">
        <div className="tabs watch-tabs">{(["TRENDING", "BIGGEST MOVERS", "SMART HOLDERS", "NEW", "LAUNCHES", "FOMO", "ALERTS"] as WatchTab[]).map((item) => <button key={item} className={tab === item ? "on" : ""} onClick={() => selectTab(item)}>{item}</button>)}</div>
      </div>
      <div className="panel-scroll">
        {robinhoodDiscovery && isDiscoverTab(tab) ? <DiscoverTab tab={tab} onOpen={onInstrument} selected={selected} /> : tab === "ALERTS" ? <AlertsTab onOpen={onInstrument} selected={selected} /> : tab === "FOMO" ? <FomoBoardTab /> : tab === "LAUNCHES" ? <LaunchesTab onOpen={onInstrument} selected={selected} /> : tab === "TRENDING" || tab === "NEW" ? (
          <table className="terminal-table"><thead><tr><th>TOKEN / SOCIAL</th><th className="r">MCAP / VOL</th></tr></thead><tbody>{sourceRows.slice(0, 48).map((item) => {
            const mint = String(item.mintAddress || "");
            return <tr className={mint && mint === selected ? "selected" : ""} key={mint || String(item.symbol)} onClick={() => pickSpot(item)}>
              <td><b>{clean(item.symbol)}</b><small>{item.isGraduated ? "GRAD" : "BOND"}{item.xVerified ? " · X✓" : ""} {clean(item.agentXUsername || item.xVerifiedHandle || "")}</small></td>
              <td className="r"><b className="mcap-value">{compact(item.marketCap)}</b><small>{compact(item.volume24h)}</small></td>
            </tr>;
          })}</tbody></table>
        ) : (
          <table className="terminal-table signal-table"><thead><tr><th>SYMBOL / SIGNAL</th><th className="r">MCAP</th><th className="r">24H</th></tr></thead><tbody>{sourceRows.slice(0, 24).map((item, index) => {
            const mint = String(item.contract || item.mint || item.mintAddress || "");
            const change = asChangePct(item.change_24h);
            const cap = rowMarketCap(item);
            const px = rowTokenPrice(item);
            return <tr className={mint && mint === selected ? "selected" : ""} key={String(item.contract || item.symbol || index)} onClick={() => pickSpot(item)}><td><b>{clean(item.symbol || item.name)}</b><small>{clean(item.signal || item.name)}{item.chain && String(item.chain) !== "sol" ? ` · ${String(item.chain).toUpperCase()}` : ""}</small></td><td className="r"><b className="mcap-value">{cap != null ? compact(cap) : "—"}</b>{px != null ? <small>{money(px)}</small> : null}</td><td className={`r ${change == null ? "" : changeClass(change)}`}>{change == null ? "—" : pct(change)}</td></tr>;
          })}</tbody></table>
        )}
        {!robinhoodDiscovery && tab !== "LAUNCHES" && tab !== "FOMO" && tab !== "ALERTS" && !sourceRows.length && <p className="empty-copy">No rows returned by this ClawPump feed.</p>}
      </div>
    </section>
  );
}

export function SocialPanel({ market, trench, onPick }: {
  market: OnchainMarket;
  trench?: Row | null;
  onPick?: (mint: string, symbol?: string) => void;
}) {
  const { notify } = useNotifications();
  const provider = record(market.provider);
  const intelligence = record(provider.intelligence_market);
  const signals = rows(provider.intelligence_signals, ["signals"]);
  const twitter = trench ? String(trench.twitter || "") : "";
  const telegram = trench ? String(trench.telegram || "") : "";
  const handle = trench ? clean(trench.xVerifiedHandle || trench.agentXUsername || "") : "";
  const movers = rows(provider.top_movers, ["signals", "movers"]);
  const anomalies = rows(provider.anomalies, ["gems", "signals"]);
  const incomingBubbles = useMemo(() => {
    const bubbleRows: Array<{ id: string; tag: "THESIS" | "TOP TRADER BUY" | "TOP TRADER SELL" | "VOLUME SPIKE"; symbol: string; mint: string; message: string; tone: string; xUrl?: string; xHandle?: string }> = [];
    const narrative = intelligence.narratives ? clean(intelligence.narratives) : "";
    if (narrative && narrative !== "—") {
      const thesisHandle = handle && handle !== "—" ? `@${handle.replace(/^@/, "")}` : undefined;
      const thesisUrl = twitter && twitter !== "null" ? twitter : undefined;
      bubbleRows.push({ id: `thesis-${market.mint}`, tag: "THESIS", symbol: market.symbol, mint: market.mint, message: narrative, tone: "thesis", xUrl: thesisUrl, xHandle: thesisHandle });
    }
    const signalSource = signals.length ? signals : anomalies;
    signalSource.slice(0, 3).forEach((item, index) => {
      const message = clean(item.signal || item.summary || item.reason || item.name);
      const isSell = /sell|bear|exit|distribution/i.test(message);
      const symbol = clean(item.symbol || market.symbol);
      const mint = String(item.contract || item.mint || item.mintAddress || market.mint);
      const rawHandle = clean(item.author_handle || item.handle || item.username || item.x_handle || "");
      const xUrl = String(item.tweet_url || item.twitter_url || item.x_url || "") || undefined;
      bubbleRows.push({ id: `trader-${mint}-${index}`, tag: isSell ? "TOP TRADER SELL" : "TOP TRADER BUY", symbol, mint, message, tone: isSell ? "sell" : "buy", xUrl, xHandle: rawHandle !== "—" ? `@${rawHandle.replace(/^@/, "")}` : undefined });
    });
    movers.slice(0, 3).forEach((item, index) => {
      const symbol = clean(item.symbol || item.name || market.symbol);
      const mint = String(item.contract || item.mint || item.mintAddress || market.mint);
      const volume = Number(item.volume_24h || item.volume24h || item.volume_usd);
      const change = asChangePct(item.change_24h);
      bubbleRows.push({ id: `volume-${mint}-${index}`, tag: "VOLUME SPIKE", symbol, mint, message: `${symbol} activity accelerated${Number.isFinite(volume) ? ` to ${money(volume, true)} volume` : " across the live tape"}${change == null ? "." : ` with ${pct(change)} momentum.`}`, tone: "volume" });
    });
    return bubbleRows.slice(0, 8);
  }, [anomalies, handle, intelligence.narratives, market.mint, market.symbol, movers, signals, twitter]);
  const bubbleSignature = incomingBubbles.map((bubble) => bubble.id).join("|");
  const [bubbles, setBubbles] = useState(incomingBubbles);
  useEffect(() => {
    setBubbles((current) => [...incomingBubbles, ...current.filter((old) => !incomingBubbles.some((fresh) => fresh.id === old.id))].slice(0, 8));
  }, [bubbleSignature]);
  return (
    <section className="panel radar-panel social-panel">
      <div className="panel-scroll">
        {!bubbles.length && <p className="empty-copy">No ClawPump signals, narrative, or movers returned for {market.symbol}.</p>}
        <div className="social-bubble-flow">
          <AnimatePresence initial={false} mode="popLayout">
            {bubbles.map((bubble, index) => <motion.article
              layout
              key={bubble.id}
              className={`social-bubble ${bubble.tone}`}
              initial={{ opacity: 0, scale: 0.65, y: 18 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.75, y: -14 }}
              transition={{ type: "spring", stiffness: 430, damping: 24, delay: index * 0.025 }}
            >
              <div className="social-bubble-top"><span>{bubble.tag}</span>{bubble.xUrl && bubble.xHandle ? <a href={bubble.xUrl} target="_blank" rel="noreferrer" aria-label={`Open ${bubble.xHandle} on X`} onClick={(event) => event.stopPropagation()}><svg viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true"><path d="M0 0h3v2h1v2h2V2h1V0h3L7 5l5 7H9L6 7.5 3 12H0l4.5-7z" /></svg>{bubble.xHandle}</a> : null}</div>
              <button type="button" className="social-bubble-chart" onClick={() => {
                  onPick?.(bubble.mint, bubble.symbol);
                  notify({ title: `${bubble.tag} · ${bubble.symbol}`, message: "Chart and trading context are loading for this signal.", tone: bubble.tone === "sell" ? "warning" : "info" });
                }}><b>${bubble.symbol}</b><p>{bubble.message}</p><em>OPEN CHART →</em></button>
            </motion.article>)}
          </AnimatePresence>
        </div>
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

export function BothSidesPanel({
  market,
  tape = [],
  coverage,
  tokenFlow
}: {
  market: OnchainMarket;
  tape?: TapeRow[];
  coverage?: FlowCoverage;
  /** Tier A ledger flow; the footer's bias and counts are its rolling 1h window, em-dashes until the poll has windows. */
  tokenFlow?: TokenFlowResponse | null;
}) {
  const provider = record(market.provider);
  const intelligence = record(provider.intelligence_market);
  const indicators = record(provider.get_indicators);
  const pools = rows(intelligence, ["top_pools"]).slice().sort((a, b) => (Number(b.liquidity_usd) || 0) - (Number(a.liquidity_usd) || 0));
  const liqs = pools.map((pool) => Number(pool.liquidity_usd) || 0);
  const maxLiq = Math.max(0, ...liqs);
  const totalLiq = liqs.reduce((sum, value) => sum + value, 0)
    || Number(intelligence.total_liquidity_usd || market.liquidityUsd)
    || 0;
  const sentRaw = String(indicators.sentiment || "").trim();
  const regimeLabel = sentRaw ? sentRaw.toUpperCase() : "—";
  const hour = tokenFlow?.windows?.find((window) => window.label === "1h") ?? null;
  const flowLabel = hour ? (hour.net > 0 ? "BUY" : hour.net < 0 ? "SELL" : "FLAT") : "—";
  const healthChips = feedHealthChips(tokenFlow?.feedHealth, Date.now());
  return (
    <section className="panel sides-panel flow-panel research-panel">
      <div className="ph"><span className="pt">FLOW</span><span className="sd-sym">{market.symbol}</span><span className="pm">TAPE · POOLS · SENT</span></div>
      {coverage || tokenFlow?.stale || healthChips.length ? <p className="pm flow-health">
        {coverage ? <span className="chip">{coverageChipLabel(coverage)}</span> : null}
        {tokenFlow?.stale ? <span className="chip warn" title={tokenFlow.error ? `last-good ring · ${tokenFlow.error}` : "last-good ring · no print source is currently ok"}>STALE</span> : null}
        {healthChips.map((chip) => <span key={chip.key} className={`chip ${chip.tone}`} title={chip.title}>{chip.label}</span>)}
      </p> : null}
      <FlowSideOutputs flow={tokenFlow ?? null} />
      <div className="flow-columns">
        <FeatureSection id="flow" className="tape-col">
          <h3>TYPE</h3>
          {tape.length
            ? tape.map((row) => (
              <p className={`tape-row ${row.side === "buy" ? "up" : "dn"}`} key={row.key}>
                <span>{row.side === "buy" ? "BUY" : "SELL"}</span>
                <b>{money(row.usd, true)}</b>
                <em>{printAge(row.time)}</em>
              </p>
            ))
            : <p className="empty-copy">{tapeEmptyCopy(tokenFlow)}</p>}
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
        FLOW 1H <b className={biasTone(flowLabel)}>{flowLabel}</b>
        {" · "}1H B{hour ? hour.buys : "—"}/S{hour ? hour.sells : "—"}
        {" · "}LIQ {compact(totalLiq)}
        {" · "}REGIME <b className={biasTone(regimeLabel)}>{regimeLabel}</b>
      </p>
    </section>
  );
}

/** Project facts for either chain. ClawPump narrative and news are Solana-only; Robinhood shows only what DexScreener returned. */
export function ResearchPanel({ market }: { market: MarketResponse }) {
  const solana = market.instrument.chain === "solana";
  const provider = record(market.provider);
  const intelligence = record(provider.intelligence_market);
  const newsPayload = record(provider.news);
  const news = solana ? rows(provider.news, ["articles", "news", "items"]) : [];
  const newsError = newsPayload.error ? clean(newsPayload.error) : "";
  return (
    <section className="panel project-info-panel">
      <div className="ph"><span className="pt">PROJECT INFORMATION</span><span className="pm">{solana ? "CLAWPUMP · SOURCED" : "DEXSCREENER"}</span></div>
      <div className="panel-scroll">
        <div className="project-facts">
          <div><small>PROJECT</small><strong>{market.instrument.name}</strong></div>
          <div><small>TICKER</small><strong>${market.instrument.symbol}</strong></div>
          <div><small>MARKET CAP</small><strong className="mcap-value">{money(market.marketCapUsd ?? market.fdvUsd, true)}</strong></div>
          <div><small>LIQUIDITY</small><strong>{money(market.liquidityUsd, true)}</strong></div>
          <div><small>24H VOLUME</small><strong>{money(market.volume24Usd, true)}</strong></div>
          <div><small>PRIMARY VENUE</small><strong>{market.primaryPair?.dex || market.source}</strong></div>
        </div>
        <p className="project-contract" title={market.instrument.address}><span>CONTRACT</span><b>{market.instrument.address}</b></p>
        {news.slice(0, 8).map((item, index) => <article className="news-row" key={String(item.id || item.url || index)}><b>{clean(item.title || item.headline)}</b><p>{clean(item.summary || item.description)}</p></article>)}
        {solana && !news.length && (
          <>
            <article className="narrative"><b>CLAWPUMP NARRATIVE</b><p className="project-description">{clean(intelligence.narratives || "No narrative returned.")}</p><small>{Array.isArray(intelligence.narrative_tags) ? intelligence.narrative_tags.join(" · ") : "SOLANA"}</small></article>
            <p className="empty-copy">News feed unconfigured{newsError ? ` · ${newsError}` : ""}.</p>
          </>
        )}
        {!solana && <p className="empty-copy">Narrative, news, and holder intel are Solana-only (ClawPump). Nothing is inferred for Robinhood.</p>}
      </div>
    </section>
  );
}

