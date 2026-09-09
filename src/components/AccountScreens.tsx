import { useEffect, useMemo, useState } from "react";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { api } from "../api/client";
import { money, shortAddress } from "../lib/format";
import { hasPrivy } from "../auth/WalletProviders";
import { PixelLoader } from "./PixelLoader";

import type { WalletAsset } from "../../shared/portfolio";

type Section = "Portfolio";

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
  const [partial, setPartial] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setPartial(false);
    setAssets([]);
    api.portfolio(address).then(result => {
      if (!active) return;
      setAssets(result.assets);
      setValuationUnavailable(result.valuationUnavailable);
      setPartial(result.partial);
    }).catch(() => {
      if (active) setError("Wallet assets are temporarily unavailable from the Solana RPC.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [address, retry]);
  const total = useMemo(() => assets.reduce((sum, asset) => sum + (asset.valueUsd || 0), 0), [assets]);
  const valued = assets.some((asset) => asset.valueUsd != null);
  return <section className="navigation-page account-page"><PageHead title="Portfolio" eyebrow="SOLANA ASSETS" address={address} onBack={onBack} />
    <div className="account-summary"><article><span>{partial || valuationUnavailable ? "KNOWN ASSET VALUE" : "PORTFOLIO VALUE"}</span><strong>{valued ? money(total) : "—"}</strong><small>{valuationUnavailable ? "Balances live · some prices unavailable" : "Market prices + Solana balances"}</small></article><article><span>ASSETS</span><strong>{assets.length}</strong><small>SPL + Token-2022 + native SOL</small></article><article><span>NETWORK</span><strong>MAINNET</strong><small>Connected wallet inventory</small></article></div>
    {partial && <p role="status">Some wallet balances could not be loaded. <button onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
    {loading ? <div className="account-empty"><PixelLoader label="READING WALLET ASSETS" /></div> : error ? <div className="account-empty"><h2>Portfolio unavailable</h2><p>{error}</p><button onClick={() => setRetry(value => value + 1)}>Retry</button></div> : assets.length ? <div className="asset-table-wrap"><table className="account-table"><thead><tr><th>ASSET</th><th>BALANCE</th><th>PRICE</th><th>VALUE</th></tr></thead><tbody>{assets.map((asset) => <tr key={asset.mint}><td><b>{asset.symbol}</b><small>{asset.name} · {asset.mint === "SOL" ? "NATIVE" : shortAddress(asset.mint)}</small></td><td>{asset.amount.toLocaleString(undefined, { maximumFractionDigits: Math.min(asset.decimals, 8) })}</td><td>{money(asset.priceUsd)}</td><td>{money(asset.valueUsd)}</td></tr>)}</tbody></table></div> : <div className="account-empty"><h2>No funded assets</h2><p>This wallet has no non-zero Solana assets to display.</p></div>}
  </section>;
}
