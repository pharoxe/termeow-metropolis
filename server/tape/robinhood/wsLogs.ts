import WebSocket from "ws";
import { config } from "../../config.js";
import { errorMessage } from "../../lib/http.js";
import type { WebSocketLike } from "../solana/subscribe.js";
import { MAX_SUBSCRIPTIONS_PER_CONNECTION, diffLegs, legKey, legWithinLimits, logBlockTimestampMs, parseHead, parseWsFrame, type LegFilter } from "./wsLegs.js";

/** publicnode sends no pings and dropped an idle socket at 90.7 s (1006); a client ping every 20 s kept it open 150 s+. */
export const KEEPALIVE_MS = 20_000;
/** newHeads arrive ~10/s on both nodes, so a socket silent this long is dead even if TCP has not noticed. */
export const SILENCE_LIMIT_MS = 45_000;
/**
 * publicnode answers an over-limit subscribe with silence, so a missing ack is a failure, not a wait: for newHeads the
 * socket is dropped, for a logs leg only that leg is marked rejected (the other legs keep delivering) until the next
 * setLegs or reconnect retries it.
 */
export const ACK_TIMEOUT_MS = 8_000;
/** setExtraLegs fires in bursts (launch legs, then transfer legs); one resubscribe pass per burst. */
export const LEGS_DEBOUNCE_MS = 250;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/**
 * A retired subscription keeps delivering for a moment after eth_unsubscribe is sent; its frames are still logs of a
 * leg this poller asked for, so they are forwarded (the owner's accept() filters and dedupes) rather than dropped.
 */
export const RETIRED_GRACE_MS = 15_000;

/** The slice of a `ws` socket the transport touches (the Solana subscriber's); tests inject a fake or a real client through `makeSocket`. */
export type WsSocketLike = WebSocketLike;

export type WsLogsHandlers = {
  /** One log notification, exactly the eth_getLogs row shape; `blockTimeMs` is the frame's blockTimestamp when non-zero. */
  onLog(log: unknown, blockTimeMs: number | null): void;
  onHead(block: number, timestampMs: number | null): void;
  onOpen(): void;
  onClose(): void;
};

export type WsLogsOptions = {
  urls: string[];
  makeSocket?: (url: string) => WsSocketLike;
  now?: () => number;
  log?: (message: string) => void;
  keepaliveMs?: number;
  silenceLimitMs?: number;
  ackTimeoutMs?: number;
  legsDebounceMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
};

export type WsTransportStatus = {
  connected: boolean;
  url: string | null;
  connectedAt: number | null;
  /** Live log subscriptions (newHeads excluded). */
  subscriptions: number;
  wantedLegs: number;
  rejectedLegs: number;
  notifications: number;
  heads: number;
  /** Notifications for a subscription id this connection never knew. */
  stray: number;
  /** Frames forwarded from a subscription retired within RETIRED_GRACE_MS (leg churn, not a fault). */
  retiredFrames: number;
  /** Leg-set changes that reached the socket, and eth_unsubscribe calls they caused. */
  legChanges: number;
  unsubscribes: number;
  reconnects: number;
  lastError: string | null;
  lastFrameAt: number | null;
  lastBlock: number | null;
};

/** What the poller needs from a transport; RobinhoodWsLogs is the real one, tests may inject a fake. */
export type WsLogsLike = {
  start(handlers: WsLogsHandlers): void;
  stop(): void;
  setLegs(legs: LegFilter[]): void;
  status(): WsTransportStatus;
};

type Pending =
  | { kind: "heads" }
  | { kind: "logs"; key: string; cancelled: boolean }
  | { kind: "unsubscribe" | "keepalive" };

/**
 * One websocket carrying eth_subscribe("newHeads") plus one eth_subscribe("logs") per poller leg (measured: every leg
 * shape the pollers build is accepted by publicnode and pocket, fixtures r7/ws-measure-*.json). Legs are diffed on
 * change, so a resubscribe pass touches only what moved. Any close, silence, or missing newHeads ack drops the socket
 * and reconnects with backoff, rotating URLs; a logs leg the node rejects or never acks is marked rejected on its own
 * (status().rejectedLegs, retried on the next setLegs or reconnect) while the rest stay live, so the owner can see it is
 * not fully subscribed and keep polling. Subscription ids never survive a socket, nothing is buffered server-side, so
 * the owner back-fills the gap over HTTP when `onOpen` fires again. Handlers never throw out of here.
 */
