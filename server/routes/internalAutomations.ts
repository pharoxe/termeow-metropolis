import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { AutomationIntent } from "../../shared/automation.js";
import { NATIVE_MON } from "../../shared/chains.js";
import { config } from "../config.js";
import { sendDelegatedMonadTransaction, type EvmAutomationTransaction } from "../automation/privyExecutor.js";
import { automationRepository } from "../automation/runtime.js";
import { evmRpc } from "../tape/monad/rpc.js";
import { KuruFlowClient } from "../trading/kuru.js";

const triggerSchema = z.object({ sourceEventId: z.string().min(4).max(200), observedMarketCapUsd: z.number().nonnegative().optional() });
/** Native MON kept back for gas when an automation spends a share of the wallet (Monad gas is cheap; 0.2 MON is ample). */
const GAS_RESERVE_WEI = 2n * 10n ** 17n;
const kuru = new KuruFlowClient({ apiUrl: config.kuru.apiUrl });

function authorized(value?: string) {
  const expected = config.privy.automationTriggerSecret;
  if (!expected || !value) return false;
  const supplied = value.replace(/^Bearer\s+/i, "");
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const result = await evmRpc(config.monad.rpcUrl, method, params);
  if (result == null) throw new Error(`Monad RPC ${method} returned nothing.`);
  return result as T;
}

const word = (address: string) => address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const uint = (hex: string) => BigInt(hex === "0x" ? "0x0" : hex);

async function erc20Balance(owner: string, token: string) {
  return uint(await rpc<string>("eth_call", [{ to: token, data: `0x70a08231${word(owner)}` }, "latest"]));
}

async function erc20Decimals(token: string) {
  return Number(uint(await rpc<string>("eth_call", [{ to: token, data: "0x313ce567" }, "latest"])));
}

async function erc20Allowance(owner: string, token: string, spender: string) {
  return uint(await rpc<string>("eth_call", [{ to: token, data: `0xdd62ed3e${word(owner)}${word(spender)}` }, "latest"]));
}

/** Waits (bounded) for a receipt so a swap never races its own approval; Monad finalizes in ~600 ms. */
async function waitForReceipt(hash: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await evmRpc(config.monad.rpcUrl, "eth_getTransactionReceipt", [hash]).catch(() => null) as { status?: string } | null;
    if (receipt?.status) {
      if (receipt.status !== "0x1") throw new Error(`Transaction ${hash} reverted.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Transaction ${hash} was not confirmed in time.`);
}

async function inputAmount(intent: AutomationIntent, wallet: string) {
  const selling = intent.side === "sell";
  const inputToken = selling ? intent.tokenAddress : NATIVE_MON;
  if (!inputToken) throw new Error("The automation signal did not resolve a token address.");
  const decimals = selling ? await erc20Decimals(inputToken) : 18;
  if (intent.amountMode === "fixed") {
    const [whole, fraction = ""] = (intent.amount || "0").split(".");
    return { inputToken, amount: BigInt(`${whole || "0"}${fraction.padEnd(decimals, "0").slice(0, decimals)}`).toString() };
  }
  const balance = selling ? await erc20Balance(wallet, inputToken) : uint(await rpc<string>("eth_getBalance", [wallet, "latest"]));
  const reserve = selling ? 0n : GAS_RESERVE_WEI;
  const spendable = balance > reserve ? balance - reserve : 0n;
  const basisPoints = BigInt(Math.round((intent.allocationPercent || 0) * 100));
  return { inputToken, amount: (spendable * basisPoints / 10_000n).toString() };
}

/** Kuru Flow route for the delegated wallet, plus the exact-amount approval an ERC-20 input still needs. */
async function buildKuruSwap(wallet: string, inputToken: string, outputToken: string, amount: string, slippageBps: number) {
  const quote = await kuru.quote({ userAddress: wallet, tokenIn: inputToken, tokenOut: outputToken, amount, slippageBps });
  const chainId = config.network.chainId;
  const swap: EvmAutomationTransaction = { to: quote.transaction.to, data: quote.transaction.data, value: quote.transaction.value, chainId };
  let approval: EvmAutomationTransaction | null = null;
  if (inputToken !== NATIVE_MON && await erc20Allowance(wallet, inputToken, quote.transaction.to) < BigInt(amount)) {
    approval = { to: inputToken, data: `0x095ea7b3${word(quote.transaction.to)}${BigInt(amount).toString(16).padStart(64, "0")}`, value: "0", chainId };
  }
  return { swap, approval, expectedOut: quote.output };
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
    if (current.intent.chain !== "monad" || (current.intent.router && current.intent.router !== "kuru")) { response.status(409).json({ error: "Unattended execution routes through Kuru Flow on Monad only" }); return; }
    if (!current.intent.side) { response.status(409).json({ error: "Automation has no executable side" }); return; }
    if ((current.intent.marketCapMinUsd != null || current.intent.marketCapMaxUsd != null) && trigger.observedMarketCapUsd == null) {
      response.status(409).json({ error: "A current market cap observation is required by this automation" }); return;
    }
    if (trigger.observedMarketCapUsd != null && ((current.intent.marketCapMinUsd != null && trigger.observedMarketCapUsd < current.intent.marketCapMinUsd) || (current.intent.marketCapMaxUsd != null && trigger.observedMarketCapUsd > current.intent.marketCapMaxUsd))) {
      response.status(409).json({ error: "Signal is outside the approved market-cap execution range" }); return;
    }
    const delegation = await automationRepository.getDelegation(current.userId);
    if (!delegation) { response.status(409).json({ error: "User has no active Monad automation delegation" }); return; }
    const claim = await automationRepository.claimExecution(id, trigger.sourceEventId, trigger.observedMarketCapUsd);
    if (!claim.automation) {
      response.status(claim.duplicate ? 200 : 409).json({ duplicate: claim.duplicate, error: claim.duplicate ? undefined : "Automation is not armed or has expired" }); return;
    }
    const executing = claim.automation;
    try {
      const tokenAddress = executing.intent.tokenAddress ?? executing.lastSignal?.tokenAddress;
      if (!tokenAddress) throw new Error("The automation signal did not resolve a token address.");
      const executableIntent = { ...executing.intent, tokenAddress };
      const { inputToken, amount } = await inputAmount(executableIntent, delegation.walletAddress);
      if (BigInt(amount) <= 0n) throw new Error("Delegated wallet has insufficient spendable balance.");
      const outputToken = executableIntent.side === "sell" ? NATIVE_MON : tokenAddress;
      const built = await buildKuruSwap(delegation.walletAddress, inputToken, outputToken, amount, executing.intent.maxSlippageBps ?? 50);
      const executionId = `${id}:${trigger.sourceEventId}`;
      if (built.approval) {
        const approved = await sendDelegatedMonadTransaction({ walletId: delegation.walletId, walletAddress: delegation.walletAddress, transaction: built.approval, executionId: `${executionId}:approve` });
        await waitForReceipt(approved.hash);
      }
      const result = await sendDelegatedMonadTransaction({ walletId: delegation.walletId, walletAddress: delegation.walletAddress, transaction: built.swap, executionId });
      const completed = await automationRepository.finishExecution(current.userId, id, trigger.sourceEventId, "completed", { transactionHash: result.hash });
      response.json({ automation: completed, transactionHash: result.hash, sourceEventId: trigger.sourceEventId });
    } catch (error) {
      await automationRepository.finishExecution(current.userId, id, trigger.sourceEventId, "failed", { failure: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  } catch (error) { next(error); }
});
