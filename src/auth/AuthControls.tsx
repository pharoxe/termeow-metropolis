import { useEffect, useMemo, useRef, useState } from "react";
import { useFundWallet as useEvmFundWallet, usePrivy, useWallets as useEvmWallets } from "@privy-io/react-auth";
import { useFundWallet as useSolanaFundWallet, useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { useWorkspaceFeatures } from "../features/WorkspaceFeatures";
import { networkLabel, networkNativeToken, ROBINHOOD_CHAIN, type FundingNetwork, useFundingNetwork } from "../features/NetworkContext";
import { useNotifications } from "../components/NotificationSystem";
import { shortAddress } from "../lib/format";
import { hasPrivy } from "./WalletProviders";

function NetworkPicker({ compact = false }: { compact?: boolean }) {
  const { network, setNetwork } = useFundingNetwork();
  const { notify } = useNotifications();
  const choose = (next: FundingNetwork) => {
    setNetwork(next);
    notify({ title: `${networkLabel(next).toUpperCase()} WALLET`, message: `${networkNativeToken(next)} funding is selected.`, tone: "info" });
  };
  return <div className={`funding-network-picker ${compact ? "compact" : ""}`} role="group" aria-label="Funding network">
    <button type="button" className={network === "robinhood" ? "active" : ""} aria-pressed={network === "robinhood"} onClick={() => choose("robinhood")}>ROBINHOOD</button>
    <button type="button" className={network === "solana" ? "active" : ""} aria-pressed={network === "solana"} onClick={() => choose("solana")}>SOLANA</button>
  </div>;
}

function LivePrivyControl() {
  const { authenticated, login, logout, ready, user } = usePrivy();
  const { wallets: evmWallets } = useEvmWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  const { fundWallet: fundEvmWallet } = useEvmFundWallet();
  const { fundWallet: fundSolanaWallet } = useSolanaFundWallet();
  const { notify } = useNotifications();
  const { network, setNetwork } = useFundingNetwork();
  const [profileOpen, setProfileOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [transferMode, setTransferMode] = useState<"swap" | "bridge">("swap");
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState("");
  const profileRef = useRef<HTMLDivElement>(null);
  const evmWallet = useMemo(() => evmWallets.find(wallet => ["privy", "privy-v2"].includes(wallet.walletClientType)) ?? evmWallets[0], [evmWallets]);
  const solanaWallet = solanaWallets[0];

  useEffect(() => {
    if (!authenticated || !user) return;
    const socialLogin = user.linkedAccounts.some(account => account.type !== "wallet" && account.type !== "smart_wallet");
    const key = `termeow-funding-onboarding-${user.id}`;
    if (socialLogin && !localStorage.getItem(key)) setOnboardingOpen(true);
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
    setNetwork(target);
    try {
      if (target === "solana") {
        if (!solanaWallet?.address) throw new Error("Solana wallet is still being created.");
        await fundSolanaWallet({ address: solanaWallet.address, options: { chain: "solana:mainnet", asset: "native-currency" } });
      } else {
        if (!evmWallet?.address) throw new Error("Robinhood wallet is still being created.");
        await fundEvmWallet({ address: evmWallet.address, options: { chain: ROBINHOOD_CHAIN } });
      }
      notify({ title: `FUND ${networkNativeToken(target)}`, message: `${networkLabel(target)} deposit flow opened.`, tone: "success" });
      finishOnboarding();
    } catch (reason) {
      notify({ title: "DEPOSIT UNAVAILABLE", message: reason instanceof Error ? reason.message : String(reason), tone: "warning" });
    }
  };
  const activeAddress = network === "solana" ? solanaWallet?.address : evmWallet?.address;
  const buildPreview = () => {
    if (!(Number(amount) > 0)) return setPreview("ENTER AN AMOUNT TO CONTINUE");
    const receive = transferMode === "swap" ? "USDC" : networkNativeToken(network === "solana" ? "robinhood" : "solana");
    setPreview(`${transferMode.toUpperCase()} ${amount} ${networkNativeToken(network)} → ${receive} · ROUTE PREVIEW ONLY`);
  };

  return <div className="profile-control" ref={profileRef}>
    <button className="auth-button primary-auth" type="button" disabled={!ready} onClick={() => authenticated ? setProfileOpen(open => !open) : login()}>
      {authenticated ? "PROFILE" : "LOG IN"}
    </button>
    {authenticated && profileOpen && <div className="profile-popover" role="dialog" aria-label="Wallet profile">
      <div className="profile-heading"><div><span>PRIVY PROFILE</span><strong>{networkLabel(network)} funding</strong></div><button type="button" onClick={() => setProfileOpen(false)}>×</button></div>
      <NetworkPicker />
      <div className="profile-wallets">
        <article className={network === "robinhood" ? "active" : ""}><small>ROBINHOOD CHAIN · ETH</small><strong>{shortAddress(evmWallet?.address)}</strong><button type="button" onClick={() => void fund("robinhood")}>FUND ETH</button></article>
        <article className={network === "solana" ? "active" : ""}><small>SOLANA · SOL</small><strong>{shortAddress(solanaWallet?.address)}</strong><button type="button" onClick={() => void fund("solana")}>FUND SOL</button></article>
      </div>
      <section className="profile-transfer">
        <div className="transfer-tabs"><button type="button" className={transferMode === "swap" ? "active" : ""} onClick={() => { setTransferMode("swap"); setPreview(""); }}>SWAP</button><button type="button" className={transferMode === "bridge" ? "active" : ""} onClick={() => { setTransferMode("bridge"); setPreview(""); }}>BRIDGE</button></div>
        <label><span>PAY · {networkNativeToken(network)}</span><input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00" /></label>
        <button type="button" className="profile-action" onClick={buildPreview}>PREVIEW {transferMode.toUpperCase()}</button>
        {preview && <small className="transfer-preview">{preview}</small>}
      </section>
      <div className="profile-foot"><span>{shortAddress(activeAddress)}</span><button type="button" onClick={() => { setProfileOpen(false); void logout(); }}>LOG OUT</button></div>
    </div>}
    {onboardingOpen && <dialog className="funding-onboarding" open aria-modal="true">
      <div className="onboarding-kicker">NEW PRIVY WALLET</div>
      <h2>FUND YOUR WALLET</h2>
      <p>Your embedded wallets are ready. Choose a network and deposit its native token before trading.</p>
      <NetworkPicker />
      <div className="onboarding-address"><span>{networkLabel(network)} wallet</span><strong>{shortAddress(activeAddress)}</strong><small>Deposit {networkNativeToken(network)}</small></div>
      <button type="button" className="onboarding-deposit" onClick={() => void fund(network)}>DEPOSIT {networkNativeToken(network)}</button>
      <button type="button" className="onboarding-skip" onClick={finishOnboarding}>I'LL FUND LATER</button>
    </dialog>}
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
