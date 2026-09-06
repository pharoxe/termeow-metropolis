import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PairRow } from "../../shared/wire.js";
import fixture from "./__fixtures__/dexscreener-token-pairs.json";
import { fetchTokenPairs, getTokenPairs, normalizePair, resetTokenPairsCache, sumTxns } from "./dexscreener.js";

const ANSEM = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";

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
    chain: "solana",
    dex: "x",
    pairAddress: "p",
    baseMint: ANSEM,
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
    const pairs = await fetchTokenPairs("solana", ANSEM);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe(`https://api.dexscreener.com/token-pairs/v1/solana/${ANSEM}`);
    expect(pairs.map((pair) => pair.dex)).toEqual(["raydium", "orca", "pumpswap"]);
    expect(pairs.every((pair) => pair.baseMint === ANSEM)).toBe(true);
  });

  it("normalizes numbers, tier, share24 and sources", async () => {
    stubFetch(() => jsonResponse(fixture));
    const [raydium, orca, pump] = await fetchTokenPairs("solana", ANSEM);
    expect(raydium).toEqual({
      chain: "solana",
      dex: "raydium",
      pairAddress: "RayPair1111111111111111111111111111111111111",
      baseMint: ANSEM,
      quoteMint: "So11111111111111111111111111111111111111112",
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
    expect(orca.txns).toEqual({ m5: null, h1: null, h6: null, h24: null });
    expect(pump.liquidityUsd).toBeNull();
    expect(pump.volume24Usd).toBeNull();
    expect(pump.txns).toEqual({ m5: { buys: 2, sells: 3 }, h1: null, h6: null, h24: { buys: 50, sells: 45 } });
  });

  it("returns an empty list when the body is not an array", async () => {
    stubFetch(() => jsonResponse({ pairs: [] }));
    expect(await fetchTokenPairs("solana", ANSEM)).toEqual([]);
  });
});

describe("normalizePair", () => {
  it("drops pairs on another chain", () => {
    expect(normalizePair("solana", ANSEM, { ...fixture[0], chainId: "robinhood" })).toBeNull();
  });

  it("matches robinhood addresses case-insensitively and solana addresses exactly", () => {
    const raw = { ...fixture[0], chainId: "robinhood", baseToken: { address: "0xABCDEF", symbol: "X" } };
    expect(normalizePair("robinhood", "0xabcdef", raw)?.baseMint).toBe("0xABCDEF");
    expect(normalizePair("solana", ANSEM.toLowerCase(), fixture[0])).toBeNull();
  });
});

describe("sumTxns", () => {
  it("sums across pairs and nulls a window only when every pair has null", async () => {
    stubFetch(() => jsonResponse(fixture));
    const pairs = await fetchTokenPairs("solana", ANSEM);
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
    const first = await getTokenPairs("solana", ANSEM);
    expect(first.stale).toBe(false);
    expect(first.observedAt).toBe(1_760_000_000_000);
    expect(first.pairs).toHaveLength(3);
    vi.setSystemTime(1_760_000_000_000 + 59_000);
    const second = await getTokenPairs("solana", ANSEM);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.pairs).toBe(first.pairs);
    vi.setSystemTime(1_760_000_000_000 + 61_000);
    await getTokenPairs("solana", ANSEM);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent in-flight requests", async () => {
    const spy = stubFetch(() => jsonResponse(fixture));
    const [a, b] = await Promise.all([getTokenPairs("solana", ANSEM), getTokenPairs("solana", ANSEM)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("returns the last good value marked stale when the upstream fails", async () => {
    let calls = 0;
    stubFetch(() => (calls++ === 0 ? jsonResponse(fixture) : jsonResponse({ error: "rate" }, 429)));
    const good = await getTokenPairs("solana", ANSEM);
    vi.setSystemTime(1_760_000_000_000 + 61_000);
    const stale = await getTokenPairs("solana", ANSEM);
    expect(stale.stale).toBe(true);
    expect(stale.error).toContain("429");
    expect(stale.pairs).toBe(good.pairs);
    expect(stale.observedAt).toBe(good.observedAt);
  });

  it("throws when there is no cached value to fall back to", async () => {
    stubFetch(() => jsonResponse({ error: "down" }, 503));
    await expect(getTokenPairs("solana", ANSEM)).rejects.toThrow("503");
  });
});
