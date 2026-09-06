import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountClassifier, FOMO_DESIGNATOR, isFomoCode, type AccountClassifierOptions } from "./identity.js";

const RPC = "https://rpc.example.test/";
const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const WALLET = "0x06de9c48b1e639ed5c13ec8fbd4080a38e39f2d1";
const WALLET_B = "0x0a6ebed0155edb4b21d92ad02897a626cd90119e";
const WALLET_C = "0x662053fd75f1f7da7e524d884b96552a13d2800b";
const OTHER_7702 = "0xef0100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTRACT = "0x6080604052348015600f57600080fd5b50";
const BACKOFF_MS = 1_000;

type CodesFixture = { wallets: Array<{ wallet: string; code: string; isFomoDesignator: boolean }> };
type Reply = { status: number; body?: unknown };

function codesFixture(): CodesFixture {
  return JSON.parse(readFileSync(new URL("codes.json", FIXTURES), "utf8")) as CodesFixture;
}

/** Stub fetch answering eth_getCode from `codes` (default: FOMO designator) unless a scripted reply overrides it. */
function fakeRpc(codes: Record<string, string> = {}, script: Reply[] = []) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push(body);
    const scripted = script.shift();
    if (scripted) return new Response(scripted.body === undefined ? "" : JSON.stringify(scripted.body), { status: scripted.status });
    const result = codes[String(body.params[0])] ?? FOMO_DESIGNATOR;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** Pacing is exercised explicitly under fake timers; every other test runs effectively unpaced. */
function classifier(rpc: ReturnType<typeof fakeRpc>, opts: Partial<AccountClassifierOptions> = {}): AccountClassifier {
  return new AccountClassifier({ rpcUrl: RPC, fetchImpl: rpc.fetchImpl, rps: 1_000_000, backoffMs: BACKOFF_MS, ...opts });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isFomoCode", () => {
  it("matches the designator in any case and rejects EOAs, contracts and other 7702 delegates", () => {
    expect(isFomoCode(FOMO_DESIGNATOR)).toBe(true);
    expect(isFomoCode(FOMO_DESIGNATOR.toUpperCase())).toBe(true);
    expect(isFomoCode("0x")).toBe(false);
    expect(isFomoCode("")).toBe(false);
    expect(isFomoCode(OTHER_7702)).toBe(false);
    expect(isFomoCode(CONTRACT)).toBe(false);
    expect(isFomoCode(undefined)).toBe(false);
    expect(isFomoCode(null)).toBe(false);
  });
});

