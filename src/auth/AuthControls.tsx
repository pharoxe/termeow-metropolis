import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getAccessToken, usePrivy, useWallets as useEvmWallets } from "@privy-io/react-auth";
import { useWorkspaceFeatures } from "../features/WorkspaceFeatures";
import { MONAD_PROFILE, networkLabel, networkNativeToken, type FundingNetwork, useFundingNetwork } from "../features/NetworkContext";
import { useNotifications } from "../components/NotificationSystem";
import { shortAddress } from "../lib/format";
import { hasPrivy } from "./WalletProviders";
import { api } from "../api/client";
import { TradingOnboarding } from "./TradingOnboarding";

async function copyWalletAddress(address: string) {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(address); return; }
  const field = document.createElement("textarea");
  field.value = address; field.style.position = "fixed"; field.style.opacity = "0";
  document.body.appendChild(field); field.select();
  const copied = document.execCommand("copy"); field.remove();
  if (!copied) throw new Error("Copy the wallet address shown above.");
}

/** Monad is the only network; the chip states it instead of offering a switch. */
function NetworkPicker({ compact = false }: { compact?: boolean }) {
  return <div className={`funding-network-picker ${compact ? "compact" : ""}`} role="note" aria-label="Network">
    <button type="button" className="active" aria-pressed="true" disabled>{MONAD_PROFILE.name.toUpperCase()} · {MONAD_PROFILE.chainId}</button>
  </div>;
}

