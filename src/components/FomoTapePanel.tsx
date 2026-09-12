import { useEffect, useState } from "react";
import type { FomoTapeResponse } from "../../shared/wire";
import { api } from "../api/client";
import type { InstrumentRef } from "../lib/address";
import { FOMO_TAPE_POLL_MS, fomoCoverageLabel, fomoTapeRow } from "../lib/fomoPanel";
import { LiveAlertBubbles } from "./LiveAlertBubbles";

/**
 * Radar "FOMO tape": newest FOMO-wallet fills across every token this server tracks, polled from /api/fomo/tape.
 * A row is FOMO only after the EIP-7702 designator check passed on this server; a wallet taken from the
 * robinhoodtrenches traders list whose check has not answered yet is tagged SEEDED (its provenance, never an upgrade).
 * A row without a robinhoodtrenches handle shows its address and links nowhere (fomo.family has no public API to resolve one).
 */
export function FomoTapePanel({ onInstrument,onNewChart }: { onInstrument?: (ref: InstrumentRef, symbol?: string) => void;onNewChart?:(ref:InstrumentRef)=>void }) {
  const [feed, setFeed] = useState<FomoTapeResponse | null>(null);
  const [failure, setFailure] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    const load = () => api.fomoTape()
      .then((value) => {
        if (!active) return;
        setFeed(value);
        setNow(Date.now());
        setFailure(value.error ?? "");
      })
      .catch((reason) => active && setFailure(reason instanceof Error ? reason.message : String(reason)));
    load();
    const timer = setInterval(load, FOMO_TAPE_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const fills = feed?.fills ?? [];
  return (
    <section className="panel radar-panel social-panel">
      <div className="ph">
        <span className="pt">FOMO TAPE</span>
        <span className="pm">{fomoCoverageLabel(feed?.coverage)}</span>
      </div>
      <div className="panel-scroll">
        <div className="social-bubble-flow alert-bubble-flow fomo-live-bubbles">
          <LiveAlertBubbles onOpen={onInstrument} />
          {fills.map((fill) => {
            const row = fomoTapeRow(fill, now);
            const rawTwitter = fill.trader.twitter?.trim() || "";
            const xHandle = (rawTwitter.match(/(?:x|twitter)\.com\/([^/?#]+)/i)?.[1] || rawTwitter.replace(/^@+/, "") || fill.trader.handle?.replace(/^@+/, ""))?.trim();
            const href = xHandle ? `https://x.com/${encodeURIComponent(xHandle)}` : row.href;
            return <article className={`social-bubble fomo-fill ${row.tone}`} key={row.key} title={row.title}>
              <div className="fomo-trader-identity">
                {fill.trader.avatarUrl ? <img src={fill.trader.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <i className="pixel-trader-avatar" aria-hidden="true"><b /><b /><b /><b /></i>}
                <span><strong>{xHandle ? `@${xHandle}` : row.label}</strong><small>{row.followers} FOLLOWERS · {row.chain} · {row.age}</small></span>
                {href && <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${row.label} profile`}>↗</a>}
              </div>
              <button type="button" className="social-bubble-chart" onClick={() => onInstrument?.({ chain: fill.chain, address: fill.token }, fill.symbol ?? undefined)}>
                <b>${row.token}</b><p>{row.side} {row.usd} · {fill.dex || "ONCHAIN"}</p><em>OPEN CHART →</em>
              </button>
              {onNewChart && <button type="button" className="bubble-new-chart" onClick={() => onNewChart({ chain: fill.chain, address: fill.token })}>NEW CHART ＋</button>}
            </article>;
          })}
        </div>
        {failure ? <p className="empty-copy">FOMO tape degraded · {failure}</p> : null}
        {!fills.length && <p className="empty-copy">{failure ? "" : "No tracked trader fills seen by this server yet."}</p>}
      </div>
    </section>
  );
}
