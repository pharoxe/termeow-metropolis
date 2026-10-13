import { errorMessage, UpstreamError } from "../../lib/http.js";
import { SWAP_TOPICS, type EvmLog } from "../../tape/monad/decode.js";
import { POOL_MANAGER, type EvmPoolRef } from "../../tape/monad/pools.js";
import { EvmRpcError, hexToNumber, toHexQuantity } from "../../tape/monad/rpc.js";
import { BLOCK_MS, decodeSwapPoints, interpolateBlockTime, timePoints, type BlockAnchor, type TimedSwapPoint } from "./swapCandles.js";

/**
 * Historical Swap logs for one pool, fetched newest-first in block chunks through whatever transport rpc.ts exposes.
 * Measured 2026-09-07 (see the R6 capture): the official RPC caps a getLogs by query time (~3 s), blockmachine by an
 * INCLUSIVE 10,000-block range (-32602 with data.max_blocks), nodeflare 429s within seconds; 10,000-block chunks work
 * on every endpoint that serves history at all. Block times come from two anchors per chunk (oldest and newest swap
 * block) read through the block-time cache; every other swap in the chunk is placed by linear interpolation, and the
 * result says so. Never one eth_getBlockByNumber per log.
 */
/**
 * Monad public RPCs cap one eth_getLogs at 100 (QuickNode, Foundation) or 1,000 blocks (Alchemy, Ankr); the endpoint
 * pool routes wide requests to the 1,000-block hosts and getLogsPaged shrinks the chunk on a -32602 for the rest of the run.
 */
export const DEFAULT_CHUNK_BLOCKS = 1_000;
/** ~2 h of 0.3 s blocks: the deepest a first backfill goes on public RPC; older bars come from GeckoTerminal OHLCV. */
export const MAX_BACKFILL_BLOCKS = 24_000;
/** A run ends after this many calls (stoppedBy "cap", partial); the next top-up continues from the cache. */
export const MAX_CHUNKS_PER_RUN = 24;
export const DEFAULT_CHUNK_GAP_MS = 1_500;
/** Public RPCs answer a bare 429 with no retry-after; wait this long before retrying the chunk. */
export const RETRY_429_MS = 20_000;
export const DEFAULT_BARS = 2_000;
/**
 * Blocks below the cached head a top-up re-reads and REPLACES, so a swap from a block the chain later orphaned (or one
 * a lagging logs node omitted while a faster node answered eth_blockNumber) does not stay in the cache for good; the
 * own poller re-scans 5 blocks for the same reason, this window is wider because the two calls hit different nodes
 * (Monad finalizes in two 300 ms slots, so 64 blocks is ~20 s of margin).
 */
export const REORG_RESCAN_BLOCKS = 64;
const RANGE_ERROR_CODE = -32602;

export type LogFilter = { address: string; topics: Array<string | null>; fromBlock: string; toBlock: string };

/** The three RPC calls the backfill makes, each already routed/paced by the caller's transport. */
export type BackfillRpc = {
  getLogs(filter: LogFilter): Promise<unknown>;
  blockNumber(): Promise<number>;
  /** ms epoch of a block, or null when it cannot be read right now (BlockTimeCache semantics). */
  blockTime(block: number): Promise<number | null>;
};