function LivePrivyControl() {
  const { authenticated, login, logout, ready, user } = usePrivy();
  const { wallets: evmWallets } = useEvmWallets();
  const { notify } = useNotifications();
  const { network } = useFundingNetwork();
  const [profileOpen, setProfileOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [tradingOnboardingOpen, setTradingOnboardingOpen] = useState(false);
  const [depositTarget, setDepositTarget] = useState<FundingNetwork | null>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const evmWallet = useMemo(() => evmWallets.find(wallet => ["privy", "privy-v2"].includes(wallet.walletClientType)) ?? evmWallets[0], [evmWallets]);

  useEffect(() => {
    if (!authenticated || !user) return;
    let live = true;
    void getAccessToken().then((token) => token ? api.automationPreferences(token) : null).then((result) => {
      if (!live || !result) return;
      if (!result.preferences.onboardingCompletedAt) setTradingOnboardingOpen(true);
      else if (!localStorage.getItem(`termeow-funding-onboarding-${user.id}`)) setOnboardingOpen(true);
    }).catch(() => { if (live && !localStorage.getItem(`termeow-funding-onboarding-${user.id}`)) setOnboardingOpen(true); });
    return () => { live = false; };
  }, [authenticated, user]);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (profileRef.current && !profileRef.current.contains(event.target as Node)) setProfileOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  const finishOnboarding = () => {
    if (user) localStorage.setItem(`termeow-funding-onboarding-${user.id}`, "done");
    setOnboardingOpen(false);
  };
  const fund = async (target: FundingNetwork) => {
    const address = evmWallet?.address;
    if (!address) { notify({ title: "WALLET NOT READY", message: `${networkLabel(target)} wallet is still being created.`, tone: "warning" }); return; }
    setDepositTarget(target);
    try {
      await copyWalletAddress(address);
      notify({ title: `${networkNativeToken(target)} ADDRESS COPIED`, message: `Send only ${networkNativeToken(target)} on ${networkLabel(target)} to this embedded wallet.`, tone: "success" });
    } catch { /* The full address remains visible in the deposit sheet. */ }
  };
  useEffect(() => {
    const openFunding = () => { setProfileOpen(false); void fund(network); };
    window.addEventListener("termeow:add-funds", openFunding);
    return () => window.removeEventListener("termeow:add-funds", openFunding);
  }, [network, evmWallet?.address]);
  const activeAddress = evmWallet?.address;
  const depositAddress = evmWallet?.address;

  return <div className="profile-control" ref={profileRef}>
    <button className="auth-button primary-auth" type="button" disabled={!ready} onClick={() => authenticated ? setProfileOpen(open => !open) : login()}>
      {authenticated ? "PROFILE" : "LOG IN"}
    </button>
    {authenticated && profileOpen && <div className="profile-popover" role="dialog" aria-label="Wallet profile">
      <div className="profile-heading"><div><span>PRIVY PROFILE</span><strong>{networkLabel(network)} funding</strong></div><button type="button" onClick={() => setProfileOpen(false)}>×</button></div>
      <NetworkPicker />
      <div className="profile-wallets">
        <article className="active"><small>MONAD · MON</small><strong>{shortAddress(evmWallet?.address)}</strong><button type="button" onClick={() => void fund("monad")}>ADD FUNDS</button></article>
        <article><small>EXPLORER</small><strong>MonadVision</strong>{evmWallet?.address ? <a className="profile-link" href={`${MONAD_PROFILE.explorer}/address/${evmWallet.address}`} target="_blank" rel="noreferrer">OPEN ↗</a> : null}</article>
      </div>
      <div className="profile-foot"><span>{shortAddress(activeAddress)}</span><button type="button" onClick={() => { setProfileOpen(false); void logout(); }}>LOG OUT</button></div>
    </div>}
    {tradingOnboardingOpen && createPortal(<TradingOnboarding onComplete={() => { setTradingOnboardingOpen(false); setOnboardingOpen(true); }} />, document.body)}
    {onboardingOpen && !tradingOnboardingOpen && createPortal(<div className="onboarding-viewport"><dialog className="funding-onboarding" open aria-modal="true">
      <div className="onboarding-kicker">NEW PRIVY WALLET</div>
      <h2>FUND YOUR WALLET</h2>
      <p>Your embedded Monad wallet is ready. Deposit MON for gas and trading before you place a swap or arm an automation.</p>
      <NetworkPicker />
      <div className="onboarding-address"><span>{networkLabel(network)} wallet</span><strong>{shortAddress(activeAddress)}</strong><small>Deposit {networkNativeToken(network)}</small></div>
      <button type="button" className="onboarding-deposit" onClick={() => void fund(network)}>DEPOSIT {networkNativeToken(network)}</button>
      <button type="button" className="onboarding-skip" onClick={finishOnboarding}>I'LL FUND LATER</button>
    </dialog></div>, document.body)}
    {depositTarget && depositAddress && createPortal(<div className="deposit-address-backdrop" role="presentation">
      <section className="deposit-address-sheet" role="dialog" aria-modal="true" aria-label={`Fund ${networkLabel(depositTarget)} wallet`}>
        <div className="onboarding-kicker">PRIVY EMBEDDED WALLET</div>
        <h2>ADD {networkNativeToken(depositTarget)}</h2>
        <p>Send <b>{networkNativeToken(depositTarget)}</b> (or USDC / AUSD) on <b>{networkLabel(depositTarget)}</b> only. Sending from another network directly to this address can lose funds.</p>
        <code>{depositAddress}</code>
        <div className="deposit-address-actions"><button type="button" onClick={() => void copyWalletAddress(depositAddress).then(() => notify({ title: "ADDRESS COPIED", message: `${networkLabel(depositTarget)} wallet copied.`, tone: "success" }))}>COPY ADDRESS</button><button type="button" className="confirm" onClick={() => { setDepositTarget(null); finishOnboarding(); }}>DONE</button></div>
      </section>
    </div>, document.body)}
  </div>;
}

function PrivyPreviewControl() {
  const [active, setActive] = useState(false);
  return <div className="profile-control">
    <button className="auth-button primary-auth" type="button" onClick={() => setActive(value => !value)} aria-expanded={active}>LOG IN</button>
    {active && <div className="wallet-popover" role="status"><b>PRIVY LOGIN</b><p>Add VITE_PRIVY_APP_ID to enable social login and embedded wallets.</p><button type="button" onClick={() => setActive(false)}>CLOSE</button></div>}
  </div>;
}

export function AuthControls() {
  const { customize } = useWorkspaceFeatures();
  return <div className="auth-controls">
    <button className="auth-button" type="button" onClick={customize}>SETTINGS</button>
    {hasPrivy ? <LivePrivyControl /> : <PrivyPreviewControl />}
  </div>;
}
