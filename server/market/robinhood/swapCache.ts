import type { EvmPoolRef } from "../../tape/robinhood/pools.js";
import { sortPoints, type TimedSwapPoint } from "./swapCandles.js";
import { REORG_RESCAN_BLOCKS, type BackfillResult, type BackfillStop, type ChunkResult } from "./swapBackfill.js";

/**
 * In-memory swap history per pool: the backfill's timed swap points, kept continuous from `fromBlock` to `toBlock`,
 * topped up forward on read and deepened backward when a request wants more depth. A top-up re-reads the last
 * REORG_RESCAN_BLOCKS below the cached head and replaces what the cache held there, so an orphaned or lag-omitted swap
 * does not persist. One RPC operation per pool at a time; a reader waits at most `waitMs` for it and then takes
 * whatever is there. snapshot()/restore() serialize the settled pools for server/persist (component "swap-candles"):
 * a restored pool carries a `restored` mark (when, and how old the snapshot was) and its head is treated as stale, so
 * the first read tops it up from the cached head; a gap wider than the top-up cap resets it and fills afresh.
 */
export const DEFAULT_MAX_POOLS = 16;
export const DEFAULT_MAX_POINTS = 50_000;
/** A read within this window of the last top-up reuses the cached head instead of asking the chain again. */
export const DEFAULT_TOP_UP_MIN_MS = 5_000;
export const DEFAULT_WAIT_MS = 4_000;

export type PoolCandleState = {
  key: string;
  pool: EvmPoolRef;
  points: TimedSwapPoint[];
  fromBlock: number | null;
  /** Interpolated ms of fromBlock: coverage begins here even when the oldest swap is newer. */
  fromTime: number | null;
  toBlock: number | null;
  spanMs: number;
  stoppedBy: BackfillStop | null;
  backfilling: boolean;
  chunks: number;
  anchors: number;
  estimatedChunks: number;
  error: string | null;
  updatedAt: number;
  toppedUpAt: number | null;
  /** Points dropped by the per-pool cap (the oldest go first). */
  trimmed: number;
  /** Set while the pool's history came back from a snapshot rather than from this process's own backfill. */
  restored: RestoredMark | null;
};

/** When the snapshot was applied, how old its data was then, and how far the restored points reached. */
export type RestoredMark = { at: number; ageMs: number; points: number; toBlock: number; headTime: number | null };

/** A settled pool as the snapshot carries it: bounds known, no run in flight. */
export type PoolCandleSnapshot = {
  key: string;
  pool: EvmPoolRef;
  points: TimedSwapPoint[];
  fromBlock: number;
  fromTime: number;
  toBlock: number;
  spanMs: number;
  stoppedBy: BackfillStop;
  chunks: number;
  anchors: number;
  estimatedChunks: number;
  trimmed: number;
};

/** `collectedAt` is the cache's clock at snapshot(); restore() measures the data's age from it. Pools oldest-read first. */
export type SwapCacheSnapshot = { collectedAt: number; pools: PoolCandleSnapshot[] };
export type SwapCacheRestoreCounts = { pools: number; points: number; skipped: number };

export type BackfillFn = (pool: EvmPoolRef, run: { spanMs: number; toBlock?: number; onChunk?: (chunk: ChunkResult) => void }) => Promise<BackfillResult>;
export type TopUpFn = (pool: EvmPoolRef, fromBlock: number, onChunk?: (chunk: ChunkResult) => void) => Promise<BackfillResult>;

export type SwapCacheDeps = {
  backfill: BackfillFn;
  topUp: TopUpFn;
  now?: () => number;
  maxPools?: number;
  maxPoints?: number;
  topUpMinMs?: number;
};

export function poolCacheKey(pool: Pick<EvmPoolRef, "pair" | "token">): string {
  return `${pool.pair}:${pool.token}`;
}

function pointKey(point: Pick<TimedSwapPoint, "tx" | "logIndex">): string {
  return `${point.tx}:${point.logIndex}`;
}

