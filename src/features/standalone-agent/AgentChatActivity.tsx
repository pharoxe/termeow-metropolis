import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentStatus, AgentToolEvent } from "../voice-agent/runtime/agentTypes";

const activityCopy: Partial<Record<AgentStatus, string>> = {
  connecting: "Opening private channel",
  thinking: "Reading the request",
  executing: "Running onchain tools",
  speaking: "Composing response"
};

function cleanToolName(name: string) {
  return name.replace(/^termeow[_-]?/i, "").replaceAll("_", " ");
}

export function MatrixActivityIcon() {
  return <span className="matrix-activity-icon" aria-hidden="true">
    {Array.from({ length: 16 }, (_, index) => <i key={index} />)}
  </span>;
}

export function AgentChatActivity({ status, events }: { status: AgentStatus; events: AgentToolEvent[] }) {
  const [clock, redraw] = useState(0);
  const visible = useMemo(() => {
    const now = Date.now();
    return events.filter((event) => event.status === "running" || (event.finishedAt != null && now - event.finishedAt < 2400)).slice(-4);
  }, [events, clock]);
  const active = status === "connecting" || status === "thinking" || status === "executing" || status === "speaking" || events.some((event) => event.status === "running");

  useEffect(() => {
    const completed = events.filter((event) => event.finishedAt != null);
    if (!completed.length) return;
    const timer = window.setTimeout(() => redraw((value) => value + 1), 2450);
    return () => window.clearTimeout(timer);
  }, [events]);

  return <AnimatePresence initial={false}>
    {(active || visible.length > 0) && <motion.section className="agent-chat-activity" initial={{ opacity: 0, height: 0, y: -5 }} animate={{ opacity: 1, height: "auto", y: 0 }} exit={{ opacity: 0, height: 0, y: -4 }} transition={{ duration: .24, ease: [.22, .72, .2, 1] }}>
      <div className="agent-activity-state">
        {active ? <MatrixActivityIcon /> : <span className="activity-ready-dot" />}
        <span><b>AGENT ACTIVITY</b><small>{activityCopy[status] || (visible.some((event) => event.status === "failed") ? "A tool needs attention" : "Evidence received")}</small></span>
      </div>
      <div className="agent-tool-capsules" aria-label="Recent tool activity">
        <AnimatePresence mode="popLayout" initial={false}>
          {visible.map((event) => <motion.span layout key={event.id} className={`agent-tool-capsule ${event.status}`} title={event.summary} initial={{ opacity: 0, scale: .76, x: -6 }} animate={{ opacity: event.status === "running" ? 1 : .7, scale: 1, x: 0 }} exit={{ opacity: 0, scale: .82, x: 7 }} transition={{ duration: .16, ease: "easeOut" }}>
            <i />{cleanToolName(event.name)}
          </motion.span>)}
        </AnimatePresence>
      </div>
      <small className="activity-privacy">TOOL STATUS + EVIDENCE · PRIVATE REASONING STAYS PRIVATE</small>
    </motion.section>}
  </AnimatePresence>;
}

export function TypewriterText({ text, animate = false }: { text: string; animate?: boolean }) {
  const [shown, setShown] = useState(animate ? "" : text);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(text); return; }
    const startedAt = performance.now();
    const duration = Math.min(1600, Math.max(260, text.length * 17));
    setShown("");
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const length = Math.max(1, Math.floor(text.length * (1 - Math.pow(1 - progress, 2))));
      setShown(text.slice(0, length));
      if (progress < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => { if (frame.current != null) cancelAnimationFrame(frame.current); };
  }, [animate, text]);

  return <span className={shown.length < text.length ? "typewriter-text typing" : "typewriter-text"}>{shown}</span>;
}
