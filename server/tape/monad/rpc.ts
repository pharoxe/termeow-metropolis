import { errorMessage } from "../../lib/http.js";
import { monadRpcFetch } from "./rpcPool.js";

export const RPC_TIMEOUT_MS = 15_000;
const REVERT_CODE = 3;
const HEX_WORD = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_POOL_ID = /^0x[0-9a-fA-F]{64}$/;

/** A JSON-RPC level error: the node answered, the call itself failed (revert, bad params, node limit). */
export class EvmRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly data?: unknown
  ) {
    super(message);
  }
}

/** True for the one failure a pool probe may legitimately see: the contract has no such function. */
export function isRevert(error: unknown): boolean {
  return error instanceof EvmRpcError && (error.code === REVERT_CODE || /revert/i.test(error.message));
}

function rpcBody(method: string, params: unknown[]): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
}

function parseRpcResult(method: string, body: unknown): unknown {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!record) throw new Error(`${method}: malformed response body`);
  if (record.error) {
    const err = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : {};
    const code = typeof err.code === "number" ? err.code : null;
    throw new EvmRpcError(`${method}: ${String(err.message ?? JSON.stringify(record.error))}`, code, err.data);
  }
  return record.result;
}

/** One JSON-RPC POST. Throws UpstreamError-like Error on HTTP failure, EvmRpcError when the node returns `error`. */
export async function evmRpc(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch = monadRpcFetch,
  timeoutMs = RPC_TIMEOUT_MS
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rpcBody(method, params),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method}: upstream returned ${response.status}`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new Error(`${method}: non-JSON body (${errorMessage(error)})`);
    }
    return parseRpcResult(method, body);
  } finally {
    clearTimeout(timeout);
  }
}

/** eth_call of a zero-argument view (`selector` is the 4-byte id) at latest; returns the raw hex return data. */
export async function ethCall(rpcUrl: string, to: string, selector: string, fetchImpl?: typeof fetch): Promise<string> {
  const result = await evmRpc(rpcUrl, "eth_call", [{ to, data: selector }, "latest"], fetchImpl);
  if (typeof result !== "string") throw new Error(`eth_call ${selector}: non-string result`);
  return result;
}

export function isAddress(value: string): boolean {
  return HEX_ADDRESS.test(value);
}

export function isPoolId(value: string): boolean {
  return HEX_POOL_ID.test(value);
}

/** Decode one ABI word holding an address (left-padded) into lowercase 0x + 40 hex. */
export function decodeAddress(word: string): string {
  if (!HEX_WORD.test(word)) throw new Error(`decodeAddress: expected 32-byte word, got ${word.length} chars`);
  return `0x${word.slice(-40).toLowerCase()}`;
}

/** Decode one ABI word holding a small unsigned integer (fee, decimals) into a safe number. */
export function decodeUint(word: string): number {
  if (!HEX_WORD.test(word)) throw new Error(`decodeUint: expected 32-byte word, got ${word.length} chars`);
  const value = BigInt(word);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("decodeUint: value exceeds safe integer");
  return Number(value);
}

/** Quantity-encoded hex ("0x6a9d3e2d") to a safe number; throws on anything else. */
export function hexToNumber(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`hexToNumber: bad quantity ${String(value)}`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("hexToNumber: value exceeds safe integer");
  return Number(parsed);
}

export function toHexQuantity(value: number): string {
  return `0x${value.toString(16)}`;
}
