import { AnimatePresence, motion, useMotionValue, useSpring, useTransform, type MotionValue } from "motion/react";
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

export type AgentDockView = "ask" | "automations" | "activity";

function DockIcon({ name }: { name: AgentDockView | "terminal" | "portfolio" }) {
  if (name === "ask") return <svg viewBox="0 0 24 24"><path d="M4 20V9l3-6 5 4 5-4 3 6v11H4Z" /><path d="M8 13h.01M16 13h.01M9 17q3 3 6 0" /></svg>;
  if (name === "automations") return <svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="13" rx="2" /><path d="M12 3v4m-2-4h4M7 12h2m6 0h2M8 17h8M2 11v5m20-5v5" /></svg>;
  if (name === "activity") return <svg viewBox="0 0 24 24"><path d="M3 13h4l2-7 4 13 2-6h6" /></svg>;
  if (name === "portfolio") return <svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V4h8v3M3 12h18m-10 0v3h2v-3" /></svg>;
  return <svg viewBox="0 0 24 24"><path d="M5 19V9m5 10V5m5 14v-7m4 7V3M3 19h18" /></svg>;
}

function DockSlot({ mouseX, active, badge, label, children }: { mouseX: MotionValue<number>; active?: boolean; badge?: number; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const distance = useTransform(mouseX, (value) => {
    const bounds = ref.current?.getBoundingClientRect();
    return bounds ? value - bounds.left - bounds.width / 2 : Number.POSITIVE_INFINITY;
  });
  const width = useSpring(useTransform(distance, [-150, 0, 150], [65, 86, 65]), { stiffness: 390, damping: 30, mass: 0.36 });
  const lift = useSpring(useTransform(distance, [-130, 0, 130], [0, -9, 0]), { stiffness: 390, damping: 28, mass: 0.32 });
  return <motion.div ref={ref} className={`agent-dock-slot ${active ? "active" : ""}`} style={{ width, y: lift }} aria-label={label}>
    {children}{badge ? <b>{badge}</b> : null}
  </motion.div>;
}

export function AgentDock({ view, automationCount, onSelect, onPortfolio }: { view: AgentDockView; automationCount: number; onSelect: (view: AgentDockView) => void; onPortfolio: () => void }) {
  const mouseX = useMotionValue(Number.POSITIVE_INFINITY);
  const [confirmTerminal, setConfirmTerminal] = useState(false);
  const items: Array<{ id: AgentDockView; label: string }> = [
    { id: "ask", label: "Chat" }, { id: "automations", label: "Automations" }, { id: "activity", label: "Activity" }
  ];
  return <nav className="agent-bottom-nav" aria-label="Agent views" onMouseMove={(event) => mouseX.set(event.clientX)} onMouseLeave={() => mouseX.set(Number.POSITIVE_INFINITY)}>
    {items.map((item) => <DockSlot key={item.id} mouseX={mouseX} active={view === item.id} badge={item.id === "automations" ? automationCount : undefined} label={item.label}>
      <button type="button" aria-current={view === item.id ? "page" : undefined} onClick={() => onSelect(item.id)}><DockIcon name={item.id} /><span>{item.label}</span></button>
    </DockSlot>)}
    <DockSlot mouseX={mouseX} label="Portfolio"><button type="button" onClick={onPortfolio}><DockIcon name="portfolio" /><span>Portfolio</span></button></DockSlot>
    <DockSlot mouseX={mouseX} label="Terminal"><button type="button" onClick={() => setConfirmTerminal((value) => !value)}><DockIcon name="terminal" /><span>Terminal</span></button>
      <AnimatePresence>{confirmTerminal ? <motion.div className="terminal-confirm" initial={{ opacity: 0, y: 8, scale: .9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: .94 }}><span>OPEN FULL TERMINAL?</span><div><button type="button" onClick={() => setConfirmTerminal(false)}>STAY</button><Link to="/onchain">OPEN ↗</Link></div></motion.div> : null}</AnimatePresence>
    </DockSlot>
  </nav>;
}
