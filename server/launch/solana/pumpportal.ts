import WebSocket from "ws";
import type { WebSocketLike } from "../../tape/solana/subscribe.js";

export const PUMPPORTAL_URL = "wss://pumpportal.fun/api/data";
export const RING_SIZE = 1_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** PumpPortal delivered ~8 creates/min when measured (2026-09-06); two minutes of silence means the socket is dead. */
export const IDLE_LIMIT_MS = 120_000;
export const IDLE_CHECK_MS = 15_000;
/** The only frame this client ever sends. Trade subscriptions need a funded key and are never sent. */
const SUBSCRIBE_FRAME = JSON.stringify({ method: "subscribeNewToken" });

export type SolanaLaunch = {
  chain: "solana";
  launchpad: "pump.fun";
  token: string;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  /** Local receive time in ms; PumpPortal create frames carry no on-chain timestamp. */
  createdAt: number;
  /** SOL the creator spent on the dev buy (`solAmount`); null when absent. */
  initialBuySol: number | null;
  /** Tokens received by the dev buy (`initialBuy`); null when absent. */
  initialBuyTokens: number | null;
  marketCapSol: number | null;
  mayhemMode: boolean | null;
  tx: string;
  /** pump.fun bonding curve; required, so a frame without one is never a pump.fun launch here. */
  curve: string;
  /** PumpPortal `pool` field; only "pump" frames are accepted (the stream also carries `bonk` creates). */
  pool: "pump";
};

/** The only `pool` value mapped to launchpad "pump.fun"; other pools (measured: "bonk") are dropped, not relabelled. */
export const PUMP_POOL = "pump";

export type PumpPortalOptions = {
  url?: string;
  makeSocket?: (url: string) => WebSocketLike;
  now?: () => number;
  log?: (msg: string) => void;
  onLaunch?: (launch: SolanaLaunch) => void;
};

export type PumpPortalStatus = {
  connected: boolean;
  launches: number;
  reconnects: number;
  framesSeen: number;
  lastFrameAt: number | null;
  lastLaunchAt: number | null;
  lastError: string | null;
};

type CreateFrame = {
  message?: unknown;
  errors?: unknown;
  txType?: unknown;
  signature?: unknown;
  mint?: unknown;
  traderPublicKey?: unknown;
  initialBuy?: unknown;
  solAmount?: unknown;
  bondingCurveKey?: unknown;
  marketCapSol?: unknown;
  name?: unknown;
  symbol?: unknown;
  uri?: unknown;
  is_mayhem_mode?: unknown;
  pool?: unknown;
};

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function frameText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

function parseJson(data: unknown): CreateFrame | null {
  try {
    const parsed: unknown = JSON.parse(frameText(data));
    return parsed && typeof parsed === "object" ? (parsed as CreateFrame) : null;
  } catch {
    return null;
  }
}

/**
 * Maps one verified PumpPortal `create` frame to a SolanaLaunch. Ack frames (`message`), API-key notices (`errors`),
 * anything that is not a create with mint + signature + creator, and creates outside the pump pool or without a
 * bonding curve return null: the subscribeNewToken stream also emits `pool:"bonk"` creates and create-shaped frames for
 * long-established mints (no `bondingCurveKey`), neither of which is a pump.fun launch.
 */
export function parseCreateFrame(raw: unknown, receivedAt: number): SolanaLaunch | null {
  if (!raw || typeof raw !== "object") return null;
  const frame = raw as CreateFrame;
  if (frame.message !== undefined || frame.errors !== undefined || frame.txType !== "create") return null;
  if (frame.pool !== PUMP_POOL) return null;
  const token = nonEmpty(frame.mint);
  const tx = nonEmpty(frame.signature);
  const creator = nonEmpty(frame.traderPublicKey);
  const curve = nonEmpty(frame.bondingCurveKey);
  if (!token || !tx || !creator || !curve) return null;
  return {
    chain: "solana",
    launchpad: "pump.fun",
    token,
    creator,
    name: typeof frame.name === "string" ? frame.name : "",
    symbol: typeof frame.symbol === "string" ? frame.symbol : "",
    uri: typeof frame.uri === "string" ? frame.uri : "",
    createdAt: receivedAt,
    initialBuySol: finiteOrNull(frame.solAmount),
    initialBuyTokens: finiteOrNull(frame.initialBuy),
    marketCapSol: finiteOrNull(frame.marketCapSol),
    mayhemMode: typeof frame.is_mayhem_mode === "boolean" ? frame.is_mayhem_mode : null,
    tx,
    curve,
    pool: PUMP_POOL
  };
}

/**
 * One socket to PumpPortal carrying only `subscribeNewToken`. Keeps the newest 1,000 launches (newest first), reconnects
 * with 1s to 30s backoff, forces a reconnect after 120s of silence. Handlers never throw; failures land in status().
 */
