import { createHash } from "node:crypto";
import { PrivyClient } from "@privy-io/node";
import { config } from "../config.js";
import { MONAD_AUTOMATION_CONTRACT_ALLOWLIST } from "./privyPolicy.js";

/** approve(address,uint256) */
const APPROVE_SELECTOR = "0x095ea7b3";
/** Unattended swaps may spend at most this much native MON in one transaction (a guard on top of allocation limits). */
export const MAX_AUTOMATION_VALUE_WEI = 10n ** 18n * 10_000n;

export type EvmAutomationTransaction = { to: string; data: string; value: string; chainId: number };

function client() {
  const { appId, appSecret } = config.privy;
  if (!appId || !appSecret) throw new Error("Privy server authentication is not configured.");
  return new PrivyClient({ appId, appSecret });
}

/** The wallet must be the user's Privy EVM wallet with our scoped signer and policy attached. */
export async function verifyDelegatedMonadWallet(input: { walletId: string; walletAddress: string }) {
  const { automationSignerId, automationPolicyId } = config.privy;
  if (!automationSignerId || !automationPolicyId) throw new Error("Privy automation signer is not configured.");
  const wallet = await client().wallets().get(input.walletId);
  if (wallet.chain_type !== "ethereum" || String(wallet.address).toLowerCase() !== input.walletAddress.toLowerCase()) throw new Error("Privy wallet ID does not match the submitted Monad wallet.");
  const signer = wallet.additional_signers.find((candidate: { signer_id: string; override_policy_ids?: string[] }) => candidate.signer_id === automationSignerId);
  if (!signer || !signer.override_policy_ids?.includes(automationPolicyId)) throw new Error("The required Privy signer policy is not attached to this wallet.");
  return wallet;
}

/**
 * Server-side mirror of the Privy policy, checked before anything is sent: Monad chain id, a target on the Kuru Flow
 * allowlist, or an ERC-20 approve() whose spender is on it; bounded native value.
 */
export function inspectAutomationTransaction(transaction: EvmAutomationTransaction) {
  if (transaction.chainId !== config.network.chainId) throw new Error(`Automation transaction targets chain ${transaction.chainId}, not Monad.`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(transaction.to)) throw new Error("Automation transaction target is invalid.");
  if (!/^0x([0-9a-fA-F]{2})*$/.test(transaction.data) || transaction.data.length > 200_000) throw new Error("Automation transaction calldata is invalid.");
  const value = BigInt(transaction.value || "0");
  if (value < 0n || value > MAX_AUTOMATION_VALUE_WEI) throw new Error("Automation transaction value is outside the allowed range.");
  const to = transaction.to.toLowerCase();
  if (MONAD_AUTOMATION_CONTRACT_ALLOWLIST.includes(to)) return { kind: "swap" as const, to };
  if (transaction.data.toLowerCase().startsWith(APPROVE_SELECTOR) && value === 0n) {
    const spender = `0x${transaction.data.slice(10 + 24, 10 + 64).toLowerCase()}`;
    if (MONAD_AUTOMATION_CONTRACT_ALLOWLIST.includes(spender)) return { kind: "approve" as const, to, spender };
    throw new Error(`Automation approval names an unapproved spender: ${spender}`);
  }
  throw new Error(`Automation transaction targets an unapproved contract: ${to}`);
}

function toHexQuantity(value: string): string {
  return `0x${BigInt(value || "0").toString(16)}`;
}

/** Signs and broadcasts through the user's delegated Privy wallet with the server's authorization key (policy-bound). */
export async function sendDelegatedMonadTransaction(input: { walletId: string; walletAddress: string; transaction: EvmAutomationTransaction; executionId: string }) {
  const { appId, appSecret, automationAuthPrivateKey } = config.privy;
  if (!appId || !appSecret || !automationAuthPrivateKey) throw new Error("Privy automation signing is not configured.");
  inspectAutomationTransaction(input.transaction);
  const reference = createHash("sha256").update(input.executionId).digest("hex").slice(0, 48);
  const result = await client().wallets().ethereum().sendTransaction(input.walletId, {
    caip2: config.network.caip2,
    params: {
      transaction: {
        from: input.walletAddress,
        to: input.transaction.to,
        data: input.transaction.data,
        value: toHexQuantity(input.transaction.value),
        chain_id: input.transaction.chainId
      }
    },
    authorization_context: { authorization_private_keys: [automationAuthPrivateKey] },
    idempotency_key: reference
  });
  return { hash: String(result.hash) };
}
