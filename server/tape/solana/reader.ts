import { errorMessage } from "../../lib/http.js";

export const DEFAULT_MAX_QUEUE = 120;
export const SEEN_TTL_MS = 5 * 60_000;
export const SEEN_MAX = 5_000;
export const RATE_LIMIT_BLOCK_MS = 5_000;
export const NULL_RETRY_MS = 2_000;
export const REQUEST_TIMEOUT_MS = 15_000;

export type ReaderMeta = { mint: string; slot: number };
export type TransactionHandler = (tx: unknown, meta: ReaderMeta) => void;

export type ReaderOptions = {
  rpcUrl: string;
  rps: number;
  maxQueue?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type ReaderStats = {
  queued: number;
  inFlight: boolean;
  read: number;
  dropped: number;
  missing: number;
  rateLimited: number;
  maxQueueSeen: number;
  lastError: string | null;
};

type QueueItem = { sig: string; meta: ReaderMeta; requeued: boolean };

type RpcOutcome =
  | { kind: "tx"; tx: unknown }
  | { kind: "null" }
  | { kind: "rateLimited" }
  | { kind: "stopped" }
  | { kind: "error"; message: string };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rpcBody(sig: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getTransaction",
    params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]
  });
}

function parseOutcome(body: unknown): RpcOutcome {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!record) return { kind: "error", message: "getTransaction: malformed response body" };
  if (record.error) return { kind: "error", message: `getTransaction: ${JSON.stringify(record.error)}` };
  if (record.result === null || record.result === undefined) return { kind: "null" };
  return { kind: "tx", tx: record.result };
}

/**
 * Bounded FIFO of signatures drained by one worker paced at 1000/rps ms between getTransaction calls.
 * Public RPC tolerates ~1 rps; 429 blocks the worker for RATE_LIMIT_BLOCK_MS and requeues the signature at the front once.
 */
export class TransactionReader {
  private readonly rpcUrl: string;
  private readonly intervalMs: number;
  private readonly maxQueue: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private queue: QueueItem[] = [];
  /** Item the worker has taken off the queue and is pacing or reading; still counts as queued. */
  private held: QueueItem | null = null;
  /** sig -> enqueue time; insertion order is age order. */
  private readonly seen = new Map<string, number>();
  private running = false;
  private inFlight = false;
  private wake: (() => void) | null = null;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private blockedUntil = 0;
  private counters = { read: 0, dropped: 0, missing: 0, rateLimited: 0, maxQueueSeen: 0 };
  private lastError: string | null = null;

  constructor(opts: ReaderOptions) {
    if (!(opts.rps > 0)) throw new Error("TransactionReader: rps must be > 0");
    this.rpcUrl = opts.rpcUrl;
    this.intervalMs = 1000 / opts.rps;
    this.maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Returns false when the signature is a duplicate (queued or read within SEEN_TTL_MS). Drops the oldest when full. */
  enqueue(sig: string, meta: ReaderMeta): boolean {
    const now = this.now();
    this.pruneSeen(now);
    if (this.seen.has(sig)) return false;
    this.seen.set(sig, now);
    this.queue = [...this.queue, { sig, meta, requeued: false }];
    while (this.queue.length > this.maxQueue) this.dropOldest();
    this.counters.maxQueueSeen = Math.max(this.counters.maxQueueSeen, this.queue.length);
    this.wakeWorker();
    return true;
  }

  start(onTransaction: TransactionHandler): void {
    if (this.running) return;
    this.running = true;
    void this.loop(onTransaction);
  }

  stop(): void {
    this.running = false;
    this.wakeWorker();
  }

  stats(): ReaderStats {
    const queued = this.queue.length + (this.held ? 1 : 0);
    return { queued, inFlight: this.inFlight, ...this.counters, lastError: this.lastError };
  }

  private async loop(handler: TransactionHandler): Promise<void> {
    while (this.running) {
      const item = this.queue[0];
      if (!item) {
        await this.idle();
        continue;
      }
      this.queue = this.queue.slice(1);
      this.held = item;
      try {
        await this.process(item, handler);
      } catch (error) {
        this.lastError = errorMessage(error);
      } finally {
        this.held = null;
      }
    }
  }

  private async process(item: QueueItem, handler: TransactionHandler): Promise<void> {
    const first = await this.request(item.sig);
    if (first.kind !== "null") return this.settle(item, first, handler);
    await this.sleep(NULL_RETRY_MS);
    if (!this.running) return this.settle(item, { kind: "stopped" }, handler);
    const second = await this.request(item.sig);
    if (second.kind === "null") {
      this.counters.missing += 1;
      return;
    }
    return this.settle(item, second, handler);
  }

  private settle(item: QueueItem, outcome: RpcOutcome, handler: TransactionHandler): void {
    if (outcome.kind === "tx") {
      this.counters.read += 1;
      handler(outcome.tx, item.meta);
    } else if (outcome.kind === "rateLimited") {
      this.onRateLimited(item);
    } else if (outcome.kind === "stopped") {
      this.queue = [item, ...this.queue];
    } else if (outcome.kind === "error") {
      this.lastError = outcome.message;
    }
  }

  private onRateLimited(item: QueueItem): void {
    this.counters.rateLimited += 1;
    this.blockedUntil = this.now() + RATE_LIMIT_BLOCK_MS;
    this.lastError = "getTransaction: 429 rate limited";
    if (item.requeued) {
      this.counters.dropped += 1;
      return;
    }
    this.queue = [{ ...item, requeued: true }, ...this.queue];
  }

  /** Token pacing: one request per intervalMs measured from the previous request's start, plus any 429 block. */
  private async request(sig: string): Promise<RpcOutcome> {
    const readyAt = Math.max(this.lastRequestAt + this.intervalMs, this.blockedUntil);
    const wait = readyAt - this.now();
    if (wait > 0) await this.sleep(wait);
    if (!this.running) return { kind: "stopped" };
    this.lastRequestAt = this.now();
    this.inFlight = true;
    try {
      return await this.post(sig);
    } catch (error) {
      return { kind: "error", message: errorMessage(error) };
    } finally {
      this.inFlight = false;
    }
  }

  private async post(sig: string): Promise<RpcOutcome> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rpcBody(sig),
        signal: controller.signal
      });
      if (response.status === 429) return { kind: "rateLimited" };
      if (!response.ok) return { kind: "error", message: `getTransaction: upstream returned ${response.status}` };
      return parseOutcome(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  private wakeWorker(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private dropOldest(): void {
    const [oldest, ...rest] = this.queue;
    if (!oldest) return;
    this.queue = rest;
    this.seen.delete(oldest.sig);
    this.counters.dropped += 1;
  }

  private pruneSeen(now: number): void {
    for (const [sig, at] of this.seen) {
      if (now - at < SEEN_TTL_MS && this.seen.size <= SEEN_MAX) break;
      this.seen.delete(sig);
    }
  }
}
