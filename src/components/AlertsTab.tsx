import { useEffect, useMemo, useRef, useState } from "react";
import type { AlertsResponse } from "../../shared/wire";
import { api } from "../api/client";
import type { InstrumentRef } from "../lib/address";
import {
  ALERTS_POLL_MS,
  ALERT_TOASTS_PER_POLL,
  alertQuery,
  alertRowView,
  alertToast,
  alertsHeader,
  coldCopy,
  sortNewestFirst,
  unseenAlerts,
  withSeen
} from "../lib/alerts";
import { CHAIN_CHIPS, type ChainChip } from "../lib/launches";
import { useNotifications } from "./NotificationSystem";

type OpenAlert = (ref: InstrumentRef, symbol?: string) => void;

/**
 * WatchPanel ALERTS tab: polls /api/alerts every 15 s, newest first. Each row names its
 * evidence (wallet or handle, followers, usd or "unpriced", launchpad, launch age) and its chain time in IST; the header
 * carries the SMART coverage the alerts were measured under. Alerts unseen since the previous poll raise a toast through
 * the shared NotificationSystem (deduped by alert id; the first load only seeds the seen set, so a reload is silent).
 */
export function AlertsTab({ onOpen, selected }: { onOpen?: OpenAlert; selected?: string }) {
  const { notify } = useNotifications();
  const [chip, setChip] = useState<ChainChip>("ALL");
  const [feed, setFeed] = useState<AlertsResponse | null>(null);
  const [failure, setFailure] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const seen = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    let active = true;
    // A chip switch re-seeds: rows of the newly selected scope are history, not news.
    seen.current = null;
    const load = () => api.alerts(alertQuery(chip))
      .then((value) => {
        if (!active) return;
        setFeed(value);
        setNow(Date.now());
        setFailure(value.error ?? "");
        const fresh = seen.current ? unseenAlerts(value.alerts, seen.current) : [];
        seen.current = withSeen(seen.current ?? new Set<string>(), value.alerts);
        fresh.slice(0, ALERT_TOASTS_PER_POLL).forEach((row) => {
          const toast = alertToast(row);
          notify({ title: toast.title, message: toast.message, tone: toast.tone });
        });
      })
      .catch((reason) => active && setFailure(reason instanceof Error ? reason.message : String(reason)));
    load();
    const timer = setInterval(load, ALERTS_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [chip, notify]);

  const rows = useMemo(() => sortNewestFirst(feed?.alerts ?? []), [feed]);
  const chain = alertQuery(chip).chain;
  return (
    <>
      <div className="launch-bar">
        {CHAIN_CHIPS.length > 1 ? CHAIN_CHIPS.map((item) => <button key={item} type="button" className={chip === item ? "on" : ""} onClick={() => setChip(item)}>{item}</button>) : null}
        <span className="pm" title={(feed?.rules ?? []).map((rule) => `${rule.rule}: ${rule.description}`).join("\n") || undefined}>
          {alertsHeader(rows.length, feed?.coverage, feed?.ring.size, feed?.ring.max, feed?.engine?.errors ?? 0)}{feed?.stale ? " · STALE" : ""}
        </span>
      </div>
      {failure ? <p className="empty-copy">Alerts degraded · {failure}</p> : null}
      {rows.length ? (
        <table className="terminal-table alert-table">
          <thead><tr><th>RULE · IST</th><th>TOKEN</th><th className="r">EVIDENCE</th></tr></thead>
          <tbody>
            {rows.map((row) => {
              const view = alertRowView(row, now);
              return (
                <tr key={view.key} className={row.token.toLowerCase() === selected?.toLowerCase() ? "selected" : ""} title={view.title} onClick={() => onOpen?.(view.instrument, row.symbol ?? undefined)}>
                  <td><span className={`chip ${view.tone}`}>{view.badge}</span><small>{view.clock} IST · {view.age} ago</small></td>
                  <td><b>{view.token}</b><small><span className="chip">{view.chain}</span>{view.lag ? <span className="alert-lag">{view.lag}</span> : null}</small></td>
                  <td className="r"><small>{view.evidence}</small></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <p className="empty-copy">{failure && !feed ? "" : coldCopy(chain)}</p>}
    </>
  );
}
