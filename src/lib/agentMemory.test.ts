import { describe, expect, it } from "vitest";
import { agentMemoryText } from "./agentMemory";

describe("agentMemoryText", () => {
  it("renders compact personalized context without wallet addresses", () => {
    const text = agentMemoryText({
      userId: "did:privy:test",
      trackedTraders: [{ handle: "frankdegods", chain: "monad", wallet: "SecretWalletAddress", uses: 2, lastUsedAt: 1 }],
      favoriteTraders: [{ handle: "ansem", chain: "monad", wallet: "AnotherSecretWallet", followers: 1000 }],
      favoriteTokens: [{ symbol: "CASHCAT", chain: "monad", address: "SecretMint" }],
      defaultAllocationPercent: 5,
      lastTrade: { side: "buy", symbol: "ANSEM", chain: "monad", completedAt: 1 },
      updatedAt: 1
    });
    expect(text).toContain("@frankdegods");
    expect(text).toContain("$CASHCAT");
    expect(text).toContain("5%");
    expect(text).not.toContain("SecretWallet");
    expect(text).not.toContain("did:privy");
  });
});
