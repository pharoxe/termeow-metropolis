import { useEffect, useState } from "react";
import type { Chain, SmartBoardResponse, SmartBoardWindow } from "../../shared/wire";
import { api } from "../api/client";
import { BOARD_WINDOWS, SMART_BOARD_POLL_MS, smartBoardRowView, smartCoverageLabel, populationNote, truncationNote } from "../lib/smartPanel";

const COLUMNS = ["WALLET", "FILLS", "BUY", "SELL", "NET", "CASH FLOW"];
const DEFAULT_POPULATION_LABEL = "SMART wallets seen by this server";

/**
 * WatchPanel "SMART" tab: /api/smart/board ranked by net USD into tokens over 1H / 24H / 7D. NET is buy minus sell —
 * net flow into tokens, not realized P&L. W/L counts tokens with priced buys and priced sells, and its Wilson lower
 * bound is an em-dash under five closed round trips. The population line always says whose population it is.
 */
export function SmartBoardTab({chain}:{chain?:Chain}) {
  const [window, setWindow] = useState<SmartBoardWindow>("24h");
  const [feed, setFeed] = useState<SmartBoardResponse | null>(null);
  const [failure, setFailure] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    const load = () => api.smartBoard({ chain, window })
      .then((value) => {
        if (!active) return;
        setFeed(value);
        setNow(Date.now());
        setFailure(value.error ?? "");
      })
      .catch((reason) => active && setFailure(reason instanceof Error ? reason.message : String(reason)));
    load();
    const timer = setInterval(load, SMART_BOARD_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [chain, window]);

  const rows = feed && (!chain || feed.chain === chain) ? feed.rows : [];
  const truncated = truncationNote(feed?.truncatedAt ?? null, now);
  return (
    <div className="smart-board">
      <div className="smart-board-head">
        <span className="tabs">{BOARD_WINDOWS.map((item) => (
          <button key={item} className={window === item ? "on" : ""} onClick={() => setWindow(item)}>{item.toUpperCase()}</button>
        ))}</span>
        <span className="pm">{populationNote(feed?.population ?? 0, feed?.populationLabel ?? DEFAULT_POPULATION_LABEL)}</span>
      </div>
      <p className="pm smart-note" title="Unwatched wallets cannot rank: the transfer legs only carry the watched share of the population">{smartCoverageLabel(feed?.coverage)}</p>
      {truncated ? <p className="pm smart-note">{truncated}</p> : null}
      {failure ? <p className="empty-copy">Board degraded · {failure}</p> : null}
      <p className="terminal-notice">Cash-flow counts are not win rate or realized P&amp;L. Partial sales do not prove closed positions.</p>
      {rows.length ? (
      <table className="terminal-table smart-board-table">
          <thead><tr>{COLUMNS.map((column, index) => <th key={column} className={index ? "r" : ""}>{column}</th>)}</tr></thead>
          <tbody>
            {rows.map((row) => {
              const view = smartBoardRowView(row, now);
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
                  <td className="r">{view.record}<small>cash-positive / two-sided</small></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <p className="empty-copy">{failure ? "" : "No SMART wallets ranked in this window yet. NET is net flow into tokens, not P&L."}</p>}
    </div>
  );
}
