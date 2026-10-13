import { useEffect, useState } from "react";
import type { Chain, DiscoverResponse, DiscoverRow } from "../../shared/wire";
import { api } from "../api/client";
import type { InstrumentRef } from "../lib/address";
import { money } from "../lib/format";
import {
  DISCOVER_POLL_MS, WINDOW_CHIPS, changeCell, emptyCopy, rowKey, sourcesSummary, sourcesTitle, symbolLabel, txnsLabel, viewFor, windowParam,
  type DiscoverTab as DiscoverTabName, type WindowChip
} from "../lib/discover";
import { smartCoverageLabel } from "../lib/smartPanel";

type OpenInstrument = (ref: InstrumentRef, symbol?: string) => void;

function DiscoverRowItem({ row, selected, onOpen }: { row: DiscoverRow; selected?: string; onOpen?: OpenInstrument }) {
  const change = changeCell(row.changePct);
  return (
    <tr className={row.token.toLowerCase() === selected?.toLowerCase() ? "selected" : ""} title={row.token} onClick={() => onOpen?.({ chain: row.chain, address: row.token }, row.symbol ?? undefined)}>
      <td>
        <button onClick={e=>{e.stopPropagation();onOpen?.({chain:row.chain,address:row.token},row.symbol??undefined);}}>{symbolLabel(row)}</button>
      </td>
      <td className="r"><b className="mcap-value">{money(row.marketCapUsd, true)}</b><small>LIQ {money(row.liquidityUsd,true)}</small></td>
      <td className={`r ${change.tone}`}><b className={change.tone}>{change.text}</b><small>{money(row.volumeUsd, true)} · {txnsLabel(row.txns)}</small></td>
    </tr>
  );
}

/** Monad discovery view for the TRENDING / BIGGEST MOVERS / NEW / SMART HOLDERS tabs: polls /api/discover/monad every 30s. */
export function DiscoverTab({ chain="monad", tab, onOpen, selected }: { chain?:Chain; tab: DiscoverTabName; onOpen?: OpenInstrument; selected?: string }) {
  const [windowChip, setWindowChip] = useState<WindowChip>("24H");
  const [feed, setFeed] = useState<DiscoverResponse | null>(null);
  const [failure, setFailure] = useState("");
  const view = viewFor(tab);

  useEffect(() => {
    let active = true;
    const load = () => api.discover(chain, view, windowParam(windowChip))
      .then((value) => {
        if (!active) return;
        setFeed(value);
        setFailure(value.error || "");
      })
      .catch((reason) => {
        if (active) setFailure(reason instanceof Error ? reason.message : String(reason));
      });
    load();
    const timer = setInterval(load, DISCOVER_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [chain, view, windowChip]);

  const now = Date.now();
  const shown = feed && feed.chain === chain && feed.view === view ? feed : null;
  const rows = shown?.rows ?? [];
  const sources = shown?.sources ?? [];
  return (
    <>
      <div className="launch-bar">
        {WINDOW_CHIPS.map((item) => <button key={item} type="button" className={windowChip === item ? "on" : ""} onClick={() => setWindowChip(item)}>{item}</button>)}
        <span className="pm" title={sourcesTitle(sources, now)}>{sourcesSummary(sources, shown?.stale)}</span>
      </div>
      {view === "holders" ? <p className="pm discover-coverage" title="verified-SMART buyers per this server's trader book; a wallet that later sold still counts">{smartCoverageLabel(shown?.coverage)}</p> : null}
      {rows.length && shown ? (
        <table className="terminal-table launch-table discover-table">
          <thead><tr><th>TOKEN</th><th className="r">MCAP / LIQ</th><th className="r">CHG · VOL</th></tr></thead>
          <tbody>{rows.map((row) => <DiscoverRowItem key={rowKey(row)} row={row} selected={selected} onOpen={onOpen} />)}</tbody>
        </table>
      ) : (
        <p className="empty-copy">{emptyCopy(shown, failure)}</p>
      )}
      {failure && shown && rows.length ? <p className="empty-copy">Feed degraded · {failure}</p> : null}
    </>
  );
}
