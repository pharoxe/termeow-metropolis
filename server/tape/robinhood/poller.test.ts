import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  CATCHUP_DELAY_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_RANGE,
  POOL_SWAP_TOPICS,
  RobinhoodLogPoller,
  SEEN_RING,
  V2_SWAP_TOPIC,
  V3_SWAP_TOPIC,
  V4_POOL_MANAGER,
  V4_SWAP_TOPIC,
  type RawLog
} from "./poller.js";
import { LogsLane } from "./logsLane.js";

const RPC = "https://rpc.mainnet.chain.robinhood.com/";
const START = 1_800_000_000_000;
const V3_POOL = "0x353f2bd390d8db7bfc9b3dd389f8b71e8df524fa";
const V2_POOL = "0x7ba7d2a2d549bbb699fead825298b87fea9f0a31";
const FATCOIN_POOL_ID = "0x70b5b746dc36c648893dafdf4b98d708a07673dfc1b3a0bb9dd70e36c0569f68";
const OTHER_POOL_ID = "0xa06116d5b8288f43f21364df1fa58377ed95e491eb48e4cfaea99ab0a0e3d460";
const HEAD = 1_000;

type RpcRequest = { id: number; method: string; params: unknown[] };
type Call = { at: number; batched: boolean; requests: RpcRequest[] };
type LogsFilter = { fromBlock: string; toBlock: string; address: string[]; topics: string[][] };

function hex(n: number): string {
  return `0x${n.toString(16)}`;
}

function mkLog(block: number, tx: string, logIndex: number, address: string, topic0: string, topic1 = "0x" + "1".repeat(64)): RawLog {
  return {
    address,
    topics: [topic0, topic1],
    data: "0x",
    blockNumber: hex(block),
    blockHash: "0x" + "b".repeat(64),
    transactionHash: tx,
    transactionIndex: "0x1",
    logIndex: hex(logIndex),
    removed: false
  };
}

/**
 * Stub node: filters logs by block range / address / topic0 / topic1 the way geth does (toBlock beyond the head is clamped),
 * appends `raw` entries unfiltered, answers batches only when `batch` is true, and returns 429 for the next `rateLimit` HTTP requests.
 */
