import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PairRow } from "../../../shared/wire.js";
import { POOL_MANAGER, type EvmPoolRef } from "./pools.js";
import { PoolResolveQueue, poolKey, RESOLVE_RETRY_MAX_MS, RESOLVE_RETRY_MIN_MS, RESOLVE_STAGGER_MS, type PoolResolveQueueOptions } from "./resolveQueue.js";

const FATCOIN = "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const POOL_A = "0x353F2BD390D8db7BFC9B3dD389F8B71e8DF524fa";
const POOL_B = "0x70b5b746dc36c648893dafdf4b98d708a07673dfc1b3a0bb9dd70e36c0569f68";
const POOL_C = "0x00000000000000000000000000000000000000ff";
const START = 1_788_690_000_000;

function row(pairAddress: string): PairRow {
  return {
    chain: "monad",
    dex: "uniswap",
    pairAddress,
    baseMint: FATCOIN,
    quoteMint: USDG,
    liquidityUsd: null,
    volume24Usd: null,
    share24: null,
    txns: { m5: null, h1: null, h6: null, h24: null },
    tier: "A",
    sources: ["dexscreener"]
  };
}

function ref(pairAddress: string): EvmPoolRef {
  const pair = pairAddress.toLowerCase();
  const v4 = pair.length === 66;
  return {
    kind: v4 ? "v4" : "v3",
    pair,
    ledgerPair: pairAddress,
    logAddress: v4 ? POOL_MANAGER : pair,
    dex: "uniswap",
    token: FATCOIN,
    quote: USDG,
    tokenIsCurrency0: true,
    tokenDecimals: 18,
    quoteDecimals: 6,
    fee: v4 ? null : 3000
  };
}

type Deferred = { row: PairRow; resolve: (value: EvmPoolRef | null) => void; reject: (error: Error) => void };

