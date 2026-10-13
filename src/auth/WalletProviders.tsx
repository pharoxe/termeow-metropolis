import type { PropsWithChildren } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { NetworkProvider, MONAD_CHAIN } from "../features/NetworkContext";

const privyAppId = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;

/** Privy embedded EVM wallets on Monad: social login, one wallet per user, Monad as the only and default chain. */
export function WalletProviders({ children }: PropsWithChildren) {
  if (!privyAppId) return <NetworkProvider>{children}</NetworkProvider>;
  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        appearance: {
          theme: "light",
          accentColor: "#8b6cf6",
          landingHeader: "Log in to termeow",
          loginMessage: "Create your private Monad wallet.",
          walletChainType: "ethereum-only"
        },
        loginMethods: ["email", "google", "twitter", "discord"],
        supportedChains: [MONAD_CHAIN],
        defaultChain: MONAD_CHAIN,
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" }
        }
      }}
    >
      <NetworkProvider>{children}</NetworkProvider>
    </PrivyProvider>
  );
}

export const hasPrivy = Boolean(privyAppId);
