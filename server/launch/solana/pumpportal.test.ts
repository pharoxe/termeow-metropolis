import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketLike } from "../../tape/solana/subscribe.js";
import { BACKOFF_MAX_MS, IDLE_CHECK_MS, IDLE_LIMIT_MS, PUMPPORTAL_URL, PumpPortalNewTokens, RING_SIZE, parseCreateFrame } from "./pumpportal.js";

const START = 1_800_000_000_000;
const SUBSCRIBE = JSON.stringify({ method: "subscribeNewToken" });

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
}

/** Every captured frame (2 acks + 11 creates) in arrival order, without our receivedAt stamp. */
const FIXTURE_FRAMES: Array<Record<string, unknown>> = readFileSync(new URL("../__fixtures__/pumpportal-newtoken.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const { receivedAt: _receivedAt, ...frame } = JSON.parse(line) as Record<string, unknown>;
    return frame;
  });
const CREATE_FRAMES = FIXTURE_FRAMES.filter((frame) => frame.txType === "create");

function harness(onLaunch?: (launch: unknown) => void) {
  const sockets: FakeSocket[] = [];
  const log = vi.fn();
  const client = new PumpPortalNewTokens({
    log,
    onLaunch,
    makeSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    }
  });
  const last = () => sockets[sockets.length - 1]!;
  return { client, sockets, log, last };
}

const active: PumpPortalNewTokens[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  while (active.length) active.pop()?.stop();
  vi.useRealTimers();
});

