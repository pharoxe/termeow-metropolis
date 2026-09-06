import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWallets } from "@privy-io/react-auth/solana";
import { api } from "../api/client";
import { money, shortAddress } from "../lib/format";
import { hasPrivy } from "../auth/WalletProviders";
import { PixelLoader } from "./PixelLoader";
import { useNotifications } from "./NotificationSystem";

type Section = "Automation" | "Portfolio" | "Referrals" | "Leaderboard";
type Row = Record<string, unknown>;
type WalletAsset = {
  mint: string;
  symbol: string;
  name: string;
  amount: number;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number | null;
};

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function numeric(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function candidateAssetRows(value: unknown, found: Row[][] = []): Row[][] {
  if (Array.isArray(value)) {
    const entries = value.filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item)));
    if (entries.some((item) => item.mint || item.address || item.tokenAddress || item.symbol)) found.push(entries);
    for (const item of value) candidateAssetRows(item, found);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) candidateAssetRows(child, found);
  }
  return found;
}

function providerMetadata(value: unknown) {
  const candidates = candidateAssetRows(value).sort((a, b) => b.length - a.length)[0] || [];
  const byMint = new Map<string, Row>();
  for (const item of candidates) {
    const mint = String(item.mint || item.address || item.tokenAddress || item.contract || "");
    if (mint) byMint.set(mint, item);
    if (String(item.symbol || "").toUpperCase() === "SOL") byMint.set("SOL", item);
  }
  return byMint;
}

function tokenAccounts(value: unknown): WalletAsset[] {
  const entries = Array.isArray(row(value).value) ? row(value).value as unknown[] : [];
  return entries.flatMap((entry) => {
    const info = row(row(row(row(entry).account).data).parsed).info;
    const parsed = row(info);
    const tokenAmount = row(parsed.tokenAmount);
    const amount = numeric(tokenAmount.uiAmountString ?? tokenAmount.uiAmount);
    const mint = String(parsed.mint || "");
    if (!mint || amount == null || amount <= 0) return [];
    return [{ mint, symbol: shortAddress(mint), name: "Solana token", amount, decimals: numeric(tokenAmount.decimals) || 0, priceUsd: null, valueUsd: null }];
  });
}

function mergeAssets(assets: WalletAsset[], metadata: Map<string, Row>) {
  const merged = new Map<string, WalletAsset>();
  for (const asset of assets) {
    const current = merged.get(asset.mint);
    if (current) current.amount += asset.amount;
    else merged.set(asset.mint, { ...asset });
  }
  return [...merged.values()].map((asset) => {
    const meta = metadata.get(asset.mint) || (asset.mint === "SOL" ? metadata.get("SOL") : undefined) || {};
    const price = numeric(meta.priceUsd ?? meta.price_usd ?? meta.usdPrice ?? meta.price);
    const suppliedValue = numeric(meta.valueUsd ?? meta.value_usd ?? meta.usdValue ?? meta.usd_value);
    return {
      ...asset,
      symbol: String(meta.symbol || asset.symbol).toUpperCase(),
      name: String(meta.name || asset.name),
      priceUsd: price,
      valueUsd: suppliedValue ?? (price == null ? null : price * asset.amount)
    };
  }).sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
}

function PrivyAddress({ section, directAddress, onBack }: { section: Section; directAddress?: string; onBack: () => void }) {
  const { wallets } = useWallets();
  return <AccountSurface section={section} address={directAddress || wallets[0]?.address} onBack={onBack} />;
}

export function AccountScreen({ section, onBack }: { section: Section; onBack: () => void }) {
  const { publicKey } = useWallet();
  const directAddress = publicKey?.toBase58();
  return hasPrivy
    ? <PrivyAddress section={section} directAddress={directAddress} onBack={onBack} />
    : <AccountSurface section={section} address={directAddress} onBack={onBack} />;
}

function AccountSurface({ section, address, onBack }: { section: Section; address?: string; onBack: () => void }) {
  if (section === "Automation") return <Automation address={address} onBack={onBack} />;
  if (!address) return <Disconnected section={section} onBack={onBack} />;
  if (section === "Portfolio") return <Portfolio address={address} onBack={onBack} />;
  if (section === "Referrals") return <Referrals address={address} onBack={onBack} />;
  return <Leaderboard address={address} onBack={onBack} />;
}

