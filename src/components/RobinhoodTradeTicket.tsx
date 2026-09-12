import { useEffect, useMemo, useRef, useState } from "react";
import { useSendTransaction, useWallets } from "@privy-io/react-auth";
import { createPublicClient, encodeFunctionData, formatUnits, http, parseUnits } from "viem";
import { api, deepFind } from "../api/client";
import { hasPrivy } from "../auth/WalletProviders";
import { ROBINHOOD_CHAIN } from "../features/NetworkContext";
import { shortAddress } from "../lib/format";
import type { PublicConfig } from "../types";
import { useNotifications, useTradeFeedback } from "./NotificationSystem";
import { PixelLoader } from "./PixelLoader";
import type { WalletAsset } from "../../shared/portfolio";
import { ETH_ASSET, NATIVE_ETH, type SwapAsset, swapMints } from "../lib/swapAssets";

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
    if (!wallet?.address) throw new Error("Your Privy Robinhood wallet is not ready. Reopen Profile and try again.");
    const value = quantity(tx.value), gasLimit = quantity(tx.gas), gasPrice = quantity(tx.gasPrice);
    const maxFeePerGas = quantity(tx.maxFeePerGas), maxPriorityFeePerGas = quantity(tx.maxPriorityFeePerGas);
    const result = await sendTransaction({
      to: tx.to,
      data: tx.data,
      ...(value === undefined ? {} : { value }),
      ...(gasLimit === undefined ? {} : { gasLimit }),
      ...(gasPrice === undefined ? {} : { gasPrice }),
      ...(maxFeePerGas === undefined ? {} : { maxFeePerGas }),
      ...(maxPriorityFeePerGas === undefined ? {} : { maxPriorityFeePerGas }),
      chainId: ROBINHOOD_CHAIN.id
    }, { address: wallet.address });
    return result.hash;
  }} />;
}

export function RobinhoodTradeTicket(props: Props) {
  return hasPrivy ? <LiveRobinhoodTradeTicket {...props} /> : <RobinhoodTradeSurface {...props} />;
}

