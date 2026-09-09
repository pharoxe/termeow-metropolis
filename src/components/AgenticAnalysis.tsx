import { useEffect, useMemo, useState } from "react";
import { useSignAndSendTransaction, useWallets } from "@privy-io/react-auth/solana";
import type { Candle, OnchainMarket, PublicConfig } from "../types";
import { analyzeToken, type AgentTradeSetup, type AnalysisFlow } from "../lib/agenticAnalysis";
import { api, deepFind } from "../api/client";
import { money, pct, signedMoney } from "../lib/format";
import { useNotifications } from "./NotificationSystem";
import { hasPrivy } from "../auth/WalletProviders";
import { useFundingNetwork } from "../features/NetworkContext";

type Props = {
  open: boolean;
  market: OnchainMarket;
  candles: Candle[];
  /** One named Tier A flow window from /api/flow/token; null until the poll has windows. */
  flow: AnalysisFlow | null;
  provider: unknown;
  config: PublicConfig;
  onClose(): void;
};

function decodeBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function PrivyAgenticAnalysisPanel(props: Props) {
  const { wallets } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const wallet = wallets[0];
  return <AnalysisSurface {...props} walletAddress={wallet?.address} send={wallet ? async transaction => {
    const result = await signAndSendTransaction({ transaction, wallet, chain: "solana:mainnet" });
    return Array.from(result.signature).map(byte => byte.toString(16).padStart(2, "0")).join("");
  } : undefined} />;
}

export function AgenticAnalysisPanel(props: Props) {
  return hasPrivy ? <PrivyAgenticAnalysisPanel {...props} /> : <AnalysisSurface {...props} />;
}

function AnalysisSurface({ open, market, candles, flow, provider, config, onClose, walletAddress, send }: Props & { walletAddress?: string; send?: (transaction: Uint8Array) => Promise<string> }) {
  const { notify } = useNotifications();
  const { network } = useFundingNetwork();
  const [selected, setSelected] = useState<AgentTradeSetup | null>(null);
  const [notional, setNotional] = useState("100");
  const [slippage, setSlippage] = useState("0.5");
  const [reviewed, setReviewed] = useState(false);
  const [executionMessage, setExecutionMessage] = useState("");
  const analysis = useMemo(() => analyzeToken({ market, candles, flow, provider }), [market, candles, flow, provider]);

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
    if (!selected || !walletAddress || !reviewed || !send || network !== "solana") return;
    setExecutionMessage("Preparing the Privy wallet transaction…");
    try {
      const input = { chain: "solana" as const, router: "jupiter" as const, inputMint: config.usdcMint, outputMint: market.mint, amount: String(Math.round(Number(notional) * 1_000_000)), slippageBps: Math.round(Number(slippage) * 100), walletAddress };
      const quote = await api.quote(input);
      const payload = await api.transaction({ ...input, quoteId: quote.quoteId });
      const base64 = deepFind(payload, ["transaction", "swapTransaction", "unsignedTransaction", "serializedTransaction"]);
      if (typeof base64 !== "string") throw new Error("The selected router did not return a recognizable unsigned transaction");
      const signature = await send(decodeBase64(base64));
      setExecutionMessage(`Submitted · ${signature.slice(0, 12)}…`);
      notify({ title: "AGENT TRADE SUBMITTED", message: `${market.symbol} execution was submitted successfully.`, tone: "success" });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setExecutionMessage(message);
      notify({ title: "TRADE NOT SENT", message, tone: "warning" });
    }
  };

  return <div className="analysis-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="analysis-drawer" role="dialog" aria-modal="true" aria-labelledby="agentic-analysis-title">
      <header className="analysis-header">
        <div><small>CLAWPUMP SIGNAL SYNTHESIS</small><h2 id="agentic-analysis-title">ANALYZE {market.symbol}</h2></div>
        <button type="button" className="analysis-close" aria-label="Close analysis" onClick={onClose}>×</button>
      </header>

      <section className="analysis-verdict">
        <div><span className={`analysis-signal ${analysis.signal === "BUY WATCH" ? "up" : analysis.signal === "RISK OFF" ? "dn" : ""}`}>{analysis.signal}</span><b>{analysis.confidence}/100 SETUP SCORE</b></div>
        <p>{analysis.summary}</p>
      </section>

      <dl className="analysis-metrics">
        <div><dt>PRICE</dt><dd>{money(market.priceUsd)}</dd></div>
        <div><dt>24H CHANGE</dt><dd className={(market.change24hPct || 0) >= 0 ? "up" : "dn"}>{pct(market.change24hPct)}</dd></div>
        <div><dt>LIQUIDITY</dt><dd>{money(market.liquidityUsd, true)}</dd></div>
        <div><dt>24H VOLUME</dt><dd>{money(market.volume24hUsd, true)}</dd></div>
        <div><dt>STOCH RSI K / D</dt><dd>{analysis.stochK?.toFixed(1) ?? "—"} / {analysis.stochD?.toFixed(1) ?? "—"}</dd></div>
        <div><dt>NET FLOW {analysis.flowWindow ?? "—"}</dt><dd className={(analysis.netFlowUsd || 0) >= 0 ? "up" : "dn"}>{analysis.netFlowUsd == null ? "—" : signedMoney(analysis.netFlowUsd)}</dd></div>
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
          <span className="analysis-option-footer"><b>{setup.confidence}/100</b><em>SELECT SETUP →</em></span>
        </button>)}
      </div>

      {selected && <section className="analysis-confirmation">
        <div className="ph"><span className="pt">CONFIRM OPTION {selected.option}</span><span className="pm">AUTOMATED SPOT INTENT</span></div>
        <p>The agent will monitor every listed condition, request the route when they converge, and execute only inside these limits.</p>
        <div className="analysis-order-grid">
          <label>NOTIONAL USDC<input type="number" min="1" step="1" value={notional} onChange={(event) => setNotional(event.target.value)} /></label>
          <label>MAX SLIPPAGE %<input type="number" min="0.01" max="5" step="0.01" value={slippage} onChange={(event) => setSlippage(event.target.value)} /></label>
        </div>
        <div className="analysis-order-summary"><span>SIDE <b className="up">BUY</b></span><span>ENTRY <b>{money(selected.entryPrice)}</b></span><span>EXIT <b>{selected.exitPrice ? money(selected.exitPrice) : "CONDITION-LED"}</b></span></div>
        <label className="analysis-review"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} /><span>I reviewed the trigger, amount, slippage, and exit logic.</span></label>
        <div className="session-guard"><b>PRIVY EMBEDDED WALLET</b><span>Execution requires the Solana wallet and a final user confirmation.</span></div>
        <button type="button" className="primary analysis-execute" disabled={network !== "solana" || !walletAddress || !reviewed || !(Number(notional) > 0)} onClick={() => void execute()}>{network !== "solana" ? "SWITCH TO SOLANA" : walletAddress ? "EXECUTE TRADE" : "LOG IN TO EXECUTE"}</button>
        {executionMessage && <p className="analysis-execution-message" role="status">{executionMessage}</p>}
      </section>}

      <footer className="analysis-disclosure">Signals are decision support, not guarantees. Execution remains bounded by wallet authorization, price, and slippage policy.</footer>
    </aside>
  </div>;
}
