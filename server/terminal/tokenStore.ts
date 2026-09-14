import path from "node:path";
import { config } from "../config.js";
import { fomoscanDirectory } from "./fomoscanAccount.js";
import { TokenRegistry } from "./tokenRegistry.js";

const seed = (registry: TokenRegistry) => {
  // High-confidence canonical entries win over similarly named newly launched pairs.
  registry.upsert({
    chain: "solana", address: config.ansemMint, symbol: "ANSEM", name: "The Black Bull",
    aliases: ["ansem coin"], source: "seeded", priority: 100, verified: true, verificationSource: "termeow-curated"
  });
  registry.upsert({
    chain: "robinhood", address: "0x020bfc650a365f8bb26819deaabf3e21291018b4", symbol: "CASHCAT", name: "Cash Cat",
    aliases: ["cash cat"], source: "seeded", priority: 100, verified: true, verificationSource: "termeow-curated"
  });
};

let activeRegistry = new TokenRegistry(path.join(fomoscanDirectory, "token-index.db"));
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
