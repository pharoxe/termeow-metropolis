import { useEffect, useMemo, useRef, useState } from "react";
import type { AlertsResponse } from "../../shared/wire";
import { api } from "../api/client";
import type { InstrumentRef } from "../lib/address";
import { ALERTS_POLL_MS, ALERT_TOASTS_PER_POLL, alertRowView, alertToast, sortNewestFirst, unseenAlerts, withSeen } from "../lib/alerts";
import { useNotifications } from "./NotificationSystem";

/** Alert rules now surface where traders consume them: the Live Feed bubble stream. */
export function LiveAlertBubbles({ onOpen }: { onOpen?: (ref: InstrumentRef, symbol?: string) => void }) {
  const { notify } = useNotifications();
  const [feed, setFeed] = useState<AlertsResponse | null>(null);
  const [failure, setFailure] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const seen = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => api.alerts({ chain: "all", limit: 24 }).then((value) => {
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
    }).catch((reason) => active && setFailure(reason instanceof Error ? reason.message : String(reason)));
    load();
    const timer = setInterval(load, ALERTS_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [notify]);

  const alerts = useMemo(() => sortNewestFirst(feed?.alerts ?? []).slice(0, 8), [feed]);
  return <>
    {failure && !alerts.length ? <p className="empty-copy">Alerts degraded · {failure}</p> : null}
    {alerts.map((row) => {
      const view = alertRowView(row, now);
      return <article className={`social-bubble alert ${view.tone} ${view.side ?? ""}`} key={`alert-${view.key}`} title={view.title}>
        <div className="social-bubble-top"><span>{view.badge}</span><i>{view.chain} · {view.age}</i></div>
        {view.xUrl && <a className="signal-handle" href={view.xUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>@{view.xHandle} ↗</a>}
        <button type="button" className="social-bubble-chart" onClick={() => onOpen?.(view.instrument, row.symbol ?? undefined)}>
          <b>${view.token}</b><p>{view.evidence}{view.lag ? ` · ${view.lag}` : ""}</p><em>OPEN CHART →</em>
        </button>
      </article>;
    })}
  </>;
}
