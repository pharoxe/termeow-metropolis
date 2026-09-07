import { UpstreamError, errorMessage } from "../../lib/http.js";
import { rememberBlockTime } from "./blockHints.js";
import { getLogsLane, type LogsLane } from "./logsLane.js";
import { robinhoodRpcFetch } from "./rpcPool.js";
import { logBlockNumber, type LegFilter } from "./wsLegs.js";
import { wsTransportFromConfig, type WsLogsLike } from "./wsLogs.js";
import { registerTransport, unregisterTransport, type PollerTransport } from "./wsStatus.js";

/** Uniswap Swap event signatures observed on Robinhood Chain (chain id 4663) via eth_getLogs, 2026-09-06. */
export const V2_SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
export const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
export const V4_SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
export const SWAP_TOPICS = [V2_SWAP_TOPIC, V3_SWAP_TOPIC, V4_SWAP_TOPIC];
/** topic0 filter of the v2/v3 leg; the v4 leg asks the PoolManager for V4_SWAP_TOPIC with tracked poolIds as topic1. */
export const POOL_SWAP_TOPICS = [V2_SWAP_TOPIC, V3_SWAP_TOPIC];
/** Uniswap v4 PoolManager; its Swap logs carry the poolId as topic1, which eth_getLogs filters server-side. */
export const V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

export const DEFAULT_INTERVAL_MS = 2_000;
export const DEFAULT_MAX_RANGE = 400;
export const DEFAULT_REORG_DEPTH = 5;
export const FIRST_RUN_LOOKBACK = 20;
/** Delay between ticks while the cursor is still behind the head (chunked catch-up). */
export const CATCHUP_DELAY_MS = 250;
export const BACKOFF_MIN_MS = 2_000;
export const BACKOFF_MAX_MS = 30_000;
/**
 * Hard cap on the tx:logIndex dedupe ring. Keys are normally retired by block once the HTTP sweep has verified past
 * them (see pruneSeen); the cap only bounds memory while HTTP has been failing for a long time under a live socket.
 */
export const SEEN_RING = 100_000;
export const REQUEST_TIMEOUT_MS = 15_000;
/** HTTP tick cadence while every leg is subscribed: a slow sweep from the last HTTP-verified block that recovers a missed notification. */
export const WS_CATCHUP_INTERVAL_MS = 30_000;
/** Websocket frames are held this long so one handler call carries every log of a block (0.1 s blocks) in block order. */
export const WS_FLUSH_MS = 150;
const LOGS_PER_BLOCK_SLOT = 0x100000; // ordering slot per block when merging legs; logIndex never approaches it
let pollerSeq = 0; // default /api/health names for pollers whose owner passes none

/**
 * One eth_getLogs entry as the node returns it (websocket log frames carry exactly these keys). `blockTimestamp` is
 * deliberately not modelled: the official RPC returns 0x0; when a websocket node reports a real value it is fed to
 * blockHints.ts, never read from here.
 */
export type RawLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed?: boolean;
};

export type LogsHandler = (logs: RawLog[], headBlock: number) => void;

/**
 * One extra eth_getLogs leg appended to this poller's batch: `topics` follows the eth_getLogs shape (position i matches
 * any listed topic; null is a wildcard). An empty `addresses` list means no address filter (chain-wide by topic, used
 * for the FOMO Transfer legs in server/traders/transfers.ts); such a leg must constrain at least one topic position or
 * it is dropped. Its logs reach the handler through the same window and dedupe path. RPC budget
 * note: legs only ride for free on a *shared* poller; a consumer that constructs its own RobinhoodLogPoller (the launch
 * stream in server/launch/service.ts does) runs a second independent 2s eth_blockNumber + eth_getLogs loop against the
 * 429-prone public RPC.
 */
export type ExtraLeg = { addresses: string[]; topics: Array<string[] | null> };

export type PollerOptions = {
  rpcUrl: string;
  intervalMs?: number;
  maxRange?: number;
  reorgDepth?: number;
  poolManager?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
  /**
   * Shared logs-lane budget every tick waits on (see logsLane.ts): undefined means the process lane when the transport
   * is the shared pool, none when a caller injected its own fetchImpl (tests); null opts out explicitly.
   */
  lane?: LogsLane | null;
  /**
   * Websocket transport (wsLogs.ts): undefined means the configured one when the transport is the shared pool, none
   * when a caller injected its own fetchImpl (tests); null opts out explicitly. Named in /api/health by `name`.
   */
  ws?: WsLogsLike | null;
  name?: string;
};

