import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { AutomationIntent } from "../../shared/automation.js";
import { config } from "../config.js";
import { signAndSendDelegatedSolana } from "../automation/privyExecutor.js";
import { automationRepository } from "../automation/runtime.js";

const WSOL = "So11111111111111111111111111111111111111112";
const triggerSchema = z.object({ sourceEventId: z.string().min(4).max(200), observedMarketCapUsd: z.number().nonnegative().optional() });

function authorized(value?: string) {
  const expected = config.privy.automationTriggerSecret;
  if (!expected || !value) return false;
  const supplied = value.replace(/^Bearer\s+/i, "");
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(config.rpc.primary, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json() as { result?: T; error?: { message?: string } };
  if (!response.ok || body.error || body.result == null) throw new Error(body.error?.message || `Solana RPC ${method} failed.`);
  return body.result;
}

async function tokenBalance(owner: string, mint: string) {
  const result = await rpc<{ value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }> }>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
  return result.value.reduce((sum, row) => sum + BigInt(row.account.data.parsed.info.tokenAmount.amount), 0n);
}

async function inputAmount(intent: AutomationIntent, wallet: string) {
  const selling = intent.side === "sell";
  const inputMint = selling ? intent.tokenAddress : WSOL;
  const decimals = selling ? (await rpc<{ value: { decimals: number } }>("getTokenSupply", [inputMint])).value.decimals : 9;
  if (intent.amountMode === "fixed") {
    const [whole, fraction = ""] = (intent.amount || "0").split(".");
    return { inputMint, amount: BigInt(`${whole || "0"}${fraction.padEnd(decimals, "0").slice(0, decimals)}`).toString() };
  }
  const balance = selling
    ? await tokenBalance(wallet, inputMint)
    : BigInt((await rpc<{ value: number }>("getBalance", [wallet])).value);
  const reserve = selling ? 0n : 10_000_000n;
  const spendable = balance > reserve ? balance - reserve : 0n;
  const basisPoints = BigInt(Math.round((intent.allocationPercent || 0) * 100));
  return { inputMint, amount: (spendable * basisPoints / 10_000n).toString() };
}

async function buildJupiterSwap(wallet: string, inputMint: string, outputMint: string, amount: string, slippageBps: number) {
  const headers = { ...(config.jupiter.apiKey ? { "x-api-key": config.jupiter.apiKey } : {}) };
  const query = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: String(slippageBps), restrictIntermediateTokens: "true" });
  const quoted = await fetch(`${config.jupiter.apiUrl}/quote?${query}`, { headers });
  if (!quoted.ok) throw new Error(`Jupiter quote failed (${quoted.status}).`);
  const quoteResponse = await quoted.json();
  const built = await fetch(`${config.jupiter.apiUrl}/swap`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ quoteResponse, userPublicKey: wallet, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" })
  });
  if (!built.ok) throw new Error(`Jupiter transaction build failed (${built.status}).`);
  const payload = await built.json() as { swapTransaction?: string };
  if (!payload.swapTransaction) throw new Error("Jupiter did not return a swap transaction.");
  return payload.swapTransaction;
}

export const internalAutomationsRouter = Router();
internalAutomationsRouter.use((request, response, next) => {
  if (!authorized(request.headers.authorization)) { response.status(401).json({ error: "Invalid automation trigger authorization" }); return; }
  next();
});
internalAutomationsRouter.post("/:id/fire", async (request, response, next) => {
  const id = String(request.params.id);
  try {
    const trigger = triggerSchema.parse(request.body);
    const current = await automationRepository.getById(id);
    if (!current) { response.status(404).json({ error: "Automation not found" }); return; }
    if (current.intent.chain !== "solana" || (current.intent.router && current.intent.router !== "jupiter")) { response.status(409).json({ error: "MVP unattended execution supports Jupiter on Solana only" }); return; }
    if (!current.intent.side) { response.status(409).json({ error: "Automation has no executable side" }); return; }
    if ((current.intent.marketCapMinUsd != null || current.intent.marketCapMaxUsd != null) && trigger.observedMarketCapUsd == null) {
      response.status(409).json({ error: "A current market cap observation is required by this automation" }); return;
    }
    if (trigger.observedMarketCapUsd != null && ((current.intent.marketCapMinUsd != null && trigger.observedMarketCapUsd < current.intent.marketCapMinUsd) || (current.intent.marketCapMaxUsd != null && trigger.observedMarketCapUsd > current.intent.marketCapMaxUsd))) {
      response.status(409).json({ error: "Signal is outside the approved market-cap execution range" }); return;
    }
    const delegation = await automationRepository.getDelegation(current.userId);
    if (!delegation) { response.status(409).json({ error: "User has no active Solana automation delegation" }); return; }
    const claim = await automationRepository.claimExecution(id, trigger.sourceEventId, trigger.observedMarketCapUsd);
    if (!claim.automation) {
      response.status(claim.duplicate ? 200 : 409).json({ duplicate: claim.duplicate, error: claim.duplicate ? undefined : "Automation is not armed or has expired" }); return;
    }
    const executing = claim.automation;
    try {
      const { inputMint, amount } = await inputAmount(executing.intent, delegation.walletAddress);
      if (BigInt(amount) <= 0n) throw new Error("Delegated wallet has insufficient spendable balance.");
      const outputMint = executing.intent.side === "sell" ? WSOL : executing.intent.tokenAddress;
      const transaction = await buildJupiterSwap(delegation.walletAddress, inputMint, outputMint, amount, executing.intent.maxSlippageBps ?? 50);
      const result = await signAndSendDelegatedSolana({ walletId: delegation.walletId, walletAddress: delegation.walletAddress, transaction, executionId: `${id}:${trigger.sourceEventId}` });
      const completed = await automationRepository.finishExecution(current.userId, id, trigger.sourceEventId, "completed", { transactionHash: result.hash });
      response.json({ automation: completed, transactionHash: result.hash, sourceEventId: trigger.sourceEventId });
    } catch (error) {
      await automationRepository.finishExecution(current.userId, id, trigger.sourceEventId, "failed", { failure: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  } catch (error) { next(error); }
});
