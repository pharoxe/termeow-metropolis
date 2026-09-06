import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../launch/__fixtures__/robinhoodtrenches-tokens.json";
import { TRENCHES_SOURCE, fetchTrenchTokens, normalizeTrenchToken, resetTrenchCache } from "./trenches.js";

const T0 = 1_760_000_000_000;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(handler: (url: string) => Response) {
  const spy = vi.fn(async (input: string | URL | Request) => handler(String(input)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetTrenchCache();
});

describe("normalizeTrenchToken", () => {
  it("maps a meme row: seconds to ms, first buyer, honeypot flag", () => {
    expect(normalizeTrenchToken(fixture[0])).toEqual({
      address: "0xdcda464763247994483c2cb3df670908c7d33853",
      symbol: "PENZ",
      name: "penz",
      isStock: false,
      traders: 24,
      buyers: 24,
      usdIn: 34155.94222109927,
      usdOut: 0,
      netUsd: 34155.94222109927,
      firstAt: 1788661956000,
      lastAt: 1788663932000,
      priceUsd: 0.000003698,
      liquidityUsd: 30.04,
      change24Pct: 807,
      volume24Usd: 82603.7,
      pairUrl: "https://dexscreener.com/robinhood/0xc1a7e7abc001d60352049ce9c5eb4ac1692c813998035340d0ec1cf708717701",
      pairCreatedAt: 1788661816000,
      buys24: 197,
      sells24: 10,
      honeypot: true,
      firstBuyer: { at: 1788661956000, priceUsd: 4.154585104396484e-7, handle: "fmpumpguy", followers: 65621 },
      sinceFirstBuyPct: 790.1009143095145,
      holders: 24
    });
  });

  it("flags tokenized stocks and keeps their null first-buyer price / since-first-buy as null", () => {
    const stock = normalizeTrenchToken(fixture[2]);
    expect(stock).toMatchObject({ symbol: "SPCX", isStock: true, honeypot: false, sinceFirstBuyPct: null });
    expect(stock?.firstBuyer).toEqual({ at: 1787873697000, priceUsd: null, handle: "unipcs", followers: 514576 });
    const stocks = fixture.map(normalizeTrenchToken).filter((row) => row?.isStock);
    expect(stocks).toHaveLength(3);
  });

  it("lowercases the address, nulls missing fields and drops rows without a 0x token", () => {
    const sparse = normalizeTrenchToken({ token: "0xDCDA464763247994483C2CB3DF670908C7D33853", symbol: null, honeypot: "yes", first_buyer: null, mark: "abc" });
    expect(sparse).toMatchObject({
      address: "0xdcda464763247994483c2cb3df670908c7d33853",
      symbol: "",
      name: "",
      isStock: false,
      honeypot: null,
      firstBuyer: null,
      priceUsd: null,
      traders: null,
      firstAt: null,
      pairUrl: null
    });
    expect(normalizeTrenchToken({ symbol: "X" })).toBeNull();
    expect(normalizeTrenchToken({ token: "So11111111111111111111111111111111111111112" })).toBeNull();
    expect(normalizeTrenchToken("row")).toBeNull();
  });
});

describe("fetchTrenchTokens", () => {
  it("queries the window and limit, labels the population and normalizes every fixture row", async () => {
    const spy = stubFetch(() => jsonResponse(fixture));
    const result = await fetchTrenchTokens("1h", 10);
    expect(String(spy.mock.calls[0][0])).toBe("https://robinhoodtrenches.com/api/tokens?window=1h&limit=10");
    expect(result).toMatchObject({ source: TRENCHES_SOURCE, window: "1h", observedAt: T0, stale: false });
    expect(result.source).toBe("robinhoodtrenches · unofficial");
    expect(result.rows).toHaveLength(10);
    expect(result.rows.every((row) => row.address === row.address.toLowerCase())).toBe(true);
  });

  it("clamps the limit and defaults it", async () => {
    const spy = stubFetch(() => jsonResponse([]));
    await fetchTrenchTokens("24h");
    await fetchTrenchTokens("24h", 9_999);
    await fetchTrenchTokens("24h", -3);
    expect(spy.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://robinhoodtrenches.com/api/tokens?window=24h&limit=50",
      "https://robinhoodtrenches.com/api/tokens?window=24h&limit=200",
      "https://robinhoodtrenches.com/api/tokens?window=24h&limit=1"
    ]);
  });

  it("caches per window for 30s and serves last-good with stale + error afterwards", async () => {
    let calls = 0;
    const spy = stubFetch(() => (calls++ === 0 ? jsonResponse(fixture) : jsonResponse("busy", 503)));
    const first = await fetchTrenchTokens("1h", 10);
    vi.setSystemTime(T0 + 29_000);
    await fetchTrenchTokens("1h", 10);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 31_000);
    const stale = await fetchTrenchTokens("1h", 10);
    expect(stale.stale).toBe(true);
    expect(stale.error).toContain("503");
    expect(stale.rows).toBe(first.rows);
    expect(stale.observedAt).toBe(T0);
  });

  it("returns no rows for a non-array body and throws before any success", async () => {
    stubFetch(() => jsonResponse({ tokens: [] }));
    expect((await fetchTrenchTokens("1h", 5)).rows).toEqual([]);
    resetTrenchCache();
    stubFetch(() => jsonResponse("down", 502));
    await expect(fetchTrenchTokens("1h", 5)).rejects.toThrow("502");
  });
});