function emptyState(pool: EvmPoolRef, now: number): PoolCandleState {
  return {
    key: poolCacheKey(pool),
    pool,
    points: [],
    fromBlock: null,
    fromTime: null,
    toBlock: null,
    spanMs: 0,
    stoppedBy: null,
    backfilling: false,
    chunks: 0,
    anchors: 0,
    estimatedChunks: 0,
    error: null,
    updatedAt: now,
    toppedUpAt: null,
    trimmed: 0,
    restored: null
  };
}

/**
 * The settled part of a state, or null until its first fill has finished (no bounds, no stop reason). A top-up or a
 * deepening run in flight is fine: chunks land with their bounds, so the points are continuous to `toBlock` at every
 * step; leaving such a pool out would let a save during a slow top-up wipe the last good file.
 */
function settled(state: PoolCandleState): PoolCandleSnapshot | null {
  if (state.fromBlock === null || state.fromTime === null || state.toBlock === null || state.stoppedBy === null) return null;
  const { key, pool, points, fromBlock, fromTime, toBlock, spanMs, stoppedBy, chunks, anchors, estimatedChunks, trimmed } = state;
  return { key, pool, points, fromBlock, fromTime, toBlock, spanMs, stoppedBy, chunks, anchors, estimatedChunks, trimmed };
}

/** Union of two point lists, deduped by tx:logIndex, ascending, capped from the oldest end. */
export function mergePoints(current: TimedSwapPoint[], incoming: TimedSwapPoint[], maxPoints: number): { points: TimedSwapPoint[]; trimmed: number } {
  const byKey = new Map<string, TimedSwapPoint>();
  for (const point of current) byKey.set(pointKey(point), point);
  for (const point of incoming) byKey.set(pointKey(point), point);
  const sorted = sortPoints([...byKey.values()]);
  const trimmed = Math.max(0, sorted.length - maxPoints);
  return { points: trimmed > 0 ? sorted.slice(trimmed) : sorted, trimmed };
}

function race(op: Promise<unknown>, waitMs: number): Promise<void> {
  if (!(waitMs > 0)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    timer.unref?.();
    op.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      }
    );
  });
}

export class SwapCandleCache {
  private readonly deps: SwapCacheDeps;
  private readonly now: () => number;
  private readonly maxPools: number;
  private readonly maxPoints: number;
  private readonly topUpMinMs: number;
  /** Insertion order is recency order; a read re-inserts, eviction drops the first key. */
  private readonly entries = new Map<string, PoolCandleState>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(deps: SwapCacheDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.maxPools = Math.max(1, deps.maxPools ?? DEFAULT_MAX_POOLS);
    this.maxPoints = Math.max(1, deps.maxPoints ?? DEFAULT_MAX_POINTS);
    this.topUpMinMs = deps.topUpMinMs ?? DEFAULT_TOP_UP_MIN_MS;
  }

  /** Current state without touching the chain; null when the pool was never asked for. */
  peek(pool: Pick<EvmPoolRef, "pair" | "token">): PoolCandleState | null {
    return this.entries.get(poolCacheKey(pool)) ?? null;
  }

  /**
   * Returns the pool's state after at most `waitMs`: starts a backfill for a new (or too-shallow) pool, tops up a cached
   * one whose head is older than topUpMinMs, and never runs two operations on one pool at once. Never throws.
   */
  async ensure(pool: EvmPoolRef, spanMs: number, waitMs = DEFAULT_WAIT_MS): Promise<PoolCandleState> {
    const key = poolCacheKey(pool);
    const state = this.touch(key) ?? this.create(pool);
    const pending = this.running.get(key) ?? this.start(key, state, spanMs);
    if (pending) await race(pending, waitMs);
    return this.view(key);
  }

  /** Settled pools in recency order (least recently read first) for server/persist; a pool still in its first fill is left out. */
  snapshot(): SwapCacheSnapshot {
    const pools: PoolCandleSnapshot[] = [];
    for (const state of this.entries.values()) {
      const pool = settled(state);
      if (pool) pools.push(pool);
    }
    return { collectedAt: this.now(), pools };
  }

