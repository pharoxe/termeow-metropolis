import { getAccessToken, usePrivy } from "@privy-io/react-auth";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { AutomationRecord } from "../../shared/automation";
import { api } from "../api/client";
import { AuthControls } from "../auth/AuthControls";
import { hasPrivy } from "../auth/WalletProviders";
import { AsciiPersona } from "../features/standalone-agent/AsciiPersona";
import { AgentSignalRail } from "../features/standalone-agent/AgentSignalRail";
import { HandlePicker } from "../features/standalone-agent/HandlePicker";
import { MarketHud } from "../features/standalone-agent/MarketHud";
import { OrderFlowHud } from "../features/standalone-agent/OrderFlowHud";
import { useAgent } from "../features/voice-agent/context/AgentProvider";
import { useAgentStore } from "../features/voice-agent/store/agentStore";
import { AgentApproval } from "../features/voice-agent/surfaces/AgentApproval";
import type { PublicConfig } from "../types";
import "../components/agent-standalone.css";

type View = "ask" | "automations" | "activity";

const statusCopy: Record<string, string> = {
  dormant: "CHANNEL CLOSED", connecting: "TUNING CHANNEL", idle: "ONLINE", listening: "I'M LISTENING",
  thinking: "READING THE TAPE", speaking: "TERMEOW LIVE", executing: "EXECUTING", success: "DONE",
  warning: "CHECK THIS", error: "SIGNAL LOST"
};

function AutomationList({ onCount }: { onCount: (count: number) => void }) {
  const { authenticated } = usePrivy();
  const [records, setRecords] = useState<AutomationRecord[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!authenticated) { setRecords([]); onCount(0); return; }
    let live = true;
    const load = async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        const result = await api.automations(token);
        if (live) { setRecords(result.automations); onCount(result.automations.length); setError(""); }
      } catch (reason) { if (live) setError(reason instanceof Error ? reason.message : String(reason)); }
    };
    void load();
    const timer = setInterval(load, 20_000);
    addEventListener("termeow:automation-approved", load);
    return () => { live = false; clearInterval(timer); removeEventListener("termeow:automation-approved", load); };
  }, [authenticated, onCount]);
  if (!authenticated) return <p className="agent-empty">Log in to arm and review your rules.</p>;
  if (error) return <p className="agent-empty danger">{error}</p>;
  if (!records.length) return <p className="agent-empty">No live rules yet. Ask me to watch a wallet or market setup.</p>;
  return <div className="standalone-rule-list">{records.slice(0, 8).map((record) => <article key={record.id}>
    <span className={`rule-state ${record.status}`}>{record.status.replaceAll("_", " ")}</span>
    <strong>{record.intent.tokenSymbol ? `$${record.intent.tokenSymbol}` : record.intent.kind.replaceAll("_", " ")}</strong>
    <p>{record.intent.description}</p>
    <small>{record.intent.chain} · {record.intent.durationHours ? `${record.intent.durationHours}H` : "NO EXPIRY"}</small>
  </article>)}</div>;
}

