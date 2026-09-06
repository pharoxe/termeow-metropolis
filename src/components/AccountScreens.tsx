import { useEffect, useMemo, useState } from "react";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { api } from "../api/client";
import { money, shortAddress } from "../lib/format";
import { hasPrivy } from "../auth/WalletProviders";
import { PixelLoader } from "./PixelLoader";

type Section = "Portfolio";
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

function PrivyAddress({ section, onBack }: { section: Section; onBack: () => void }) {
  const { wallets: solanaWallets } = useSolanaWallets();
  return <AccountSurface section={section} address={solanaWallets[0]?.address} onBack={onBack} />;
}

export function AccountScreen({ section, onBack }: { section: Section; onBack: () => void }) {
  return hasPrivy
    ? <PrivyAddress section={section} onBack={onBack} />
    : <AccountSurface section={section} onBack={onBack} />;
}

function AccountSurface({ section, address, onBack }: { section: Section; address?: string; onBack: () => void }) {
  if (!address) return <Disconnected section={section} onBack={onBack} />;
  return <Portfolio address={address} onBack={onBack} />;
}

function PageHead({ title, address, eyebrow, onBack }: { title: string; address?: string; eyebrow: string; onBack: () => void }) {
  return <div className="account-page-head"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{address && <p>WALLET · {shortAddress(address)}</p>}</div><button onClick={onBack}>← TRADE</button></div>;
}

function Disconnected({ section, onBack }: { section: Section; onBack: () => void }) {
  return <section className="navigation-page account-page"><PageHead title={section} eyebrow="PRIVY LOGIN REQUIRED" onBack={onBack} /><div className="account-empty"><span className="account-pixel" aria-hidden="true">□</span><h2>Log in to continue</h2><p>Use Log In to create your embedded Solana and Robinhood wallets.</p></div></section>;
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
