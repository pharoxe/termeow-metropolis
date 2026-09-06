import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowPrint } from "../../shared/wire";
import { fetchPumpTradesPage, isPumpBlocked, parsePumpTradesResponse, PUMP_BLOCK_MS, pumpPoolFor, resetPumpBackoff, walkPumpTradesBack } from "./pumpfun";

const mint = "MintPumpFixture1111111111111111111111111111";
const fixture: unknown = JSON.parse(readFileSync(new URL("./__fixtures__/pumpfun-trades.json", import.meta.url), "utf8"));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function trade(tx: string, type: string, timeMs: number, amountUsd: unknown = "10.5") {
  return { slotIndexId: tx, tx, timestamp: new Date(timeMs).toISOString(), userAddress: "u", type, program: "pump_amm", amountUsd };
}

function page(trades: unknown[], nextCursor: string | null, hasMore: boolean) {
  return { trades, pagination: { nextCursor, hasMore, limit: 100 } };
}

const T0 = Date.parse("2026-09-06T08:00:00.000Z");
const MIN = 60_000;

/** Three pages, newest first: c0 -> c1 -> c2 (end). Times descend by one minute per trade. */
const pagesByCursor: Record<string, unknown> = {
  "": page([trade("a1", "buy", T0), trade("a2", "sell", T0 - MIN)], "c1", true),
  c1: page([trade("b1", "buy", T0 - 2 * MIN), trade("b2", "sell", T0 - 3 * MIN)], "c2", true),
  c2: page([trade("c1", "sell", T0 - 4 * MIN)], null, false)
};

function cursorOf(url: string) {
  return new URL(url).searchParams.get("cursor") ?? "";
}

function stubPagedFetch() {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const body = pagesByCursor[cursorOf(String(input))];
    return body ? jsonResponse(body) : jsonResponse({ error: "no such page" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const noSleep = () => vi.fn(async (_ms: number) => {});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetPumpBackoff();
});

describe("pumpPoolFor", () => {
  it("returns the per-coin pair id", () => {
    expect(pumpPoolFor(mint)).toBe(`pumpfun:${mint}`);
  });
});

describe("parsePumpTradesResponse", () => {
  it("normalizes buy and sell rows, drops unknown types, and nulls unpriced usd", () => {
    const result = parsePumpTradesResponse(fixture, mint);
    expect(result.prints.map((p) => p.tx.slice(0, 4))).toEqual(["5KQ1", "3hSe", "4nUn"]);
    expect(result.prints[0]).toEqual({
      chain: "solana",
      pair: `pumpfun:${mint}`,
      tx: result.prints[0].tx,
      time: Date.parse("2026-09-06T08:15:42.000Z"),
      side: "buy",
      usd: 152.3,
      source: "pumpfun"
    });
    expect(result.prints[1].side).toBe("sell");
    expect(result.prints[1].usd).toBe(48.1);
    expect(result.prints[2].usd).toBeNull();
    expect(result.nextCursor).toBe("367001225-1788950131000");
    expect(result.hasMore).toBe(true);
  });

  it("drops rows whose timestamp does not parse and treats non-finite usd as null", () => {
    const json = page(
      [trade("ok", "buy", T0, "NaN"), { ...trade("bad", "sell", T0), timestamp: "not-a-date" }, { ...trade("missing", "buy", T0), timestamp: undefined }],
      null,
      false
    );
    const result = parsePumpTradesResponse(json, mint);
    expect(result.prints.map((p) => p.tx)).toEqual(["ok"]);
    expect(result.prints[0].usd).toBeNull();
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("tolerates malformed payloads", () => {
    expect(parsePumpTradesResponse(null, mint)).toEqual({ prints: [], nextCursor: null, hasMore: false });
    expect(parsePumpTradesResponse({ trades: "nope" }, mint)).toEqual({ prints: [], nextCursor: null, hasMore: false });
    expect(parsePumpTradesResponse({ trades: [], pagination: { hasMore: true, nextCursor: null } }, mint).hasMore).toBe(false);
  });
});

describe("fetchPumpTradesPage", () => {
  it("requests limit=100 without a cursor and forwards the cursor when given", async () => {
    const fetchMock = stubPagedFetch();
    const first = await fetchPumpTradesPage(mint);
    expect(first.prints).toHaveLength(2);
    expect(first.nextCursor).toBe("c1");
    const firstUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(firstUrl.origin + firstUrl.pathname).toBe(`https://swap-api.pump.fun/v2/coins/${mint}/trades`);
    expect(firstUrl.searchParams.get("limit")).toBe("100");
    expect(firstUrl.searchParams.has("cursor")).toBe(false);

    const second = await fetchPumpTradesPage(mint, "c1");
    expect(second.prints.map((p) => p.tx)).toEqual(["b1", "b2"]);
    expect(cursorOf(String(fetchMock.mock.calls[1][0]))).toBe("c1");
  });

  it("propagates upstream failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "rate limited" }, 429)));
    await expect(fetchPumpTradesPage(mint)).rejects.toMatchObject({ status: 429 });
  });

  it("backs off for PUMP_BLOCK_MS after a 429 without calling fetch, then resumes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const fetchMock = vi.fn(async () => jsonResponse({ message: "rate limited" }, 429));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPumpTradesPage(mint)).rejects.toMatchObject({ status: 429 });
    expect(isPumpBlocked()).toBe(true);
    await expect(fetchPumpTradesPage(mint)).rejects.toMatchObject({ message: "pump.fun backoff active after 429", status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + PUMP_BLOCK_MS);
    expect(isPumpBlocked()).toBe(false);
    await expect(fetchPumpTradesPage(mint)).rejects.toMatchObject({ message: "Upstream returned 429" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not back off after non-429 failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "boom" }, 500)));
    await expect(fetchPumpTradesPage(mint)).rejects.toMatchObject({ status: 500 });
    expect(isPumpBlocked()).toBe(false);
  });
});