export class RobinhoodWsLogs implements WsLogsLike {
  private readonly urls: string[];
  private readonly makeSocket: (url: string) => WsSocketLike;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly keepaliveMs: number;
  private readonly silenceLimitMs: number;
  private readonly ackTimeoutMs: number;
  private readonly legsDebounceMs: number;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;
  private handlers: WsLogsHandlers | null = null;
  private running = false;
  private socket: WsSocketLike | null = null;
  private url: string | null = null;
  private urlIndex = 0;
  private connected = false;
  private connectedAt: number | null = null;
  private backoffMs = 0;
  private nextId = 1;
  private headsSub: string | null = null;
  private desired = new Map<string, LegFilter>();
  private readonly active = new Map<string, string>();
  private readonly bySub = new Map<string, string>();
  /** subscription id -> retirement time, consulted for frames that arrive after an unsubscribe. */
  private readonly retired = new Map<string, number>();
  private readonly pending = new Map<number, Pending>();
  private readonly ackTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private rejected = new Set<string>();
  private oversized = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private legsTimer: ReturnType<typeof setTimeout> | null = null;
  private counters = { notifications: 0, heads: 0, stray: 0, retiredFrames: 0, legChanges: 0, unsubscribes: 0, reconnects: 0 };
  private lastError: string | null = null;
  private lastFrameAt: number | null = null;
  private lastBlock: number | null = null;

  constructor(opts: WsLogsOptions) {
    if (opts.urls.length === 0) throw new Error("RobinhoodWsLogs: at least one websocket url is required");
    this.urls = [...opts.urls];
    this.makeSocket = opts.makeSocket ?? ((url) => new WebSocket(url));
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((message) => console.warn(message));
    this.keepaliveMs = opts.keepaliveMs ?? KEEPALIVE_MS;
    this.silenceLimitMs = opts.silenceLimitMs ?? SILENCE_LIMIT_MS;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    this.legsDebounceMs = opts.legsDebounceMs ?? LEGS_DEBOUNCE_MS;
    this.backoffMinMs = opts.backoffMinMs ?? BACKOFF_MIN_MS;
    this.backoffMaxMs = opts.backoffMaxMs ?? BACKOFF_MAX_MS;
  }