function PageHead({ title, address, eyebrow, onBack }: { title: string; address?: string; eyebrow: string; onBack: () => void }) {
  return <div className="account-page-head"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{address && <p>WALLET · {shortAddress(address)}</p>}</div><button onClick={onBack}>← TRADE</button></div>;
}

function Disconnected({ section, onBack }: { section: Section; onBack: () => void }) {
  return <section className="navigation-page account-page"><PageHead title={section} eyebrow="WALLET REQUIRED" onBack={onBack} /><div className="account-empty"><span className="account-pixel" aria-hidden="true">□</span><h2>Connect a wallet</h2><p>Select Wallet or sign in with Privy to unlock your {section.toLowerCase()} workspace.</p></div></section>;
}

function Portfolio({ address, onBack }: { address: string; onBack: () => void }) {
  const [assets, setAssets] = useState<WalletAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [valuationUnavailable, setValuationUnavailable] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const tokenParams = (programId: string) => [address, { programId }, { encoding: "jsonParsed" }];
    Promise.allSettled([
      api.rpc<{ value?: number }>("getBalance", [address, { commitment: "confirmed" }]),
      api.rpc<Row>("getTokenAccountsByOwner", tokenParams(TOKEN_PROGRAM)),
      api.rpc<Row>("getTokenAccountsByOwner", tokenParams(TOKEN_2022_PROGRAM)),
      api.portfolio(address)
    ]).then((results) => {
      if (!active) return;
      const [solResult, tokenResult, token2022Result, providerResult] = results;
      const next: WalletAsset[] = [];
      if (solResult.status === "fulfilled") {
        const lamports = numeric(solResult.value.value) || 0;
        if (lamports > 0) next.push({ mint: "SOL", symbol: "SOL", name: "Solana", amount: lamports / 1_000_000_000, decimals: 9, priceUsd: null, valueUsd: null });
      }
      if (tokenResult.status === "fulfilled") next.push(...tokenAccounts(tokenResult.value));
      if (token2022Result.status === "fulfilled") next.push(...tokenAccounts(token2022Result.value));
      const metadata = providerResult.status === "fulfilled" ? providerMetadata(providerResult.value) : new Map<string, Row>();
      setValuationUnavailable(providerResult.status === "rejected");
      setAssets(mergeAssets(next, metadata));
      if (solResult.status === "rejected" && tokenResult.status === "rejected" && token2022Result.status === "rejected") setError("Wallet assets are temporarily unavailable from the Solana RPC.");
      setLoading(false);
    });
    return () => { active = false; };
  }, [address]);
  const total = useMemo(() => assets.reduce((sum, asset) => sum + (asset.valueUsd || 0), 0), [assets]);
  const valued = assets.some((asset) => asset.valueUsd != null);
  return <section className="navigation-page account-page"><PageHead title="Portfolio" eyebrow="SOLANA ASSETS" address={address} onBack={onBack} />
    <div className="account-summary"><article><span>PORTFOLIO VALUE</span><strong>{valued ? money(total) : "—"}</strong><small>{valuationUnavailable ? "Balances live · valuation feed unavailable" : "ClawPump valuation + Solana balances"}</small></article><article><span>ASSETS</span><strong>{assets.length}</strong><small>SPL + Token-2022 + native SOL</small></article><article><span>NETWORK</span><strong>MAINNET</strong><small>Connected wallet inventory</small></article></div>
    {loading ? <div className="account-empty"><PixelLoader label="READING WALLET ASSETS" /></div> : error ? <div className="account-empty"><h2>Portfolio unavailable</h2><p>{error}</p></div> : assets.length ? <div className="asset-table-wrap"><table className="account-table"><thead><tr><th>ASSET</th><th>BALANCE</th><th>PRICE</th><th>VALUE</th></tr></thead><tbody>{assets.map((asset) => <tr key={asset.mint}><td><b>{asset.symbol}</b><small>{asset.name} · {asset.mint === "SOL" ? "NATIVE" : shortAddress(asset.mint)}</small></td><td>{asset.amount.toLocaleString(undefined, { maximumFractionDigits: Math.min(asset.decimals, 8) })}</td><td>{money(asset.priceUsd)}</td><td>{money(asset.valueUsd)}</td></tr>)}</tbody></table></div> : <div className="account-empty"><h2>No funded assets</h2><p>This wallet has no non-zero Solana assets to display.</p></div>}
  </section>;
}

