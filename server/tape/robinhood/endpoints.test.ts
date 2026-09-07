import { describe, expect, it, vi } from "vitest";
import { UpstreamError } from "../../lib/http.js";
import {
  ENDPOINT_BACKOFF_MAX_MS,
  ENDPOINT_BACKOFF_MS,
  ENDPOINT_USER_AGENT,
  EndpointPool,
  FAIL_STREAK_DECAY_MS,
  LOGS_FORBIDDEN_RETRY_MS,
  NO_LOGS_HOSTS,
  LOGS_RANGE_CAPS,
  NO_SPECULATIVE_TOBLOCK_HOSTS,
  ROBINHOOD_CHAIN_ID,
  SLOW_P50_MS,
  endpointKey,
  shapeOf
} from "./endpoints.js";

const A = "https://robinhood-rpc.publicnode.com";
const B = "https://rpc-robinhood.blockmachine.io";
const C = "https://rpc.mainnet.chain.robinhood.com";
const T0 = 1_788_788_395_478; // 2026-09-07 19:09:55 IST

type Reply = { status: number; body?: unknown; text?: string };
type Handler = (method: string, body: unknown) => Reply;
type Seen = { url: string; method: string; userAgent: string | null; batch: boolean };

const ok = (result: unknown): Reply => ({ status: 200, body: { jsonrpc: "2.0", id: 1, result } });
/** Real chain: every measured endpoint answers eth_chainId "0x1237" (4663). */
const CHAIN_OK = ok("0x1237");
const RATE_LIMITED: Reply = { status: 429, text: '{"code":429,"message":"Too Many Requests"}' };

/** Stub fetch keyed by endpoint URL; eth_chainId answers CHAIN_OK unless the handler says otherwise. */
function fakeNet(handlers: Record<string, Handler>) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const parsed = JSON.parse(String(init?.body)) as { method?: string } | Array<{ method: string }>;
    const method = Array.isArray(parsed) ? parsed.map((item) => item.method).join("+") : parsed.method ?? "?";
    seen.push({ url, method, userAgent: new Headers(init?.headers).get("user-agent"), batch: Array.isArray(parsed) });
    const handler = handlers[endpointKey(url)];
    if (!handler) return new Response("no such host", { status: 502 });
    const reply = handler(method, parsed);
    return new Response(reply.text ?? JSON.stringify(reply.body), { status: reply.status });
  });
  const methods = (url: string) => seen.filter((entry) => endpointKey(entry.url) === endpointKey(url)).map((entry) => entry.method);
  return { fetchImpl: fetchImpl as unknown as typeof fetch, seen, methods };
}

const always = (reply: Reply): Handler => (method) => (method === "eth_chainId" ? CHAIN_OK : reply);
const script = (replies: Reply[]): Handler => {
  const queue = [...replies];
  return (method) => (method === "eth_chainId" ? CHAIN_OK : queue.shift() ?? ok("0xdead"));
};

function makePool(net: ReturnType<typeof fakeNet>, urls: string[], clock: { now: number }, log = vi.fn()) {
  return { pool: new EndpointPool({ urls, fetchImpl: net.fetchImpl, now: () => clock.now, log }), log };
}

const rpcInit = (method: string, params: unknown[] = []): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
});