export type PollerStats = {
  cursor: number | null;
  head: number | null;
  polls: number;
  /** Logs handed to the handler. */
  logs: number;
  /** Logs discarded: reorg-overlap duplicates, `removed`, malformed, or the client-side residue of v4 logs whose topic1 is not a tracked poolId. */
  dropped: number;
  errors: number;
  lastError: string | null;
  lastOkAt: number | null;
  /** HTTP requests made (a JSON-RPC batch counts once). */
  rpcCalls: number;
  blockedUntil: number | null;
};

type RpcRequest = { jsonrpc: "2.0"; id: number; method: string; params: unknown[] };
type RpcReply = { id?: unknown; result?: unknown; error?: { message?: string; code?: number } };
type BlockWindow = { from: number; to: number };
/** `addresses` are v2/v3 pool contracts; `poolIds` are v4 pools, queried on the PoolManager by topic1. */
type Filter = { addresses: string[]; poolIds: Set<string> };
type BatchMode = "try" | "on" | "off";
type PollResult = { head: number; window: BlockWindow; logs: unknown[] };

function hex(n: number): string {
  return `0x${n.toString(16)}`;
}

function parseHex(value: unknown): number | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isRawLog(value: unknown): value is RawLog {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!row) return false;
  return (
    typeof row.address === "string" &&
    Array.isArray(row.topics) &&
    typeof row.data === "string" &&
    typeof row.blockNumber === "string" &&
    typeof row.transactionHash === "string" &&
    typeof row.logIndex === "string"
  );
}

function logKey(log: RawLog): string {
  return `${log.transactionHash.toLowerCase()}:${log.logIndex.toLowerCase()}`;
}

function replyResult(reply: RpcReply, method: string): unknown {
  if (reply.error) throw new Error(`${method}: ${reply.error.message ?? "rpc error"}`);
  return reply.result;
}

function isRateLimit(error: unknown): boolean {
  return error instanceof UpstreamError && error.status === 429;
}

/** Sort key for (block, logIndex); malformed rows sort first and are dropped by accept(). */
function position(value: unknown): number {
  return isRawLog(value) ? (parseHex(value.blockNumber) ?? 0) * LOGS_PER_BLOCK_SLOT + (parseHex(value.logIndex) ?? 0) : -1;
}

/** Each leg returns one node-ordered page; merged legs go back into block/logIndex order so the handler sees a single tape. */
function mergePages(pages: unknown[][]): unknown[] {
  return pages.length < 2 ? (pages[0] ?? []) : pages.flat().sort((a, b) => position(a) - position(b));
}

/**
 * eth_getLogs poller for Robinhood Chain with two transports feeding one decode/dedupe/callback path. HTTP: one timer
 * loop, never overlapping: eth_blockNumber then one eth_getLogs per leg over [cursor - reorgDepth, min(head, cursor +
 * maxRange)] — v2/v3 pool addresses, and the v4 PoolManager with tracked poolIds as topic1 so untracked v4 swaps never
 * leave the node — batched into one JSON-RPC array once the RPC accepts batches. Websocket (wsLogs.ts, publicnode /
 * pocket): the same legs as eth_subscribe("logs") filters, frames held WS_FLUSH_MS and handed over in block order,
 * block times from newHeads and log frames into blockHints.ts. HTTP never stops being the backstop: it always sweeps
 * from its own last verified block (httpCursor), paging at the catch-up delay when it is more than maxRange behind,
 * so every block is HTTP-verified eventually whatever the socket missed. While every wanted leg is subscribed the sweep
 * runs every WS_CATCHUP_INTERVAL_MS; while the socket is down, or any leg is unsubscribed (rejected, unacked, still
 * pending), HTTP runs at the normal cadence and transport().mode says "http". The reorg overlap and the transport
 * overlap are both collapsed by a tx:logIndex ring retired by block once HTTP has verified past it, so a log is
 * delivered at most once, with the same shape from either transport. Every failure lands in stats() and backs the loop
 * off 2s -> 30s; nothing throws.
 */
