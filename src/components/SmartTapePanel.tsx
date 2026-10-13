import { useEffect, useState } from "react";
import type { SmartTapeResponse } from "../../shared/wire";
import { api } from "../api/client";
import type { InstrumentRef } from "../lib/address";
import { SMART_TAPE_POLL_MS, smartCoverageLabel, smartTapeRow } from "../lib/smartPanel";
import { LiveAlertBubbles } from "./LiveAlertBubbles";

/**
 * Radar "SMART tape": newest smart-money fills across every token this server tracks, polled from /api/smart/tape.
 * A wallet is smart money when Nansen labels it in a smart-money cohort on Monad or the user watches it; a seeded wallet
 * still awaiting its check is tagged SEEDED. Every row links to the wallet's Nansen profiler page.
 */
export function SmartTapePanel({ onInstrument,onNewChart }: { onInstrument?: (ref: InstrumentRef, symbol?: string) => void;onNewChart?:(ref:InstrumentRef)=>void }) {
  const [feed, setFeed] = useState<SmartTapeResponse | null>(null);
  const [failure, setFailure] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    const load = () => api.smartTape()
      .then((value) => {
        if (!active) return;
        setFeed(value);
        setNow(Date.now());
        setFailure(value.error ?? "");
      })
      .catch((reason) => active && setFailure(reason instanceof Error ? reason.message : String(reason)));
    load();
    const timer = setInterval(load, SMART_TAPE_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const fills = feed?.fills ?? [];
  return (
    <section className="panel radar-panel social-panel">
      <div className="ph">
        <span className="pt">SMART TAPE</span>
        <span className="pm">{smartCoverageLabel(feed?.coverage)}</span>
      </div>
      <div className="panel-scroll">
        <div className="social-bubble-flow alert-bubble-flow smart-live-bubbles">
          <LiveAlertBubbles onOpen={onInstrument} />
          {fills.map((fill) => {
            const row = smartTapeRow(fill, now);
            const href = row.href;
            return <article className={`social-bubble smart-fill ${row.tone}`} key={row.key} title={row.title}>
              <div className="smart-trader-identity">
                {fill.trader.avatarUrl ? <img src={fill.trader.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <i className="pixel-trader-avatar" aria-hidden="true"><b /><b /><b /><b /></i>}
                <span><strong>{row.label}</strong><small>{row.tag ?? "SMART MONEY"} · {row.chain} · {row.age}</small></span>
                {href && <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${row.label} on Nansen`}>↗</a>}
              </div>
              <button type="button" className="social-bubble-chart" onClick={() => onInstrument?.({ chain: fill.chain, address: fill.token }, fill.symbol ?? undefined)}>
                <b>${row.token}</b><p>{row.side} {row.usd} · {fill.dex || "ONCHAIN"}</p><em>OPEN CHART →</em>
              </button>
              {onNewChart && <button type="button" className="bubble-new-chart" onClick={() => onNewChart({ chain: fill.chain, address: fill.token })}>NEW CHART ＋</button>}
            </article>;
          })}
        </div>
        {failure ? <p className="empty-copy">SMART tape degraded · {failure}</p> : null}
        {!fills.length && <p className="empty-copy">{failure ? "" : "No smart-money fills seen by this server yet. Labels come from Nansen (NANSEN_API_KEY) and wallets you watch."}</p>}
      </div>
    </section>
  );
}
