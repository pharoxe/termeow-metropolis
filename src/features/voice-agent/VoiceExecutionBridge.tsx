import { useEffect } from "react";
import { getAccessToken, useSendTransaction, useWallets as useEvmWallets } from "@privy-io/react-auth";
import { encodeFunctionData, parseUnits } from "viem";
import type { AutomationRecord } from "../../../shared/automation";
import { api } from "../../api/client";
import { useNotifications } from "../../components/NotificationSystem";
import { MONAD_CHAIN } from "../../features/NetworkContext";
import { approvalNeeded, erc20Abi, monadClient } from "../../lib/monadClient";
import { NATIVE_MON } from "../../lib/swapAssets";
import { useAgentStore } from "./store/agentStore";

const immediateExecutions = new Set<string>();
type EvmTx = { to: string; data: string; value?: string; gas?: string; gasPrice?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string };
const quantity = (value: unknown) => typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : undefined;
const percentOf = (balance: bigint, percent?: number) => balance * BigInt(Math.round((percent || 0) * 100)) / 10_000n;
/** MON kept back for gas when a voice swap spends a share of the wallet. */
const GAS_RESERVE_WEI = 2n * 10n ** 17n;

/**
 * Executes user-approved voice actions in the browser with the user's own Privy wallet (no delegation): one-time native
 * MON transfers and Kuru Flow / 0x swaps on Monad. Monitoring automations are only acknowledged here; they fire later
 * through the server's delegated, policy-bound signer.
 */
export function VoiceExecutionBridge() {
  const { notify } = useNotifications();
  const { wallets: evmWallets } = useEvmWallets();
  const { sendTransaction } = useSendTransaction();

  useEffect(() => {
    const onApproved = async (event: Event) => {
      const automation = (event as CustomEvent<AutomationRecord>).detail;
      if (!["swap", "transfer"].includes(automation.intent.kind)) {
        notify({ title: "AUTOMATION ARMED", message: automation.intent.description, tone: "success" });
        return;
      }
      if (immediateExecutions.has(automation.id)) return;
      immediateExecutions.add(automation.id);
      const auth = await getAccessToken();
      if (!auth) { immediateExecutions.delete(automation.id); return; }
      const intent = automation.intent;
      try {
        const claimed = await api.reportAutomation(auth, automation.id, { status: "executing" }).catch(() => null);
        if (!claimed) return;
        const wallet = evmWallets.find((item) => ["privy", "privy-v2"].includes(item.walletClientType)) ?? evmWallets[0];
        if (!wallet?.address) throw new Error("No Privy Monad wallet is available.");
        const owner = wallet.address as `0x${string}`;
        const send = (tx: EvmTx) => {
          const value = quantity(tx.value), gasLimit = quantity(tx.gas), gasPrice = quantity(tx.gasPrice);
          const maxFeePerGas = quantity(tx.maxFeePerGas), maxPriorityFeePerGas = quantity(tx.maxPriorityFeePerGas);
          return sendTransaction({ to: tx.to, data: tx.data,
            ...(value === undefined ? {} : { value }), ...(gasLimit === undefined ? {} : { gasLimit }),
            ...(gasPrice === undefined ? {} : { gasPrice }), ...(maxFeePerGas === undefined ? {} : { maxFeePerGas }),
            ...(maxPriorityFeePerGas === undefined ? {} : { maxPriorityFeePerGas }), chainId: MONAD_CHAIN.id }, { address: wallet.address });
        };
        let hash = "";
        let confirmed = true;
        if (intent.kind === "transfer") {
          if (!intent.recipientAddress || !intent.transferAmountMon) throw new Error("The approved transfer is incomplete.");
          if (intent.recipientAddress.toLowerCase() === owner.toLowerCase()) throw new Error("Source and recipient wallets cannot be the same.");
          const wei = parseUnits(intent.transferAmountMon, 18);
          const balance = await monadClient.getBalance({ address: owner });
          if (wei <= 0n || balance < wei + 10n ** 16n) throw new Error("Insufficient MON for the transfer plus network fee.");
          hash = (await send({ to: intent.recipientAddress, data: "0x", value: wei.toString() })).hash;
          const receipt = await monadClient.waitForTransactionReceipt({ hash: hash as `0x${string}`, confirmations: 1, timeout: 30_000 }).catch(() => null);
          if (receipt && receipt.status !== "success") throw new Error("The transfer reverted on Monad.");
          confirmed = Boolean(receipt);
        } else {
          if (!intent.tokenAddress) throw new Error("This automation has not resolved a token contract yet.");
          const token = intent.tokenAddress as `0x${string}`;
          const selling = intent.side === "sell";
          const decimals = selling ? Number(await monadClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })) : 18;
          const balance = selling
            ? await monadClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] })
            : await monadClient.getBalance({ address: owner });
          const spendable = selling ? balance : balance > GAS_RESERVE_WEI ? balance - GAS_RESERVE_WEI : 0n;
          const amount = intent.amountMode === "wallet_percent" ? percentOf(spendable, intent.allocationPercent).toString() : parseUnits(intent.amount || "0", decimals).toString();
          if (BigInt(amount) <= 0n) throw new Error("The approved Monad funding balance is too small for this allocation.");
          const order = { chain: "monad" as const, router: intent.router ?? "kuru", inputMint: selling ? token : NATIVE_MON, outputMint: selling ? NATIVE_MON : token, amount, slippageBps: intent.slippageBps ?? 50, walletAddress: wallet.address };
          const quote = await api.quote(order);
          const payload = await api.transaction({ ...order, quoteId: quote.quoteId });
          const approval = payload.approval as { required?: boolean; token?: string; spender?: string; amount?: string } | undefined;
          if (approval?.required) {
            if (!approval.token || !approval.spender || !approval.amount) throw new Error("The router returned an incomplete allowance request.");
            if (await approvalNeeded(approval.token, owner, approval.spender, BigInt(approval.amount))) {
              const approved = await send({ to: approval.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [approval.spender as `0x${string}`, BigInt(approval.amount)] }) });
              await monadClient.waitForTransactionReceipt({ hash: approved.hash, confirmations: 1, timeout: 60_000 });
            }
          }
          const transaction = payload.transaction as EvmTx | undefined;
          if (!transaction?.to || !transaction.data) throw new Error("The router did not return a complete Monad transaction.");
          hash = (await send(transaction)).hash;
        }
        await api.reportAutomation(auth, automation.id, { status: "completed", transactionHash: hash });
        const transferLabel = confirmed ? "Transfer confirmed" : "Transfer submitted; confirmation pending—do not retry";
        useAgentStore.getState().addMessage({ role: "system", text: `${intent.kind === "transfer" ? transferLabel : "Swap submitted"}: ${hash.slice(0, 10)}…` });
        notify({ title: intent.kind === "transfer" ? (confirmed ? "TRANSFER CONFIRMED" : "TRANSFER SUBMITTED") : "VOICE TRADE SUBMITTED", message: automation.intent.description, tone: "success" });
      } catch (reason) {
        const failure = reason instanceof Error ? reason.message : String(reason);
        await api.reportAutomation(auth, automation.id, { status: "failed", failure }).catch(() => undefined);
        useAgentStore.getState().addMessage({ role: "system", text: `Approved action failed: ${failure}` });
        notify({ title: "VOICE TRADE NOT SENT", message: failure, tone: "warning" });
      } finally {
        immediateExecutions.delete(automation.id);
      }
    };
    window.addEventListener("termeow:automation-approved", onApproved);
    return () => window.removeEventListener("termeow:automation-approved", onApproved);
  }, [evmWallets, notify, sendTransaction]);
  return null;
}