describe("parseCreateFrame", () => {
  it("maps the verified create keys and stamps createdAt with the receive time", () => {
    expect(parseCreateFrame(CREATE_FRAMES[0], START)).toEqual({
      chain: "solana",
      launchpad: "pump.fun",
      token: "43F8mXf6iejR6VLQmD65UAg49MpL5yL8suHGtUj4pump",
      creator: "GSENXFmXHcKApbBKg5fqjwtkEaigHp8q63vAudp2t4g9",
      name: "Freaky ah",
      symbol: "kittylick",
      uri: "https://ipfs.io/ipfs/QmPu43X8aQEhg92SpWcvr1K7cVpJfoS5UMvQ9XqdcNfi9x",
      createdAt: START,
      initialBuySol: 0.097774557,
      initialBuyTokens: 3485709.524202,
      marketCapSol: 28.14153567166915,
      mayhemMode: true,
      tx: "48RAofjjvmDDvhc4D2caC6uqKXBm1FQCVDz3c65Y56sKe8EXLQzEKBwG13qjTvfFYWczMiAAMs2nBjteh1D62vey",
      curve: "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s",
      pool: "pump"
    });
  });

  it("returns null for acks, API-key notices, non-create frames and frames missing identity", () => {
    expect(parseCreateFrame(FIXTURE_FRAMES[0], START)).toBeNull();
    expect(parseCreateFrame({ errors: ["This feature is only available with an API key"] }, START)).toBeNull();
    expect(parseCreateFrame({ ...CREATE_FRAMES[0], txType: "buy" }, START)).toBeNull();
    expect(parseCreateFrame({ ...CREATE_FRAMES[0], mint: "" }, START)).toBeNull();
    expect(parseCreateFrame({ ...CREATE_FRAMES[0], signature: undefined }, START)).toBeNull();
    expect(parseCreateFrame("create", START)).toBeNull();
    expect(parseCreateFrame(null, START)).toBeNull();
  });

  it("keeps missing numerics and flags as null instead of inventing them", () => {
    const { solAmount: _s, initialBuy: _i, marketCapSol: _m, is_mayhem_mode: _f, ...bare } = CREATE_FRAMES[1]!;
    const launch = parseCreateFrame(bare, START);
    expect(launch).toMatchObject({ initialBuySol: null, initialBuyTokens: null, marketCapSol: null, mayhemMode: null });
    expect(parseCreateFrame({ ...CREATE_FRAMES[1], solAmount: "nope" }, START)?.initialBuySol).toBeNull();
  });

  /** Shapes from the 2026-09-06 live capture report: bonk creates carry no bondingCurveKey/name/symbol; established mints arrive create-shaped without a curve. */
  it("drops creates outside the pump pool and creates without a bonding curve instead of labelling them pump.fun", () => {
    const { bondingCurveKey: _c, name: _n, symbol: _y, ...bonk } = CREATE_FRAMES[0]!;
    expect(parseCreateFrame({ ...bonk, pool: "bonk" }, START)).toBeNull();
    expect(parseCreateFrame({ ...CREATE_FRAMES[0], pool: "bonk" }, START)).toBeNull();
    expect(parseCreateFrame({ ...CREATE_FRAMES[0], pool: undefined }, START)).toBeNull();
    expect(parseCreateFrame({ ...CREATE_FRAMES[0], mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", bondingCurveKey: undefined }, START)).toBeNull();
    expect(parseCreateFrame({ ...CREATE_FRAMES[0], bondingCurveKey: " " }, START)).toBeNull();
    expect(parseCreateFrame(CREATE_FRAMES[0], START)).not.toBeNull();
  });
});

describe("PumpPortalNewTokens", () => {
  it("opens one socket to PumpPortal, sends only subscribeNewToken and collects fixture creates newest first", () => {
    const seen: unknown[] = [];
    const { client, sockets, last } = harness((launch) => seen.push(launch));
    active.push(client);
    client.start();
    client.start();
    expect(sockets).toHaveLength(1);
    expect(last().url).toBe(PUMPPORTAL_URL);
    expect(client.status().connected).toBe(false);

    last().open();
    expect(last().sent).toEqual([SUBSCRIBE]);
    expect(client.status()).toMatchObject({ connected: true, launches: 0, reconnects: 0, lastError: null });

    FIXTURE_FRAMES.forEach((frame, index) => {
      vi.setSystemTime(START + index * 1_000);
      last().message(frame);
    });
    const recent = client.recent();
    expect(recent).toHaveLength(11);
    expect(recent[0]!.token).toBe("HWWPm3uTban6k4QXLFmjvQ9ZEPuvoaHxefRQEp1Hpump");
    expect(recent[10]!.token).toBe("43F8mXf6iejR6VLQmD65UAg49MpL5yL8suHGtUj4pump");
    expect(recent[0]!.createdAt).toBe(START + 12_000);
    expect(client.recent(2)).toHaveLength(2);
    expect(seen).toHaveLength(11);
    expect(client.status()).toMatchObject({ launches: 11, framesSeen: 13, lastFrameAt: START + 12_000, lastLaunchAt: START + 12_000, lastError: null });
    expect(last().sent.every((frame) => frame === SUBSCRIBE)).toBe(true);
  });

  it("ignores malformed frames and API-key notices, dedupes a re-delivered mint, and survives a throwing listener", () => {
    const { client, last, log } = harness(() => {
      throw new Error("listener boom");
    });
    active.push(client);
    client.start();
    last().open();
    last().emit("message", Buffer.from("not json"));
    last().message({ errors: ["This feature is only available with an API key"] });
    last().message({ ...CREATE_FRAMES[0], pool: "bonk", bondingCurveKey: undefined });
    expect(client.recent()).toHaveLength(0);
    expect(client.status().framesSeen).toBe(3);
    expect(log).not.toHaveBeenCalled();

    expect(() => last().message(CREATE_FRAMES[0])).not.toThrow();
    expect(client.status().lastError).toContain("listener boom");
    last().message(CREATE_FRAMES[0]);
    expect(client.recent()).toHaveLength(1);
    expect(client.status().connected).toBe(true);
  });

  it("bounds the ring at 1,000 newest launches", () => {
    const { client, last } = harness();
    active.push(client);
    client.start();
    last().open();
    for (let index = 0; index < RING_SIZE + 5; index += 1) {
      last().message({ ...CREATE_FRAMES[0], mint: `mint${index}`, signature: `sig${index}` });
    }
    const all = client.recent(RING_SIZE * 2);
    expect(all).toHaveLength(RING_SIZE);
    expect(all[0]!.token).toBe(`mint${RING_SIZE + 4}`);
    expect(all[RING_SIZE - 1]!.token).toBe("mint5");
    expect(client.status().launches).toBe(RING_SIZE);
  });

  it("reconnects with growing backoff capped at 30s and re-sends subscribeNewToken on every open", () => {
    const { client, sockets, last } = harness();
    active.push(client);
    client.start();
    last().open();

    last().emit("close");
    expect(client.status()).toMatchObject({ connected: false, reconnects: 1, lastError: "socket closed" });
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    last().emit("error", new Error("ECONNRESET"));
    expect(client.status().lastError).toContain("ECONNRESET");
    vi.advanceTimersByTime(1_999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    last().open();
    expect(last().sent).toEqual([SUBSCRIBE]);
    last().message(CREATE_FRAMES[2]);
    expect(client.recent()[0]!.token).toBe(CREATE_FRAMES[2]!.mint);

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
    expect(sockets.flatMap((socket) => socket.sent).every((frame) => frame === SUBSCRIBE)).toBe(true);
  });

  it("pings while frames flow and forces a reconnect after 120s of silence", () => {
    const { client, sockets, last } = harness();
    active.push(client);
    client.start();
    const first = last();
    first.open();

    vi.advanceTimersByTime(IDLE_CHECK_MS);
    expect(first.pings).toBe(1);
    vi.advanceTimersByTime(IDLE_LIMIT_MS - IDLE_CHECK_MS * 2);
    first.message(CREATE_FRAMES[0]);
    vi.advanceTimersByTime(IDLE_LIMIT_MS - IDLE_CHECK_MS);
    expect(first.closed).toBe(false);

    vi.advanceTimersByTime(IDLE_CHECK_MS);
    expect(first.closed).toBe(true);
    expect(client.status()).toMatchObject({ connected: false, lastError: "no frame for 120s" });
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    expect(last().sent).toEqual([]);
    last().open();
    expect(last().sent).toEqual([SUBSCRIBE]);
    expect(client.recent()).toHaveLength(1);
  });

  it("stop halts timers and closes the socket; start afterwards opens a fresh one", () => {
    const { client, sockets, last } = harness();
    active.push(client);
    client.start();
    last().open();
    last().emit("close");

    client.stop();
    expect(client.status().connected).toBe(false);
    vi.advanceTimersByTime(IDLE_LIMIT_MS * 3);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.pings).toBe(0);

    client.start();
    expect(sockets).toHaveLength(2);
    last().open();
    expect(last().sent).toEqual([SUBSCRIBE]);
  });
});
