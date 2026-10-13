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
    const token = store.upsert({ chain: "monad", address: "0x9c000000000000000000000000000000000000aa", symbol: "ANSEM", name: "The Black Bull", aliases: ["Ansem Coin"], source: "seeded", priority: 100 });
    expect(store.resolve("$ansem").match).toMatchObject({ address: token.address, chain: "monad" });
    expect(store.resolve("the black bull").match?.symbol).toBe("ANSEM");
    expect(store.resolve(token.address).match?.symbol).toBe("ANSEM");
    store.close();
  });

  it("refuses equally ranked ambiguous symbols but still resolves each by address", () => {
    const store = registry();
    store.upsert({ chain: "monad", address: "0x9c000000000000000000000000000000000000aa", symbol: "SAME", source: "seeded", priority: 50 });
    store.upsert({ chain: "monad", address: "0x020bfc650a365f8bb26819deaabf3e21291018b4", symbol: "SAME", source: "seeded", priority: 50 });
    expect(store.resolve("SAME")).toMatchObject({ ambiguous: true, match: null });
    expect(store.resolve("0x020bfc650a365f8bb26819deaabf3e21291018b4").match?.symbol).toBe("SAME");
    store.close();
  });

  it("keeps a curated token ahead of a lower-authority launch row", () => {
    const store = registry();
    store.upsert({ chain: "monad", address: "0x020bfc650a365f8bb26819deaabf3e21291018b4", symbol: "CASHCAT", name: "Cash Cat", source: "seeded", priority: 100 });
    store.upsert({ chain: "monad", address: "0x020bfc650a365f8bb26819deaabf3e21291018b4", symbol: "FAKE", source: "launch-index", priority: 20 });
    expect(store.resolve("CASHCAT").match?.name).toBe("Cash Cat");
    expect(store.resolve("FAKE").match).toBeNull();
    store.close();
  });

  it("returns verified authority and nearby suggestions without guessing a match", () => {
    const store = registry();
    store.upsert({ chain: "monad", address: "0x9c000000000000000000000000000000000000aa", symbol: "ANSEM", name: "The Black Bull", source: "seeded", priority: 100, verified: true, verificationSource: "termeow-curated" });
    expect(store.resolve("ANSEM").match).toMatchObject({ verified: true, verificationSource: "termeow-curated" });
    expect(store.resolve("ANSE")).toMatchObject({ indexed: false, match: null, ambiguous: false });
    expect(store.resolve("ANSE").matches[0]).toMatchObject({ symbol: "ANSEM", verified: true });
    store.close();
  });

  it("bulk-ingests launch tokens without replacing a curated mapping", () => {
    const store = registry();
    const curated = "0x020bfc650a365f8bb26819deaabf3e21291018b4";
    const launched = "0x120bfc650a365f8bb26819deaabf3e21291018b4";
    store.upsert({ chain: "monad", address: curated, symbol: "CASHCAT", name: "Cash Cat", source: "seeded", priority: 100, verified: true });
    store.ingestLaunches([
      { chain: "monad", token: curated, symbol: "FAKE", name: "Wrong", observedAt: 10 },
      { chain: "monad", token: launched, symbol: "NEW", name: "New launch", observedAt: 20 }
    ] as never);
    expect(store.resolve("CASHCAT").match).toMatchObject({ address: curated, verified: true });
    expect(store.resolve("FAKE").match).toBeNull();
    expect(store.resolve("NEW").match).toMatchObject({ address: launched, source: "launch-index" });
    store.close();
  });

  it("rebuilds in memory when the persistent catalog cannot be opened", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "termeow-tokens-full-"));
    directories.push(directory);
    const store = new TokenRegistry(directory);
    expect(store.persistent).toBe(false);
    store.upsert({ chain: "monad", address: "0x9c000000000000000000000000000000000000aa", symbol: "ANSEM", source: "seeded", priority: 100 });
    expect(store.resolve("ANSEM").match?.chain).toBe("monad");
    store.close();
  });
});
