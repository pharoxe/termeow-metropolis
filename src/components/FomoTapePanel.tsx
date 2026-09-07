import { useEffect, useState } from "react";
import type { FomoTapeResponse } from "../../shared/wire";
import { api } from "../api/client";
import type { InstrumentRef } from "../lib/address";
import { FOMO_TAPE_POLL_MS, fomoHeaderLabel, fomoTapeRow } from "../lib/fomoPanel";

/**
 * Radar "FOMO tape": newest FOMO-wallet fills across every token this server tracks, polled from /api/fomo/tape.
 * A row is FOMO only after the EIP-7702 designator check passed on this server; a wallet taken from the
 * robinhoodtrenches traders list whose check has not answered yet is tagged SEEDED (its provenance, never an upgrade).
 * A row without a robinhoodtrenches handle shows its address and links nowhere (fomo.family has no public API to resolve one).
 */
export function FomoTapePanel({ onInstrument }: { onInstrument?: (ref: InstrumentRef, symbol?: string) => void }) {
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
        <span className="pm">{fomoHeaderLabel(feed?.population ?? 0, feed?.handles ?? 0)}</span>
      </div>
      <div className="panel-scroll">
        {failure ? <p className="empty-copy">FOMO tape degraded · {failure}</p> : null}
        {fills.length ? (
          <table className="terminal-table fomo-tape">
            <thead><tr><th>WALLET</th><th className="r">SIDE / USD</th><th className="r">TOKEN</th></tr></thead>
            <tbody>
              {fills.map((fill) => {
                const row = fomoTapeRow(fill, now);
                return (
                  <tr key={row.key} title={row.title} onClick={() => onInstrument?.({ chain: fill.chain, address: fill.token }, fill.symbol ?? undefined)}>
                    <td>
                      {row.href
                        ? <a href={row.href} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>{row.label}</a>
                        : <b>{row.label}</b>}
                      <small>{row.followers} FOLLOWERS{row.tag ? ` · ${row.tag}` : ""}</small>
                    </td>
                    <td className={`r ${row.tone}`}><b>{row.usd}</b><small>{row.side}</small></td>
                    <td className="r"><b>{row.token}</b><small>{row.age}</small></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="empty-copy">{failure ? "" : "No FOMO or seeded fills seen by this server yet. Rows appear once a watched wallet trades; SEEDED marks robinhoodtrenches wallets still awaiting the 7702 check."}</p>}
      </div>
    </section>
  );
}
