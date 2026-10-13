import { useEffect, useMemo, useState } from "react";
import { getAccessToken, usePrivy, useWallets } from "@privy-io/react-auth";
import { api } from "../api/client";
import { money, shortAddress } from "../lib/format";
import { hasPrivy } from "../auth/WalletProviders";
import { PixelLoader } from "./PixelLoader";
import { useAutomationDelegation } from "../auth/useAutomationDelegation";

import type { WalletAsset } from "../../shared/portfolio";
import type { AutomationRecord } from "../../shared/automation";

type Section = "Portfolio" | "Automation";

function PrivyAddress({ section, onBack }: { section: Section; onBack: () => void }) {
  const { wallets } = useWallets();
  const { authenticated } = usePrivy();
  const wallet = wallets.find(item => ["privy", "privy-v2"].includes(item.walletClientType)) ?? wallets[0];
  return <AccountSurface section={section} authenticated={authenticated} address={wallet?.address} onBack={onBack} />;
}

export function AccountScreen({ section, onBack }: { section: Section; onBack: () => void }) {
  return hasPrivy
    ? <PrivyAddress section={section} onBack={onBack} />
    : <AccountSurface section={section} authenticated={false} onBack={onBack} />;
}

function AccountSurface({ section, address, authenticated, onBack }: { section: Section; address?: string; authenticated: boolean; onBack: () => void }) {
  if (!authenticated) return <Disconnected section={section} onBack={onBack} />;
  if (section === "Automation") return <AutomationControlPlane address={address} onBack={onBack} />;
  if (!address) return <Disconnected section={section} onBack={onBack} />;
  return <Portfolio address={address} onBack={onBack} />;
}

function PageHead({ title, address, eyebrow, onBack }: { title: string; address?: string; eyebrow: string; onBack: () => void }) {
  return <div className="account-page-head"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{address && <p>WALLET · {shortAddress(address)}</p>}</div><button onClick={onBack}>← TRADE</button></div>;
}

