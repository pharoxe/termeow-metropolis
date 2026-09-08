import { useMemo, useState } from "react";
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
type RouterId = "0x" | "clawpump";

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
  const [router, setRouter] = useState<RouterId>("0x");
  const [amount, setAmount] = useState("25");
  const [slippagePct, setSlippagePct] = useState(0.5);
  const [quote, setQuote] = useState<Record<string, unknown> | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const input = useMemo(() => side === "buy"
    ? { router, inputMint: config.usdcMint, outputMint: tokenMint, amount: String(Math.round(Number(amount || 0) * 1_000_000)) }
    : { router, inputMint: tokenMint, outputMint: config.usdcMint, amount: String(Math.round(Number(amount || 0) * 1_000_000)) }, [side, router, amount, config.usdcMint, tokenMint]);
  const slippageBps = Math.round(Math.min(5, Math.max(0.01, Number.isFinite(slippagePct) ? slippagePct : 0.5)) * 100);

  const getQuote = async () => {
    if (network !== "solana") { setNetwork("solana"); setStatus("Switched to the Solana wallet for spot execution."); return; }
    setLoading(true); setStatus(""); setConfirmed(false);
    try {
      setQuote(await api.quote({ ...input, slippageBps, walletAddress }));
      notify({ title: "ROUTE READY", message: `${side.toUpperCase()} ${tokenSymbol} quote is ready for review.`, tone: "success" });
    } catch (error) { const message = error instanceof Error ? error.message : String(error); setStatus(message); notify({ title: "QUOTE UNAVAILABLE", message, tone: "warning" }); }
    finally { setLoading(false); }
  };
  const execute = async () => {
    if (!walletAddress || !quote || !confirmed || !send || network !== "solana") return;
    setLoading(true); setStatus("Preparing the Privy wallet transaction…");
    try {
      const payload = await api.transaction({ ...input, slippageBps, walletAddress, quoteId: quote.quoteId });
      const base64 = deepFind(payload, ["transaction", "swapTransaction", "unsignedTransaction", "serializedTransaction"]);
      if (typeof base64 !== "string") throw new Error("ClawPump did not return a recognizable unsigned transaction");
      setStatus("Confirm with your Privy embedded wallet…");
      const signature = await send(decodeBase64(base64));
      setStatus(`Submitted ${shortAddress(signature)}`);
      notify({ title: "TRADE SUBMITTED", message: `${side.toUpperCase()} ${tokenSymbol} was sent to Solana.`, tone: "success" });
    } catch (error) { const message = error instanceof Error ? error.message : String(error); setStatus(message); notify({ title: "TRADE NOT SENT", message, tone: "warning" }); }
    finally { setLoading(false); }
  };
  const outAmount = deepFind(quote, ["outAmount", "outputAmount"]);
  const impact = deepFind(quote, ["priceImpactPct", "priceImpact"]);
  const routers = config.routers?.length ? config.routers : [
    { id: "0x" as const, label: "0x Protocol", available: false },
    { id: "clawpump" as const, label: "ClawPump + Jupiter", available: Boolean(config.integrations.clawpump) }
  ];
  const selectedRouter = routers.find((item) => item.id === router);
  const routeLabels = Array.isArray(quote?.routePlan)
    ? quote.routePlan.map((leg) => String((leg as Record<string, unknown>).dex_label || "")).filter(Boolean).join(" → ")
    : "";
  const executable = Boolean(network === "solana" && walletAddress && send);

  return <section className="panel trade-ticket">
    <div className="panel-title"><span>SPOT ORDER</span><span className="tag">PRIVY · SOLANA</span></div>
    <label className="router-field">ROUTING API<select value={router} onChange={event => { setRouter(event.target.value as RouterId); setQuote(null); setConfirmed(false); setStatus(""); }}>
      {routers.map((item) => <option key={item.id} value={item.id}>{item.label}{item.available ? "" : " · NOT CONFIGURED"}</option>)}
    </select></label>
    <div className={`router-status${selectedRouter?.available ? " ready" : ""}`}><span>{selectedRouter?.available ? "ROUTER ONLINE" : "API KEY REQUIRED"}</span><b>{selectedRouter?.label || router}</b></div>
    <div className="side-tabs"><button className={side === "buy" ? "buy active" : ""} onClick={() => { setSide("buy"); setQuote(null); }}>BUY {tokenSymbol}</button><button className={side === "sell" ? "sell active" : ""} onClick={() => { setSide("sell"); setQuote(null); }}>SELL {tokenSymbol}</button></div>
    <label>NOTIONAL {side === "buy" ? "USDC" : tokenSymbol}<input type="number" min="0" value={amount} onChange={event => { setAmount(event.target.value); setQuote(null); }} /></label>
    <label>MAX SLIPPAGE <div className="input-suffix"><input type="number" min="0.01" max="5" step="0.01" value={slippagePct} onChange={event => { setSlippagePct(Number(event.target.value)); setQuote(null); }} /><span>%</span></div></label>
    <div className="wallet-line"><span>SOLANA SIGNER</span><b>{shortAddress(walletAddress)}</b></div>
    {!quote ? <button className="primary" disabled={loading || !Number(amount) || !selectedRouter?.available} onClick={() => void getQuote()}>{!selectedRouter?.available ? "CONFIGURE ROUTER" : network !== "solana" ? "SWITCH TO SOLANA" : loading ? <PixelLoader label="QUOTING" /> : "PREVIEW ROUTE"}</button> : <div className="quote-box">
      <div><span>EXPECTED OUTPUT</span><b>{outAmount == null ? "See route payload" : String(outAmount)}</b></div>
      <div><span>ROUTER</span><b>{selectedRouter?.label || router}</b></div>
      {routeLabels && <div className="quote-route"><span>LIQUIDITY PATH</span><b>{routeLabels}</b></div>}
      <div><span>PRICE IMPACT</span><b>{impact == null ? "—" : `${impact}%`}</b></div>
      <label className="confirm-row"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I verified the token, route, amount, and slippage.</label>
      <button className="primary execute" disabled={!executable || !confirmed || loading} onClick={() => void execute()}>{network !== "solana" ? "SWITCH TO SOLANA" : !walletAddress ? "LOG IN TO EXECUTE" : loading ? "WORKING…" : "SIGN & SUBMIT"}</button>
    </div>}
    {status && <p className="ticket-status">{status}</p>}
  </section>;
}
