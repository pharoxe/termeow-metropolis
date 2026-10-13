import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BLOCK_RETRY_ATTEMPTS, BLOCK_RETRY_BASE_MS, BlockTimeCache, DEFAULT_BLOCK_CACHE_MAX, type BlockTimeCacheOptions } from "./blocks.js";

const RPC = "https://rpc.example.test/";
const FIXTURES = new URL("./__fixtures__/", import.meta.url);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
}

/** Real eth_getBlockByNumber results captured 2026-09-06; Gecko block_timestamp matched all three. */
const BLOCKS: Record<number, unknown> = {
  55900852: fixture("block-55900852.json"),
  55900104: fixture("block-55900104.json"),
  55898525: fixture("block-55898525.json")
};
const V4_BLOCK_MS = Date.parse("2026-09-06T10:19:25Z");

type Reply = { status: number; body?: unknown };

/** Stub fetch answering eth_getBlockByNumber from the fixture blocks unless a scripted reply overrides it. */
function fakeRpc(script: Reply[] = []) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push(body);
    const scripted = script.shift();
    if (scripted) return new Response(scripted.body === undefined ? "" : JSON.stringify(scripted.body), { status: scripted.status });
    const result = BLOCKS[Number(body.params[0])] ?? null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** Retries are exercised explicitly below; every other test runs with no retry delay. */
