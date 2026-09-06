import { afterEach, describe, expect, it, vi } from "vitest";
import { jupiterPriceUrl, parseJupiterPrices, QuotePriceCache, SOL_MINT, STALE_MAX_MS, USDC_MINT, USDT_MINT } from "./price";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const T0 = Date.parse("2026-09-06T08:00:00.000Z");
const MIN = 60_000;

function jupBody(prices: Record<string, number>) {
  return Object.fromEntries(Object.entries(prices).map(([mint, usdPrice]) => [mint, { usdPrice, decimals: 6, blockId: 1 }]));
}

function clock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function cacheWith(prices: Record<string, number>, opts: { ttlMs?: number; now?: () => number } = {}) {
  const fetchImpl = vi.fn(async (_url: string) => jupBody(prices));
  const cache = new QuotePriceCache({ ...opts, fetchImpl });
  return { cache, fetchImpl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("QuotePriceCache stable mints", () => {
  it("returns 1 for USDC and USDT without any fetch", async () => {
    const fetchImpl = vi.fn(async () => ({}));
    const cache = new QuotePriceCache({ fetchImpl });
    await cache.prime([USDC_MINT, USDT_MINT]);
    expect(cache.get(USDC_MINT)).toBe(1);
    expect(cache.get(USDT_MINT)).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honours a custom stableMints list", () => {
    const cache = new QuotePriceCache({ stableMints: ["X"], fetchImpl: vi.fn(async () => ({})) });
    expect(cache.get("X")).toBe(1);
    expect(cache.get(USDC_MINT)).toBeNull();
  });
});

describe("QuotePriceCache prime", () => {
  it("batches all unknown ids into one Jupiter v3 URL", async () => {
    const { cache, fetchImpl } = cacheWith({ [SOL_MINT]: 200, [BONK]: 0.00002 }, { now: () => T0 });
    await cache.prime([SOL_MINT, BONK, SOL_MINT, USDC_MINT]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe("https://lite-api.jup.ag/price/v3");
    expect(url.searchParams.get("ids")).toBe(`${SOL_MINT},${BONK}`);
    expect(cache.get(SOL_MINT)).toBe(200);
    expect(cache.get(BONK)).toBe(0.00002);
    expect(cache.status()).toEqual({ cached: 2, lastOkAt: T0, lastError: null });
  });

  it("uses the global fetch via fetchJson when no fetchImpl is given", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(jupBody({ [SOL_MINT]: 150 })), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new QuotePriceCache();
    await cache.prime([SOL_MINT]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(jupiterPriceUrl([SOL_MINT]));
    expect(cache.get(SOL_MINT)).toBe(150);
  });

  it("skips the fetch entirely when every mint is fresh or stable", async () => {
    const { cache, fetchImpl } = cacheWith({ [SOL_MINT]: 200 });
    await cache.prime([SOL_MINT]);
    await cache.prime([SOL_MINT, USDC_MINT]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("coalesces overlapping primes for the same mint into the request already in flight", async () => {
    const pending = new Map<string, (body: unknown) => void>();
    const fetchImpl = vi.fn((url: string) => new Promise<unknown>((resolve) => pending.set(url, resolve)));
    const cache = new QuotePriceCache({ fetchImpl, now: () => T0 });
    const first = cache.prime([SOL_MINT]);
    const second = cache.prime([SOL_MINT, BONK]);
    const third = cache.prime([SOL_MINT]);
    expect(fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams.get("ids"))).toEqual([SOL_MINT, BONK]);
    pending.get(jupiterPriceUrl([SOL_MINT]))?.(jupBody({ [SOL_MINT]: 200 }));
    await Promise.all([first, third]);
    expect(cache.get(SOL_MINT)).toBe(200);
    expect(cache.get(BONK)).toBeNull();
    pending.get(jupiterPriceUrl([BONK]))?.(jupBody({ [BONK]: 0.5 }));
    await second;
    expect(cache.get(BONK)).toBe(0.5);
    await cache.prime([SOL_MINT, BONK]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("QuotePriceCache ttl", () => {
  it("hits the cache within ttl and refetches after it", async () => {
    const c = clock();
    const { cache, fetchImpl } = cacheWith({ [SOL_MINT]: 200 }, { ttlMs: 30_000, now: c.now });
    await cache.prime([SOL_MINT]);
    c.advance(29_000);
    await cache.prime([SOL_MINT]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    c.advance(2_000);
    await cache.prime([SOL_MINT]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cache.status().lastOkAt).toBe(T0 + 31_000);
  });
});

describe("QuotePriceCache failure", () => {
  it("keeps the last good price within 5 minutes, then returns null", async () => {
    const c = clock();
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error("jup 503");
      return jupBody({ [SOL_MINT]: 200 });
    });
    const cache = new QuotePriceCache({ ttlMs: 30_000, now: c.now, fetchImpl });
    await cache.prime([SOL_MINT]);
    fail = true;
    c.advance(MIN);
    await expect(cache.prime([SOL_MINT])).resolves.toBeUndefined();
    expect(cache.get(SOL_MINT)).toBe(200);
    expect(cache.status()).toEqual({ cached: 1, lastOkAt: T0, lastError: "jup 503" });
    c.advance(STALE_MAX_MS - MIN);
    await cache.prime([SOL_MINT]);
    expect(cache.get(SOL_MINT)).toBeNull();
    expect(cache.get(USDC_MINT)).toBe(1);
  });

  it("clears lastError after a later successful prime", async () => {
    let fail = true;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error("boom");
      return jupBody({ [SOL_MINT]: 1 });
    });
    const cache = new QuotePriceCache({ fetchImpl });
    await cache.prime([SOL_MINT]);
    expect(cache.status().lastError).toBe("boom");
    fail = false;
    await cache.prime([SOL_MINT]);
    expect(cache.status().lastError).toBeNull();
  });
});

describe("QuotePriceCache get", () => {
  it("returns null for an unknown mint", () => {
    const cache = new QuotePriceCache({ fetchImpl: vi.fn(async () => ({})) });
    expect(cache.get(BONK)).toBeNull();
  });

  it("returns null for mints Jupiter did not price", async () => {
    const { cache } = cacheWith({ [SOL_MINT]: 200 });
    await cache.prime([SOL_MINT, BONK]);
    expect(cache.get(BONK)).toBeNull();
  });
});

describe("parseJupiterPrices", () => {
  it("drops malformed rows and non-finite or non-positive prices", () => {
    const body = { a: { usdPrice: 2 }, b: { usdPrice: "x" }, c: null, d: { usdPrice: 0 }, e: { usdPrice: "3.5" } };
    expect([...parseJupiterPrices(body)]).toEqual([["a", 2], ["e", 3.5]]);
    expect(parseJupiterPrices(null).size).toBe(0);
    expect(parseJupiterPrices([1]).size).toBe(0);
  });
});
