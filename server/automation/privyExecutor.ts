import { createHash } from "node:crypto";
import { PrivyClient } from "@privy-io/node";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { config } from "../config.js";
import { SOLANA_AUTOMATION_PROGRAM_ALLOWLIST } from "./privyPolicy.js";

const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

function client() {
  const { appId, appSecret } = config.privy;
  if (!appId || !appSecret) throw new Error("Privy server authentication is not configured.");
  return new PrivyClient({ appId, appSecret });
}

export async function verifyDelegatedSolanaWallet(input: { walletId: string; walletAddress: string }) {
  const { automationSignerId, automationPolicyId } = config.privy;
  if (!automationSignerId || !automationPolicyId) throw new Error("Privy automation signer is not configured.");
  const wallet = await client().wallets().get(input.walletId);
  if (wallet.chain_type !== "solana" || wallet.address !== input.walletAddress) throw new Error("Privy wallet ID does not match the submitted Solana wallet.");
  const signer = wallet.additional_signers.find((candidate) => candidate.signer_id === automationSignerId);
  if (!signer || !signer.override_policy_ids?.includes(automationPolicyId)) throw new Error("The required Privy signer policy is not attached to this wallet.");
  return wallet;
}

function decodePrograms(serialized: Buffer) {
  try {
    const tx = VersionedTransaction.deserialize(serialized);
    const staticKeys = tx.message.staticAccountKeys;
    const programs = tx.message.compiledInstructions.map((instruction) => {
      const key = staticKeys[instruction.programIdIndex];
      if (!key) throw new Error("Automation transaction uses an unresolved lookup-table program ID.");
      return key.toBase58();
    });
    return { feePayer: staticKeys[0]?.toBase58(), programs };
  } catch (versionedError) {
    try {
      const tx = Transaction.from(serialized);
      return { feePayer: tx.feePayer?.toBase58(), programs: tx.instructions.map((instruction) => instruction.programId.toBase58()) };
    } catch {
      throw versionedError;
    }
  }
}

export function inspectAutomationTransaction(transaction: string, expectedWallet: string) {
  const bytes = Buffer.from(transaction, "base64");
  if (!bytes.length || bytes.length > 1_500) throw new Error("Automation transaction encoding is invalid.");
  const decoded = decodePrograms(bytes);
  if (!decoded.feePayer || !new PublicKey(decoded.feePayer).equals(new PublicKey(expectedWallet))) {
    throw new Error("Automation transaction fee payer does not match the delegated wallet.");
  }
  const unexpected = [...new Set(decoded.programs)].filter((program) => !SOLANA_AUTOMATION_PROGRAM_ALLOWLIST.includes(program as never));
  if (unexpected.length) throw new Error(`Automation transaction contains unapproved programs: ${unexpected.join(", ")}`);
  if (!decoded.programs.includes("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")) throw new Error("Automation transaction is not a Jupiter v6 swap.");
  return { programs: [...new Set(decoded.programs)], byteLength: bytes.length };
}

export async function signAndSendDelegatedSolana(input: { walletId: string; walletAddress: string; transaction: string; executionId: string }) {
  const { appId, appSecret, automationAuthPrivateKey } = config.privy;
  if (!appId || !appSecret || !automationAuthPrivateKey) throw new Error("Privy automation signing is not configured.");
  inspectAutomationTransaction(input.transaction, input.walletAddress);
  const reference = createHash("sha256").update(input.executionId).digest("hex").slice(0, 48);
  return client().wallets().solana().signAndSendTransaction(input.walletId, {
    caip2: SOLANA_MAINNET_CAIP2,
    transaction: input.transaction,
    authorization_context: { authorization_private_keys: [automationAuthPrivateKey] },
    idempotency_key: reference,
    reference_id: reference
  });
}
