import { useMemo, useState as useStateSafe, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FeatureSection } from "../features/WorkspaceFeatures";
import type { OnchainMarket } from "../types";
import { money, pct, shortAddress, signedMoney } from "../lib/format";
import { mcapScale } from "../lib/mcap";
import { coverageChipLabel } from "../lib/flowSeries";
import type { DiscoverRow, FlowCoverage, MarketResponse, TokenFlowResponse } from "../../shared/wire";
import { tradeLinks, type TapeRow } from "../lib/instrument";
import { biasTone, feedHealthChips, tapeEmptyCopy } from "../lib/deskFlow";
import { DiscoverTab } from "./DiscoverTab";
import type { InstrumentRef } from "../lib/address";
import { FlowSideOutputs } from "./FlowSideOutputs";
import { SmartBoardTab } from "./SmartBoardTab";
import { SmartMoneyTab } from "./SmartMoneyTab";
import { LaunchesTab } from "./LaunchesTab";
import { LiveAlertBubbles } from "./LiveAlertBubbles";
import { api } from "../api/client";
import { useResource } from "../lib/resource";
import { printAgeLabel } from "../lib/flowPanel";

type WatchTab = "TRENDING" | "NEW" | "LAUNCHES" | "SMART MONEY" | "WALLETS";
const WATCH_TABS: readonly WatchTab[] = ["TRENDING", "NEW", "LAUNCHES", "SMART MONEY", "WALLETS"];

function compact(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? money(number, true) : "—";
}

function changeClass(value: unknown) {
  return Number(value) < 0 ? "dn" : "up";
}

