import { useEffect, useState } from "react";
import type { DiscoverResponse, DiscoverRow } from "../../shared/wire";
import { api } from "../api/client";
import type { InstrumentRef } from "../lib/address";
import { money } from "../lib/format";
import {
  DISCOVER_POLL_MS, WINDOW_CHIPS, ageLabel, changeCell, disputedLabel, emptyCopy, fomoHoldersCell, rowKey, sourceChips, sourcesSummary, sourcesTitle, symbolLabel, txnsLabel, viewFor, windowParam,
  type DiscoverTab as DiscoverTabName, type WindowChip
} from "../lib/discover";
import { fomoCoverageLabel } from "../lib/fomoPanel";

type OpenInstrument = (ref: InstrumentRef, symbol?: string) => void;

function DiscoverRowItem({ row, feed, now, selected, onOpen }: { row: DiscoverRow; feed: DiscoverResponse; now: number; selected?: string; onOpen?: OpenInstrument }) {
  const change = changeCell(row.changePct);
  const fomo = fomoHoldersCell(row, feed.coverage);
  const disputed = disputedLabel(row);
  const chips = sourceChips(row, now);
  return (
    <tr className={row.token.toLowerCase() === selected?.toLowerCase() ? "selected" : ""} title={row.token} onClick={() => onOpen?.({ chain: row.chain, address: row.token }, row.symbol ?? undefined)}>
      <td>
        <b>{symbolLabel(row)}</b>
        <small>{row.name ?? row.dex ?? "—"} · {ageLabel(row.ageMs)}{disputed ? <span className="chip warn" title="sources differ by more than 5% on these fields; each chip's tooltip carries its own figures">{disputed}</span> : null}</small>
        <small className="discover-sources">{chips.map((chip) => <span key={chip.key} className={`chip${chip.stale ? " warn" : ""}`} title={chip.title}>{chip.label}</span>)}</small>
      </td>
      <td className="r"><b className="mcap-value">{money(row.marketCapUsd, true)}</b><small>{money(row.priceUsd)}</small></td>
      <td className={`r ${change.tone}`}><b className={change.tone}>{change.text}</b><small>{money(row.volumeUsd, true)} · {txnsLabel(row.txns)}</small></td>
      <td className="r" title={fomo.title}><b>{fomo.text}</b><small>FOMO</small></td>
    </tr>
  );
}

/** Robinhood discovery view for the TRENDING / BIGGEST MOVERS / NEW / SMART HOLDERS tabs: polls /api/discover/robinhood every 30s. */
export function DiscoverTab({ tab, onOpen, selected }: { tab: DiscoverTabName; onOpen?: OpenInstrument; selected?: string }) {
  const [windowChip, setWindowChip] = useState<WindowChip>("24H");
  const [feed, setFeed] = useState<DiscoverResponse | null>(null);
  const [failure, setFailure] = useState("");
  const view = viewFor(tab);

  useEffect(() => {
    let active = true;
    const load = () => api.discover("robinhood", view, windowParam(windowChip))
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
  }, [view, windowChip]);

  const now = Date.now();
  const shown = feed && feed.view === view ? feed : null;
  const rows = shown?.rows ?? [];
  const sources = shown?.sources ?? [];
  return (
    <>
      <div className="launch-bar">
        {WINDOW_CHIPS.map((item) => <button key={item} type="button" className={windowChip === item ? "on" : ""} onClick={() => setWindowChip(item)}>{item}</button>)}
        <span className="pm" title={sourcesTitle(sources, now)}>{sourcesSummary(sources, shown?.stale)}</span>
      </div>
      {view === "holders" ? <p className="pm discover-coverage" title="verified-FOMO buyers per this server's trader book; a wallet that later sold still counts">{fomoCoverageLabel(shown?.coverage)}</p> : null}
      {rows.length && shown ? (
        <table className="terminal-table launch-table discover-table">
          <thead><tr><th>TOKEN · SOURCES</th><th className="r">MCAP / PX</th><th className="r">CHG · VOL</th><th className="r">FOMO</th></tr></thead>
          <tbody>{rows.map((row) => <DiscoverRowItem key={rowKey(row)} row={row} feed={shown} now={now} selected={selected} onOpen={onOpen} />)}</tbody>
        </table>
      ) : (
        <p className="empty-copy">{emptyCopy(shown, failure)}</p>
      )}
      {failure && shown && rows.length ? <p className="empty-copy">Feed degraded · {failure}</p> : null}
    </>
  );
}