describe("EndpointPool failover", () => {
  it("routes to the first healthy endpoint, adds a User-Agent and verifies eth_chainId once per endpoint", async () => {
    const net = fakeNet({ [A]: always(ok("0x3640000")), [B]: always(ok("0x3640001")) });
    const clock = { now: T0 };
    const { pool } = makePool(net, [A, B], clock);
    const first = await pool.fetch(A, rpcInit("eth_blockNumber"));
    const second = await pool.fetch(`${B}/`, rpcInit("eth_blockNumber"));
    expect(await first.json()).toMatchObject({ result: "0x3640000" });
    expect(await second.json()).toMatchObject({ result: "0x3640000" });
    expect(net.methods(A)).toEqual(["eth_chainId", "eth_blockNumber", "eth_blockNumber"]);
    expect(net.methods(B)).toEqual([]);
    expect(net.seen.every((entry) => entry.userAgent === ENDPOINT_USER_AGENT)).toBe(true);
  });

  it("falls through to the next endpoint on a 429 and blocks the rate-limited one", async () => {
    const net = fakeNet({ [A]: always(RATE_LIMITED), [B]: always(ok("0x1")) });
    const clock = { now: T0 };
    const { pool } = makePool(net, [A, B], clock);
    const response = await pool.fetch(A, rpcInit("eth_blockNumber"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: "0x1" });
    expect(net.methods(A)).toEqual(["eth_chainId", "eth_blockNumber"]);
    expect(net.methods(B)).toEqual(["eth_chainId", "eth_blockNumber"]);
    const [a, b] = pool.stats().endpoints;
    expect(a).toMatchObject({ url: A, ok: false, rateLimited: 1, failures: 0, calls: 1, lastError: "upstream returned 429" });
    expect(a.blockedUntil).toBe(new Date(T0 + ENDPOINT_BACKOFF_MS).toISOString());
    expect(b).toMatchObject({ url: B, ok: true, rateLimited: 0, calls: 1, blockedUntil: null });
    // the blocked endpoint is skipped outright on the next call: no second retry per call, no traffic to A
    await pool.fetch(A, rpcInit("eth_blockNumber"));
    expect(net.methods(A)).toHaveLength(2);
    expect(net.methods(B)).toHaveLength(3);
  });

  it("retries at most once: two 429s return the second 429 response to the caller unchanged", async () => {
    const net = fakeNet({ [A]: always(RATE_LIMITED), [B]: always(RATE_LIMITED), [C]: always(ok("0x1")) });
    const clock = { now: T0 };
    const { pool } = makePool(net, [A, B, C], clock);
    const response = await pool.fetch(A, rpcInit("eth_blockNumber"));
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("Too Many Requests");
    expect(net.methods(C)).toEqual([]);
    expect(pool.stats().endpoints.map((e) => e.ok)).toEqual([false, false, true]);
  });

  it("throws UpstreamError 429 when every endpoint is blocked or disabled", async () => {
    const net = fakeNet({ [A]: always(RATE_LIMITED), [B]: always(RATE_LIMITED) });
    const clock = { now: T0 };
    const { pool } = makePool(net, [A, B], clock);
    await pool.fetch(A, rpcInit("eth_blockNumber"));
    await expect(pool.fetch(A, rpcInit("eth_blockNumber"))).rejects.toMatchObject({ status: 429 });
    await expect(pool.fetch(A, rpcInit("eth_blockNumber"))).rejects.toBeInstanceOf(UpstreamError);
  });

  it("passes a URL outside the pool straight through to the underlying fetch", async () => {
    const other = "https://rpc.example.test";
    const net = fakeNet({ [A]: always(ok("0x1")), [other]: (method) => ok(`echo:${method}`) });
    const { pool } = makePool(net, [A], { now: T0 });
    const response = await pool.fetch(other, rpcInit("eth_getCode"));
    expect(await response.json()).toMatchObject({ result: "echo:eth_getCode" });
    expect(net.seen).toEqual([{ url: other, method: "eth_getCode", userAgent: null, batch: false }]);
    expect(pool.stats().endpoints[0].calls).toBe(0);
  });
});

