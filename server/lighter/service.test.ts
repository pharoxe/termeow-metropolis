import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBookOrders, parseTrades, type LighterMarket } from "../sources/lighter.js";
import bookOrders from "./__fixtures__/orderBookOrders-0.json";
import recentTrades from "./__fixtures__/recentTrades-0.json";
import { BOOK_REST_TTL_MS, FUNDING_TTL_MS, LighterService, TAKER_SIDE_LABEL, getLighterService, resetLighterService } from "./service.js";
import type { WebSocketLike } from "./stream.js";

const START = 1_788_698_190_000;
const FRAMES: Array<Record<string, any>> = readFileSync(new URL("./__fixtures__/ws-frames-0.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const TRADES = parseTrades(recentTrades);
const MARKET: LighterMarket = { marketId: 0, symbol: "ETH", status: "active", markPrice: 2503, indexPrice: 2503, lastPrice: 2503, change24Pct: 1, volume24Usd: 1, trades24: 1, sizeDecimals: 4, priceDecimals: 2 };

type Listener = (...args: unknown[]) => void;

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  message(frame: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const api = {
    getMarkets: vi.fn(async () => ({ value: [MARKET], observedAt: START, stale: false })),
    fetchRecentTrades: vi.fn(async () => TRADES),
    fetchBookSnapshot: vi.fn(async (_id: number, depth?: number) => parseBookOrders(bookOrders, depth)),
    fetchFunding: vi.fn(async () => ({ rate: 0.0012, direction: "long", at: START - 1000 }))
  };
  const service = new LighterService({
    api,
    log: vi.fn(),
    makeSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }
  });
  const last = () => sockets[sockets.length - 1]!;
  return { service, api, sockets, last };
}

const active: LighterService[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  while (active.length) active.pop()?.stop();
  resetLighterService();
  vi.useRealTimers();
});

