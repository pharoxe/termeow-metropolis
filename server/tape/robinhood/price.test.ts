import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dexScreenerTokensUrl, EvmQuotePrice, parseDexScreenerTokenPrices, STALE_MAX_MS, TOKENS_PER_CALL, USDG_ADDRESS } from "./price.js";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
/** Live tokens/v1/robinhood/<ETH,WETH> response 2026-09-06: ETH came back as the QUOTE of SIZE/ETH, WETH as a BASE. */
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

function cacheWith(body: unknown = TOKENS_BODY, opts: { ttlMs?: number; now?: () => number } = {}) {
  const fetchImpl = vi.fn(async (_url: string) => body);
  const cache = new EvmQuotePrice({ chain: "robinhood", ...opts, fetchImpl });
  return { cache, fetchImpl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseDexScreenerTokenPrices", () => {
  it("prices a token on the base side from priceUsd and on the quote side from priceUsd / priceNative", () => {
    const prices = parseDexScreenerTokenPrices(TOKENS_BODY, new Set([ETH, WETH.toLowerCase()]), "robinhood");
    expect(prices.get(WETH.toLowerCase())).toBe(2498.87);
    expect(prices.get(ETH)).toBeCloseTo(ETH_USD, 6);
    expect(prices.size).toBe(2);
  });

  it("keeps the highest-liquidity pair per token and ignores other chains, unwanted tokens and bad prices", () => {
    const body = [
      { chainId: "robinhood", baseToken: { address: WETH }, quoteToken: { address: USDG_ADDRESS }, priceUsd: "2400", priceNative: "2400", liquidity: { usd: 10 } },
      { chainId: "robinhood", baseToken: { address: WETH }, quoteToken: { address: USDG_ADDRESS }, priceUsd: "2500", priceNative: "2500", liquidity: { usd: 1000 } },
      { chainId: "robinhood", baseToken: { address: WETH }, quoteToken: { address: USDG_ADDRESS }, priceUsd: "9999", priceNative: "9999" },
      { chainId: "base", baseToken: { address: WETH }, quoteToken: { address: USDG_ADDRESS }, priceUsd: "1", priceNative: "1", liquidity: { usd: 1e9 } },
      { chainId: "robinhood", baseToken: { address: "0xother" }, quoteToken: { address: ETH }, priceUsd: "1", priceNative: "0", liquidity: { usd: 1e9 } },
      { chainId: "robinhood", baseToken: { address: "0xother" }, quoteToken: { address: ETH }, priceUsd: "abc", priceNative: "1" },
      "junk"
    ];
    const prices = parseDexScreenerTokenPrices(body, new Set([WETH.toLowerCase(), ETH]), "robinhood");
    expect(prices.get(WETH.toLowerCase())).toBe(2500);
    expect(prices.has(ETH)).toBe(false);
    expect(parseDexScreenerTokenPrices({ pairs: [] }, new Set([ETH]), "robinhood").size).toBe(0);
  });
});

describe("EvmQuotePrice stables", () => {
  it("returns 1 for USDG in any casing without any fetch", async () => {
    const { cache, fetchImpl } = cacheWith();
    await cache.prime([USDG_ADDRESS, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"]);
    expect(cache.get(USDG_ADDRESS)).toBe(1);
    expect(cache.get("0x5FC5360D0400A0FD4F2AF552ADD042D716F1D168")).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honours a custom stableAddresses list", () => {
    const cache = new EvmQuotePrice({ chain: "robinhood", stableAddresses: ["0xABC"], fetchImpl: vi.fn(async () => []) });
    expect(cache.get("0xabc")).toBe(1);
    expect(cache.get(USDG_ADDRESS)).toBeNull();
  });
});

describe("EvmQuotePrice prime", () => {
  it("batches every unknown non-stable address into one tokens/v1 URL and caches both sides", async () => {
    const { cache, fetchImpl } = cacheWith(TOKENS_BODY, { now: () => T0 });
    await cache.prime([ETH, WETH, ETH, USDG_ADDRESS]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.dexscreener.com/tokens/v1/robinhood/${ETH},${WETH.toLowerCase()}`);
    expect(cache.get(WETH)).toBe(2498.87);
    expect(cache.get(ETH)).toBeCloseTo(ETH_USD, 6);
    expect(cache.status()).toEqual({ cached: 2, lastOkAt: T0, lastError: null });
  });

  it("splits more than 30 addresses across calls", async () => {
    const { cache, fetchImpl } = cacheWith([]);
    const addresses = Array.from({ length: 31 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    await cache.prime(addresses);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe(dexScreenerTokensUrl("robinhood", addresses.slice(0, TOKENS_PER_CALL)));
    expect(fetchImpl.mock.calls[1][0]).toBe(dexScreenerTokensUrl("robinhood", addresses.slice(TOKENS_PER_CALL)));
  });

  it("uses the global fetch via fetchJson when no fetchImpl is given", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(TOKENS_BODY), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new EvmQuotePrice({ chain: "robinhood" });
    await cache.prime([WETH]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(dexScreenerTokensUrl("robinhood", [WETH.toLowerCase()]));
    expect(cache.get(WETH)).toBe(2498.87);
  });

  it("skips the fetch while cached values are within ttl and refetches once past it", async () => {
    const c = clock();
    const { cache, fetchImpl } = cacheWith(TOKENS_BODY, { ttlMs: MIN, now: c.now });
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
    const cache = new EvmQuotePrice({ chain: "robinhood", fetchImpl, now: () => T0 });
    const first = cache.prime([WETH]);
    const second = cache.prime([WETH, ETH]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe(dexScreenerTokensUrl("robinhood", [ETH]));
    pending.forEach((resolve) => resolve(TOKENS_BODY));
    await Promise.all([first, second]);
    expect(cache.get(WETH)).toBe(2498.87);
    expect(cache.get(ETH)).toBeCloseTo(ETH_USD, 6);
  });

  it("records lastError on failure, keeps the previous value, and never throws", async () => {
    const c = clock();
    let fail = false;
    const fetchImpl = vi.fn(async (_url: string) => {
      if (fail) throw new Error("Upstream returned 429");
      return TOKENS_BODY;
    });
    const cache = new EvmQuotePrice({ chain: "robinhood", ttlMs: MIN, fetchImpl, now: c.now });
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
      return TOKENS_BODY;
    });
    const cache = new EvmQuotePrice({ chain: "robinhood", ttlMs: MIN, fetchImpl, now: c.now });
    await cache.prime([ETH]);
    fail = true;
    c.advance(STALE_MAX_MS - 1);
    await cache.prime([ETH]);
    expect(cache.get(ETH)).toBeCloseTo(ETH_USD, 6);
    c.advance(1);
    expect(cache.get(ETH)).toBeNull();
    expect(cache.get(USDG_ADDRESS)).toBe(1);
    expect(cache.get("0xnever")).toBeNull();
  });
});
