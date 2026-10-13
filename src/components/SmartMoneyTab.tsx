import { useMemo, useState } from "react";
import { api } from "../api/client";
import type { InstrumentRef } from "../lib/address";
import { money, shortAddress, signedMoney } from "../lib/format";
import { printAgeLabel } from "../lib/flowPanel";
import { useResource } from "../lib/resource";

type View = "NETFLOW" | "TRADES";
type Window = "1H" | "24H" | "7D";
const NANSEN_PROFILE = "https://app.nansen.ai/profiler?chain=monad&address=";

/**
 * WatchPanel "SMART MONEY" tab: Nansen smart-money netflows (which tokens labelled wallets are accumulating) and their
 * latest DEX trades on Monad, polled through /api/onchain/smart-money every minute. Without NANSEN_API_KEY the tab says
 * so instead of showing an empty list as if nobody traded.
 */
export function SmartMoneyTab({ onOpen, selected }: { onOpen?: (ref: InstrumentRef, symbol?: string) => void; selected?: string }) {
  const [view, setView] = useState<View>("NETFLOW");
  const [window, setWindow] = useState<Window>("24H");
  const query = useResource("smart-money:monad", () => api.smartMoney(), 60_000);
  const data = query.data;
  const flows = useMemo(() => {
    const pick = (row: NonNullable<typeof data>["netflows"][number]) => window === "1H" ? row.netFlow1hUsd : window === "7D" ? row.netFlow7dUsd : row.netFlow24hUsd;
    return [...(data?.netflows ?? [])].filter((row) => pick(row) != null).sort((a, b) => (pick(b) ?? 0) - (pick(a) ?? 0)).map((row) => ({ row, net: pick(row) ?? 0 }));
  }, [data, window]);
  const now = Date.now();
  if (data && !data.configured) {
    return <div className="smart-money-empty">
      <p className="empty-copy">Nansen smart money is not configured on this server.</p>
      <p className="empty-copy">Set <code>NANSEN_API_KEY</code> to list the tokens Nansen-labelled wallets are accumulating on Monad and their live DEX trades.</p>
    </div>;
  }
  return <>
    <div className="launch-bar">
      {(["NETFLOW", "TRADES"] as View[]).map((item) => <button key={item} type="button" className={view === item ? "on" : ""} onClick={() => setView(item)}>{item}</button>)}
      {view === "NETFLOW" ? (["1H", "24H", "7D"] as Window[]).map((item) => <button key={item} type="button" className={window === item ? "on" : ""} onClick={() => setWindow(item)}>{item}</button>) : null}
      <span className="pm" title="Nansen smart-money cohorts on chain monad">NANSEN · MONAD{data?.error ? " · DEGRADED" : ""}</span>
    </div>
    {query.error && !data ? <p className="empty-copy">Smart money unavailable · {query.error}</p> : null}
    {view === "NETFLOW" ? (
      flows.length ? <table className="terminal-table smart-money-table">
        <thead><tr><th>TOKEN</th><th className="r">NET {window}</th><th className="r">WALLETS · MCAP</th></tr></thead>
        <tbody>{flows.slice(0, 40).map(({ row, net }) => <tr key={row.token} className={row.token === selected?.toLowerCase() ? "selected" : ""} title={row.token} onClick={() => onOpen?.({ chain: "monad", address: row.token }, row.symbol ?? undefined)}>
          <td><b>{row.symbol ?? shortAddress(row.token)}</b><small>{row.sectors.slice(0, 2).join(" · ") || shortAddress(row.token)}</small></td>
          <td className={`r ${net >= 0 ? "up" : "dn"}`}><b className={net >= 0 ? "up" : "dn"}>{signedMoney(net)}</b></td>
          <td className="r"><b>{row.traderCount ?? "—"}</b><small className="mcap-value">{money(row.marketCapUsd, true)}</small></td>
        </tr>)}</tbody>
      </table> : <p className="empty-copy">{data ? "No smart-money netflow reported for Monad in this window." : "Loading smart-money netflows…"}</p>
    ) : (
      (data?.trades.length ?? 0) ? <table className="terminal-table smart-money-table">
        <thead><tr><th>WALLET</th><th>TRADE</th><th className="r">USD · AGE</th></tr></thead>
        <tbody>{data!.trades.slice(0, 60).map((trade) => <tr key={`${trade.tx}:${trade.trader}`} title={`${trade.trader} · ${trade.tx}`} onClick={() => onOpen?.({ chain: "monad", address: trade.boughtToken }, trade.boughtSymbol ?? undefined)}>
          <td><a href={`${NANSEN_PROFILE}${trade.trader}`} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}><b>{trade.label ?? shortAddress(trade.trader)}</b></a><small>{shortAddress(trade.trader)}</small></td>
          <td><b className="up">{trade.boughtSymbol ?? shortAddress(trade.boughtToken)}</b><small>for {trade.soldSymbol ?? shortAddress(trade.soldToken)}</small></td>
          <td className="r"><b>{money(trade.valueUsd, true)}</b><small>{printAgeLabel(trade.time, now)}</small></td>
        </tr>)}</tbody>
      </table> : <p className="empty-copy">{data ? "No smart-money DEX trades on Monad in the last 24h." : "Loading smart-money trades…"}</p>
    )}
  </>;
}