describe("EndpointPool backoff", () => {
  it("expires the block after 20 s, doubles it per consecutive 429 up to 2 min, and resets on success", async () => {
    const net = fakeNet({ [A]: script([RATE_LIMITED, RATE_LIMITED, ok("0xa"), RATE_LIMITED]) });
    const clock = { now: T0 };
    const { pool } = makePool(net, [A], clock);
    const blockedUntil = () => pool.stats().endpoints[0].blockedUntil;
    const sent = () => net.methods(A).filter((m) => m === "eth_blockNumber").length;
    await expect(pool.fetch(A, rpcInit("eth_blockNumber"))).resolves.toHaveProperty("status", 429);
    expect(blockedUntil()).toBe(new Date(T0 + ENDPOINT_BACKOFF_MS).toISOString());
    clock.now += ENDPOINT_BACKOFF_MS - 1;
    await expect(pool.fetch(A, rpcInit("eth_blockNumber"))).rejects.toMatchObject({ status: 429 });
    expect(sent()).toBe(1); // still blocked: nothing sent
    clock.now += 1;
    await expect(pool.fetch(A, rpcInit("eth_blockNumber"))).resolves.toHaveProperty("status", 429);
    expect(sent()).toBe(2);
    expect(blockedUntil()).toBe(new Date(clock.now + 2 * ENDPOINT_BACKOFF_MS).toISOString());
    clock.now += 2 * ENDPOINT_BACKOFF_MS;
    await expect(pool.fetch(A, rpcInit("eth_blockNumber"))).resolves.toHaveProperty("status", 200);
    expect(blockedUntil()).toBeNull();
    await expect(pool.fetch(A, rpcInit("eth_blockNumber"))).resolves.toHaveProperty("status", 429);
    // the success reset the doubling: back to the base block
    expect(blockedUntil()).toBe(new Date(clock.now + ENDPOINT_BACKOFF_MS).toISOString());
    expect(pool.stats().endpoints[0].rateLimited).toBe(3);
  });

  it("caps the doubling at ENDPOINT_BACKOFF_MAX_MS", async () => {
    const net = fakeNet({ [A]: always(RATE_LIMITED) });
    const clock = { now: T0 };
    const { pool } = makePool(net, [A], clock);
    let expected = ENDPOINT_BACKOFF_MS;
    for (let i = 0; i < 6; i += 1) {
      await pool.fetch(A, rpcInit("eth_blockNumber"));
      const blockedUntil = Date.parse(pool.stats().endpoints[0].blockedUntil ?? "");
      expect(blockedUntil - clock.now).toBe(expected);
      clock.now = blockedUntil;
      expected = Math.min(expected * 2, ENDPOINT_BACKOFF_MAX_MS);
    }
    expect(expected).toBe(ENDPOINT_BACKOFF_MAX_MS);
  });

  it("treats a 5xx like a 429 for blocking but counts it as a failure, and a thrown fetch error the same way", async () => {
    const net = fakeNet({ [A]: always({ status: 502, text: "bad gateway" }), [B]: always(ok("0xb")) });
    const clock = { now: T0 };
    const { pool } = makePool(net, [A, B], clock);
    const response = await pool.fetch(A, rpcInit("eth_blockNumber"));
    expect(response.status).toBe(200);
    expect(pool.stats().endpoints[0]).toMatchObject({ ok: false, failures: 1, rateLimited: 0, lastError: "upstream returned 502" });

    const throwing = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === A && String(init?.body).includes("eth_blockNumber")) throw new Error("socket hang up");
      return net.fetchImpl(input, init);
    });
    const second = new EndpointPool({ urls: [A, B], fetchImpl: throwing as unknown as typeof fetch, now: () => clock.now, log: vi.fn() });
    const served = await second.fetch(A, rpcInit("eth_blockNumber"));
    expect(await served.json()).toMatchObject({ result: "0xb" });
    expect(second.stats().endpoints[0]).toMatchObject({ ok: false, failures: 1, lastError: "socket hang up" });
  });
});

describe("EndpointPool chain-id gate", () => {
  it("disables an endpoint whose eth_chainId is not 4663 with a logged reason and never sends it traffic", async () => {
    const net = fakeNet({
      [A]: (method) => (method === "eth_chainId" ? ok("0x1") : ok("0xa")),
      [B]: always(ok("0xb"))
    });
    const clock = { now: T0 };
    const { pool, log } = makePool(net, [A, B], clock);
    const response = await pool.fetch(A, rpcInit("eth_blockNumber"));
    expect(await response.json()).toMatchObject({ result: "0xb" });
    expect(net.methods(A)).toEqual(["eth_chainId"]);
    expect(log).toHaveBeenCalledWith(`robinhood rpc pool: disabled ${A} (eth_chainId 1 != ${ROBINHOOD_CHAIN_ID})`);
    await pool.fetch(A, rpcInit("eth_blockNumber"));
    expect(net.methods(A)).toEqual(["eth_chainId"]);
    expect(pool.stats().endpoints[0]).toMatchObject({ enabled: false, ok: false, chainVerified: false, disabledReason: "eth_chainId 1 != 4663", calls: 0 });
    expect(pool.stats().endpoints[1]).toMatchObject({ enabled: true, chainVerified: true });
  });

  it("blocks (not disables) an endpoint whose chain check fails transiently and re-checks after the backoff", async () => {
    const chainReplies: Reply[] = [{ status: 503, text: "warming up" }];
    const net = fakeNet({ [A]: (method) => (method === "eth_chainId" ? chainReplies.shift() ?? CHAIN_OK : ok("0xa")) });
    const clock = { now: T0 };
    const { pool } = makePool(net, [A], clock);
    await expect(pool.fetch(A, rpcInit("eth_blockNumber"))).rejects.toMatchObject({ status: 429 });
    expect(pool.stats().endpoints[0]).toMatchObject({ enabled: true, ok: false, chainVerified: false, lastError: "eth_chainId: upstream returned 503" });
    expect(net.methods(A)).toEqual(["eth_chainId"]);
    clock.now += ENDPOINT_BACKOFF_MS;
    const response = await pool.fetch(A, rpcInit("eth_blockNumber"));
    expect(await response.json()).toMatchObject({ result: "0xa" });
    expect(net.methods(A)).toEqual(["eth_chainId", "eth_chainId", "eth_blockNumber"]);
    expect(pool.stats().endpoints[0]).toMatchObject({ chainVerified: true, ok: true });
  });
});

