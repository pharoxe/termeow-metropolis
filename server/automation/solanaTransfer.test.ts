import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { computeSolanaTransferQuote, validateSolanaRecipientAccount, validateSolanaTransferRecipient } from "./solanaTransfer.js";

const WALLET = "FqdPiMhYdYTAnfXKY7opX5YxNLSL9UFtKE8HQq9T9VAb";

describe("Solana transfer proposals", () => {
  it("converts a USD request into an exact lamport-safe SOL amount", () => {
    expect(computeSolanaTransferQuote({ recipient: WALLET, amount: 10, denomination: "usd", priceUsd: 200, quotedAt: 123 })).toEqual({
      recipient: WALLET, amountSol: "0.05", amountLamports: "50000000", amountUsd: 10, priceUsd: 200, quotedAt: 123
    });
  });

  it("preserves an exact SOL request and provides its USD estimate", () => {
    const quote = computeSolanaTransferQuote({ recipient: WALLET, amount: 0.123456789, denomination: "sol", priceUsd: 150, quotedAt: 123 });
    expect(quote.amountSol).toBe("0.123456789");
    expect(quote.amountLamports).toBe("123456789");
    expect(quote.amountUsd).toBeCloseTo(18.51851835);
  });

  it("rejects program-derived recipients", () => {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("recipient")], new PublicKey("11111111111111111111111111111111"));
    expect(() => validateSolanaTransferRecipient(pda.toBase58())).toThrow(/ordinary Solana wallet/);
  });

  it("rejects malformed addresses and unsafe amount bounds", () => {
    expect(() => validateSolanaTransferRecipient("not-a-wallet")).toThrow(/Invalid Solana/);
    expect(() => computeSolanaTransferQuote({ recipient: WALLET, amount: 10_001, denomination: "usd", priceUsd: 200 })).toThrow(/between/);
  });

  it("allows new and system-owned recipients but rejects program accounts", async () => {
    const rpc = (value: unknown) => (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    await expect(validateSolanaRecipientAccount(WALLET, "https://rpc.test", rpc(null))).resolves.toBe(WALLET);
    await expect(validateSolanaRecipientAccount(WALLET, "https://rpc.test", rpc({ executable: false, owner: "11111111111111111111111111111111" }))).resolves.toBe(WALLET);
    await expect(validateSolanaRecipientAccount(WALLET, "https://rpc.test", rpc({ executable: true, owner: "BPFLoaderUpgradeab1e11111111111111111111111" }))).rejects.toThrow(/not a standard SOL wallet/);
  });
});
