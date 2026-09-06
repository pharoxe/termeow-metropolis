import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import details from "../lighter/__fixtures__/orderBookDetails.json";
import stats from "../lighter/__fixtures__/exchangeStats.json";
import recentTrades from "../lighter/__fixtures__/recentTrades-0.json";
import bookOrders from "../lighter/__fixtures__/orderBookOrders-0.json";
import fundings from "../lighter/__fixtures__/fundings-0.json";
import {
  LIGHTER_API_BASE,
  MARKETS_TTL_MS,
  fetchFunding,
  fetchMarkets,
  getMarkets,
  parseBookOrders,
  parseFunding,
  parseMarkets,
  parseTrade,
  parseTrades,
  resetLighterCache
} from "./lighter.js";

const START = 1_788_698_200_000;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: string | URL | Request) => handler(String(input)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function byPath(url: string): Response {
  if (url.includes("/orderBookDetails")) return jsonResponse(details);
  if (url.includes("/exchangeStats")) return jsonResponse(stats);
  return jsonResponse({}, 404);
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetLighterCache();
});

describe("parseMarkets", () => {
  it("normalizes orderBookDetails rows and sorts by marketId", () => {
    const markets = parseMarkets(details, stats);
    expect(markets.map((market) => market.marketId)).toEqual([25, 43, 90, 103, 207]);
    const bnb = markets[0];
    expect(bnb).toMatchObject({ symbol: "BNB", status: "active", markPrice: 757.4527, indexPrice: 757.059, lastPrice: 757.5422, volume24Usd: 8904208.786743, trades24: 6954, sizeDecimals: 2, priceDecimals: 4 });
    expect(bnb.change24Pct).toBeCloseTo(-0.6311, 4);
  });

  it("prefers exchangeStats daily_price_change by symbol and skips stats-only symbols", () => {
    const merged = parseMarkets(details, { order_book_stats: [{ symbol: "BNB", daily_price_change: 1.5, last_trade_price: 1 }, { symbol: "GHOST", daily_price_change: 9 }] });
    expect(merged.find((market) => market.symbol === "BNB")?.change24Pct).toBe(1.5);
    expect(merged.find((market) => market.symbol === "BNB")?.lastPrice).toBe(757.5422);
    expect(merged.some((market) => market.symbol === "GHOST")).toBe(false);
  });

  it("keeps nulls honest: zero prices and missing numbers become null", () => {
    const [market] = parseMarkets({ order_book_details: [{ symbol: "NEW", market_id: 7, status: "active", last_trade_price: 0, mark_price: "0", daily_trades_count: 0 }] }, {});
    expect(market).toMatchObject({ marketId: 7, lastPrice: null, markPrice: null, indexPrice: null, change24Pct: null, volume24Usd: null, trades24: 0, sizeDecimals: 0 });
  });

  it("drops rows without a usable market_id or symbol and tolerates garbage bodies", () => {
    expect(parseMarkets({ order_book_details: [{ symbol: "X" }, { market_id: 1 }, null] }, null)).toEqual([]);
    expect(parseMarkets(undefined, "nope")).toEqual([]);
  });
});

describe("parseTrades", () => {
  it("normalizes recentTrades and maps is_maker_ask to the taker side", () => {
    const trades = parseTrades(recentTrades);
    expect(trades).toHaveLength(20);
    expect(trades[0]).toEqual({
      id: "29600423478",
      tx: "e527fe5d8fe4389b87596cca761503d076d9c1b7921d6ce6625df0fe11c21c3cc18b9e53281d8bb6",
      time: 1788698180173,
      price: 2503.75,
      size: 0.2995,
      usd: 749.873125,
      takerSide: "buy",
      liquidation: false
    });
    expect(trades.filter((trade) => trade.takerSide === "buy")).toHaveLength(12);
    expect(trades.filter((trade) => trade.takerSide === "sell")).toHaveLength(8);
  });

  it("flags liquidation_trades and drops rows missing load-bearing fields", () => {
    const frame = { trades: [{ trade_id: 1, price: "1", size: "1", timestamp: 5, is_maker_ask: false }], liquidation_trades: [{ trade_id: 2, price: "2", size: "1", timestamp: 6, is_maker_ask: true }] };
    const trades = parseTrades(frame);
    expect(trades.map((trade) => [trade.id, trade.takerSide, trade.liquidation, trade.usd, trade.tx])).toEqual([
      ["1", "sell", false, null, "1"],
      ["2", "buy", true, null, "2"]
    ]);
    expect(parseTrade({ trade_id: 3, price: "x", size: "1", timestamp: 1 })).toBeNull();
    expect(parseTrade(null)).toBeNull();
    expect(parseTrades(undefined)).toEqual([]);
  });
});