describe("LighterService", () => {
  it("markets() passes the cached result through and never throws", async () => {
    const { service, api } = harness();
    active.push(service);
    expect(await service.markets()).toEqual({ markets: [MARKET], observedAt: START, stale: false });
    api.getMarkets.mockRejectedValueOnce(new Error("boom"));
    expect(await service.markets()).toEqual({ markets: [], observedAt: null, stale: true, error: "boom" });
  });

  it("book() starts the stream, falls back to REST until a snapshot arrives, then serves the merged book", async () => {
    const { service, api, sockets, last } = harness();
    active.push(service);
    const rest = await service.book(0, 3);
    expect(sockets).toHaveLength(1);
    expect(api.fetchBookSnapshot).toHaveBeenCalledWith(0, 3);
    expect(rest).toMatchObject({ marketId: 0, source: "rest", stale: true, updatedAt: START });
    expect(rest.asks.map((level) => level.price)).toEqual([2503.84, 2503.85, 2503.87]);
    expect(rest.mid).toBeCloseTo((2503.84 + 2503.73) / 2, 6);

    last().emit("open");
    last().message(FRAMES[1]);
    const live = await service.book(0, 2);
    expect(live).toMatchObject({ source: "stream", updatedAt: START });
    expect(live.asks).toHaveLength(2);
    expect(live.asks[0]).toEqual({ price: 2503.46, size: 0.7898 });
    expect(live.stale).toBeUndefined();
    expect(api.fetchBookSnapshot).toHaveBeenCalledTimes(1);
  });

  it("book() reports REST failures as an error field with empty sides", async () => {
    const { service, api } = harness();
    active.push(service);
    api.fetchBookSnapshot.mockRejectedValueOnce(new Error("offline"));
    expect(await service.book(0)).toEqual({ marketId: 0, asks: [], bids: [], mid: null, spreadBps: null, updatedAt: null, source: null, stale: true, error: "offline" });
  });

  it("book() shares one REST snapshot across concurrent polls and reuses it for BOOK_REST_TTL_MS, but never retains a failure", async () => {
    const { service, api } = harness();
    active.push(service);
    const [first, second] = await Promise.all([service.book(0, 3), service.book(0, 3)]);
    expect(api.fetchBookSnapshot).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);

    vi.setSystemTime(START + BOOK_REST_TTL_MS - 1);
    expect((await service.book(0, 3)).updatedAt).toBe(START);
    expect(api.fetchBookSnapshot).toHaveBeenCalledTimes(1);
    expect((await service.book(0, 2)).asks).toHaveLength(2);
    expect(api.fetchBookSnapshot).toHaveBeenCalledTimes(2);

    vi.setSystemTime(START + BOOK_REST_TTL_MS);
    expect((await service.book(0, 3)).updatedAt).toBe(START + BOOK_REST_TTL_MS);
    expect(api.fetchBookSnapshot).toHaveBeenCalledTimes(3);

    vi.setSystemTime(START + 2 * BOOK_REST_TTL_MS);
    api.fetchBookSnapshot.mockRejectedValueOnce(new Error("offline"));
    expect((await service.book(0, 3)).error).toBe("offline");
    expect((await service.book(0, 3)).source).toBe("rest");
    expect(api.fetchBookSnapshot).toHaveBeenCalledTimes(5);
  });

  it("rejects invalid market ids without touching the network", async () => {
    const { service, api, sockets } = harness();
    active.push(service);
    expect((await service.book(-1)).error).toBe("invalid marketId");
    expect((await service.trades(1.5)).error).toBe("invalid marketId");
    expect((await service.flow(Number.NaN)).error).toBe("invalid marketId");
    expect((await service.funding(-2)).error).toBe("invalid marketId");
    expect(sockets).toHaveLength(0);
    expect(api.fetchRecentTrades).not.toHaveBeenCalled();
  });

  it("bootstraps once from recentTrades so trades() and flow() are populated before any live frame", async () => {
    const { service, api } = harness();
    active.push(service);
    const trades = await service.trades(0, 5);
    expect(api.fetchRecentTrades).toHaveBeenCalledTimes(1);
    expect(api.fetchRecentTrades).toHaveBeenCalledWith(0, 100);
    expect(trades).toMatchObject({ marketId: 0, source: "stream", population: TAKER_SIDE_LABEL });
    expect(trades.trades).toHaveLength(5);
    expect(trades.trades[0].id).toBe("29600423478");

    const flow = await service.flow(0, "1m");
    expect(api.fetchRecentTrades).toHaveBeenCalledTimes(1);
    expect(flow.error).toBeUndefined();
    expect(flow.windows.find((window) => window.label === "1m")).toMatchObject({ buys: 12, sells: 8 });
    expect(flow.bars).toHaveLength(1);
    expect(flow.coverage.firstPrintAt).toBe(Math.min(...TRADES.map((trade) => trade.time)));
    expect(service.status(0)).toMatchObject({ bootstrapped: [0], market: { trades: 20 } });
  });

  it("retries the bootstrap after a failure and surfaces the error as stale", async () => {
    const { service, api } = harness();
    active.push(service);
    api.fetchRecentTrades.mockRejectedValueOnce(new Error("429"));
    const failed = await service.trades(0);
    expect(failed).toMatchObject({ trades: [], source: null, stale: true, error: "429" });
    const ok = await service.trades(0);
    expect(api.fetchRecentTrades).toHaveBeenCalledTimes(2);
    expect(ok.trades).toHaveLength(20);
    expect(ok.error).toBeUndefined();
  });

  it("live trade frames flow into the ledger through the stream", async () => {
    const { service, last } = harness();
    active.push(service);
    await service.flow(0, "1m");
    last().emit("open");
    last().message(FRAMES[2]);
    const flow = await service.flow(0, "1m");
    const backlog = parseTrades(FRAMES[2]);
    const unique = new Set([...TRADES, ...backlog].map((trade) => trade.id)).size;
    expect(unique).toBeGreaterThan(TRADES.length);
    const hour = flow.windows.find((window) => window.label === "1h")!;
    expect(hour.buys + hour.sells).toBe(unique);
    expect(service.status(0).market).toMatchObject({ trades: unique });
  });

  it("flow() rejects unknown intervals without throwing", async () => {
    const { service } = harness();
    active.push(service);
    expect(await service.flow(0, "7m")).toMatchObject({ marketId: 0, interval: "7m", bars: [], windows: [], error: "unknown flow interval: 7m" });
  });

  it("funding() caches per market for 5 minutes and keeps the last good value on failure", async () => {
    const { service, api } = harness();
    active.push(service);
    const first = await service.funding(0);
    expect(first).toEqual({ marketId: 0, funding: { rate: 0.0012, direction: "long", at: START - 1000 }, observedAt: START, stale: false });
    await service.funding(0);
    expect(api.fetchFunding).toHaveBeenCalledTimes(1);

    vi.setSystemTime(START + FUNDING_TTL_MS + 1);
    api.fetchFunding.mockRejectedValueOnce(new Error("down"));
    const stale = await service.funding(0);
    expect(stale).toMatchObject({ funding: first.funding, observedAt: START, stale: true, error: "down" });
    api.fetchFunding.mockRejectedValueOnce(new Error("down"));
    expect(await service.funding(1)).toEqual({ marketId: 1, funding: null, observedAt: null, stale: true, error: "down" });
  });

  it("getLighterService() is a lazy singleton that opens no socket until a market is requested", () => {
    const service = getLighterService();
    expect(getLighterService()).toBe(service);
    expect(service.status()).toMatchObject({ stream: { connected: false, markets: 0 }, bootstrapped: [] });
  });
});
