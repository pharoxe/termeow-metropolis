import "dotenv/config";
import { PrivyClient } from "@privy-io/node";

const appId = process.env.PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;
if (!appId || !appSecret) throw new Error("Set PRIVY_APP_ID and PRIVY_APP_SECRET before creating the policy.");

const programs = [
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
];

const client = new PrivyClient({ appId, appSecret });
const policy = await client.policies().create({
  version: "1.0",
  name: "Termeow Jupiter automation signer",
  chain_type: "solana",
  rules: [
    { name: "Allow only reviewed Jupiter swap programs", method: "signAndSendTransaction", conditions: [{ field_source: "solana_program_instruction", field: "programId", operator: "in", value: programs }], action: "ALLOW" },
    { name: "Deny private key export", method: "exportPrivateKey", conditions: [], action: "DENY" },
    { name: "Deny seed phrase export", method: "exportSeedPhrase", conditions: [], action: "DENY" }
  ],
  idempotency_key: "termeow-jupiter-automation-policy-v1"
});

console.log(JSON.stringify({ policyId: policy.id, env: `PRIVY_AUTOMATION_POLICY_ID=${policy.id}`, programs }, null, 2));
