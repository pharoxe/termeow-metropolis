import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { UpstreamError } from "../../lib/http.js";
import type { EvmLog } from "../../tape/monad/decode.js";
import { POOL_MANAGER, type EvmPoolRef } from "../../tape/monad/pools.js";
import { EvmRpcError, hexToNumber } from "../../tape/monad/rpc.js";
import {
  MAX_BACKFILL_BLOCKS,
  backfillSpanMs,
  backfillSwaps,
  isRateLimited,
  isTransient,
  rangeLimitOf,
  swapLogFilter,
  topUpSwaps,
  type BackfillRpc,
  type LogFilter
} from "./swapBackfill.js";
import { BLOCK_MS } from "./swapCandles.js";

type FixtureFile = { logs: Array<Omit<EvmLog, "address">> };
type Blocks = { fatcoinV4: { first: { number: number; timestampSec: number }; last: { number: number; timestampSec: number } } };

function load<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(`../__fixtures__/r6/${file}`, import.meta.url), "utf8")) as T;
}

const POOL: EvmPoolRef = {
  kind: "v4",
  pair: "0x46ba8216b5d05ff33427b976663836ec5b34b3e261f374f9a5e773d776d3af85",
  ledgerPair: "0x46ba8216b5d05ff33427b976663836ec5b34b3e261f374f9a5e773d776d3af85",
  logAddress: POOL_MANAGER,
  dex: "uniswap",
  token: "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01",
  quote: "0x8005d266423c7ea827372c9c864491e5786600ea",
  tokenIsCurrency0: true,
  tokenDecimals: 18,
  quoteDecimals: 18,
  fee: null
};
const V3_POOL: EvmPoolRef = { ...POOL, kind: "v3", pair: "0x7a6a053eccf1446a2633e05aa6d40d09381997ec", logAddress: "0x7a6a053eccf1446a2633e05aa6d40d09381997ec", fee: 3000 };

const LOGS: EvmLog[] = ["fatcoin-v4-swaps-1.json", "fatcoin-v4-swaps-2.json"].flatMap((file) => load<FixtureFile>(file).logs.map((log) => ({ ...log, address: POOL_MANAGER })));
const BLOCKS = load<Blocks>("blocks.json").fatcoinV4;
const FIRST = BLOCKS.first.number;
const HEAD = BLOCKS.last.number;
/** A linear chain clock anchored on the two measured blocks (the fixtures span 79,622 blocks over 8,030 s). */
const T0 = BLOCKS.first.timestampSec * 1000;
const SLOPE = (BLOCKS.last.timestampSec * 1000 - T0) / (HEAD - FIRST);
const clock = (block: number): number => Math.round(T0 + (block - FIRST) * SLOPE);

type FakeRpc = BackfillRpc & { getLogs: ReturnType<typeof vi.fn>; blockTime: ReturnType<typeof vi.fn>; calls: LogFilter[] };

/** eth_getLogs over the fixture, with optional per-call failure injection; block times from the linear clock. */
function fakeRpc(opts: { head?: number; fail?: (call: number, filter: LogFilter) => Error | null; noTime?: Set<number> } = {}): FakeRpc {
  const calls: LogFilter[] = [];
  const getLogs = vi.fn(async (filter: LogFilter) => {
    calls.push(filter);
    const error = opts.fail?.(calls.length, filter);
    if (error) throw error;
    const from = hexToNumber(filter.fromBlock);
    const to = hexToNumber(filter.toBlock);
    return LOGS.filter((log) => {
      const block = hexToNumber(log.blockNumber);
      return block >= from && block <= to && log.address === filter.address && log.topics[0] === filter.topics[0] && (filter.topics[1] === null || filter.topics[1] === undefined || log.topics[1] === filter.topics[1]);
    });
  });
  const blockTime = vi.fn(async (block: number) => (opts.noTime?.has(block) ? null : clock(block)));
  return { getLogs, blockTime, blockNumber: async () => opts.head ?? HEAD, calls };
}

