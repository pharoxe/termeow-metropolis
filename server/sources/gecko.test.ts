import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowPrint } from "../../shared/wire";
import { UpstreamError } from "../lib/http";
import {
  GECKO_BASE_URL,
  GECKO_BUCKET_LIMIT,
  GECKO_BUCKET_WINDOW_MS,
  GECKO_MAX_WAIT_MS,
  GECKO_OHLCV_INTERVALS,
  GECKO_RESERVE_FOCUSED,
  geckoBlockedUntilMs,
  geckoGet,
  geckoPoolOhlcv,
  geckoPoolTrades,
  geckoTokenPools,
  isGeckoBlocked,
  mapGeckoOhlcv,
  normalizeGeckoTrade,
  type GeckoOhlcvInterval,
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

describe("geckoGet budget classes", () => {
  const drain = (count: number, priority?: "focused" | "discovery" | "background") =>
    Array.from({ length: count }, (_, index) => geckoGet(`/networks/solana/pools/${priority ?? "F"}${index}/trades`, priority ? { priority } : {}));

  it("serves focused before discovery before background when slots free up, whatever the arrival order", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));
    drain(GECKO_BUCKET_LIMIT);
    await vi.advanceTimersByTimeAsync(GECKO_BUCKET_WINDOW_MS - 10_000);
    const background = geckoGet("/networks/solana/pools/BG/trades", { priority: "background" });
    const discovery = geckoGet("/networks/solana/trending_pools", { priority: "discovery" });
    const low = geckoGet("/networks/solana/pools/LOW/trades", { priority: "low" });
    const focused = geckoGet("/networks/solana/pools/FOCUSED/ohlcv/minute", { priority: "focused" });
    await vi.advanceTimersByTimeAsync(10_000);
    const order = fetchMock.mock.calls.slice(GECKO_BUCKET_LIMIT).map((call) => String(call[0]));
    const marks = ["FOCUSED", "trending_pools", "/BG/", "/LOW/"];
    expect(order.map((url) => marks.find((mark) => url.includes(mark)))).toEqual(marks);
    expect(await Promise.all([background, discovery, low, focused].map(settle))).toEqual(["resolved", "resolved", "resolved", "resolved"]);
  });

  it("keeps GECKO_RESERVE_FOCUSED slots that discovery and background may not take", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));
    const shared = GECKO_BUCKET_LIMIT - GECKO_RESERVE_FOCUSED;
    drain(shared, "background");
    await vi.advanceTimersByTimeAsync(GECKO_BUCKET_WINDOW_MS - 15_000);
    expect(fetchMock).toHaveBeenCalledTimes(shared);
    const extraBackground = geckoGet("/networks/solana/pools/EXTRA_BG/trades", { priority: "background" });
    const extraDiscovery = geckoGet("/networks/solana/new_pools", { priority: "discovery" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(shared);
    drain(GECKO_RESERVE_FOCUSED, "focused");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(GECKO_BUCKET_LIMIT);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await settle(extraDiscovery)).toBe("resolved");
    expect(await settle(extraBackground)).toBe("resolved");
    expect(fetchMock).toHaveBeenCalledTimes(GECKO_BUCKET_LIMIT + 2);
  });

  it("rejects a background caller immediately when only reserved slots are left and the wait exceeds the cap", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    drain(GECKO_BUCKET_LIMIT - GECKO_RESERVE_FOCUSED, "background");
    await vi.advanceTimersByTimeAsync(0);
    const error = await settle(geckoGet("/networks/solana/pools/BG_LATE/trades", { priority: "background" }));
    expect((error as UpstreamError).status).toBe(429);
    expect(await settle(geckoGet("/networks/solana/pools/FOCUSED_OK/trades"))).toBe("resolved");
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
    expect(geckoBlockedUntilMs()).toBe(Date.now() + 20_000);
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

type GeckoTradeFixture = { data: Array<{ attributes: Record<string, string | number> }> };
const ansemTrades: GeckoTradeFixture = JSON.parse(readFileSync(new URL("./__fixtures__/gecko-pool-trades-solana-ansem.json", import.meta.url), "utf8"));
const ANSEM = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const ANSEM_POOL = "FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC";

describe("geckoPoolTrades", () => {
  it("normalizes prints and keeps a null usd for non-numeric volume; price only when usd and the base leg are known", async () => {
    stubFetch(() => jsonResponse({
      data: [
        { attributes: { kind: "buy", volume_in_usd: "12.5", block_timestamp: "2024-01-01T00:00:00Z", tx_hash: "TX1", from_token_amount: "0.1", to_token_amount: "50" } },
        { attributes: { kind: "sell", volume_in_usd: "n/a", block_timestamp: "2024-01-01T00:01:00Z", tx_hash: "TX2", from_token_amount: "50", to_token_amount: "0.1" } },
        { attributes: { kind: "swap", volume_in_usd: "1", block_timestamp: "2024-01-01T00:02:00Z", tx_hash: "TX3" } },
        { attributes: { kind: "buy", volume_in_usd: "1", block_timestamp: "not-a-date", tx_hash: "TX4" } }
      ]
    }));
    const prints = await geckoPoolTrades("solana", "POOL");
    expect(prints).toEqual([
      { chain: "solana", pair: "POOL", tx: "TX1", time: Date.parse("2024-01-01T00:00:00Z"), side: "buy", usd: 12.5, source: "geckoterminal", price: 0.25 },
      { chain: "solana", pair: "POOL", tx: "TX2", time: Date.parse("2024-01-01T00:01:00Z"), side: "sell", usd: null, source: "geckoterminal" }
    ]);
  });

  it("prices the measured ANSEM/SOL trades page to Gecko's own per-token USD price (to_token on buys, from_token on sells)", () => {
    expect(ansemTrades.data.length).toBeGreaterThanOrEqual(12);
    expect(new Set(ansemTrades.data.map((row) => row.attributes.kind))).toEqual(new Set(["buy", "sell"]));
    for (const row of ansemTrades.data) {
      const print = normalizeGeckoTrade(row, "solana", ANSEM_POOL);
      expect(print).not.toBeNull();
      const attrs = row.attributes;
      const baseIsTo = attrs.kind === "buy";
      expect(baseIsTo ? attrs.to_token_address : attrs.from_token_address).toBe(ANSEM);
      const geckoPrice = Number(baseIsTo ? attrs.price_to_in_usd : attrs.price_from_in_usd);
      expect(print?.usd).toBeCloseTo(Number(attrs.volume_in_usd), 9);
      expect((print?.price as number) / geckoPrice).toBeCloseTo(1, 6);
    }
  });

  it("orients side and price to the focused token when it is the pool's quote leg, and drops rows that never name it", () => {
    const SOL = "So11111111111111111111111111111111111111112";
    for (const row of ansemTrades.data) {
      const attrs = row.attributes;
      const asAnsem = normalizeGeckoTrade(row, "solana", ANSEM_POOL, ANSEM) as FlowPrint;
      const asSol = normalizeGeckoTrade(row, "solana", ANSEM_POOL, SOL) as FlowPrint;
      expect(asAnsem.side).toBe(attrs.kind);
      expect(asSol.side).toBe(attrs.kind === "buy" ? "sell" : "buy");
      const solPrice = Number(attrs.kind === "buy" ? attrs.price_from_in_usd : attrs.price_to_in_usd);
      expect((asSol.price as number) / solPrice).toBeCloseTo(1, 6);
      expect(normalizeGeckoTrade(row, "solana", ANSEM_POOL, "OtherMint111111111111111111111111111111111")).toBeNull();
    }
    const evm = { attributes: { kind: "buy", volume_in_usd: "10", block_timestamp: "2024-01-01T00:00:00Z", tx_hash: "T", from_token_address: "0xAAAA", to_token_address: "0xBBBB", from_token_amount: "5", to_token_amount: "40" } };
    expect(normalizeGeckoTrade(evm, "robinhood", "P", "0xaaaa")).toMatchObject({ side: "sell", price: 2 });
  });

  it("omits price when the base leg amount is missing, zero or unparseable", () => {
    const base = { kind: "sell", volume_in_usd: "10", block_timestamp: "2024-01-01T00:00:00Z", tx_hash: "T" };
    expect("price" in (normalizeGeckoTrade({ attributes: base }, "robinhood", "P") ?? {})).toBe(false);
    expect("price" in (normalizeGeckoTrade({ attributes: { ...base, from_token_amount: "0" } }, "robinhood", "P") ?? {})).toBe(false);
    expect("price" in (normalizeGeckoTrade({ attributes: { ...base, from_token_amount: "abc" } }, "robinhood", "P") ?? {})).toBe(false);
    expect(normalizeGeckoTrade({ attributes: { ...base, from_token_amount: "40" } }, "robinhood", "P")?.price).toBe(0.25);
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

describe("geckoPoolOhlcv", () => {
  it("maps ohlcv_list rows to ms candles, ascending and deduped by time, dropping non-finite rows", async () => {
    const fetchMock = stubFetch(() => jsonResponse({
      data: { attributes: { ohlcv_list: [
        [1_700_000_600, "1.5", "2", "1", "1.8", "300"],
        [1_700_000_300, 1, 1.6, 0.9, 1.5, 100],
        [1_700_000_300, 1.1, 1.6, 0.9, 1.5, 120],
        [1_700_000_000, 1, 1, 1, "n/a", 10],
        "garbage"
      ] } }
    }));
    const candles = await geckoPoolOhlcv("robinhood", "0xpool", "5m");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.geckoterminal.com/api/v2/networks/robinhood/pools/0xpool/ohlcv/minute?aggregate=5&limit=1000");
    expect(candles).toEqual([
      { time: 1_700_000_300_000, open: 1.1, high: 1.6, low: 0.9, close: 1.5, volume: 120 },
      { time: 1_700_000_600_000, open: 1.5, high: 2, low: 1, close: 1.8, volume: 300 }
    ]);
  });

  it("maps every interval to the unit/aggregate pair the Solana path uses and forwards limit + before_timestamp", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ data: { attributes: { ohlcv_list: [] } } }));
    const expected: Record<GeckoOhlcvInterval, string> = {
      "1m": "minute?aggregate=1", "5m": "minute?aggregate=5", "15m": "minute?aggregate=15",
      "1h": "hour?aggregate=1", "4h": "hour?aggregate=4", "1d": "day?aggregate=1"
    };
    for (const interval of GECKO_OHLCV_INTERVALS) {
      await geckoPoolOhlcv("solana", `P-${interval}`, interval, { limit: 50, beforeTs: 1_700_000_000.9 });
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(`${GECKO_BASE_URL}/networks/solana/pools/P-${interval}/ohlcv/${expected[interval]}&limit=50&before_timestamp=1700000000`);
    }
  });

  it("clamps limit into 1..1000 and returns [] for a body without ohlcv_list", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ data: {} }));
    expect(await geckoPoolOhlcv("robinhood", "P", "1h", { limit: 5000 })).toEqual([]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("limit=1000");
    expect(mapGeckoOhlcv(undefined)).toEqual([]);
  });
});