describe("EndpointPool lanes", () => {
  it("classifies eth_getLogs (single or batched) as the logs lane", () => {
    expect(shapeOf(JSON.stringify({ method: "eth_blockNumber", params: [] })).lane).toBe("other");
    expect(shapeOf(JSON.stringify({ method: "eth_getLogs", params: [{}] })).lane).toBe("logs");
    expect(shapeOf(JSON.stringify([{ method: "eth_blockNumber" }, { method: "eth_getLogs" }])).lane).toBe("logs");
    expect(shapeOf(JSON.stringify([{ method: "eth_blockNumber" }])).lane).toBe("other");
    expect(shapeOf(undefined).lane).toBe("other");
    expect(shapeOf("not json").lane).toBe("other");
  });

  it("never sends eth_getLogs to a measured head-only host while still using it for eth_blockNumber", async () => {
    expect(NO_LOGS_HOSTS.has("robinhood-rpc.publicnode.com")).toBe(true);
    const net = fakeNet({ [A]: always(ok("0xa")), [C]: always(ok("0xc")) });
    const clock = { now: T0 };
    const { pool } = makePool(net, [A, C], clock);
    const head = await pool.fetch(A, rpcInit("eth_blockNumber"));
    expect(await head.json()).toMatchObject({ result: "0xa" });
    const batch: RequestInit = { method: "POST", body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }, { jsonrpc: "2.0", id: 2, method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2" }] }]) };
    const logs = await pool.fetch(A, batch);
    expect(await logs.json()).toMatchObject({ result: "0xc" });
    expect(net.methods(A)).toEqual(["eth_chainId", "eth_blockNumber"]);
    expect(net.methods(C)).toEqual(["eth_chainId", "eth_blockNumber+eth_getLogs"]);
    expect(pool.stats().endpoints.map((e) => e.logs)).toEqual([false, true]);
  });

  it("learns that an endpoint refuses logs from a 403 on a logs request and fails over", async () => {
    const own = "https://my-node.example.test/rpc";
    const net = fakeNet({
      [own]: (method) => (method === "eth_chainId" ? CHAIN_OK : method === "eth_getLogs" ? { status: 403, text: "archive requests require a token" } : ok("0xown")),
      [C]: always(ok("0xc"))
    });
    const clock = { now: T0 };
    const { pool } = makePool(net, [own, C], clock);
    const response = await pool.fetch(own, rpcInit("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }]));
    expect(await response.json()).toMatchObject({ result: "0xc" });
    expect(pool.stats().endpoints[0]).toMatchObject({ logs: false, ok: false, failures: 1, lastError: "upstream returned 403" });
    clock.now += ENDPOINT_BACKOFF_MS;
    await pool.fetch(own, rpcInit("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }]));
    expect(net.methods(own).filter((m) => m === "eth_getLogs")).toHaveLength(1);
    // once the block expires it is eligible for the head lane again, still marked logs-incapable
    expect(pool.stats().endpoints[0]).toMatchObject({ ok: true, logs: false, enabled: true });
  });
});

describe("EndpointPool recovery", () => {
  it("re-probes a 403-suspended host for logs after LOGS_FORBIDDEN_RETRY_MS instead of dropping it for the process", async () => {
    const own = "https://my-node.example.test/rpc";
    let forbid = true;
    const net = fakeNet({
      [own]: (method) => (method === "eth_chainId" ? CHAIN_OK : method === "eth_getLogs" && forbid ? { status: 403, text: "edge blip" } : ok("0xown")),
      [C]: always(ok("0xc"))
    });
    const clock = { now: T0 };
    const { pool, log } = makePool(net, [own, C], clock);
    const logs = rpcInit("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }]);
    await pool.fetch(own, logs);
    expect(pool.stats().endpoints[0].logs).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("403 to eth_getLogs"));
    clock.now += LOGS_FORBIDDEN_RETRY_MS - 1;
    await pool.fetch(own, logs);
    expect(net.methods(own).filter((m) => m === "eth_getLogs")).toHaveLength(1);
    expect(pool.laneFreeAt("logs")).toBe(0); // C is free
    forbid = false;
    clock.now += 1;
    expect(pool.stats().endpoints[0].logs).toBe(true);
    const served = await pool.fetch(own, logs);
    expect(await served.json()).toMatchObject({ result: "0xown" });
    expect(net.methods(own).filter((m) => m === "eth_getLogs")).toHaveLength(2);
  });

  it("reports when a lane frees from a 403 suspension, not only from a backoff block", async () => {
    const own = "https://my-node.example.test/rpc";
    const net = fakeNet({ [own]: (method) => (method === "eth_chainId" ? CHAIN_OK : { status: 403, text: "no" }) });
    const clock = { now: T0 };
    const { pool } = makePool(net, [own], clock);
    await pool.fetch(own, rpcInit("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }]));
    expect(pool.laneFreeAt("logs")).toBe(T0 + LOGS_FORBIDDEN_RETRY_MS);
    expect(pool.laneFreeAt("other")).toBe(T0 + ENDPOINT_BACKOFF_MS);
  });

  it("spreads a same-tick fan-out over the pool by requests in flight instead of piling every call on one endpoint", async () => {
    const clock = { now: T0 };
    const gates: Array<() => void> = [];
    const slowNet = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(init?.body).includes("eth_chainId")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), { status: 200 });
      await new Promise<void>((resolve) => gates.push(resolve));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: String(input) }), { status: 200 });
    });
    const pool = new EndpointPool({ urls: [A, B, C], fetchImpl: slowNet as unknown as typeof fetch, now: () => clock.now, log: vi.fn() });
    // nothing verified yet: the reservation is taken before the chain check, so the fan-out still spreads
    const fanOut = Promise.all(Array.from({ length: 6 }, () => pool.fetch(A, rpcInit("eth_blockNumber"))));
    await vi.waitFor(() => expect(gates).toHaveLength(6));
    expect(pool.stats().endpoints.map((e) => e.calls)).toEqual([2, 2, 2]);
    gates.splice(0).forEach((open) => open());
    await fanOut;
    // settled: a later single call ranks on index order again, so all reservations were released
    const single = pool.fetch(A, rpcInit("eth_blockNumber"));
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(pool.stats().endpoints.map((e) => e.calls)).toEqual([3, 2, 2]);
    gates.shift()?.();
    await single;
  });

  it("stops counting a failure streak against an endpoint after FAIL_STREAK_DECAY_MS and restarts its backoff from the base", async () => {
    const clock = { now: T0 };
    let failB = true;
    const net = fakeNet({
      [A]: always(ok("0xa")),
      [B]: (method) => (method === "eth_chainId" ? CHAIN_OK : failB ? { status: 503, text: "boom" } : ok("0xb"))
    });
    const { pool } = makePool(net, [B, A], clock); // B first in configured order
    const blockNumbersAt = (url: string) => net.methods(url).filter((m) => m === "eth_blockNumber").length;
    await pool.fetch(B, rpcInit("eth_blockNumber")); // B 503s (streak 1, blocked 20 s, next backoff 40 s), A serves the failover
    failB = false;
    clock.now += ENDPOINT_BACKOFF_MS;
    await pool.fetch(B, rpcInit("eth_blockNumber"));
    expect(blockNumbersAt(B)).toBe(1); // unblocked but its recent streak still ranks it behind clean A
    clock.now += FAIL_STREAK_DECAY_MS;
    await pool.fetch(B, rpcInit("eth_blockNumber"));
    expect(blockNumbersAt(B)).toBe(2); // decayed: ties A on streak and wins on configured order again
    failB = true;
    const blocked = await pool.fetch(B, rpcInit("eth_blockNumber"));
    expect(await blocked.json()).toMatchObject({ result: "0xa" });
    // the block after a decayed streak starts from the base backoff, not from the 40 s the old streak had reached
    expect(pool.stats().endpoints[0].blockedUntil).toBe(new Date(clock.now + ENDPOINT_BACKOFF_MS).toISOString());
  });
});

