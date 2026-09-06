import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LighterTrade } from "../sources/lighter.js";
import {
  BACKOFF_MIN_MS,
  HEARTBEAT_MS,
  IDLE_UNSUBSCRIBE_MS,
  LIGHTER_WS_URL,
  LighterStream,
  SILENCE_LIMIT_MS,
  TRADE_RING,
  mergeTradeRing,
  parseChannel,
  type WebSocketLike
} from "./stream.js";

const START = 1_788_698_198_000;
const FRAMES: Array<Record<string, any>> = readFileSync(new URL("./__fixtures__/ws-frames-0.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const SNAPSHOT = FRAMES[1];
const BACKLOG = FRAMES[2];
const FIRST_DELTA = FRAMES[3];
const LIVE_BUY = FRAMES[5];
const LIVE_SELL = FRAMES[16];
const REMOVAL = FRAMES[10];

type Listener = (...args: unknown[]) => void;

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  pings = 0;
  private listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) {}
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
  terminate(): void {
    this.closed = true;
  }
  ping(): void {
    this.pings += 1;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  open(): void {
    this.emit("open");
  }
  message(frame: unknown): void {
    this.emit("message", Buffer.from(typeof frame === "string" ? frame : JSON.stringify(frame)));
  }
  json(): Array<Record<string, any>> {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

const active: LighterStream[] = [];

function harness(onTrades?: (marketId: number, trades: LighterTrade[]) => void) {
  const sockets: FakeSocket[] = [];
  const log = vi.fn();
  const stream = new LighterStream({
    log,
    onTrades,
    makeSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    }
  });
  active.push(stream);
  const last = () => sockets[sockets.length - 1]!;
  return { stream, sockets, log, last };
}

function openWithSnapshot() {
  const h = harness();
  h.stream.subscribe(0);
  h.last().open();
  h.last().message(SNAPSHOT);
  return h;
}

function syntheticTrade(id: number, time: number, buy = true): Record<string, unknown> {
  return { trade_id: id, tx_hash: `tx${id}`, market_id: 0, size: "1.0000", price: "2500.00", usd_amount: "2500", is_maker_ask: buy, timestamp: time };
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  while (active.length) active.pop()?.stop();
  vi.useRealTimers();
});

describe("parseChannel", () => {
  it("splits kind and market id and rejects anything else", () => {
    expect(parseChannel("order_book:12")).toEqual({ kind: "order_book", marketId: 12 });
    expect(parseChannel("trade:0")).toEqual({ kind: "trade", marketId: 0 });
    expect(parseChannel("order_book/0")).toBeNull();
    expect(parseChannel(undefined)).toBeNull();
  });
});

describe("LighterStream subscriptions", () => {
  it("opens one socket and sends order_book + trade subscribes per market once connected", () => {
    const { stream, sockets, last } = harness();
    stream.subscribe(0);
    stream.subscribe(0);
    expect(sockets).toHaveLength(1);
    expect(last().url).toBe(LIGHTER_WS_URL);
    expect(last().sent).toEqual([]);
    last().open();
    expect(last().json()).toEqual([
      { type: "subscribe", channel: "order_book/0" },
      { type: "subscribe", channel: "trade/0" }
    ]);
    stream.subscribe(25);
    expect(last().json().slice(2)).toEqual([
      { type: "subscribe", channel: "order_book/25" },
      { type: "subscribe", channel: "trade/25" }
    ]);
    expect(stream.status()).toMatchObject({ connected: true, markets: 2, reconnects: 0, framesIn: 0, lastError: null });
  });

  it("ignores invalid market ids", () => {
    const { stream, sockets } = harness();
    stream.subscribe(-1);
    stream.subscribe(1.5);
    expect(sockets).toHaveLength(0);
    expect(stream.status().markets).toBe(0);
  });

  it("unsubscribing the last market sends unsubscribes and closes the socket", () => {
    const { stream, last } = harness();
    stream.subscribe(0);
    last().open();
    stream.unsubscribe(0);
    expect(last().json().slice(2)).toEqual([
      { type: "unsubscribe", channel: "order_book/0" },
      { type: "unsubscribe", channel: "trade/0" }
    ]);
    expect(last().closed).toBe(true);
    expect(stream.status()).toMatchObject({ connected: false, markets: 0 });
  });
});

describe("LighterStream book merge", () => {
  it("replaces the book on subscribed/order_book and reports mid and spread", () => {
    const { stream } = openWithSnapshot();
    const book = stream.getBook(0, 5)!;
    expect(book.asks[0]).toEqual({ price: 2503.46, size: 0.7898 });
    expect(book.bids[0].price).toBe(2503.36);
    expect(book.asks).toHaveLength(5);
    expect(book.mid).toBeCloseTo(2503.41, 6);
    expect(book.spreadBps).toBeCloseTo((0.1 / 2503.41) * 10_000, 3);
    expect(book.updatedAt).toBe(START);
    expect(stream.marketStatus(0)).toMatchObject({ hasBook: true, lastBookAt: START, resyncs: 0 });
  });

  it("treats delta sizes as absolute replacements and size 0 as removal", () => {
    const { stream, last } = openWithSnapshot();
    last().message(FIRST_DELTA);
    expect(stream.getBook(0, 1)!.asks[0]).toEqual({ price: 2503.46, size: 0.69 });

    const before = stream.getBook(0, 25)!;
    expect(before.asks.some((level) => level.price === 2503.56)).toBe(true);
    for (const frame of FRAMES.slice(4, 11)) last().message(frame);
    const after = stream.getBook(0, 25)!;
    expect(REMOVAL.order_book.asks.some((level: { price: string; size: string }) => level.price === "2503.56" && Number(level.size) === 0)).toBe(true);
    expect(after.asks.some((level) => level.price === 2503.56)).toBe(false);
  });

  it("never crosses or holds zero sizes after replaying the whole capture", () => {
    const { stream, last } = harness();
    stream.subscribe(0);
    last().open();
    for (const frame of FRAMES) last().message(frame);
    const book = stream.getBook(0, 25)!;
    expect(book.bids[0].price).toBeLessThan(book.asks[0].price);
    expect([...book.asks, ...book.bids].every((level) => level.size > 0)).toBe(true);
    expect(book.asks.map((level) => level.price)).toEqual([...book.asks.map((level) => level.price)].sort((a, b) => a - b));
    expect(stream.status()).toMatchObject({ connected: true, framesIn: FRAMES.length, lastError: null });
  });

  it("resyncs on a broken nonce chain instead of trusting offsets, then rebuilds from the next snapshot", () => {
    const { stream, last, log } = openWithSnapshot();
    const skipped = { ...FRAMES[4], order_book: { ...FRAMES[4].order_book } };
    last().message(skipped);
    expect(stream.getBook(0)).toBeNull();
    expect(stream.marketStatus(0)).toMatchObject({ hasBook: false, resyncs: 1 });
    expect(last().json().slice(2)).toEqual([
      { type: "unsubscribe", channel: "order_book/0" },
      { type: "subscribe", channel: "order_book/0" }
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("nonce gap"));

    last().message(SNAPSHOT);
    last().message(FIRST_DELTA);
    expect(stream.getBook(0, 1)!.asks[0].size).toBe(0.69);
  });

  it("accepts non-consecutive offsets as long as the nonce chain holds", () => {
    const { stream, last } = openWithSnapshot();
    last().message(FIRST_DELTA);
    last().message(FRAMES[4]);
    last().message(FRAMES[6]);
    expect(FRAMES[6].offset - FRAMES[4].offset).toBeGreaterThan(1);
    expect(stream.marketStatus(0)!.resyncs).toBe(0);
    expect(stream.getBook(0)).not.toBeNull();
  });
});

describe("LighterStream trades", () => {
  it("keeps a newest-first ring deduped by trade id and notifies only accepted trades", () => {
    const onTrades = vi.fn();
    const { stream, last } = harness(onTrades);
    stream.subscribe(0);
    last().open();
    last().message(BACKLOG);
    last().message(BACKLOG);
    expect(stream.getTrades(0)).toHaveLength(50);
    expect(onTrades).toHaveBeenCalledTimes(1);
    expect(onTrades.mock.calls[0][1]).toHaveLength(50);
    expect(stream.getTrades(0, 1)[0].id).toBe("29600435205");

    last().message(LIVE_BUY);
    last().message(LIVE_SELL);
    const trades = stream.getTrades(0, 3);
    expect(trades.map((trade) => [trade.id, trade.takerSide])).toEqual([
      ["29600435591", "sell"],
      ["29600435298", "buy"],
      ["29600435205", "buy"]
    ]);
    expect(stream.getTrades(0)).toHaveLength(52);
    expect(stream.marketStatus(0)).toMatchObject({ trades: 52, lastTradeAt: START, liquidations: 0 });
  });

  it("bounds the ring at 500 and counts liquidation trades", () => {
    const { stream, last } = harness();
    stream.subscribe(0);
    last().open();
    const trades = Array.from({ length: 600 }, (_, i) => syntheticTrade(i, START - 600_000 + i * 1000));
    last().message({ channel: "trade:0", type: "update/trade", trades, liquidation_trades: [syntheticTrade(9_999, START + 1, false)] });
    const ring = stream.getTrades(0);
    expect(ring).toHaveLength(TRADE_RING);
    expect(ring[0]).toMatchObject({ id: "9999", liquidation: true, takerSide: "sell" });
    expect(ring[ring.length - 1].id).toBe("101");
    expect(stream.marketStatus(0)!.liquidations).toBe(1);
  });

  it("seeds REST history into the ring without notifying onTrades", () => {
    const onTrades = vi.fn();
    const { stream, last } = harness(onTrades);
    stream.subscribe(0);
    last().open();
    const seeded = stream.seedTrades(0, [{ id: "a", tx: "a", time: START, price: 1, size: 1, usd: 1, takerSide: "buy", liquidation: false }]);
    expect(seeded).toBe(1);
    expect(stream.getTrades(0)).toHaveLength(1);
    expect(onTrades).not.toHaveBeenCalled();
    expect(stream.seedTrades(99, [])).toBe(0);
  });

  it("mergeTradeRing frees dedupe slots for dropped trades", () => {
    const seen = new Set<string>();
    const make = (id: string, time: number): LighterTrade => ({ id, tx: id, time, price: 1, size: 1, usd: null, takerSide: "buy", liquidation: false });
    const first = mergeTradeRing([], seen, [make("1", 1), make("2", 2), make("3", 3)], 2);
    expect(first.ring.map((trade) => trade.id)).toEqual(["3", "2"]);
    expect(seen.has("1")).toBe(false);
    expect(mergeTradeRing(first.ring, seen, [make("2", 2)], 2).accepted).toEqual([]);
  });

  it("ignores frames for unknown channels and malformed payloads without throwing", () => {
    const { stream, last } = harness();
    stream.subscribe(0);
    last().open();
    last().message("not json");
    last().message({ channel: "trade:7", type: "update/trade", trades: [syntheticTrade(1, START)] });
    last().message({ type: "connected", session_id: "x" });
    expect(stream.status()).toMatchObject({ framesIn: 3, lastError: null });
    expect(stream.getTrades(0)).toEqual([]);
  });
});

describe("LighterStream reconnect and idle policy", () => {
  it("drops the book on close, reconnects with backoff, resubscribes and rebuilds from the next snapshot", () => {
    const { stream, sockets, last } = openWithSnapshot();
    last().message(BACKLOG);
    last().emit("close");
    expect(stream.status()).toMatchObject({ connected: false, reconnects: 1, lastError: "socket closed" });
    expect(stream.getBook(0)).toBeNull();
    expect(stream.getTrades(0)).toHaveLength(50);

    vi.advanceTimersByTime(BACKOFF_MIN_MS - 1);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    last().emit("close");
    vi.advanceTimersByTime(2 * BACKOFF_MIN_MS - 1);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    expect(stream.status().reconnects).toBe(2);

    last().open();
    expect(last().json()).toEqual([
      { type: "subscribe", channel: "order_book/0" },
      { type: "subscribe", channel: "trade/0" }
    ]);
    last().message(SNAPSHOT);
    expect(stream.getBook(0, 1)!.asks[0].size).toBe(0.7898);
    expect(stream.getTrades(0)).toHaveLength(50);

    last().emit("close");
    vi.advanceTimersByTime(BACKOFF_MIN_MS);
    expect(sockets).toHaveLength(4);
  });

  it("reconnects after 60s of silence", () => {
    const { stream, sockets, last } = harness();
    stream.subscribe(0);
    last().open();
    vi.advanceTimersByTime(SILENCE_LIMIT_MS - HEARTBEAT_MS);
    expect(last().pings).toBeGreaterThan(0);
    expect(stream.status().connected).toBe(true);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(stream.status()).toMatchObject({ connected: false, reconnects: 1, lastError: "no frame for 60s" });
    vi.advanceTimersByTime(BACKOFF_MIN_MS);
    expect(sockets).toHaveLength(2);
  });

  it("unsubscribes markets not touched for 10 minutes and keeps touched ones", () => {
    const { stream, last } = harness();
    stream.subscribe(0);
    stream.subscribe(25);
    last().open();
    /** Advances one heartbeat at a time, feeding a keepalive frame so the silence guard stays quiet. */
    const idle = (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += HEARTBEAT_MS) {
        vi.advanceTimersByTime(HEARTBEAT_MS);
        if (!last().closed) last().message({ type: "connected" });
      }
    };
    idle(IDLE_UNSUBSCRIBE_MS - HEARTBEAT_MS);
    expect(stream.isSubscribed(0)).toBe(true);
    stream.touch(25);
    idle(HEARTBEAT_MS);
    expect(stream.isSubscribed(0)).toBe(false);
    expect(stream.isSubscribed(25)).toBe(true);
    expect(last().json()).toContainEqual({ type: "unsubscribe", channel: "order_book/0" });
    expect(last().json()).not.toContainEqual({ type: "unsubscribe", channel: "trade/25" });
    expect(last().closed).toBe(false);
    expect(stream.status().reconnects).toBe(0);

    idle(IDLE_UNSUBSCRIBE_MS);
    expect(stream.status().markets).toBe(0);
    expect(last().closed).toBe(true);
  });

  it("stop() closes the socket and forgets markets; subscribe afterwards starts fresh", () => {
    const { stream, sockets, last } = openWithSnapshot();
    stream.stop();
    expect(last().closed).toBe(true);
    expect(stream.status()).toMatchObject({ connected: false, markets: 0 });
    stream.subscribe(0);
    expect(sockets).toHaveLength(2);
  });
});