function Disconnected({ section, onBack }: { section: Section; onBack: () => void }) {
  return <section className="navigation-page account-page"><PageHead title={section} eyebrow="PRIVY LOGIN REQUIRED" onBack={onBack} /><div className="account-empty"><span className="account-pixel" aria-hidden="true">□</span><h2>Log in to continue</h2><p>Use Log In to create your embedded Monad wallet.</p></div></section>;
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
    api.monadPortfolio(address).then(result => {
      if (!active) return;
      setAssets(result.assets);
      setValuationUnavailable(result.valuationUnavailable);
      setPartial(result.partial);
    }).catch(() => {
      if (active) setError("Wallet assets are temporarily unavailable from the Monad RPC.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [address, retry]);
  const total = useMemo(() => assets.reduce((sum, asset) => sum + (asset.valueUsd || 0), 0), [assets]);
  const valued = assets.some((asset) => asset.valueUsd != null);
  return <section className="navigation-page account-page"><PageHead title="Portfolio" eyebrow="MONAD ASSETS" address={address} onBack={onBack} />
    <div className="account-summary"><article><span>{partial || valuationUnavailable ? "KNOWN ASSET VALUE" : "PORTFOLIO VALUE"}</span><strong>{valued ? money(total) : "—"}</strong><small>{valuationUnavailable ? "Balances live · some prices unavailable" : "DexScreener prices + on-chain balances"}</small></article><article><span>ASSETS</span><strong>{assets.length}</strong><small>Native MON + WMON / USDC / AUSD</small></article><article><span>NETWORK</span><strong>MONAD</strong><small>Connected wallet inventory</small></article></div>
    {partial && <p role="status">Some wallet balances could not be loaded. <button onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
    {loading ? <div className="account-empty"><PixelLoader label="READING WALLET ASSETS" /></div> : error ? <div className="account-empty"><h2>Portfolio unavailable</h2><p>{error}</p><button onClick={() => setRetry(value => value + 1)}>Retry</button></div> : assets.length ? <div className="asset-table-wrap"><table className="account-table"><thead><tr><th>ASSET</th><th>BALANCE</th><th>PRICE</th><th>VALUE</th></tr></thead><tbody>{assets.map((asset) => <tr key={asset.mint}><td><b>{asset.symbol}</b><small>{asset.name} · {asset.mint === "MON" ? "NATIVE" : shortAddress(asset.mint)}</small></td><td>{asset.amount.toLocaleString(undefined, { maximumFractionDigits: Math.min(asset.decimals, 8) })}</td><td>{money(asset.priceUsd)}</td><td>{money(asset.valueUsd)}</td></tr>)}</tbody></table></div> : <div className="account-empty"><h2>No funded assets</h2><p>This wallet holds no MON, WMON, USDC or AUSD yet. Fund it from Profile → Add funds.</p></div>}
  </section>;
}

function marketCapRange(row: AutomationRecord) {
  const min = row.intent.marketCapMinUsd;
  const max = row.intent.marketCapMaxUsd;
  if (min != null && max != null) return `${money(min, true)} – ${money(max, true)}`;
  if (min != null) return `≥ ${money(min, true)}`;
  if (max != null) return `≤ ${money(max, true)}`;
  return "ANY MARKET CAP";
}

function AutomationToken({ row }: { row: AutomationRecord }) {
  const symbol = (row.intent.tokenSymbol || "TOKEN").replace(/^\$/, "").toUpperCase();
  return <div className="automation-token">
    <span aria-hidden="true">{symbol.slice(0, 1)}</span>
    {row.intent.tokenLogoUrl && <img src={row.intent.tokenLogoUrl} alt="" onError={(event) => { event.currentTarget.remove(); }} />}
    <div><strong>${symbol}</strong><small>{row.intent.tokenName || (row.intent.tokenAddress ? shortAddress(row.intent.tokenAddress) : "ANY TOKEN")}</small></div>
  </div>;
}

function AutomationControlPlane({ address, onBack }: { address?: string; onBack: () => void }) {
  const [rows, setRows] = useState<AutomationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [delegation, setDelegation] = useState<{ configured: boolean; active: boolean; allowedContracts: string[] } | null>(null);
  const [delegating, setDelegating] = useState(false);
  const { ensureDelegated } = useAutomationDelegation(address);
  const load = async () => {
    setLoading(true); setError("");
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Privy session expired.");
      const [automationResult, delegationResult] = await Promise.all([api.automations(token), api.automationDelegation(token)]);
      setRows(automationResult.automations); setDelegation(delegationResult);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); const refresh = () => void load(); window.addEventListener("termeow:automation-approved", refresh); return () => window.removeEventListener("termeow:automation-approved", refresh); }, []);
  const cancel = async (id: string) => {
    try { const token = await getAccessToken(); if (!token) throw new Error("Privy session expired."); await api.cancelAutomation(token, id); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const live = rows.filter((row) => ["armed", "executing"].includes(row.status)).length;
  const enableDelegation = async () => {
    setDelegating(true); setError("");
    try { await ensureDelegated(); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setDelegating(false); }
  };
  return <section className="navigation-page account-page automation-page"><PageHead title="Automation" eyebrow="AGENT CONTROL PLANE" onBack={onBack} />
    <div className="account-summary"><article><span>LIVE STRATEGIES</span><strong>{live}</strong><small>Passkey-approved only</small></article><article><span>PENDING APPROVAL</span><strong>{rows.filter((row) => row.status === "pending_approval").length}</strong><small>Voice cannot self-approve</small></article><article><span>EXECUTION</span><strong>PRIVY</strong><small>Kuru Flow · 0x</small></article></div>
    <div className="automation-policy"><b>UNATTENDED MONAD · {delegation?.active ? "ENABLED" : delegation?.configured ? "NOT DELEGATED" : "SERVER SETUP REQUIRED"}</b><p>Kuru Flow-only signing on chain 143, restricted by a Privy policy and a second server-side contract inspection. Your wallet remains user-owned.</p>{delegation?.configured && !delegation.active && <button type="button" disabled={delegating || !address} onClick={() => void enableDelegation()}>{delegating ? "AUTHORIZING…" : "ENABLE WITH PRIVY"}</button>}</div>
    {loading ? <div className="account-empty"><PixelLoader label="READING AUTOMATIONS" /></div> : error ? <div className="account-empty"><h2>Control plane unavailable</h2><p>{error}</p><button onClick={() => void load()}>Retry</button></div> : rows.length ? <div className="automation-list">{rows.map((row) => <article key={row.id} data-status={row.status}>
      <div className="automation-main"><AutomationToken row={row} /><span className="automation-kind">{row.intent.kind.replaceAll("_", " ")} · {row.intent.chain}</span><strong className="automation-description">{row.intent.description}</strong>
        <p className="automation-condition"><b>WHEN</b>{row.intent.condition || "Execute immediately after approval."}</p>
        {row.intent.trackedWallet && <small className="automation-wallet">TRACKED WALLET · <b>{row.intent.trackedWalletUsername ? row.intent.trackedWalletUsername.replace(/^@/, "") : "UNLABELLED"}</b> · {shortAddress(row.intent.trackedWallet)}</small>}
        {row.intent.trackedXAccount && <small className="automation-wallet">TRACKED X ACCOUNT · <b>@{row.intent.trackedXAccount.replace(/^@/, "")}</b></small>}
        {row.intent.exitConditions?.map((exit) => <p className="automation-condition automation-exit" key={exit.id}><b>AFTER ENTRY · SELL {exit.sellPercent}%</b>{exit.condition}</p>)}
        <small className="automation-timing">CREATED · {new Date(row.createdAt).toLocaleString()}{row.intent.durationHours ? ` · EXPIRES ${new Date(row.createdAt + row.intent.durationHours * 3_600_000).toLocaleString()}` : ""}</small>
      </div>
      <dl><div><dt>STATUS</dt><dd>{row.status}</dd></div><div><dt>ACTION</dt><dd>{row.intent.side || "monitor"}</dd></div><div><dt>ALLOCATION</dt><dd>{row.intent.amountMode === "wallet_percent" ? `${row.intent.allocationPercent}% OF WALLET` : row.intent.amount || "—"}</dd></div><div><dt>MARKET CAP RANGE</dt><dd>{marketCapRange(row)}</dd></div><div><dt>ENTRY DRIFT</dt><dd>{row.intent.entryPriceTolerancePct == null ? "—" : `≤ ${row.intent.entryPriceTolerancePct}%`}</dd></div><div><dt>SLIPPAGE</dt><dd>{row.intent.slippageBps == null ? "AUTO" : `${(row.intent.slippageBps / 100).toFixed(2)}%`}</dd></div><div><dt>WINDOW</dt><dd>{row.intent.durationHours ? `${row.intent.durationHours}H` : "IMMEDIATE"}</dd></div><div><dt>ROUTER</dt><dd>{row.intent.router || "—"}</dd></div>{row.lastSignal && <div><dt>LAST SIGNAL</dt><dd>{row.lastSignal.source} · {shortAddress(row.lastSignal.tokenAddress)}</dd></div>}<div><dt>LINKED EXITS</dt><dd>{row.activeExitConditions?.length ? `${row.activeExitConditions.length} ACTIVE` : row.intent.exitConditions?.length ? `${row.intent.exitConditions.length} DORMANT` : "NONE"}</dd></div></dl>
      {row.failure && <p className="automation-failure">{row.failure}</p>}{row.transactionHash && <small>TX · {row.transactionHash}</small>}
      {!["completed", "cancelled"].includes(row.status) && <button type="button" onClick={() => void cancel(row.id)}>CANCEL</button>}
    </article>)}</div> : <div className="account-empty"><h2>No strategies yet</h2><p>Ask Termeow to propose a monitored strategy or swap. Nothing arms until you confirm the exact action with a passkey.</p></div>}
  </section>;
}