const noSleep = { sleep: async () => undefined, gapMs: 0 };

describe("swapLogFilter", () => {
  it("targets the PoolManager + poolId topic for v4 and the pool contract for v2/v3, hex quantities inclusive", () => {
    expect(swapLogFilter(POOL, 16, 255)).toEqual({ address: POOL_MANAGER, topics: [LOGS[0].topics[0], POOL.pair], fromBlock: "0x10", toBlock: "0xff" });
    const v3 = swapLogFilter(V3_POOL, 1, 2);
    expect(v3.address).toBe(V3_POOL.logAddress);
    expect(v3.topics).toHaveLength(1);
    expect(v3.topics[0]).toMatch(/^0xc42079f9/);
  });
});

describe("error classification", () => {
  it("reads blockmachine's -32602 max_blocks, halves on a bare range message, ignores other errors", () => {
    expect(rangeLimitOf(new EvmRpcError("eth_getLogs: block range exceeds maximum allowed (max=10000, requested=20001)", -32602, { max_blocks: 10000 }))).toBe(10000);
    expect(rangeLimitOf(new EvmRpcError("eth_getLogs: query returned too many blocks", -32000))).toBe(0);
    expect(rangeLimitOf(new EvmRpcError("eth_getLogs: log query timed out", -32000))).toBeNull();
    expect(rangeLimitOf(new Error("upstream returned 429"))).toBeNull();
  });

  it("recognises a 429 from rpc.ts (plain Error) and from an UpstreamError", () => {
    expect(isRateLimited(new Error("eth_getLogs: upstream returned 429"))).toBe(true);
    expect(isRateLimited(new UpstreamError("rpc 429 rate limited", 429))).toBe(true);
    expect(isRateLimited(new UpstreamError("boom", 500))).toBe(false);
    expect(isRateLimited(new Error("timeout"))).toBe(false);
  });
});