  /**
   * Puts snapshot pools back as stale-headed, marked entries: the next read tops each up from its cached head (or resets
   * it when the gap exceeds the cap). A pool this process already holds is not overwritten; a pool whose key does not
   * match its ref is skipped. Never throws.
   */
  restore(snapshot: SwapCacheSnapshot): SwapCacheRestoreCounts {
    const now = this.now();
    const ageMs = Math.max(0, now - snapshot.collectedAt);
    let pools = 0;
    let points = 0;
    let skipped = 0;
    for (const saved of snapshot.pools) {
      if (saved.key !== poolCacheKey(saved.pool) || this.entries.has(saved.key)) {
        skipped += 1;
        continue;
      }
      const merged = mergePoints([], saved.points, this.maxPoints);
      const headTime = merged.points[merged.points.length - 1]?.time ?? null;
      this.entries.set(saved.key, {
        ...emptyState(saved.pool, now),
        ...saved,
        points: merged.points,
        trimmed: saved.trimmed + merged.trimmed,
        updatedAt: now,
        restored: { at: now, ageMs, points: merged.points.length, toBlock: saved.toBlock, headTime }
      });
      pools += 1;
      points += merged.points.length;
    }
    this.evict();
    return { pools, points, skipped };
  }

  /** Testing hook. */
  reset(): void {
    this.entries.clear();
    this.running.clear();
  }

  private create(pool: EvmPoolRef): PoolCandleState {
    const state = emptyState(pool, this.now());
    this.entries.set(state.key, state);
    this.evict();
    return state;
  }

  private touch(key: string): PoolCandleState | null {
    const state = this.entries.get(key);
    if (!state) return null;
    this.entries.delete(key);
    this.entries.set(key, state);
    return state;
  }

  private view(key: string): PoolCandleState {
    const state = this.entries.get(key);
    if (!state) throw new Error(`swap cache: ${key} evicted while in use`);
    return { ...state, points: [...state.points], backfilling: this.running.has(key) };
  }

