import type { PropsWithChildren } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { NetworkProvider, ROBINHOOD_CHAIN } from "../features/NetworkContext";

const privyAppId = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;
const solanaRpcUrl = typeof window === "undefined"
  ? "https://api.mainnet-beta.solana.com"
  : new URL("/api/rpc", window.location.origin).toString();
const solanaMainnetRpc = {
  rpc: createSolanaRpc(solanaRpcUrl),
  // Signing broadcasts through our same-origin Helius/Alchemy proxy. A websocket
  // subscription is still required by Privy while it waits for confirmation.
  rpcSubscriptions: createSolanaRpcSubscriptions("wss://api.mainnet-beta.solana.com"),
  blockExplorerUrl: "https://explorer.solana.com"
};

export function WalletProviders({ children }: PropsWithChildren) {
  if (!privyAppId) return <NetworkProvider>{children}</NetworkProvider>;
  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        appearance: {
          theme: "#050705",
          accentColor: "#39ff88",
          landingHeader: "Log in to termeow",
          loginMessage: "Create your private Solana and Robinhood Chain wallets.",
          walletChainType: "ethereum-and-solana"
        },
        loginMethods: ["email", "google", "twitter", "discord"],
        supportedChains: [ROBINHOOD_CHAIN],
        defaultChain: ROBINHOOD_CHAIN,
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
          solana: { createOnLogin: "users-without-wallets" }
        },
        solana: { rpcs: { "solana:mainnet": solanaMainnetRpc } }
      }}
    >
      <NetworkProvider>{children}</NetworkProvider>
    </PrivyProvider>
  );
}

export const hasPrivy = Boolean(privyAppId);
