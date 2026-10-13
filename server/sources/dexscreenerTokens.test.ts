import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../launch/__fixtures__/dexscreener-tokens-batch.json";
import { TOKEN_BATCH_MAX, chunkAddresses, fetchTokenBatch, fetchTokenBatches, pickBestPairs, resetTokenBatchCache } from "./dexscreenerTokens.js";

const MEAO = "0x8f5Ef8C3D77C1B89fda82Fc910eDE9f809DE524B";
const ROB = "0xa29042272cC55fb939e0165509Ee124447767777";
const TRENCH = "0x9b86fd81000000000000000000000000000000cc";
const T0 = 1_760_000_000_000;
const BASE = "https://api.dexscreener.com/tokens/v1/monad/";

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
  resetTokenBatchCache();
});

describe("pickBestPairs", () => {
  it("maps the captured batch: one row per listed token, keyed lowercase, the unlisted trench token absent", () => {
    const rows = pickBestPairs("monad", [MEAO, ROB, TRENCH], fixture);
    expect([...rows.keys()]).toEqual([MEAO.toLowerCase(), ROB.toLowerCase()]);
    expect(rows.get(MEAO.toLowerCase())).toEqual({
      symbol: "MEAO",
      name: "Make Everyone an Owner",
      image: null,
      priceUsd: 0.000004013,
      marketCapUsd: 4014,
      fdvUsd: 4014,
      liquidityUsd: 5151.22,
      volume24Usd: 65463.48,
      change24Pct: -90.12,
      pairAddress: "0x051d1b7815553a7c4164e875b065e2d60462a968256cb75dd19c93731b43f654",
      dex: "uniswap",
      pairCreatedAt: 1788702725000
    });
    expect(rows.get(ROB.toLowerCase())).toMatchObject({ symbol: "ROB", dex: "flapsh", liquidityUsd: 8917.99, change24Pct: -17.41 });
  });

  it("keeps the highest-liquidity base-side pair and ignores other chains, quote-side pairs and unknown liquidity", () => {
    const meao = fixture[0]!;
    const body = [
      { ...meao, pairAddress: "0xlow", liquidity: { usd: 1 } },
      { ...meao, pairAddress: "0xnull", liquidity: null },
      { ...meao, pairAddress: "0xhigh", liquidity: { usd: 99_999 }, info: { imageUrl: "https://img/meao.png" } },
      { ...meao, pairAddress: "0xother", chainId: "base", liquidity: { usd: 1e9 } },
      { ...meao, pairAddress: "0xquote", baseToken: { address: "0xdead" }, quoteToken: meao.baseToken, liquidity: { usd: 1e9 } }
    ];
    const rows = pickBestPairs("monad", [MEAO], body);
    expect(rows.size).toBe(1);
    expect(rows.get(MEAO.toLowerCase())).toMatchObject({ pairAddress: "0xhigh", liquidityUsd: 99_999, image: "https://img/meao.png" });
    expect(pickBestPairs("monad", [MEAO], [{ ...meao, liquidity: null }]).get(MEAO.toLowerCase())?.liquidityUsd).toBeNull();
    expect(pickBestPairs("monad", [MEAO], { pairs: [] }).size).toBe(0);
  });
});

describe("chunkAddresses", () => {
  it("dedupes case-insensitively and splits into groups of at most 30", () => {
    const many = Array.from({ length: 65 }, (_, index) => `0x${index.toString(16).padStart(40, "0")}`);
    const chunks = chunkAddresses([...many, many[0]!.toUpperCase(), " ", many[3]!]);
    expect(chunks.map((chunk) => chunk.length)).toEqual([30, 30, 5]);
    expect(chunks.flat()).toEqual(many);
    expect(chunkAddresses([])).toEqual([]);
    expect(chunkAddresses(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
  });
});

describe("fetchTokenBatch", () => {
  it("asks for every address in one comma-joined call and caches hits and misses for 60s", async () => {
    const spy = stubFetch(() => jsonResponse(fixture));
    const first = await fetchTokenBatch("monad", [MEAO, ROB, TRENCH]);
    expect(String(spy.mock.calls[0][0])).toBe(`${BASE}${MEAO},${ROB},${TRENCH}`);
    expect(first.size).toBe(2);
    expect(first.has(TRENCH.toLowerCase())).toBe(false);

    vi.setSystemTime(T0 + 59_000);
    const second = await fetchTokenBatch("monad", [TRENCH, ROB.toUpperCase().replace("0X", "0x"), MEAO]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.size).toBe(2);
    expect(second.get(ROB.toLowerCase())?.symbol).toBe("ROB");

    vi.setSystemTime(T0 + 61_000);
    await fetchTokenBatch("monad", [MEAO]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[1][0])).toBe(`${BASE}${MEAO}`);
  });

  it("only fetches the addresses that are not fresh in the cache", async () => {
    const spy = stubFetch(() => jsonResponse(fixture));
    await fetchTokenBatch("monad", [MEAO]);
    const rows = await fetchTokenBatch("monad", [MEAO, ROB]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[1][0])).toBe(`${BASE}${ROB}`);
    expect(rows.size).toBe(2);
  });

  it("serves last-good rows when the upstream fails and throws only with nothing cached", async () => {
    let calls = 0;
    stubFetch(() => (calls++ === 0 ? jsonResponse(fixture) : jsonResponse({ error: "rate" }, 429)));
    const good = await fetchTokenBatch("monad", [MEAO, ROB]);
    vi.setSystemTime(T0 + 61_000);
    const stale = await fetchTokenBatch("monad", [MEAO, ROB]);
    expect(stale.get(MEAO.toLowerCase())).toBe(good.get(MEAO.toLowerCase()));
    expect(stale.size).toBe(2);
    await expect(fetchTokenBatch("monad", [TRENCH.replace("cc", "dd")])).rejects.toThrow("429");
  });

  it("rejects more than 30 addresses and returns empty for an empty list without fetching", async () => {
    const spy = stubFetch(() => jsonResponse(fixture));
    const many = Array.from({ length: TOKEN_BATCH_MAX + 1 }, (_, index) => `0x${index.toString(16).padStart(40, "0")}`);
    await expect(fetchTokenBatch("monad", many)).rejects.toThrow("at most 30");
    expect((await fetchTokenBatch("monad", [])).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("fetchTokenBatches", () => {
  it("splits an arbitrary list into calls of 30 and keeps the good chunks when one fails", async () => {
    const many = Array.from({ length: 62 }, (_, index) => `0x${index.toString(16).padStart(40, "0")}`);
    const spy = stubFetch((url) => (url.endsWith(`${MEAO},${ROB}`) ? jsonResponse(fixture) : url.includes(many[30]!) ? jsonResponse("busy", 503) : jsonResponse([])));
    const rows = await fetchTokenBatches("monad", [...many, MEAO, ROB]);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.map((call) => String(call[0]).slice(BASE.length).split(",").length)).toEqual([30, 30, 4]);
    expect(rows.size).toBe(2);
    expect(rows.get(MEAO.toLowerCase())?.dex).toBe("uniswap");
  });
});
