import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dexScreenerTokensUrl, EvmQuotePrice, parseDexScreenerTokenPrices, STALE_MAX_MS, TOKENS_PER_CALL, USDC_ADDRESS, WMON_ADDRESS } from "./price.js";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
/** Live tokens/v1/monad/<ETH,WETH> response 2026-09-06: ETH came back as the QUOTE of SIZE/ETH, WETH as a BASE. */
const TOKENS_BODY = JSON.parse(readFileSync(new URL("dexscreener-tokens-eth-weth.json", FIXTURES), "utf8")) as unknown;

const ETH = "0x0000000000000000000000000000000000000000";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const T0 = Date.parse("2026-09-06T08:00:00.000Z");
const MIN = 60_000;
const ETH_USD = 0.0002222 / 0.0000000889;

function clock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const NATIVE = "0x0000000000000000000000000000000000000000";
const MON_USD = 0.0002222 / 0.0000000889;
/** Synthetic Monad tokens/v1 body: WETH as a BASE, WMON as the QUOTE of SIZE/WMON (native MON is priced as WMON). */
const CACHE_BODY = [
  { chainId: "monad", baseToken: { address: WETH }, quoteToken: { address: USDC_ADDRESS }, priceUsd: "2498.87", liquidity: { usd: 1_000_000 } },
  { chainId: "monad", baseToken: { address: "0x00000000000000000000000000000000000051ce" }, quoteToken: { address: WMON_ADDRESS }, priceUsd: "0.0002222", priceNative: "0.0000000889", liquidity: { usd: 50_000 } }
];

function cacheWith(body: unknown = CACHE_BODY, opts: { ttlMs?: number; now?: () => number } = {}) {
  const fetchImpl = vi.fn(async (_url: string) => body);
  const cache = new EvmQuotePrice({ chain: "monad", ...opts, fetchImpl });
  return { cache, fetchImpl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseDexScreenerTokenPrices", () => {
  it("prices a token on the base side from priceUsd and on the quote side from priceUsd / priceNative", () => {
    const prices = parseDexScreenerTokenPrices(TOKENS_BODY, new Set([ETH, WETH.toLowerCase()]), "monad");
    expect(prices.get(WETH.toLowerCase())).toBe(2498.87);
    expect(prices.get(ETH)).toBeCloseTo(ETH_USD, 6);
    expect(prices.size).toBe(2);
  });

  it("keeps the highest-liquidity pair per token and ignores other chains, unwanted tokens and bad prices", () => {
    const body = [
      { chainId: "monad", baseToken: { address: WETH }, quoteToken: { address: USDC_ADDRESS }, priceUsd: "2400", priceNative: "2400", liquidity: { usd: 10 } },
      { chainId: "monad", baseToken: { address: WETH }, quoteToken: { address: USDC_ADDRESS }, priceUsd: "2500", priceNative: "2500", liquidity: { usd: 1000 } },
      { chainId: "monad", baseToken: { address: WETH }, quoteToken: { address: USDC_ADDRESS }, priceUsd: "9999", priceNative: "9999" },
      { chainId: "base", baseToken: { address: WETH }, quoteToken: { address: USDC_ADDRESS }, priceUsd: "1", priceNative: "1", liquidity: { usd: 1e9 } },
      { chainId: "monad", baseToken: { address: "0xother" }, quoteToken: { address: ETH }, priceUsd: "1", priceNative: "0", liquidity: { usd: 1e9 } },
      { chainId: "monad", baseToken: { address: "0xother" }, quoteToken: { address: ETH }, priceUsd: "abc", priceNative: "1" },
      "junk"
    ];
    const prices = parseDexScreenerTokenPrices(body, new Set([WETH.toLowerCase(), ETH]), "monad");
    expect(prices.get(WETH.toLowerCase())).toBe(2500);
    expect(prices.has(ETH)).toBe(false);
    expect(parseDexScreenerTokenPrices({ pairs: [] }, new Set([ETH]), "monad").size).toBe(0);
  });
});

describe("EvmQuotePrice stables", () => {
  it("returns 1 for USDC in any casing without any fetch", async () => {
    const { cache, fetchImpl } = cacheWith();
    await cache.prime([USDC_ADDRESS, USDC_ADDRESS.toUpperCase().replace("0X", "0x")]);
    expect(cache.get(USDC_ADDRESS)).toBe(1);
    expect(cache.get(USDC_ADDRESS.toUpperCase())).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honours a custom stableAddresses list", () => {
    const cache = new EvmQuotePrice({ chain: "monad", stableAddresses: ["0xABC"], fetchImpl: vi.fn(async () => []) });
    expect(cache.get("0xabc")).toBe(1);
    expect(cache.get(USDC_ADDRESS)).toBeNull();
  });
});

