import { afterEach, describe, expect, it, vi } from "vitest";
import { resetGeckoBackoff } from "../sources/gecko";
import { rankCandlePairs, resolveGeckoCandles } from "./market";

const mint = "So11111111111111111111111111111111111111112";

function ohlcv(count: number, start = 1_700_000_000) {
  return Array.from({ length: count }, (_, index) => [start + index * 300, 1, 2, 0.5, 1.2, 10]);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function ohlcvResponse(rows: number[][], status = 200) {
  return jsonResponse({ data: { attributes: { ohlcv_list: rows } } }, status);
}

function pumpFunBars(count: number, start = 1_700_000_000_000, step = 300_000) {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: String(start + index * step),
    open: "1",
    high: "2",
    low: "0.5",
    close: "1.2",
    volume: "10"
  }));
}

function pumpFunResponse(count: number, status = 200, start?: number, step?: number) {
  return jsonResponse(pumpFunBars(count, start, step), status);
}

function emptyPump(url: string) {
  if (url.includes("frontend-api-v3.pump.fun")) return jsonResponse({});
  if (url.includes("swap-api.pump.fun")) return jsonResponse([]);
  return null;
}

function geckoOhlcvCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes("api.geckoterminal.com") && String(call[0]).includes("/ohlcv/"));
}

function geckoPoolCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes("api.geckoterminal.com") && String(call[0]).includes("/pools/"));
}

function pumpFunCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes("swap-api.pump.fun"));
}

const pairs = [
  { chainId: "solana", dexId: "pumpswap", pairAddress: "PAIR_BEST", liquidity: { usd: 8_000 }, volume: { h24: 100 } },
  { chainId: "solana", dexId: "raydium", pairAddress: "PAIR_RAY", liquidity: { usd: 3_000 }, volume: { h24: 900 } },
  { chainId: "solana", dexId: "orca", pairAddress: "PAIR_ORCA", liquidity: { usd: 1_000 }, volume: { h24: 50 } },
  { chainId: "ethereum", dexId: "uni", pairAddress: "PAIR_ETH", liquidity: { usd: 99_000 }, volume: { h24: 9_000 } },
  { chainId: "solana", dexId: "pumpswap", pairAddress: "PAIR_BEST", liquidity: { usd: 1 }, volume: { h24: 1 } }
];

afterEach(() => {
  resetGeckoBackoff();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rankCandlePairs", () => {
  it("ranks solana pairs by liquidity then volume and skips dupes", () => {
    const ranked = rankCandlePairs(pairs);
    expect(ranked.map((pair) => pair.pairAddress)).toEqual(["PAIR_BEST", "PAIR_RAY", "PAIR_ORCA"]);
  });

  it("prefers volume when liquidity ties", () => {
    const ranked = rankCandlePairs([
      { chainId: "solana", pairAddress: "A", liquidity: { usd: 10 }, volume: { h24: 1 } },
      { chainId: "solana", pairAddress: "B", liquidity: { usd: 10 }, volume: { h24: 50 } }
    ]);
    expect(ranked[0]?.pairAddress).toBe("B");
  });
});

