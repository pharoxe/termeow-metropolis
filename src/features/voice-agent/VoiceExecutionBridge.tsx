import { useEffect } from "react";
import { getAccessToken, useSendTransaction, useWallets as useEvmWallets } from "@privy-io/react-auth";
import { useSignAndSendTransaction, useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { createPublicClient, encodeFunctionData, http, parseUnits } from "viem";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
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
const immediateExecutions = new Set<string>();
type EvmTx = { to: string; data: string; value?: string; gas?: string; gasPrice?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string };
const quantity = (value: unknown) => typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : undefined;
const percentOf = (balance: bigint, percent?: number) => balance * BigInt(Math.round((percent || 0) * 100)) / 10_000n;
function decodeBase64(value: string) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function encodeBase64(value: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 8_192) binary += String.fromCharCode(...value.subarray(offset, offset + 8_192));
  return btoa(binary);
}
const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array) {
  let value = BigInt(`0x${Array.from(bytes).map((item) => item.toString(16).padStart(2, "0")).join("")}`);
  let output = "";
  while (value > 0n) { output = base58Alphabet[Number(value % 58n)] + output; value /= 58n; }
  for (const item of bytes) { if (item !== 0) break; output = `1${output}`; }
  return output;
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function recoverSolTransfer(sender: string, recipient: string, amount: number, after: number) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const activity = await api.walletActivity("solana", sender, 24).catch(() => null);
    const match = activity?.items.find((item) => item.status === "confirmed" && item.observedAt >= after - 30_000
      && item.nativeTransfers.some((transfer) => transfer.from === sender && transfer.to === recipient && Math.abs(transfer.amount - amount) < 0.00000001));
    if (match) return match.signature;
    await wait(1_250);
  }
  return null;
}
async function confirmSolanaSignature(signature: string) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await api.rpc<{ value?: Array<{ confirmationStatus?: string; err?: unknown } | null> }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const status = result.value?.[0];
    if (status?.err) throw new Error(`Solana transaction failed: ${JSON.stringify(status.err)}`);
    if (status && ["confirmed", "finalized"].includes(status.confirmationStatus || "")) return true;
    await wait(1_000);
  }
  return false;
}

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
        const config = await api.config();
        let hash = "";
        let solTransferConfirmed = true;
        if (intent.kind === "transfer") {
          const wallet = solanaWallets[0];
          if (!wallet?.address) throw new Error("No Privy Solana wallet is available.");
          if (!intent.recipientAddress || !intent.transferAmountSol) throw new Error("The approved transfer is incomplete.");
          const sender = new PublicKey(wallet.address);
          const recipient = new PublicKey(intent.recipientAddress);
          if (!PublicKey.isOnCurve(recipient.toBytes())) throw new Error("Recipient is not an ordinary Solana wallet.");
          if (sender.equals(recipient)) throw new Error("Source and recipient wallets cannot be the same.");
          const lamports = BigInt(tokenAmount(intent.transferAmountSol, 9));
          const [balanceResult, latest] = await Promise.all([
            api.rpc<{ value: number }>("getBalance", [wallet.address, { commitment: "confirmed" }]),
            api.rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "finalized" }])
          ]);
          const balance = BigInt(balanceResult.value);
          const feeReserve = 10_000n;
          if (lamports <= 0n || balance < lamports + feeReserve) throw new Error("Insufficient SOL balance for the transfer plus network fee.");
          const transaction = new Transaction({ feePayer: sender, recentBlockhash: latest.value.blockhash }).add(SystemProgram.transfer({ fromPubkey: sender, toPubkey: recipient, lamports }));
          const unsigned = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
          const simulated = await api.rpc<{ value: { err: unknown; logs?: string[] } }>("simulateTransaction", [encodeBase64(unsigned), { encoding: "base64", commitment: "confirmed", sigVerify: false }]);
          if (simulated.value.err) throw new Error(`Solana preflight failed: ${JSON.stringify(simulated.value.err)}`);
          const submittedAt = Date.now();
          try {
            const result = await signAndSendTransaction({ transaction: unsigned, wallet, chain: "solana:mainnet" });
            hash = typeof result.signature === "string" ? result.signature : base58(result.signature);
          } catch (reason) {
            // Privy's modal/SDK can disconnect after the network accepts a transaction.
            // Recover the signature before reporting failure so a retry cannot double-send.
            const recovered = await recoverSolTransfer(wallet.address, intent.recipientAddress, Number(intent.transferAmountSol), submittedAt);
            if (!recovered) throw reason;
            hash = recovered;
          }
          solTransferConfirmed = await confirmSolanaSignature(hash);
        } else if (intent.chain === "solana") {
          if (!intent.tokenAddress) throw new Error("This automation has not resolved a token contract yet.");
          const wallet = solanaWallets[0];
          if (!wallet?.address) throw new Error("No Privy Solana wallet is available.");
          const inputMint = intent.side === "sell" ? intent.tokenAddress : config.usdcMint;
          const outputMint = intent.side === "sell" ? config.usdcMint : intent.tokenAddress;
          const supply = await api.rpc<{ value: { decimals: number } }>("getTokenSupply", [inputMint]);
          const amount = intent.amountMode === "wallet_percent"
            ? percentOf(await solanaTokenBalance(wallet.address, inputMint), intent.allocationPercent).toString()
            : tokenAmount(intent.amount || "0", supply.value.decimals);
          if (BigInt(amount) <= 0n) throw new Error("The approved Solana funding balance is too small for this allocation.");
          const order = { chain: "solana" as const, router: intent.router || "jupiter", inputMint, outputMint, amount, slippageBps: intent.slippageBps ?? 50, walletAddress: wallet.address };
          const quote = await api.quote(order);
          const payload = await api.transaction({ ...order, quoteId: quote.quoteId });
          const encoded = deepFind(payload, ["transaction", "swapTransaction", "unsignedTransaction", "serializedTransaction"]);
          if (typeof encoded !== "string") throw new Error("Router did not return a Solana transaction.");
          const result = await signAndSendTransaction({ transaction: decodeBase64(encoded), wallet, chain: "solana:mainnet" });
          hash = typeof result.signature === "string" ? result.signature : base58(result.signature);
        } else {
          if (!intent.tokenAddress) throw new Error("This automation has not resolved a token contract yet.");
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
          const order = { chain: "robinhood" as const, router: "0x" as const, inputMint: selling ? token : NATIVE_ETH, outputMint: selling ? NATIVE_ETH : token, amount, slippageBps: intent.slippageBps ?? 50, walletAddress: wallet.address };
          const quote = await api.quote(order);
          const payload = await api.transaction({ ...order, quoteId: quote.quoteId });
          const send = (tx: EvmTx) => {
            const value = quantity(tx.value), gasLimit = quantity(tx.gas), gasPrice = quantity(tx.gasPrice);
            const maxFeePerGas = quantity(tx.maxFeePerGas), maxPriorityFeePerGas = quantity(tx.maxPriorityFeePerGas);
            return sendTransaction({ to: tx.to, data: tx.data,
              ...(value === undefined ? {} : { value }), ...(gasLimit === undefined ? {} : { gasLimit }),
              ...(gasPrice === undefined ? {} : { gasPrice }), ...(maxFeePerGas === undefined ? {} : { maxFeePerGas }),
              ...(maxPriorityFeePerGas === undefined ? {} : { maxPriorityFeePerGas }), chainId: ROBINHOOD_CHAIN.id }, { address: wallet.address });
          };
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
        const transferLabel = solTransferConfirmed ? "Transfer confirmed" : "Transfer submitted; confirmation pending—do not retry";
        useAgentStore.getState().addMessage({ role: "system", text: `${intent.kind === "transfer" ? transferLabel : "Swap submitted"}: ${hash.slice(0, 10)}…` });
        notify({ title: intent.kind === "transfer" ? (solTransferConfirmed ? "TRANSFER CONFIRMED" : "TRANSFER SUBMITTED") : "VOICE TRADE SUBMITTED", message: automation.intent.description, tone: "success" });
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
  }, [evmWallets, notify, sendTransaction, signAndSendTransaction, solanaWallets]);
  return null;
}
