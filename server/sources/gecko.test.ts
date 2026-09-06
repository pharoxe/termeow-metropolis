import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpstreamError } from "../lib/http";
import {
  GECKO_BUCKET_LIMIT,
  GECKO_BUCKET_WINDOW_MS,
  GECKO_MAX_WAIT_MS,
  geckoGet,
  geckoPoolTrades,
  geckoTokenPools,
  isGeckoBlocked,
  normalizeGeckoTrade,
  resetGeckoBackoff,
  resetGeckoBucket
} from "./gecko";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function settle(promise: Promise<unknown>) {
  return promise.then(() => "resolved", (error: unknown) => error);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  resetGeckoBucket();
  resetGeckoBackoff();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("geckoGet token bucket", () => {
  it("lets the first 25 distinct calls through immediately", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));
    const calls = Array.from({ length: GECKO_BUCKET_LIMIT }, (_, index) => geckoGet(`/networks/solana/pools/P${index}/trades`));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(GECKO_BUCKET_LIMIT);
    expect(await Promise.all(calls)).toHaveLength(GECKO_BUCKET_LIMIT);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.geckoterminal.com/api/v2/networks/solana/pools/P0/trades");
  });

  it("queues the 26th call until a slot frees when the wait is under 20s", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));
    for (let index = 0; index < GECKO_BUCKET_LIMIT; index += 1) geckoGet(`/networks/solana/pools/P${index}/trades`);
    await vi.advanceTimersByTimeAsync(GECKO_BUCKET_WINDOW_MS - 15_000);
    const late = geckoGet("/networks/solana/pools/LATE/trades");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(GECKO_BUCKET_LIMIT);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(GECKO_BUCKET_LIMIT + 1);
    expect(await settle(late)).toBe("resolved");
  });

  it("rejects with 429 when the estimated wait exceeds 20s", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));
    for (let index = 0; index < GECKO_BUCKET_LIMIT; index += 1) geckoGet(`/networks/solana/pools/P${index}/trades`);
    await vi.advanceTimersByTimeAsync(GECKO_BUCKET_WINDOW_MS - GECKO_MAX_WAIT_MS - 1_000);
    const error = await settle(geckoGet("/networks/solana/pools/TOO_LATE/trades"));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(GECKO_BUCKET_LIMIT);
    expect(isGeckoBlocked()).toBe(false);
  });

  it("serves high priority ahead of queued low priority callers", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));
    for (let index = 0; index < GECKO_BUCKET_LIMIT; index += 1) geckoGet(`/networks/solana/pools/P${index}/trades`);
    await vi.advanceTimersByTimeAsync(GECKO_BUCKET_WINDOW_MS - 10_000);
    const low = geckoGet("/networks/solana/pools/LOW/trades", { priority: "low" });
    const high = geckoGet("/networks/solana/pools/HIGH/trades", { priority: "high" });
    await vi.advanceTimersByTimeAsync(10_000);
    const order = fetchMock.mock.calls.slice(GECKO_BUCKET_LIMIT).map((call) => String(call[0]));
    expect(order[0]).toContain("/HIGH/");
    expect(order[1]).toContain("/LOW/");
    expect(await settle(low)).toBe("resolved");
    expect(await settle(high)).toBe("resolved");
  });
});

describe("geckoGet 429 block", () => {
  it("blocks every call for 20s after an upstream 429 and recovers on reset", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ status: { error_code: 429 } }, 429));
    const first = await settle(geckoGet("/networks/solana/pools/A/trades"));
    expect((first as UpstreamError).status).toBe(429);
    expect(isGeckoBlocked()).toBe(true);
    const second = await settle(geckoGet("/networks/solana/pools/B/trades"));
    expect((second as UpstreamError).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resetGeckoBackoff();
    expect(isGeckoBlocked()).toBe(false);
    await settle(geckoGet("/networks/solana/pools/C/trades"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("geckoGet in-flight dedupe", () => {
  it("issues one fetch for two concurrent identical URLs and refetches after settle", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ data: [] }));
    const [a, b] = await Promise.all([
      geckoGet("/networks/solana/pools/SAME/trades"),
      geckoGet("/networks/solana/pools/SAME/trades")
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    await geckoGet("/networks/solana/pools/SAME/trades");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("geckoPoolTrades", () => {
  it("normalizes prints and keeps a null usd for non-numeric volume", async () => {
    stubFetch(() => jsonResponse({
      data: [
        { attributes: { kind: "buy", volume_in_usd: "12.5", block_timestamp: "2024-01-01T00:00:00Z", tx_hash: "TX1" } },
        { attributes: { kind: "sell", volume_in_usd: "n/a", block_timestamp: "2024-01-01T00:01:00Z", tx_hash: "TX2" } },
        { attributes: { kind: "swap", volume_in_usd: "1", block_timestamp: "2024-01-01T00:02:00Z", tx_hash: "TX3" } },
        { attributes: { kind: "buy", volume_in_usd: "1", block_timestamp: "not-a-date", tx_hash: "TX4" } }
      ]
    }));
    const prints = await geckoPoolTrades("solana", "POOL");
    expect(prints).toEqual([
      { chain: "solana", pair: "POOL", tx: "TX1", time: Date.parse("2024-01-01T00:00:00Z"), side: "buy", usd: 12.5, source: "geckoterminal" },
      { chain: "solana", pair: "POOL", tx: "TX2", time: Date.parse("2024-01-01T00:01:00Z"), side: "sell", usd: null, source: "geckoterminal" }
    ]);
  });

  it("drops rows without a tx hash", () => {
    expect(normalizeGeckoTrade({ attributes: { kind: "buy", block_timestamp: "2024-01-01T00:00:00Z" } }, "robinhood", "P")).toBeNull();
  });
});

describe("geckoTokenPools", () => {
  it("maps dex, address, reserve and 24h volume and dedupes addresses", async () => {
    const fetchMock = stubFetch(() => jsonResponse({
      data: [
        { attributes: { address: "P1", reserve_in_usd: "1000.5", volume_usd: { h24: "250" } }, relationships: { dex: { data: { id: "raydium" } } } },
        { attributes: { address: "P1", reserve_in_usd: "1", volume_usd: { h24: "1" } }, relationships: { dex: { data: { id: "raydium" } } } },
        { attributes: { address: "P2", reserve_in_usd: "x" }, relationships: {} }
      ]
    }));
    const pools = await geckoTokenPools("robinhood", "TOKEN");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/TOKEN/pools?page=1");
    expect(pools).toEqual([
      { dex: "raydium", pairAddress: "P1", liquidityUsd: 1000.5, volume24Usd: 250 },
      { dex: "", pairAddress: "P2", liquidityUsd: null, volume24Usd: null }
    ]);
  });
});