export class RobinhoodLogPoller {
  private readonly rpcUrl: string;
  private readonly intervalMs: number;
  private readonly maxRange: number;
  private readonly reorgDepth: number;
  private readonly poolManager: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly lane: LogsLane | null;
  private readonly ws: WsLogsLike | null;
  private readonly name: string;
  private readonly transportProvider = () => this.transport();
  private filter: Filter = { addresses: [], poolIds: new Set() };
  private extraLegs: ExtraLeg[] = [];
  private handler: LogsHandler | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private running = false;
  private inFlight = false;
  private batchMode: BatchMode = "try";
  private delayMs = 0;
  private nextId = 1;
  /** tx:logIndex -> block; keys below the HTTP-verified block minus the reorg overlap are pruned, the rest capped at SEEN_RING. */
  private readonly seen = new Map<string, number>();
  /** Latest block either transport has covered; stats().cursor. */
  private cursor: number | null = null;
  /** Latest block the HTTP path has verified; the next HTTP window always starts here. */
  private httpCursor: number | null = null;
  private head: number | null = null;
  private counters = { polls: 0, logs: 0, dropped: 0, errors: 0, rpcCalls: 0 };
  private wsConnected = false;
  private wsBuffer: unknown[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private wsCounters = { wsLogs: 0, catchUpTicks: 0, lastWsBlock: null as number | null };
  private lastError: string | null = null;
  private lastOkAt: number | null = null;
  private blockedUntil: number | null = null;

  constructor(opts: PollerOptions) {
    this.rpcUrl = opts.rpcUrl;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxRange = opts.maxRange ?? DEFAULT_MAX_RANGE;
    this.reorgDepth = opts.reorgDepth ?? DEFAULT_REORG_DEPTH;
    this.poolManager = (opts.poolManager ?? V4_POOL_MANAGER).toLowerCase();
    this.fetchImpl = opts.fetchImpl ?? robinhoodRpcFetch;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((m) => console.warn(m));
    this.lane = opts.lane !== undefined ? opts.lane : opts.fetchImpl ? null : getLogsLane();
    this.ws = opts.ws !== undefined ? opts.ws : opts.fetchImpl ? null : wsTransportFromConfig(this.log);
    this.name = opts.name ?? `poller-${++pollerSeq}`;
  }

  /** v2/v3 pool contracts and v4 poolIds, each driving its own eth_getLogs leg. Leaves the cursor untouched. */
  setFilter(addresses: string[], poolIds: string[]): void {
    const pools = new Set(poolIds.map((id) => id.toLowerCase()));
    const contracts = new Set(addresses.map((address) => address.toLowerCase()));
    this.filter = { addresses: [...contracts], poolIds: pools };
    this.ws?.setLegs(this.legFilters());
  }

  /** Extra legs appended to every poll (same window, batch, dedupe and ordering). Empty (the default) changes nothing. */
  setExtraLegs(legs: ExtraLeg[]): void {
    this.extraLegs = legs
      .filter((leg) => leg.addresses.length > 0 || leg.topics.some((position) => position !== null && position.length > 0))
      .map((leg) => ({
        addresses: [...new Set(leg.addresses.map((address) => address.toLowerCase()))],
        topics: leg.topics.map((position) => (position === null ? null : position.map((topic) => topic.toLowerCase())))
      }));
    this.ws?.setLegs(this.legFilters());
  }

  start(onLogs: LogsHandler): void {
    this.handler = onLogs;
    if (this.running) return;
    this.running = true;
    registerTransport(this.name, this.transportProvider);
    if (this.ws) {
      this.ws.setLegs(this.legFilters());
      this.ws.start({
        onLog: (log, blockTimeMs) => this.onWsLog(log, blockTimeMs),
        onHead: (block, timestampMs) => this.onWsHead(block, timestampMs),
        onOpen: () => this.onWsState(true),
        onClose: () => this.onWsState(false)
      });
    }
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.wsBuffer = [];
    this.ws?.stop();
    unregisterTransport(this.transportProvider);
    this.wsConnected = false;
  }

  /** Which transport is carrying prints right now, for /api/health; stats() keeps its HTTP shape. */
  transport(): PollerTransport {
    return {
      mode: this.wsLive() ? "ws" : "http",
      wsEnabled: this.ws !== null,
      httpCursor: this.httpCursor,
      catchUpTicks: this.wsCounters.catchUpTicks,
      wsLogs: this.wsCounters.wsLogs,
      lastWsBlock: this.wsCounters.lastWsBlock,
      ws: this.ws?.status() ?? null
    };
  }

  /** True only while the socket is open AND every wanted leg is subscribed: a rejected, unacked or pending leg leaves that leg on HTTP alone. */
  private wsLive(): boolean {
    if (!this.wsConnected || !this.ws) return false;
    const status = this.ws.status();
    return status.connected && status.subscriptions >= status.wantedLegs;
  }

  stats(): PollerStats {
    return {
      cursor: this.cursor,
      head: this.head,
      ...this.counters,
      lastError: this.lastError,
      lastOkAt: this.lastOkAt,
      blockedUntil: this.blockedUntil
    };
  }

  private schedule(ms: number): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    if (this.wsLive()) this.wsCounters.catchUpTicks += 1;
    let ok = false;
    try {
      // The lane serialises every eth_getLogs in the process and spaces them by its adaptive gap; a stop() while
      // waiting for the slot skips the poll (the slot is released untouched).
      if (this.lane) await this.lane.run("routine", () => (this.running ? this.poll() : Promise.resolve()));
      else await this.poll();
      ok = true;
    } catch (error) {
      if (this.running) this.fail(error);
    } finally {
      this.inFlight = false;
    }
    this.schedule(this.nextDelay(ok));
  }