describe("AccountClassifier", () => {
  it("posts eth_getCode(address, latest) and classifies the designator as fomo", async () => {
    const rpc = fakeRpc();
    const account = classifier(rpc);
    expect(await account.classify(WALLET)).toBe("fomo");
    expect(rpc.calls).toMatchObject([{ method: "eth_getCode", params: [WALLET, "latest"] }]);
    expect(account.stats()).toMatchObject({ cached: 1, fomo: 1, other: 0, pending: 0, failures: 0 });
  });

  it("classifies an EOA, a contract and another 7702 delegate as other", async () => {
    const rpc = fakeRpc({ [WALLET]: "0x", [WALLET_B]: CONTRACT, [WALLET_C]: OTHER_7702 });
    const account = classifier(rpc);
    expect(await account.classify(WALLET)).toBe("other");
    expect(await account.classify(WALLET_B)).toBe("other");
    expect(await account.classify(WALLET_C)).toBe("other");
    expect(account.stats()).toMatchObject({ cached: 3, fomo: 0, other: 3 });
  });

  it("agrees with the captured codes.json designator flags for every sampled tape wallet", async () => {
    const fixture = codesFixture();
    /** Two capture rows carry code null (the eth_getCode 429'd); they are lookup failures, not classifications. */
    const captured = fixture.wallets.filter((row) => typeof row.code === "string");
    const rpc = fakeRpc(Object.fromEntries(captured.map((row) => [row.wallet, row.code])));
    const account = classifier(rpc);
    for (const row of captured) {
      expect(await account.classify(row.wallet)).toBe(row.isFomoDesignator ? "fomo" : "other");
    }
    expect(captured.length).toBeGreaterThanOrEqual(20);
    expect(captured.every((row) => row.isFomoDesignator)).toBe(true);
    expect(fixture.wallets.length - captured.length).toBe(2);
    expect(rpc.calls).toHaveLength(captured.length);
  });

  it("caches positive and negative results: one fetch per address, case-insensitive", async () => {
    const rpc = fakeRpc({ [WALLET_B]: "0x" });
    const account = classifier(rpc);
    expect(await account.classify(WALLET)).toBe("fomo");
    expect(await account.classify(WALLET.toUpperCase().replace("0X", "0x"))).toBe("fomo");
    expect(await account.classify(WALLET_B)).toBe("other");
    expect(await account.classify(WALLET_B)).toBe("other");
    expect(rpc.calls).toHaveLength(2);
    expect(account.peek(WALLET)).toBe("fomo");
    expect(account.peek(WALLET_C)).toBeUndefined();
  });

  it("dedupes concurrent lookups of the same address into one request", async () => {
    const rpc = fakeRpc();
    const account = classifier(rpc);
    const pending = Promise.all([account.classify(WALLET), account.classify(WALLET), account.classify(WALLET)]);
    expect(account.stats().pending).toBe(1);
    expect(await pending).toEqual(["fomo", "fomo", "fomo"]);
    expect(rpc.calls).toHaveLength(1);
    expect(account.stats().pending).toBe(0);
  });

  it("paces lookups at rps: one request per 250ms at 4 rps", async () => {
    vi.useFakeTimers();
    const rpc = fakeRpc();
    const account = classifier(rpc, { rps: 4 });
    const all = Promise.all([account.classify(WALLET), account.classify(WALLET_B), account.classify(WALLET_C)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(rpc.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(rpc.calls).toHaveLength(3);
    expect(await all).toEqual(["fomo", "fomo", "fomo"]);
  });

  it("backs off after a 429, holds every waiter, and retries the failed lookup once", async () => {
    vi.useFakeTimers();
    const rpc = fakeRpc({}, [{ status: 429 }]);
    const account = classifier(rpc, { rps: 4 });
    const first = account.classify(WALLET);
    const second = account.classify(WALLET_B);
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.calls).toHaveLength(1);
    expect(account.stats().rpc).toMatchObject({ rateLimited: 1, blocked: true });
    await vi.advanceTimersByTimeAsync(BACKOFF_MS - 1);
    expect(rpc.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(rpc.calls).toHaveLength(3);
    expect(await first).toBe("fomo");
    expect(await second).toBe("fomo");
    expect(account.stats()).toMatchObject({ failures: 0, fomo: 2 });
  });

  it("answers null without caching when the retry is 429 too, then succeeds on the next call", async () => {
    vi.useFakeTimers();
    const rpc = fakeRpc({}, [{ status: 429 }, { status: 429 }]);
    const account = classifier(rpc, { rps: 4 });
    const first = account.classify(WALLET);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS * 2);
    expect(await first).toBeNull();
    expect(account.stats()).toMatchObject({ cached: 0, failures: 1 });
    expect(account.stats().lastError).toContain("429");
    const again = account.classify(WALLET);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS);
    expect(await again).toBe("fomo");
    expect(rpc.calls).toHaveLength(3);
  });

  it("answers null on an RPC error or a non-string result and keeps the reason", async () => {
    const rpc = fakeRpc({}, [
      { status: 200, body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "header not found" } } },
      { status: 200, body: { jsonrpc: "2.0", id: 1, result: 42 } },
      { status: 200, body: "not json {" }
    ]);
    const account = classifier(rpc);
    expect(await account.classify(WALLET)).toBeNull();
    expect(account.stats().lastError).toContain("header not found");
    expect(await account.classify(WALLET)).toBeNull();
    expect(account.stats().lastError).toContain("non-string result");
    expect(await account.classify(WALLET)).toBeNull();
    expect(account.stats()).toMatchObject({ cached: 0, failures: 3 });
  });

  it("rejects a malformed address without a request", async () => {
    const rpc = fakeRpc();
    const account = classifier(rpc);
    expect(await account.classify("0x1234")).toBeNull();
    expect(await account.classify("not-an-address")).toBeNull();
    expect(rpc.calls).toHaveLength(0);
    expect(account.stats().lastError).toContain("invalid address");
  });

  it("bounds the cache as an LRU and re-fetches an evicted address", async () => {
    const rpc = fakeRpc();
    const account = classifier(rpc, { max: 2 });
    await account.classify(WALLET);
    await account.classify(WALLET_B);
    await account.classify(WALLET);
    await account.classify(WALLET_C);
    expect(account.stats().cached).toBe(2);
    expect(account.peek(WALLET_B)).toBeUndefined();
    expect(account.peek(WALLET)).toBe("fomo");
    await account.classify(WALLET_B);
    expect(rpc.calls).toHaveLength(4);
  });

  it("classifyMany dedupes addresses and keys the map by lowercase address", async () => {
    const rpc = fakeRpc({ [WALLET_B]: "0x" }, [{ status: 200, body: { jsonrpc: "2.0", id: 1, result: FOMO_DESIGNATOR } }]);
    const account = classifier(rpc);
    const kinds = await account.classifyMany([WALLET, WALLET.toUpperCase().replace("0X", "0x"), WALLET_B, "0xbad"]);
    expect(kinds.get(WALLET)).toBe("fomo");
    expect(kinds.get(WALLET_B)).toBe("other");
    expect(kinds.get("0xbad")).toBeNull();
    expect(kinds.size).toBe(3);
    expect(rpc.calls).toHaveLength(2);
  });
});