function Referrals({ address, onBack }: { address: string; onBack: () => void }) {
  const [copied, setCopied] = useState(false);
  const code = `MEOW-${address.slice(0, 4).toUpperCase()}`;
  const link = `${window.location.origin}/onchain?ref=${code}`;
  const copy = async () => { await navigator.clipboard.writeText(link); setCopied(true); window.setTimeout(() => setCopied(false), 1600); };
  return <section className="navigation-page account-page"><PageHead title="Referrals" eyebrow="CONNECTED PREVIEW" address={address} onBack={onBack} />
    <div className="account-summary"><article><span>REFERRED TRADERS</span><strong>0</strong><small>Placeholder value</small></article><article><span>VOLUME</span><strong>$0.00</strong><small>Placeholder value</small></article><article><span>REWARDS</span><strong>$0.00</strong><small>Placeholder value</small></article></div>
    <div className="referral-card"><span>YOUR REFERRAL LINK</span><strong>{link}</strong><p>Share termeow. Reward tiers and attribution will activate when the referral program launches.</p><button onClick={copy}>{copied ? "COPIED" : "COPY LINK"}</button></div>
    <div className="account-split"><article><span>REFERRAL CODE</span><strong>{code}</strong></article><article><span>REWARD TIER</span><strong>GENESIS</strong></article></div>
  </section>;
}

const MOCK_LEADERS = [
  ["01", "pixelwhale", "$3.82M", "+42.8%"], ["02", "solsignal", "$2.16M", "+31.4%"], ["03", "trenches.exe", "$1.48M", "+27.1%"], ["04", "green candle", "$982K", "+19.6%"], ["05", "liquiditycat", "$744K", "+16.2%"]
];

function Leaderboard({ address, onBack }: { address: string; onBack: () => void }) {
  return <section className="navigation-page account-page"><PageHead title="Leaderboard" eyebrow="CONNECTED PREVIEW" address={address} onBack={onBack} />
    <div className="account-summary"><article><span>YOUR RANK</span><strong>—</strong><small>Ranking begins after your first trade</small></article><article><span>YOUR VOLUME</span><strong>$0.00</strong><small>Placeholder value</small></article><article><span>YOUR PNL</span><strong>$0.00</strong><small>Placeholder value</small></article></div>
    <div className="asset-table-wrap"><table className="account-table leaderboard-table"><thead><tr><th>RANK</th><th>TRADER</th><th>VOLUME</th><th>PNL</th></tr></thead><tbody>{MOCK_LEADERS.map(([rank, trader, volume, pnl]) => <tr key={rank}><td>{rank}</td><td><b>{trader}</b><small>Preview trader</small></td><td>{volume}</td><td className="up">{pnl}</td></tr>)}<tr className="you-row"><td>—</td><td><b>YOU · {shortAddress(address)}</b><small>Complete a trade to enter</small></td><td>$0.00</td><td>—</td></tr></tbody></table></div>
  </section>;
}

type AutomationStrategy = {
  id: string;
  name: string;
  symbol: string;
  state: "LIVE" | "PAUSED" | "CANCELLED";
  allocation: number;
  trigger: string;
  exit: string;
  lastCheck: string;
  progress: number;
};

const INITIAL_AUTOMATIONS: AutomationStrategy[] = [
  { id: "reversal", name: "CVD + STOCH RSI REVERSAL", symbol: "$ANSEM", state: "LIVE", allocation: 250, trigger: "STOCH RSI LOCAL BOTTOM + POSITIVE CVD", exit: "LOCAL TOP OR WHALE SELL SIGNAL", lastCheck: "8S AGO", progress: 72 },
  { id: "breakout", name: "LIQUIDITY BREAKOUT SCOUT", symbol: "$ANSEM", state: "LIVE", allocation: 125, trigger: "15M CLOSE ABOVE LOCAL RESISTANCE", exit: "TRAIL 4.5% FROM LOCAL HIGH", lastCheck: "14S AGO", progress: 48 },
  { id: "guard", name: "WHALE EXIT GUARD", symbol: "PORTFOLIO", state: "PAUSED", allocation: 500, trigger: "TOP HOLDER SELL + NEGATIVE CVD", exit: "REDUCE POSITION BY 35%", lastCheck: "PAUSED", progress: 18 }
];

