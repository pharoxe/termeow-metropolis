import type { OnchainMarket } from "../types";

export function EvidencePanel({ market }: { market: OnchainMarket }) {
  return (
    <section className="panel evidence-panel">
      <div className="panel-title"><span>ONCHAIN EVIDENCE</span><span className={market.degraded ? "tag warning" : "tag live-tag"}>{market.source}</span></div>
      <div className="signal-grid">
        {market.signals.map((signal) => <div className={signal.tone} key={signal.label}><small>{signal.label}</small><strong>{String(signal.value ?? "—")}</strong></div>)}
      </div>
      <dl>
        <div><dt>MINT</dt><dd title={market.mint}>{market.mint}</dd></div>
        <div><dt>DEX</dt><dd>{market.dex || "—"}</dd></div>
        <div><dt>PAIR</dt><dd title={market.pairAddress || ""}>{market.pairAddress || "—"}</dd></div>
        <div><dt>OBSERVED</dt><dd>{new Date(market.observedAt).toLocaleTimeString()}</dd></div>
      </dl>
      {market.notes.map((note) => <p className="coverage-note" key={note}>{note}</p>)}
    </section>
  );
}