describe("resolveGeckoCandles", () => {
  it("returns the primary pair series without extra gecko lookups", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const pump = emptyPump(url);
      if (pump) return pump;
      if (url.includes("/pools/PAIR_BEST/ohlcv/")) return ohlcvResponse(ohlcv(3));
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const notes: string[] = [];
    const result = await resolveGeckoCandles(mint, pairs, "5m", notes);
    expect(result.pair?.pairAddress).toBe("PAIR_BEST");
    expect(result.candles).toHaveLength(3);
    expect(notes).toEqual([]);
    expect(geckoOhlcvCalls(fetchMock)).toHaveLength(1);
  });

  it("uses pump.fun when gecko best pair is empty", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pools/PAIR_BEST/ohlcv/")) return ohlcvResponse([]);
      if (url.includes("frontend-api-v3.pump.fun")) return jsonResponse({});
      if (url.includes("swap-api.pump.fun")) return pumpFunResponse(5);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const notes: string[] = [];
    const result = await resolveGeckoCandles(mint, pairs, "5m", notes);
    expect(result.candles).toHaveLength(5);
    expect(result.pair?.pairAddress).toBe("PAIR_BEST");
    expect(notes).toEqual(["OHLCV from pump.fun (gecko empty)"]);
    expect(geckoPoolCalls(fetchMock)).toHaveLength(1);
    expect(pumpFunCalls(fetchMock).length).toBeGreaterThanOrEqual(1);
    expect(pumpFunCalls(fetchMock).every((call) => String(call[0]).includes("limit=1000"))).toBe(true);
  });

  it("uses pump.fun when gecko rate-limits the best pair and skips further gecko pools", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pools/PAIR_BEST/ohlcv/")) return ohlcvResponse([], 429);
      if (url.includes("frontend-api-v3.pump.fun")) return jsonResponse({});
      if (url.includes("swap-api.pump.fun")) return pumpFunResponse(6);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const notes: string[] = [];
    const result = await resolveGeckoCandles(mint, pairs, "5m", notes);
    expect(result.candles).toHaveLength(6);
    expect(result.pair?.pairAddress).toBe("PAIR_BEST");
    expect(notes).toEqual(["OHLCV from pump.fun (gecko empty)"]);
    expect(geckoPoolCalls(fetchMock)).toHaveLength(1);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/pools/PAIR_RAY/"))).toBe(false);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes(`/tokens/${mint}/pools`))).toBe(false);
    expect(pumpFunCalls(fetchMock).length).toBeGreaterThanOrEqual(1);
  });

  it("keeps a single gecko OHLCV call when the best pair is usable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const pump = emptyPump(url);
      if (pump) return pump;
      if (url.includes("/pools/PAIR_BEST/ohlcv/")) return ohlcvResponse(ohlcv(4));
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const notes: string[] = [];
    const result = await resolveGeckoCandles(mint, pairs, "5m", notes);
    expect(result.candles).toHaveLength(4);
    expect(result.pair?.pairAddress).toBe("PAIR_BEST");
    expect(notes).toEqual([]);
    expect(geckoOhlcvCalls(fetchMock)).toHaveLength(1);
  });

  it("falls through to the next liquid pair when the best pool is empty", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pools/PAIR_BEST/ohlcv/")) return ohlcvResponse([]);
      if (url.includes("frontend-api-v3.pump.fun")) return jsonResponse({});
      if (url.includes("swap-api.pump.fun")) return pumpFunResponse(0);
      if (url.includes("/pools/PAIR_RAY/ohlcv/")) return ohlcvResponse(ohlcv(4));
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const notes: string[] = [];
    const result = await resolveGeckoCandles(mint, pairs, "5m", notes);
    expect(result.pair?.pairAddress).toBe("PAIR_RAY");
    expect(result.candles).toHaveLength(4);
    expect(notes.some((note) => note.includes("raydium"))).toBe(true);
    expect(geckoOhlcvCalls(fetchMock)).toHaveLength(2);
  });

  it("tries unused Gecko token pools when every dex pair is empty", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("frontend-api-v3.pump.fun")) return jsonResponse({});
      if (url.includes("swap-api.pump.fun")) return pumpFunResponse(0);
      if (url.includes("/pools/PAIR_BEST/ohlcv/") || url.includes("/pools/PAIR_RAY/ohlcv/") || url.includes("/pools/PAIR_ORCA/ohlcv/")) {
        return ohlcvResponse([]);
      }
      if (url.includes(`/tokens/${mint}/pools`)) {
        return jsonResponse({
          data: [
            { attributes: { address: "PAIR_BEST" }, relationships: { dex: { data: { id: "pumpswap" } } } },
            { attributes: { address: "GECKO_NEW" }, relationships: { dex: { data: { id: "meteora" } } } }
          ]
        });
      }
      if (url.includes("/pools/GECKO_NEW/ohlcv/")) return ohlcvResponse(ohlcv(2));
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const notes: string[] = [];
    const result = await resolveGeckoCandles(mint, pairs, "5m", notes);
    expect(result.pair?.pairAddress).toBe("GECKO_NEW");
    expect(result.candles).toHaveLength(2);
    expect(notes.some((note) => note.includes("GECKO_"))).toBe(true);
  });

  it("stitches pump 1h history when 5m starts after launch", async () => {
    const created = 1_700_000_000_000;
    const fineStart = created + 2 * 86_400_000;
    const fineCount = 1000;
    const hourlyCount = 40;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pools/PAIR_BEST/ohlcv/")) return ohlcvResponse([]);
      if (url.includes("frontend-api-v3.pump.fun/coins/")) return jsonResponse({ created_timestamp: created });
      if (url.includes("swap-api.pump.fun") && url.includes("interval=5m")) {
        expect(url).toContain("limit=1000");
        return pumpFunResponse(fineCount, 200, fineStart, 300_000);
      }
      if (url.includes("swap-api.pump.fun") && url.includes("interval=1h")) {
        expect(url).toContain("limit=1000");
        return pumpFunResponse(hourlyCount, 200, created, 3_600_000);
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const notes: string[] = [];
    const result = await resolveGeckoCandles(mint, pairs, "5m", notes);
    expect(result.candles.length).toBeGreaterThan(fineCount);
    expect(result.candles[0]?.time).toBe(created);
    expect(notes).toEqual(["OHLCV from pump.fun (gecko empty)"]);
    expect(geckoOhlcvCalls(fetchMock)).toHaveLength(1);
    expect(pumpFunCalls(fetchMock).some((call) => String(call[0]).includes("interval=1h"))).toBe(true);
    expect(pumpFunCalls(fetchMock).some((call) => String(call[0]).includes("interval=4h"))).toBe(false);
  });
});