export type BackfillOptions = {
  chunkBlocks?: number;
  maxBlocks?: number;
  gapMs?: number;
  retry429Ms?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type ChunkResult = {
  fromBlock: number;
  /** Interpolated ms of fromBlock once the run has anchors around it (set by the run, null from fetchChunk alone). */
  fromTime: number | null;
  toBlock: number;
  points: TimedSwapPoint[];
  anchors: BlockAnchor[];
  /** True when an anchor could not be read and the chunk's times lean on BLOCK_MS extrapolation from another anchor. */
  estimated: boolean;
};

export type BackfillStop = "depth" | "cap" | "genesis" | "head" | "error";

export type BackfillResult = {
  /** Oldest block scanned (null when not even one chunk completed). */
  fromBlock: number | null;
  /** Interpolated ms of `fromBlock`; the coverage the caller may vouch for starts here, swaps or not. */
  fromTime: number | null;
  toBlock: number;
  chunks: number;
  anchors: number;
  estimatedChunks: number;
  points: TimedSwapPoint[];
  stoppedBy: BackfillStop;
  error: string | null;
};

export type BackfillRun = BackfillOptions & {
  /** Depth wanted, measured back from the head's time. */
  spanMs: number;
  /** Start scanning at this block instead of the head (a continuation below an earlier fill). */
  toBlock?: number;
  onChunk?: (chunk: ChunkResult) => void;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** eth_getLogs filter for the pool's Swap topic: PoolManager + poolId topic for v4, the pool contract for v2/v3. */
export function swapLogFilter(pool: EvmPoolRef, fromBlock: number, toBlock: number): LogFilter {
  const topics: Array<string | null> = pool.kind === "v4" ? [SWAP_TOPICS.v4, pool.pair] : [SWAP_TOPICS[pool.kind]];
  return { address: pool.kind === "v4" ? POOL_MANAGER : pool.logAddress, topics, fromBlock: toHexQuantity(fromBlock), toBlock: toHexQuantity(toBlock) };
}

/** blockmachine-style "range too large": returns the node's max span when it states one, else a halving hint (0). */
export function rangeLimitOf(error: unknown): number | null {
  if (!(error instanceof EvmRpcError)) return null;
  const data = error.data && typeof error.data === "object" ? (error.data as Record<string, unknown>) : {};
  if (error.code !== RANGE_ERROR_CODE && !/block range|range exceeds|too many blocks/i.test(error.message)) return null;
  return typeof data.max_blocks === "number" && data.max_blocks > 0 ? data.max_blocks : 0;
}

export function isRateLimited(error: unknown): boolean {
  if (error instanceof UpstreamError) return error.status === 429;
  return /\b429\b|rate.?limit/i.test(errorMessage(error));
}

/** A transport hiccup (rpc.ts 15 s abort, reset socket, DNS blip) worth one retry after a chunk gap; not a node's verdict. */
export function isTransient(error: unknown): boolean {
  if (error instanceof EvmRpcError) return false;
  return /aborted|abort|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(errorMessage(error));
}

function asLogs(result: unknown): EvmLog[] {
  if (!Array.isArray(result)) throw new Error("eth_getLogs: non-array result");
  return result.filter((log): log is EvmLog => Boolean(log) && typeof log === "object" && typeof (log as EvmLog).data === "string");
}

function blockOf(log: EvmLog): number | null {
  try {
    return hexToNumber(log.blockNumber);
  } catch {
    return null;
  }
}

/** Two anchors per chunk: the oldest and newest swap blocks (one when they coincide); a chunk without swaps needs none. */
async function readAnchors(logs: EvmLog[], rpc: BackfillRpc): Promise<{ anchors: BlockAnchor[]; missing: number }> {
  const blocks = logs.map(blockOf).filter((block): block is number => block !== null);
  if (blocks.length === 0) return { anchors: [], missing: 0 };
  const wanted = [...new Set([Math.min(...blocks), Math.max(...blocks)])];
  const anchors: BlockAnchor[] = [];
  let missing = 0;
  for (const block of wanted) {
    const time = await rpc.blockTime(block);
    if (time === null) missing += 1;
    else anchors.push({ block, time });
  }
  return { anchors, missing };
}

/**
 * One getLogs over [from, to], shrinking on a range error, retrying a 429 once after retry429Ms and a transport
 * abort/failure once after gapMs (the pool routes the retry to another endpoint); anything else ends the fill.
 */
async function getLogsPaged(pool: EvmPoolRef, from: number, to: number, rpc: BackfillRpc, opts: Required<Pick<BackfillOptions, "retry429Ms" | "gapMs" | "sleep">>): Promise<{ logs: EvmLog[]; chunkBlocks: number | null }> {
  let retried = false;
  let retriedTransient = false;
  let span = to - from + 1;
  let lo = from;
  const logs: EvmLog[] = [];
  let shrunkTo: number | null = null;
  while (lo <= to) {
    const hi = Math.min(to, lo + span - 1);
    try {
      logs.push(...asLogs(await rpc.getLogs(swapLogFilter(pool, lo, hi))));
      lo = hi + 1;
    } catch (error) {
      const limit = rangeLimitOf(error);
      if (limit !== null && span > 1) {
        span = limit > 0 ? Math.min(limit, span - 1) : Math.max(1, Math.floor(span / 2));
        shrunkTo = span;
        continue;
      }
      if (isRateLimited(error) && !retried) {
        retried = true;
        await opts.sleep(opts.retry429Ms);
        continue;
      }
      if (isTransient(error) && !retriedTransient) {
        retriedTransient = true;
        await opts.sleep(opts.gapMs);
        continue;
      }
      throw error;
    }
  }
  return { logs, chunkBlocks: shrunkTo };
}

/**
 * Fetch, decode and time one chunk. `known` anchors (head, earlier chunks) place a chunk whose own anchors could not be
 * read; the chunk is then flagged `estimated`. Throws only when the RPC fails past its one retry.
 */
export async function fetchChunk(pool: EvmPoolRef, fromBlock: number, toBlock: number, rpc: BackfillRpc, known: BlockAnchor[], opts: BackfillOptions = {}): Promise<ChunkResult & { chunkBlocks: number | null }> {
  const paged = await getLogsPaged(pool, fromBlock, toBlock, rpc, { retry429Ms: opts.retry429Ms ?? RETRY_429_MS, gapMs: opts.gapMs ?? DEFAULT_CHUNK_GAP_MS, sleep: opts.sleep ?? defaultSleep });
  const raw = decodeSwapPoints(paged.logs, pool);
  const { anchors, missing } = await readAnchors(paged.logs, rpc);
  // The chunk's own anchors bracket every swap in it; only a chunk that could not read them leans on outside anchors.
  const usable = anchors.length > 0 ? anchors : known;
  if (raw.length > 0 && usable.length === 0) throw new Error(`no block anchor for blocks ${fromBlock}-${toBlock}`);
  const points = raw.length === 0 ? [] : timePoints(raw, usable);
  return { fromBlock, fromTime: null, toBlock, points, anchors, estimated: missing > 0 || (raw.length > 0 && anchors.length === 0), chunkBlocks: paged.chunkBlocks };
}

/** The head's block time, or null when the block-time cache cannot read it now; never the server's wall clock. */
async function headAnchor(rpc: BackfillRpc, head: number): Promise<BlockAnchor | null> {
  const time = await rpc.blockTime(head);
  return time === null ? null : { block: head, time };
}

function headUnreadable(head: number): string {
  return `head block ${head}: block time unreadable (block-time cache blocked); retried on the next read`;
}

/**
 * Newest-first backfill until the swaps reach `spanMs` before the head's time, the block cap, or genesis. Partial on
 * error (what was fetched stays usable, `error` says what stopped it). Chunk gaps and 429 waits use unref'd timers.
 */
export async function backfillSwaps(pool: EvmPoolRef, run: BackfillRun, rpc: BackfillRpc): Promise<BackfillResult> {
  const sleep = run.sleep ?? defaultSleep;
  const maxBlocks = run.maxBlocks ?? MAX_BACKFILL_BLOCKS;
  let chunkBlocks = Math.max(1, run.chunkBlocks ?? DEFAULT_CHUNK_BLOCKS);
  const head = await rpc.blockNumber();
  const top = Math.min(head, run.toBlock ?? head);
  const result: BackfillResult = { fromBlock: null, fromTime: null, toBlock: top, chunks: 0, anchors: 0, estimatedChunks: 0, points: [], stoppedBy: "head", error: null };
  if (top < 0) return result;
  const anchor = await headAnchor(rpc, head);
  if (!anchor) return { ...result, stoppedBy: "error", error: headUnreadable(head) };
  const known: BlockAnchor[] = [anchor];
  const floorTime = anchor.time - run.spanMs;
  let to = top;
  let scanned = 0;
  try {
    while (true) {
      const from = Math.max(0, to - chunkBlocks + 1);
      const chunk = await fetchChunk(pool, from, to, rpc, known, { ...run, sleep });
      if (chunk.chunkBlocks !== null) chunkBlocks = chunk.chunkBlocks;
      known.push(...chunk.anchors);
      result.points = [...chunk.points, ...result.points];
      result.chunks += 1;
      result.anchors += chunk.anchors.length;
      if (chunk.estimated) result.estimatedChunks += 1;
      result.fromBlock = from;
      result.fromTime = interpolateBlockTime(from, known);
      scanned += to - from + 1;
      run.onChunk?.({ ...chunk, fromTime: result.fromTime });
      if (from === 0) return { ...result, stoppedBy: "genesis" };
      if (result.fromTime <= floorTime) return { ...result, stoppedBy: "depth" };
      if (scanned >= maxBlocks || result.chunks >= MAX_CHUNKS_PER_RUN) return { ...result, stoppedBy: "cap" };
      to = from - 1;
      await sleep(run.gapMs ?? DEFAULT_CHUNK_GAP_MS);
    }
  } catch (error) {
    return { ...result, stoppedBy: "error", error: errorMessage(error) };
  }
}

/**
 * Forward fill from `fromBlock` (exclusive) to the head so a cached pool stays continuous across the minutes the own
 * tape's 200-print ring cannot hold. Refuses a gap wider than maxBlocks (the caller should backfill afresh).
 */
export async function topUpSwaps(pool: EvmPoolRef, fromBlock: number, rpc: BackfillRpc, opts: BackfillOptions & { onChunk?: (chunk: ChunkResult) => void } = {}): Promise<BackfillResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxBlocks = opts.maxBlocks ?? MAX_BACKFILL_BLOCKS;
  let chunkBlocks = Math.max(1, opts.chunkBlocks ?? DEFAULT_CHUNK_BLOCKS);
  const head = await rpc.blockNumber();
  const result: BackfillResult = { fromBlock: fromBlock + 1, fromTime: null, toBlock: fromBlock, chunks: 0, anchors: 0, estimatedChunks: 0, points: [], stoppedBy: "head", error: null };
  if (head <= fromBlock) return result;
  if (head - fromBlock > maxBlocks) return { ...result, stoppedBy: "error", error: `gap of ${head - fromBlock} blocks exceeds ${maxBlocks}` };
  const anchor = await headAnchor(rpc, head);
  if (!anchor) return { ...result, stoppedBy: "error", error: headUnreadable(head) };
  const known: BlockAnchor[] = [anchor];
  let from = fromBlock + 1;
  try {
    while (from <= head) {
      const to = Math.min(head, from + chunkBlocks - 1);
      const chunk = await fetchChunk(pool, from, to, rpc, known, { ...opts, sleep });
      if (chunk.chunkBlocks !== null) chunkBlocks = chunk.chunkBlocks;
      known.push(...chunk.anchors);
      result.points = [...result.points, ...chunk.points];
      result.chunks += 1;
      result.anchors += chunk.anchors.length;
      if (chunk.estimated) result.estimatedChunks += 1;
      result.toBlock = to;
      opts.onChunk?.({ ...chunk, fromTime: interpolateBlockTime(from, known) });
      from = to + 1;
      if (from <= head) await sleep(opts.gapMs ?? DEFAULT_CHUNK_GAP_MS);
    }
    return { ...result, fromTime: interpolateBlockTime(fromBlock + 1, known) };
  } catch (error) {
    return { ...result, stoppedBy: "error", error: errorMessage(error) };
  }
}

/** Depth for a request: `bars` of `intervalMs`, never deeper than the block cap allows. */
export function backfillSpanMs(intervalMs: number, bars = DEFAULT_BARS, maxBlocks = MAX_BACKFILL_BLOCKS): number {
  return Math.min(bars * intervalMs, Math.round(maxBlocks * BLOCK_MS));
}
