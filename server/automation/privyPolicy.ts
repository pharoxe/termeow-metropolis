/**
 * Top-level programs emitted by Jupiter's v6 swap builder for ordinary swaps.
 * Keep this list deliberately small. A route that introduces another program is
 * rejected before it reaches Privy and must be reviewed before being added.
 */
export const SOLANA_AUTOMATION_PROGRAMS = {
  computeBudget: "ComputeBudget111111111111111111111111111111",
  system: "11111111111111111111111111111111",
  associatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  jupiterV6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
} as const;

export const SOLANA_AUTOMATION_PROGRAM_ALLOWLIST = Object.freeze(Object.values(SOLANA_AUTOMATION_PROGRAMS));

/** Policy payload used by scripts/setup-privy-automation.mjs and documented for dashboard setup. */
export function solanaAutomationPolicy() {
  return {
    version: "1.0" as const,
    name: "Termeow Jupiter automation signer",
    chain_type: "solana" as const,
    rules: [
      {
        name: "Allow only reviewed Jupiter swap programs",
        method: "signAndSendTransaction" as const,
        conditions: [{
          field_source: "solana_program_instruction" as const,
          field: "programId",
          operator: "in" as const,
          value: [...SOLANA_AUTOMATION_PROGRAM_ALLOWLIST]
        }],
        action: "ALLOW" as const
      },
      {
        name: "Deny private key export",
        method: "exportPrivateKey" as const,
        conditions: [],
        action: "DENY" as const
      },
      {
        name: "Deny seed phrase export",
        method: "exportSeedPhrase" as const,
        conditions: [],
        action: "DENY" as const
      }
    ]
  };
}