function RobinhoodTradeSurface({ config, token, symbol, walletAddress, send }: Props & { walletAddress?: string; send?: (tx: EvmTx) => Promise<`0x${string}` | string> }) {
  const { notify } = useNotifications();
  const tradeFeedback = useTradeFeedback();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("0.01");
  const [slippagePct, setSlippagePct] = useState(0.5);
  const [tokenDecimals, setTokenDecimals] = useState<number | null>(null);
  const [quote, setQuote] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [walletAssets, setWalletAssets] = useState<WalletAsset[]>([]);
  const [settlementAddress, setSettlementAddress] = useState(NATIVE_ETH);
  const [quoteRefresh, setQuoteRefresh] = useState(0);
  const revision = useRef(0);

  useEffect(() => {
    let live = true;
    setTokenDecimals(null);
    client.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: "decimals" })
      .then(value => { if (live) setTokenDecimals(Number(value)); })
      .catch(() => { if (live) setStatus("Token decimals could not be read from Robinhood Chain."); });
    return () => { live = false; };
  }, [token]);
  useEffect(() => {
    let live = true;
    if (!walletAddress) { setWalletAssets([]); return; }
    api.robinhoodPortfolio(walletAddress).then(result => { if (live) setWalletAssets(result.assets); }).catch(() => { if (live) setWalletAssets([]); });
    return () => { live = false; };
  }, [walletAddress]);
  const fundingAssets = useMemo(() => {
    const assets = new Map<string, SwapAsset>([[NATIVE_ETH.toLowerCase(), ETH_ASSET]]);
    for (const asset of walletAssets) {
      const address = asset.mint === "ETH" ? NATIVE_ETH : asset.mint;
      if (address.toLowerCase() === token.toLowerCase() || !asset.symbol || asset.amount <= 0) continue;
      assets.set(address.toLowerCase(), { address, symbol: asset.symbol.toUpperCase(), name: asset.name, decimals: asset.decimals, balance: asset.amount });
    }
    return [...assets.values()];
  }, [token, walletAssets]);
  const settlement = fundingAssets.find(asset => asset.address.toLowerCase() === settlementAddress.toLowerCase()) ?? ETH_ASSET;
  useEffect(() => {
    if (!fundingAssets.some(asset => asset.address.toLowerCase() === settlementAddress.toLowerCase())) setSettlementAddress(NATIVE_ETH);
  }, [fundingAssets, settlementAddress]);

  const atomicAmount = useMemo(() => {
    try { return parseUnits(amount || "0", side === "buy" ? settlement.decimals : tokenDecimals ?? 18).toString(); }
    catch { return "0"; }
  }, [amount, side, tokenDecimals, settlement.decimals]);
  const mints = swapMints(side, token, settlement.address);
  const input = useMemo(() => ({
    chain: "robinhood" as const,
    router: "0x" as const,
    ...mints,
    amount: atomicAmount
  }), [atomicAmount, mints.inputMint, mints.outputMint]);
  const slippageBps = Math.round(Math.min(5, Math.max(0.01, Number.isFinite(slippagePct) ? slippagePct : 0.5)) * 100);
  const zeroEx = config.routers.find(router => router.id === "0x" && router.chains.includes("robinhood"));

  const getQuote = async () => {
    if (!walletAddress) { setStatus("Log in to request a wallet-specific 0x quote."); return; }
    if (side === "sell" && tokenDecimals == null) { setStatus("Waiting for token decimals from Robinhood Chain."); return; }
    const requestRevision = ++revision.current;
    setLoading(true); setStatus("");
    try {
      const next = await api.quote({ ...input, slippageBps, walletAddress });
      if (revision.current !== requestRevision) return;
      setQuote(next);
    } catch (reason) {
      if (revision.current === requestRevision) setStatus(reason instanceof Error ? reason.message : String(reason));
    } finally { setLoading(false); }
  };
  useEffect(() => {
    revision.current += 1;
    setQuote(null);
    if (!walletAddress || !zeroEx?.available || atomicAmount === "0" || (side === "sell" && tokenDecimals == null)) return;
    const timer = setTimeout(() => void getQuote(), 300);
    return () => clearTimeout(timer);
  }, [amount, side, slippageBps, walletAddress, token, tokenDecimals, settlementAddress, atomicAmount, zeroEx?.available, quoteRefresh]);
  useEffect(() => {
    if (!quote?.expiresAt || loading) return;
    const timer = setTimeout(() => { revision.current += 1; setQuote(null); setQuoteRefresh(value => value + 1); }, Math.max(0, Number(quote.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [quote, loading]);

  const execute = async () => {
    if (!walletAddress || !quote || !send) return;
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
      tradeFeedback(side);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setStatus(message); notify({ title: "TRADE NOT SENT", message, tone: "warning" });
    } finally { setLoading(false); }
  };

  const outAmount = deepFind(quote, ["outAmount", "buyAmount"]);
  const outputDecimals = side === "buy" ? tokenDecimals : settlement.decimals;
  const formattedOutput = typeof outAmount === "string" && outputDecimals != null
    ? formatUnits(BigInt(outAmount), outputDecimals)
    : outAmount == null ? "—" : String(outAmount);
  const impact = deepFind(quote, ["priceImpactPct", "estimatedPriceImpact"]);

  return <section className="panel trade-ticket">
    <div className="panel-title"><span>SPOT ORDER</span><span className="tag">PRIVY · ROBINHOOD</span></div>
    <label className="router-field"><span>ROUTING API</span><select value="0x" disabled><option value="0x">0x Protocol</option></select></label>
    <div className={`router-status${zeroEx?.available ? " ready" : ""}`}><span>{zeroEx?.available ? "ROUTER ONLINE" : "API KEY REQUIRED"}</span><b>Robinhood Chain · 4663</b></div>
    <div className="side-tabs"><button className={side === "buy" ? "buy active" : ""} onClick={() => { setSide("buy"); setAmount("0.01"); }}>BUY {symbol}</button><button className={side === "sell" ? "sell active" : ""} onClick={() => { setSide("sell"); setAmount("1"); }}>SELL {symbol}</button></div>
    <label className="amount-field"><span>AMOUNT {side === "buy" ? "FROM" : symbol}</span><div className="amount-control"><input type="number" min="0" step="any" value={amount} onChange={event => setAmount(event.target.value)} /><select aria-label={side === "buy" ? "Pay with asset" : "Receive asset"} value={settlementAddress} onChange={event => setSettlementAddress(event.target.value)}>{fundingAssets.map(asset => <option key={asset.address} value={asset.address}>{asset.symbol}{asset.balance == null ? "" : ` · ${asset.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}`}</option>)}</select></div></label>
    <label>MAX SLIPPAGE <div className="input-suffix"><input type="number" min="0.01" max="5" step="0.01" value={slippagePct} onChange={event => { setSlippagePct(Number(event.target.value)); setQuote(null); }} /><span>%</span></div></label>
    <div className="wallet-line"><span>ROBINHOOD SIGNER</span><b>{shortAddress(walletAddress)}</b></div>
    {quote ? <div className="quote-box">
      <div><span>EXPECTED OUTPUT</span><b>{formattedOutput} {side === "buy" ? symbol : settlement.symbol}</b></div>
      <div><span>ROUTER</span><b>0x AllowanceHolder</b></div>
      <div><span>TOKEN APPROVAL</span><b>{quote.allowanceRequired ? "REQUIRED · EXACT AMOUNT" : "NOT REQUIRED"}</b></div>
      <div><span>PRICE IMPACT</span><b>{impact == null ? "—" : `${impact}%`}</b></div>
    </div> : null}
    <button className="primary execute trade-execute" disabled={!quote || !walletAddress || !send || loading} onClick={() => void execute()}>{!zeroEx?.available ? "CONFIGURE 0X" : !walletAddress ? "LOG IN TO EXECUTE" : loading ? <PixelLoader label="QUOTING" /> : quote ? quote.allowanceRequired ? "APPROVE & EXECUTE" : `EXECUTE ${side.toUpperCase()}` : "FETCHING ROUTE…"}</button>
    {status && <p className="ticket-status" role="status">{status}</p>}
  </section>;
}
