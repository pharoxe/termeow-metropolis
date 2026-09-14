import { getAccessToken, usePrivy, useWallets as useEvmWallets } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { AnimatePresence, motion, useDragControls } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import type { AutomationRecord } from "../../shared/automation";
import { api } from "../api/client";
import { AuthControls } from "../auth/AuthControls";
import { hasPrivy } from "../auth/WalletProviders";
import { AsciiPersona } from "../features/standalone-agent/AsciiPersona";
import { AgentDock, type AgentDockView } from "../features/standalone-agent/AgentDock";
import { AgentVolumeSlider } from "../features/standalone-agent/AgentVolumeSlider";
import { AgentCredits } from "../features/standalone-agent/AgentCredits";
import { AgentSignalRail } from "../features/standalone-agent/AgentSignalRail";
import { HandlePicker } from "../features/standalone-agent/HandlePicker";
import { MarketHud } from "../features/standalone-agent/MarketHud";
import { OrderFlowHud } from "../features/standalone-agent/OrderFlowHud";
import { TokenPicker } from "../features/standalone-agent/TokenPicker";
import { TokenLogo } from "../features/standalone-agent/TokenLogo";
import { useAgent } from "../features/voice-agent/context/AgentProvider";
import { useAgentStore } from "../features/voice-agent/store/agentStore";
import { AgentApproval } from "../features/voice-agent/surfaces/AgentApproval";
import type { PublicConfig } from "../types";
import { AGENT_GREETINGS } from "../lib/agentMemory";
import "../components/agent-standalone.css";

type View = AgentDockView;

const promptSuggestions = ["Pull up the $ANSEM chart", "Set up an automated trade", "Teach me to trade better"];

const statusCopy: Record<string, string> = {
  dormant: "CHANNEL CLOSED", connecting: "TUNING CHANNEL", idle: "ONLINE", listening: "I'M LISTENING",
  thinking: "READING THE TAPE", speaking: "TERMEOW LIVE", executing: "EXECUTING", success: "DONE",
  warning: "CHECK THIS", error: "SIGNAL LOST"
};

type AutomationData = { records: AutomationRecord[]; error: string; loading: boolean };

function AutomationDataBridge({ onData }: { onData: (data: AutomationData) => void }) {
  const { authenticated } = usePrivy();
  useEffect(() => {
    if (!authenticated) { onData({ records: [], error: "", loading: false }); return; }
    let live = true;
    const load = async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        const result = await api.automations(token);
        if (live) onData({ records: result.automations, error: "", loading: false });
      } catch (reason) { if (live) onData({ records: [], error: reason instanceof Error ? reason.message : String(reason), loading: false }); }
    };
    onData({ records: [], error: "", loading: true });
    void load();
    const timer = setInterval(load, 20_000);
    addEventListener("termeow:automation-approved", load);
    return () => { live = false; clearInterval(timer); removeEventListener("termeow:automation-approved", load); };
  }, [authenticated, onData]);
  return null;
}

function AutomationList({ data }: { data: AutomationData }) {
  const { authenticated } = usePrivy();
  const [selected, setSelected] = useState<AutomationRecord | null>(null);
  if (!authenticated) return <p className="agent-empty">Log in to arm and review your rules.</p>;
  const { records, error, loading } = data;
  if (loading) return <p className="agent-empty">SYNCING RULES…</p>;
  if (error) return <p className="agent-empty danger">{error}</p>;
  if (!records.length) return <p className="agent-empty">No live rules yet. Ask me to watch a wallet or market setup.</p>;
  const detail = <AnimatePresence>{selected ? <motion.div className="automation-detail-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <motion.section className="automation-detail" role="dialog" aria-modal="true" aria-label="Automation details" initial={{ opacity: 0, scale: .88, y: 24 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .92, y: 14 }}>
      <header><span>AUTOMATION // {selected.status.replaceAll("_", " ")}</span><button type="button" onClick={() => setSelected(null)}>×</button></header>
      <strong>{selected.intent.tokenSymbol ? `$${selected.intent.tokenSymbol}` : selected.intent.kind.replaceAll("_", " ")}</strong><p>{selected.intent.description}</p>
      <dl><div><dt>CHAIN</dt><dd>{selected.intent.chain}</dd></div><div><dt>SIDE / SIZE</dt><dd>{selected.intent.side || "WATCH"} · {selected.intent.allocationPercent ?? "—"}%</dd></div><div><dt>SLIPPAGE</dt><dd>{selected.intent.slippageBps ?? "—"} BPS</dd></div><div><dt>DURATION</dt><dd>{selected.intent.durationHours ? `${selected.intent.durationHours}H` : "NO EXPIRY"}</dd></div></dl>
      <h4>WHEN</h4><p>{selected.intent.condition || "Execute immediately after approval."}</p>
      {selected.intent.exitConditions?.length ? <><h4>AFTER ENTRY</h4>{selected.intent.exitConditions.map((exit) => <p key={exit.id}>SELL {exit.sellPercent}% · {exit.condition}</p>)}</> : null}
      <small>CREATED {new Date(selected.createdAt).toLocaleString()}</small>
    </motion.section>
  </motion.div> : null}</AnimatePresence>;
  return <><div className="standalone-rule-list">{records.slice(0, 8).map((record) => <button className="standalone-rule-card" type="button" key={record.id} onClick={() => setSelected(record)}>
    <span className={`rule-state ${record.status}`}>{record.status.replaceAll("_", " ")}</span>
    <div className="rule-token"><TokenLogo symbol={record.intent.tokenSymbol} src={record.intent.tokenLogoUrl} /><strong>{record.intent.tokenSymbol ? `$${record.intent.tokenSymbol}` : record.intent.kind.replaceAll("_", " ")}</strong></div>
    <p>{record.intent.description}</p>
    <small>{record.intent.chain} · {record.intent.durationHours ? `${record.intent.durationHours}H` : "NO EXPIRY"} · EXPAND ↗</small>
  </button>)}</div>{createPortal(detail, document.body)}</>;
}

