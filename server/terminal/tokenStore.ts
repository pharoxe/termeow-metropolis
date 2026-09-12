import path from "node:path";
import { config } from "../config.js";
import { fomoscanDirectory } from "./fomoscanAccount.js";
import { TokenRegistry } from "./tokenRegistry.js";

export const tokenRegistry = new TokenRegistry(path.join(fomoscanDirectory, "token-index.db"));

// High-confidence canonical entries win over similarly named newly launched pairs.
tokenRegistry.upsert({
  chain: "solana", address: config.ansemMint, symbol: "ANSEM", name: "The Black Bull",
  aliases: ["ansem coin"], source: "seeded", priority: 100
});
tokenRegistry.upsert({
  chain: "robinhood", address: "0x020bfc650a365f8bb26819deaabf3e21291018b4", symbol: "CASHCAT", name: "Cash Cat",
  aliases: ["cash cat"], source: "seeded", priority: 100
});
