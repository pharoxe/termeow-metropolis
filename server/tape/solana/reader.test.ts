import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NULL_RETRY_MS, RATE_LIMIT_BLOCK_MS, SEEN_TTL_MS, TransactionReader, type ReaderMeta } from "./reader.js";

const RPC = "https://rpc.example.test/";
const META: ReaderMeta = { mint: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump", slot: 1 };

type Reply = { status: number; body?: unknown };

function reply(status: number, body?: unknown): Reply {
  return { status, body };
}

/** Stub fetch that answers from a per-signature script and records the fake-clock time of every call. */
function fakeRpc(script: Record<string, Reply[]> = {}) {
  const calls: Array<{ sig: string; at: number; init: RequestInit | undefined }> = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const sig = JSON.parse(String(init?.body)).params[0] as string;
    calls.push({ sig, at: Date.now(), init });
    const next = script[sig]?.shift() ?? reply(200, { jsonrpc: "2.0", result: { slot: 1, sig } });
    return new Response(next.status === 429 ? "" : JSON.stringify(next.body), { status: next.status });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function build(rps: number, script?: Record<string, Reply[]>, maxQueue?: number) {
  const rpc = fakeRpc(script);
  const handler = vi.fn();
  const reader = new TransactionReader({ rpcUrl: RPC, rps, maxQueue, fetchImpl: rpc.fetchImpl });
  return { reader, handler, ...rpc };
}

const readers: TransactionReader[] = [];
function track<T extends { reader: TransactionReader }>(h: T): T {
  readers.push(h.reader);
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});

afterEach(() => {
  while (readers.length) readers.pop()?.stop();
  vi.useRealTimers();
});

describe("TransactionReader", () => {
  it("posts getTransaction with jsonParsed/v0/confirmed and a JSON content type, then hands the tx to the handler", async () => {
    const h = track(build(10));
    h.reader.enqueue("sigA", META);
    h.reader.start(h.handler);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].init?.method).toBe("POST");
    expect(h.calls[0].init?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(String(h.calls[0].init?.body))).toMatchObject({
      method: "getTransaction",
      params: ["sigA", { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]
    });
    expect(h.handler).toHaveBeenCalledWith({ slot: 1, sig: "sigA" }, META);
    expect(h.reader.stats()).toMatchObject({ read: 1, queued: 0, inFlight: false, lastError: null });
  });

  it("paces requests at 1000/rps ms apart (rps=2 -> >= 500ms)", async () => {
    const h = track(build(2));
    ["s1", "s2", "s3"].forEach((sig) => h.reader.enqueue(sig, META));
    h.reader.start(h.handler);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(498);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[1].at - h.calls[0].at).toBeGreaterThanOrEqual(500);
    expect(h.calls[2].at - h.calls[1].at).toBeGreaterThanOrEqual(500);
    expect(h.handler).toHaveBeenCalledTimes(3);
  });

  it("drops the oldest when the queue is full, counts it, and lets the dropped signature be enqueued again", async () => {
    const h = track(build(10, {}, 2));
    expect(h.reader.enqueue("a", META)).toBe(true);
    expect(h.reader.enqueue("b", META)).toBe(true);
    expect(h.reader.enqueue("c", META)).toBe(true);
    expect(h.reader.stats()).toMatchObject({ queued: 2, dropped: 1, maxQueueSeen: 2 });
    expect(h.reader.enqueue("a", META)).toBe(true);
    expect(h.reader.stats()).toMatchObject({ queued: 2, dropped: 2 });
    h.reader.start(h.handler);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls.map((call) => call.sig)).toEqual(["c", "a"]);
  });

  it("dedupes signatures that are queued or were read within the last five minutes", async () => {
    const h = track(build(10));
    expect(h.reader.enqueue("a", META)).toBe(true);
    expect(h.reader.enqueue("a", META)).toBe(false);
    h.reader.start(h.handler);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.calls).toHaveLength(1);
    expect(h.reader.enqueue("a", META)).toBe(false);
    await vi.advanceTimersByTimeAsync(SEEN_TTL_MS);
    expect(h.reader.enqueue("a", META)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.calls).toHaveLength(2);
  });

  it("backs off 5s on 429 and retries the same signature at the front once", async () => {
    const h = track(build(10, { a: [reply(429), reply(429)] }));
    h.reader.enqueue("a", META);
    h.reader.enqueue("b", META);
    h.reader.start(h.handler);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls.map((call) => call.sig)).toEqual(["a"]);
    expect(h.reader.stats()).toMatchObject({ rateLimited: 1, queued: 2, lastError: "getTransaction: 429 rate limited" });
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_BLOCK_MS - 2);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls.map((call) => call.sig)).toEqual(["a", "a"]);
    expect(h.reader.stats()).toMatchObject({ rateLimited: 2, dropped: 1, queued: 1 });
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_BLOCK_MS);
    expect(h.calls.map((call) => call.sig)).toEqual(["a", "a", "b"]);
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.handler.mock.calls[0][1]).toEqual(META);
  });

  it("retries a null result once after 2s and then counts it as missing", async () => {
    const h = track(build(10, { gone: [reply(200, { result: null }), reply(200, { result: null })], late: [reply(200, { result: null })] }));
    h.reader.enqueue("gone", META);
    h.reader.enqueue("late", META);
    h.reader.start(h.handler);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls.map((call) => call.sig)).toEqual(["gone"]);
    await vi.advanceTimersByTimeAsync(NULL_RETRY_MS - 2);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls.map((call) => call.sig)).toEqual(["gone", "gone"]);
    expect(h.reader.stats()).toMatchObject({ missing: 1, read: 0 });
    await vi.advanceTimersByTimeAsync(NULL_RETRY_MS + 200);
    expect(h.calls.map((call) => call.sig)).toEqual(["gone", "gone", "late", "late"]);
    expect(h.reader.stats()).toMatchObject({ missing: 1, read: 1 });
    expect(h.handler).toHaveBeenCalledTimes(1);
  });

  it("records rpc errors and handler throws in lastError without stopping the loop", async () => {
    const h = track(build(10, { bad: [reply(500)], rpcErr: [reply(200, { error: { code: -32602, message: "bad sig" } })] }));
    h.handler.mockImplementationOnce(() => {
      throw new Error("handler exploded");
    });
    ["bad", "rpcErr", "boom", "ok"].forEach((sig) => h.reader.enqueue(sig, META));
    h.reader.start(h.handler);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reader.stats().lastError).toBe("getTransaction: upstream returned 500");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.reader.stats().lastError).toContain("bad sig");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.reader.stats().lastError).toBe("handler exploded");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.calls.map((call) => call.sig)).toEqual(["bad", "rpcErr", "boom", "ok"]);
    expect(h.reader.stats()).toMatchObject({ read: 2, queued: 0 });
  });

  it("stop halts the worker loop", async () => {
    const h = track(build(1));
    ["a", "b", "c"].forEach((sig) => h.reader.enqueue(sig, META));
    h.reader.start(h.handler);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
    h.reader.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(1);
    expect(h.reader.stats()).toMatchObject({ read: 1, queued: 2, inFlight: false });
  });
});