  start(handlers: WsLogsHandlers): void {
    this.handlers = handlers;
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.legsTimer) clearTimeout(this.legsTimer);
    this.legsTimer = null;
    const socket = this.socket;
    const wasConnected = this.connected;
    this.dropSocket();
    this.closeQuietly(socket);
    if (wasConnected) this.emit(() => this.handlers?.onClose());
  }

  /** Replaces the wanted leg set; the live subscriptions follow after a short debounce. Over-limit legs (topic list, or leg count past the measured per-connection ceiling) are reported, not sent. */
  setLegs(legs: LegFilter[]): void {
    const withinTopics = legs.filter((leg) => legWithinLimits(leg));
    const within = withinTopics.slice(0, MAX_SUBSCRIPTIONS_PER_CONNECTION);
    this.oversized = legs.length - within.length;
    if (withinTopics.length > within.length) this.lastError = `${withinTopics.length - within.length} leg(s) past the measured ${MAX_SUBSCRIPTIONS_PER_CONNECTION} subscriptions per connection were not subscribed`;
    else if (this.oversized > 0) this.lastError = `${this.oversized} leg(s) exceed the measured topic limit and were not subscribed`;
    this.desired = new Map(within.map((leg) => [legKey(leg), leg] as const));
    this.rejected = new Set();
    if (this.legsTimer) clearTimeout(this.legsTimer);
    this.legsTimer = setTimeout(() => {
      this.legsTimer = null;
      this.guard(() => this.syncLegs());
    }, this.legsDebounceMs);
    this.legsTimer.unref?.();
  }

  status(): WsTransportStatus {
    return {
      connected: this.connected,
      url: this.url,
      connectedAt: this.connectedAt,
      subscriptions: this.active.size,
      wantedLegs: this.desired.size + this.oversized,
      rejectedLegs: this.rejected.size + this.oversized,
      ...this.counters,
      lastError: this.lastError,
      lastFrameAt: this.lastFrameAt,
      lastBlock: this.lastBlock
    };
  }

  private connect(): void {
    if (!this.running || this.socket) return;
    const url = this.urls[this.urlIndex % this.urls.length]!;
    this.url = url;
    let socket: WsSocketLike;
    try {
      socket = this.makeSocket(url);
    } catch (error) {
      this.fail(`connect ${url}: ${errorMessage(error)}`);
      return;
    }
    this.socket = socket;
    socket.on("open", () => this.guard(() => this.onOpen(socket)));
    socket.on("message", (data: unknown) => this.guard(() => this.onMessage(socket, data)));
    socket.on("pong", () => {
      if (this.socket === socket) this.lastFrameAt = this.now();
    });
    socket.on("error", (error: unknown) => {
      if (this.socket === socket) this.lastError = `${url}: ${errorMessage(error)}`;
    });
    socket.on("close", (code: unknown) => this.guard(() => this.onClosed(socket, code)));
  }

  private onOpen(socket: WsSocketLike): void {
    if (this.socket !== socket) return;
    this.connected = true;
    this.connectedAt = this.now();
    this.lastFrameAt = this.connectedAt;
    this.send("eth_subscribe", ["newHeads"], { kind: "heads" });
    this.syncLegs();
    this.keepaliveTimer = setInterval(() => this.guard(() => this.keepalive()), this.keepaliveMs);
    this.keepaliveTimer.unref?.();
    this.emit(() => this.handlers?.onOpen());
  }

  /** Subscribes new legs and unsubscribes departed ones; a leg whose ack is still pending is cancelled on arrival. */
  private syncLegs(): void {
    if (!this.connected || !this.socket) return;
    const pendingAdds = new Map<string, number>();
    for (const [id, item] of this.pending) if (item.kind === "logs" && !item.cancelled) pendingAdds.set(item.key, id);
    const { add, remove } = diffLegs([...this.active.keys(), ...pendingAdds.keys()], [...this.desired.values()]);
    if (add.length > 0 || remove.length > 0) this.counters.legChanges += 1;
    for (const leg of add) {
      const key = legKey(leg);
      if (this.rejected.has(key)) continue;
      this.send("eth_subscribe", ["logs", leg], { kind: "logs", key, cancelled: false });
    }
    for (const key of remove) {
      const subId = this.active.get(key);
      if (subId !== undefined) this.retire(key, subId);
      const pendingId = pendingAdds.get(key);
      const item = pendingId === undefined ? undefined : this.pending.get(pendingId);
      if (item && item.kind === "logs") item.cancelled = true;
    }
  }

  private send(method: string, params: unknown[], pending: Pending): void {
    if (!this.socket) return;
    const id = this.nextId++;
    this.pending.set(id, pending);
    if (pending.kind === "heads" || pending.kind === "logs") {
      const timer = setTimeout(() => this.guard(() => this.onAckTimeout(id)), this.ackTimeoutMs);
      timer.unref?.();
      this.ackTimers.set(id, timer);
    }
    try {
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    } catch (error) {
      this.fail(`send ${method}: ${errorMessage(error)}`);
    }
  }

  private onMessage(socket: WsSocketLike, data: unknown): void {
    if (this.socket !== socket) return;
    this.lastFrameAt = this.now();
    const frame = parseWsFrame(data);
    if (!frame || frame.kind === "other") return;
    if (frame.kind === "reply") {
      this.onReply(frame.id, frame.result, frame.error);
      return;
    }
    if (frame.subscription === this.headsSub) {
      const head = parseHead(frame.result);
      if (!head) return;
      this.counters.heads += 1;
      this.lastBlock = Math.max(this.lastBlock ?? 0, head.number);
      this.emit(() => this.handlers?.onHead(head.number, head.timestampMs));
      return;
    }
    if (!this.bySub.has(frame.subscription)) {
      const retiredAt = this.retired.get(frame.subscription);
      if (retiredAt === undefined || this.now() - retiredAt > RETIRED_GRACE_MS) {
        this.counters.stray += 1;
        return;
      }
      this.counters.retiredFrames += 1;
    }
    this.counters.notifications += 1;
    this.emit(() => this.handlers?.onLog(frame.result, logBlockTimestampMs(frame.result)));
  }

  private onReply(id: number, result: unknown, error: { code: number | null; message: string } | null): void {
    const item = this.pending.get(id);
    this.pending.delete(id);
    const timer = this.ackTimers.get(id);
    if (timer) clearTimeout(timer);
    this.ackTimers.delete(id);
    if (!item) return;
    if (item.kind === "heads") {
      if (error || typeof result !== "string") {
        this.fail(`newHeads subscribe rejected: ${error?.message ?? "malformed id"}`);
        return;
      }
      this.headsSub = result;
      this.backoffMs = 0;
      return;
    }
    if (item.kind !== "logs") return;
    if (error || typeof result !== "string") {
      this.rejected.add(item.key);
      this.lastError = `leg rejected: ${error?.message ?? "malformed id"}`;
      this.log(`robinhood ws logs: ${this.lastError}`);
      return;
    }
    if (item.cancelled || !this.desired.has(item.key)) {
      this.retire(item.key, result);
      return;
    }
    this.active.set(item.key, result);
    this.bySub.set(result, item.key);
    this.backoffMs = 0;
  }

  /** Unsubscribes a leg's live id and remembers it for the grace window; expired retirements are swept here. */
  private retire(key: string, subId: string): void {
    this.active.delete(key);
    this.bySub.delete(subId);
    this.retired.set(subId, this.now());
    this.counters.unsubscribes += 1;
    this.send("eth_unsubscribe", [subId], { kind: "unsubscribe" });
    const cutoff = this.now() - RETIRED_GRACE_MS;
    for (const [id, at] of this.retired) if (at < cutoff) this.retired.delete(id);
  }

  /** newHeads unacked: the socket is useless, drop it. A logs leg unacked: that leg alone is rejected; the acked legs keep delivering. */
  private onAckTimeout(id: number): void {
    const item = this.pending.get(id);
    this.ackTimers.delete(id);
    if (!item) return;
    if (item.kind !== "logs") {
      this.fail(`no ack for newHeads subscribe within ${this.ackTimeoutMs} ms`);
      return;
    }
    this.pending.delete(id);
    if (item.cancelled) return;
    this.rejected.add(item.key);
    this.lastError = `leg rejected: no ack for logs subscribe within ${this.ackTimeoutMs} ms`;
    this.log(`robinhood ws logs: ${this.lastError}`);
  }

  /** Every keepaliveMs: give up on a silent socket, otherwise ping (or, without ping support, ask for the head). */
  private keepalive(): void {
    if (!this.socket || !this.connected) return;
    if (this.lastFrameAt !== null && this.now() - this.lastFrameAt > this.silenceLimitMs) {
      this.fail(`no frame for ${this.silenceLimitMs} ms`);
      return;
    }
    if (this.socket.ping) this.socket.ping();
    else this.send("eth_blockNumber", [], { kind: "keepalive" });
  }

  private onClosed(socket: WsSocketLike, code: unknown): void {
    if (this.socket !== socket) return;
    if (this.running) this.lastError = `closed (${String(code ?? "?")})`;
    this.disconnected();
  }

  /** Records the reason, drops the socket, and reconnects; the old socket's late events are ignored by identity. */
  private fail(reason: string): void {
    this.lastError = reason;
    this.log(`robinhood ws logs: ${reason}`);
    const socket = this.socket;
    this.disconnected();
    this.closeQuietly(socket);
  }

  private disconnected(): void {
    const wasConnected = this.connected;
    this.dropSocket();
    if (wasConnected) this.emit(() => this.handlers?.onClose());
    if (this.running) this.scheduleReconnect();
  }

  private dropSocket(): void {
    this.socket = null;
    this.connected = false;
    this.headsSub = null;
    this.active.clear();
    this.bySub.clear();
    this.retired.clear();
    this.pending.clear();
    this.rejected = new Set(); // a fresh socket retries every wanted leg
    for (const timer of this.ackTimers.values()) clearTimeout(timer);
    this.ackTimers.clear();
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private closeQuietly(socket: WsSocketLike | null): void {
    if (!socket) return;
    try {
      if (socket.terminate) socket.terminate();
      else socket.close();
    } catch {
      /* already gone */
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.running) return;
    this.backoffMs = this.backoffMs === 0 ? this.backoffMinMs : Math.min(this.backoffMs * 2, this.backoffMaxMs);
    this.urlIndex += 1;
    this.counters.reconnects += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.guard(() => this.connect());
    }, this.backoffMs);
    this.reconnectTimer.unref?.();
  }

  private emit(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.lastError = `handler: ${errorMessage(error)}`;
      this.log(`robinhood ws logs: ${this.lastError}`);
    }
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.lastError = errorMessage(error);
      this.log(`robinhood ws logs: ${this.lastError}`);
    }
  }
}

/** The process default: null when ROBINHOOD_WS_ENABLED is off, else a transport over the configured URL list. */
export function wsTransportFromConfig(log?: (message: string) => void): RobinhoodWsLogs | null {
  const ws = config.robinhood.ws;
  if (!ws.enabled || ws.urls.length === 0) return null;
  return new RobinhoodWsLogs({ urls: ws.urls, log });
}
