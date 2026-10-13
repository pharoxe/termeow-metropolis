import { MONAD_MAINNET } from "../../shared/chains.js";

/**
 * Contracts a delegated (unattended) Privy wallet may call on Monad: the Kuru Flow entrypoint/router that Kuru's quote
 * API returns as `transaction.to`. Keep this list deliberately small. A route that targets anything else is rejected by
 * inspectAutomationTransaction before it reaches Privy, and by the Privy policy below if it ever got that far.
 */
export const MONAD_AUTOMATION_CONTRACTS = {
  kuruFlowEntrypoint: MONAD_MAINNET.kuru.flowEntrypoint,
  kuruFlowRouter: MONAD_MAINNET.kuru.flowRouter
} as const;

export const MONAD_AUTOMATION_CONTRACT_ALLOWLIST: readonly string[] = Object.freeze(
  Object.values(MONAD_AUTOMATION_CONTRACTS).filter((address): address is string => Boolean(address)).map((address) => address.toLowerCase())
);

const APPROVE_ABI = [{
  type: "function",
  name: "approve",
  stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }]
}] as const;

/**
 * Privy policy payload (docs.privy.io/controls/policies): ALLOW eth_sendTransaction on Monad only to the Kuru Flow
 * contracts, ALLOW ERC-20 approve() only when the spender is one of them, DENY key export. Privy evaluates DENY over
 * ALLOW and denies anything no rule allows. Used by scripts/create-privy-automation-policy.mjs.
 */
export function monadAutomationPolicy(chainId = MONAD_MAINNET.chainId) {
  const onMonad = { field_source: "ethereum_transaction" as const, field: "chain_id", operator: "eq" as const, value: String(chainId) };
  return {
    version: "1.0" as const,
    name: "Termeow Kuru Flow automation signer (Monad)",
    chain_type: "ethereum" as const,
    rules: [
      {
        name: "Allow swaps through Kuru Flow on Monad",
        method: "eth_sendTransaction" as const,
        conditions: [
          onMonad,
          { field_source: "ethereum_transaction" as const, field: "to", operator: "in" as const, value: [...MONAD_AUTOMATION_CONTRACT_ALLOWLIST] }
        ],
        action: "ALLOW" as const
      },
      {
        name: "Allow ERC-20 approvals to Kuru Flow only",
        method: "eth_sendTransaction" as const,
        conditions: [
          onMonad,
          { field_source: "ethereum_calldata" as const, field: "approve.spender", abi: APPROVE_ABI, operator: "in" as const, value: [...MONAD_AUTOMATION_CONTRACT_ALLOWLIST] }
        ],
        action: "ALLOW" as const
      },
      { name: "Deny private key export", method: "exportPrivateKey" as const, conditions: [], action: "DENY" as const },
      { name: "Deny seed phrase export", method: "exportSeedPhrase" as const, conditions: [], action: "DENY" as const }
    ]
  };
}
