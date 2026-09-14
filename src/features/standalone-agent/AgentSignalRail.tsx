import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import type { TraderIdentity } from "../../../shared/identity";
import type { FomoFill, FomoTapeResponse } from "../../../shared/wire";
import { api } from "../../api/client";
import { fomoTapeRow } from "../../lib/fomoPanel";
import { isLargeAgentSignal } from "../../lib/agentOrderFlow";
import { useAgentStore } from "../voice-agent/store/agentStore";
import { TokenLogo } from "./TokenLogo";

type Signal = { fill: FomoFill; identity: TraderIdentity | null };

const xHref = (identity: TraderIdentity | null, fallback?: string | null) => {
  const value = identity?.twitter?.trim() || fallback?.trim();
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://x.com/${value.replace(/^@/, "")}`;
};
const cleanSymbol = (value: string) => value.replace(/^\$+/, "");

export function AgentSignalRail() {
  const [feed, setFeed] = useState<FomoTapeResponse | null>(null);
  const [identities, setIdentities] = useState<Record<string, TraderIdentity | null>>({});
  const [tokenLogos, setTokenLogos] = useState<Record<string, string | null>>({});
  const setHudWindow = useAgentStore((state) => state.setHudWindow);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const next = await api.fomoTape({ limit: 60 });
        if (!live) return;
        setFeed(next);
        const unique = [...new Map(next.fills.filter((fill) => isLargeAgentSignal(fill)).slice(0, 8).map((fill) => [`${fill.chain}:${fill.trader.address}`, fill])).values()];
        const resolved = await Promise.all(unique.map(async (fill) => [`${fill.chain}:${fill.trader.address}`, await api.identityWallet(fill.chain, fill.trader.address).then((result) => result.identity).catch(() => null)] as const));
        const logoTargets = [...new Map(next.fills.filter((fill) => isLargeAgentSignal(fill) && fill.trader.kind !== "fomo").slice(0, 8).map((fill) => [`${fill.chain}:${fill.token}`, { chain: fill.chain, address: fill.token }])).values()];
        const logoResult = logoTargets.length ? await api.tokenLogos(logoTargets).catch(() => null) : null;
        const logos = (logoResult?.logos || []).map((item) => [`${item.chain}:${item.address}`, item.imageUrl] as const);
        if (live) setIdentities((current) => ({ ...current, ...Object.fromEntries(resolved) }));
        if (live) setTokenLogos((current) => ({ ...current, ...Object.fromEntries(logos) }));
      } catch { /* The rail is ambient; failures must never obstruct voice. */ }
    };
    void load();
    const timer = setInterval(load, 10_000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const signals = useMemo<Signal[]>(() => (feed?.fills ?? []).filter((fill) => isLargeAgentSignal(fill)).slice(0, 3).map((fill) => ({
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
        const profile = xHref(identity, fill.trader.twitter);
        const followers = identity?.followers ?? fill.trader.followers ?? 0;
        const notable = followers >= 25_000;
        const fomoProfile = handle ? `https://fomo.family/profile/${encodeURIComponent(handle.replace(/^@/, ""))}` : null;
        const fomoTrader = fill.trader.kind === "fomo" && Boolean(handle);
        const logo = tokenLogos[`${fill.chain}:${fill.token}`];
        return <motion.article layout key={row.key} className={`${fill.side === "buy" ? "buy" : "sell"}${notable ? " notable" : ""}${handle ? " has-handle" : ""}`}
          initial={{ opacity: 0, x: -20, scale: .9 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: -12 }}
          transition={{ type: "spring", stiffness: 360, damping: 30, delay: index * .035 }}>
          <button className="signal-open" type="button" aria-label={`Open ${symbol} chart`} onClick={() => setHudWindow({
            type: "market_chart", chain: fill.chain, tokenAddress: fill.token, tokenSymbol: symbol, timeframe: "5m", requestedAt: Date.now()
          })}>
            {fomoTrader ? <span className="signal-fomo-icon" aria-hidden="true"><img src="/assets/fomo-logo.png" alt="" /></span> : <TokenLogo className="signal-token-logo" symbol={symbol} src={logo} />}
            <span><b>{row.side} ${symbol}</b><small>{row.usd} · {row.chain} · {row.age}</small></span>
          </button>
          {handle ? <div className="signal-identities"><span>@{handle.replace(/^@/, "")}</span>{fomoProfile && <a href={fomoProfile} target="_blank" rel="noreferrer" aria-label="Open Fomo profile"><img src="/assets/fomo-logo.png" alt="" /></a>}{profile && <a href={profile} target="_blank" rel="noreferrer" aria-label="Open X profile"><img src="/assets/x-logo.png" alt="" /></a>}</div> : null}
        </motion.article>;
      })}
    </AnimatePresence>
  </aside>;
}