describe("EndpointPool stats", () => {
  it("reports url, ok, blockedUntil, calls, rateLimited, failures and p50 latency per endpoint", async () => {
    const clock = { now: T0 };
    const latencies = [300, 100, 200];
    const slow = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const chainCheck = String(init?.body).includes("eth_chainId");
      if (!chainCheck) clock.now += latencies.shift() ?? 0;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: chainCheck ? "0x1237" : "0x1" }), { status: 200 });
    });
    const pool = new EndpointPool({ urls: [A], fetchImpl: slow as unknown as typeof fetch, now: () => clock.now, log: vi.fn() });
    for (let i = 0; i < 3; i += 1) await pool.fetch(A, rpcInit("eth_blockNumber"));
    const stats = pool.stats();
    expect(stats.chainId).toBe(ROBINHOOD_CHAIN_ID);
    expect(stats.endpoints).toHaveLength(1);
    expect(stats.endpoints[0]).toEqual({
      url: A,
      ok: true,
      enabled: true,
      disabledReason: null,
      chainVerified: true,
      logs: false,
      blockedUntil: null,
      calls: 3,
      rateLimited: 0,
      failures: 0,
      p50Ms: 200,
      lastError: null
    });
    const untouched = new EndpointPool({ urls: [A, B], fetchImpl: slow as unknown as typeof fetch, now: () => clock.now, log: vi.fn() });
    expect(untouched.stats().endpoints[1]).toMatchObject({ url: B, ok: true, calls: 0, p50Ms: null, chainVerified: false, logs: true });
  });

  it("prefers an endpoint with no failure streak, then the lower p50, then configured order", async () => {
    const clock = { now: T0 };
    const paced = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const chainCheck = String(init?.body).includes("eth_chainId");
      if (!chainCheck) clock.now += String(input) === A ? 300 : 100;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: chainCheck ? "0x1237" : "0x1" }), { status: 200 });
    });
    const pool = new EndpointPool({ urls: [A, B], fetchImpl: paced as unknown as typeof fetch, now: () => clock.now, log: vi.fn() });
    for (let i = 0; i < 4; i += 1) await pool.fetch(A, rpcInit("eth_blockNumber"));
    // A (first in order, p50 unknown) is tried first, then B (p50 unknown beats 300), then B keeps winning on p50 100 < 300
    expect(pool.stats().endpoints.map((e) => e.calls)).toEqual([1, 3]);
  });

  it("ranks a reliably slow endpoint (p50 above SLOW_P50_MS) behind a faster one that has failed once", async () => {
    const clock = { now: T0 };
    let failB = false;
    const paced = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const chainCheck = String(init?.body).includes("eth_chainId");
      if (chainCheck) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), { status: 200 });
      if (String(input) === B && failB) return new Response("boom", { status: 503 });
      clock.now += String(input) === A ? SLOW_P50_MS + 4_000 : 150;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 });
    });
    const pool = new EndpointPool({ urls: [A, B], fetchImpl: paced as unknown as typeof fetch, now: () => clock.now, log: vi.fn() });
    for (let i = 0; i < 3; i += 1) await pool.fetch(A, rpcInit("eth_blockNumber"));
    // A answers in 8 s, B in 150 ms: after the first probe of each, B wins on p50
    expect(pool.stats().endpoints.map((e) => e.calls)).toEqual([1, 2]);
    failB = true;
    await pool.fetch(A, rpcInit("eth_blockNumber")); // B 503s (failStreak 1, blocked), A serves the failover
    failB = false;
    clock.now += ENDPOINT_BACKOFF_MS;
    await pool.fetch(A, rpcInit("eth_blockNumber"));
    // B is unblocked with failStreak 1; the pre-R6 sort (failStreak first) would send this to slow A, the slow tier sends it to B
    expect(pool.stats().endpoints.map((e) => e.calls)).toEqual([2, 4]);
    expect(pool.stats().endpoints[0].p50Ms).toBeGreaterThan(SLOW_P50_MS);
  });

  it("counts a caller abort (timeout) as that endpoint's failure and blocks it, so the next call fails over", async () => {
    const clock = { now: T0 };
    const hanging = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const chainCheck = String(init?.body).includes("eth_chainId");
      if (chainCheck) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), { status: 200 });
      if (String(input) === A) {
        clock.now += 15_000;
        const controller = init?.signal as AbortSignal | undefined;
        Object.defineProperty(controller, "aborted", { value: true, configurable: true });
        throw new Error("This operation was aborted");
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 });
    });
    const log = vi.fn();
    const pool = new EndpointPool({ urls: [A, B], fetchImpl: hanging as unknown as typeof fetch, now: () => clock.now, log });
    const controller = new AbortController();
    await expect(pool.fetch(A, { ...rpcInit("eth_blockNumber"), signal: controller.signal })).rejects.toThrow(/aborted/);
    const a = pool.stats().endpoints[0];
    expect(a).toMatchObject({ ok: false, failures: 1, lastError: "no answer within 15000 ms (caller aborted)" });
    expect(a.blockedUntil).toBe(new Date(clock.now + ENDPOINT_BACKOFF_MS).toISOString());
    const next = await pool.fetch(A, rpcInit("eth_blockNumber"));
    expect(next.status).toBe(200);
    expect(pool.stats().endpoints.map((e) => e.calls)).toEqual([1, 1]);
  });

  it("dedupes member URLs that differ only by a trailing slash and answers has() for either form", () => {
    const pool = new EndpointPool({ urls: [`${A}/`, A, B], fetchImpl: vi.fn() as unknown as typeof fetch, log: vi.fn() });
    expect(pool.urls()).toEqual([`${A}/`, B]);
    expect(pool.has(A)).toBe(true);
    expect(pool.has(`${B}/`)).toBe(true);
    expect(pool.has("https://rpc.example.test")).toBe(false);
  });
});

