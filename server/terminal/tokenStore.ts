import path from "node:path";
import { mkdirSync } from "node:fs";
import { config } from "../config.js";
import { TokenRegistry } from "./tokenRegistry.js";

const directory = path.resolve(process.env.TERMINAL_DATA_DIR || "data/terminal");
mkdirSync(directory, { recursive: true });

const seed = (registry: TokenRegistry) => {
  // High-confidence canonical entries win over similarly named newly launched pairs.
  const { tokens } = config.network;
  registry.upsert({
    chain: "monad", address: tokens.wmon, symbol: "MON", name: "Monad (wrapped)",
    aliases: ["mon", "monad", "wmon", "wrapped mon"], source: "seeded", priority: 100, verified: true, verificationSource: "monad-docs"
  });
  registry.upsert({
    chain: "monad", address: tokens.usdc, symbol: "USDC", name: "USD Coin",
    aliases: ["usdc", "usd coin"], source: "seeded", priority: 100, verified: true, verificationSource: "monad-docs"
  });
  if (tokens.ausd) registry.upsert({
    chain: "monad", address: tokens.ausd, symbol: "AUSD", name: "Agora Dollar",
    aliases: ["ausd", "agora dollar"], source: "seeded", priority: 100, verified: true, verificationSource: "agora"
  });
  // Monad community tokens people ask for by name; mainnet contracts, checked against their DexScreener listings.
  if (config.network.chainId === 143) for (const token of MAINNET_COMMUNITY_TOKENS) registry.upsert({ chain: "monad", ...token, source: "seeded", priority: 90, verified: true, verificationSource: "dexscreener" });
};

const MAINNET_COMMUNITY_TOKENS = [
  { address: "0x350035555e10d9afaf1566aaebfced5ba6c27777", symbol: "CHOG", name: "Chog", aliases: ["chog", "$chog"] }
];

let activeRegistry = new TokenRegistry(path.join(directory, "token-index.db"));
try {
  seed(activeRegistry);
} catch (error) {
  // A mounted cache can open successfully yet reject its first WAL write when the volume is full.
  // The index is derived data, so preserve the disk copy and keep the production process alive in memory.
  console.warn(`token index: persistent writes unavailable; using memory for this process (${error instanceof Error ? error.message : String(error)})`);
  try { activeRegistry.close(); } catch { /* a full SQLite journal can also make close noisy */ }
  activeRegistry = new TokenRegistry(":memory:");
  seed(activeRegistry);
}

export const tokenRegistry = activeRegistry;
