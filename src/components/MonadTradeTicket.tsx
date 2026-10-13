import { useEffect, useMemo, useRef, useState } from "react";
import { useSendTransaction, useWallets } from "@privy-io/react-auth";
import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import { api, deepFind } from "../api/client";
import { hasPrivy } from "../auth/WalletProviders";
import { MONAD_CHAIN, explorerTxUrl } from "../features/NetworkContext";
import { shortAddress } from "../lib/format";
import { approvalNeeded, erc20Abi, monadClient } from "../lib/monadClient";
import type { PublicConfig } from "../types";
import { useNotifications, useTradeFeedback } from "./NotificationSystem";
import { PixelLoader } from "./PixelLoader";
import type { WalletAsset } from "../../shared/portfolio";
import { MON_ASSET, NATIVE_MON, isNativeAddress, monadFundingAssets, swapMints } from "../lib/swapAssets";

type Props = { config: PublicConfig; token: string; symbol: string };
type EvmTx = { to: string; data: string; value?: string; gas?: string; gasPrice?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string };
type RouterId = "kuru" | "0x";

const ROUTER_LABEL: Record<RouterId, string> = { kuru: "Kuru Flow", "0x": "0x AllowanceHolder" };

function quantity(value: unknown) {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : undefined;
}

function LiveMonadTradeTicket(props: Props) {
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();
  const wallet = wallets.find(item => ["privy", "privy-v2"].includes(item.walletClientType)) ?? wallets[0];
  return <MonadTradeSurface {...props} walletAddress={wallet?.address} send={async tx => {
    if (!wallet?.address) throw new Error("Your Privy Monad wallet is not ready. Reopen Profile and try again.");
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
      chainId: MONAD_CHAIN.id
    }, { address: wallet.address });
    return result.hash;
  }} />;
}

export function MonadTradeTicket(props: Props) {
  return hasPrivy ? <LiveMonadTradeTicket {...props} /> : <MonadTradeSurface {...props} />;
}

