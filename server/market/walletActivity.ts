import type { WalletActivityItem, WalletActivityResponse } from "../../shared/walletActivity.js";
import { walletRpc } from "./walletPortfolio.js";

type Rpc = (method: string, params: unknown[]) => Promise<any>;

const numeric = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

function parsedInstruction(instruction: any): { native?: WalletActivityItem["nativeTransfers"][number]; token?: WalletActivityItem["tokenTransfers"][number] } | null {
  const parsed = instruction?.parsed;
  const info = parsed?.info;
  if (!parsed?.type || !info) return null;
  if (instruction.program === "system" && parsed.type === "transfer") {
    return { native: { from: String(info.source || ""), to: String(info.destination || ""), amount: numeric(info.lamports) / 1e9 } };
  }
  if (instruction.program === "spl-token" && ["transfer", "transferChecked"].includes(parsed.type)) {
    return { token: { mint: info.mint ? String(info.mint) : undefined, from: info.source ? String(info.source) : undefined, to: info.destination ? String(info.destination) : undefined, amount: numeric(info.tokenAmount?.uiAmountString ?? info.amount) } };
  }
  return null;
}

export async function solanaWalletActivity(walletAddress: string, limit = 20, rpc: Rpc = walletRpc): Promise<WalletActivityResponse> {
  const signatures = await rpc("getSignaturesForAddress", [walletAddress, { limit: Math.min(40, Math.max(1, limit)), commitment: "confirmed" }]);
  const settled = await Promise.allSettled((signatures || []).map((row: any) => rpc("getTransaction", [row.signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])));
  const items: WalletActivityItem[] = [];
  settled.forEach((result, index) => {
    if (result.status !== "fulfilled" || !result.value) return;
    const transaction = result.value;
    const message = transaction.transaction?.message;
    const accountKeys = (message?.accountKeys || []).map((key: any) => String(key.pubkey || key));
    const nativeTransfers: WalletActivityItem["nativeTransfers"] = [];
    const tokenTransfers: WalletActivityItem["tokenTransfers"] = [];
    for (const instruction of message?.instructions || []) {
      const parsed = parsedInstruction(instruction);
      if (parsed?.native?.from && parsed.native.to) nativeTransfers.push(parsed.native);
      if (parsed?.token) tokenTransfers.push(parsed.token);
    }
    const balances = new Map<string, number>();
    for (const row of transaction.meta?.preTokenBalances || []) if (row.owner === walletAddress && row.mint) balances.set(row.mint, -numeric(row.uiTokenAmount?.uiAmountString));
    for (const row of transaction.meta?.postTokenBalances || []) if (row.owner === walletAddress && row.mint) balances.set(row.mint, (balances.get(row.mint) || 0) + numeric(row.uiTokenAmount?.uiAmountString));
    const tokenBalanceChanges = [...balances].filter(([, amount]) => Math.abs(amount) > 1e-12).map(([mint, amount]) => ({ mint, amount }));
    const swap = tokenBalanceChanges.some((row) => row.amount > 0) && tokenBalanceChanges.some((row) => row.amount < 0);
    const programs = [...new Set<string>((message?.instructions || []).map((instruction: any) => String(instruction.programId || instruction.program || "")).filter(Boolean))];
    items.push({
      signature: String((signatures || [])[index]?.signature || ""),
      observedAt: numeric(transaction.blockTime) * 1000,
      status: transaction.meta?.err ? "failed" : "confirmed",
      kind: swap ? "swap" : nativeTransfers.length || tokenTransfers.length ? "transfer" : "transaction",
      feeNative: numeric(transaction.meta?.fee) / 1e9,
      nativeTransfers,
      tokenTransfers,
      tokenBalanceChanges,
      programs
    });
  });
  return { chain: "solana", walletAddress, observedAt: Date.now(), source: "solana-rpc:getSignaturesForAddress+getTransaction", items, partial: settled.some((result) => result.status === "rejected") };
}
