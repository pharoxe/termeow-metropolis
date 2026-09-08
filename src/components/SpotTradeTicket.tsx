import { tokenAmount } from "../lib/tokenAmount";
import { useEffect, useRef, useState } from "react";
import { useSignAndSendTransaction, useWallets } from "@privy-io/react-auth/solana";
import { api, deepFind } from "../api/client";
import type { PublicConfig } from "../types";
import { shortAddress } from "../lib/format";
import { PixelLoader } from "./PixelLoader";
import { useNotifications } from "./NotificationSystem";
import { useFundingNetwork } from "../features/NetworkContext";
import { hasPrivy } from "../auth/WalletProviders";

function decodeBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

type Props = { config: PublicConfig; mint?: string; symbol?: string };

function PrivySpotTradeTicket(props: Props) {
  const { wallets } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  return <TradeTicketSurface {...props} walletAddress={wallets[0]?.address} send={async transaction => {
    const result = await signAndSendTransaction({ transaction, wallet: wallets[0], chain: "solana:mainnet" });
    return Array.from(result.signature).map(byte => byte.toString(16).padStart(2, "0")).join("");
  }} />;
}

export function SpotTradeTicket(props: Props) {
  return hasPrivy ? <PrivySpotTradeTicket {...props} /> : <TradeTicketSurface {...props} />;
}

function TradeTicketSurface({ config, mint, symbol, walletAddress, send }: Props & { walletAddress?: string; send?: (transaction: Uint8Array) => Promise<string> }) {
  const { notify } = useNotifications();
  const { network, setNetwork } = useFundingNetwork();
  const tokenMint = mint || config.ansemMint;
  const tokenSymbol = (symbol || "TOKEN").toUpperCase();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("25");
  const [slippagePct, setSlippagePct] = useState(0.5);
  const [quote, setQuote] = useState<Record<string, unknown> | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const revision = useRef(0);
  const orderRef = useRef<Record<string, unknown> | null>(null);
  const invalidate = () => { revision.current++; orderRef.current = null; setQuote(null); setConfirmed(false); };
  useEffect(() => { invalidate(); return () => { revision.current++; }; }, [tokenMint, walletAddress, network]);
  useEffect(() => {
    if (!quote || loading) return;
    const timer = setTimeout(invalidate, Math.max(0, Number(quote.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [quote, loading]);
  const slippageBps = Math.round(Math.min(5, Math.max(0.01, Number.isFinite(slippagePct) ? slippagePct : 0.5)) * 100);

  const getQuote = async () => {
    if (network !== "solana") { setNetwork("solana"); setStatus("Switched to the Solana wallet for spot execution."); return; }
    const requestRevision = ++revision.current;
    setLoading(true); setStatus(""); setConfirmed(false);
    try {
      const inputMint = side === "buy" ? config.usdcMint : tokenMint;
      const outputMint = side === "buy" ? tokenMint : config.usdcMint;
      const supply = await api.rpc<{ value: { decimals: number } }>("getTokenSupply", [inputMint]);
      const input = { inputMint, outputMint, amount: tokenAmount(amount, supply.value.decimals), slippageBps, walletAddress };
      const result = await api.quote(input);
      if (revision.current !== requestRevision) return;
      orderRef.current = input;
      setQuote(result);
      notify({ title: "ROUTE READY", message: `${side.toUpperCase()} ${tokenSymbol} quote is ready for review.`, tone: "success" });
    } catch (error) { const message = error instanceof Error ? error.message : String(error); setStatus(message); notify({ title: "QUOTE UNAVAILABLE", message, tone: "warning" }); }
    finally { setLoading(false); }
  };
  const execute = async () => {
    if (!walletAddress || !quote || !confirmed || !send || network !== "solana" || !orderRef.current) return;
    if (Number(quote.expiresAt) <= Date.now()) { invalidate(); setStatus("Quote expired. Preview a new route."); return; }
    const executionRevision = revision.current;
    setLoading(true); setStatus("Preparing the Privy wallet transaction…");
    try {
      const payload = await api.transaction({ ...orderRef.current, quoteId: quote.quoteId });
      if (executionRevision !== revision.current) throw new Error("Wallet or order changed. Preview a new route.");
      const base64 = deepFind(payload, ["transaction", "swapTransaction", "unsignedTransaction", "serializedTransaction"]);
      if (typeof base64 !== "string") throw new Error("ClawPump did not return a recognizable unsigned transaction");
      setStatus("Confirm with your Privy embedded wallet…");
      const signature = await send(decodeBase64(base64));
      invalidate();
      setStatus(`Submitted ${shortAddress(signature)}`);
      notify({ title: "TRADE SUBMITTED", message: `${side.toUpperCase()} ${tokenSymbol} was sent to Solana.`, tone: "success" });
    } catch (error) { invalidate(); const message = error instanceof Error ? error.message : String(error); setStatus(message); notify({ title: "TRADE NOT SENT", message, tone: "warning" }); }
    finally { setLoading(false); }
  };
  const outAmount = deepFind(quote, ["outAmount", "outputAmount"]);
  const impact = deepFind(quote, ["priceImpactPct", "priceImpact"]);
  const executable = Boolean(config.executionEnabled && network === "solana" && walletAddress && send);

  return <section className="panel trade-ticket">
    <div className="panel-title"><span>SPOT ORDER</span><span className="tag">PRIVY · CLAWPUMP</span></div>
    <div className="side-tabs"><button disabled={loading} className={side === "buy" ? "buy active" : ""} onClick={() => { setSide("buy"); invalidate(); }}>BUY {tokenSymbol}</button><button disabled={loading} className={side === "sell" ? "sell active" : ""} onClick={() => { setSide("sell"); invalidate(); }}>SELL {tokenSymbol}</button></div>
    <label>NOTIONAL {side === "buy" ? "USDC" : tokenSymbol}<input disabled={loading} type="number" min="0" value={amount} onChange={event => { setAmount(event.target.value); invalidate(); }} /></label>
    <label>MAX SLIPPAGE <div className="input-suffix"><input disabled={loading} type="number" min="0.01" max="5" step="0.01" value={slippagePct} onChange={event => { setSlippagePct(Number(event.target.value)); invalidate(); }} /><span>%</span></div></label>
    <div className="wallet-line"><span>SOLANA SIGNER</span><b>{shortAddress(walletAddress)}</b></div>
    {!quote ? <button className="primary" disabled={loading || !Number(amount)} onClick={() => void getQuote()}>{network !== "solana" ? "SWITCH TO SOLANA" : loading ? <PixelLoader label="QUOTING" /> : "PREVIEW ROUTE"}</button> : <div className="quote-box">
      <div><span>EXPECTED OUTPUT</span><b>{outAmount == null ? "See route payload" : String(outAmount)}</b></div>
      <div><span>PRICE IMPACT</span><b>{impact == null ? "—" : `${impact}%`}</b></div>
      <label className="confirm-row"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I verified the mint, route, amount, and mainnet risk.</label>
      <button className="primary execute" disabled={!executable || !confirmed || loading} onClick={() => void execute()}>{!config.executionEnabled ? "TRADING UNAVAILABLE" : network !== "solana" ? "SWITCH TO SOLANA" : !walletAddress ? "LOG IN TO EXECUTE" : loading ? "WORKING…" : "SIGN & SUBMIT"}</button>
    </div>}
    {status && <p className="ticket-status">{status}</p>}
  </section>;
}