describe("walkPumpTradesBack", () => {
  it("stops by until once a page reaches older prints and keeps the resume cursor", async () => {
    stubPagedFetch();
    const sleep = noSleep();
    const seen: FlowPrint[][] = [];
    const result = await walkPumpTradesBack(mint, { untilMs: T0 - 2 * MIN - 1, maxPages: 10, sleep, onPage: (p) => seen.push(p) });
    expect(result).toEqual({ pages: 2, prints: 4, oldestMs: T0 - 3 * MIN, nextCursor: "c2", stoppedBy: "until" });
    expect(seen.map((p) => p.length)).toEqual([2, 2]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("stops by maxPages and honours a custom page delay", async () => {
    stubPagedFetch();
    const sleep = noSleep();
    const result = await walkPumpTradesBack(mint, { untilMs: 0, maxPages: 2, pageDelayMs: 25, sleep });
    expect(result).toEqual({ pages: 2, prints: 4, oldestMs: T0 - 3 * MIN, nextCursor: "c2", stoppedBy: "maxPages" });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("stops by end when the feed has no more pages", async () => {
    stubPagedFetch();
    const sleep = noSleep();
    const result = await walkPumpTradesBack(mint, { untilMs: 0, maxPages: 10, sleep });
    expect(result).toEqual({ pages: 3, prints: 5, oldestMs: T0 - 4 * MIN, nextCursor: null, stoppedBy: "end" });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("resumes from startCursor", async () => {
    const fetchMock = stubPagedFetch();
    const result = await walkPumpTradesBack(mint, { untilMs: 0, maxPages: 10, sleep: noSleep(), startCursor: "c2" });
    expect(cursorOf(String(fetchMock.mock.calls[0][0]))).toBe("c2");
    expect(result).toEqual({ pages: 1, prints: 1, oldestMs: T0 - 4 * MIN, nextCursor: null, stoppedBy: "end" });
  });

  it("returns without fetching when maxPages is zero", async () => {
    const fetchMock = stubPagedFetch();
    const result = await walkPumpTradesBack(mint, { untilMs: 0, maxPages: 0, sleep: noSleep() });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ pages: 0, prints: 0, oldestMs: null, nextCursor: null, stoppedBy: "maxPages" });
  });

  it("re-walking is idempotent and yields the same tx set", async () => {
    stubPagedFetch();
    const collect = async () => {
      const txs = new Set<string>();
      await walkPumpTradesBack(mint, { untilMs: 0, maxPages: 10, sleep: noSleep(), onPage: (p) => p.forEach((x) => txs.add(x.tx)) });
      return txs;
    };
    const first = await collect();
    const second = await collect();
    expect([...first].sort()).toEqual(["a1", "a2", "b1", "b2", "c1"]);
    expect(second).toEqual(first);
  });
});
