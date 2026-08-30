import { useMemo, type PropsWithChildren } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { PrivyProvider } from "@privy-io/react-auth";

const privyAppId = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;

export function WalletProviders({ children }: PropsWithChildren) {
  const endpoint = useMemo(() => `${window.location.origin}/api/rpc`, []);
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter({ network: WalletAdapterNetwork.Mainnet })], []);
  const walletTree = (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );

  if (!privyAppId) return walletTree;
  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        appearance: { theme: "dark", accentColor: "#9aff72" },
        loginMethods: ["email", "google", "wallet"],
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" } }
      }}
    >
      {walletTree}
    </PrivyProvider>
  );
}

export const hasPrivy = Boolean(privyAppId);
