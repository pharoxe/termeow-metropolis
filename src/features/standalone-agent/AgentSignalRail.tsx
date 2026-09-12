import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import type { TraderIdentity } from "../../../shared/identity";
import type { FomoFill, FomoTapeResponse } from "../../../shared/wire";
import { api } from "../../api/client";
import { fomoTapeRow } from "../../lib/fomoPanel";
import { useAgentStore } from "../voice-agent/store/agentStore";

type Signal = { fill: FomoFill; identity: TraderIdentity | null };

const xHref = (identity: TraderIdentity | null) => {
  const value = identity?.twitter?.trim();
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://x.com/${value.replace(/^@/, "")}`;
};
const cleanSymbol = (value: string) => value.replace(/^\$+/, "");

export function AgentSignalRail() {
  const [feed, setFeed] = useState<FomoTapeResponse | null>(null);
  const [identities, setIdentities] = useState<Record<string, TraderIdentity | null>>({});
  const setHudWindow = useAgentStore((state) => state.setHudWindow);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const next = await api.fomoTape({ limit: 8 });
        if (!live) return;
        setFeed(next);
        const unique = [...new Map(next.fills.slice(0, 4).map((fill) => [`${fill.chain}:${fill.trader.address}`, fill])).values()];
        const resolved = await Promise.all(unique.map(async (fill) => [
          `${fill.chain}:${fill.trader.address}`,
          await api.identityWallet(fill.chain, fill.trader.address).then((result) => result.identity).catch(() => null)
        ] as const));
        if (live) setIdentities((current) => ({ ...current, ...Object.fromEntries(resolved) }));
      } catch { /* The rail is ambient; failures must never obstruct voice. */ }
    };
    void load();
    const timer = setInterval(load, 10_000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const signals = useMemo<Signal[]>(() => (feed?.fills ?? []).slice(0, 3).map((fill) => ({
    fill, identity: identities[`${fill.chain}:${fill.trader.address}`] ?? null
  })), [feed?.fills, identities]);
  if (!signals.length) return null;
  return <aside className="agent-signal-rail" aria-label="Live social signals">
    <header><i /> LIVE SIGNALS</header>
    <AnimatePresence initial={false} mode="popLayout">
      {signals.map(({ fill, identity }, index) => {
        const row = fomoTapeRow(fill, Date.now());
        const symbol = cleanSymbol(row.token);
        const handle = identity?.handle || fill.trader.handle;
        const profile = xHref(identity);
        return <motion.article layout key={row.key} className={fill.side === "buy" ? "buy" : "sell"}
          initial={{ opacity: 0, x: -20, scale: .9 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: -12 }}
          transition={{ type: "spring", stiffness: 360, damping: 30, delay: index * .035 }}>
          <button className="signal-open" type="button" aria-label={`Open ${symbol} chart`} onClick={() => setHudWindow({
            type: "market_chart", chain: fill.chain, tokenAddress: fill.token, tokenSymbol: symbol, timeframe: "5m", requestedAt: Date.now()
          })}>
            {identity?.avatarUrl ? <img src={identity.avatarUrl} alt="" /> : <span className="signal-avatar" aria-hidden="true" />}
            <span><b>{row.side} ${symbol}</b><small>{row.usd} · {row.chain} · {row.age}</small></span>
          </button>
          {handle ? (profile ? <a href={profile} target="_blank" rel="noreferrer">@{handle.replace(/^@/, "")}</a> : <em>@{handle.replace(/^@/, "")}</em>) : null}
        </motion.article>;
      })}
    </AnimatePresence>
  </aside>;
}
