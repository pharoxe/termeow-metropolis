import { createPublicClient, http } from "viem";
import { MONAD_CHAIN } from "../features/NetworkContext";

/**
 * Read-only Monad client for the browser. Reads go through the server's /api/rpc proxy (read methods only), which rides
 * the server's health-ranked endpoint pool instead of one public RPC and avoids browser CORS limits.
 */
const rpcUrl = typeof window === "undefined" ? MONAD_CHAIN.rpcUrls.default.http[0] : `${window.location.origin}/api/rpc`;
export const monadClient = createPublicClient({ chain: MONAD_CHAIN, transport: http(rpcUrl, { batch: { batchSize: 20, wait: 16 } }) });

export const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }
] as const;

/** True when the current allowance is short of `amount` (or unreadable), so an exact-amount approval must come first. */
export async function approvalNeeded(token: string, owner: string, spender: string, amount: bigint): Promise<boolean> {
  try {
    const current = await monadClient.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: "allowance", args: [owner as `0x${string}`, spender as `0x${string}`] });
    return BigInt(current) < amount;
  } catch {
    return true;
  }
}