function AutomationSurface({ data }: { data: AutomationData }) {
  return hasPrivy ? <AutomationList data={data} /> : <p className="agent-empty">Privy is not configured in this build.</p>;
}

function PrivyPortfolio() {
  const { authenticated } = usePrivy();
  const { wallets: evmWallets } = useEvmWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  const [rows, setRows] = useState<Array<{ chain: string; symbol: string; imageUrl?: string | null; amount: number; value: number | null }>>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!authenticated) { setRows([]); return; }
    let live = true;
    const requests = [
      solanaWallets[0]?.address ? api.portfolio(solanaWallets[0].address).then((portfolio) => ({ chain: "SOL", portfolio })) : null,
      evmWallets[0]?.address ? api.robinhoodPortfolio(evmWallets[0].address).then((portfolio) => ({ chain: "RH", portfolio })) : null
    ].filter(Boolean) as Array<Promise<{ chain: string; portfolio: Awaited<ReturnType<typeof api.portfolio>> }>>;
    Promise.allSettled(requests).then((results) => {
      if (!live) return;
      const fulfilled = results.filter((item): item is PromiseFulfilledResult<{ chain: string; portfolio: Awaited<ReturnType<typeof api.portfolio>> }> => item.status === "fulfilled");
      setRows(fulfilled.flatMap(({ value }) => value.portfolio.assets.map((asset) => ({ chain: value.chain, symbol: asset.symbol, imageUrl: asset.imageUrl, amount: asset.amount, value: asset.valueUsd }))));
      setError(!fulfilled.length && requests.length ? "Portfolio data is temporarily unavailable." : "");
    });
    return () => { live = false; };
  }, [authenticated, evmWallets[0]?.address, solanaWallets[0]?.address]);
  if (!authenticated) return <div className="agent-portfolio"><strong>$0.00</strong><small>CONNECTED WALLET VALUE</small><p className="agent-empty">Log in to inspect your connected wallets.</p></div>;
  if (error) return <p className="agent-empty danger">{error}</p>;
  const total = rows.reduce((sum, row) => sum + (row.value || 0), 0);
  const funded = rows.filter((row) => row.amount > 0 || (row.value ?? 0) > 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return <div className="agent-portfolio"><strong>${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong><small>CONNECTED WALLET VALUE</small>
    <div className="agent-portfolio-actions"><Link to="/onchain?view=portfolio">MANAGE</Link><button type="button" onClick={() => window.dispatchEvent(new CustomEvent("termeow:add-funds"))}>ADD FUNDS</button></div>
    {funded.slice(0, 5).map((row, index) => <article key={`${row.chain}:${row.symbol}:${index}`}><TokenLogo symbol={row.symbol} src={row.imageUrl} /><b>{row.symbol}</b><span>{row.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span><em>{row.value == null ? "—" : `$${row.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}</em></article>)}
    {!funded.length ? <p className="agent-empty">Wallet connected · no funded assets yet.</p> : null}{funded.length > 5 ? <Link className="agent-portfolio-expand" to="/onchain?view=portfolio">VIEW ALL {funded.length} ASSETS →</Link> : null}
  </div>;
}

function PortfolioSurface() {
  return hasPrivy ? <PrivyPortfolio /> : <p className="agent-empty">Privy is not configured in this build.</p>;
}

function PrivyVoiceStart() {
  const { authenticated, login, ready } = usePrivy();
  const agent = useAgent();
  const connecting = agent.status === "connecting";
  return <button className="voice-main" type="button" disabled={!ready || connecting} onClick={() => authenticated ? void agent.start() : login()}>
    <span>◉</span>{connecting ? "TUNING…" : authenticated ? "TALK TO TERMEOW" : "LOG IN TO TALK"}
  </button>;
}

function VoiceStart() {
  const agent = useAgent();
  return hasPrivy ? <PrivyVoiceStart /> : <button className="voice-main" type="button" disabled={agent.status === "connecting"} onClick={() => void agent.start()}>
    <span>◉</span>{agent.status === "connecting" ? "TUNING…" : "TALK TO TERMEOW"}
  </button>;
}

export function AgentPage({ config }: { config: PublicConfig }) {
  const agent = useAgent();
  const transcript = useAgentStore((state) => state.transcript);
  const toolActivity = useAgentStore((state) => state.toolActivity);
  const conversationId = useAgentStore((state) => state.conversationId);
  const muted = useAgentStore((state) => state.muted);
  const pending = useAgentStore((state) => state.pendingApproval);
  const voiceError = useAgentStore((state) => state.error);
  const leftWidget = useAgentStore((state) => state.leftWidget);
  const setLeftWidget = useAgentStore((state) => state.setLeftWidget);
  const [view, setView] = useState<View>("ask");
  const desktopRef = useRef<HTMLElement>(null);
  const leftWidgetDrag = useDragControls();
  const [text, setText] = useState("");
  const [automationCount, setAutomationCount] = useState(0);
  const [automationData, setAutomationData] = useState<AutomationData>({ records: [], error: "", loading: false });
  const receiveAutomationData = useCallback((data: AutomationData) => {
    setAutomationData(data);
    if (!data.loading) setAutomationCount(data.records.length);
  }, []);
  const [idleGreeting] = useState(() => AGENT_GREETINGS[Math.floor(Math.random() * AGENT_GREETINGS.length)]);
  const latest = useMemo(() => transcript.slice(-5), [transcript]);

  useEffect(() => {
    document.body.classList.add("standalone-agent-body");
    agent.open("surface");
    return () => { document.body.classList.remove("standalone-agent-body"); agent.close(); };
  }, []); // The standalone route owns this hidden runtime surface.

  useEffect(() => {
    if (!useAgentStore.getState().leftWidget) setLeftWidget({ type: "portfolio" });
  }, [setLeftWidget]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim() || !conversationId) return;
    agent.send(text.trim());
    setText("");
  };

  return <main className={`agent-app status-${agent.status}`} ref={desktopRef}>
    {hasPrivy ? <AutomationDataBridge onData={receiveAutomationData} /> : null}
    <div className="agent-crt" aria-hidden="true" />
    <header className="standalone-head">
      <Link className="standalone-brand" to="/agent"><span>TERMEOW</span><small>VOICE OS / 0.1</small></Link>
      <div className="agent-network"><i /> {config.network.toUpperCase()} INTELLIGENCE ONLINE</div>
      <div className="agent-head-actions"><AgentCredits /><Link to="/onchain">OPEN TERMINAL ↗</Link><AuthControls /></div>
    </header>

    <AgentSignalRail />
    <MarketHud />
    <OrderFlowHud />

    <section className="agent-command-deck">
      <div className="agent-left-widget-anchor">
        <AnimatePresence>{leftWidget ? <motion.section className={`agent-left-widget agent-left-widget-${leftWidget.type}`} initial={{ opacity: 0, x: -28, scale: .86 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: -18, scale: .92 }} transition={{ type: "spring", stiffness: 290, damping: 28 }} drag dragControls={leftWidgetDrag} dragListener={false} dragConstraints={desktopRef} dragMomentum={false} dragElastic={0.04} whileDrag={{ scale: 1.01 }}>
          <header className="desktop-window-handle" onPointerDown={(event) => leftWidgetDrag.start(event)}><span>{leftWidget.type === "automations" ? "AUTOMATION CONTROL" : leftWidget.type === "portfolio" ? "CONNECTED PORTFOLIO" : leftWidget.type === "tokens" ? "CHOOSE AN INDEXED TOKEN" : "CHOOSE A TRACKED HANDLE"}</span><small>MOVE · RESIZE ↘</small><button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => { setLeftWidget(); if (view === "automations") setView("ask"); }}>×</button></header>
          {leftWidget.type === "automations" ? <AutomationSurface data={automationData} /> : leftWidget.type === "portfolio" ? <PortfolioSurface /> : leftWidget.type === "tokens" ? <TokenPicker query={leftWidget.query} onChoose={(token) => { if (conversationId) agent.send(`Use the verified indexed ${token.chain} token $${token.symbol} at ${token.address}.`); setLeftWidget(); }} /> : <HandlePicker initialQuery={leftWidget.query} onChoose={(handle) => { if (conversationId) agent.send(`Use the indexed trader @${handle}.`); setLeftWidget(); }} />}
        </motion.section> : null}</AnimatePresence>
      </div>

      <section className="persona-console">
        <div className="persona-stage">
          <AsciiPersona status={agent.status} />
          <div className="persona-noise" aria-hidden="true" />
          <div className="persona-crt-glass" aria-hidden="true" />
          <span className="persona-timecode">REC {new Date().getFullYear()} / CH.09</span>
          <span className="persona-signal">{statusCopy[agent.status]}</span>
        </div>
        <div className="voice-console">
          <div className="voice-status"><span><i /> {statusCopy[agent.status]}</span><small>{conversationId ? "ENCRYPTED VOICE SESSION" : "MIC ACCESS ON START"}</small></div>
          {agent.status === "error" && voiceError && <p className="agent-voice-error" role="alert">VOICE LINK FAILED · {voiceError}</p>}
          <div className="standalone-transcript" aria-live="polite">
            {latest.length ? latest.map((message) => <p key={message.id} className={message.role}><b>{message.role === "agent" ? "TM" : message.role === "user" ? "YOU" : "SYS"}</b><span>{message.text}</span></p>) : <p className="system"><b>TM</b><span>{idleGreeting}</span></p>}
          </div>
          <div className="agent-prompt-chips" aria-label="Suggested prompts">{promptSuggestions.map((prompt) => <button key={prompt} type="button" onClick={() => conversationId ? agent.send(prompt) : setText(prompt)}>{prompt}</button>)}</div>
          <form onSubmit={submit}>
            <input value={text} onChange={(event) => setText(event.target.value)} disabled={!conversationId} placeholder={conversationId ? "TYPE A FOLLOW-UP…" : "START VOICE TO OPEN THE CHANNEL"} />
            <button type="submit" disabled={!conversationId || !text.trim()}>SEND ↵</button>
          </form>
          <div className="standalone-voice-controls">
            {!conversationId ? <VoiceStart /> : <>
              <button type="button" onClick={() => agent.setMuted(!muted)}>{muted ? "UNMUTE MIC" : "MUTE MIC"}</button>
              <button className="voice-stop" type="button" onClick={agent.stop}>END CHANNEL</button>
            </>}
          </div>
        </div>
      </section>

      <aside className="agent-sideband agent-sideband-right">
        <span>DECISION TRACE</span>
        <strong>{toolActivity.length ? `${toolActivity.length} TOOL CALLS` : "CLEAN SLATE"}</strong>
        <div className="sideband-tools">{toolActivity.slice(-3).reverse().map((event) => <div key={event.id} className={event.status} title={event.summary}><i /> <span>{event.name.replaceAll("_", " ")}</span></div>)}</div>
        <p>Tool evidence and outcomes are shown—not private model chain-of-thought.</p>
        {(agent.status === "thinking" || agent.status === "executing" || agent.status === "connecting" || toolActivity.some((event) => event.status === "running")) ? <div className="pixel-grid-spinner" aria-label="Working"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div> : <div className="sideband-meter"><i /><i /><i /><i /><i /><i /></div>}
      </aside>
    </section>

    <section className={`agent-drawer ${view !== "activity" ? "collapsed" : ""}`}>
      {view === "activity" && <><header><span>SESSION TAPE</span><small>CONVERSATION + TOOL EVIDENCE</small><button type="button" aria-label="Close activity" onClick={() => setView("ask")}>×</button></header><div className="tool-tape"><h3>DECISION TRACE</h3>{toolActivity.length ? toolActivity.slice().reverse().map((event) => <article key={event.id} className={event.status}><time>{new Date(event.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><div><b>{event.name.replaceAll("_", " ")}</b>{event.input && <small>{event.input}</small>}<span>{event.summary || "Working…"}</span></div></article>) : <p className="agent-empty">No tools used in this session.</p>}</div><div className="activity-tape">{transcript.length ? transcript.slice().reverse().map((message) => <p key={message.id}><time>{new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><b>{message.role}</b><span>{message.text}</span></p>) : <p className="agent-empty">No conversation yet.</p>}</div></>}
    </section>

    <AgentDock view={view} automationCount={automationCount} onPortfolio={() => setLeftWidget(leftWidget?.type === "portfolio" ? undefined : { type: "portfolio" })} onSelect={(item) => { setView(item); if (item === "automations") setLeftWidget({ type: "automations" }); else if (leftWidget?.type === "automations") setLeftWidget(); }} />
    <AgentVolumeSlider />

    {pending && <div className="standalone-approval-backdrop" role="presentation"><div className="standalone-approval-modal"><div className="approval-modal-label">ACTION REQUIRES YOU</div><AgentApproval /></div></div>}
  </main>;
}