  /**
   * Caught up: the configured interval (or the catch-up interval while every leg is subscribed) or the lane's current
   * gap, whichever is longer; HTTP behind the head by more than one window: the chunked catch-up delay, so the HTTP
   * backstop pages through a backlog instead of trusting the socket for it; backing off: as before. The lane still
   * spaces the requests.
   */
  private nextDelay(ok: boolean): number {
    const laneGap = this.lane?.gapMs() ?? 0;
    if (!ok) return Math.max(this.delayMs, laneGap);
    const lag = this.httpCursor !== null && this.head !== null ? this.head - this.httpCursor : 0;
    if (this.wsLive()) return lag >= this.maxRange ? CATCHUP_DELAY_MS : Math.max(WS_CATCHUP_INTERVAL_MS, laneGap);
    return lag > 0 ? CATCHUP_DELAY_MS : Math.max(this.intervalMs, laneGap);
  }

  private async poll(): Promise<void> {
    this.counters.polls += 1;
    const base = this.scanBase();
    const useBatch = base !== null && this.batchMode !== "off" && this.hasFilter();
    const result = useBatch ? await this.pollBatched(base as number) : await this.pollSequential();
    this.settle(result);
  }

  /**
   * Where the next HTTP window starts: the HTTP-verified cursor, however far the websocket-advanced cursor has run
   * ahead (frames are not gap-free by construction: legs are re-cut, acks time out, sockets drop; only an HTTP page
   * verifies a block). Null before the first HTTP poll, which then takes the FIRST_RUN_LOOKBACK window.
   */
  private scanBase(): number | null {
    return this.httpCursor;
  }

  private hasFilter(): boolean {
    return this.filter.addresses.length > 0 || this.filter.poolIds.size > 0 || this.extraLegs.length > 0;
  }
  private async pollSequential(): Promise<PollResult> {
    const head = this.parseHead(await this.call("eth_blockNumber", []));
    const window = this.window(head);
    const legs = this.logsLegs(window);
    const pages: unknown[][] = [];
    for (const params of legs) pages.push(this.parseLogs(await this.call("eth_getLogs", [params])));
    return { head, window, logs: mergePages(pages) };
  }

  /** The head is unknown before the batch returns, so toBlock is cursor + maxRange; the node clamps it to its head. */
  private async pollBatched(cursor: number): Promise<PollResult> {
    const requested = { from: Math.max(cursor - this.reorgDepth, 0), to: cursor + this.maxRange };
    const legs = this.logsLegs(requested).map((params) => this.request("eth_getLogs", [params]));
    const requests = [this.request("eth_blockNumber", []), ...legs];
    let results: unknown[];
    try {
      results = this.batchResults(await this.post(requests), requests);
    } catch (error) {
      if (this.batchMode === "on" || isRateLimit(error)) throw error;
      this.batchMode = "off";
      this.log(`robinhood log poller: batch unsupported, falling back to sequential (${errorMessage(error)})`);
      return this.pollSequential();
    }
    this.batchMode = "on";
    const head = this.parseHead(results[0]);
    const pages = results.slice(1).map((page) => this.parseLogs(page));
    return { head, window: this.window(head), logs: mergePages(pages) };
  }

