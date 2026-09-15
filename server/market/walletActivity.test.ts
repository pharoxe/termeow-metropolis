import { describe, expect, it, vi } from "vitest";
import { solanaWalletActivity } from "./walletActivity.js";

describe("solanaWalletActivity", () => {
  it("returns confirmed native transfers and classifies two-sided token changes as swaps", async () => {
    const rpc = vi.fn(async (method: string) => method === "getSignaturesForAddress" ? [{ signature: "sig-1" }] : ({
      blockTime: 1_700_000_000,
      transaction: { message: { accountKeys: [{ pubkey: "wallet" }], instructions: [{ program: "system", parsed: { type: "transfer", info: { source: "wallet", destination: "friend", lamports: 100_000_000 } } }] } },
      meta: {
        err: null, fee: 5_000,
        preTokenBalances: [{ owner: "wallet", mint: "USDC", uiTokenAmount: { uiAmountString: "10" } }, { owner: "wallet", mint: "MEME", uiTokenAmount: { uiAmountString: "0" } }],
        postTokenBalances: [{ owner: "wallet", mint: "USDC", uiTokenAmount: { uiAmountString: "5" } }, { owner: "wallet", mint: "MEME", uiTokenAmount: { uiAmountString: "100" } }]
      }
    }));
    const result = await solanaWalletActivity("wallet", 20, rpc);
    expect(result.items[0]).toMatchObject({ signature: "sig-1", status: "confirmed", kind: "swap", nativeTransfers: [{ from: "wallet", to: "friend", amount: 0.1 }] });
    expect(result.items[0].tokenBalanceChanges).toEqual([{ mint: "USDC", amount: -5 }, { mint: "MEME", amount: 100 }]);
  });
});
