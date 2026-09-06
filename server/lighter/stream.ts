import WebSocket from "ws";
import { parseTrades, type LighterTrade } from "../sources/lighter.js";
import {
  TRADE_RING,
  applyLevels,
  mergeTradeRing,
  midAndSpread,
  parseChannel,
  parseFrame,
  replaceSide,
  topLevels,
  type BookView,
  type SideMap,
  type StreamFrame
} from "./book.js";

export { TRADE_RING, applyLevels, mergeTradeRing, parseChannel } from "./book.js";
export type { BookLevel, BookView } from "./book.js";

export const LIGHTER_WS_URL = "wss://mainnet.zklighter.elliot.ai/stream";
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
export const HEARTBEAT_MS = 15_000;
export const SILENCE_LIMIT_MS = 60_000;
export const IDLE_UNSUBSCRIBE_MS = 10 * 60_000;
export const MAX_BOOK_DEPTH = 25;

/** The slice of a `ws` socket the stream touches; tests inject a fake through `makeSocket`. */
export type WebSocketLike = {
  send(data: string): void;
  close(): void;
  terminate?(): void;
  ping?(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

export type TradesHandler = (marketId: number, trades: LighterTrade[]) => void;

export type LighterStreamOptions = {
  url?: string;
  makeSocket?: (url: string) => WebSocketLike;
  now?: () => number;
  log?: (msg: string) => void;
  /** Called with the NEW (deduped) trades of each trade frame, so a ledger can ingest them. */
  onTrades?: TradesHandler;
};

export type LighterStreamStatus = {
  connected: boolean;
  markets: number;
  reconnects: number;
  framesIn: number;
  lastFrameAt: number | null;
  lastError: string | null;
};

export type MarketStreamStatus = { hasBook: boolean; lastBookAt: number | null; lastTradeAt: number | null; trades: number; liquidations: number; resyncs: number };

type MarketState = {
  asks: SideMap;
  bids: SideMap;
  hasBook: boolean;
  nonce: number | null;
  lastBookAt: number | null;
  lastTradeAt: number | null;
  /** Newest first, at most TRADE_RING. */
  trades: LighterTrade[];
  seen: Set<string>;
  liquidations: number;
  resyncs: number;
  lastTouchedAt: number;
};

function emptyMarket(now: number): MarketState {
  return { asks: new Map(), bids: new Map(), hasBook: false, nonce: null, lastBookAt: null, lastTradeAt: null, trades: [], seen: new Set(), liquidations: 0, resyncs: 0, lastTouchedAt: now };
}

/** Drops the merged book so the next "subscribed/order_book" snapshot rebuilds it from scratch. */
function clearBook(state: MarketState): void {
  state.hasBook = false;
  state.nonce = null;
  state.asks = new Map();
  state.bids = new Map();
}

/**
 * One websocket carrying order_book/<id> and trade/<id> subscriptions per requested market. Books are rebuilt from
 * each "subscribed/order_book" snapshot and patched by "update/order_book" deltas; a broken nonce chain triggers a
 * resubscribe. Handlers never throw; failures land in `status().lastError`.
 */
export class LighterStream {
  private readonly url: string;
  private readonly makeSocket: (url: string) => WebSocketLike;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly onTrades: TradesHandler | null;
  private readonly markets = new Map<number, MarketState>();
  private socket: WebSocketLike | null = null;
  private connected = false;
  private openedAt: number | null = null;
  private delayMs = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnects = 0;
  private framesIn = 0;
  private lastFrameAt: number | null = null;
  private lastError: string | null = null;
  private closed = false;

  constructor(opts: LighterStreamOptions = {}) {
    this.url = opts.url ?? LIGHTER_WS_URL;
    this.makeSocket = opts.makeSocket ?? ((url) => new WebSocket(url));
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((msg) => console.warn(msg));
    this.onTrades = opts.onTrades ?? null;
  }

  subscribe(marketId: number): void {
    if (!Number.isInteger(marketId) || marketId < 0) return;
    const existing = this.markets.get(marketId);
    if (existing) {
      existing.lastTouchedAt = this.now();
      return;
    }
    this.markets.set(marketId, emptyMarket(this.now()));
    this.closed = false;
    if (!this.socket) {
      this.connect();
      return;
    }
    if (this.connected) this.sendSubscribe(marketId);
  }

  unsubscribe(marketId: number): void {
    if (!this.markets.has(marketId)) return;
    this.markets.delete(marketId);
    if (this.connected) this.sendUnsubscribe(marketId);
    if (this.markets.size === 0) this.stop();
  }

  /** Marks a market as still wanted; markets untouched for IDLE_UNSUBSCRIBE_MS are dropped by the heartbeat sweep. */
  touch(marketId: number): void {
    const state = this.markets.get(marketId);
    if (state) state.lastTouchedAt = this.now();
  }

  isSubscribed(marketId: number): boolean {
    return this.markets.has(marketId);
  }

  status(): LighterStreamStatus {
    return { connected: this.connected, markets: this.markets.size, reconnects: this.reconnects, framesIn: this.framesIn, lastFrameAt: this.lastFrameAt, lastError: this.lastError };
  }

  marketStatus(marketId: number): MarketStreamStatus | null {
    const state = this.markets.get(marketId);
    if (!state) return null;
    return { hasBook: state.hasBook, lastBookAt: state.lastBookAt, lastTradeAt: state.lastTradeAt, trades: state.trades.length, liquidations: state.liquidations, resyncs: state.resyncs };
  }

  /** Top `depth` (max 25) levels per side from the merged book; null until a snapshot has arrived on this connection. */
  getBook(marketId: number, depth = MAX_BOOK_DEPTH): BookView | null {
    const state = this.markets.get(marketId);
    if (!state || !state.hasBook || state.lastBookAt === null) return null;
    const cap = Math.min(MAX_BOOK_DEPTH, Math.max(1, Math.floor(depth)));
    const asks = topLevels(state.asks, true, cap);
    const bids = topLevels(state.bids, false, cap);
    return { asks, bids, ...midAndSpread(asks, bids), updatedAt: state.lastBookAt };
  }

  getTrades(marketId: number, limit = TRADE_RING): LighterTrade[] {
    const state = this.markets.get(marketId);
    if (!state || !(limit > 0)) return [];
    return state.trades.slice(0, Math.floor(limit));
  }

  /** Feeds REST-fetched history into the ring (deduped) without notifying `onTrades`; used to bootstrap. */
  seedTrades(marketId: number, trades: LighterTrade[]): number {
    const state = this.markets.get(marketId);
    if (!state) return 0;
    return this.ingestTrades(state, trades, false).length;
  }

  /** Stops timers, closes the socket and forgets every market. */
  stop(): void {
    this.closed = true;
    this.clearTimers();
    this.dropSocket();
    this.markets.clear();
  }

  private connect(): void {
    this.reconnectTimer = null;
    if (this.closed || this.socket) return;
    let socket: WebSocketLike;
    try {
      socket = this.makeSocket(this.url);
    } catch (error) {
      this.fail(`connect: ${String(error)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.connected = false;
    socket.on("open", () => this.guard(() => this.onOpen(socket)));
    socket.on("message", (data: unknown) => this.guard(() => this.onFrame(socket, data)));
    socket.on("pong", () => this.guard(() => this.touchSocket(socket)));
    socket.on("close", () => this.guard(() => this.onClose(socket, "socket closed")));
    socket.on("error", (error: unknown) => this.guard(() => this.onClose(socket, `socket error: ${String(error)}`)));
    this.startHeartbeat();
  }

  private onOpen(socket: WebSocketLike): void {
    if (socket !== this.socket) return;
    this.connected = true;
    this.openedAt = this.now();
    this.delayMs = BACKOFF_MIN_MS;
    for (const marketId of this.markets.keys()) this.sendSubscribe(marketId);
  }

  private onClose(socket: WebSocketLike, reason: string): void {
    if (socket !== this.socket) return;
    this.fail(reason);
    this.dropSocket();
    this.scheduleReconnect();
  }

  private onFrame(socket: WebSocketLike, data: unknown): void {
    if (socket !== this.socket) return;
    this.touchSocket(socket);
    this.framesIn += 1;
    const frame = parseFrame(data);
    if (!frame) return;
    const channel = parseChannel(frame.channel);
    if (!channel) return;
    const state = this.markets.get(channel.marketId);
    if (!state) return;
    if (channel.kind === "order_book") this.onBookFrame(channel.marketId, state, frame);
    else this.onTradeFrame(channel.marketId, state, frame);
  }

  private onBookFrame(marketId: number, state: MarketState, frame: StreamFrame): void {
    const book = frame.order_book;
    if (!book) return;
    if (frame.type === "subscribed/order_book") {
      state.asks = replaceSide(book.asks);
      state.bids = replaceSide(book.bids);
      state.hasBook = true;
    } else if (frame.type === "update/order_book") {
      if (!state.hasBook || book.begin_nonce !== state.nonce) {
        this.resync(marketId, state, `nonce gap on market ${marketId}`);
        return;
      }
      applyLevels(state.asks, book.asks);
      applyLevels(state.bids, book.bids);
    } else {
      return;
    }
    state.nonce = typeof book.nonce === "number" ? book.nonce : null;
    state.lastBookAt = this.now();
  }

  /** Discards the book and asks for a fresh snapshot; offsets are non-consecutive by design so only the nonce chain counts. */
  private resync(marketId: number, state: MarketState, reason: string): void {
    clearBook(state);
    state.resyncs += 1;
    this.fail(reason);
    this.send({ type: "unsubscribe", channel: `order_book/${marketId}` });
    this.send({ type: "subscribe", channel: `order_book/${marketId}` });
  }

  private onTradeFrame(marketId: number, state: MarketState, frame: StreamFrame): void {
    const accepted = this.ingestTrades(state, parseTrades(frame), true);
    if (accepted.length === 0) return;
    this.onTrades?.(marketId, accepted);
  }

  private ingestTrades(state: MarketState, trades: LighterTrade[], live: boolean): LighterTrade[] {
    const merged = mergeTradeRing(state.trades, state.seen, trades);
    state.trades = merged.ring;
    state.liquidations += merged.accepted.filter((trade) => trade.liquidation).length;
    if (live && merged.accepted.length > 0) state.lastTradeAt = this.now();
    return merged.accepted;
  }

  private sendSubscribe(marketId: number): void {
    this.send({ type: "subscribe", channel: `order_book/${marketId}` });
    this.send({ type: "subscribe", channel: `trade/${marketId}` });
  }

  private sendUnsubscribe(marketId: number): void {
    this.send({ type: "unsubscribe", channel: `order_book/${marketId}` });
    this.send({ type: "unsubscribe", channel: `trade/${marketId}` });
  }

  private send(payload: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch (error) {
      this.fail(`send: ${String(error)}`);
    }
  }

  private touchSocket(socket: WebSocketLike): void {
    if (socket === this.socket) this.lastFrameAt = this.now();
  }

  private heartbeat(): void {
    this.sweepIdle();
    const socket = this.socket;
    if (!socket) return;
    const lastActivity = Math.max(this.lastFrameAt ?? 0, this.openedAt ?? 0);
    if (this.connected && this.now() - lastActivity >= SILENCE_LIMIT_MS) {
      this.onClose(socket, `no frame for ${SILENCE_LIMIT_MS / 1000}s`);
      return;
    }
    try {
      socket.ping?.();
    } catch (error) {
      this.fail(`ping: ${String(error)}`);
    }
  }

  private sweepIdle(): void {
    const now = this.now();
    const idle = [...this.markets.entries()].filter(([, state]) => now - state.lastTouchedAt >= IDLE_UNSUBSCRIBE_MS).map(([marketId]) => marketId);
    for (const marketId of idle) this.unsubscribe(marketId);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.guard(() => this.heartbeat()), HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || this.markets.size === 0) return;
    this.reconnects += 1;
    this.reconnectTimer = setTimeout(() => this.guard(() => this.connect()), this.delayMs);
    this.reconnectTimer.unref?.();
    this.delayMs = Math.min(this.delayMs * 2, BACKOFF_MAX_MS);
  }

  /** Detaches the socket so its later events are ignored and drops every book: the next snapshot rebuilds them. */
  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.openedAt = null;
    for (const state of this.markets.values()) clearBook(state);
    if (!socket) return;
    try {
      socket.terminate ? socket.terminate() : socket.close();
    } catch (error) {
      this.fail(`close: ${String(error)}`);
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  private fail(message: string): void {
    this.lastError = message;
    this.log(`lighter stream: ${message}`);
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.fail(`handler: ${String(error)}`);
    }
  }
}
