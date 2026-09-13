import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import type { TapePrint, TokenFlowResponse } from "../../../shared/wire";
import { api } from "../../api/client";
import { money } from "../../lib/format";
import { filterRecentOrderFlow } from "../../lib/agentOrderFlow";
import { useAgentStore } from "../voice-agent/store/agentStore";

const age = (time: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
};

export function OrderFlowHud() {
  const hud = useAgentStore((state) => state.hudWindow);
  const setHudWindow = useAgentStore((state) => state.setHudWindow);
  const [flow, setFlow] = useState<TokenFlowResponse | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!hud || hud.type !== "order_flow") { setFlow(null); return; }
    let live = true;
    const load = async () => {
      try {
        const next = await api.flowToken(hud.chain, hud.tokenAddress, "1m");
        if (live) { setFlow(next); setError(next.error || ""); }
      } catch (reason) { if (live) setError(reason instanceof Error ? reason.message : String(reason)); }
    };
    void load();
    const timer = setInterval(load, 5_000);
    return () => { live = false; clearInterval(timer); };
  }, [hud?.chain, hud?.tokenAddress, hud?.type]);
  const rows = useMemo<TapePrint[]>(() => {
    if (!hud || hud.type !== "order_flow") return [];
    return filterRecentOrderFlow(flow?.tape || [], { now: Date.now(), windowMinutes: hud.windowMinutes, minUsd: hud.minUsd, side: hud.side }).slice(0, 18);
  }, [flow, hud]);
  return <AnimatePresence>{hud?.type === "order_flow" ? <motion.aside className="market-hud order-flow-hud" initial={{ opacity: 0, x: 80, scale: .72 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 55, scale: .85 }} transition={{ type: "spring", stiffness: 280, damping: 27 }}>
    <header><span><i /> LARGE ORDER TAPE</span><button type="button" onClick={() => setHudWindow()}>×</button></header>
    <div className="order-flow-title"><strong>${hud.tokenSymbol || "TOKEN"}</strong><small>{hud.side?.toUpperCase() || "BUY + SELL"} · ≥ {money(hud.minUsd, true)} · {hud.windowMinutes}M</small></div>
    <div className="order-flow-list">
      {rows.length ? rows.map((row) => <article key={`${row.tx}:${row.side}`} className={row.side}>
        <b>{row.side === "buy" ? "▲ BUY" : "▼ SELL"}</b><strong>{money(row.usd, true)}</strong>
        <small>{row.trader?.handle ? `@${row.trader.handle.replace(/^@/, "")} · ` : ""}{row.dex || row.source} · {age(row.time)}</small>
      </article>) : <div className="market-hud-empty">{error || "NO MATCHING PRINTS YET"}</div>}
    </div>
    <footer><span>SOURCE <b>{flow?.source || "ACQUIRING"}</b></span><span>PAIRS <b>{flow?.pairs.length ?? 0}</b></span><span>UPDATED <b>{flow ? age(flow.observedAt) : "—"}</b></span></footer>
  </motion.aside> : null}</AnimatePresence>;
}