function MonadTradeSurface({ config, token, symbol, walletAddress, send }: Props & { walletAddress?: string; send?: (tx: EvmTx) => Promise<`0x${string}` | string> }) {
  const { notify } = useNotifications();
  const tradeFeedback = useTradeFeedback();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("1");
  const [slippagePct, setSlippagePct] = useState(0.5);
  const [router, setRouter] = useState<RouterId>("kuru");
  const [tokenDecimals, setTokenDecimals] = useState<number | null>(null);
  const [quote, setQuote] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [lastHash, setLastHash] = useState<string | null>(null);
  const [walletAssets, setWalletAssets] = useState<WalletAsset[]>([]);
  const [settlementAddress, setSettlementAddress] = useState(NATIVE_MON);
  const [quoteRefresh, setQuoteRefresh] = useState(0);
  const revision = useRef(0);
  const routers = config.routers.filter(item => item.chains.includes("monad"));
  const active = routers.find(item => item.id === router);

  useEffect(() => {
    let live = true;
    setTokenDecimals(null);
    monadClient.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: "decimals" })
      .then(value => { if (live) setTokenDecimals(Number(value)); })
      .catch(() => { if (live) setStatus("Token decimals could not be read from Monad."); });
    return () => { live = false; };
  }, [token]);
  useEffect(() => {
    let live = true;
    if (!walletAddress) { setWalletAssets([]); return; }
    api.monadPortfolio(walletAddress, [token]).then(result => { if (live) setWalletAssets(result.assets); }).catch(() => { if (live) setWalletAssets([]); });
    return () => { live = false; };
  }, [walletAddress, token, lastHash]);
  const fundingAssets = useMemo(() => monadFundingAssets(walletAssets, token), [token, walletAssets]);
  const settlement = fundingAssets.find(asset => asset.address.toLowerCase() === settlementAddress.toLowerCase()) ?? MON_ASSET;
  const tokenBalance = walletAssets.find(asset => asset.mint.toLowerCase() === token.toLowerCase())?.amount ?? null;
  useEffect(() => {
    if (!fundingAssets.some(asset => asset.address.toLowerCase() === settlementAddress.toLowerCase())) setSettlementAddress(NATIVE_MON);
  }, [fundingAssets, settlementAddress]);

  const atomicAmount = useMemo(() => {
    try { return parseUnits(amount || "0", side === "buy" ? settlement.decimals : tokenDecimals ?? 18).toString(); }
    catch { return "0"; }
  }, [amount, side, tokenDecimals, settlement.decimals]);
  const mints = swapMints(side, token, settlement.address);
  const input = useMemo(() => ({ chain: "monad" as const, router, ...mints, amount: atomicAmount }), [atomicAmount, mints.inputMint, mints.outputMint, router]);
  const slippageBps = Math.round(Math.min(5, Math.max(0.01, Number.isFinite(slippagePct) ? slippagePct : 0.5)) * 100);

  const getQuote = async () => {
    if (!walletAddress) { setStatus("Log in to request a wallet-specific route."); return; }
    if (side === "sell" && tokenDecimals == null) { setStatus("Waiting for token decimals from Monad."); return; }
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
    if (!walletAddress || !active?.available || atomicAmount === "0" || (side === "sell" && tokenDecimals == null)) return;
    const timer = setTimeout(() => void getQuote(), 300);
    return () => clearTimeout(timer);
  }, [amount, side, slippageBps, walletAddress, token, tokenDecimals, settlementAddress, atomicAmount, active?.available, router, quoteRefresh]);
  useEffect(() => {
    if (!quote?.expiresAt || loading) return;
    const timer = setTimeout(() => { revision.current += 1; setQuote(null); setQuoteRefresh(value => value + 1); }, Math.max(0, Number(quote.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [quote, loading]);

  const execute = async () => {
    if (!walletAddress || !quote || !send) return;
    setLoading(true); setStatus(`Building the ${ROUTER_LABEL[router]} transaction…`);
    try {
      const payload = await api.transaction({ ...input, slippageBps, walletAddress, quoteId: quote.quoteId });
      const approval = payload.approval as { required?: boolean; token?: string; spender?: string; amount?: string } | undefined;
      if (approval?.required) {
        if (!approval.token || !approval.spender || !approval.amount) throw new Error("The router returned an incomplete allowance request.");
        if (await approvalNeeded(approval.token, walletAddress, approval.spender, BigInt(approval.amount))) {
          setStatus("Approve the exact token amount in Privy…");
          const approvalHash = await send({
            to: approval.token,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [approval.spender as `0x${string}`, BigInt(approval.amount)] })
          });
          setStatus("Waiting for the approval to finalize on Monad…");
          await monadClient.waitForTransactionReceipt({ hash: approvalHash as `0x${string}`, confirmations: 1, timeout: 60_000 });
        }
      }
      const transaction = payload.transaction as EvmTx | undefined;
      if (!transaction?.to || !transaction.data) throw new Error("The router did not return a complete Monad transaction.");
      setStatus("Confirm the swap with your Privy Monad wallet…");
      const hash = String(await send(transaction));
      setLastHash(hash);
      setStatus(`Submitted ${shortAddress(hash)}`);
      notify({ title: "TRADE SUBMITTED", message: `${side.toUpperCase()} ${symbol} via ${ROUTER_LABEL[router]} on Monad.`, tone: "success" });
      tradeFeedback(side);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setStatus(message); notify({ title: "TRADE NOT SENT", message, tone: "warning" });
    } finally { setLoading(false); }
  };

  const outAmount = deepFind(quote, ["outAmount", "buyAmount"]);
  const minOut = deepFind(quote, ["minimumOutAmount"]);
  const outputDecimals = side === "buy" ? tokenDecimals : settlement.decimals;
  const format = (value: unknown) => typeof value === "string" && /^\d+$/.test(value) && outputDecimals != null
    ? Number(formatUnits(BigInt(value), outputDecimals)).toLocaleString(undefined, { maximumSignificantDigits: 6 })
    : value == null ? "—" : String(value);
  const impact = deepFind(quote, ["priceImpactPct", "estimatedPriceImpact"]);
  const native = isNativeAddress(side === "buy" ? settlement.address : token);

  return <section className="panel trade-ticket">
    <div className="panel-title"><span>SPOT ORDER</span><span className="tag">PRIVY · MONAD</span></div>
    <label className="router-field"><span>ROUTING</span><select value={router} onChange={event => setRouter(event.target.value as RouterId)}>{routers.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}{item.available ? "" : " · key required"}</option>)}</select></label>
    <div className={`router-status${active?.available ? " ready" : ""}`}><span>{active?.available ? "ROUTER ONLINE" : "API KEY REQUIRED"}</span><b>{config.chain.name} · {config.chain.id}</b></div>
    <div className="side-tabs"><button className={side === "buy" ? "buy active" : ""} onClick={() => { setSide("buy"); setAmount("1"); }}>BUY {symbol}</button><button className={side === "sell" ? "sell active" : ""} onClick={() => { setSide("sell"); setAmount(tokenBalance ? String(tokenBalance) : "1"); }}>SELL {symbol}</button></div>
    <label className="amount-field"><span>AMOUNT {side === "buy" ? "FROM" : symbol}</span><div className="amount-control"><input type="number" min="0" step="any" value={amount} onChange={event => setAmount(event.target.value)} /><select aria-label={side === "buy" ? "Pay with asset" : "Receive asset"} value={settlementAddress} onChange={event => setSettlementAddress(event.target.value)}>{fundingAssets.map(asset => <option key={asset.address} value={asset.address}>{asset.symbol}{asset.balance == null ? "" : ` · ${asset.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}`}</option>)}</select></div></label>
    <label>MAX SLIPPAGE <div className="input-suffix"><input type="number" min="0.01" max="5" step="0.01" value={slippagePct} onChange={event => { setSlippagePct(Number(event.target.value)); setQuote(null); }} /><span>%</span></div></label>
    <div className="wallet-line"><span>MONAD SIGNER</span><b>{shortAddress(walletAddress)}</b></div>
    {quote ? <div className="quote-box">
      <div><span>EXPECTED OUTPUT</span><b>{format(outAmount)} {side === "buy" ? symbol : settlement.symbol}</b></div>
      <div><span>MINIMUM OUTPUT</span><b>{format(minOut)}</b></div>
      <div><span>ROUTER</span><b>{ROUTER_LABEL[router]}</b></div>
      <div><span>TOKEN APPROVAL</span><b>{native ? "NOT REQUIRED · NATIVE MON" : quote.allowanceRequired ? "EXACT AMOUNT · IF SHORT" : "NOT REQUIRED"}</b></div>
      {impact == null ? null : <div><span>PRICE IMPACT</span><b>{`${impact}%`}</b></div>}
    </div> : null}
    <button className="primary execute trade-execute" disabled={!quote || !walletAddress || !send || loading} onClick={() => void execute()}>{!active?.available ? "CONFIGURE ROUTER" : !walletAddress ? "LOG IN TO EXECUTE" : loading ? <PixelLoader label="QUOTING" /> : quote ? `EXECUTE ${side.toUpperCase()}` : "FETCHING ROUTE…"}</button>
    {status && <p className="ticket-status" role="status">{status}{lastHash && status.startsWith("Submitted") ? <> · <a href={explorerTxUrl(lastHash)} target="_blank" rel="noreferrer">MonadVision ↗</a></> : null}</p>}
  </section>;
}