describe("parseBookOrders", () => {
  it("sums per-order rows into price levels, asks ascending and bids descending, capped at depth", () => {
    const book = parseBookOrders(bookOrders, 3);
    expect(book.asks.map((level) => level.price)).toEqual([2503.84, 2503.85, 2503.87]);
    expect(book.asks[0].size).toBeCloseTo(0.816 + 0.5087, 6);
    expect(book.bids.map((level) => level.price)).toEqual([2503.73, 2503.68, 2503.64]);
    expect(book.bids[0].size).toBeCloseTo(0.0101, 6);
  });

  it("ignores zero-size or unparseable orders and empty bodies", () => {
    expect(parseBookOrders({ asks: [{ price: "1", remaining_base_amount: "0" }, { price: "x", remaining_base_amount: "1" }], bids: null })).toEqual({ asks: [], bids: [] });
    expect(parseBookOrders(null)).toEqual({ asks: [], bids: [] });
  });
});

describe("parseFunding", () => {
  it("returns the latest row with the rate as a number and the timestamp in ms", () => {
    expect(parseFunding(fundings)).toEqual({ rate: 0.0012, direction: "long", at: 1788692400000 });
  });

  it("returns null when there are no usable rows", () => {
    expect(parseFunding({ fundings: [] })).toBeNull();
    expect(parseFunding({ fundings: [{ timestamp: 1, rate: "nan" }] })).toBeNull();
    expect(parseFunding(null)).toBeNull();
  });
});

describe("fetchMarkets / getMarkets", () => {
  it("fetches both endpoints and merges them", async () => {
    const spy = stubFetch(byPath);
    const markets = await fetchMarkets();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((call) => String(call[0])).sort()).toEqual([`${LIGHTER_API_BASE}/exchangeStats`, `${LIGHTER_API_BASE}/orderBookDetails`]);
    expect(markets).toHaveLength(5);
  });

  it("caches for 30s, dedupes in-flight calls and keeps the last good list on failure", async () => {
    let failing = false;
    const spy = stubFetch((url) => (failing ? jsonResponse({ message: "down" }, 503) : byPath(url)));
    const [first, second] = await Promise.all([getMarkets(), getMarkets()]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(first.stale).toBe(false);
    expect(second.value).toBe(first.value);

    vi.setSystemTime(START + MARKETS_TTL_MS - 1);
    await getMarkets();
    expect(spy).toHaveBeenCalledTimes(2);

    failing = true;
    vi.setSystemTime(START + MARKETS_TTL_MS + 1);
    const stale = await getMarkets();
    expect(spy).toHaveBeenCalledTimes(4);
    expect(stale).toMatchObject({ stale: true, error: "Upstream returned 503", observedAt: START });
    expect(stale.value).toHaveLength(5);
  });

  it("returns an empty list with error instead of throwing before the first success", async () => {
    stubFetch(() => jsonResponse({}, 500));
    const result = await getMarkets();
    expect(result).toEqual({ value: [], observedAt: null, stale: true, error: "Upstream returned 500" });
  });
});

describe("fetchFunding", () => {
  it("asks for the last 3h at 1h resolution with count_back=2 and returns the latest row", async () => {
    const spy = stubFetch(() => jsonResponse(fundings));
    const funding = await fetchFunding(0);
    const url = new URL(String(spy.mock.calls[0][0]));
    const end = Math.floor(START / 1000);
    expect(url.pathname.endsWith("/fundings")).toBe(true);
    expect(Object.fromEntries(url.searchParams)).toEqual({ market_id: "0", resolution: "1h", start_timestamp: String(end - 10800), end_timestamp: String(end), count_back: "2" });
    expect(funding).toEqual({ rate: 0.0012, direction: "long", at: 1788692400000 });
  });
});
