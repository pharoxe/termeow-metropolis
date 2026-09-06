import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKOFF_MAX_MS, HEARTBEAT_MS, SILENCE_LIMIT_MS, SolanaLogSubscriber, wsUrlFor, type WebSocketLike } from "./subscribe.js";

const MINT_A = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const MINT_B = "So11111111111111111111111111111111111111112";
const RPC = "https://mainnet.helius-rpc.com/?api-key=secret";
const START = 1_800_000_000_000;

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
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }
  json(): Array<Record<string, any>> {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

function notification(subscription: number, signature: string, slot: number, err: unknown = null) {
  return { jsonrpc: "2.0", method: "logsNotification", params: { subscription, result: { context: { slot }, value: { signature, err, logs: [] } } } };
}

function harness() {
  const sockets: FakeSocket[] = [];
  const log = vi.fn();
  const subscriber = new SolanaLogSubscriber({
    rpcUrl: RPC,
    log,
    makeSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    }
  });
  const last = () => sockets[sockets.length - 1]!;
  return { subscriber, sockets, log, last };
}

/** Opens the socket and answers every pending logsSubscribe with sequential subscription ids starting at `firstSubId`. */
function openAndAck(socket: FakeSocket, firstSubId = 100): Map<string, number> {
  socket.open();
  const ids = new Map<string, number>();
  socket.json().filter((frame) => frame.method === "logsSubscribe").forEach((frame, index) => {
    const subId = firstSubId + index;
    ids.set(frame.params[0].mentions[0], subId);
    socket.message({ jsonrpc: "2.0", id: frame.id, result: subId });
  });
  return ids;
}

const active: SolanaLogSubscriber[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  while (active.length) active.pop()?.close();
  vi.useRealTimers();
});

describe("wsUrlFor", () => {
  it("swaps the scheme and keeps the query string", () => {
    expect(wsUrlFor(RPC)).toBe("wss://mainnet.helius-rpc.com/?api-key=secret");
    expect(wsUrlFor("https://api.mainnet-beta.solana.com")).toBe("wss://api.mainnet-beta.solana.com/");
    expect(wsUrlFor("http://localhost:8899")).toBe("ws://localhost:8899/");
  });
});

