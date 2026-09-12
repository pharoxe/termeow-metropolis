import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { inspectAutomationTransaction } from "./privyExecutor.js";

function encoded(programId: string) {
  const wallet = Keypair.generate().publicKey;
  const transaction = new Transaction({ feePayer: wallet, recentBlockhash: Keypair.generate().publicKey.toBase58() });
  transaction.add({ programId: new PublicKey(programId), keys: [], data: Buffer.alloc(0) });
  return { wallet: wallet.toBase58(), transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") };
}

describe("Privy automation transaction inspection", () => {
  it("accepts the reviewed Jupiter program and matching fee payer", () => {
    const value = encoded("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
    expect(inspectAutomationTransaction(value.transaction, value.wallet).programs).toContain("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  });

  it("rejects an unreviewed program", () => {
    const value = encoded(SystemProgram.programId.toBase58());
    const transaction = Transaction.from(Buffer.from(value.transaction, "base64"));
    transaction.instructions[0].programId = Keypair.generate().publicKey;
    const changed = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    expect(() => inspectAutomationTransaction(changed, value.wallet)).toThrow(/unapproved programs/i);
  });
});
