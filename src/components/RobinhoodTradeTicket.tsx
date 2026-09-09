import { useEffect, useMemo, useState } from "react";
import { useSendTransaction, useWallets } from "@privy-io/react-auth";
import { createPublicClient, encodeFunctionData, formatUnits, http, parseUnits } from "viem";
import { api, deepFind } from "../api/client";
import { hasPrivy } from "../auth/WalletProviders";
import { ROBINHOOD_CHAIN } from "../features/NetworkContext";
import { shortAddress } from "../lib/format";
import type { PublicConfig } from "../types";
import { useNotifications } from "./NotificationSystem";
import { PixelLoader } from "./PixelLoader";

const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }
] as const;
const client = createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http(ROBINHOOD_CHAIN.rpcUrls.default.http[0]) });

type Props = { config: PublicConfig; token: string; symbol: string };
type EvmTx = { to: string; data: string; value?: string; gas?: string; gasPrice?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string };

function quantity(value: unknown) {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : undefined;
}

function LiveRobinhoodTradeTicket(props: Props) {
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();
  const wallet = wallets.find(item => ["privy", "privy-v2"].includes(item.walletClientType)) ?? wallets[0];
  return <RobinhoodTradeSurface {...props} walletAddress={wallet?.address} send={async tx => {
    const result = await sendTransaction({
      to: tx.to,
      data: tx.data,
      value: quantity(tx.value),
      gasLimit: quantity(tx.gas),
      gasPrice: quantity(tx.gasPrice),
      maxFeePerGas: quantity(tx.maxFeePerGas),
      maxPriorityFeePerGas: quantity(tx.maxPriorityFeePerGas),
      chainId: ROBINHOOD_CHAIN.id
    }, { address: wallet?.address });
    return result.hash;
  }} />;
}

export function RobinhoodTradeTicket(props: Props) {
  return hasPrivy ? <LiveRobinhoodTradeTicket {...props} /> : <RobinhoodTradeSurface {...props} />;
}

