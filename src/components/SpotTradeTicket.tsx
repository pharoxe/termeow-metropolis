import { useEffect, useMemo, useRef, useState } from "react";
import { useSignAndSendTransaction, useWallets } from "@privy-io/react-auth/solana";
import { api, deepFind } from "../api/client";
import type { PublicConfig } from "../types";
import { shortAddress } from "../lib/format";
import { PixelLoader } from "./PixelLoader";
import { useNotifications, useTradeFeedback } from "./NotificationSystem";
import { useFundingNetwork } from "../features/NetworkContext";
import { hasPrivy } from "../auth/WalletProviders";
import { SOL_ASSET, solanaFundingAssets, swapMints } from "../lib/swapAssets";
import type { WalletAsset } from "../../shared/portfolio";

function decodeBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

type Props = { config: PublicConfig; mint?: string; symbol?: string };
type RouterId = "0x" | "jupiter" | "clawpump";

export function toAtomic(value: string, decimals: number) {
  const match = value.trim().match(/^(\d+)(?:\.(\d*))?$/);
  if (!match) return "0";
  const whole = match[1];
  const fraction = (match[2] || "").slice(0, decimals).padEnd(decimals, "0");
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction || "0")).toString();
}

export function fromAtomic(value: unknown, decimals: number | null) {
  if (typeof value !== "string" || !/^\d+$/.test(value) || decimals == null) return value == null ? "—" : String(value);
  if (decimals === 0) return value;
  const padded = value.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, "").slice(0, 6) : "";
  return fraction ? `${whole}.${fraction}` : whole;
}

function PrivySpotTradeTicket(props: Props) {
  const { wallets } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  return <TradeTicketSurface {...props} walletAddress={wallets[0]?.address} send={async transaction => {
    const wallet = wallets[0];
    if (!wallet?.address) throw new Error("Your Privy Solana wallet is not ready. Reopen Profile and try again.");
    const result = await signAndSendTransaction({ transaction, wallet, chain: "solana:mainnet" });
    return typeof result.signature === "string" ? result.signature : Array.from(result.signature).map(byte => byte.toString(16).padStart(2, "0")).join("");
  }} />;
}

export function SpotTradeTicket(props: Props) {
  return hasPrivy ? <PrivySpotTradeTicket {...props} /> : <TradeTicketSurface {...props} />;
}

