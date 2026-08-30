import { useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import { hasPrivy } from "./WalletProviders";
import { shortAddress } from "../lib/format";

function LivePrivyControl() {
  const { authenticated, login, logout, ready } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets[0];
  return (
    <button className="auth-button embedded" disabled={!ready} onClick={() => authenticated ? logout() : login()}>
      <span className={`status-dot ${authenticated ? "live" : ""}`} />
      {authenticated ? `PRIVY ${shortAddress(wallet?.address)}` : "PRIVY EMBEDDED"}
    </button>
  );
}

function MockPrivyControl() {
  const [active, setActive] = useState(() => localStorage.getItem("tv_mock_privy") === "1");
  const toggle = () => {
    const next = !active;
    setActive(next);
    localStorage.setItem("tv_mock_privy", next ? "1" : "0");
  };
  return (
    <button className="auth-button embedded" onClick={toggle} title="Add VITE_PRIVY_APP_ID for live Privy authentication">
      <span className={`status-dot ${active ? "live" : ""}`} />
      {active ? "PRIVY MOCK ACTIVE" : "PRIVY MOCK"}
    </button>
  );
}

export function AuthControls() {
  return (
    <div className="auth-controls">
      {hasPrivy ? <LivePrivyControl /> : <MockPrivyControl />}
      <WalletMultiButton />
    </div>
  );
}
