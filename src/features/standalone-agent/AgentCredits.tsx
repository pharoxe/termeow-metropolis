import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getAccessToken, usePrivy, useSendTransaction, useWallets as useEvmWallets } from "@privy-io/react-auth";
import { encodeFunctionData, parseAbi } from "viem";
import { hasPrivy } from "../../auth/WalletProviders";
import { MONAD_CHAIN } from "../NetworkContext";

/** Top-ups settle on Monad: native MON (fresh USD quote) or a 6-decimal stable (USDC, Agora AUSD). */
type Asset = "MON" | "USDC" | "AUSD";
type Quote = { id: string; chain: "monad"; asset: Asset; sender: string; recipient: string; contract: string | null; decimals: number; amountBaseUnits: string; credits: number; expiresAt: string; usd: number };
const ERC20_TRANSFER = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

async function request<T>(path: string, body?: unknown): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error("Log in to use credits.");
  const response = await fetch(`/api/agent/${path}`, { method: body ? "POST" : "GET", signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "Credit service unavailable");
  return result;
}

function LiveCredits() {
  const { authenticated, ready, login, user } = usePrivy();
  const { wallets: evmWallets } = useEvmWallets();
  const { sendTransaction } = useSendTransaction();
  const [balance, setBalance] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [asset, setAsset] = useState<Asset>("USDC");
  const [usd, setUsd] = useState(10);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [pendingHash, setPendingHash] = useState("");
  const [pendingQuote, setPendingQuote] = useState<Quote | null>(null);
  const firstLoad = useRef(true);
  useEffect(() => {
    setPendingQuote(null); setPendingHash(""); setOpen(false); setError("");
    if (!user) return;
    try {
      const saved = localStorage.getItem(`termeow-credit-payment:${user.id}`);
      if (saved) { const pending = JSON.parse(saved) as { quote: Quote; hash: string }; setPendingQuote(pending.quote); setPendingHash(pending.hash); setOpen(true); }
    } catch { /* Payment IDs can still be supplied to support. */ }
  }, [user?.id]);

  useEffect(() => {
    if (!authenticated) { setBalance(null); firstLoad.current = true; return; }
    let active = true;
    const update = () => { void request<{ balance: number }>("credits").then((result) => { if (active) { setBalance(result.balance); if (firstLoad.current && result.balance < 400) setOpen(true); firstLoad.current = false; } }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }); };
    const exhausted = () => setOpen(true);
    update(); const poll = window.setInterval(update, 30_000); window.addEventListener("termeow:credits-changed", update); window.addEventListener("termeow:credits-exhausted", exhausted);
    return () => { active = false; clearInterval(poll); window.removeEventListener("termeow:credits-changed", update); window.removeEventListener("termeow:credits-exhausted", exhausted); };
  }, [authenticated, user?.id]);

  const verifyPayment = async (quote: Quote, hash: string) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        const result = await request<{ balance: number }>("credits/settle", { quoteId: quote.id, transactionHash: hash });
        setBalance(result.balance); setPendingHash(""); setPendingQuote(null); setOpen(false);
        try { if (user) localStorage.removeItem(`termeow-credit-payment:${user.id}`); } catch { /* The onchain payment is already settled. */ }
        return;
      } catch (reason) { if (attempt === 19) throw reason; }
    }
  };
  const pay = async () => {
    setWorking(true); setError("");
    try {
      const wallet = evmWallets.find((item) => ["privy", "privy-v2"].includes(item.walletClientType)) ?? evmWallets[0];
      if (!wallet?.address) throw new Error("Connect your Monad Privy wallet first.");
      const { quote } = await request<{ quote: Quote }>("credits/quote", { asset, usd, sender: wallet.address });
      const value = BigInt(quote.amountBaseUnits);
      if (quote.asset !== "MON" && !quote.contract) throw new Error("The credit quote is missing its token contract.");
      const result = await sendTransaction(quote.asset === "MON"
        ? { to: quote.recipient, value, chainId: MONAD_CHAIN.id }
        : { to: quote.contract!, data: encodeFunctionData({ abi: ERC20_TRANSFER, functionName: "transfer", args: [quote.recipient as `0x${string}`, value] }), chainId: MONAD_CHAIN.id }, { address: wallet.address });
      const hash = result.hash;
      setPendingHash(hash); setPendingQuote(quote);
      try { if (user) localStorage.setItem(`termeow-credit-payment:${user.id}`, JSON.stringify({ quote, hash })); } catch { /* Keep verification available in memory. */ }
      await verifyPayment(quote, hash);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  };

  return <>
    <button className="agent-credit-button" type="button" disabled={!ready} onClick={() => authenticated ? setOpen(true) : login()} aria-label="Open Termeow credit balance">◈ {authenticated ? balance == null ? "CREDITS …" : `${balance} CREDITS` : "CREDITS"}</button>
    {open && authenticated && createPortal(<div className="agent-credit-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}><section className="agent-credit-modal" role="dialog" aria-modal="true" aria-label="Top up Termeow credits">
      <header><span>TERMEOW // CREDIT BAY</span><button type="button" onClick={() => setOpen(false)} aria-label="Close">×</button></header>
      <strong>{balance ?? "—"} AVAILABLE CREDITS</strong><p>500 welcome credits ($5 value). Voice starts at 40 credits per minute ($0.40), or twice provider cost when higher. We reserve 400 credits for a call of up to 10 minutes and return unused credits after it ends.</p>
      <label>TOP UP USD<select value={usd} onChange={(event) => setUsd(Number(event.target.value))} disabled={working}><option value={5}>$5 · 500 credits</option><option value={10}>$10 · 1,000 credits</option><option value={25}>$25 · 2,500 credits</option><option value={50}>$50 · 5,000 credits</option></select></label>
      <label>PAY WITH<select value={asset} onChange={(event) => setAsset(event.target.value as Asset)} disabled={working}><option value="USDC">USDC · Monad</option><option value="AUSD">AUSD · Agora · Monad</option><option value="MON">MON · native</option></select></label>
      <small>Privy will ask you to approve a transfer. Native token amounts use a fresh USD quote; network fees are extra. Credits appear after chain confirmation.</small>
      <button className="agent-credit-pay" type="button" disabled={working || Boolean(pendingHash)} onClick={() => void pay()}>{working ? "VERIFYING PAYMENT…" : `TOP UP $${usd} ↗`}</button>
      {error && <p className="agent-credit-error" role="alert">{error}</p>}
      {pendingHash && <p className="agent-credit-pending">Payment submitted: <code>{pendingHash}</code>. {pendingQuote && `Quote ${pendingQuote.id}`}. If verification times out, keep these IDs and contact support; do not pay twice. <button type="button" disabled={working || !pendingQuote} onClick={() => { if (!pendingQuote) return; setWorking(true); setError(""); void verifyPayment(pendingQuote, pendingHash).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setWorking(false)); }}>RETRY VERIFICATION</button></p>}
    </section></div>, document.body)}
  </>;
}

export function AgentCredits() { return hasPrivy ? <LiveCredits /> : null; }
