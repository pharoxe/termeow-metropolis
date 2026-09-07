import WebSocket from "ws";

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
export const HEARTBEAT_MS = 30_000;
export const SILENCE_LIMIT_MS = 90_000;
const COMMITMENT = "confirmed";

/** The slice of a `ws` socket the subscriber touches; tests inject a fake through `makeSocket`. */
export type WebSocketLike = {
  send(data: string): void;
  close(): void;
  terminate?(): void;
  ping?(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

export type SubscriberOptions = {
  rpcUrl: string;
  makeSocket?: (url: string) => WebSocketLike;
  now?: () => number;
  log?: (msg: string) => void;
};

export type SubscriberStatus = {
  connected: boolean;
  mints: number;
  reconnects: number;
  lastFrameAt: number | null;
  lastError: string | null;
};

export type SignatureHandler = (sig: string, slot: number) => void;

type MintState = { onSignature: SignatureHandler; subId: number | null };

type RpcFrame = {
  id?: number;
  result?: unknown;
  error?: { message?: string; code?: number };
  method?: string;
  params?: { subscription?: number; result?: { context?: { slot?: number }; value?: { signature?: string; err?: unknown } } };
};

/** Derives the websocket endpoint from an https RPC URL, keeping any query string (Helius api-key). */
export function wsUrlFor(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

function nextDelay(current: number): number {
  return Math.min(current * 2, BACKOFF_MAX_MS);
}

/** Text of one inbound `ws` frame whatever form the library handed it in; shared with the Robinhood log transport. */
export function frameText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

function parseFrame(data: unknown): RpcFrame | null {
  try {
    const parsed: unknown = JSON.parse(frameText(data));
    return parsed && typeof parsed === "object" ? (parsed as RpcFrame) : null;
  } catch {
    return null;
  }
}

/**
 * One websocket per subscriber carrying a `logsSubscribe` per mint. Reconnects with exponential backoff and
 * re-subscribes every mint after a reconnect. Handlers never throw; failures land in `status().lastError`.
 */
export class SolanaLogSubscriber {
  private readonly url: string;
  private readonly makeSocket: (url: string) => WebSocketLike;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly mints = new Map<string, MintState>();
  private readonly pending = new Map<number, string>();
  private readonly subIds = new Map<number, string>();
  private socket: WebSocketLike | null = null;
  private connected = false;
  private openedAt: number | null = null;
  private nextId = 1;
  private delayMs = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnects = 0;
  private lastFrameAt: number | null = null;
  private lastError: string | null = null;
  private closed = false;

  constructor(opts: SubscriberOptions) {
    this.url = wsUrlFor(opts.rpcUrl);
    this.makeSocket = opts.makeSocket ?? ((url) => new WebSocket(url));
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((msg) => console.warn(msg));
  }

  subscribe(mint: string, onSignature: SignatureHandler): void {
    const existing = this.mints.get(mint);
    this.mints.set(mint, { onSignature, subId: existing?.subId ?? null });
    this.closed = false;
    if (!this.socket) {
      this.connect();
      return;
    }
    if (this.connected && !existing) this.sendSubscribe(mint);
  }

  unsubscribe(mint: string): void {
    const state = this.mints.get(mint);
    if (!state) return;
    this.mints.delete(mint);
    if (state.subId !== null) {
      this.subIds.delete(state.subId);
      if (this.connected) this.send({ jsonrpc: "2.0", id: this.nextId++, method: "logsUnsubscribe", params: [state.subId] });
    }
    if (this.mints.size === 0) this.close();
  }

  status(): SubscriberStatus {
    return { connected: this.connected, mints: this.mints.size, reconnects: this.reconnects, lastFrameAt: this.lastFrameAt, lastError: this.lastError };
  }

  /** Stops timers and closes the socket; `subscribe` afterwards starts a fresh connection. */
  close(): void {
    this.closed = true;
    this.clearTimers();
    this.dropSocket();
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
    socket.on("pong", () => this.guard(() => this.touch(socket)));
    socket.on("close", () => this.guard(() => this.onClose(socket, "socket closed")));
    socket.on("error", (error: unknown) => this.guard(() => this.onClose(socket, `socket error: ${String(error)}`)));
    this.startHeartbeat();
  }

  private onOpen(socket: WebSocketLike): void {
    if (socket !== this.socket) return;
    this.connected = true;
    this.openedAt = this.now();
    this.delayMs = BACKOFF_MIN_MS;
    for (const mint of this.mints.keys()) this.sendSubscribe(mint);
  }

  private onClose(socket: WebSocketLike, reason: string): void {
    if (socket !== this.socket) return;
    this.fail(reason);
    this.dropSocket();
    this.scheduleReconnect();
  }

  private onFrame(socket: WebSocketLike, data: unknown): void {
    if (socket !== this.socket) return;
    this.touch(socket);
    const frame = parseFrame(data);
    if (!frame) return;
    if (frame.method === "logsNotification") this.dispatch(frame);
    else if (typeof frame.id === "number") this.onReply(frame);
  }

  private onReply(frame: RpcFrame): void {
    const mint = frame.id === undefined ? undefined : this.pending.get(frame.id);
    if (frame.id !== undefined) this.pending.delete(frame.id);
    if (mint === undefined) return;
    if (frame.error) {
      this.fail(`logsSubscribe ${mint}: ${frame.error.message ?? "rpc error"}`);
      return;
    }
    const state = this.mints.get(mint);
    if (typeof frame.result !== "number" || !state) return;
    this.mints.set(mint, { ...state, subId: frame.result });
    this.subIds.set(frame.result, mint);
  }

  private dispatch(frame: RpcFrame): void {
    const subId = frame.params?.subscription;
    const mint = subId === undefined ? undefined : this.subIds.get(subId);
    const value = frame.params?.result?.value;
    if (mint === undefined || !value || (value.err !== null && value.err !== undefined)) return;
    const state = this.mints.get(mint);
    if (!state || typeof value.signature !== "string") return;
    state.onSignature(value.signature, frame.params?.result?.context?.slot ?? 0);
  }

  private sendSubscribe(mint: string): void {
    const id = this.nextId++;
    this.pending.set(id, mint);
    this.send({ jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [mint] }, { commitment: COMMITMENT }] });
  }

  private send(payload: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch (error) {
      this.fail(`send: ${String(error)}`);
    }
  }

  private touch(socket: WebSocketLike): void {
    if (socket === this.socket) this.lastFrameAt = this.now();
  }

  private heartbeat(): void {
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

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.guard(() => this.heartbeat()), HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || this.mints.size === 0) return;
    this.reconnects += 1;
    this.reconnectTimer = setTimeout(() => this.guard(() => this.connect()), this.delayMs);
    this.reconnectTimer.unref?.();
    this.delayMs = nextDelay(this.delayMs);
  }

  /** Detaches the current socket so its later events are ignored, then closes it. */
  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.openedAt = null;
    this.pending.clear();
    this.subIds.clear();
    for (const [mint, state] of this.mints) this.mints.set(mint, { ...state, subId: null });
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
    this.log(`solana log subscriber: ${message}`);
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.fail(`handler: ${String(error)}`);
    }
  }
}
