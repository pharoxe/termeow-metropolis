import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TokenRegistry } from "./tokenRegistry.js";

const directories: string[] = [];
const registry = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "termeow-tokens-"));
  directories.push(directory);
  return new TokenRegistry(path.join(directory, "tokens.db"));
};

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe("TokenRegistry", () => {
  it("resolves ticker, name, dollar-prefixed ticker, and address locally", () => {
    const store = registry();
    const token = store.upsert({ chain: "solana", address: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump", symbol: "ANSEM", name: "The Black Bull", aliases: ["Ansem Coin"], source: "seeded", priority: 100 });
    expect(store.resolve("$ansem").match).toMatchObject({ address: token.address, chain: "solana" });
    expect(store.resolve("the black bull").match?.symbol).toBe("ANSEM");
    expect(store.resolve(token.address).match?.symbol).toBe("ANSEM");
    store.close();
  });

  it("uses chain filters and refuses equally ranked ambiguous symbols", () => {
    const store = registry();
    store.upsert({ chain: "solana", address: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump", symbol: "SAME", source: "seeded", priority: 50 });
    store.upsert({ chain: "robinhood", address: "0x020bfc650a365f8bb26819deaabf3e21291018b4", symbol: "SAME", source: "seeded", priority: 50 });
    expect(store.resolve("SAME")).toMatchObject({ ambiguous: true, match: null });
    expect(store.resolve("SAME", "robinhood").match?.chain).toBe("robinhood");
    store.close();
  });

  it("keeps a curated token ahead of a lower-authority launch row", () => {
    const store = registry();
    store.upsert({ chain: "robinhood", address: "0x020bfc650a365f8bb26819deaabf3e21291018b4", symbol: "CASHCAT", name: "Cash Cat", source: "seeded", priority: 100 });
    store.upsert({ chain: "robinhood", address: "0x020bfc650a365f8bb26819deaabf3e21291018b4", symbol: "FAKE", source: "launch-index", priority: 20 });
    expect(store.resolve("CASHCAT").match?.name).toBe("Cash Cat");
    expect(store.resolve("FAKE").match).toBeNull();
    store.close();
  });

  it("rebuilds in memory when the persistent catalog cannot be opened", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "termeow-tokens-full-"));
    directories.push(directory);
    const store = new TokenRegistry(directory);
    expect(store.persistent).toBe(false);
    store.upsert({ chain: "solana", address: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump", symbol: "ANSEM", source: "seeded", priority: 100 });
    expect(store.resolve("ANSEM").match?.chain).toBe("solana");
    store.close();
  });
});
