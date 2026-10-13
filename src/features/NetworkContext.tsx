import { createContext, useContext, type PropsWithChildren } from "react";
import { defineChain } from "viem";
import { MONAD_NETWORKS } from "../../shared/chains";

export type FundingNetwork = "monad";

/** Same profile the server reads (shared/chains.ts); VITE_MONAD_NETWORK=testnet points the wallet at Monad testnet. */
export const MONAD_PROFILE = MONAD_NETWORKS[import.meta.env.VITE_MONAD_NETWORK === "testnet" ? "testnet" : "mainnet"];

export const MONAD_CHAIN = defineChain({
  id: MONAD_PROFILE.chainId,
  name: MONAD_PROFILE.name,
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [...MONAD_PROFILE.rpcUrls], webSocket: [...MONAD_PROFILE.wsUrls] } },
  blockExplorers: { default: { name: "MonadVision", url: MONAD_PROFILE.explorer } },
  contracts: { multicall3: { address: MONAD_PROFILE.multicall3 as `0x${string}` } }
});

const NetworkContext = createContext<{ network: FundingNetwork; setNetwork(network: FundingNetwork): void }>({ network: "monad", setNetwork: () => undefined });

/** Monad is the only network; the provider stays so components written for a network switch keep one source of truth. */
export function NetworkProvider({ children }: PropsWithChildren) {
  return <NetworkContext.Provider value={{ network: "monad", setNetwork: () => undefined }}>{children}</NetworkContext.Provider>;
}

export const useFundingNetwork = () => useContext(NetworkContext);
export const networkLabel = (_network: FundingNetwork = "monad") => "Monad";
export const networkNativeToken = (_network: FundingNetwork = "monad") => "MON";
export const explorerTxUrl = (hash: string) => `${MONAD_PROFILE.explorer}/tx/${hash}`;
export const explorerAddressUrl = (address: string) => `${MONAD_PROFILE.explorer}/address/${address}`;