function cache(rpc: ReturnType<typeof fakeRpc>, opts: Partial<BlockTimeCacheOptions> = {}): BlockTimeCache {
  return new BlockTimeCache({ rpcUrl: RPC, fetchImpl: rpc.fetchImpl, retryBaseMs: 0, ...opts });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("BlockTimeCache", () => {
  it("posts eth_getBlockByNumber(hex, false) and returns timestamp * 1000", async () => {
    const rpc = fakeRpc();
    const cache = new BlockTimeCache({ rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    expect(await cache.timeMs(55900852)).toBe(V4_BLOCK_MS);
    expect(rpc.calls).toMatchObject([{ method: "eth_getBlockByNumber", params: ["0x354fab4", false] }]);
    expect(await cache.timeMs(55900104)).toBe(Date.parse("2026-09-06T10:18:11Z"));
    expect(await cache.timeMs(55898525)).toBe(Date.parse("2026-09-06T10:15:30Z"));
  });

  it("serves a cache hit without a second request", async () => {
    const rpc = fakeRpc();
    const cache = new BlockTimeCache({ rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    await cache.timeMs(55900852);
    expect(await cache.timeMs(55900852)).toBe(V4_BLOCK_MS);
    expect(rpc.calls).toHaveLength(1);
    expect(cache.stats()).toEqual({ cached: 1, inFlight: 0, hits: 1, misses: 1, failures: 0, lastError: null });
  });

  it("dedupes concurrent requests for the same block into one fetch", async () => {
    const rpc = fakeRpc();
    const cache = new BlockTimeCache({ rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    const results = await Promise.all([cache.timeMs(55900852), cache.timeMs(55900852), cache.timeMs(55900852)]);
    expect(results).toEqual([V4_BLOCK_MS, V4_BLOCK_MS, V4_BLOCK_MS]);
    expect(rpc.calls).toHaveLength(1);
    expect(cache.stats().inFlight).toBe(0);
  });

  it("with a single attempt, returns null and records lastError on HTTP failure, then retries on the next call", async () => {
    const rpc = fakeRpc([{ status: 500 }]);
    const single = cache(rpc, { retryAttempts: 1 });
    expect(await single.timeMs(55900852)).toBeNull();
    expect(single.stats()).toMatchObject({ cached: 0, failures: 1, lastError: "block 55900852: eth_getBlockByNumber: upstream returned 500" });
    expect(await single.timeMs(55900852)).toBe(V4_BLOCK_MS);
    expect(rpc.calls).toHaveLength(2);
  });

  it("retries a 429 and a lagging node (result null) within one lookup and reports no failure", async () => {
    const rpc = fakeRpc([{ status: 429 }, { status: 200, body: { jsonrpc: "2.0", id: 1, result: null } }]);
    const retrying = cache(rpc);
    expect(await retrying.timeMs(55900852)).toBe(V4_BLOCK_MS);
    expect(rpc.calls).toHaveLength(3);
    expect(retrying.stats()).toMatchObject({ cached: 1, misses: 1, failures: 0 });
    expect(await retrying.timeMs(55900852)).toBe(V4_BLOCK_MS);
    expect(rpc.calls).toHaveLength(3);
  });

  it("gives up after retryAttempts, counts one failure, and tries again on the next call", async () => {
    const rpc = fakeRpc([{ status: 429 }, { status: 502 }, { status: 429 }]);
    const retrying = cache(rpc);
    expect(await retrying.timeMs(55900852)).toBeNull();
    expect(rpc.calls).toHaveLength(3);
    expect(retrying.stats()).toMatchObject({ cached: 0, misses: 1, failures: 1, lastError: "block 55900852: eth_getBlockByNumber: upstream returned 429" });
    expect(await retrying.timeMs(55900852)).toBe(V4_BLOCK_MS);
    expect(rpc.calls).toHaveLength(4);
  });

  it("waits retryBaseMs, then double, between attempts", async () => {
    vi.useFakeTimers();
    const rpc = fakeRpc([{ status: 429 }, { status: 429 }]);
    const retrying = new BlockTimeCache({ rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    const pending = retrying.timeMs(55900852);
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(BLOCK_RETRY_BASE_MS - 1);
    expect(rpc.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(BLOCK_RETRY_BASE_MS * 2 - 1);
    expect(rpc.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.calls).toHaveLength(3);
    expect(await pending).toBe(V4_BLOCK_MS);
  });

  it("returns null for an unknown block (result null), a JSON-RPC error, and a network throw", async () => {
    const rpc = fakeRpc([{ status: 200, body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } } }]);
    const single = cache(rpc, { retryAttempts: 1 });
    expect(await single.timeMs(1)).toBeNull();
    expect(single.stats().lastError).toBe("block 1: eth_getBlockByNumber: boom");
    expect(await single.timeMs(99)).toBeNull();
    expect(single.stats().lastError).toBe("block 99 not found");
    const failing = new BlockTimeCache({ rpcUrl: RPC, retryBaseMs: 0, fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch });
    expect(await failing.timeMs(2)).toBeNull();
    expect(failing.stats()).toMatchObject({ failures: 1, lastError: "block 2: ECONNRESET" });
  });

  it("rejects a non-integer block number without calling the rpc", async () => {
    const rpc = fakeRpc();
    const cache = new BlockTimeCache({ rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    expect(await cache.timeMs(1.5)).toBeNull();
    expect(await cache.timeMs(-1)).toBeNull();
    expect(rpc.calls).toHaveLength(0);
    expect(cache.stats().lastError).toBe("invalid block number -1");
  });

  it("evicts the least recently used block once max is exceeded", async () => {
    const rpc = fakeRpc();
    const cache = new BlockTimeCache({ rpcUrl: RPC, fetchImpl: rpc.fetchImpl, max: 2 });
    await cache.timeMs(55900852);
    await cache.timeMs(55900104);
    await cache.timeMs(55900852); // touch: 55900104 is now the oldest
    await cache.timeMs(55898525); // evicts 55900104
    expect(cache.stats().cached).toBe(2);
    await cache.timeMs(55900852);
    expect(rpc.calls).toHaveLength(3);
    await cache.timeMs(55900104);
    expect(rpc.calls).toHaveLength(4);
  });

  it("defaults to the global fetch and a 5000-block bound", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: BLOCKS[55900852] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new BlockTimeCache({ rpcUrl: RPC });
    expect(await cache.timeMs(55900852)).toBe(V4_BLOCK_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(DEFAULT_BLOCK_CACHE_MAX).toBe(5000);
    expect(BLOCK_RETRY_ATTEMPTS).toBe(3);
    expect(BLOCK_RETRY_BASE_MS).toBe(500);
  });
});
