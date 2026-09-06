import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReceiptFetcher, normalizeReceipt, type ReceiptFetcherOptions } from "./receipts.js";

const RPC = "https://rpc.example.test/";
const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const ENTRY_POINT = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";
const BACKOFF_MS = 1_000;

type Captured = { receipt: Record<string, unknown> };
type Reply = { status: number; body?: unknown };

/** Relay A (EntryPoint) fill captured 2026-09-06: 23 logs, 2 UserOperationEvents. */
const CAPTURED = (JSON.parse(readFileSync(new URL("receipt-AvgJoesCrypto-51e1a0bc.json", FIXTURES), "utf8")) as Captured).receipt;
const TX = String(CAPTURED.transactionHash);
const TX_B = `0x${"ab".repeat(32)}`;
const TX_C = `0x${"cd".repeat(32)}`;

/** Stub fetch answering eth_getTransactionReceipt with the captured receipt unless a scripted reply overrides it. */
function fakeRpc(script: Reply[] = []) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push(body);
    const scripted = script.shift();
    if (scripted) return new Response(scripted.body === undefined ? "" : JSON.stringify(scripted.body), { status: scripted.status });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ...CAPTURED, transactionHash: body.params[0] } }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function fetcher(rpc: ReturnType<typeof fakeRpc>, opts: Partial<ReceiptFetcherOptions> = {}): ReceiptFetcher {
  return new ReceiptFetcher({ rpcUrl: RPC, fetchImpl: rpc.fetchImpl, rps: 1_000_000, backoffMs: BACKOFF_MS, ...opts });
}

function ok(result: unknown): Reply {
  return { status: 200, body: { jsonrpc: "2.0", id: 1, result } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("normalizeReceipt", () => {
  it("lowercases addresses, hashes and topics and keeps every log in node order", () => {
    const receipt = normalizeReceipt(CAPTURED);
    expect(receipt.transactionHash).toBe(TX.toLowerCase());
    expect(receipt.to).toBe(ENTRY_POINT);
    expect(receipt.status).toBe("0x1");
    expect(receipt.logs).toHaveLength(23);
    expect(receipt.logs.map((log) => Number.parseInt(log.logIndex, 16))).toEqual([...receipt.logs].map((log) => Number.parseInt(log.logIndex, 16)).sort((a, b) => a - b));
    expect(receipt.logs.every((log) => log.address === log.address.toLowerCase())).toBe(true);
  });

  it("throws on a receipt with no logs array or a malformed log", () => {
    expect(() => normalizeReceipt({ ...CAPTURED, logs: undefined })).toThrow(/logs/);
    expect(() => normalizeReceipt({ ...CAPTURED, logs: [{ address: 1 }] })).toThrow(/malformed log/);
    expect(() => normalizeReceipt("0x")).toThrow(/not an object/);
    expect(() => normalizeReceipt({ logs: [] })).toThrow(/transactionHash/);
  });
});

describe("ReceiptFetcher", () => {
  it("posts eth_getTransactionReceipt(hash) and returns the normalized receipt", async () => {
    const rpc = fakeRpc();
    const receipts = fetcher(rpc);
    const receipt = await receipts.get(TX);
    expect(rpc.calls).toMatchObject([{ method: "eth_getTransactionReceipt", params: [TX.toLowerCase()] }]);
    expect(receipt?.to).toBe(ENTRY_POINT);
    expect(receipt?.logs).toHaveLength(23);
    expect(receipts.stats()).toMatchObject({ cached: 1, pending: 0, fetched: 1, missing: 0, failures: 0 });
  });

  it("serves a cache hit without a second request, case-insensitively", async () => {
    const rpc = fakeRpc();
    const receipts = fetcher(rpc);
    const first = await receipts.get(TX);
    const second = await receipts.get(TX.toUpperCase().replace("0X", "0x"));
    expect(second).toBe(first);
    expect(rpc.calls).toHaveLength(1);
  });

  it("dedupes concurrent lookups of the same hash", async () => {
    const rpc = fakeRpc();
    const receipts = fetcher(rpc);
    const pending = Promise.all([receipts.get(TX), receipts.get(TX)]);
    expect(receipts.stats().pending).toBe(1);
    const [a, b] = await pending;
    expect(a).toBe(b);
    expect(rpc.calls).toHaveLength(1);
  });

  it("answers null for a pending/unknown tx without caching it", async () => {
    const rpc = fakeRpc([ok(null)]);
    const receipts = fetcher(rpc);
    expect(await receipts.get(TX)).toBeNull();
    expect(receipts.stats()).toMatchObject({ cached: 0, missing: 1, failures: 0 });
    expect(await receipts.get(TX)).not.toBeNull();
    expect(rpc.calls).toHaveLength(2);
  });

  it("answers null on a malformed receipt, an RPC error or a bad hash and records the reason", async () => {
    const rpc = fakeRpc([ok({ transactionHash: TX, from: "0x", blockNumber: "0x1" }), { status: 200, body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } } }]);
    const receipts = fetcher(rpc);
    expect(await receipts.get(TX)).toBeNull();
    expect(receipts.stats().lastError).toContain("logs");
    expect(await receipts.get(TX)).toBeNull();
    expect(receipts.stats().lastError).toContain("boom");
    expect(await receipts.get("0x1234")).toBeNull();
    expect(receipts.stats()).toMatchObject({ cached: 0, failures: 2 });
    expect(rpc.calls).toHaveLength(2);
  });

  it("paces requests at rps under fake timers", async () => {
    vi.useFakeTimers();
    const rpc = fakeRpc();
    const receipts = fetcher(rpc, { rps: 4 });
    const all = Promise.all([receipts.get(TX), receipts.get(TX_B), receipts.get(TX_C)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(rpc.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(rpc.calls).toHaveLength(3);
    expect((await all).every((receipt) => receipt !== null)).toBe(true);
  });

  it("backs off after a 429 and retries once", async () => {
    vi.useFakeTimers();
    const rpc = fakeRpc([{ status: 429 }]);
    const receipts = fetcher(rpc, { rps: 4 });
    const pending = receipts.get(TX);
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.calls).toHaveLength(1);
    expect(receipts.stats().rpc).toMatchObject({ rateLimited: 1, blocked: true });
    await vi.advanceTimersByTimeAsync(BACKOFF_MS - 1);
    expect(rpc.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.calls).toHaveLength(2);
    expect(await pending).not.toBeNull();
    expect(receipts.stats()).toMatchObject({ fetched: 1, failures: 0 });
  });

  it("bounds the cache as an LRU", async () => {
    const rpc = fakeRpc();
    const receipts = fetcher(rpc, { max: 1 });
    await receipts.get(TX);
    await receipts.get(TX_B);
    expect(receipts.stats().cached).toBe(1);
    await receipts.get(TX);
    expect(rpc.calls).toHaveLength(3);
  });
});