function AutomationSurface({ onCount }: { onCount: (count: number) => void }) {
  return hasPrivy ? <AutomationList onCount={onCount} /> : <p className="agent-empty">Privy is not configured in this build.</p>;
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
  const leftWidget = useAgentStore((state) => state.leftWidget);
  const setLeftWidget = useAgentStore((state) => state.setLeftWidget);
  const [view, setView] = useState<View>("ask");
  const [text, setText] = useState("");
  const [automationCount, setAutomationCount] = useState(0);
  const latest = useMemo(() => transcript.slice(-5), [transcript]);

  useEffect(() => {
    document.body.classList.add("standalone-agent-body");
    agent.open("surface");
    return () => { document.body.classList.remove("standalone-agent-body"); agent.close(); };
  }, []); // The standalone route owns this hidden runtime surface.

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim() || !conversationId) return;
    agent.send(text.trim());
    setText("");
  };

  return <main className={`agent-app status-${agent.status}`}>
    <div className="agent-crt" aria-hidden="true" />
    <header className="standalone-head">
      <Link className="standalone-brand" to="/agent"><span>TERMEOW</span><small>VOICE OS / 0.1</small></Link>
      <div className="agent-network"><i /> {config.network.toUpperCase()} INTELLIGENCE ONLINE</div>
      <div className="agent-head-actions"><Link to="/onchain">OPEN TERMINAL ↗</Link><AuthControls /></div>
    </header>

    <AgentSignalRail />
    <MarketHud />
    <OrderFlowHud />

    <section className="agent-command-deck">
      <aside className="agent-sideband agent-sideband-left">
        <span>LIVE INPUTS</span>
        <dl><div><dt>VOICE</dt><dd>{conversationId ? "LINKED" : "STANDBY"}</dd></div><div><dt>CHAIN</dt><dd>SOL + RH</dd></div><div><dt>RULES</dt><dd>{automationCount}</dd></div></dl>
        <p>Intent in.<br />Onchain action out.</p>
        <AnimatePresence>{leftWidget ? <motion.section className="agent-left-widget" initial={{ opacity: 0, x: -28, scale: .86 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: -18, scale: .92 }} transition={{ type: "spring", stiffness: 290, damping: 28 }}>
          <header><span>{leftWidget.type === "automations" ? "AUTOMATION CONTROL" : "CHOOSE A TRACKED HANDLE"}</span><button type="button" onClick={() => { setLeftWidget(); if (view === "automations") setView("ask"); }}>×</button></header>
          {leftWidget.type === "automations" ? <AutomationSurface onCount={setAutomationCount} /> : <HandlePicker initialQuery={leftWidget.query} onChoose={(handle) => { if (conversationId) agent.send(`Use the indexed trader @${handle}.`); setLeftWidget(); }} />}
        </motion.section> : null}</AnimatePresence>
      </aside>

      <section className="persona-console">
        <div className="persona-stage">
          <img src="/assets/termeow-persona.webp" alt="Termeow, a cyberpunk cat-eared market operator" />
          <AsciiPersona status={agent.status} />
          <div className="persona-noise" aria-hidden="true" />
          <span className="persona-timecode">REC {new Date().getFullYear()} / CH.09</span>
          <span className="persona-signal">{statusCopy[agent.status]}</span>
        </div>
        <div className="voice-console">
          <div className="voice-status"><span><i /> {statusCopy[agent.status]}</span><small>{conversationId ? "ENCRYPTED VOICE SESSION" : "MIC ACCESS ON START"}</small></div>
          <div className="standalone-transcript" aria-live="polite">
            {latest.length ? latest.map((message) => <p key={message.id} className={message.role}><b>{message.role === "agent" ? "TM" : message.role === "user" ? "YOU" : "SYS"}</b><span>{message.text}</span></p>) : <p className="system"><b>TM</b><span>What are we hunting tonight?</span></p>}
          </div>
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
      {view === "activity" && <><header><span>SESSION TAPE</span><small>CONVERSATION + TOOL EVIDENCE</small></header><div className="tool-tape"><h3>DECISION TRACE</h3>{toolActivity.length ? toolActivity.slice().reverse().map((event) => <article key={event.id} className={event.status}><time>{new Date(event.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><div><b>{event.name.replaceAll("_", " ")}</b>{event.input && <small>{event.input}</small>}<span>{event.summary || "Working…"}</span></div></article>) : <p className="agent-empty">No tools used in this session.</p>}</div><div className="activity-tape">{transcript.length ? transcript.slice().reverse().map((message) => <p key={message.id}><time>{new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><b>{message.role}</b><span>{message.text}</span></p>) : <p className="agent-empty">No conversation yet.</p>}</div></>}
    </section>

    <nav className="agent-bottom-nav" aria-label="Agent views">
      {(["ask", "automations", "activity"] as View[]).map((item) => <button key={item} className={view === item ? "active" : ""} onClick={() => { setView(item); if (item === "automations") setLeftWidget({ type: "automations" }); else if (leftWidget?.type === "automations") setLeftWidget(); }}><i>{item === "ask" ? "◉" : item === "automations" ? "⌁" : "≋"}</i>{item.toUpperCase()}{item === "automations" && automationCount > 0 ? <b>{automationCount}</b> : null}</button>)}
      <Link to="/onchain"><i>⌗</i>TERMINAL</Link>
    </nav>

    {pending && <div className="standalone-approval-backdrop" role="presentation"><div className="standalone-approval-modal"><div className="approval-modal-label">ACTION REQUIRES YOU</div><AgentApproval /></div></div>}
  </main>;
}