  private settle(result: PollResult): void {
    this.head = Math.max(this.head ?? 0, result.head);
    // Clamped: a poll answered by a lagging pool node must not walk the verified block backwards.
    this.httpCursor = Math.max(this.httpCursor ?? 0, result.window.to);
    this.cursor = Math.max(this.cursor ?? 0, result.window.to);
    this.lastOkAt = this.now();
    this.blockedUntil = null;
    this.delayMs = 0;
    const fresh = this.accept(result.logs);
    this.pruneSeen(); // after accept: the page just verified may hold keys the frames delivered, and must still see them
    this.counters.logs += fresh.length;
    if (fresh.length === 0 || !this.handler) return;
    try {
      this.handler(fresh, result.head);
    } catch (error) {
      this.lastError = `handler: ${errorMessage(error)}`;
      this.log(`robinhood log poller: ${this.lastError}`);
    }
  }

  private window(head: number): BlockWindow {
    const cursor = this.scanBase() ?? Math.max(head - FIRST_RUN_LOOKBACK, 0);
    const to = Math.min(head, cursor + this.maxRange);
    const from = Math.max(Math.min(cursor, to) - this.reorgDepth, 0);
    return { from, to };
  }

  /** One eth_getLogs filter per leg; a leg with nothing tracked is skipped rather than sent empty. */
  private logsLegs(window: BlockWindow): Array<Record<string, unknown>> {
    const range = { fromBlock: hex(window.from), toBlock: hex(window.to) };
    return this.legFilters().map((leg) => ({ ...range, ...leg }));
  }

  /** The range-free leg filters both transports share: eth_getLogs params minus the block range, eth_subscribe("logs") params as is. */
  private legFilters(): LegFilter[] {
    const legs: LegFilter[] = [];
    if (this.filter.addresses.length > 0) legs.push({ address: this.filter.addresses, topics: [POOL_SWAP_TOPICS] });
    if (this.filter.poolIds.size > 0) legs.push({ address: [this.poolManager], topics: [[V4_SWAP_TOPIC], [...this.filter.poolIds]] });
    for (const leg of this.extraLegs) legs.push({ ...(leg.addresses.length > 0 ? { address: leg.addresses } : {}), topics: leg.topics });
    return legs;
  }