describe("EvmQuotePrice prime", () => {
  it("batches every unknown non-stable address into one tokens/v1 URL and caches both sides", async () => {
    const { cache, fetchImpl } = cacheWith(CACHE_BODY, { now: () => T0 });
    await cache.prime([NATIVE, WETH, NATIVE, USDC_ADDRESS]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.dexscreener.com/tokens/v1/monad/${WMON_ADDRESS},${WETH.toLowerCase()}`);
    expect(cache.get(WETH)).toBe(2498.87);
    expect(cache.get(NATIVE)).toBeCloseTo(MON_USD, 6);
    // 3, not 2: USDC is a stable, so prime() records its known price of 1 without a fetch and it counts as cached.
    expect(cache.status()).toEqual({ cached: 3, lastOkAt: T0, lastError: null });
  });

  it("splits more than 30 addresses across calls", async () => {
    const { cache, fetchImpl } = cacheWith([]);
    const addresses = Array.from({ length: 31 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    await cache.prime(addresses);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe(dexScreenerTokensUrl("monad", addresses.slice(0, TOKENS_PER_CALL)));
    expect(fetchImpl.mock.calls[1][0]).toBe(dexScreenerTokensUrl("monad", addresses.slice(TOKENS_PER_CALL)));
  });

  it("uses the global fetch via fetchJson when no fetchImpl is given", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(CACHE_BODY), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new EvmQuotePrice({ chain: "monad" });
    await cache.prime([WETH]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(dexScreenerTokensUrl("monad", [WETH.toLowerCase()]));
    expect(cache.get(WETH)).toBe(2498.87);
  });

  it("skips the fetch while cached values are within ttl and refetches once past it", async () => {
    const c = clock();
    const { cache, fetchImpl } = cacheWith(CACHE_BODY, { ttlMs: MIN, now: c.now });
    await cache.prime([WETH]);
    c.advance(MIN - 1);
    await cache.prime([WETH]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    c.advance(1);
    await cache.prime([WETH]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("coalesces overlapping primes for the same address into the request already in flight", async () => {
    const pending: Array<(body: unknown) => void> = [];
    const fetchImpl = vi.fn((_url: string) => new Promise<unknown>((resolve) => pending.push(resolve)));
    const cache = new EvmQuotePrice({ chain: "monad", fetchImpl, now: () => T0 });
    const first = cache.prime([WETH]);
    const second = cache.prime([WETH, NATIVE]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe(dexScreenerTokensUrl("monad", [WMON_ADDRESS]));
    pending.forEach((resolve) => resolve(CACHE_BODY));
    await Promise.all([first, second]);
    expect(cache.get(WETH)).toBe(2498.87);
    expect(cache.get(NATIVE)).toBeCloseTo(MON_USD, 6);
  });

  it("records lastError on failure, keeps the previous value, and never throws", async () => {
    const c = clock();
    let fail = false;
    const fetchImpl = vi.fn(async (_url: string) => {
      if (fail) throw new Error("Upstream returned 429");
      return CACHE_BODY;
    });
    const cache = new EvmQuotePrice({ chain: "monad", ttlMs: MIN, fetchImpl, now: c.now });
    await cache.prime([WETH]);
    fail = true;
    c.advance(2 * MIN);
    await expect(cache.prime([WETH])).resolves.toBeUndefined();
    expect(cache.status()).toEqual({ cached: 1, lastOkAt: T0, lastError: "Upstream returned 429" });
    expect(cache.get(WETH)).toBe(2498.87);
  });
});

describe("EvmQuotePrice stale cutoff", () => {
  it("returns null once a cached value is 5 minutes old even if refreshes keep failing", async () => {
    const c = clock();
    let fail = false;
    const fetchImpl = vi.fn(async (_url: string) => {
      if (fail) throw new Error("down");
      return CACHE_BODY;
    });
    const cache = new EvmQuotePrice({ chain: "monad", ttlMs: MIN, fetchImpl, now: c.now });
    await cache.prime([NATIVE]);
    fail = true;
    c.advance(STALE_MAX_MS - 1);
    await cache.prime([NATIVE]);
    expect(cache.get(NATIVE)).toBeCloseTo(MON_USD, 6);
    c.advance(1);
    expect(cache.get(NATIVE)).toBeNull();
    expect(cache.get(USDC_ADDRESS)).toBe(1);
    expect(cache.get("0xnever")).toBeNull();
  });
});
