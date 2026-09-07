import { useEffect, useMemo, useState } from "react";
import type { LaunchRow, LaunchesResponse } from "../../shared/wire";
import { api } from "../api/client";
import type { InstrumentRef } from "../lib/address";
import { useFundingNetwork } from "../features/NetworkContext";
import {
  CHAIN_CHIPS,
  LAUNCH_POLL_MS,
  chainLabel,
  coldCopy,
  curveCounts,
  defaultChip,
  filterByChip,
  fomoBuyer,
  isHoneypot,
  launchAge,
  launchMcap,
  launchPrice,
  launchQuery,
  padLabel,
  priceAgeTitle,
  rowKey,
  rowSubtitle,
  sortNewestFirst,
  symbolLabel,
  type ChainChip
} from "../lib/launches";

type OpenLaunch = (ref: InstrumentRef, symbol?: string) => void;

function LaunchRowItem({ row, now, selected, onOpen }: { row: LaunchRow; now: number; selected?: string; onOpen?: OpenLaunch }) {
  const buyer = fomoBuyer(row, now);
  const selectedRow = row.chain === "robinhood" ? row.token.toLowerCase() === selected?.toLowerCase() : row.token === selected;
  return (
    <tr className={selectedRow ? "selected" : ""} title={row.token} onClick={() => onOpen?.({ chain: row.chain, address: row.token }, row.symbol ?? undefined)}>
      <td><b>{launchAge(row, now)}</b><small><span className="chip">{chainLabel(row.chain)}</span><span className="chip">{padLabel(row.launchpad)}</span>{row.graduatedAt ? <span className="chip good">GRAD</span> : null}</small></td>
      <td><b>{symbolLabel(row)}</b>{isHoneypot(row) ? <span className="chip bad" title="honeypot flag · robinhoodtrenches">HONEYPOT</span> : null}<small title={row.sources.join(" · ")}>{rowSubtitle(row)}</small></td>
      <td className="r" title={priceAgeTitle(row, now)}><b className="mcap-value">{launchMcap(row)}</b><small>{launchPrice(row)}</small></td>
      <td className="r"><b>{curveCounts(row)}</b><small title={buyer?.title}>{buyer ? buyer.handle : "—"}</small></td>
    </tr>
  );
}

/** WatchPanel LAUNCHES tab: polls /api/launches every 15s; chips filter chain, STOCKS reveals tokenised stocks. */
export function LaunchesTab({ onOpen, selected }: { onOpen?: OpenLaunch; selected?: string }) {
  const { network } = useFundingNetwork();
  const [chip, setChip] = useState<ChainChip>(() => defaultChip(network));
  useEffect(() => { setChip(defaultChip(network)); }, [network]);
  const [stocks, setStocks] = useState(false);
  const [feed, setFeed] = useState<LaunchesResponse | null>(null);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    let active = true;
    const load = () => api.launches(launchQuery(chip, stocks))
      .then((value) => {
        if (!active) return;
        setFeed(value);
        setFailure(value.error || "");
      })
      .catch((reason) => {
        if (active) setFailure(reason instanceof Error ? reason.message : String(reason));
      });
    load();
    const timer = setInterval(load, LAUNCH_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [chip, stocks]);

  const now = Date.now();
  const rows = useMemo(() => sortNewestFirst(filterByChip(feed?.launches ?? [], chip)), [feed, chip]);
  const sources = feed?.sources ?? [];
  const failing = sources.filter((source) => source.lastError).length;

  return (
    <>
      <div className="launch-bar">
        {CHAIN_CHIPS.map((item) => <button key={item} type="button" className={chip === item ? "on" : ""} onClick={() => setChip(item)}>{item}</button>)}
        <button type="button" className={stocks ? "on" : ""} aria-pressed={stocks} title="Show tokenised stocks flagged by robinhoodtrenches" onClick={() => setStocks((value) => !value)}>STOCKS</button>
        <span className="pm" title={sources.map((source) => `${source.name}${source.lastError ? ` · ${source.lastError}` : ""}`).join("\n")}>
          {sources.length ? `${sources.length - failing}/${sources.length} SRC` : "SRC —"}{feed?.stale ? " · STALE" : ""}{feed?.truncated ? " · CAPPED" : ""}
        </span>
      </div>
      {rows.length ? (
        <table className="terminal-table launch-table">
          <thead><tr><th>AGE · PAD</th><th>TOKEN</th><th className="r">MCAP / PX</th><th className="r">CURVE · FOMO</th></tr></thead>
          <tbody>{rows.map((row) => <LaunchRowItem key={rowKey(row)} row={row} now={now} selected={selected} onOpen={onOpen} />)}</tbody>
        </table>
      ) : (
        <p className="empty-copy">{failure && !feed ? `Launch feed unavailable · ${failure}` : coldCopy(sources)}</p>
      )}
      {failure && feed ? <p className="empty-copy">Feed degraded · {failure}</p> : null}
    </>
  );
}