const hex = (n: number) => `0x${n.toString(16)}`;
const logsInit = (from: number, to: number): RequestInit => rpcInit("eth_getLogs", [{ fromBlock: hex(from), toBlock: hex(to), address: [] }]);
/** A poller tick: eth_blockNumber and eth_getLogs in one batch, toBlock = cursor + 400 before the head is known. */
const tickInit = (cursor: number): RequestInit => ({
  method: "POST",
  body: JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
    { jsonrpc: "2.0", id: 2, method: "eth_getLogs", params: [{ fromBlock: hex(cursor - 5), toBlock: hex(cursor + 400) }] }
  ])
});
const getLogsCalls = (net: ReturnType<typeof fakeNet>, url: string) => net.methods(url).filter((m) => m.includes("eth_getLogs"));

describe("EndpointPool logs routing by request shape", () => {
  it("reads lane, widest block span and the speculative-toBlock flag from a body", () => {
    expect(shapeOf(JSON.stringify({ method: "eth_blockNumber", params: [] }))).toEqual({ lane: "other", range: 0, speculative: false });
    expect(shapeOf(String(logsInit(1, 500_000).body))).toEqual({ lane: "logs", range: 500_000, speculative: false });
    expect(shapeOf(String(tickInit(1_000).body))).toEqual({ lane: "logs", range: 406, speculative: true });
    expect(shapeOf(JSON.stringify({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "latest" }] }))).toEqual({ lane: "logs", range: 0, speculative: false });
    expect(shapeOf("not json")).toEqual({ lane: "other", range: 0, speculative: false });
  });

  it("sends a backfill span to the largest-range endpoint and never to a host whose cap it exceeds", async () => {
    expect(LOGS_RANGE_CAPS.get("rpc-robinhood.blockmachine.io")).toBe(9_999);
    const net = fakeNet({ [A]: always(ok("0xa")), [B]: always(ok("0xb")), [C]: always(ok("0xc")) });
    const clock = { now: T0 };
    const { pool } = makePool(net, [A, B, C], clock);
    const response = await pool.fetch(A, logsInit(1, 500_000));
    expect(await response.json()).toMatchObject({ result: "0xc" });
    expect(getLogsCalls(net, B)).toEqual([]);
    // official 429s: blockmachine cannot serve 500k blocks, so the caller gets the 429 back instead of a doomed -32602 detour
    const netBlocked = fakeNet({ [A]: always(ok("0xa")), [B]: always(ok("0xb")), [C]: always(RATE_LIMITED) });
    const { pool: blocked } = makePool(netBlocked, [A, B, C], clock);
    const refused = await blocked.fetch(A, logsInit(1, 500_000));
    expect(refused.status).toBe(429);
    expect(getLogsCalls(netBlocked, B)).toEqual([]);
  });

  it("sends a small single eth_getLogs (top-up, shrunk chunk) to the smallest-cap endpoint that fits, keeping the largest for ticks and backfills", async () => {
    const net = fakeNet({ [A]: always(ok("0xa")), [B]: always(ok("0xb")), [C]: always(ok("0xc")) });
    const clock = { now: T0 };
    const { pool } = makePool(net, [A, B, C], clock);
    const small = await pool.fetch(A, logsInit(1_000, 1_405));
    expect(await small.json()).toMatchObject({ result: "0xb" });
    const atThreshold = await pool.fetch(A, logsInit(1, 2_000));
    expect(await atThreshold.json()).toMatchObject({ result: "0xb" });
    // 9,999 blocks fit blockmachine's cap but exceed the backfill threshold: a backfill span goes to the largest range first
    const wide = await pool.fetch(A, logsInit(1, 9_999));
    expect(await wide.json()).toMatchObject({ result: "0xc" });
    const overCap = await pool.fetch(A, logsInit(1, 10_000));
    expect(await overCap.json()).toMatchObject({ result: "0xc" });
    expect(getLogsCalls(net, B)).toHaveLength(2);
    expect(getLogsCalls(net, C)).toHaveLength(2);
  });

  it("never sends a batched tick (speculative toBlock) to blockmachine, so one 429 on the tick endpoint does not also stall small getLogs there", async () => {
    expect(NO_SPECULATIVE_TOBLOCK_HOSTS.has("rpc-robinhood.blockmachine.io")).toBe(true);
    const net = fakeNet({ [A]: always(ok("0xa")), [B]: always(ok("0xb")), [C]: always(ok("0xc")) });
    const clock = { now: T0 };
    const { pool } = makePool(net, [A, B, C], clock);
    const tick = await pool.fetch(A, tickInit(1_000));
    expect(await tick.json()).toMatchObject({ result: "0xc" });
    expect(getLogsCalls(net, B)).toEqual([]);
    expect(getLogsCalls(net, C)).toEqual(["eth_blockNumber+eth_getLogs"]);
    // the pool is not consulted for the head-only host either way
    expect(getLogsCalls(net, A)).toEqual([]);
  });

  it("reports logs-lane 429s, clean answers and lane-wide blocks to the lane reporter, and nothing for the other lane", async () => {
    const reporter = { report429: vi.fn(), reportOk: vi.fn(), holdUntil: vi.fn() };
    const net = fakeNet({ [A]: always(ok("0xa")), [C]: script([RATE_LIMITED]) });
    const clock = { now: T0 };
    const pool = new EndpointPool({ urls: [A, C], fetchImpl: net.fetchImpl, now: () => clock.now, log: vi.fn(), logsLane: reporter });
    await pool.fetch(A, rpcInit("eth_blockNumber"));
    expect(reporter.reportOk).not.toHaveBeenCalled();
    const refused = await pool.fetch(A, logsInit(1, 405));
    expect(refused.status).toBe(429);
    expect(reporter.report429).toHaveBeenCalledTimes(1);
    // C was the only logs endpoint: the lane is told to hold until C's block expires
    expect(reporter.holdUntil).toHaveBeenLastCalledWith(T0 + ENDPOINT_BACKOFF_MS);
    expect(pool.laneFreeAt("logs")).toBe(T0 + ENDPOINT_BACKOFF_MS);
    expect(pool.laneFreeAt("other")).toBe(0);
    await expect(pool.fetch(A, logsInit(1, 405))).rejects.toMatchObject({ status: 429 });
    expect(reporter.holdUntil).toHaveBeenCalledTimes(2);
    clock.now += ENDPOINT_BACKOFF_MS;
    await pool.fetch(A, logsInit(1, 405));
    expect(reporter.reportOk).toHaveBeenCalledTimes(1);
    expect(reporter.report429).toHaveBeenCalledTimes(1);
  });
});
