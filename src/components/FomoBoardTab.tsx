import { useEffect, useState } from "react";
import type { FomoBoardResponse, FomoBoardWindow } from "../../shared/wire";
import { api } from "../api/client";
import { BOARD_WINDOWS, FOMO_BOARD_POLL_MS, fomoBoardRowView, populationNote, truncationNote } from "../lib/fomoPanel";

const COLUMNS = ["WALLET", "FILLS", "BUY", "SELL", "NET", "W/L"];
const DEFAULT_POPULATION_LABEL = "FOMO wallets seen by this server";

/**
 * WatchPanel "FOMO" tab: /api/fomo/board ranked by net USD into tokens over 1H / 24H / 7D. NET is buy minus sell —
 * net flow into tokens, not realized P&L. W/L counts tokens with priced buys and priced sells, and its Wilson lower
 * bound is an em-dash under five closed round trips. The population line always says whose population it is.
 */
export function FomoBoardTab() {
  const [window, setWindow] = useState<FomoBoardWindow>("24h");
  const [feed, setFeed] = useState<FomoBoardResponse | null>(null);
  const [failure, setFailure] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    const load = () => api.fomoBoard({ window })
      .then((value) => {
        if (!active) return;
        setFeed(value);
        setNow(Date.now());
        setFailure(value.error ?? "");
      })
      .catch((reason) => active && setFailure(reason instanceof Error ? reason.message : String(reason)));
    load();
    const timer = setInterval(load, FOMO_BOARD_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [window]);

  const rows = feed?.rows ?? [];
  const truncated = truncationNote(feed?.truncatedAt ?? null, now);
  return (
    <div className="fomo-board">
      <div className="fomo-board-head">
        <span className="tabs">{BOARD_WINDOWS.map((item) => (
          <button key={item} className={window === item ? "on" : ""} onClick={() => setWindow(item)}>{item.toUpperCase()}</button>
        ))}</span>
        <span className="pm">{populationNote(feed?.population ?? 0, feed?.populationLabel ?? DEFAULT_POPULATION_LABEL)}</span>
      </div>
      {truncated ? <p className="pm fomo-note">{truncated}</p> : null}
      {failure ? <p className="empty-copy">Board degraded · {failure}</p> : null}
      {rows.length ? (
        <table className="terminal-table fomo-board-table">
          <thead><tr>{COLUMNS.map((column, index) => <th key={column} className={index ? "r" : ""}>{column}</th>)}</tr></thead>
          <tbody>
            {rows.map((row) => {
              const view = fomoBoardRowView(row, now);
              return (
                <tr className="static" key={view.key} title={view.title}>
                  <td>
                    {view.href
                      ? <a href={view.href} target="_blank" rel="noopener noreferrer">{view.label}</a>
                      : <b>{view.label}</b>}
                    <small>{view.tag ? `${view.tag} · ` : ""}{view.age}</small>
                  </td>
                  <td className="r">{view.fills}</td>
                  <td className="r up">{view.buy}</td>
                  <td className="r dn">{view.sell}</td>
                  <td className={`r ${view.netTone}`}>{view.net}</td>
                  <td className="r">{view.record}<small>{view.wilson}</small></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <p className="empty-copy">{failure ? "" : "No FOMO wallets ranked in this window yet. NET is net flow into tokens, not P&L."}</p>}
    </div>
  );
}
