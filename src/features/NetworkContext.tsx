import { createContext, useContext, useState, type PropsWithChildren } from "react";
import { defineChain } from "viem";

export type FundingNetwork = "robinhood" | "solana";

export const ROBINHOOD_CHAIN = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Robinhood Chain Explorer", url: "https://robinhoodchain.blockscout.com" } }
});

const STORAGE_KEY = "termeow-funding-network";

function initialNetwork(): FundingNetwork {
  try { return localStorage.getItem(STORAGE_KEY) === "robinhood" ? "robinhood" : "solana"; }
  catch { return "solana"; }
}

const NetworkContext = createContext<{ network: FundingNetwork; setNetwork(network: FundingNetwork): void }>({ network: "solana", setNetwork: () => undefined });

export function NetworkProvider({ children }: PropsWithChildren) {
  const [network, setNetworkState] = useState<FundingNetwork>(initialNetwork);
  const setNetwork = (next: FundingNetwork) => {
    setNetworkState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* keep the in-memory selection */ }
  };
  return <NetworkContext.Provider value={{ network, setNetwork }}>{children}</NetworkContext.Provider>;
}

export const useFundingNetwork = () => useContext(NetworkContext);
export const networkLabel = (network: FundingNetwork) => network === "solana" ? "Solana" : "Robinhood";
export const networkNativeToken = (network: FundingNetwork) => network === "solana" ? "SOL" : "ETH";