export class PumpPortalNewTokens {
  private readonly url: string;
  private readonly makeSocket: (url: string) => WebSocketLike;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly onLaunch: ((launch: SolanaLaunch) => void) | null;
  private ring: SolanaLaunch[] = [];
  private socket: WebSocketLike | null = null;
  private connected = false;
  private stopped = true;
  private connectAt: number | null = null;
  private delayMs = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private reconnects = 0;
  private framesSeen = 0;
  private lastFrameAt: number | null = null;
  private lastLaunchAt: number | null = null;
  private lastError: string | null = null;

  constructor(opts: PumpPortalOptions = {}) {
    this.url = opts.url ?? PUMPPORTAL_URL;
    this.makeSocket = opts.makeSocket ?? ((url) => new WebSocket(url));
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((msg) => console.warn(msg));
    this.onLaunch = opts.onLaunch ?? null;
  }

  /** Opens the socket; idempotent while running. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Stops timers and closes the socket; `start()` afterwards opens a fresh connection. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.dropSocket();
  }

  /** Newest first. */
  recent(limit = 100): SolanaLaunch[] {
    return this.ring.slice(0, Math.max(0, limit));
  }

  status(): PumpPortalStatus {
    return {
      connected: this.connected,
      launches: this.ring.length,
      reconnects: this.reconnects,
      framesSeen: this.framesSeen,
      lastFrameAt: this.lastFrameAt,
      lastLaunchAt: this.lastLaunchAt,
      lastError: this.lastError
    };
  }

  private connect(): void {
    this.reconnectTimer = null;
    if (this.stopped || this.socket) return;
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
    this.connectAt = this.now();
    socket.on("open", () => this.guard(() => this.onOpen(socket)));
    socket.on("message", (data: unknown) => this.guard(() => this.onFrame(socket, data)));
    socket.on("pong", () => this.guard(() => this.touch(socket)));
    socket.on("close", () => this.guard(() => this.onClose(socket, "socket closed")));
    socket.on("error", (error: unknown) => this.guard(() => this.onClose(socket, `socket error: ${String(error)}`)));
    this.startIdleCheck();
  }

  private onOpen(socket: WebSocketLike): void {
    if (socket !== this.socket) return;
    this.connected = true;
    this.connectAt = this.now();
    this.delayMs = BACKOFF_MIN_MS;
    try {
      socket.send(SUBSCRIBE_FRAME);
    } catch (error) {
      this.fail(`send: ${String(error)}`);
    }
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
    this.framesSeen += 1;
    const launch = parseCreateFrame(parseJson(data), this.now());
    if (launch) this.push(launch);
  }

  private push(launch: SolanaLaunch): void {
    if (this.ring.some((row) => row.token === launch.token)) return;
    this.ring = [launch, ...this.ring].slice(0, RING_SIZE);
    this.lastLaunchAt = launch.createdAt;
    this.onLaunch?.(launch);
  }

  private touch(socket: WebSocketLike): void {
    if (socket === this.socket) this.lastFrameAt = this.now();
  }

  private checkIdle(): void {
    const socket = this.socket;
    if (!socket) return;
    const lastActivity = Math.max(this.lastFrameAt ?? 0, this.connectAt ?? 0);
    if (this.now() - lastActivity >= IDLE_LIMIT_MS) {
      this.onClose(socket, `no frame for ${IDLE_LIMIT_MS / 1000}s`);
      return;
    }
    try {
      socket.ping?.();
    } catch (error) {
      this.fail(`ping: ${String(error)}`);
    }
  }

  private startIdleCheck(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => this.guard(() => this.checkIdle()), IDLE_CHECK_MS);
    this.idleTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnects += 1;
    this.reconnectTimer = setTimeout(() => this.guard(() => this.connect()), this.delayMs);
    this.reconnectTimer.unref?.();
    this.delayMs = Math.min(this.delayMs * 2, BACKOFF_MAX_MS);
  }

  /** Detaches the current socket so its later events are ignored, then closes it. */
  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.connectAt = null;
    if (!socket) return;
    try {
      socket.terminate ? socket.terminate() : socket.close();
    } catch (error) {
      this.fail(`close: ${String(error)}`);
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.reconnectTimer = null;
    this.idleTimer = null;
  }

  private fail(message: string): void {
    this.lastError = message;
    this.log(`pumpportal new tokens: ${message}`);
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.fail(`handler: ${String(error)}`);
    }
  }
}

let shared: PumpPortalNewTokens | null = null;

/** Process-wide client, started on first use; routes call `recent()` / `status()` on it. */
export function getPumpPortalNewTokens(): PumpPortalNewTokens {
  if (!shared) {
    shared = new PumpPortalNewTokens();
    shared.start();
  }
  return shared;
}