function TradeTicketSurface({ config, mint, symbol, walletAddress, send }: Props & { walletAddress?: string; send?: (transaction: Uint8Array) => Promise<string> }) {
  const { notify } = useNotifications();
  const tradeFeedback = useTradeFeedback();
  const { network, setNetwork } = useFundingNetwork();
  const tokenMint = mint || config.ansemMint;
  const tokenSymbol = (symbol || "TOKEN").toUpperCase();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [router, setRouter] = useState<RouterId>("jupiter");
  const [amount, setAmount] = useState("0.01");
  const [slippagePct, setSlippagePct] = useState(0.5);
  const [quote, setQuote] = useState<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [tokenDecimals, setTokenDecimals] = useState<number | null>(null);
  const [walletAssets, setWalletAssets] = useState<WalletAsset[]>([]);
  const [settlementMint, setSettlementMint] = useState(SOL_ASSET.address);
  const [quoteRefresh, setQuoteRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    setTokenDecimals(null);
    api.rpc<{ value?: { decimals?: number } }>("getTokenSupply", [tokenMint])
      .then(result => { if (live) setTokenDecimals(typeof result?.value?.decimals === "number" ? result.value.decimals : null); })
      .catch(() => { if (live) setTokenDecimals(null); });
    return () => { live = false; };
  }, [tokenMint]);
  useEffect(() => {
    let live = true;
    if (!walletAddress) { setWalletAssets([]); return; }
    api.portfolio(walletAddress).then(result => { if (live) setWalletAssets(result.assets); }).catch(() => { if (live) setWalletAssets([]); });
    return () => { live = false; };
  }, [walletAddress]);
  const fundingAssets = useMemo(() => solanaFundingAssets(walletAssets, tokenMint), [tokenMint, walletAssets]);
  const settlement = fundingAssets.find(asset => asset.address === settlementMint) ?? SOL_ASSET;
  useEffect(() => {
    if (!fundingAssets.some(asset => asset.address === settlementMint)) setSettlementMint(SOL_ASSET.address);
  }, [fundingAssets, settlementMint]);
  const revision = useRef(0);
  const orderRef = useRef<Record<string, unknown> | null>(null);
  const invalidate = () => { revision.current++; orderRef.current = null; setQuote(null); };
  // Router belongs in here with the rest: a quote is only executable through the router that priced it, and the
  // server rejects a mismatch with a 409, so switching routers has to drop the held quote rather than resubmit it.
  useEffect(() => { invalidate(); return () => { revision.current++; }; }, [tokenMint, walletAddress, network, router, settlementMint]);
  useEffect(() => {
    if (!quote || loading) return;
    const timer = setTimeout(() => { invalidate(); setQuoteRefresh(value => value + 1); }, Math.max(0, Number(quote.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [quote, loading]);
  const slippageBps = Math.round(Math.min(5, Math.max(0.01, Number.isFinite(slippagePct) ? slippagePct : 0.5)) * 100);
  const routers = config.routers?.length ? config.routers : [
    { id: "jupiter" as const, label: "Jupiter", available: true, chains: ["solana" as const] },
    { id: "0x" as const, label: "0x Protocol", available: false, chains: ["solana" as const] },
    { id: "clawpump" as const, label: "ClawPump + Jupiter", available: Boolean(config.integrations.clawpump), chains: ["solana" as const] }
  ];
  const solanaRouters = routers.filter(item => !item.chains || item.chains.includes("solana"));
  const selectedRouter = routers.find((item) => item.id === router);

  const getQuote = async () => {
    if (network !== "solana") { setNetwork("solana"); setStatus("Switched to the Solana wallet for spot execution."); return; }
    const requestRevision = ++revision.current;
    if (!Number(amount) || !selectedRouter?.available) return;
    if (side === "sell" && tokenDecimals == null) return;
    setLoading(true); setStatus("");
    try {
      const { inputMint, outputMint } = swapMints(side, tokenMint, settlement.address);
      const inputDecimals = side === "buy" ? settlement.decimals : tokenDecimals ?? 0;
      const input = { chain: "solana" as const, router, inputMint, outputMint, amount: toAtomic(amount, inputDecimals), slippageBps, walletAddress };
      const result = await api.quote(input);
      if (revision.current !== requestRevision) return;
      orderRef.current = input;
      setQuote(result);
    } catch (error) { if (revision.current === requestRevision) setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    invalidate();
    if (!Number(amount) || !selectedRouter?.available || network !== "solana" || (side === "sell" && tokenDecimals == null)) return;
    const timer = setTimeout(() => void getQuote(), 300);
    return () => clearTimeout(timer);
  }, [amount, side, slippageBps, router, tokenMint, walletAddress, network, settlementMint, tokenDecimals, quoteRefresh, selectedRouter?.available]);
  const execute = async () => {
    if (!walletAddress || !quote || !send || network !== "solana" || !orderRef.current) return;
    if (Number(quote.expiresAt) <= Date.now()) { invalidate(); setQuoteRefresh(value => value + 1); setStatus("Refreshing an expired route…"); return; }
    const executionRevision = revision.current;
    setLoading(true); setStatus("Preparing the Privy wallet transaction…");
    try {
      const payload = await api.transaction({ ...orderRef.current, quoteId: quote.quoteId });
      if (executionRevision !== revision.current) throw new Error("Wallet or order changed. Wait for the refreshed route.");
      const base64 = deepFind(payload, ["transaction", "swapTransaction", "unsignedTransaction", "serializedTransaction"]);
      if (typeof base64 !== "string") throw new Error("The selected router did not return a recognizable unsigned transaction");
      setStatus("Confirm with your Privy embedded wallet…");
      const signature = await send(decodeBase64(base64));
      invalidate();
      setStatus(`Submitted ${shortAddress(signature)}`);
      notify({ title: "TRADE SUBMITTED", message: `${side.toUpperCase()} ${tokenSymbol} was sent to Solana.`, tone: "success" });
      tradeFeedback(side);
    } catch (error) { invalidate(); const message = error instanceof Error ? error.message : String(error); setStatus(message); notify({ title: "TRADE NOT SENT", message, tone: "warning" }); }
    finally { setLoading(false); }
  };
  const outAmount = deepFind(quote, ["outAmount", "outputAmount"]);
  const impact = deepFind(quote, ["priceImpactPct", "priceImpact"]);
  const routeLabels = Array.isArray(quote?.routePlan)
    ? quote.routePlan.map((leg) => String((leg as Record<string, unknown>).dex_label || "")).filter(Boolean).join(" → ")
    : "";
  const executable = Boolean(network === "solana" && walletAddress && send);

  return <section className="panel trade-ticket">
    <div className="panel-title"><span>SPOT ORDER</span><span className="tag">PRIVY · SOLANA</span></div>
    {/* Every control locks while a quote is in flight and clears through invalidate(), which bumps the revision the
        in-flight response is checked against: a bare setQuote(null) leaves that response free to land on a changed order. */}
    <label className="router-field"><span>ROUTING API</span><select disabled={loading} value={router} onChange={event => { setRouter(event.target.value as RouterId); setStatus(""); }}>
      {solanaRouters.map((item) => <option key={item.id} value={item.id}>{item.label}{item.available ? "" : " · NOT CONFIGURED"}</option>)}
    </select></label>
    <div className={`router-status${selectedRouter?.available ? " ready" : ""}`}><span>{selectedRouter?.available ? "ROUTER ONLINE" : "API KEY REQUIRED"}</span><b>{selectedRouter?.label || router}</b></div>
    <div className="side-tabs"><button disabled={loading} className={side === "buy" ? "buy active" : ""} onClick={() => { setSide("buy"); invalidate(); }}>BUY {tokenSymbol}</button><button disabled={loading} className={side === "sell" ? "sell active" : ""} onClick={() => { setSide("sell"); invalidate(); }}>SELL {tokenSymbol}</button></div>
    <label className="amount-field"><span>AMOUNT {side === "buy" ? "FROM" : tokenSymbol}</span><div className="amount-control"><input disabled={loading} type="number" min="0" step="any" value={amount} onChange={event => setAmount(event.target.value)} /><select aria-label={side === "buy" ? "Pay with asset" : "Receive asset"} disabled={loading} value={settlementMint} onChange={event => setSettlementMint(event.target.value)}>{fundingAssets.map(asset => <option key={asset.address} value={asset.address}>{asset.symbol}{asset.balance == null ? "" : ` · ${asset.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}`}</option>)}</select></div></label>
    <label>MAX SLIPPAGE <div className="input-suffix"><input disabled={loading} type="number" min="0.01" max="5" step="0.01" value={slippagePct} onChange={event => { setSlippagePct(Number(event.target.value)); invalidate(); }} /><span>%</span></div></label>
    <div className="wallet-line"><span>SOLANA SIGNER</span><b>{shortAddress(walletAddress)}</b></div>
    {quote ? <div className="quote-box">
      <div><span>EXPECTED OUTPUT</span><b>{fromAtomic(outAmount, side === "buy" ? tokenDecimals : settlement.decimals)} {side === "buy" ? tokenSymbol : settlement.symbol}</b></div>
      <div><span>ROUTER</span><b>{selectedRouter?.label || router}</b></div>
      {routeLabels && <div className="quote-route"><span>LIQUIDITY PATH</span><b>{routeLabels}</b></div>}
      <div><span>PRICE IMPACT</span><b>{impact == null ? "—" : `${impact}%`}</b></div>
    </div> : null}
    <button className="primary execute trade-execute" disabled={network === "solana" && (!quote || !executable || loading)} onClick={() => network !== "solana" ? setNetwork("solana") : void execute()}>{!selectedRouter?.available ? "CONFIGURE ROUTER" : network !== "solana" ? "SWITCH TO SOLANA" : !walletAddress ? "LOG IN TO EXECUTE" : loading ? <PixelLoader label="QUOTING" /> : quote ? `EXECUTE ${side.toUpperCase()}` : "FETCHING ROUTE…"}</button>
    {status && <p className="ticket-status">{status}</p>}
  </section>;
}