/** A resolver whose answers the test releases one by one, to observe ordering and concurrency. */
function harness(overrides: Partial<PoolResolveQueueOptions> = {}) {
  let now = START;
  const pending: Deferred[] = [];
  const resolve = vi.fn(
    (pairRow: PairRow) =>
      new Promise<EvmPoolRef | null>((res, rej) => {
        pending.push({ row: pairRow, resolve: res, reject: rej });
      })
  );
  const onChange = vi.fn();
  const onError = vi.fn();
  let rows: PairRow[] = [];
  const queue = new PoolResolveQueue({
    resolve,
    resolveStatus: () => ({ lastError: "chain said no", decimalsCached: 0 }),
    rows: () => rows,
    onChange,
    onError,
    now: () => now,
    staggerMs: 0,
    ...overrides
  });
  return {
    queue,
    resolve,
    onChange,
    onError,
    pending,
    setRows: (next: PairRow[]) => {
      rows = next;
    },
    advance: async (ms: number) => {
      now += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
    /** Answers the oldest pending resolution and lets the drain loop move on. */
    release: async (value: EvmPoolRef | null | Error) => {
      const next = pending.shift();
      if (!next) throw new Error("nothing pending");
      if (value instanceof Error) next.reject(value);
      else next.resolve(value);
      await vi.advanceTimersByTimeAsync(0);
    }
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("PoolResolveQueue", () => {
  it("resolves requested rows one at a time in FIFO order and reports each ref as it lands", async () => {
    const h = harness();
    h.queue.request([row(POOL_A), row(POOL_B), row(POOL_C)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.pending.map((p) => p.row.pairAddress)).toEqual([POOL_A]);
    await h.release(ref(POOL_A));
    expect(h.queue.ref(poolKey(row(POOL_A)))).toEqual(ref(POOL_A));
    expect(h.onChange).toHaveBeenCalledTimes(1);
    expect(h.resolve).toHaveBeenCalledTimes(2);
    await h.release(ref(POOL_B));
    await h.release(ref(POOL_C));
    expect(h.resolve.mock.calls.map(([r]) => r.pairAddress)).toEqual([POOL_A, POOL_B, POOL_C]);
    expect(h.onChange).toHaveBeenCalledTimes(4);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.queue.size()).toEqual({ queued: 0, parked: 0 });
  });

  it("waits staggerMs between two resolutions", async () => {
    const h = harness({ staggerMs: RESOLVE_STAGGER_MS });
    h.queue.request([row(POOL_A), row(POOL_B)]);
    await vi.advanceTimersByTimeAsync(0);
    await h.release(ref(POOL_A));
    expect(h.resolve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RESOLVE_STAGGER_MS - 1);
    expect(h.resolve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.resolve).toHaveBeenCalledTimes(2);
  });

  it("does not re-queue a row that is resolved, queued, or parked and not yet due", async () => {
    const h = harness();
    h.queue.request([row(POOL_A), row(POOL_B)]);
    h.queue.request([row(POOL_A), row(POOL_B)]);
    await vi.advanceTimersByTimeAsync(0);
    await h.release(ref(POOL_A));
    await h.release(null);
    expect(h.resolve).toHaveBeenCalledTimes(2);
    expect(h.onError).toHaveBeenCalledWith(`pool ${POOL_B}: chain said no`);
    h.queue.request([row(POOL_A), row(POOL_B)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.resolve).toHaveBeenCalledTimes(2);
    expect(h.queue.size()).toEqual({ queued: 0, parked: 1 });
  });

  it("retries a parked pool from its own timer after RESOLVE_RETRY_MIN_MS, doubling up to the max", async () => {
    const h = harness();
    h.setRows([row(POOL_A)]);
    h.queue.request([row(POOL_A)]);
    await vi.advanceTimersByTimeAsync(0);
    await h.release(new Error("eth_call: upstream returned 429"));
    expect(h.onError).toHaveBeenCalledWith(`pool ${POOL_A}: eth_call: upstream returned 429`);
    await h.advance(RESOLVE_RETRY_MIN_MS - 1);
    expect(h.resolve).toHaveBeenCalledTimes(1);
    await h.advance(1);
    expect(h.resolve).toHaveBeenCalledTimes(2);
    await h.release(null);
    await h.advance(RESOLVE_RETRY_MIN_MS * 2 - 1);
    expect(h.resolve).toHaveBeenCalledTimes(2);
    await h.advance(1);
    expect(h.resolve).toHaveBeenCalledTimes(3);
    await h.release(null);
    for (let i = 0; i < 6; i += 1) {
      await h.advance(RESOLVE_RETRY_MAX_MS);
      await h.release(null);
    }
    const calls = h.resolve.mock.calls.length;
    await h.advance(RESOLVE_RETRY_MAX_MS - 1);
    expect(h.resolve).toHaveBeenCalledTimes(calls);
    await h.advance(1);
    expect(h.resolve).toHaveBeenCalledTimes(calls + 1);
    await h.release(ref(POOL_A));
    expect(h.queue.ref(poolKey(row(POOL_A)))).toEqual(ref(POOL_A));
    expect(h.queue.size()).toEqual({ queued: 0, parked: 0 });
    await h.advance(RESOLVE_RETRY_MAX_MS * 2);
    expect(h.resolve).toHaveBeenCalledTimes(calls + 1);
  });

  it("forgets a parked pool that the live rows no longer list when the retry fires", async () => {
    const h = harness();
    h.setRows([row(POOL_A), row(POOL_B)]);
    h.queue.request([row(POOL_A), row(POOL_B)]);
    await vi.advanceTimersByTimeAsync(0);
    await h.release(null);
    await h.release(null);
    expect(h.queue.size()).toEqual({ queued: 0, parked: 2 });
    h.setRows([row(POOL_B)]);
    await h.advance(RESOLVE_RETRY_MIN_MS);
    expect(h.resolve).toHaveBeenCalledTimes(3);
    expect(h.pending.map((p) => p.row.pairAddress)).toEqual([POOL_B]);
    await h.release(ref(POOL_B));
    expect(h.queue.size()).toEqual({ queued: 0, parked: 0 });
  });

  it("stop drops queued and parked work and the retry timer but keeps resolved refs", async () => {
    const h = harness();
    h.setRows([row(POOL_A), row(POOL_B), row(POOL_C)]);
    h.queue.request([row(POOL_A), row(POOL_B), row(POOL_C)]);
    await vi.advanceTimersByTimeAsync(0);
    await h.release(ref(POOL_A));
    await h.release(null);
    expect(h.queue.size()).toEqual({ queued: 0, parked: 1 });
    expect(h.pending).toHaveLength(1);
    h.queue.stop();
    expect(h.queue.size()).toEqual({ queued: 0, parked: 0 });
    expect(h.queue.ref(poolKey(row(POOL_A)))).toEqual(ref(POOL_A));
    await h.release(ref(POOL_C));
    await h.advance(RESOLVE_RETRY_MAX_MS * 2);
    expect(h.resolve).toHaveBeenCalledTimes(3);
  });

  it("a throwing rows() inside the retry timer is reported, never thrown", async () => {
    const h = harness({
      rows: () => {
        throw new Error("registry gone");
      }
    });
    h.queue.request([row(POOL_A)]);
    await vi.advanceTimersByTimeAsync(0);
    await h.release(null);
    await h.advance(RESOLVE_RETRY_MIN_MS);
    expect(h.onError).toHaveBeenLastCalledWith("resolve retry: registry gone");
    expect(h.resolve).toHaveBeenCalledTimes(1);
  });

  it("exports the measured defaults", () => {
    expect(RESOLVE_RETRY_MIN_MS).toBe(15_000);
    expect(RESOLVE_RETRY_MAX_MS).toBe(300_000);
    expect(RESOLVE_STAGGER_MS).toBe(250);
    expect(poolKey(row(POOL_A))).toBe(POOL_A.toLowerCase());
  });
});
