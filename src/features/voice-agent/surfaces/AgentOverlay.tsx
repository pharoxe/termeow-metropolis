import { lazy, Suspense, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { useAgent } from "../context/AgentProvider";
import { useAgentStore } from "../store/agentStore";
import { AgentApproval } from "./AgentApproval";

const AgentVisual = lazy(() => import("../visual/AgentVisual"));

const statusCopy: Record<string, string> = {
  dormant: "READY WHEN YOU ARE", connecting: "LINKING VOICE", idle: "READY", listening: "LISTENING", thinking: "THINKING",
  speaking: "TERMEOW SPEAKING", executing: "RUNNING TOOL", success: "COMPLETE", warning: "CHECK SIGNAL", error: "VOICE OFFLINE"
};

export function AgentOverlayHost() {
  const agent = useAgent();
  const mode = useAgentStore((state) => state.overlayMode);
  const muted = useAgentStore((state) => state.muted);
  const error = useAgentStore((state) => state.error);
  const transcript = useAgentStore((state) => state.transcript);
  const conversationId = useAgentStore((state) => state.conversationId);
  const [text, setText] = useState("");
  if (typeof document === "undefined") return null;

  return createPortal(<AnimatePresence>
    {mode !== "hidden" && <motion.aside
      className={`termeow-agent ${mode} status-${agent.status}`}
      role="dialog"
      aria-label="Termeow voice agent"
      initial={{ opacity: 0, scale: .82, y: 22 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: .82, y: 22 }}
      transition={{ type: "spring", stiffness: 520, damping: 36 }}
    >
      {mode === "orb" ? <button type="button" className="agent-orb" aria-label="Open Termeow voice agent" onClick={() => agent.open("compact")}>
        <span className="agent-pixel-fallback" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        <span className="agent-orb-state">{agent.status === "speaking" ? "OUT" : "IN"}</span>
      </button> : <>
        <header className="agent-head">
          <div><span className="agent-kicker">TERMEOW // VOICE COPILOT</span><strong>{statusCopy[agent.status]}</strong></div>
          <nav><button type="button" title="Minimize" onClick={() => agent.open("orb")}>_</button><button type="button" title={mode === "expanded" ? "Compact" : "Expand"} onClick={() => agent.open(mode === "expanded" ? "compact" : "expanded")}>{mode === "expanded" ? "↙" : "↗"}</button><button type="button" title="Close" onClick={agent.close}>×</button></nav>
        </header>
        <div className="agent-visual-stage" aria-label={`${statusCopy[agent.status]} audio visualization`}>
          <div className="agent-scanlines" aria-hidden="true" />
          <Suspense fallback={<span className="agent-pixel-fallback large" aria-hidden="true"><i /><i /><i /><i /><i /></span>}>
            <AgentVisual status={agent.status} quality={matchMedia("(max-width: 700px)").matches ? "low" : "normal"} />
          </Suspense>
          <span className="agent-state-label"><i /> {statusCopy[agent.status]}</span>
        </div>
        <div className="agent-transcript" aria-live="polite">
          {transcript.length ? transcript.slice(mode === "expanded" ? -8 : -2).map((message) => <p key={message.id} className={message.role}><b>{message.role === "agent" ? "TM" : "YOU"}</b><span>{message.text}</span></p>) : <p className="system"><b>SYS</b><span>Ask about the selected token, portfolio, or market setup.</span></p>}
          {error && <p className="error"><b>ERR</b><span>{error}</span></p>}
        </div>
        <form className="agent-text-entry" onSubmit={(event) => { event.preventDefault(); if (!text.trim() || !conversationId) return; agent.send(text.trim()); setText(""); }}>
          <input value={text} disabled={!conversationId} onChange={(event) => setText(event.target.value)} placeholder={conversationId ? "TYPE A FOLLOW-UP" : "START VOICE TO CHAT"} aria-label="Message Termeow" />
          <button disabled={!conversationId || !text.trim()} type="submit">SEND</button>
        </form>
        <footer className="agent-controls">
          {!conversationId ? <button className="agent-start" type="button" onClick={() => void agent.start()} disabled={agent.status === "connecting"}><span className="pixel-mic" aria-hidden="true">▥</span>{agent.status === "connecting" ? "CONNECTING…" : "START VOICE"}</button> : <>
            <button type="button" aria-pressed={muted} onClick={() => agent.setMuted(!muted)}>{muted ? "UNMUTE" : "MUTE"}</button>
            <button className="agent-end" type="button" onClick={agent.stop}>END SESSION</button>
          </>}
          <small>CTRL + .</small>
        </footer>
      </>}
    </motion.aside>}
    <AgentApproval />
  </AnimatePresence>, document.body);
}

export function AgentHeaderButton() {
  const agent = useAgent();
  return <button type="button" className={`agent-header-button status-${agent.status}`} onClick={() => agent.open("compact")} title="Open Termeow voice copilot">
    <span className="agent-button-glyph" aria-hidden="true"><i /><i /><i /></span> ASK TERMEOW
  </button>;
}
