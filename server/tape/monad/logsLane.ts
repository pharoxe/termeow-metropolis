import { config } from "../../config.js";

/**
 * One budget for every eth_getLogs the process sends (both log pollers, backfills, top-ups). Measured 2026-09-07
 * 22:00-22:10 IST on rpc.mainnet.chain.monad.com with the real 8-leg launch-poller batch: 2 s and 5 s cadences drew
 * 429s, 1 request per 10 s drew none; two pollers each ticking every 2 s (60 logs POSTs/min) kept all three logs
 * endpoints blocked for whole minutes. So: requests start at least `gapMs` apart and never overlap, the gap doubles on
 * every 429 the pool reports (up to maxGapMs) and halves back after a run of clean answers, and the lane holds while
 * the pool says every logs endpoint is blocked. A "priority" request (the first fill of a freshly pasted pool) takes
 * the next free slot ahead of queued routine ticks, at most once per backfillGapMs so ticks are delayed, not starved.
 */
export type LaneKind = "routine" | "priority";

export type LogsLaneOptions = {
  minGapMs: number;
  maxGapMs: number;
  /** Minimum spacing between two priority slots while routine requests are waiting (default DEFAULT_BACKFILL_GAP_MS). */
  backfillGapMs?: number;
  /** Clean answers in a row before the gap halves back toward minGapMs. */
  recoverAfterOks?: number;
  now?: () => number;
  log?: (message: string) => void;
};

export type LogsLaneStats = {
  gapMs: number;
  queued: { routine: number; priority: number };
  served: { routine: number; priority: number };
  /** Priority slots granted ahead of at least one waiting routine request. */
  jumped: number;
  rateLimited: number;
  holdUntil: number | null;
};

/** What the endpoint pool tells the lane; kept narrow so the pool never depends on the lane class. */
export type LaneReporter = {
  report429(): void;
  reportOk(): void;
  holdUntil(epochMs: number): void;
};

export const DEFAULT_RECOVER_AFTER_OKS = 6;
/** Same as the measured minimum gap: one priority jump per routine slot at most while ticks wait. */
export const DEFAULT_BACKFILL_GAP_MS = 5_000;

type Waiter = { resolve: () => void };

export class LogsLane implements LaneReporter {
  private readonly minGapMs: number;
  private readonly maxGapMs: number;
  private readonly backfillGapMs: number;
  private readonly recoverAfterOks: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private gap: number;
  private okStreak = 0;
  private busy = false;
  private lastStartAt = Number.NEGATIVE_INFINITY;
  private lastPriorityAt = Number.NEGATIVE_INFINITY;
  private hold = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly routine: Waiter[] = [];
  private readonly priority: Waiter[] = [];
  private counters = { routine: 0, priority: 0, jumped: 0, rateLimited: 0 };

  constructor(opts: LogsLaneOptions) {
    this.minGapMs = Math.max(0, opts.minGapMs);
    this.maxGapMs = Math.max(this.minGapMs, opts.maxGapMs);
    this.backfillGapMs = Math.max(0, opts.backfillGapMs ?? DEFAULT_BACKFILL_GAP_MS);
    this.recoverAfterOks = Math.max(1, opts.recoverAfterOks ?? DEFAULT_RECOVER_AFTER_OKS);
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((message) => console.warn(message));
    this.gap = this.minGapMs;
  }

  /** Current spacing between logs-lane requests; the poller ticks no faster than this. */
  gapMs(): number {
    return this.gap;
  }

  stats(): LogsLaneStats {
    return {
      gapMs: this.gap,
      queued: { routine: this.routine.length, priority: this.priority.length },
      served: { routine: this.counters.routine, priority: this.counters.priority },
      jumped: this.counters.jumped,
      rateLimited: this.counters.rateLimited,
      holdUntil: this.hold > this.now() ? this.hold : null
    };
  }

  /** Waits for a slot, runs `fn`, frees the lane when it settles. The gap is measured from the slot's start. */
  async run<T>(kind: LaneKind, fn: () => Promise<T>): Promise<T> {
    await this.acquire(kind);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  acquire(kind: LaneKind): Promise<void> {
    return new Promise<void>((resolve) => {
      (kind === "priority" ? this.priority : this.routine).push({ resolve });
      this.pump();
    });
  }

  release(): void {
    this.busy = false;
    this.pump();
  }

  report429(): void {
    this.counters.rateLimited += 1;
    this.okStreak = 0;
    const widened = Math.min(this.maxGapMs, Math.max(this.minGapMs, this.gap * 2));
    if (widened !== this.gap) this.log(`monad logs lane: 429, gap ${this.gap} -> ${widened} ms`);
    this.gap = widened;
  }

  reportOk(): void {
    this.okStreak += 1;
    if (this.okStreak < this.recoverAfterOks || this.gap <= this.minGapMs) return;
    this.okStreak = 0;
    this.gap = Math.max(this.minGapMs, Math.floor(this.gap / 2));
  }

  /** No slot starts before `epochMs` (the pool's earliest unblocked logs endpoint); never shortens an existing hold. */
  holdUntil(epochMs: number): void {
    if (epochMs <= this.hold) return;
    this.hold = epochMs;
    this.pump();
  }

  private pump(): void {
    if (this.busy || (this.routine.length === 0 && this.priority.length === 0)) return;
    const now = this.now();
    const readyAt = Math.max(this.lastStartAt + this.gap, this.hold);
    if (readyAt > now) {
      this.arm(readyAt - now);
      return;
    }
    const next = this.choose(now);
    this.busy = true;
    this.lastStartAt = now;
    next.resolve();
  }

  /** Priority goes first when nothing routine waits or its own gap has passed; otherwise the oldest routine request. */
  private choose(now: number): Waiter {
    const priorityDue = this.priority.length > 0 && (this.routine.length === 0 || now - this.lastPriorityAt >= this.backfillGapMs);
    if (priorityDue) {
      if (this.routine.length > 0) {
        this.counters.jumped += 1;
        this.log(`monad logs lane: priority backfill slot ahead of ${this.routine.length} queued tick(s)`);
      }
      this.lastPriorityAt = now;
      this.counters.priority += 1;
      return this.priority.shift() as Waiter;
    }
    this.counters.routine += 1;
    return this.routine.shift() as Waiter;
  }

  private arm(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, ms);
    this.timer.unref?.();
  }
}

let shared: LogsLane | null = null;

/** The process-wide lane, built from config.monad.logsLane on first use; injected transports never construct it. */
export function getLogsLane(): LogsLane {
  if (!shared) shared = new LogsLane(config.monad.logsLane);
  return shared;
}