  /** A frame is held with its neighbours and flushed as one block-ordered batch through accept() like an HTTP page; its blockTimestamp (non-zero on publicnode/pocket) times the block for the cache. */
  private onWsLog(log: unknown, blockTimeMs: number | null): void {
    if (!this.running) return;
    const block = logBlockNumber(log);
    if (block !== null && blockTimeMs !== null) rememberBlockTime(block, blockTimeMs);
    this.wsBuffer.push(log);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushWs();
    }, WS_FLUSH_MS);
    this.flushTimer.unref?.();
  }

  private flushWs(): void {
    const batch = this.wsBuffer;
    this.wsBuffer = [];
    if (batch.length === 0 || !this.running) return;
    const fresh = this.accept([...batch].sort((a, b) => position(a) - position(b)));
    for (const log of fresh) {
      const block = logBlockNumber(log);
      if (block !== null) this.advanceWs(block);
    }
    this.counters.logs += fresh.length;
    this.wsCounters.wsLogs += fresh.length;
    if (fresh.length === 0 || !this.handler) return;
    try {
      this.handler(fresh, this.head ?? 0);
    } catch (error) {
      this.lastError = `handler: ${errorMessage(error)}`;
      this.log(`robinhood log poller: ${this.lastError}`);
    }
  }

  /** newHeads: the socket's clock for the block cache and the cursor's advance; a head the HTTP path is still behind on is fine. */
  private onWsHead(block: number, timestampMs: number | null): void {
    if (timestampMs !== null) rememberBlockTime(block, timestampMs);
    this.advanceWs(block);
  }

  private advanceWs(block: number): void {
    this.wsCounters.lastWsBlock = Math.max(this.wsCounters.lastWsBlock ?? 0, block);
    this.head = Math.max(this.head ?? 0, block);
    this.cursor = Math.max(this.cursor ?? 0, block);
  }

  /** Socket up: sweep the HTTP window now to fill the gap since the last verified block; socket down: back to the HTTP cadence at once. */
  private onWsState(connected: boolean): void {
    this.wsConnected = connected;
    if (!connected) {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.flushWs();
    }
    this.kick();
  }

  private kick(): void {
    if (!this.running || this.inFlight) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
  }

  private accept(raw: unknown[]): RawLog[] {
    const fresh: RawLog[] = [];
    for (const item of raw) {
      if (!isRawLog(item) || item.removed === true || !this.matches(item) || this.seen.has(logKey(item))) {
        this.counters.dropped += 1;
        continue;
      }
      this.remember(logKey(item), parseHex(item.blockNumber) ?? 0);
      fresh.push(item);
    }
    return fresh;
  }

  /** Residual guard: the node already filters by address/topic0/topic1, but a node that ignores topic1 must not leak foreign v4 swaps. */
  private matches(log: RawLog): boolean {
    return this.matchesSwap(log) || this.matchesExtra(log);
  }

  private matchesSwap(log: RawLog): boolean {
    const topic0 = log.topics[0]?.toLowerCase();
    if (topic0 === V4_SWAP_TOPIC) return this.filter.poolIds.has((log.topics[1] ?? "").toLowerCase());
    return topic0 === V2_SWAP_TOPIC || topic0 === V3_SWAP_TOPIC;
  }

  /** A log satisfies an extra leg when its address is listed (or the leg has no address filter) and every constrained topic position holds one of the listed topics. */
  private matchesExtra(log: RawLog): boolean {
    if (this.extraLegs.length === 0) return false;
    const address = log.address.toLowerCase();
    return this.extraLegs.some(
      (leg) =>
        (leg.addresses.length === 0 || leg.addresses.includes(address)) &&
        leg.topics.every((position, i) => position === null || position.includes((log.topics[i] ?? "").toLowerCase()))
    );
  }

  private remember(key: string, block: number): void {
    this.seen.set(key, block);
    while (this.seen.size > SEEN_RING) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  /**
   * Keys are safe to forget once no transport can re-deliver them: HTTP never asks below httpCursor - reorgDepth again,
   * and a websocket frame is only ever near the head (retired-subscription repeats included), so a margin of one window
   * behind the cursor covers those. Runs after every HTTP page has been accepted (never before, or the page would
   * re-print what it was about to dedupe).
   */
  private pruneSeen(): void {
    if (this.httpCursor === null) return;
    const floor = Math.min(this.httpCursor - this.reorgDepth, (this.cursor ?? this.httpCursor) - this.maxRange);
    for (const [key, block] of this.seen) if (block < floor) this.seen.delete(key);
  }

  private parseHead(value: unknown): number {
    const head = parseHex(value);
    if (head === null) throw new Error("eth_blockNumber: malformed result");
    return head;
  }

  private parseLogs(value: unknown): unknown[] {
    if (!Array.isArray(value)) throw new Error("eth_getLogs: malformed result");
    return value;
  }

  private request(method: string, params: unknown[]): RpcRequest {
    return { jsonrpc: "2.0", id: this.nextId++, method, params };
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    const body = await this.post(this.request(method, params));
    const reply = body && typeof body === "object" && !Array.isArray(body) ? (body as RpcReply) : null;
    if (!reply) throw new Error(`${method}: malformed response body`);
    return replyResult(reply, method);
  }

  /** Matches replies to requests by id (batch replies may arrive in any order); any missing or errored item throws. */
  private batchResults(body: unknown, requests: RpcRequest[]): unknown[] {
    if (!Array.isArray(body)) throw new Error("batch: response is not an array");
    const replies = new Map<number, RpcReply>();
    for (const item of body) {
      if (item && typeof item === "object" && typeof (item as RpcReply).id === "number") replies.set((item as RpcReply).id as number, item as RpcReply);
    }
    return requests.map((req) => {
      const reply = replies.get(req.id);
      if (!reply) throw new Error(`batch: no reply for ${req.method}`);
      return replyResult(reply, req.method);
    });
  }

  private async post(body: RpcRequest | RpcRequest[]): Promise<unknown> {
    this.counters.rpcCalls += 1;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (response.status === 429) throw new UpstreamError("rpc 429 rate limited", 429);
      if (!response.ok) throw new UpstreamError(`rpc returned ${response.status}`, response.status);
      return await response.json();
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
    }
  }

  private fail(error: unknown): void {
    this.counters.errors += 1;
    this.lastError = errorMessage(error);
    this.delayMs = this.delayMs === 0 ? BACKOFF_MIN_MS : Math.min(this.delayMs * 2, BACKOFF_MAX_MS);
    this.blockedUntil = this.now() + this.delayMs;
    this.log(`robinhood log poller: ${this.lastError}`);
  }
}