describe("backfillSwaps", () => {
  it("walks newest-first in inclusive chunks, reads two anchors per chunk with swaps and interpolates the rest", async () => {
    const rpc = fakeRpc();
    const chunks: number[] = [];
    const result = await backfillSwaps(POOL, { spanMs: 30 * 60_000, chunkBlocks: 10_000, ...noSleep, onChunk: (chunk) => chunks.push(chunk.fromTime ?? NaN) }, rpc);
    expect(result.stoppedBy).toBe("depth");
    expect(chunks).toHaveLength(result.chunks);
    expect(chunks.every((time, index) => Number.isFinite(time) && (index === 0 || time < chunks[index - 1]))).toBe(true);
    expect(chunks[chunks.length - 1]).toBe(result.fromTime);
    expect(result.error).toBeNull();
    expect(rpc.calls[0]).toMatchObject({ fromBlock: `0x${(HEAD - 9_999).toString(16)}`, toBlock: `0x${HEAD.toString(16)}` });
    expect(rpc.calls[1]).toMatchObject({ toBlock: `0x${(HEAD - 10_000).toString(16)}` });
    expect(result.chunks).toBe(rpc.calls.length);
    // head anchor + at most two per chunk; every chunk in this window has swaps
    expect(result.anchors).toBeGreaterThanOrEqual(result.chunks);
    expect(result.anchors).toBeLessThanOrEqual(2 * result.chunks);
    expect(rpc.blockTime).toHaveBeenCalledTimes(1 + result.anchors);
    expect(result.points.length).toBeGreaterThan(0);
    expect(result.points.every((point, index) => index === 0 || result.points[index - 1].block <= point.block)).toBe(true);
    for (const point of result.points) expect(Math.abs(point.time - clock(point.block))).toBeLessThanOrEqual(1);
    expect(result.fromTime).toBeLessThanOrEqual(clock(HEAD) - 30 * 60_000);
    expect(result.fromBlock).toBe(HEAD - result.chunks * 10_000 + 1);
  });

  it("stops at the block cap with stoppedBy 'cap' and at genesis with 'genesis'", async () => {
    const capped = await backfillSwaps(POOL, { spanMs: 24 * 3_600_000, chunkBlocks: 10_000, maxBlocks: 30_000, ...noSleep }, fakeRpc());
    expect(capped.stoppedBy).toBe("cap");
    expect(capped.chunks).toBe(3);
    const genesis = await backfillSwaps(POOL, { spanMs: 3_600_000, chunkBlocks: 5, ...noSleep }, fakeRpc({ head: 12 }));
    expect(genesis.stoppedBy).toBe("genesis");
    expect(genesis.fromBlock).toBe(0);
    expect(genesis.points).toEqual([]);
  });

  it("shrinks the chunk to the node's max_blocks on a range error and keeps that size for later chunks", async () => {
    const rpc = fakeRpc({
      fail: (_call, filter) => (hexToNumber(filter.toBlock) - hexToNumber(filter.fromBlock) + 1 > 10_000
        ? new EvmRpcError("eth_getLogs: block range exceeds maximum allowed", -32602, { max_blocks: 10000, max_step: 9999 })
        : null)
    });
    const result = await backfillSwaps(POOL, { spanMs: 25 * 60_000, chunkBlocks: 50_000, ...noSleep }, rpc);
    expect(result.error).toBeNull();
    expect(result.stoppedBy).toBe("depth");
    const spans = rpc.calls.map((filter) => hexToNumber(filter.toBlock) - hexToNumber(filter.fromBlock) + 1);
    expect(spans[0]).toBe(50_000);
    expect(spans.slice(1).every((span) => span <= 10_000)).toBe(true);
    expect(result.points.length).toBeGreaterThan(0);
  });

  it("retries a 429 once after the configured wait, then surfaces a second failure as a partial result", async () => {
    const sleep = vi.fn(async () => undefined);
    const once = fakeRpc({ fail: (call) => (call === 2 ? new Error("eth_getLogs: upstream returned 429") : null) });
    const ok = await backfillSwaps(POOL, { spanMs: 20 * 60_000, chunkBlocks: 10_000, sleep, gapMs: 0, retry429Ms: 20_000 }, once);
    expect(ok.error).toBeNull();
    expect(sleep).toHaveBeenCalledWith(20_000);
    const twice = fakeRpc({ fail: (call) => (call >= 2 ? new Error("eth_getLogs: upstream returned 429") : null) });
    const partial = await backfillSwaps(POOL, { spanMs: 20 * 60_000, chunkBlocks: 10_000, ...noSleep, retry429Ms: 0 }, twice);
    expect(partial.stoppedBy).toBe("error");
    expect(partial.error).toMatch(/429/);
    expect(partial.chunks).toBe(1);
    expect(partial.points.length).toBeGreaterThan(0);
    expect(partial.fromBlock).toBe(HEAD - 9_999);
  });

  it("retries a transport abort once after the chunk gap (another endpoint answers), and ends the fill on a repeat", async () => {
    expect(isTransient(new Error("This operation was aborted"))).toBe(true);
    expect(isTransient(new Error("fetch failed"))).toBe(true);
    expect(isTransient(new EvmRpcError("eth_getLogs: historical state is not available", -32000))).toBe(false);
    expect(isTransient(new Error("eth_getLogs: non-array result"))).toBe(false);
    const sleep = vi.fn(async () => undefined);
    const once = fakeRpc({ fail: (call) => (call === 2 ? new Error("This operation was aborted") : null) });
    const ok = await backfillSwaps(POOL, { spanMs: 20 * 60_000, chunkBlocks: 10_000, sleep, gapMs: 1_500 }, once);
    expect(ok.error).toBeNull();
    expect(sleep).toHaveBeenCalledWith(1_500);
    const twice = fakeRpc({ fail: (call) => (call >= 2 ? new Error("This operation was aborted") : null) });
    const partial = await backfillSwaps(POOL, { spanMs: 20 * 60_000, chunkBlocks: 10_000, ...noSleep }, twice);
    expect(partial.stoppedBy).toBe("error");
    expect(partial.error).toMatch(/aborted/);
    expect(partial.chunks).toBe(1);
  });

  it("refuses to anchor on the wall clock: an unreadable head block time ends the run as an error before any getLogs", async () => {
    const rpc = fakeRpc({ noTime: new Set([HEAD]) });
    const result = await backfillSwaps(POOL, { spanMs: 20 * 60_000, chunkBlocks: 10_000, ...noSleep }, rpc);
    expect(result).toMatchObject({ stoppedBy: "error", chunks: 0, points: [], fromBlock: null });
    expect(result.error).toMatch(/head block \d+: block time unreadable/);
    expect(rpc.getLogs).not.toHaveBeenCalled();
    const topUp = await topUpSwaps(POOL, HEAD - 100, rpc, noSleep);
    expect(topUp.stoppedBy).toBe("error");
    expect(topUp.error).toMatch(/block time unreadable/);
    expect(rpc.getLogs).not.toHaveBeenCalled();
  });

  it("flags a chunk whose anchors could not be read and places it from the anchors it has", async () => {
    // every swap block of the newest chunk except the head itself is unreadable, so the chunk keeps one anchor and is flagged
    const rpc = fakeRpc({ noTime: new Set(LOGS.map((log) => hexToNumber(log.blockNumber)).filter((block) => block > HEAD - 10_000 && block !== HEAD)) });
    const result = await backfillSwaps(POOL, { spanMs: 20 * 60_000, chunkBlocks: 10_000, ...noSleep }, rpc);
    expect(result.estimatedChunks).toBe(1);
    expect(result.error).toBeNull();
    const oldest = result.points.find((point) => point.block > HEAD - 10_000) as (typeof result.points)[number];
    // extrapolated from the head anchor at BLOCK_MS (vs the fixture's 100.86 ms/block), so within a second of the real clock
    expect(Math.abs(oldest.time - clock(oldest.block))).toBeLessThan((HEAD - oldest.block) * Math.abs(BLOCK_MS - SLOPE) + 1_000);
  });
});