function printAge(time: number) {
  const ms = Math.max(0, Date.now() - time);
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** Scrolling header ticker: the focused token, then the top of the Monad trending list (DexScreener + GeckoTerminal). */
export function MarketStrips({ market, movers = [], onPick }: { market: OnchainMarket; movers?: DiscoverRow[]; onPick?: (ref: InstrumentRef, symbol?: string) => void }) {
  const headlineCap = mcapScale(market).mcap;
  const top = movers.filter((row) => row.token.toLowerCase() !== market.mint.toLowerCase()).slice(0, 10);
  const strip = (duplicate = false) => (
      <div className="ticker-segment" aria-hidden={duplicate || undefined}>
        <span><b>{market.symbol}</b> <strong className={headlineCap != null ? "mcap-value" : undefined}>{money(headlineCap ?? market.priceUsd, true)}</strong> <i className={changeClass(market.change24hPct)}>{pct(market.change24hPct)}</i></span>
        {top.map((row) => <span key={`${duplicate ? "copy-" : ""}${row.token}`} role={duplicate ? undefined : "button"} onClick={duplicate ? undefined : () => onPick?.({ chain: "monad", address: row.token }, row.symbol ?? undefined)}><b>{row.symbol ?? shortAddress(row.token)}</b> <strong className={row.marketCapUsd != null ? "mcap-value" : undefined}>{row.marketCapUsd != null ? compact(row.marketCapUsd) : money(row.priceUsd)}</strong> <i className={changeClass(row.changePct)}>{pct(row.changePct)}</i></span>)}
      </div>
  );
  return (
    <div className="ticker-tape">
      <div className="ticker-inner">
        {strip()}
        {strip(true)}
      </div>
    </div>
  );
}

/** Left discovery column: Monad trending / new lists, nad.fun launches, Nansen smart money, and this server's wallet board. */
export function WatchPanel({ selected, onInstrument, search }: {
  selected?: string;
  activeInstrument?: InstrumentRef;
  onInstrument?: (ref: InstrumentRef, symbol?: string) => void;
  onNewChart?: (ref: InstrumentRef) => void;
  search?: ReactNode;
}) {
  const [tab, setTab] = useStateTab();
  return (
    <section className="panel watch-panel">
      {search}
      <div className="ph">
        <div className="tabs watch-tabs">{WATCH_TABS.map((item) => <button key={item} className={tab === item ? "on" : ""} onClick={() => setTab(item)}>{item}</button>)}</div>
      </div>
      <div className="panel-scroll">
        {tab === "TRENDING" || tab === "NEW" ? <DiscoverTab chain="monad" tab={tab} onOpen={onInstrument} selected={selected} />
          : tab === "LAUNCHES" ? <LaunchesTab onOpen={onInstrument} selected={selected} />
          : tab === "SMART MONEY" ? <SmartMoneyTab onOpen={onInstrument} selected={selected} />
          : <SmartBoardTab chain="monad" />}
      </div>
    </section>
  );
}

const WATCH_TAB_KEY = "termeow-watch-tab";
function useStateTab(): [WatchTab, (tab: WatchTab) => void] {
  const [tab, setTab] = useStateSafe<WatchTab>(() => {
    try {
      const stored = localStorage.getItem(WATCH_TAB_KEY) as WatchTab | null;
      return stored && WATCH_TABS.includes(stored) ? stored : "TRENDING";
    } catch { return "TRENDING"; }
  });
  return [tab, (next) => { setTab(next); try { localStorage.setItem(WATCH_TAB_KEY, next); } catch { /* per-viewer convenience only */ } }];
}

/**
 * Live signal column for the focused token: server alerts (fresh nad.fun launches, smart-money entries, graduations) and
 * the latest Nansen smart-money trades in this token, with the token's net smart-money flow as the headline.
 */
export function SocialPanel({ market, onInstrument }: { market: OnchainMarket; onInstrument?: (ref: InstrumentRef, symbol?: string) => void }) {
  const token = market.mint.toLowerCase();
  const smart = useResource(`smart-money:token:${token}`, () => api.smartMoney(token), 60_000);
  const flows = useResource(`smart-money:flows:${token}`, () => api.smartMoneyFlows(token, "1d"), 300_000);
  const trades = useMemo(() => (smart.data?.trades ?? []).filter((trade) => trade.boughtToken === token || trade.soldToken === token).slice(0, 8), [smart.data, token]);
  const segments = flows.data?.data;
  const now = Date.now();
  const segment = (key: "smart_trader" | "whale" | "top_pnl" | "fresh_wallets", label: string) => {
    const value = segments?.[key]?.netFlowUsd;
    return value == null ? null : <span className={`chip ${value >= 0 ? "good" : "bad"}`} key={key} title={`${segments?.[key]?.wallets ?? "?"} wallets · Nansen flow intelligence, 1d`}>{label} {signedMoney(value)}</span>;
  };
  const chips = [segment("smart_trader", "SMART"), segment("whale", "WHALES"), segment("top_pnl", "TOP PNL"), segment("fresh_wallets", "FRESH")].filter(Boolean);
  return (
    <section className="panel radar-panel social-panel">
      <div className="panel-scroll">
        {chips.length ? <p className="pm flow-health smart-flow-chips">{chips}</p> : null}
        <div className="social-bubble-flow">
          <LiveAlertBubbles onOpen={(instrument, alertSymbol) => onInstrument?.(instrument, alertSymbol)} />
          <AnimatePresence initial={false} mode="popLayout">
            {trades.map((trade, index) => {
              const buy = trade.boughtToken === token;
              return <motion.article
                layout
                key={`${trade.tx}:${trade.trader}`}
                className={`social-bubble ${buy ? "buy" : "sell"}`}
                initial={{ opacity: 0, scale: 0.65, y: 18 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.75, y: -14 }}
                transition={{ type: "spring", stiffness: 430, damping: 24, delay: index * 0.025 }}
              >
                <div className="social-bubble-top"><span>{buy ? "SMART MONEY BUY" : "SMART MONEY SELL"}</span><a href={`https://app.nansen.ai/profiler?chain=monad&address=${trade.trader}`} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{trade.label ?? shortAddress(trade.trader)}</a></div>
                <p className="social-bubble-chart"><b>${market.symbol}</b> {money(trade.valueUsd, true)} · {printAgeLabel(trade.time, now)} ago</p>
              </motion.article>;
            })}
          </AnimatePresence>
        </div>
        {!trades.length && <p className="empty-copy">{smart.data && !smart.data.configured ? "Set NANSEN_API_KEY to stream smart-money trades for this token." : `No Nansen smart-money trades in ${market.symbol} in the last 24h.`}</p>}
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
  const pools = (tokenFlow?.pairs ?? []).slice().sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  const liqs = pools.map((pool) => pool.liquidityUsd ?? 0);
  const maxLiq = Math.max(0, ...liqs);
  const totalLiq = liqs.reduce((sum, value) => sum + value, 0) || market.liquidityUsd || 0;
  const hourWindow = tokenFlow?.windows?.find((window) => window.label === "1h");
  const regimeLabel = hourWindow?.aggressor == null ? "—" : hourWindow.aggressor >= 0.55 ? "BUYERS" : hourWindow.aggressor <= 0.45 ? "SELLERS" : "BALANCED";
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
              const liq = pool.liquidityUsd ?? 0;
              const width = maxLiq > 0 ? (liq / maxLiq) * 100 : 0;
              const label = (pool.dex || "pool").toUpperCase();
              return (
                <div className="pool-row" key={pool.pairAddress || index}>
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

/** Project facts for a Monad token: DexScreener market figures, venue, and link-outs to Kuru, nad.fun and the explorer. */
export function ResearchPanel({ market }: { market: MarketResponse }) {
  const links = tradeLinks(market.instrument.address, market.primaryPair?.pairAddress ?? null);
  const venue = market.primaryPair?.dex || market.source;
  const onCurve = /nad/i.test(venue) || market.primaryPair?.pairAddress?.startsWith("nadfun:");
  return (
    <section className="panel project-info-panel">
      <div className="ph"><span className="pt">PROJECT INFORMATION</span><span className="pm">DEXSCREENER · MONAD</span></div>
      <div className="panel-scroll">
        <div className="project-facts">
          <div><small>PROJECT</small><strong>{market.instrument.name}</strong></div>
          <div><small>TICKER</small><strong>${market.instrument.symbol}</strong></div>
          <div><small>MARKET CAP</small><strong className="mcap-value">{money(market.marketCapUsd ?? market.fdvUsd, true)}</strong></div>
          <div><small>LIQUIDITY</small><strong>{money(market.liquidityUsd, true)}</strong></div>
          <div><small>24H VOLUME</small><strong>{money(market.volume24Usd, true)}</strong></div>
          <div><small>PRIMARY VENUE</small><strong>{venue}</strong></div>
        </div>
        <p className="project-contract" title={market.instrument.address}><span>CONTRACT</span><b>{market.instrument.address}</b></p>
        <div className="project-links">
          <a href={links.kuru} target="_blank" rel="noreferrer">KURU ↗</a>
          <a href={links.nadfun} target="_blank" rel="noreferrer">NAD.FUN ↗</a>
          <a href={links.dexscreener} target="_blank" rel="noreferrer">DEXSCREENER ↗</a>
          <a href={links.explorer} target="_blank" rel="noreferrer">MONADVISION ↗</a>
        </div>
        {onCurve ? <p className="empty-copy">This token is still on its nad.fun bonding curve: liquidity is the curve reserve until it graduates to a DEX pool.</p> : null}
        <p className="empty-copy">Ask the agent for Nansen flow intelligence or Perpl positioning on this token.</p>
      </div>
    </section>
  );
}
