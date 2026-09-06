import { useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { api, deepFind } from "../api/client";
import type { PublicConfig } from "../types";
import { shortAddress } from "../lib/format";
import { PixelLoader } from "./PixelLoader";
import { useNotifications } from "./NotificationSystem";

function decodeBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function SpotTradeTicket({ config, mint, symbol }: { config: PublicConfig; mint?: string; symbol?: string }) {
  const { notify } = useNotifications();
  const tokenMint = mint || config.ansemMint;
  const tokenSymbol = (symbol || "TOKEN").toUpperCase();
  const { publicKey, sendTransaction, connected } = useWallet();
  const { connection } = useConnection();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("25");
  const [slippagePct, setSlippagePct] = useState(0.5);
  const [quote, setQuote] = useState<Record<string, unknown> | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const input = useMemo(() => side === "buy"
    ? { inputMint: config.usdcMint, outputMint: tokenMint, amount: String(Math.round(Number(amount || 0) * 1_000_000)) }
    : { inputMint: tokenMint, outputMint: config.usdcMint, amount: String(Math.round(Number(amount || 0) * 1_000_000)) },
  [side, amount, config, tokenMint]);
  const slippageBps = Math.round(Math.min(5, Math.max(0.01, Number.isFinite(slippagePct) ? slippagePct : 0.5)) * 100);

  const getQuote = async () => {
    setLoading(true); setStatus(""); setConfirmed(false);
    try {
      setQuote(await api.quote({ ...input, slippageBps, walletAddress: publicKey?.toBase58() }));
      notify({ title: "ROUTE READY", message: `${side.toUpperCase()} ${tokenSymbol} quote is ready for review.`, tone: "success" });
    } catch (error) { const message = error instanceof Error ? error.message : String(error); setStatus(message); notify({ title: "QUOTE UNAVAILABLE", message, tone: "warning" }); }
    finally { setLoading(false); }
  };

  const execute = async () => {
    if (!publicKey || !quote || !confirmed) return;
    setLoading(true); setStatus("Requesting unsigned transaction from ClawPump…");
    try {
      const payload = await api.transaction({ ...input, slippageBps, walletAddress: publicKey.toBase58(), quoteId: quote.quoteId });
      const base64 = deepFind(payload, ["transaction", "swapTransaction", "unsignedTransaction", "serializedTransaction"]);
      if (typeof base64 !== "string") throw new Error("ClawPump did not return a recognizable unsigned transaction");
      const transaction = VersionedTransaction.deserialize(decodeBase64(base64));
      setStatus("Confirm the transaction in your wallet…");
      const signature = await sendTransaction(transaction, connection, { skipPreflight: false, maxRetries: 3 });
      setStatus(`Submitted ${signature}`);
      notify({ title: "TRADE SUBMITTED", message: `${side.toUpperCase()} ${tokenSymbol} was sent to Solana.`, tone: "success" });
    } catch (error) { const message = error instanceof Error ? error.message : String(error); setStatus(message); notify({ title: "TRADE NOT SENT", message, tone: "warning" }); }
    finally { setLoading(false); }
  };

  const outAmount = deepFind(quote, ["outAmount", "outputAmount"]);
  const impact = deepFind(quote, ["priceImpactPct", "priceImpact"]);

  return (
    <section className="panel trade-ticket">
      <div className="panel-title"><span>SPOT ORDER</span><span className="tag">CLAWPUMP ROUTER</span></div>
      <div className="side-tabs"><button className={side === "buy" ? "buy active" : ""} onClick={() => { setSide("buy"); setQuote(null); }}>BUY {tokenSymbol}</button><button className={side === "sell" ? "sell active" : ""} onClick={() => { setSide("sell"); setQuote(null); }}>SELL {tokenSymbol}</button></div>
      <label>NOTIONAL {side === "buy" ? "USDC" : tokenSymbol}<input type="number" min="0" value={amount} onChange={(event) => { setAmount(event.target.value); setQuote(null); }} /></label>
      <label>MAX SLIPPAGE <div className="input-suffix"><input type="number" min="0.01" max="5" step="0.01" value={slippagePct} onChange={(event) => { setSlippagePct(Number(event.target.value)); setQuote(null); }} /><span>%</span></div></label>
      <div className="wallet-line"><span>SIGNER</span><b>{shortAddress(publicKey?.toBase58())}</b></div>
      {!quote ? <button className="primary" disabled={loading || !Number(amount)} onClick={getQuote}>{loading ? <PixelLoader label="QUOTING" /> : "PREVIEW ROUTE"}</button> : (
        <div className="quote-box">
          <div><span>EXPECTED OUTPUT</span><b>{outAmount == null ? "See route payload" : String(outAmount)}</b></div>
          <div><span>PRICE IMPACT</span><b>{impact == null ? "—" : `${impact}%`}</b></div>
          <label className="confirm-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I verified the mint, route, amount, and mainnet risk.</label>
          <button className="primary execute" disabled={!connected || !confirmed || loading || !config.executionEnabled} onClick={execute}>
            {!config.executionEnabled ? "TRADING UNAVAILABLE" : !connected ? "CONNECT DIRECT WALLET" : loading ? "WORKING…" : "SIGN & SUBMIT"}
          </button>
        </div>
      )}
      {status && <p className="ticket-status">{status}</p>}
    </section>
  );
}