describe("SolanaLogSubscriber", () => {
  it("opens one socket, sends logsSubscribe per mint and routes notifications by subscription id", () => {
    const { subscriber, sockets, last } = harness();
    active.push(subscriber);
    const onA = vi.fn();
    const onB = vi.fn();
    subscriber.subscribe(MINT_A, onA);
    subscriber.subscribe(MINT_B, onB);

    expect(sockets).toHaveLength(1);
    expect(last().url).toBe("wss://mainnet.helius-rpc.com/?api-key=secret");
    expect(subscriber.status().connected).toBe(false);

    const ids = openAndAck(last());
    expect(last().json()).toEqual([
      { jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [MINT_A] }, { commitment: "confirmed" }] },
      { jsonrpc: "2.0", id: 2, method: "logsSubscribe", params: [{ mentions: [MINT_B] }, { commitment: "confirmed" }] }
    ]);
    expect(subscriber.status()).toMatchObject({ connected: true, mints: 2, reconnects: 0, lastFrameAt: START, lastError: null });

    last().message(notification(ids.get(MINT_B)!, "sigB", 42));
    last().message(notification(ids.get(MINT_A)!, "sigA", 43));
    expect(onB).toHaveBeenCalledWith("sigB", 42);
    expect(onA).toHaveBeenCalledWith("sigA", 43);
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).toHaveBeenCalledTimes(1);
  });

  it("ignores failed transactions, unknown subscriptions and malformed frames", () => {
    const { subscriber, last, log } = harness();
    active.push(subscriber);
    const onA = vi.fn();
    subscriber.subscribe(MINT_A, onA);
    const ids = openAndAck(last());

    last().message(notification(ids.get(MINT_A)!, "failed", 1, { InstructionError: [0, "Custom"] }));
    last().message(notification(999, "orphan", 2));
    last().emit("message", Buffer.from("not json"));
    expect(onA).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("never throws from handlers when a signature callback throws", () => {
    const { subscriber, last } = harness();
    active.push(subscriber);
    subscriber.subscribe(MINT_A, () => {
      throw new Error("boom");
    });
    const ids = openAndAck(last());
    expect(() => last().message(notification(ids.get(MINT_A)!, "sig", 1))).not.toThrow();
    expect(subscriber.status().lastError).toContain("boom");
    expect(subscriber.status().connected).toBe(true);
  });

  it("records subscribe errors from the RPC", () => {
    const { subscriber, last } = harness();
    active.push(subscriber);
    subscriber.subscribe(MINT_A, vi.fn());
    last().open();
    last().message({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } });
    expect(subscriber.status().lastError).toBe(`logsSubscribe ${MINT_A}: Invalid params`);
  });

  it("unsubscribe sends logsUnsubscribe and closes the socket once no mints remain", () => {
    const { subscriber, sockets, last } = harness();
    active.push(subscriber);
    subscriber.subscribe(MINT_A, vi.fn());
    subscriber.subscribe(MINT_B, vi.fn());
    const ids = openAndAck(last());

    subscriber.unsubscribe(MINT_A);
    expect(last().json().at(-1)).toEqual({ jsonrpc: "2.0", id: 3, method: "logsUnsubscribe", params: [ids.get(MINT_A)] });
    expect(last().closed).toBe(false);
    expect(subscriber.status().mints).toBe(1);

    subscriber.unsubscribe(MINT_B);
    expect(last().closed).toBe(true);
    expect(subscriber.status()).toMatchObject({ connected: false, mints: 0 });

    last().emit("close");
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    expect(sockets).toHaveLength(1);
  });

  it("reconnects with growing backoff and re-subscribes every mint", () => {
    const { subscriber, sockets, last } = harness();
    active.push(subscriber);
    const onA = vi.fn();
    subscriber.subscribe(MINT_A, onA);
    subscriber.subscribe(MINT_B, vi.fn());
    openAndAck(last());

    last().emit("close");
    expect(subscriber.status()).toMatchObject({ connected: false, reconnects: 1, lastError: "socket closed" });
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    last().emit("close");
    vi.advanceTimersByTime(1_999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    last().emit("error", new Error("ECONNRESET"));
    expect(subscriber.status().lastError).toContain("ECONNRESET");
    vi.advanceTimersByTime(3_999);
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);
    expect(subscriber.status().reconnects).toBe(3);

    const ids = openAndAck(last(), 200);
    expect(last().json().map((frame) => frame.method)).toEqual(["logsSubscribe", "logsSubscribe"]);
    expect(last().json().map((frame) => frame.params[0].mentions[0])).toEqual([MINT_A, MINT_B]);
    last().message(notification(ids.get(MINT_A)!, "after-reconnect", 7));
    expect(onA).toHaveBeenCalledWith("after-reconnect", 7);

    last().emit("close");
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(5);
  });

  it("caps the backoff at 30s", () => {
    const { subscriber, sockets, last } = harness();
    active.push(subscriber);
    subscriber.subscribe(MINT_A, vi.fn());
    for (let attempt = 0; attempt < 6; attempt += 1) {
      last().emit("close");
      vi.advanceTimersByTime(BACKOFF_MAX_MS);
    }
    const before = sockets.length;
    last().emit("close");
    vi.advanceTimersByTime(BACKOFF_MAX_MS - 1);
    expect(sockets).toHaveLength(before);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(before + 1);
  });

  it("pings every 30s and forces a reconnect after 90s without any frame", () => {
    const { subscriber, sockets, last } = harness();
    active.push(subscriber);
    subscriber.subscribe(MINT_A, vi.fn());
    const first = last();
    openAndAck(first);

    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(first.pings).toBe(1);
    first.emit("pong");
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    expect(first.pings).toBe(3);
    expect(first.closed).toBe(false);

    vi.advanceTimersByTime(SILENCE_LIMIT_MS - HEARTBEAT_MS * 2);
    expect(first.closed).toBe(true);
    expect(subscriber.status()).toMatchObject({ connected: false, lastError: "no frame for 90s" });
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    expect(last().json().map((frame) => frame.method)).toEqual([]);
    last().open();
    expect(last().json().map((frame) => frame.method)).toEqual(["logsSubscribe"]);
  });

  it("close stops timers and later subscribes start a fresh socket", () => {
    const { subscriber, sockets, last } = harness();
    active.push(subscriber);
    subscriber.subscribe(MINT_A, vi.fn());
    openAndAck(last());
    last().emit("close");

    subscriber.close();
    expect(subscriber.status().connected).toBe(false);
    vi.advanceTimersByTime(SILENCE_LIMIT_MS * 3);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.pings).toBe(0);

    subscriber.subscribe(MINT_B, vi.fn());
    expect(sockets).toHaveLength(2);
    expect(subscriber.status().mints).toBe(2);
  });
});
