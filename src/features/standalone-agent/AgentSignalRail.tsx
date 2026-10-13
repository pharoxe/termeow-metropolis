import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import type { SmartFill, SmartTapeResponse } from "../../../shared/wire";
import { api } from "../../api/client";
import { smartTapeRow } from "../../lib/smartPanel";
import { isLargeAgentSignal } from "../../lib/agentOrderFlow";
import { useAgentStore } from "../voice-agent/store/agentStore";
import { TokenLogo } from "./TokenLogo";

type Signal = { fill: SmartFill };
const cleanSymbol = (value: string) => value.replace(/^\$+/, "");

export function AgentSignalRail() {
  const [feed, setFeed] = useState<SmartTapeResponse | null>(null);
  const [tokenLogos, setTokenLogos] = useState<Record<string, string | null>>({});
  const setHudWindow = useAgentStore((state) => state.setHudWindow);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const next = await api.smartTape({ limit: 60 });
        if (!live) return;
        setFeed(next);
        const logoTargets = [...new Map(next.fills.filter((fill) => isLargeAgentSignal(fill)).slice(0, 8).map((fill) => [`${fill.chain}:${fill.token}`, { chain: fill.chain, address: fill.token }])).values()];
        const logoResult = logoTargets.length ? await api.tokenLogos(logoTargets).catch(() => null) : null;
        const logos = (logoResult?.logos || []).map((item) => [`${item.chain}:${item.address}`, item.imageUrl] as const);
        if (live) setTokenLogos((current) => ({ ...current, ...Object.fromEntries(logos) }));
      } catch { /* The rail is ambient; failures must never obstruct voice. */ }
    };
    void load();
    const timer = setInterval(load, 10_000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const signals = useMemo<Signal[]>(() => (feed?.fills ?? []).filter((fill) => isLargeAgentSignal(fill)).slice(0, 3).map((fill) => ({ fill })), [feed?.fills]);
  if (!signals.length) return null;
  return <aside className="agent-signal-rail" aria-label="Live smart-money signals">
    <header><i /> LIVE SIGNALS</header>
    <AnimatePresence initial={false} mode="popLayout">
      {signals.map(({ fill }, index) => {
        const row = smartTapeRow(fill, Date.now());
        const symbol = cleanSymbol(row.token);
        const handle = fill.trader.handle;
        const notable = (fill.usd ?? 0) >= 25_000;
        const smartProfile = `https://app.nansen.ai/profiler?chain=monad&address=${fill.trader.address}`;
        const smartTrader = fill.trader.kind === "smart";
        const logo = tokenLogos[`${fill.chain}:${fill.token}`];
        return <motion.article layout key={row.key} className={`${fill.side === "buy" ? "buy" : "sell"}${notable ? " notable" : ""}${handle ? " has-handle" : ""}`}
          initial={{ opacity: 0, x: -20, scale: .9 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: -12 }}
          transition={{ type: "spring", stiffness: 360, damping: 30, delay: index * .035 }}>
          <button className="signal-open" type="button" aria-label={`Open ${symbol} chart`} onClick={() => setHudWindow({
            type: "market_chart", chain: fill.chain, tokenAddress: fill.token, tokenSymbol: symbol, timeframe: "5m", requestedAt: Date.now()
          })}>
            {smartTrader ? <span className="signal-smart-icon" aria-hidden="true">◆</span> : <TokenLogo className="signal-token-logo" symbol={symbol} src={logo} />}
            <span><b>{row.side} ${symbol}</b><small>{row.usd} · {row.chain} · {row.age}</small></span>
          </button>
          {handle ? <div className="signal-identities"><span>{handle.replace(/^@/, "")}</span><a href={smartProfile} target="_blank" rel="noreferrer" aria-label="Open on Nansen">NANSEN ↗</a></div> : null}
        </motion.article>;
      })}
    </AnimatePresence>
  </aside>;
}
