import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getAccessToken, usePrivy, useSendTransaction, useWallets as useEvmWallets } from "@privy-io/react-auth";
import { useSignAndSendTransaction, useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { encodeFunctionData, parseAbi } from "viem";
import { hasPrivy } from "../../auth/WalletProviders";
import { api } from "../../api/client";

type Asset = "SOL" | "USDC" | "ETH" | "USDG";
type Quote = { id: string; chain: "solana" | "robinhood"; asset: Asset; sender: string; recipient: string; amountBaseUnits: string; credits: number; expiresAt: string; usd: number };
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const ERC20_TRANSFER = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array) {
  let value = BigInt(`0x${Array.from(bytes).map((item) => item.toString(16).padStart(2, "0")).join("")}`);
  let output = "";
  while (value > 0n) { output = alphabet[Number(value % 58n)] + output; value /= 58n; }
  for (const item of bytes) { if (item !== 0) break; output = `1${output}`; }
  return output;
}
function tokenAccount(owner: PublicKey) {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), USDC_MINT.toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
}
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
  const { wallets: solanaWallets } = useSolanaWallets();
  const { sendTransaction } = useSendTransaction();
  const { signAndSendTransaction } = useSignAndSendTransaction();
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
      const solana = asset === "SOL" || asset === "USDC";
      const wallet = solana ? solanaWallets[0] : evmWallets.find((item) => ["privy", "privy-v2"].includes(item.walletClientType)) ?? evmWallets[0];
      if (!wallet?.address) throw new Error(`Connect your ${solana ? "Solana" : "Robinhood"} Privy wallet first.`);
      const { quote } = await request<{ quote: Quote }>("credits/quote", { asset, usd, sender: wallet.address });
      let hash: string;
      if (solana) {
        const sender = new PublicKey(wallet.address), recipient = new PublicKey(quote.recipient);
        const tx = new Transaction();
        if (asset === "SOL") {
          tx.add(SystemProgram.transfer({ fromPubkey: sender, toPubkey: recipient, lamports: BigInt(quote.amountBaseUnits) }));
        } else {
          const source = tokenAccount(sender), destination = tokenAccount(recipient);
          tx.add(new TransactionInstruction({ programId: ASSOCIATED_TOKEN_PROGRAM, keys: [
            { pubkey: sender, isSigner: true, isWritable: true }, { pubkey: destination, isSigner: false, isWritable: true },
            { pubkey: recipient, isSigner: false, isWritable: false }, { pubkey: USDC_MINT, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false }
          ], data: new Uint8Array([1]) as Buffer }));
          const amount = BigInt(quote.amountBaseUnits), data = new Uint8Array(10); data[0] = 12; data[9] = 6;
          for (let i = 0; i < 8; i++) data[i + 1] = Number((amount >> BigInt(8 * i)) & 255n);
          tx.add(new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [
            { pubkey: source, isSigner: false, isWritable: true }, { pubkey: USDC_MINT, isSigner: false, isWritable: false },
            { pubkey: destination, isSigner: false, isWritable: true }, { pubkey: sender, isSigner: true, isWritable: false }
          ], data: data as Buffer }));
        }
        const blockhash = await api.rpc<{ value?: { blockhash?: string } }>("getLatestBlockhash", [{ commitment: "finalized" }]);
        const latest = blockhash.value?.blockhash;
        if (!latest) throw new Error("Solana blockhash unavailable. Try again.");
        tx.recentBlockhash = latest; tx.feePayer = sender;
        const result = await signAndSendTransaction({ transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }), wallet: solanaWallets[0], chain: "solana:mainnet" });
        hash = typeof result.signature === "string" ? result.signature : base58(result.signature);
      } else {
        const value = BigInt(quote.amountBaseUnits);
        const result = await sendTransaction(asset === "ETH"
          ? { to: quote.recipient, value, chainId: 4663 }
          : { to: USDG, data: encodeFunctionData({ abi: ERC20_TRANSFER, functionName: "transfer", args: [quote.recipient as `0x${string}`, value] }), chainId: 4663 }, { address: wallet.address });
        hash = result.hash;
      }
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
      <label>PAY WITH<select value={asset} onChange={(event) => setAsset(event.target.value as Asset)} disabled={working}><option value="USDC">USDC · Solana</option><option value="SOL">SOL · Solana</option><option value="USDG">USDG · Robinhood</option><option value="ETH">ETH · Robinhood</option></select></label>
      <small>Privy will ask you to approve a transfer. Native token amounts use a fresh USD quote; network fees are extra. Credits appear after chain confirmation.</small>
      <button className="agent-credit-pay" type="button" disabled={working || Boolean(pendingHash)} onClick={() => void pay()}>{working ? "VERIFYING PAYMENT…" : `TOP UP $${usd} ↗`}</button>
      {error && <p className="agent-credit-error" role="alert">{error}</p>}
      {pendingHash && <p className="agent-credit-pending">Payment submitted: <code>{pendingHash}</code>. {pendingQuote && `Quote ${pendingQuote.id}`}. If verification times out, keep these IDs and contact support; do not pay twice. <button type="button" disabled={working || !pendingQuote} onClick={() => { if (!pendingQuote) return; setWorking(true); setError(""); void verifyPayment(pendingQuote, pendingHash).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setWorking(false)); }}>RETRY VERIFICATION</button></p>}
    </section></div>, document.body)}
  </>;
}

export function AgentCredits() { return hasPrivy ? <LiveCredits /> : null; }
