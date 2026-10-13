import type { PairRow } from "../../../shared/wire.js";
import { errorMessage } from "../../lib/http.js";
import type { EvmPoolRef, PoolResolveStatus } from "./pools.js";

/** A pool that failed to resolve is retried after this, doubling per failure up to RESOLVE_RETRY_MAX_MS. */
export const RESOLVE_RETRY_MIN_MS = 15_000;
export const RESOLVE_RETRY_MAX_MS = 5 * 60_000;
/** Pause between two pool resolutions so a token's Tier A set does not burst 2-3 eth_calls per pool at the RPC. */
export const RESOLVE_STAGGER_MS = 250;

export type PoolResolver = (row: PairRow) => Promise<EvmPoolRef | null>;

export type PoolResolveQueueOptions = {
  resolve: PoolResolver;
  resolveStatus: () => PoolResolveStatus;
  /** The rows still worth resolving when the retry timer fires; parked pools no longer listed are forgotten. */
  rows: () => PairRow[];
  /** Fired after every resolution that produced a ref and once the queue drains. */
  onChange: () => void;
  onError: (message: string) => void;
  now?: () => number;
  staggerMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
};

type Parked = { at: number; delayMs: number };

export function poolKey(row: PairRow): string {
  return row.pairAddress.trim().toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Serial pool resolution with a stagger between pools, so tracking a token never fans out N parallel eth_call bursts.
 * One resolution in flight at a time also makes poolResolveStatus().lastError attributable to the row that just failed.
 * Failures park the pool with a doubling delay and arm a retry timer, so a transient 429 heals on its own instead of
 * waiting for the next external track() call. Nothing here throws out of a timer or a drain.
 */
export class PoolResolveQueue {
  private readonly resolve: PoolResolver;
  private readonly resolveStatus: () => PoolResolveStatus;
  private readonly rows: () => PairRow[];
  private readonly onChange: () => void;
  private readonly onError: (message: string) => void;
  private readonly now: () => number;
  private readonly staggerMs: number;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly refs = new Map<string, EvmPoolRef>();
  private readonly parked = new Map<string, Parked>();
  /** Insertion order is FIFO order. */
  private readonly queued = new Map<string, PairRow>();
  /** The key whose resolution is in flight: shifted out of `queued`, not yet in `refs` or `parked`. */
  private active: string | null = null;
  private draining = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: PoolResolveQueueOptions) {
    this.resolve = opts.resolve;
    this.resolveStatus = opts.resolveStatus;
    this.rows = opts.rows;
    this.onChange = opts.onChange;
    this.onError = opts.onError;
    this.now = opts.now ?? (() => Date.now());
    this.staggerMs = opts.staggerMs ?? RESOLVE_STAGGER_MS;
    this.retryMinMs = opts.retryMinMs ?? RESOLVE_RETRY_MIN_MS;
    this.retryMaxMs = opts.retryMaxMs ?? RESOLVE_RETRY_MAX_MS;
  }

  ref(key: string): EvmPoolRef | undefined {
    return this.refs.get(key);
  }

  size(): { queued: number; parked: number } {
    return { queued: this.queued.size, parked: this.parked.size };
  }

  /** Queues every row that is neither resolved, queued or in flight, nor parked with its retry delay still running. */
  request(rows: PairRow[]): void {
    for (const row of rows) {
      const key = poolKey(row);
      if (this.refs.has(key) || this.queued.has(key) || key === this.active || !this.due(key)) continue;
      this.queued.set(key, row);
    }
    void this.drain();
  }

  /** Drops queued and parked work and the retry timer; resolved refs are kept for a later track(). */
  stop(): void {
    this.queued.clear();
    this.parked.clear();
    this.clearTimer();
  }

  private due(key: string): boolean {
    const parked = this.parked.get(key);
    return parked === undefined || this.now() - parked.at >= parked.delayMs;
  }

  private shift(): [string, PairRow] | undefined {
    const next = this.queued.entries().next();
    if (next.done) return undefined;
    this.queued.delete(next.value[0]);
    return next.value;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.shift(); next; next = this.shift()) {
        this.active = next[0];
        await this.resolveOne(next[0], next[1]);
        this.active = null;
        if (this.queued.size > 0 && this.staggerMs > 0) await sleep(this.staggerMs);
      }
    } finally {
      this.active = null;
      this.draining = false;
    }
    this.onChange();
    this.scheduleRetry();
  }

  private async resolveOne(key: string, row: PairRow): Promise<void> {
    try {
      const ref = await this.resolve(row);
      if (ref) {
        this.refs.set(key, ref);
        this.parked.delete(key);
        this.onChange();
        return;
      }
      this.park(key, row, this.resolveStatus().lastError ?? "unresolved");
    } catch (error) {
      this.park(key, row, errorMessage(error));
    }
  }

  private park(key: string, row: PairRow, reason: string): void {
    const previous = this.parked.get(key);
    const delayMs = previous ? Math.min(previous.delayMs * 2, this.retryMaxMs) : this.retryMinMs;
    this.parked.set(key, { at: this.now(), delayMs });
    this.onError(`pool ${row.pairAddress}: ${reason}`);
  }

  /** Arms one timer for the earliest parked retry; a firing re-requests the live rows, which re-queues the due ones. */
  private scheduleRetry(): void {
    this.clearTimer();
    let dueAt: number | null = null;
    for (const parked of this.parked.values()) {
      const at = parked.at + parked.delayMs;
      if (dueAt === null || at < dueAt) dueAt = at;
    }
    if (dueAt === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.retry();
    }, Math.max(0, dueAt - this.now()));
    this.timer.unref?.();
  }

  private retry(): void {
    try {
      const rows = this.rows();
      const live = new Set(rows.map(poolKey));
      for (const key of [...this.parked.keys()]) if (!live.has(key)) this.parked.delete(key);
      this.request(rows);
    } catch (error) {
      this.onError(`resolve retry: ${errorMessage(error)}`);
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