function Automation({ address, onBack }: { address?: string; onBack: () => void }) {
  const { notify } = useNotifications();
  const [strategies, setStrategies] = useState(INITIAL_AUTOMATIONS);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const liveCount = strategies.filter((strategy) => strategy.state === "LIVE").length;
  const activeAllocation = strategies.filter((strategy) => strategy.state !== "CANCELLED").reduce((total, strategy) => total + strategy.allocation, 0);
  const updateAllocation = (id: string, allocation: number) => setStrategies((current) => current.map((strategy) => strategy.id === id ? { ...strategy, allocation: Math.max(0, allocation) } : strategy));
  const cancel = (strategy: AutomationStrategy) => {
    setStrategies((current) => current.map((item) => item.id === strategy.id ? { ...item, state: "CANCELLED" } : item));
    setConfirming(null);
    notify({ title: "AUTOMATION CANCELLED", message: `${strategy.name} will no longer evaluate or place trades.`, tone: "warning" });
  };
  return <section className="navigation-page account-page automation-page">
    <PageHead title="Automation" eyebrow="LIVE AGENT STRATEGIES" address={address} onBack={onBack} />
    {!address && <div className="automation-wallet-note"><b>WALLET NOT CONNECTED</b><span>Strategy monitoring is visible. Connect a wallet to authorize edits and future Session Key execution.</span></div>}
    <div className="account-summary"><article><span>LIVE STRATEGIES</span><strong>{liveCount}</strong><small>Continuously evaluating signals</small></article><article><span>ALLOCATED</span><strong>{money(activeAllocation)}</strong><small>Maximum active strategy capital</small></article><article><span>EXECUTION</span><strong>{address ? "READY" : "LOCKED"}</strong><small>{address ? "Wallet connected" : "Wallet authorization required"}</small></article></div>
    <div className="automation-grid">
      {strategies.map((strategy) => <article key={strategy.id} className={`automation-card ${strategy.state.toLowerCase()}`}>
        <header><div><span>{strategy.symbol}</span><h2>{strategy.name}</h2></div><b className={`automation-state ${strategy.state.toLowerCase()}`}><i />{strategy.state}</b></header>
        <div className="automation-track"><span style={{ width: `${strategy.progress}%` }} /></div>
        <dl><div><dt>ENTRY LOGIC</dt><dd>{strategy.trigger}</dd></div><div><dt>EXIT LOGIC</dt><dd>{strategy.exit}</dd></div><div><dt>ALLOCATION</dt><dd>{money(strategy.allocation)}</dd></div><div><dt>LAST CHECK</dt><dd>{strategy.lastCheck}</dd></div></dl>
        {editing === strategy.id && strategy.state !== "CANCELLED" && <div className="automation-editor"><label>MAX ALLOCATION USDC<input type="number" min="0" value={strategy.allocation} onChange={(event) => updateAllocation(strategy.id, Number(event.target.value))} /></label><button type="button" onClick={() => { setEditing(null); notify({ title: "STRATEGY UPDATED", message: `${strategy.name} saved with a ${money(strategy.allocation)} limit.`, tone: "success" }); }}>SAVE CHANGES</button></div>}
        {confirming === strategy.id && strategy.state !== "CANCELLED" ? <div className="automation-confirm"><span>Cancel this strategy and stop all future evaluations?</span><button type="button" onClick={() => cancel(strategy)}>CONFIRM CANCEL</button><button type="button" onClick={() => setConfirming(null)}>KEEP LIVE</button></div> : <footer><button type="button" disabled={strategy.state === "CANCELLED" || !address} onClick={() => setEditing(editing === strategy.id ? null : strategy.id)}>{editing === strategy.id ? "CLOSE" : "MODIFY"}</button><button type="button" className="danger" disabled={strategy.state === "CANCELLED" || !address} onClick={() => setConfirming(strategy.id)}>CANCEL</button></footer>}
      </article>)}
    </div>
  </section>;
}