describe("topUpSwaps", () => {
  it("fills forward from the cached head to the chain head, oldest chunk first, and no-ops when already current", async () => {
    const rpc = fakeRpc();
    const result = await topUpSwaps(POOL, HEAD - 25_000, rpc, { chunkBlocks: 10_000, ...noSleep });
    expect(result.stoppedBy).toBe("head");
    expect(result.toBlock).toBe(HEAD);
    expect(rpc.calls.map((filter) => hexToNumber(filter.fromBlock))).toEqual([HEAD - 24_999, HEAD - 14_999, HEAD - 4_999]);
    expect(result.points.every((point) => point.block > HEAD - 25_000)).toBe(true);
    // fromBlock+1 sits just below the first chunk's oldest swap anchor: BLOCK_MS extrapolation over a few blocks
    expect(Math.abs((result.fromTime as number) - clock(HEAD - 24_999))).toBeLessThan(100);
    const current = await topUpSwaps(POOL, HEAD, fakeRpc(), noSleep);
    expect(current).toMatchObject({ chunks: 0, points: [], toBlock: HEAD, stoppedBy: "head" });
  });

  it("refuses a gap wider than the block cap instead of scanning it", async () => {
    const result = await topUpSwaps(POOL, HEAD - MAX_BACKFILL_BLOCKS - 1, fakeRpc(), noSleep);
    expect(result.stoppedBy).toBe("error");
    expect(result.error).toMatch(/exceeds/);
    expect(result.chunks).toBe(0);
  });
});

describe("backfillSpanMs", () => {
  it("asks for 2,000 bars of the interval but never deeper than the block cap allows", () => {
    expect(backfillSpanMs(60_000, 10)).toBe(600_000);
    expect(backfillSpanMs(60_000)).toBe(Math.round(MAX_BACKFILL_BLOCKS * BLOCK_MS));
    expect(backfillSpanMs(3_600_000)).toBe(Math.round(MAX_BACKFILL_BLOCKS * BLOCK_MS));
  });
});
