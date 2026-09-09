import { useEffect } from "react";
import { getAccessToken, useSendTransaction, useWallets as useEvmWallets } from "@privy-io/react-auth";
import { useSignAndSendTransaction, useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { createPublicClient, encodeFunctionData, http, parseUnits } from "viem";
import type { AutomationRecord } from "../../../shared/automation";
import { api, deepFind } from "../../api/client";
import { useNotifications } from "../../components/NotificationSystem";
import { ROBINHOOD_CHAIN } from "../../features/NetworkContext";
import { tokenAmount } from "../../lib/tokenAmount";
import { useAgentStore } from "./store/agentStore";

const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }
] as const;
const evmClient = createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http(ROBINHOOD_CHAIN.rpcUrls.default.http[0]) });
type EvmTx = { to: string; data: string; value?: string; gas?: string; gasPrice?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string };
const quantity = (value: unknown) => typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : undefined;
const percentOf = (balance: bigint, percent?: number) => balance * BigInt(Math.round((percent || 0) * 100)) / 10_000n;
function decodeBase64(value: string) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }

async function solanaTokenBalance(owner: string, mint: string) {
  const response = await api.rpc<{ value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }> }>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
  return (response.value || []).reduce((total, row) => total + BigInt(row.account?.data?.parsed?.info?.tokenAmount?.amount || "0"), 0n);
}

export function VoiceExecutionBridge() {
  const { notify } = useNotifications();
  const { wallets: evmWallets } = useEvmWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  const { sendTransaction } = useSendTransaction();
  const { signAndSendTransaction } = useSignAndSendTransaction();

  useEffect(() => {
    const onApproved = async (event: Event) => {
      const automation = (event as CustomEvent<AutomationRecord>).detail;
      if (automation.intent.kind !== "swap") {
        notify({ title: "AUTOMATION ARMED", message: automation.intent.description, tone: "success" });
        return;
      }
      const auth = await getAccessToken();
      if (!auth) return;
      const intent = automation.intent;
      try {
        await api.reportAutomation(auth, automation.id, { status: "executing" });
        const config = await api.config();
        let hash = "";
        if (intent.chain === "solana") {
          const wallet = solanaWallets[0];
          if (!wallet?.address) throw new Error("No Privy Solana wallet is available.");
          const inputMint = intent.side === "sell" ? intent.tokenAddress : config.usdcMint;
          const outputMint = intent.side === "sell" ? config.usdcMint : intent.tokenAddress;
          const supply = await api.rpc<{ value: { decimals: number } }>("getTokenSupply", [inputMint]);
          const amount = intent.amountMode === "wallet_percent"
            ? percentOf(await solanaTokenBalance(wallet.address, inputMint), intent.allocationPercent).toString()
            : tokenAmount(intent.amount || "0", supply.value.decimals);
          if (BigInt(amount) <= 0n) throw new Error("The approved Solana funding balance is too small for this allocation.");
          const order = { chain: "solana" as const, router: intent.router || "jupiter", inputMint, outputMint, amount, slippageBps: 50, walletAddress: wallet.address };
          const quote = await api.quote(order);
          const payload = await api.transaction({ ...order, quoteId: quote.quoteId });
          const encoded = deepFind(payload, ["transaction", "swapTransaction", "unsignedTransaction", "serializedTransaction"]);
          if (typeof encoded !== "string") throw new Error("Router did not return a Solana transaction.");
          const result = await signAndSendTransaction({ transaction: decodeBase64(encoded), wallet, chain: "solana:mainnet" });
          hash = Array.from(result.signature).map((byte) => byte.toString(16).padStart(2, "0")).join("");
        } else {
          const wallet = evmWallets.find((item) => ["privy", "privy-v2"].includes(item.walletClientType)) ?? evmWallets[0];
          if (!wallet?.address) throw new Error("No Privy Robinhood wallet is available.");
          const token = intent.tokenAddress as `0x${string}`;
          const selling = intent.side === "sell";
          const decimals = selling ? Number(await evmClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })) : 18;
          const balance = selling
            ? await evmClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address as `0x${string}`] })
            : await evmClient.getBalance({ address: wallet.address as `0x${string}` });
          const amount = intent.amountMode === "wallet_percent" ? percentOf(balance, intent.allocationPercent).toString() : parseUnits(intent.amount || "0", decimals).toString();
          if (BigInt(amount) <= 0n) throw new Error("The approved Robinhood funding balance is too small for this allocation.");
          const order = { chain: "robinhood" as const, router: "0x" as const, inputMint: selling ? token : NATIVE_ETH, outputMint: selling ? NATIVE_ETH : token, amount, slippageBps: 50, walletAddress: wallet.address };
          const quote = await api.quote(order);
          const payload = await api.transaction({ ...order, quoteId: quote.quoteId });
          const send = (tx: EvmTx) => sendTransaction({ to: tx.to, data: tx.data, value: quantity(tx.value), gasLimit: quantity(tx.gas), gasPrice: quantity(tx.gasPrice), maxFeePerGas: quantity(tx.maxFeePerGas), maxPriorityFeePerGas: quantity(tx.maxPriorityFeePerGas), chainId: ROBINHOOD_CHAIN.id }, { address: wallet.address });
          const approval = payload.approval as { required?: boolean; token?: string; spender?: string; amount?: string } | undefined;
          if (approval?.required) {
            if (!approval.token || !approval.spender || !approval.amount) throw new Error("0x returned an incomplete allowance request.");
            const approved = await send({ to: approval.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [approval.spender as `0x${string}`, BigInt(approval.amount)] }) });
            await evmClient.waitForTransactionReceipt({ hash: approved.hash, confirmations: 1, timeout: 120_000 });
          }
          const transaction = payload.transaction as EvmTx | undefined;
          if (!transaction?.to || !transaction.data) throw new Error("0x did not return a complete Robinhood transaction.");
          hash = (await send(transaction)).hash;
        }
        await api.reportAutomation(auth, automation.id, { status: "completed", transactionHash: hash });
        useAgentStore.getState().addMessage({ role: "system", text: `Swap submitted: ${hash.slice(0, 10)}…` });
        notify({ title: "VOICE TRADE SUBMITTED", message: automation.intent.description, tone: "success" });
      } catch (reason) {
        const failure = reason instanceof Error ? reason.message : String(reason);
        await api.reportAutomation(auth, automation.id, { status: "failed", failure }).catch(() => undefined);
        useAgentStore.getState().addMessage({ role: "system", text: `Approved action failed: ${failure}` });
        notify({ title: "VOICE TRADE NOT SENT", message: failure, tone: "warning" });
      }
    };
    window.addEventListener("termeow:automation-approved", onApproved);
    return () => window.removeEventListener("termeow:automation-approved", onApproved);
  }, [evmWallets, notify, sendTransaction, signAndSendTransaction, solanaWallets]);
  return null;
}
