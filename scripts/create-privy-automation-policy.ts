import "dotenv/config";
import { PrivyClient } from "@privy-io/node";
import { MONAD_NETWORKS } from "../shared/chains.js";
import { MONAD_AUTOMATION_CONTRACT_ALLOWLIST, monadAutomationPolicy } from "../server/automation/privyPolicy.js";

const appId = process.env.PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;
if (!appId || !appSecret) throw new Error("Set PRIVY_APP_ID and PRIVY_APP_SECRET before creating the policy.");
const network = MONAD_NETWORKS[process.env.MONAD_NETWORK === "testnet" ? "testnet" : "mainnet"];

const client = new PrivyClient({ appId, appSecret });
const policy = await client.policies().create({
  ...monadAutomationPolicy(network.chainId),
  idempotency_key: `termeow-kuru-automation-policy-${network.chainId}-v1`
});

console.log(JSON.stringify({ policyId: policy.id, env: `PRIVY_AUTOMATION_POLICY_ID=${policy.id}`, chainId: network.chainId, contracts: MONAD_AUTOMATION_CONTRACT_ALLOWLIST }, null, 2));
