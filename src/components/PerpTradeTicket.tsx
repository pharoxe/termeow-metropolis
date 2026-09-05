import { useState } from "react";
import { api, deepFind } from "../api/client";
import type { PublicConfig } from "../types";
import { PixelLoader } from "./PixelLoader";

export function PerpTradeTicket({ config, symbol = "SOL-PERP" }: { config: PublicConfig; symbol?: string }) {
  const [side, setSide] = useState<"bid" | "ask">("bid");
  const [quantity, setQuantity] = useState(0.1);
  const [collateral, setCollateral] = useState(25);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const payload = { symbol, side, orderType: "market", quantity, transferAmountUsdc: collateral, acknowledgeNoPriceGuard: true };

  const previewOrder = async () => {
    setLoading(true); setStatus(""); setConfirm(false);
    try { setPreview(await api.perpPreview(payload)); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };

  const execute = async () => {
    if (!preview || !confirm) return;
    setLoading(true);
    try {
      const previewId = String(preview.previewId || "");
      const result = await api.perpExecute({
        ...payload, previewId, confirmRisk: true,
        idempotencyKey: `${previewId}-${crypto.randomUUID()}`
      });
      setStatus(JSON.stringify(result));
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };

  return (
    <section className="panel trade-ticket">
      <div className="panel-title"><span>PHOENIX {symbol} ORDER</span><span className="tag">CLAWPUMP AGENT</span></div>
      <div className="side-tabs"><button className={side === "bid" ? "buy active" : ""} onClick={() => { setSide("bid"); setPreview(null); }}>LONG</button><button className={side === "ask" ? "sell active" : ""} onClick={() => { setSide("ask"); setPreview(null); }}>SHORT</button></div>
      <label>BASE QUANTITY<input type="number" min="0.0001" step="0.01" value={quantity} onChange={(event) => { setQuantity(Number(event.target.value)); setPreview(null); }} /></label>
      <label>ISOLATED COLLATERAL<div className="input-suffix"><input type="number" min="1" value={collateral} onChange={(event) => { setCollateral(Number(event.target.value)); setPreview(null); }} /><span>USDC</span></div></label>
      {!preview ? <button className="primary" onClick={previewOrder} disabled={loading}>{loading ? <PixelLoader label="PREVIEWING" /> : "PREVIEW PHOENIX ORDER"}</button> : (
        <div className="quote-box">
          <div><span>EST. ENTRY</span><b>{String(deepFind(preview, ["entryPrice", "price", "markPrice"]) || "See preview")}</b></div>
          <div><span>LIQUIDATION</span><b>{String(deepFind(preview, ["liquidationPrice", "liqPrice"]) || "—")}</b></div>
          <label className="confirm-row"><input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} /> I understand leverage, funding, liquidation, and agent-wallet execution.</label>
          <button className="primary execute" disabled={!confirm || loading || !config.executionEnabled} onClick={execute}>
            {!config.executionEnabled ? "TRADING UNAVAILABLE" : loading ? "SUBMITTING…" : "EXECUTE VIA CLAWPUMP"}
          </button>
        </div>
      )}
      {status && <p className="ticket-status">{status}</p>}
      <small className="disclaimer">Phoenix execution uses the configured ClawPump agent and requires explicit preview, risk confirmation, and idempotency.</small>
    </section>
  );
}