function RobinhoodTradeSurface({ config, token, symbol, walletAddress, send }: Props & { walletAddress?: string; send?: (tx: EvmTx) => Promise<`0x${string}` | string> }) {
  const { notify } = useNotifications();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("0.01");
  const [slippagePct, setSlippagePct] = useState(0.5);
  const [tokenDecimals, setTokenDecimals] = useState<number | null>(null);
  const [quote, setQuote] = useState<Record<string, unknown> | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let live = true;
    setTokenDecimals(null);
    client.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: "decimals" })
      .then(value => { if (live) setTokenDecimals(Number(value)); })
      .catch(() => { if (live) setStatus("Token decimals could not be read from Robinhood Chain."); });
    return () => { live = false; };
  }, [token]);

  const atomicAmount = useMemo(() => {
    try { return parseUnits(amount || "0", side === "buy" ? 18 : tokenDecimals ?? 18).toString(); }
    catch { return "0"; }
  }, [amount, side, tokenDecimals]);
  const input = useMemo(() => ({
    chain: "robinhood" as const,
    router: "0x" as const,
    inputMint: side === "buy" ? NATIVE_ETH : token,
    outputMint: side === "buy" ? token : NATIVE_ETH,
    amount: atomicAmount
  }), [atomicAmount, side, token]);
  const slippageBps = Math.round(Math.min(5, Math.max(0.01, Number.isFinite(slippagePct) ? slippagePct : 0.5)) * 100);
  const zeroEx = config.routers.find(router => router.id === "0x" && router.chains.includes("robinhood"));

  const getQuote = async () => {
    if (!walletAddress) { setStatus("Log in to request a wallet-specific 0x quote."); return; }
    if (side === "sell" && tokenDecimals == null) { setStatus("Waiting for token decimals from Robinhood Chain."); return; }
    setLoading(true); setStatus(""); setConfirmed(false);
    try {
      const next = await api.quote({ ...input, slippageBps, walletAddress });
      setQuote(next);
      notify({ title: "0X ROUTE READY", message: `${side.toUpperCase()} ${symbol} is ready for review.`, tone: "success" });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setStatus(message); notify({ title: "QUOTE UNAVAILABLE", message, tone: "warning" });
    } finally { setLoading(false); }
  };

  const execute = async () => {
    if (!walletAddress || !quote || !confirmed || !send) return;
    setLoading(true); setStatus("Building the 0x Robinhood transaction…");
    try {
      const payload = await api.transaction({ ...input, slippageBps, walletAddress, quoteId: quote.quoteId });
      const approval = payload.approval as { required?: boolean; token?: string; spender?: string; amount?: string } | undefined;
      if (approval?.required) {
        if (!approval.token || !approval.spender || !approval.amount) throw new Error("0x returned an incomplete allowance request.");
        setStatus("Approve the exact token amount in Privy…");
        const approvalHash = await send({
          to: approval.token,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [approval.spender as `0x${string}`, BigInt(approval.amount)] })
        });
        setStatus("Waiting for the token approval to confirm…");
        await client.waitForTransactionReceipt({ hash: approvalHash as `0x${string}`, confirmations: 1, timeout: 120_000 });
      }
      const transaction = payload.transaction as EvmTx | undefined;
      if (!transaction?.to || !transaction.data) throw new Error("0x did not return a complete Robinhood transaction.");
      setStatus("Confirm the swap with your Privy Robinhood wallet…");
      const hash = await send(transaction);
      setStatus(`Submitted ${shortAddress(hash)}`);
      notify({ title: "TRADE SUBMITTED", message: `${side.toUpperCase()} ${symbol} was sent to Robinhood Chain.`, tone: "success" });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setStatus(message); notify({ title: "TRADE NOT SENT", message, tone: "warning" });
    } finally { setLoading(false); }
  };

  const outAmount = deepFind(quote, ["outAmount", "buyAmount"]);
  const outputDecimals = side === "buy" ? tokenDecimals : 18;
  const formattedOutput = typeof outAmount === "string" && outputDecimals != null
    ? formatUnits(BigInt(outAmount), outputDecimals)
    : outAmount == null ? "—" : String(outAmount);
  const impact = deepFind(quote, ["priceImpactPct", "estimatedPriceImpact"]);

  return <section className="panel trade-ticket">
    <div className="panel-title"><span>SPOT ORDER</span><span className="tag">PRIVY · ROBINHOOD</span></div>
    <label className="router-field">ROUTING API<select value="0x" disabled><option value="0x">0x Protocol · AllowanceHolder</option></select></label>
    <div className={`router-status${zeroEx?.available ? " ready" : ""}`}><span>{zeroEx?.available ? "ROUTER ONLINE" : "API KEY REQUIRED"}</span><b>Robinhood Chain · 4663</b></div>
    <div className="side-tabs"><button className={side === "buy" ? "buy active" : ""} onClick={() => { setSide("buy"); setAmount("0.01"); setQuote(null); }}>BUY {symbol}</button><button className={side === "sell" ? "sell active" : ""} onClick={() => { setSide("sell"); setAmount("1"); setQuote(null); }}>SELL {symbol}</button></div>
    <label>AMOUNT {side === "buy" ? "ETH" : symbol}<input type="number" min="0" step="any" value={amount} onChange={event => { setAmount(event.target.value); setQuote(null); }} /></label>
    <label>MAX SLIPPAGE <div className="input-suffix"><input type="number" min="0.01" max="5" step="0.01" value={slippagePct} onChange={event => { setSlippagePct(Number(event.target.value)); setQuote(null); }} /><span>%</span></div></label>
    <div className="wallet-line"><span>ROBINHOOD SIGNER</span><b>{shortAddress(walletAddress)}</b></div>
    {!quote ? <button className="primary" disabled={loading || !zeroEx?.available || atomicAmount === "0"} onClick={() => void getQuote()}>{!zeroEx?.available ? "CONFIGURE 0X" : !walletAddress ? "LOG IN TO QUOTE" : loading ? <PixelLoader label="QUOTING" /> : "PREVIEW ROUTE"}</button> : <div className="quote-box">
      <div><span>EXPECTED OUTPUT</span><b>{formattedOutput} {side === "buy" ? symbol : "ETH"}</b></div>
      <div><span>ROUTER</span><b>0x AllowanceHolder</b></div>
      <div><span>TOKEN APPROVAL</span><b>{quote.allowanceRequired ? "REQUIRED · EXACT AMOUNT" : "NOT REQUIRED"}</b></div>
      <div><span>PRICE IMPACT</span><b>{impact == null ? "—" : `${impact}%`}</b></div>
      <label className="confirm-row"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I verified the token, route, amount, and slippage.</label>
      <button className="primary execute" disabled={!walletAddress || !confirmed || loading} onClick={() => void execute()}>{!walletAddress ? "LOG IN TO EXECUTE" : loading ? "WORKING…" : quote.allowanceRequired ? "APPROVE & SUBMIT" : "SIGN & SUBMIT"}</button>
    </div>}
    {status && <p className="ticket-status" role="status">{status}</p>}
  </section>;
}
