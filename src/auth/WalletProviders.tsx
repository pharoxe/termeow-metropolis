import type { PropsWithChildren } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { NetworkProvider, ROBINHOOD_CHAIN } from "../features/NetworkContext";

const privyAppId = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;

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
        }
      }}
    >
      <NetworkProvider>{children}</NetworkProvider>
    </PrivyProvider>
  );
}

export const hasPrivy = Boolean(privyAppId);
