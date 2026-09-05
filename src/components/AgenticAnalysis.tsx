import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { Candle, OnchainMarket, PoolCvd } from "../types";
import { analyzeToken, type AgentTradeSetup } from "../lib/agenticAnalysis";
import { magicBlockSessionAdapter } from "../lib/agenticExecution";
import { money, pct, signedMoney } from "../lib/format";
import SpecularButton from "./effects/SpecularButton";

type Props = {
  open: boolean;
  market: OnchainMarket;
  candles: Candle[];
  cvd: Pick<PoolCvd, "buyUsdRecent" | "sellUsdRecent" | "flow"> | null;
  provider: unknown;
  onClose(): void;
};

export function AgenticAnalysisPanel({ open, market, candles, cvd, provider, onClose }: Props) {
  const { connected } = useWallet();
  const [selected, setSelected] = useState<AgentTradeSetup | null>(null);
  const [notional, setNotional] = useState("100");
  const [slippage, setSlippage] = useState("50");
  const [reviewed, setReviewed] = useState(false);
  const [executionMessage, setExecutionMessage] = useState("");
  const analysis = useMemo(() => analyzeToken({ market, candles, cvd, provider }), [market, candles, cvd, provider]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  useEffect(() => {
    setSelected(null);
    setReviewed(false);
    setExecutionMessage("");
  }, [market.mint]);

  if (!open) return null;

  const choose = (setup: AgentTradeSetup) => {
    setSelected(setup);
    setReviewed(false);
    setExecutionMessage("");
  };
  const execute = async () => {
    if (!selected || !connected || !reviewed) return;
    setExecutionMessage("Preparing session-authorized intent…");
    try {
      const result = await magicBlockSessionAdapter.execute({
        mint: market.mint,
        symbol: market.symbol,
        setup: selected,
        notionalUsd: Number(notional),
        maxSlippageBps: Number(slippage)
      });
      setExecutionMessage(`Submitted · ${result.signature}`);
    } catch (reason) {
      setExecutionMessage(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return <div className="analysis-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="analysis-drawer" role="dialog" aria-modal="true" aria-labelledby="agentic-analysis-title">
      <header className="analysis-header">
        <div><small>CLAWPUMP SIGNAL SYNTHESIS</small><h2 id="agentic-analysis-title">ANALYZE {market.symbol}</h2></div>
        <button type="button" className="analysis-close" aria-label="Close analysis" onClick={onClose}>×</button>
      </header>

      <section className="analysis-verdict">
        <div><span className={`analysis-signal ${analysis.signal === "BUY WATCH" ? "up" : analysis.signal === "RISK OFF" ? "dn" : ""}`}>{analysis.signal}</span><b>{analysis.confidence}% CONFIDENCE</b></div>
        <p>{analysis.summary}</p>
      </section>

      <dl className="analysis-metrics">
        <div><dt>PRICE</dt><dd>{money(market.priceUsd)}</dd></div>
        <div><dt>24H CHANGE</dt><dd className={(market.change24hPct || 0) >= 0 ? "up" : "dn"}>{pct(market.change24hPct)}</dd></div>
        <div><dt>LIQUIDITY</dt><dd>{money(market.liquidityUsd, true)}</dd></div>
        <div><dt>24H VOLUME</dt><dd>{money(market.volume24hUsd, true)}</dd></div>
        <div><dt>STOCH RSI K / D</dt><dd>{analysis.stochK?.toFixed(1) ?? "—"} / {analysis.stochD?.toFixed(1) ?? "—"}</dd></div>
        <div><dt>RECENT CVD DELTA</dt><dd className={(analysis.cvdDelta || 0) >= 0 ? "up" : "dn"}>{analysis.cvdDelta == null ? "—" : signedMoney(analysis.cvdDelta)}</dd></div>
        <div><dt>LOCAL SUPPORT</dt><dd>{money(analysis.support)}</dd></div>
        <div><dt>LOCAL RESISTANCE</dt><dd>{money(analysis.resistance)}</dd></div>
      </dl>

      <div className="analysis-options" aria-label="Suggested trade setups">
        {analysis.setups.map((setup) => <button type="button" key={setup.id} className={`analysis-option${selected?.id === setup.id ? " selected" : ""}`} onClick={() => choose(setup)}>
          <span className="analysis-option-index">OPTION {setup.option}</span>
          <span className="analysis-option-title">{setup.title}</span>
          <span className="analysis-option-price">{setup.entryLabel} · {money(setup.entryPrice)}{setup.exitPrice ? ` → ${money(setup.exitPrice)}` : ""}</span>
          <span className="analysis-option-copy">{setup.rationale}</span>
          <span className="analysis-condition-row">{setup.conditions.map((condition) => <i key={condition.label} className={condition.met ? "met" : ""}>{condition.met ? "◆" : "◇"} {condition.label}</i>)}</span>
          <span className="analysis-option-footer"><b>{setup.confidence}%</b><em>SELECT SETUP →</em></span>
        </button>)}
      </div>

      {selected && <section className="analysis-confirmation">
        <div className="ph"><span className="pt">CONFIRM OPTION {selected.option}</span><span className="pm">AUTOMATED SPOT INTENT</span></div>
        <p>The agent will monitor every listed condition, request the route when they converge, and execute only inside these limits.</p>
        <div className="analysis-order-grid">
          <label>NOTIONAL USDC<input type="number" min="1" step="1" value={notional} onChange={(event) => setNotional(event.target.value)} /></label>
          <label>MAX SLIPPAGE BPS<input type="number" min="1" max="500" step="1" value={slippage} onChange={(event) => setSlippage(event.target.value)} /></label>
        </div>
        <div className="analysis-order-summary"><span>SIDE <b className="up">BUY</b></span><span>ENTRY <b>{money(selected.entryPrice)}</b></span><span>EXIT <b>{selected.exitPrice ? money(selected.exitPrice) : "CONDITION-LED"}</b></span></div>
        <label className="analysis-review"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} /><span>I reviewed the trigger, amount, slippage, and exit logic.</span></label>
        <div className="session-guard"><b>SESSION KEY REQUIRED</b><span>Automatic signing is not active yet. This preview cannot move funds.</span></div>
        <SpecularButton className="analysis-execute" tint="#39ff88" tintOpacity={0.16} lineColor="#8affb4" textColor="var(--text)" disabled={!connected || !reviewed || !(Number(notional) > 0)} onClick={() => void execute()}>{connected ? "EXECUTE TRADE" : "CONNECT WALLET TO EXECUTE"}</SpecularButton>
        {executionMessage && <p className="analysis-execution-message" role="status">{executionMessage}</p>}
      </section>}

      <footer className="analysis-disclosure">Signals are decision support, not guarantees. Execution remains bounded by wallet authorization, price, and slippage policy.</footer>
    </aside>
  </div>;
}
