import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWorkspaceFeatures } from "../features/WorkspaceFeatures";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import { hasPrivy } from "./WalletProviders";
import { shortAddress } from "../lib/format";

function LivePrivyControl() {
  const { authenticated, login, logout, ready } = usePrivy();
  const { onboard } = useWorkspaceFeatures();
  useEffect(() => { if (authenticated) onboard(); }, [authenticated]);
  const { wallets } = useWallets();
  const wallet = wallets[0];
  return (
    <button className="auth-button embedded" disabled={!ready} onClick={() => authenticated ? logout() : login()}>
      <span className={`status-dot ${authenticated ? "live" : ""}`} />
      {authenticated ? `PRIVY ${shortAddress(wallet?.address)}` : "PRIVY EMBEDDED"}
    </button>
  );
}

function PrivyPreviewControl() {
  const [active, setActive] = useState(false);
  return (
    <div className="embedded-control">
      <button className="auth-button embedded" onClick={() => setActive(!active)} aria-expanded={active} title="Embedded wallet">
        <span className="status-dot" />PRIVY
      </button>
      {active && <div className="wallet-popover" role="status"><b>Embedded wallet</b><p>Email sign-in is currently unavailable. Connect a Solana wallet to continue.</p><button onClick={() => setActive(false)}>CLOSE</button></div>}
    </div>
  );
}

export function AuthControls() {
  const { connected } = useWallet();
  const { customize, onboard } = useWorkspaceFeatures();
  useEffect(() => { if (connected) onboard(); }, [connected]);
  return (
    <div className="auth-controls">
      <button className="auth-button" onClick={customize}>CUSTOMIZE</button>
      {hasPrivy ? <LivePrivyControl /> : <PrivyPreviewControl />}
      <WalletMultiButton />
    </div>
  );
}
