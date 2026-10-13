// Monad network facts shared by server/ and src/. Every address is lowercase unless a consumer needs checksum case.
// Sources (checked 2026-10-13): docs.monad.xyz network-information + current-facts, developers.uniswap.org v3/v4
// deployments, docs.kuru.io contract addresses, Naddotfun/nadfun-sdk-typescript, docs.perpl.xyz networks.

export type MonadNetwork = "mainnet" | "testnet";

export type MonadNetworkProfile = {
  network: MonadNetwork;
  chainId: number;
  caip2: `eip155:${number}`;
  name: string;
  nativeSymbol: "MON";
  nativeDecimals: 18;
  rpcUrls: readonly string[];
  wsUrls: readonly string[];
  explorer: string;
  /** Mean block interval: 300 ms observed on mainnet (~302 ms mean, Sept 2026; docs.monad.xyz/ai/current-facts). */
  blockMs: number;
  /** eth_getLogs block range accepted by the default public RPC (QuickNode rpc.monad.xyz: 100 blocks). */
  logsRangeBlocks: number;
  tokens: { wmon: string; usdc: string; ausd: string | null };
  uniswap: { v4PoolManager: string | null; v3Factory: string | null; universalRouter: string | null; permit2: string };
  kuru: { flowEntrypoint: string | null; flowRouter: string | null; router: string; marginAccount: string };
  nadfun: { curve: string; curveRouter: string; dexRouter: string; lens: string; v3Factory: string } | null;
  perpl: { api: string; ws: string; exchange: string };
  multicall3: string;
};

export const MONAD_MAINNET: MonadNetworkProfile = {
  network: "mainnet",
  chainId: 143,
  caip2: "eip155:143",
  name: "Monad",
  nativeSymbol: "MON",
  nativeDecimals: 18,
  rpcUrls: [
    "https://rpc.monad.xyz",
    "https://rpc1.monad.xyz",
    "https://rpc3.monad.xyz",
    "https://rpc-mainnet.monadinfra.com",
    "https://rpc2.monad.xyz"
  ],
  wsUrls: ["wss://rpc.monad.xyz", "wss://rpc1.monad.xyz", "wss://rpc3.monad.xyz", "wss://rpc-mainnet.monadinfra.com"],
  explorer: "https://monadvision.com",
  blockMs: 300,
  logsRangeBlocks: 100,
  tokens: {
    wmon: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a",
    usdc: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    ausd: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a"
  },
  uniswap: {
    v4PoolManager: "0x188d586ddcf52439676ca21a244753fa19f9ea8e",
    v3Factory: "0x204faca1764b154221e35c0d20abb3c525710498",
    universalRouter: "0x0d97dc33264bfc1c226207428a79b26757fb9dc3",
    permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3"
  },
  kuru: {
    flowEntrypoint: "0xb3e6778480b2e488385e8205ea05e20060b813cb",
    flowRouter: "0x0d3a1be29e9ded63c7a5678b31e847d68f71ffa2",
    router: "0xd651346d7c789536ebf06dc72ae3c8502cd695cc",
    marginAccount: "0x2a68ba1833cdf93fa9da1eebd7f46242ad8e90c5"
  },
  nadfun: {
    curve: "0xa7283d07812a02afb7c09b60f8896bcea3f90ace",
    curveRouter: "0x6f6b8f1a20703309951a5127c45b49b1cd981a22",
    dexRouter: "0x0b79d71ae99528d1db24a4148b5f4f865cc2b137",
    lens: "0x7e78a8de94f21804f7a17f4e8bf9ec2c872187ea",
    v3Factory: "0x6b5f564339dbad6b780249827f2198a841feb7f3"
  },
  perpl: { api: "https://app.perpl.xyz/api", ws: "wss://app.perpl.xyz", exchange: "0x34b6552d57a35a1d042ccae1951bd1c370112a6f" },
  multicall3: "0xca11bde05977b3631167028862be2a173976ca11"
};

export const MONAD_TESTNET: MonadNetworkProfile = {
  network: "testnet",
  chainId: 10143,
  caip2: "eip155:10143",
  name: "Monad Testnet",
  nativeSymbol: "MON",
  nativeDecimals: 18,
  rpcUrls: ["https://testnet-rpc.monad.xyz", "https://rpc-testnet.monadinfra.com"],
  wsUrls: ["wss://testnet-rpc.monad.xyz"],
  explorer: "https://testnet.monadvision.com",
  blockMs: 300,
  logsRangeBlocks: 100,
  tokens: {
    wmon: "0xfb8bf4c1cc7a94c73d209a149ea2abea852bc541",
    usdc: "0x3ba3d39afcf8bb994f7964b3e0171ea2ba361570",
    ausd: null
  },
  uniswap: { v4PoolManager: null, v3Factory: null, universalRouter: null, permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3" },
  kuru: {
    flowEntrypoint: null,
    flowRouter: null,
    router: "0x7efbe105ca7415de98f96622173458ac1c054630",
    marginAccount: "0xd029c2d98ff85d8f64799017fe00a59b1159ce02"
  },
  nadfun: null,
  perpl: { api: "https://testnet.perpl.xyz/api", ws: "wss://testnet.perpl.xyz", exchange: "0x1964c32f0be608e7d29302aff5e61268e72080cc" },
  multicall3: "0xca11bde05977b3631167028862be2a173976ca11"
};

export const MONAD_NETWORKS: Record<MonadNetwork, MonadNetworkProfile> = { mainnet: MONAD_MAINNET, testnet: MONAD_TESTNET };

/** The zero address is how DexScreener, Uniswap v4 and Kuru Flow name native MON. */
export const NATIVE_MON = "0x0000000000000000000000000000000000000000";
/** Wallet UIs and 0x name the native asset with the 0xEeee… sentinel. */
export const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
export const EVM_TX_RE = /^0x[a-fA-F0-9]{64}$/;

export function isNativeMon(address: string | null | undefined): boolean {
  const value = String(address || "").toLowerCase();
  return value === NATIVE_MON || value === NATIVE_SENTINEL;
}

export function explorerTx(profile: MonadNetworkProfile, hash: string): string {
  return `${profile.explorer}/tx/${hash}`;
}

export function explorerAddress(profile: MonadNetworkProfile, address: string): string {
  return `${profile.explorer}/address/${address}`;
}

export function explorerToken(profile: MonadNetworkProfile, address: string): string {
  return `${profile.explorer}/token/${address}`;
}
