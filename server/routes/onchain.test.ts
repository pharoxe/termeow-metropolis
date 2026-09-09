import { describe, expect, it } from "vitest";
import { quoteSchema, sameQuoteRequest } from "./onchain";

const solana = {
  chain: "solana" as const,
  router: "jupiter" as const,
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: "1000000",
  slippageBps: 50,
  walletAddress: "11111111111111111111111111111111"
};

describe("trade quote validation", () => {
  it("accepts Jupiter on Solana and 0x on Robinhood", () => {
    expect(quoteSchema.parse(solana)).toMatchObject({ chain: "solana", router: "jupiter" });
    expect(quoteSchema.parse({
      chain: "robinhood", router: "0x", inputMint: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      outputMint: "0x11b70d0243baf75e85ce03201a92b5b7c33beb59", amount: "1000000000000000",
      slippageBps: 50, walletAddress: "0x1111111111111111111111111111111111111111"
    })).toMatchObject({ chain: "robinhood", router: "0x" });
  });

  it("rejects cross-chain addresses and unsupported Robinhood routers", () => {
    expect(() => quoteSchema.parse({ ...solana, inputMint: "0x1111111111111111111111111111111111111111" })).toThrow();
    expect(() => quoteSchema.parse({ ...solana, chain: "robinhood", router: "jupiter" })).toThrow();
  });

  it("binds transaction creation to every quoted field", () => {
    const parsed = quoteSchema.parse(solana);
    expect(sameQuoteRequest(parsed, quoteSchema.parse({ ...solana }))).toBe(true);
    expect(sameQuoteRequest(parsed, quoteSchema.parse({ ...solana, amount: "1000001" }))).toBe(false);
    expect(sameQuoteRequest(parsed, quoteSchema.parse({ ...solana, slippageBps: 51 }))).toBe(false);
  });
});
