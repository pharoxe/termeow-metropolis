import type { TokenFlowFomo, TokenFlowResponse } from "../../shared/wire";
import { largePrintRow, sinceAnchorLine, sourceChipState, windowRow } from "../lib/flowPanel";
import { fomoCoverageLabel, fomoWindowRows } from "../lib/fomoPanel";

const WINDOW_COLUMNS = ["WINDOW", "BUY", "SELL", "NET", "PRINTS", "AGGR"];

/** FOMO-cohort window totals: the same table as the all-flow windows, summed over FOMO-wallet fills alone. */
function FomoWindows({ fomo }: { fomo: TokenFlowFomo }) {
  const rows = fomoWindowRows(fomo);
  return (
    <div className="flow-fomo">
      <span className="pm flow-fomo-title">{fomoCoverageLabel(fomo.coverage)}</span>
      {rows.length ? (
        <table className="terminal-table flow-windows">
          <tbody>
            {rows.map((row) => (
              <tr className="static" key={row.label}>
                <td>{row.label}</td>
                <td className="r up">{row.buy}</td>
                <td className="r dn">{row.sell}</td>
                <td className={`r ${row.netTone}`}>{row.net}</td>
                <td className="r">{row.prints}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="empty-copy">No FOMO fills for this token in the ledger.</p>}
    </div>
  );
}

/** F4 side outputs under the FLOW coverage chip: source health, rolling windows, since-anchor totals, large prints. Tier A pairs only. */
export function FlowSideOutputs({ flow, now = Date.now() }: { flow: TokenFlowResponse | null; now?: number }) {
  if (!flow) return null;
  const sources = flow.sources ?? [];
  const windows = flow.windows ?? [];
  const prints = flow.largePrints ?? [];
  return (
    <div className="flow-side">
      <div className="flow-sources">
        {sources.map((chip) => {
          const state = sourceChipState(chip, now);
          return <span key={chip.name} className={`chip ${state.tone}`} title={state.title}>{state.label}</span>;
        })}
        {!sources.length && <span className="chip off" title="Collector status not reported">NO SOURCES</span>}
        <span className="pm">TIER A PAIRS · LEDGER</span>
      </div>
      {windows.length ? (
        <table className="terminal-table flow-windows">
          <thead><tr>{WINDOW_COLUMNS.map((column, index) => <th key={column} className={index ? "r" : ""}>{column}</th>)}</tr></thead>
          <tbody>
            {windows.map((window) => {
              const row = windowRow(window);
              return (
                <tr className="static" key={row.label}>
                  <td>{row.label}</td>
                  <td className="r up">{row.buy}</td>
                  <td className="r dn">{row.sell}</td>
                  <td className={`r ${row.netTone}`}>{row.net}</td>
                  <td className="r">{row.prints}</td>
                  <td className="r">{row.aggr}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <p className="empty-copy">No window totals in the ledger.</p>}
      <p className="pm flow-since">{sinceAnchorLine(flow.anchor, flow.sinceAnchor)}</p>
      {flow.fomo ? <FomoWindows fomo={flow.fomo} /> : null}
      <div className="flow-large">
        <span className="pm flow-large-title">LARGE PRINTS ≥ $1K</span>
        {prints.length
          ? prints.map((print) => {
            const row = largePrintRow(print, now);
            return (
              <p className={`tape-row ${row.tone}`} key={row.key} title={print.tx}>
                <span>{row.side}</span>
                <b>{row.usd}</b>
                <em>{row.dex} · {row.age}</em>
              </p>
            );
          })
          : <p className="empty-copy">No prints ≥ $1k in the ledger</p>}
      </div>
    </div>
  );
}
