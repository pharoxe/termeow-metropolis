import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PairRow } from "../../shared/wire.js";
import fixture from "./__fixtures__/dexscreener-token-pairs.json";
import { fetchTokenPairs, getTokenPairs, normalizePair, rawTokenPairs, resetTokenPairsCache, sumTxns } from "./dexscreener.js";

const MEOW = "0x9c00000000000000000000000000000000000001";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: string | URL | Request) => handler(String(input)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function row(txns: PairRow["txns"]): PairRow {
  return {
    chain: "monad",
    dex: "x",
    pairAddress: "p",
    baseMint: MEOW,
    quoteMint: null,
    liquidityUsd: null,
    volume24Usd: null,
    share24: null,
    txns,
    tier: "B",
    sources: ["dexscreener"]
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetTokenPairsCache();
});

describe("fetchTokenPairs", () => {
  it("hits the token-pairs endpoint and keeps only base-side pairs on the requested chain", async () => {
    const spy = stubFetch(() => jsonResponse(fixture));
    const pairs = await fetchTokenPairs("monad", MEOW);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe(`https://api.dexscreener.com/token-pairs/v1/monad/${MEOW}`);
    expect(pairs.map((pair) => pair.dex)).toEqual(["kuru", "uniswap", "nadfun"]);
    expect(pairs.every((pair) => pair.baseMint === MEOW)).toBe(true);
  });

  it("normalizes numbers, tier, share24 and sources", async () => {
    stubFetch(() => jsonResponse(fixture));
    const [kuru, uniswap, pump] = await fetchTokenPairs("monad", MEOW);
    expect(kuru).toEqual({
      chain: "monad",
      dex: "kuru",
      pairAddress: "0x00000000000000000000000000000000000000a1",
      baseMint: MEOW,
      quoteMint: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a",
      liquidityUsd: 500000,
      volume24Usd: 10000000,
      share24: null,
      txns: {
        m5: { buys: 10, sells: 5 },
        h1: { buys: 100, sells: 80 },
        h6: { buys: 600, sells: 500 },
        h24: { buys: 2000, sells: 1900 }
      },
      tier: "B",
      sources: ["dexscreener"]
    });
    expect(uniswap.txns).toEqual({ m5: null, h1: null, h6: null, h24: null });
    expect(pump.liquidityUsd).toBeNull();
    expect(pump.volume24Usd).toBeNull();
    expect(pump.txns).toEqual({ m5: { buys: 2, sells: 3 }, h1: null, h6: null, h24: { buys: 50, sells: 45 } });
  });

  it("returns an empty list when the body is not an array", async () => {
    stubFetch(() => jsonResponse({ pairs: [] }));
    expect(await fetchTokenPairs("monad", MEOW)).toEqual([]);
  });
});

describe("normalizePair", () => {
  it("drops pairs on another chain", () => {
    expect(normalizePair("monad", MEOW, { ...fixture[0], chainId: "solana" })).toBeNull();
  });

  it("matches monad addresses case-insensitively", () => {
    const raw = { ...fixture[0], chainId: "monad", baseToken: { address: "0xABCDEF", symbol: "X" } };
    expect(normalizePair("monad", "0xabcdef", raw)?.baseMint).toBe("0xABCDEF");
    expect(normalizePair("monad", MEOW.toUpperCase().replace("0X", "0x"), fixture[0])?.baseMint).toBe(MEOW);
  });
});

describe("sumTxns", () => {
  it("sums across pairs and nulls a window only when every pair has null", async () => {
    stubFetch(() => jsonResponse(fixture));
    const pairs = await fetchTokenPairs("monad", MEOW);
    expect(sumTxns(pairs)).toEqual({
      m5: { buys: 12, sells: 8 },
      h1: { buys: 100, sells: 80 },
      h6: { buys: 600, sells: 500 },
      h24: { buys: 2050, sells: 1945 }
    });
  });

  it("returns all-null for an empty list or all-null pairs", () => {
    const empty = { m5: null, h1: null, h6: null, h24: null };
    expect(sumTxns([])).toEqual(empty);
    expect(sumTxns([row(empty), row(empty)])).toEqual(empty);
  });
});

describe("getTokenPairs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
  });

  it("serves from cache within the TTL and refetches after it", async () => {
    const spy = stubFetch(() => jsonResponse(fixture));
    const first = await getTokenPairs("monad", MEOW);
    expect(first.stale).toBe(false);
    expect(first.observedAt).toBe(1_760_000_000_000);
    expect(first.pairs).toHaveLength(3);
    vi.setSystemTime(1_760_000_000_000 + 59_000);
    const second = await getTokenPairs("monad", MEOW);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.pairs).toBe(first.pairs);
    vi.setSystemTime(1_760_000_000_000 + 61_000);
    await getTokenPairs("monad", MEOW);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent in-flight requests", async () => {
    const spy = stubFetch(() => jsonResponse(fixture));
    const [a, b] = await Promise.all([getTokenPairs("monad", MEOW), getTokenPairs("monad", MEOW)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("returns the last good value marked stale when the upstream fails", async () => {
    let calls = 0;
    stubFetch(() => (calls++ === 0 ? jsonResponse(fixture) : jsonResponse({ error: "rate" }, 429)));
    const good = await getTokenPairs("monad", MEOW);
    vi.setSystemTime(1_760_000_000_000 + 61_000);
    const stale = await getTokenPairs("monad", MEOW);
    expect(stale.stale).toBe(true);
    expect(stale.error).toContain("429");
    expect(stale.pairs).toBe(good.pairs);
    expect(stale.observedAt).toBe(good.observedAt);
  });

  it("throws when there is no cached value to fall back to", async () => {
    stubFetch(() => jsonResponse({ error: "down" }, 503));
    await expect(getTokenPairs("monad", MEOW)).rejects.toThrow("503");
  });
});

describe("rawTokenPairs", () => {
  it("returns the un-normalized body, caches it for 60s and serves last-good with stale + error on failure", async () => {
    resetTokenPairsCache();
    const raw = [{ chainId: "monad", pairAddress: "0xP", baseToken: { address: "0xT", symbol: "FAT", name: "Fatcoin" }, priceUsd: "0.02", info: { imageUrl: "https://img" } }];
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify(raw), { status: 200 });
      return new Response("nope", { status: 500 });
    }));
    const first = await rawTokenPairs("monad", "0xT");
    expect(first.stale).toBe(false);
    expect(first.pairs).toEqual(raw);
    const cached = await rawTokenPairs("monad", "0XT");
    expect(cached.pairs).toEqual(raw);
    expect(calls).toBe(1);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    const stale = await rawTokenPairs("monad", "0xT");
    expect(stale.stale).toBe(true);
    expect(stale.pairs).toEqual(raw);
    expect(stale.error).toContain("500");
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetTokenPairsCache();
  });
});