  private evict(): void {
    while (this.entries.size > this.maxPools) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined || this.running.has(oldest)) break;
      this.entries.delete(oldest);
    }
  }

  private update(key: string, patch: Partial<PoolCandleState>): void {
    const state = this.entries.get(key);
    if (state) this.entries.set(key, { ...state, ...patch, updatedAt: this.now() });
  }

  private absorb(key: string, points: TimedSwapPoint[]): void {
    const state = this.entries.get(key);
    if (!state) return;
    const merged = mergePoints(state.points, points, this.maxPoints);
    this.update(key, { points: merged.points, trimmed: state.trimmed + merged.trimmed });
  }

  /** One finished chunk: its swaps, its anchors and the bounds it extends, visible to readers before the run ends. */
  private absorbChunk(key: string, chunk: ChunkResult): void {
    this.absorb(key, chunk.points);
    const state = this.entries.get(key);
    if (!state) return;
    const fromBlock = state.fromBlock === null ? chunk.fromBlock : Math.min(state.fromBlock, chunk.fromBlock);
    const fromTime = chunk.fromTime === null ? state.fromTime : state.fromTime === null ? chunk.fromTime : Math.min(state.fromTime, chunk.fromTime);
    this.update(key, {
      fromBlock,
      fromTime,
      toBlock: state.toBlock === null ? chunk.toBlock : Math.max(state.toBlock, chunk.toBlock),
      chunks: state.chunks + 1,
      anchors: state.anchors + chunk.anchors.length,
      estimatedChunks: state.estimatedChunks + (chunk.estimated ? 1 : 0)
    });
  }

  /** Picks the one operation the pool needs now (top-up, deepen, or first fill), or null when it is current. */
  private start(key: string, state: PoolCandleState, spanMs: number): Promise<void> | null {
    const now = this.now();
    const op = this.pick(state, spanMs, now);
    if (!op) return null;
    const run = op().finally(() => this.running.delete(key));
    this.running.set(key, run);
    return run;
  }

  private pick(state: PoolCandleState, spanMs: number, now: number): (() => Promise<void>) | null {
    const key = state.key;
    if (state.toBlock === null) return () => this.fill(key, spanMs, undefined);
    const stale = state.toppedUpAt === null || now - state.toppedUpAt >= this.topUpMinMs;
    if (stale) return () => this.topUp(key, state.toBlock as number).then(() => this.afterTopUp(key, spanMs, now));
    return this.deepen(key, spanMs, now);
  }

  /** A top-up that found the gap too wide resets the pool (toBlock null): fill afresh; otherwise deepen when asked. */
  private afterTopUp(key: string, spanMs: number, now: number): Promise<void> {
    const state = this.entries.get(key);
    if (state && state.toBlock === null) return this.fill(key, spanMs, undefined);
    return this.deepen(key, spanMs, now)?.() ?? Promise.resolve();
  }

  /** Continue below the oldest scanned block when the request wants more depth than a "depth"-stopped fill reached. */
  private deepen(key: string, spanMs: number, now: number): (() => Promise<void>) | null {
    const state = this.entries.get(key);
    if (!state || state.fromBlock === null || state.fromTime === null) return null;
    const covered = now - state.fromTime;
    if (covered >= spanMs || (state.stoppedBy !== "depth" && state.stoppedBy !== "error")) return null;
    return () => this.fill(key, spanMs, state.fromBlock === null ? undefined : state.fromBlock - 1);
  }

  private async fill(key: string, spanMs: number, toBlock: number | undefined): Promise<void> {
    const state = this.entries.get(key);
    if (!state) return;
    this.update(key, { spanMs: Math.max(state.spanMs, spanMs), error: null });
    const result = await this.deps.backfill(state.pool, { spanMs, toBlock, onChunk: (chunk) => this.absorbChunk(key, chunk) });
    this.absorb(key, result.points);
    const current = this.entries.get(key);
    if (!current) return;
    this.update(key, {
      fromBlock: result.fromBlock ?? current.fromBlock,
      fromTime: result.fromTime ?? current.fromTime,
      toBlock: current.toBlock ?? result.toBlock,
      // a head-started fill leaves the head current; a deepening run below an older fromBlock does not touch it
      toppedUpAt: toBlock === undefined ? this.now() : current.toppedUpAt,
      stoppedBy: result.stoppedBy,
      error: result.error
    });
  }

  /** Drops cached points in [lo, hi] the re-read did not report (reorged out or never there), then merges the re-read. */
  private replaceRange(key: string, lo: number, hi: number, points: TimedSwapPoint[]): void {
    const state = this.entries.get(key);
    if (!state || hi < lo) return;
    const kept = state.points.filter((point) => point.block < lo || point.block > hi);
    const merged = mergePoints(kept, points, this.maxPoints);
    this.update(key, { points: merged.points, trimmed: state.trimmed + merged.trimmed });
  }

  /** Forward fill from REORG_RESCAN_BLOCKS below the cached head; the re-read window replaces what the cache held there. */
  private async topUp(key: string, headBlock: number): Promise<void> {
    const state = this.entries.get(key);
    if (!state) return;
    const fromBlock = Math.max(-1, headBlock - REORG_RESCAN_BLOCKS);
    const result = await this.deps.topUp(state.pool, fromBlock, (chunk) => this.absorbChunk(key, chunk));
    this.replaceRange(key, fromBlock + 1, result.toBlock, result.points);
    const current = this.entries.get(key);
    if (!current) return;
    if (result.stoppedBy === "error" && result.chunks === 0) {
      // A gap wider than the cap (long downtime) means the saved history cannot be made continuous: start over.
      if (/exceeds/.test(result.error ?? "")) {
        this.entries.set(key, { ...emptyState(current.pool, this.now()), error: result.error });
        return;
      }
      // A dead RPC: keep the old history but say the head is stale.
      this.update(key, { error: result.error, toppedUpAt: this.now() });
      return;
    }
    this.update(key, { toBlock: Math.max(current.toBlock ?? 0, result.toBlock), toppedUpAt: this.now(), error: result.error });
  }
}