function fakeNode(initial: { head: number; logs?: RawLog[]; batch?: boolean }) {
  const chain = { head: initial.head, logs: initial.logs ?? [], raw: [] as unknown[], batch: initial.batch ?? true, rateLimit: 0, status: 200 };
  const calls: Call[] = [];
  const answer = (req: RpcRequest) => {
    if (req.method === "eth_blockNumber") return { jsonrpc: "2.0", id: req.id, result: hex(chain.head) };
    const filter = (req.params[0] as LogsFilter) ?? {};
    const from = Number.parseInt(filter.fromBlock, 16);
    const to = Math.min(Number.parseInt(filter.toBlock, 16), chain.head);
    if (from > to) return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "invalid block range" } };
    const addresses = new Set(filter.address.map((a) => a.toLowerCase()));
    const topics = new Set(filter.topics[0] ?? []);
    const topic1 = filter.topics[1] ? new Set(filter.topics[1].map((t) => t.toLowerCase())) : null;
    const result = chain.logs.filter((log) => {
      const block = Number.parseInt(log.blockNumber, 16);
      const inRange = block >= from && block <= to && addresses.has(log.address.toLowerCase()) && topics.has(log.topics[0]!);
      return inRange && (topic1 === null || topic1.has((log.topics[1] ?? "").toLowerCase()));
    });
    return { jsonrpc: "2.0", id: req.id, result: [...result, ...chain.raw] };
  };
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
    const batched = Array.isArray(body);
    calls.push({ at: Date.now(), batched, requests: batched ? body : [body] });
    if (chain.rateLimit > 0) {
      chain.rateLimit -= 1;
      return new Response("", { status: 429 });
    }
    if (chain.status !== 200) return new Response("", { status: chain.status });
    if (batched && !chain.batch) return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch not supported" } }), { status: 200 });
    const reply = batched ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  const logsCalls = () => calls.flatMap((call) => call.requests.filter((req) => req.method === "eth_getLogs").map((req) => req.params[0] as LogsFilter));
  return { chain, calls, logsCalls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function build(node: ReturnType<typeof fakeNode>, opts: Partial<ConstructorParameters<typeof RobinhoodLogPoller>[0]> = {}) {
  const log = vi.fn();
  const poller = new RobinhoodLogPoller({ rpcUrl: RPC, fetchImpl: node.fetchImpl, log, ...opts });
  const onLogs = vi.fn();
  pollers.push(poller);
  return { poller, onLogs, log };
}

async function tick(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

const pollers: RobinhoodLogPoller[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  while (pollers.length) pollers.pop()?.stop();
  vi.useRealTimers();
});

describe("RobinhoodLogPoller", () => {
  it("first poll is sequential: eth_blockNumber then eth_getLogs over [head-20-reorg, head], delivering matching logs", async () => {
    const wanted = mkLog(HEAD - 3, "0xaa", 7, V3_POOL, V3_SWAP_TOPIC);
    const tooOld = mkLog(HEAD - 40, "0xbb", 1, V3_POOL, V3_SWAP_TOPIC);
    const otherPool = mkLog(HEAD - 2, "0xcc", 2, V2_POOL, V2_SWAP_TOPIC);
    const node = fakeNode({ head: HEAD, logs: [wanted, tooOld, otherPool] });
    const { poller, onLogs } = build(node);
    poller.setFilter([V3_POOL.toUpperCase()], []);
    poller.start(onLogs);
    await tick();

    expect(node.calls).toHaveLength(2);
    expect(node.calls.map((call) => call.batched)).toEqual([false, false]);
    expect(node.calls[0]!.requests[0]!.method).toBe("eth_blockNumber");
    expect(node.logsCalls()).toEqual([{ fromBlock: hex(HEAD - 25), toBlock: hex(HEAD), address: [V3_POOL], topics: [POOL_SWAP_TOPICS] }]);
    expect(onLogs).toHaveBeenCalledTimes(1);
    expect(onLogs).toHaveBeenCalledWith([wanted], HEAD);
    expect(poller.stats()).toEqual({
      cursor: HEAD,
      head: HEAD,
      polls: 1,
      logs: 1,
      dropped: 0,
      errors: 0,
      lastError: null,
      lastOkAt: START,
      rpcCalls: 2,
      blockedUntil: null
    });
  });

  it("advances the cursor each interval and batches both calls into one request once the RPC accepts batches", async () => {
    const node = fakeNode({ head: HEAD });
    const { poller, onLogs } = build(node);
    poller.setFilter([V3_POOL], []);
    poller.start(onLogs);
    await tick();
    expect(node.calls).toHaveLength(2);

    node.chain.head = HEAD + 10;
    await tick(DEFAULT_INTERVAL_MS - 1);
    expect(node.calls).toHaveLength(2);
    await tick(1);
    expect(node.calls).toHaveLength(3);
    expect(node.calls[2]!.batched).toBe(true);
    expect(node.calls[2]!.requests.map((req) => req.method)).toEqual(["eth_blockNumber", "eth_getLogs"]);
    expect(node.logsCalls()[1]).toMatchObject({ fromBlock: hex(HEAD - 5), toBlock: hex(HEAD + DEFAULT_MAX_RANGE) });
    expect(poller.stats()).toMatchObject({ cursor: HEAD + 10, head: HEAD + 10, polls: 2, rpcCalls: 3, errors: 0 });

    node.chain.head = HEAD + 25;
    await tick(DEFAULT_INTERVAL_MS);
    expect(node.calls).toHaveLength(4);
    expect(node.calls[3]!.batched).toBe(true);
    expect(node.logsCalls()[2]).toMatchObject({ fromBlock: hex(HEAD + 5) });
    expect(poller.stats()).toMatchObject({ cursor: HEAD + 25, polls: 3, rpcCalls: 4 });
  });

  it("falls back to sequential calls for good when the RPC rejects the batch, without counting an error", async () => {
    const node = fakeNode({ head: HEAD, batch: false });
    const { poller, onLogs } = build(node);
    poller.setFilter([V3_POOL], []);
    poller.start(onLogs);
    await tick();
    node.chain.head = HEAD + 10;
    await tick(DEFAULT_INTERVAL_MS);

    expect(node.calls.map((call) => call.batched)).toEqual([false, false, true, false, false]);
    expect(poller.stats()).toMatchObject({ cursor: HEAD + 10, polls: 2, rpcCalls: 5, errors: 0, blockedUntil: null });

    node.chain.head = HEAD + 20;
    await tick(DEFAULT_INTERVAL_MS);
    expect(node.calls.map((call) => call.batched)).toEqual([false, false, true, false, false, false, false]);
    expect(poller.stats()).toMatchObject({ cursor: HEAD + 20, polls: 3, rpcCalls: 7, errors: 0 });
  });

  it("never re-delivers a log seen in the reorg overlap, counting it as dropped", async () => {
    const early = mkLog(HEAD - 2, "0xaa", 3, V3_POOL, V3_SWAP_TOPIC);
    const node = fakeNode({ head: HEAD, logs: [early] });
    const { poller, onLogs } = build(node);
    poller.setFilter([V3_POOL], []);
    poller.start(onLogs);
    await tick();
    expect(onLogs).toHaveBeenCalledTimes(1);

    const later = mkLog(HEAD + 4, "0xbb", 1, V3_POOL, V3_SWAP_TOPIC);
    const sameTxOtherIndex = mkLog(HEAD - 2, "0xaa", 4, V3_POOL, V3_SWAP_TOPIC);
    node.chain.logs = [early, later, sameTxOtherIndex];
    node.chain.head = HEAD + 5;
    await tick(DEFAULT_INTERVAL_MS);
    expect(node.logsCalls()[1]).toMatchObject({ fromBlock: hex(HEAD - 5) });
    expect(onLogs).toHaveBeenCalledTimes(2);
    expect(onLogs).toHaveBeenLastCalledWith([later, sameTxOtherIndex], HEAD + 5);
    expect(poller.stats()).toMatchObject({ logs: 3, dropped: 1 });

    node.chain.head = HEAD + 6;
    await tick(DEFAULT_INTERVAL_MS);
    expect(node.logsCalls()[2]).toMatchObject({ fromBlock: hex(HEAD) });
    expect(onLogs).toHaveBeenCalledTimes(2);
    expect(poller.stats()).toMatchObject({ logs: 3, dropped: 2 });
  });

  it("chunks by maxRange when far behind and catches up on the short delay instead of the interval", async () => {
    const node = fakeNode({ head: HEAD });
    const { poller, onLogs } = build(node);
    poller.setFilter([V3_POOL], []);
    poller.start(onLogs);
    await tick();
    expect(poller.stats().cursor).toBe(HEAD);

    node.chain.head = HEAD + 1_000;
    await tick(DEFAULT_INTERVAL_MS);
    expect(poller.stats()).toMatchObject({ cursor: HEAD + 400, head: HEAD + 1_000 });
    await tick(CATCHUP_DELAY_MS - 1);
    expect(poller.stats().cursor).toBe(HEAD + 400);
    await tick(1);
    expect(poller.stats().cursor).toBe(HEAD + 800);
    expect(node.logsCalls().at(-1)).toMatchObject({ fromBlock: hex(HEAD + 395), toBlock: hex(HEAD + 800) });
    await tick(CATCHUP_DELAY_MS);
    expect(poller.stats().cursor).toBe(HEAD + 1_000);
    expect(node.logsCalls().at(-1)).toMatchObject({ fromBlock: hex(HEAD + 795), toBlock: hex(HEAD + 1_200) });

    const before = node.calls.length;
    await tick(CATCHUP_DELAY_MS);
    expect(node.calls).toHaveLength(before);
    await tick(DEFAULT_INTERVAL_MS - CATCHUP_DELAY_MS);
    expect(node.calls).toHaveLength(before + 1);
  });

  it("chunks sequentially too: toBlock is clamped to cursor + maxRange when batches are off", async () => {
    const node = fakeNode({ head: HEAD, batch: false });
    const { poller, onLogs } = build(node, { maxRange: 100 });
    poller.setFilter([V3_POOL], []);
    poller.start(onLogs);
    await tick();
    node.chain.head = HEAD + 250;
    await tick(DEFAULT_INTERVAL_MS);
    expect(node.logsCalls().at(-1)).toEqual({ fromBlock: hex(HEAD - 5), toBlock: hex(HEAD + 100), address: [V3_POOL], topics: [POOL_SWAP_TOPICS] });
    expect(poller.stats().cursor).toBe(HEAD + 100);
    await tick(CATCHUP_DELAY_MS);
    expect(node.logsCalls().at(-1)).toMatchObject({ fromBlock: hex(HEAD + 95), toBlock: hex(HEAD + 200) });
    await tick(CATCHUP_DELAY_MS);
    expect(node.logsCalls().at(-1)).toMatchObject({ fromBlock: hex(HEAD + 195), toBlock: hex(HEAD + 250) });
  });

  it("splits v4 into its own PoolManager leg with tracked poolIds as topic1, so foreign v4 swaps never arrive", async () => {
    const receipt = JSON.parse(readFileSync(new URL("./__fixtures__/v4-0x70b5b746-0xa72a4c2f.json", import.meta.url), "utf8")) as { logs: RawLog[] };
    const block = Number.parseInt(receipt.logs[0]!.blockNumber, 16);
    const v3Log = mkLog(block, "0xdd", 1, V3_POOL, V3_SWAP_TOPIC);
    const node = fakeNode({ head: block, logs: [...receipt.logs, v3Log] });
    const { poller, onLogs } = build(node);
    poller.setFilter([V3_POOL], [FATCOIN_POOL_ID.toUpperCase()]);
    poller.start(onLogs);
    await tick();

    expect(node.calls.map((call) => call.batched)).toEqual([false, false, false]);
    expect(node.logsCalls()).toEqual([
      { fromBlock: hex(block - 25), toBlock: hex(block), address: [V3_POOL], topics: [POOL_SWAP_TOPICS] },
      { fromBlock: hex(block - 25), toBlock: hex(block), address: [V4_POOL_MANAGER], topics: [[V4_SWAP_TOPIC], [FATCOIN_POOL_ID]] }
    ]);
    const delivered = onLogs.mock.calls[0]![0] as RawLog[];
    expect(delivered.map((log) => [log.topics[0], log.logIndex])).toEqual([
      [V3_SWAP_TOPIC, "0x1"],
      [V4_SWAP_TOPIC, "0x25"]
    ]);
    expect(delivered[1]!.topics[1]).toBe(FATCOIN_POOL_ID);
    expect(delivered.some((log) => log.topics[1] === OTHER_POOL_ID)).toBe(false);
    expect(poller.stats()).toMatchObject({ logs: 2, dropped: 0, rpcCalls: 3 });

    node.chain.head = block + 1;
    await tick(DEFAULT_INTERVAL_MS);
    expect(node.calls.at(-1)!.batched).toBe(true);
    expect(node.calls.at(-1)!.requests.map((req) => req.method)).toEqual(["eth_blockNumber", "eth_getLogs", "eth_getLogs"]);
    expect(node.logsCalls().slice(-2).map((filter) => filter.address)).toEqual([[V3_POOL], [V4_POOL_MANAGER]]);
    expect(poller.stats()).toMatchObject({ rpcCalls: 4 });
  });

  it("still drops a foreign-poolId v4 log client-side when a node ignores the topic1 filter", async () => {
    const tracked = mkLog(HEAD, "0xaa", 1, V4_POOL_MANAGER, V4_SWAP_TOPIC, FATCOIN_POOL_ID);
    const foreign = mkLog(HEAD, "0xbb", 2, V4_POOL_MANAGER, V4_SWAP_TOPIC, OTHER_POOL_ID);
    const node = fakeNode({ head: HEAD, logs: [tracked] });
    node.chain.raw = [foreign];
    const { poller, onLogs } = build(node);
    poller.setFilter([], [FATCOIN_POOL_ID]);
    poller.start(onLogs);
    await tick();

    expect(node.logsCalls()).toEqual([{ fromBlock: hex(HEAD - 25), toBlock: hex(HEAD), address: [V4_POOL_MANAGER], topics: [[V4_SWAP_TOPIC], [FATCOIN_POOL_ID]] }]);
    expect(onLogs).toHaveBeenCalledWith([tracked], HEAD);
    expect(poller.stats()).toMatchObject({ logs: 1, dropped: 1 });
  });

  it("omits the PoolManager when no poolIds are tracked and skips eth_getLogs while the filter is empty", async () => {
    const node = fakeNode({ head: HEAD });
    const { poller, onLogs } = build(node);
    poller.start(onLogs);
    await tick();
    expect(node.calls).toHaveLength(1);
    expect(node.logsCalls()).toEqual([]);
    expect(poller.stats()).toMatchObject({ cursor: HEAD, head: HEAD, polls: 1 });

    poller.setFilter([V2_POOL], []);
    node.chain.head = HEAD + 1;
    await tick(DEFAULT_INTERVAL_MS);
    expect(node.logsCalls()).toHaveLength(1);
    expect(node.logsCalls()[0]!.address).toEqual([V2_POOL]);
  });

  it("backs off 2s, 4s ... on 429, never throws, and resets once a poll succeeds", async () => {
    const node = fakeNode({ head: HEAD });
    node.chain.rateLimit = 2;
    const { poller, onLogs, log } = build(node);
    poller.setFilter([V3_POOL], []);
    poller.start(onLogs);
    await tick();
    expect(poller.stats()).toMatchObject({ errors: 1, polls: 1, cursor: null, lastError: "rpc 429 rate limited", blockedUntil: START + BACKOFF_MIN_MS });
    expect(log).toHaveBeenCalledWith("robinhood log poller: rpc 429 rate limited");

    await tick(BACKOFF_MIN_MS - 1);
    expect(node.calls).toHaveLength(1);
    await tick(1);
    expect(node.calls).toHaveLength(2);
    expect(poller.stats()).toMatchObject({ errors: 2, blockedUntil: START + BACKOFF_MIN_MS + BACKOFF_MIN_MS * 2 });

    await tick(BACKOFF_MIN_MS * 2 - 1);
    expect(node.calls).toHaveLength(2);
    await tick(1);
    expect(poller.stats()).toMatchObject({ errors: 2, cursor: HEAD, blockedUntil: null, lastOkAt: Date.now() });
    expect(onLogs).not.toHaveBeenCalled();

    node.chain.status = 500;
    await tick(DEFAULT_INTERVAL_MS);
    expect(poller.stats()).toMatchObject({ errors: 3, lastError: "rpc returned 500", blockedUntil: Date.now() + BACKOFF_MIN_MS });
  });

  it("caps the backoff at 30s", async () => {
    const node = fakeNode({ head: HEAD });
    node.chain.rateLimit = 100;
    const { poller, onLogs } = build(node);
    poller.setFilter([V3_POOL], []);
    poller.start(onLogs);
    await tick();
    for (let attempt = 0; attempt < 6; attempt += 1) await tick(BACKOFF_MAX_MS);
    const before = node.calls.length;
    await tick(BACKOFF_MAX_MS - 1);
    expect(node.calls).toHaveLength(before);
    await tick(1);
    expect(node.calls).toHaveLength(before + 1);
    expect(poller.stats().blockedUntil).toBe(Date.now() + BACKOFF_MAX_MS);
  });

  it("keeps a batch error on 429 from disabling batching", async () => {
    const node = fakeNode({ head: HEAD });
    const { poller, onLogs } = build(node);
    poller.setFilter([V3_POOL], []);
    poller.start(onLogs);
    await tick();
    node.chain.rateLimit = 1;
    await tick(DEFAULT_INTERVAL_MS);
    expect(node.calls.at(-1)!.batched).toBe(true);
    expect(poller.stats().errors).toBe(1);
    await tick(BACKOFF_MIN_MS);
    expect(node.calls.at(-1)!.batched).toBe(true);
    expect(poller.stats()).toMatchObject({ errors: 1, polls: 3, blockedUntil: null });
  });

  it("stop clears the timer and a later start resumes from the same cursor", async () => {
    const node = fakeNode({ head: HEAD });
    const { poller, onLogs } = build(node);
    poller.setFilter([V3_POOL], []);
    poller.start(onLogs);
    await tick();
    poller.stop();
    await tick(DEFAULT_INTERVAL_MS * 10);
    expect(node.calls).toHaveLength(2);
    expect(poller.stats().cursor).toBe(HEAD);

    node.chain.head = HEAD + 3;
    poller.start(onLogs);
    await tick();
    expect(node.calls).toHaveLength(3);
    expect(node.logsCalls().at(-1)).toMatchObject({ fromBlock: hex(HEAD - 5) });
    expect(poller.stats().cursor).toBe(HEAD + 3);
  });

  it("changing the filter keeps the cursor and applies to the next poll", async () => {
    const node = fakeNode({ head: HEAD });
    const { poller, onLogs } = build(node);
    poller.setFilter([V3_POOL], []);
    poller.start(onLogs);
    await tick();
    expect(poller.stats().cursor).toBe(HEAD);

    poller.setFilter([V2_POOL], [FATCOIN_POOL_ID]);
    expect(poller.stats().cursor).toBe(HEAD);
    node.chain.head = HEAD + 2;
    await tick(DEFAULT_INTERVAL_MS);
    expect(node.logsCalls().slice(-2)).toEqual([
      { fromBlock: hex(HEAD - 5), toBlock: hex(HEAD + DEFAULT_MAX_RANGE), address: [V2_POOL], topics: [POOL_SWAP_TOPICS] },
      { fromBlock: hex(HEAD - 5), toBlock: hex(HEAD + DEFAULT_MAX_RANGE), address: [V4_POOL_MANAGER], topics: [[V4_SWAP_TOPIC], [FATCOIN_POOL_ID]] }
    ]);
    expect(poller.stats().cursor).toBe(HEAD + 2);
  });

  it("does not back off or lose the cursor when the handler throws", async () => {
    const node = fakeNode({ head: HEAD, logs: [mkLog(HEAD, "0xaa", 1, V3_POOL, V3_SWAP_TOPIC)] });
    const { poller } = build(node);
    poller.setFilter([V3_POOL], []);
    poller.start(() => {
      throw new Error("boom");
    });
    await expect(tick()).resolves.toBeUndefined();
    expect(poller.stats()).toMatchObject({ cursor: HEAD, logs: 1, errors: 0, blockedUntil: null, lastError: "handler: boom" });
  });

  it("drops malformed, removed and foreign-topic entries", async () => {
    const good = mkLog(HEAD, "0xaa", 1, V3_POOL, V3_SWAP_TOPIC);
    const removed = { ...mkLog(HEAD, "0xbb", 1, V3_POOL, V3_SWAP_TOPIC), removed: true };
    const foreign = mkLog(HEAD, "0xcc", 1, V3_POOL, "0x" + "f".repeat(64));
    const node = fakeNode({ head: HEAD, logs: [good, removed] });
    node.chain.raw = [foreign, { bogus: true }, null];
    const { poller, onLogs } = build(node);
    poller.setFilter([V3_POOL], []);
    poller.start(onLogs);
    await tick();
    expect(onLogs).toHaveBeenCalledWith([good], HEAD);
    expect(poller.stats()).toMatchObject({ logs: 1, dropped: 4, errors: 0 });
  });

  it("bounds the seen ring: a key ages out after SEEN_RING newer ones, newer keys stay deduped", async () => {
    const good = mkLog(HEAD, "0xaa", 1, V3_POOL, V3_SWAP_TOPIC);
    const node = fakeNode({ head: HEAD, logs: [good] });
    const { poller, onLogs } = build(node);
    poller.setFilter([V3_POOL], []);
    poller.start(onLogs);
    await tick();
    expect(onLogs).toHaveBeenCalledTimes(1);

    const flood = Array.from({ length: SEEN_RING }, (_, i) => mkLog(HEAD + 1, `0x${i.toString(16)}`, 0, V3_POOL, V2_SWAP_TOPIC));
    node.chain.logs = flood;
    node.chain.head = HEAD + 1;
    await tick(DEFAULT_INTERVAL_MS);
    expect(onLogs).toHaveBeenCalledTimes(2);
    expect(poller.stats()).toMatchObject({ logs: 1 + SEEN_RING, dropped: 0 });

    node.chain.logs = [good, flood[1]!, flood[SEEN_RING - 1]!];
    node.chain.head = HEAD + 2;
    await tick(DEFAULT_INTERVAL_MS);
    expect(onLogs).toHaveBeenCalledTimes(3);
    expect(onLogs).toHaveBeenLastCalledWith([good], HEAD + 2);
    expect(poller.stats()).toMatchObject({ logs: 2 + SEEN_RING, dropped: 2 });
  });

  it("rides extra legs on the same window and batch; their logs reach onLogs deduped and filtered like the pool legs", async () => {
    const PONS_FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
    const TOKEN_LAUNCHED = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";
    const swap = mkLog(HEAD - 1, "0xaa", 1, V3_POOL, V3_SWAP_TOPIC);
    const launch = mkLog(HEAD - 2, "0xbb", 3, PONS_FACTORY, TOKEN_LAUNCHED);
    const otherFactoryEvent = mkLog(HEAD - 2, "0xcc", 4, PONS_FACTORY, "0x" + "e".repeat(64));
    const node = fakeNode({ head: HEAD, logs: [swap, launch, otherFactoryEvent] });
    const { poller, onLogs } = build(node);
    poller.setFilter([V3_POOL], []);
    poller.setExtraLegs([{ addresses: [PONS_FACTORY.toUpperCase()], topics: [[TOKEN_LAUNCHED.toUpperCase()]] }]);
    poller.start(onLogs);
    await tick();

    expect(node.logsCalls()).toEqual([
      { fromBlock: hex(HEAD - 25), toBlock: hex(HEAD), address: [V3_POOL], topics: [POOL_SWAP_TOPICS] },
      { fromBlock: hex(HEAD - 25), toBlock: hex(HEAD), address: [PONS_FACTORY], topics: [[TOKEN_LAUNCHED]] }
    ]);
    expect(onLogs).toHaveBeenCalledWith([launch, swap], HEAD);
    expect(poller.stats()).toMatchObject({ logs: 2, dropped: 0, rpcCalls: 3 });

    const later = mkLog(HEAD + 1, "0xdd", 0, PONS_FACTORY, TOKEN_LAUNCHED);
    node.chain.logs = [swap, launch, later];
    node.chain.raw = [otherFactoryEvent];
    node.chain.head = HEAD + 1;
    await tick(DEFAULT_INTERVAL_MS);
    expect(node.calls.at(-1)!.batched).toBe(true);
    expect(node.calls.at(-1)!.requests.map((req) => req.method)).toEqual(["eth_blockNumber", "eth_getLogs", "eth_getLogs"]);
    expect(node.logsCalls().at(-1)).toEqual({ fromBlock: hex(HEAD - 5), toBlock: hex(HEAD + DEFAULT_MAX_RANGE), address: [PONS_FACTORY], topics: [[TOKEN_LAUNCHED]] });
    expect(onLogs).toHaveBeenLastCalledWith([later], HEAD + 1);
    expect(poller.stats()).toMatchObject({ logs: 3, dropped: 4, rpcCalls: 4 });

    poller.setExtraLegs([]);
    node.chain.head = HEAD + 2;
    await tick(DEFAULT_INTERVAL_MS);
    expect(node.calls.at(-1)!.requests.map((req) => req.method)).toEqual(["eth_blockNumber", "eth_getLogs"]);
    expect(node.logsCalls().at(-1)!.address).toEqual([V3_POOL]);
  });
});

describe("RobinhoodLogPoller on a shared logs lane", () => {
  const LANE_GAP = 5_000;
  function makeLane() {
    return new LogsLane({ minGapMs: LANE_GAP, maxGapMs: 30_000, backfillGapMs: LANE_GAP, now: () => Date.now(), log: vi.fn() });
  }

  it("ticks no faster than the lane gap even with a 2 s interval, and two pollers never start within the gap of each other", async () => {
    const lane = makeLane();
    const nodeA = fakeNode({ head: HEAD });
    const nodeB = fakeNode({ head: HEAD });
    const a = build(nodeA, { lane });
    const b = build(nodeB, { lane });
    a.poller.setFilter([V3_POOL], []);
    b.poller.setFilter([V2_POOL], []);
    a.poller.start(a.onLogs);
    b.poller.start(b.onLogs);
    await tick();
    // A's first (sequential) tick holds the one slot; B waits for the gap
    expect(nodeA.calls).toHaveLength(2);
    expect(nodeB.calls).toHaveLength(0);
    await tick(LANE_GAP - 1);
    expect(nodeB.calls).toHaveLength(0);
    await tick(1);
    expect(nodeB.calls).toHaveLength(2);
    expect(nodeA.calls).toHaveLength(2);

    await tick(60_000);
    const starts = [...new Set([...nodeA.calls, ...nodeB.calls].map((call) => call.at))].sort((x, y) => x - y);
    const diffs = starts.slice(1).map((at, i) => at - starts[i]!);
    expect(Math.min(...diffs)).toBeGreaterThanOrEqual(LANE_GAP);
    // 65 s of lane time at one start per 5 s: 13 slots shared by the two pollers, none faster than the 2 s interval would allow
    expect(starts).toHaveLength(14);
    expect(a.poller.stats().errors + b.poller.stats().errors).toBe(0);
  });

  it("follows the lane's widened gap after a 429 and a caller-supplied fetchImpl gets no lane unless one is passed", async () => {
    const lane = makeLane();
    const node = fakeNode({ head: HEAD });
    const { poller, onLogs } = build(node, { lane });
    poller.setFilter([V3_POOL], []);
    poller.start(onLogs);
    await tick();
    lane.report429();
    lane.report429();
    expect(lane.gapMs()).toBe(4 * LANE_GAP);
    await tick(4 * LANE_GAP - 1);
    expect(node.calls).toHaveLength(2);
    await tick(1);
    expect(node.calls).toHaveLength(3);

    const plain = build(fakeNode({ head: HEAD }));
    plain.poller.setFilter([V3_POOL], []);
    plain.poller.start(plain.onLogs);
    await tick();
    await tick(DEFAULT_INTERVAL_MS);
    expect(plain.poller.stats().polls).toBe(2);
  });

  it("a priority backfill on the same lane takes the slot ahead of a waiting tick, and stop() while waiting skips the poll", async () => {
    const lane = makeLane();
    const node = fakeNode({ head: HEAD });
    const { poller, onLogs } = build(node, { lane });
    poller.setFilter([V3_POOL], []);
    poller.start(onLogs);
    await tick();
    expect(node.calls).toHaveLength(2);
    const order: string[] = [];
    await tick(LANE_GAP - 1);
    void lane.run("priority", async () => {
      order.push("backfill");
    });
    await tick(1);
    expect(order).toEqual(["backfill"]);
    expect(node.calls).toHaveLength(2);
    // the tick that was queued behind the backfill now waits one more gap
    await tick(LANE_GAP - 1);
    expect(node.calls).toHaveLength(2);
    await tick(1);
    expect(node.calls).toHaveLength(3);

    await tick(1);
    poller.stop();
    await tick(2 * LANE_GAP);
    expect(node.calls).toHaveLength(3);
    expect(lane.stats().queued).toEqual({ routine: 0, priority: 0 });
  });
});
