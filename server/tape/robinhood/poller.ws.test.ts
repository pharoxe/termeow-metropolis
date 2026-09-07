import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockTimeCache } from "./blocks.js";
import { resetBlockHints } from "./blockHints.js";
import { CATCHUP_DELAY_MS, DEFAULT_INTERVAL_MS, DEFAULT_MAX_RANGE, RobinhoodLogPoller, WS_CATCHUP_INTERVAL_MS, WS_FLUSH_MS, type RawLog } from "./poller.js";
import type { LegFilter } from "./wsLegs.js";
import type { WsLogsHandlers, WsLogsLike, WsTransportStatus } from "./wsLogs.js";
import { resetTransportRegistry, robinhoodTransportStatus } from "./wsStatus.js";

const RPC = "https://rpc.mainnet.chain.robinhood.com/";
const START = 1_800_000_000_000;
const ENTRY_POINT = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";
const USEROP_TOPIC = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const USEROP_LEG = { addresses: [ENTRY_POINT], topics: [[USEROP_TOPIC]] };

type Capture = { logSamples: Record<string, Array<{ params: { result: RawLog & { blockTimestamp: string } } }>> };
const capture = (name: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/r7/${name}`, import.meta.url), "utf8")) as Capture;
/** Four real UserOperationEvent logs (two per node), in ascending block order, as the websocket delivered them. */
const WS_LOGS = [...capture("ws-frames-publicnode.json").logSamples.userop!, ...capture("ws-frames-pocket.json").logSamples.userop!].map((frame) => frame.params.result);
/** The same rows as the official HTTP node returns them: blockTimestamp 0x0 (fixture http-getlogs-blocktimestamp.json). */
const HTTP_LOGS = WS_LOGS.map((log) => ({ ...log, blockTimestamp: "0x0" }));
const block = (log: RawLog) => Number.parseInt(log.blockNumber, 16);
const FIRST = block(WS_LOGS[0]!);
const HEAD = block(WS_LOGS[WS_LOGS.length - 1]!) + 3;
/** The two captures sit ~1,250 blocks apart, so HTTP tests widen the window to cover both in one page. */
const WIDE = { maxRange: 2_000 };

type RpcRequest = { id: number; method: string; params: unknown[] };
type LogsFilter = { fromBlock: string; toBlock: string; address?: string[]; topics: Array<string[] | null> };

function fakeHttp(initial: { head: number; logs: RawLog[] }) {
  const chain = { head: initial.head, logs: initial.logs };
  const windows: Array<{ from: number; to: number }> = [];
  const answer = (req: RpcRequest) => {
    if (req.method === "eth_blockNumber") return { jsonrpc: "2.0", id: req.id, result: `0x${chain.head.toString(16)}` };
    const filter = req.params[0] as LogsFilter;
    const from = Number.parseInt(filter.fromBlock, 16);
    const to = Math.min(Number.parseInt(filter.toBlock, 16), chain.head);
    windows.push({ from, to });
    const result = chain.logs.filter((log) => block(log) >= from && block(log) <= to && filter.address?.includes(log.address) && filter.topics[0]?.includes(log.topics[0]!));
    return { jsonrpc: "2.0", id: req.id, result };
  };
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), { status: 200 });
  });
  return { chain, windows, fetchImpl: fetchImpl as unknown as typeof fetch };
}

/** In-memory transport: the test drives open/close/frames; records the leg sets the poller asked for. */
class FakeWs implements WsLogsLike {
  handlers: WsLogsHandlers | null = null;
  legSets: LegFilter[][] = [];
  started = 0;
  stopped = 0;
  connected = false;
  /** Wanted legs the fake node has not acked (rejected / unacked); status() reports that many fewer subscriptions. */
  short = 0;
  start(handlers: WsLogsHandlers): void {
    this.handlers = handlers;
    this.started += 1;
  }
  stop(): void {
    this.stopped += 1;
    this.connected = false;
  }
  setLegs(legs: LegFilter[]): void {
    this.legSets.push(legs);
  }
  status(): WsTransportStatus {
    return {
      connected: this.connected,
      url: "wss://robinhood-rpc.publicnode.com",
      connectedAt: this.connected ? START : null,
      subscriptions: this.connected ? Math.max(0, (this.legSets.at(-1)?.length ?? 0) - this.short) : 0,
      wantedLegs: this.legSets.at(-1)?.length ?? 0,
      rejectedLegs: this.short,
      notifications: 0,
      heads: 0,
      stray: 0,
      retiredFrames: 0,
      legChanges: 0,
      unsubscribes: 0,
      reconnects: 0,
      lastError: null,
      lastFrameAt: null,
      lastBlock: null
    };
  }
  open(): void {
    this.connected = true;
    this.handlers?.onOpen();
  }
  close(): void {
    this.connected = false;
    this.handlers?.onClose();
  }
  log(log: RawLog & { blockTimestamp?: string }): void {
    const seconds = Number.parseInt(log.blockTimestamp ?? "0x0", 16);
    this.handlers?.onLog(log, seconds > 0 ? seconds * 1000 : null);
  }
  head(number: number, timestampSec: number | null): void {
    this.handlers?.onHead(number, timestampSec === null ? null : timestampSec * 1000);
  }
}

const pollers: RobinhoodLogPoller[] = [];

function build(http: ReturnType<typeof fakeHttp>, ws: FakeWs | null, opts: { name?: string; maxRange?: number } = {}) {
  const onLogs = vi.fn();
  const poller = new RobinhoodLogPoller({ rpcUrl: RPC, fetchImpl: http.fetchImpl, log: vi.fn(), ws, ...opts });
  poller.setExtraLegs([USEROP_LEG]);
  pollers.push(poller);
  return { poller, onLogs };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** First poll just before the first fixture block (empty lookback), then one wide page up to HEAD. */
async function primeHttp(http: ReturnType<typeof fakeHttp>, poller: RobinhoodLogPoller, onLogs: ReturnType<typeof vi.fn>): Promise<void> {
  http.chain.head = FIRST - 1;
  poller.start(onLogs);
  await tick();
  http.chain.head = HEAD;
  await tick(DEFAULT_INTERVAL_MS);
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  resetBlockHints();
  resetTransportRegistry();
});

afterEach(() => {
  while (pollers.length) pollers.pop()?.stop();
  vi.useRealTimers();
});

describe("RobinhoodLogPoller websocket transport", () => {
  it("hands the ws the same legs it polls over HTTP (range-free) and re-pushes them on every filter change", async () => {
    const http = fakeHttp({ head: HEAD, logs: [] });
    const ws = new FakeWs();
    const { poller, onLogs } = build(http, ws);
    poller.start(onLogs);
    expect(ws.started).toBe(1);
    expect(ws.legSets.at(-1)).toEqual([{ address: [ENTRY_POINT], topics: [[USEROP_TOPIC]] }]);
    poller.setFilter(["0x7BA7d2a2d549bbb699fead825298b87fea9f0a31"], []);
    expect(ws.legSets.at(-1)).toEqual([
      { address: ["0x7ba7d2a2d549bbb699fead825298b87fea9f0a31"], topics: [[expect.any(String), expect.any(String)]] },
      { address: [ENTRY_POINT], topics: [[USEROP_TOPIC]] }
    ]);
    poller.stop();
    expect(ws.stopped).toBe(1);
  });

  it("parity: the captured logs produce identical prints whether they arrive as ws frames or as an HTTP page", async () => {
    const httpNode = fakeHttp({ head: HEAD, logs: HTTP_LOGS });
    const viaHttp = build(httpNode, null, WIDE);
    await primeHttp(httpNode, viaHttp.poller, viaHttp.onLogs);
    expect(viaHttp.onLogs).toHaveBeenCalledTimes(1);

    const ws = new FakeWs();
    const viaWs = build(fakeHttp({ head: HEAD, logs: [] }), ws);
    viaWs.poller.start(viaWs.onLogs);
    await tick(); // first HTTP poll, nothing there
    ws.open();
    await tick();
    for (const log of [...WS_LOGS].reverse()) ws.log(log); // frames out of order: the flush restores block/logIndex order
    await tick(WS_FLUSH_MS);
    expect(viaWs.onLogs).toHaveBeenCalledTimes(1);

    const strip = (logs: RawLog[]) => logs.map(({ blockTimestamp: _t, ...rest }: RawLog & { blockTimestamp?: string }) => rest);
    const httpPrints = strip(viaHttp.onLogs.mock.calls[0]![0] as RawLog[]);
    const wsPrints = strip(viaWs.onLogs.mock.calls[0]![0] as RawLog[]);
    expect(wsPrints).toEqual(httpPrints);
    expect(wsPrints.map((log) => log.transactionHash)).toEqual(WS_LOGS.map((log) => log.transactionHash));
    expect(viaWs.poller.stats()).toMatchObject({ logs: 4, dropped: 0, cursor: HEAD });
    expect(viaWs.poller.transport()).toMatchObject({ mode: "ws", wsLogs: 4, lastWsBlock: block(WS_LOGS[3]!) });
  });

  it("never delivers a log twice across transports: a frame already seen is dropped when the HTTP sweep returns it, and vice versa", async () => {
    const http = fakeHttp({ head: HEAD, logs: HTTP_LOGS });
    const ws = new FakeWs();
    const { poller, onLogs } = build(http, ws, WIDE);
    http.chain.head = FIRST - 1;
    poller.start(onLogs);
    await tick();
    http.chain.head = block(WS_LOGS[1]!); // HTTP verifies up to the second log
    await tick(DEFAULT_INTERVAL_MS);
    expect(onLogs).toHaveBeenCalledTimes(1);
    expect((onLogs.mock.calls[0]![0] as RawLog[]).map((log) => log.transactionHash)).toEqual(WS_LOGS.slice(0, 2).map((log) => log.transactionHash));
    ws.open();
    await tick();
    for (const log of WS_LOGS) ws.log(log); // first two are repeats, last two are new
    await tick(WS_FLUSH_MS);
    expect(onLogs).toHaveBeenCalledTimes(2);
    expect((onLogs.mock.calls[1]![0] as RawLog[]).map((log) => log.transactionHash)).toEqual(WS_LOGS.slice(2).map((log) => log.transactionHash));
    http.chain.head = HEAD; // the catch-up sweep from the HTTP-verified block returns the last two again; neither is new
    await tick(WS_CATCHUP_INTERVAL_MS);
    expect(onLogs).toHaveBeenCalledTimes(2);
    expect(http.windows.at(-1)).toEqual({ from: block(WS_LOGS[1]!) - 5, to: HEAD });
    // open-kick sweep re-read the first two (reorg overlap), the frames repeated them, the catch-up sweep re-read all four
    expect(poller.stats()).toMatchObject({ logs: 4, dropped: 2 + 2 + 4 });
  });

  it("slows the HTTP tick to the catch-up cadence while connected, sweeping from its own last verified block, and resumes the normal cadence on close", async () => {
    const http = fakeHttp({ head: HEAD, logs: [] });
    const ws = new FakeWs();
    const { poller, onLogs } = build(http, ws);
    poller.start(onLogs);
    await tick();
    const httpTo = HEAD;
    ws.open();
    await tick(); // the open kicks one immediate sweep (gap fill); ws-mode cadence from here
    expect(http.windows).toHaveLength(2);
    for (let i = 1; i <= 100; i += 1) ws.head(HEAD + i, null);
    http.chain.head = HEAD + 100;
    await tick(DEFAULT_INTERVAL_MS * 5);
    expect(http.windows).toHaveLength(2);
    await tick(WS_CATCHUP_INTERVAL_MS - DEFAULT_INTERVAL_MS * 5);
    expect(http.windows).toHaveLength(3);
    expect(http.windows[2]).toEqual({ from: httpTo - 5, to: HEAD + 100 });
    expect(poller.transport()).toMatchObject({ mode: "ws", catchUpTicks: 2 });

    ws.close();
    await tick(); // the close kicks a sweep, then the 2 s cadence returns
    expect(http.windows).toHaveLength(4);
    await tick(DEFAULT_INTERVAL_MS);
    expect(http.windows).toHaveLength(5);
    expect(poller.transport().mode).toBe("http");
  });

  it("fills a reconnect gap with one HTTP sweep over [last HTTP-verified block - reorg, head] as soon as the socket is back", async () => {
    const http = fakeHttp({ head: HEAD, logs: [] });
    const ws = new FakeWs();
    const { poller, onLogs } = build(http, ws);
    poller.start(onLogs);
    await tick();
    ws.open();
    await tick();
    ws.head(HEAD + 10, null);
    http.chain.head = HEAD + 10;
    ws.close(); // socket drops at HEAD+10; the chain moves on (the close kicks a sweep that finds nothing yet)
    await tick();
    expect(http.windows.at(-1)).toEqual({ from: HEAD - 5, to: HEAD + 10 });
    const missed = { ...HTTP_LOGS[0]!, blockNumber: `0x${(HEAD + 20).toString(16)}`, transactionHash: "0x" + "9".repeat(64) };
    http.chain.head = HEAD + 30;
    http.chain.logs = [missed];
    ws.open();
    await tick();
    // HTTP last verified HEAD+10 on the close sweep, so the gap fill starts there: nothing between the drop and the reconnect is skipped
    expect(http.windows.at(-1)).toEqual({ from: HEAD + 10 - 5, to: HEAD + 30 });
    expect(onLogs).toHaveBeenLastCalledWith([missed], HEAD + 30);
    expect(poller.stats().cursor).toBe(HEAD + 30);
  });

  it("keeps HTTP as the backstop however far the socket runs ahead: sweeps from its own verified block, pages at the catch-up delay, dedupes what the frames delivered", async () => {
    const http = fakeHttp({ head: HEAD, logs: [] });
    const ws = new FakeWs();
    const { poller, onLogs } = build(http, ws);
    poller.start(onLogs);
    await tick();
    ws.open();
    await tick(); // open-kick sweep verified HEAD
    const far = { ...WS_LOGS[0]!, blockNumber: `0x${(HEAD + 1_500).toString(16)}`, transactionHash: "0x" + "8".repeat(64) };
    ws.log(far);
    await tick(WS_FLUSH_MS);
    expect(onLogs).toHaveBeenCalledTimes(1);
    ws.head(HEAD + 2_000, null);
    http.chain.head = HEAD + 2_000;
    const farOverHttp: RawLog = { ...far, blockTimestamp: "0x0" } as RawLog; // the official node's row shape for the same log
    http.chain.logs = [farOverHttp];
    await tick(WS_CATCHUP_INTERVAL_MS);
    expect(http.windows.at(-1)).toEqual({ from: HEAD - 5, to: HEAD + DEFAULT_MAX_RANGE });
    for (let page = 2; page <= 5; page += 1) {
      await tick(CATCHUP_DELAY_MS);
      expect(http.windows.at(-1)).toEqual({ from: HEAD + (page - 1) * DEFAULT_MAX_RANGE - 5, to: HEAD + page * DEFAULT_MAX_RANGE });
    }
    expect(poller.transport()).toMatchObject({ mode: "ws", httpCursor: HEAD + 2_000 });
    expect(onLogs).toHaveBeenCalledTimes(1); // page 4 re-read `far`; the frame's key was still held, so no second print
    await tick(CATCHUP_DELAY_MS * 4);
    expect(http.windows).toHaveLength(7); // caught up: back to the catch-up cadence
  });

  it("reports http and keeps the normal HTTP cadence while any wanted leg is unsubscribed; ws once every leg is live", async () => {
    const http = fakeHttp({ head: HEAD, logs: [] });
    const ws = new FakeWs();
    ws.short = 1;
    const { poller, onLogs } = build(http, ws);
    poller.start(onLogs);
    await tick();
    ws.open();
    await tick();
    expect(http.windows).toHaveLength(2);
    expect(poller.transport()).toMatchObject({ mode: "http", catchUpTicks: 0 });
    expect(robinhoodTransportStatus()).toMatchObject({ label: "HTTP", mode: "http" });
    await tick(DEFAULT_INTERVAL_MS);
    expect(http.windows).toHaveLength(3);
    ws.short = 0;
    await tick(DEFAULT_INTERVAL_MS);
    expect(http.windows).toHaveLength(4);
    expect(poller.transport().mode).toBe("ws");
    await tick(DEFAULT_INTERVAL_MS * 5);
    expect(http.windows).toHaveLength(4);
  });

  it("feeds newHeads and frame block times to the block cache so consumers time ws prints without an RPC; HTTP pages feed nothing", async () => {
    const http = fakeHttp({ head: HEAD, logs: HTTP_LOGS });
    const ws = new FakeWs();
    const { poller, onLogs } = build(http, ws, WIDE);
    await primeHttp(http, poller, onLogs); // the four logs arrive as HTTP rows (blockTimestamp 0x0) first
    ws.open();
    ws.head(HEAD + 1, 1_757_000_000);
    ws.log(WS_LOGS[2]!); // a frame whose newHeads header never arrived: its own blockTimestamp times the block
    await tick(WS_FLUSH_MS);
    const blockFetch = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { timestamp: "0x1" } }), { status: 200 }));
    const cache = new BlockTimeCache({ rpcUrl: RPC, fetchImpl: blockFetch as unknown as typeof fetch });
    await expect(cache.timeMs(HEAD + 1)).resolves.toBe(1_757_000_000_000);
    await expect(cache.timeMs(block(WS_LOGS[2]!))).resolves.toBe(Number.parseInt(WS_LOGS[2]!.blockTimestamp, 16) * 1000);
    expect(blockFetch).not.toHaveBeenCalled();
    await expect(cache.timeMs(block(WS_LOGS[0]!))).resolves.toBe(1_000); // HTTP-only block: no hint, one RPC
    expect(blockFetch).toHaveBeenCalledTimes(1);
  });

  it("is HTTP-only when the transport is disabled: the cadence is the interval, and the health view still lists the poller as HTTP", async () => {
    const http = fakeHttp({ head: HEAD, logs: HTTP_LOGS });
    const { poller, onLogs } = build(http, null, { name: "tape" });
    poller.start(onLogs);
    await tick();
    await tick(DEFAULT_INTERVAL_MS);
    expect(http.windows).toHaveLength(2);
    expect(onLogs).toHaveBeenCalledTimes(1);
    expect(poller.transport()).toMatchObject({ mode: "http", wsEnabled: false, ws: null, httpCursor: HEAD });
    expect(robinhoodTransportStatus()).toMatchObject({ label: "HTTP", mode: "http", pollers: [{ name: "tape", mode: "http", wsEnabled: false, ws: null }] });
    poller.stop();
    expect(robinhoodTransportStatus().pollers).toEqual([]);
  });

  it("publishes per-poller transport state under its name while started, and leaves on stop", async () => {
    const http = fakeHttp({ head: HEAD, logs: [] });
    const ws = new FakeWs();
    const { poller, onLogs } = build(http, ws, { name: "launch" });
    poller.start(onLogs);
    expect(robinhoodTransportStatus()).toMatchObject({ label: "HTTP", pollers: [{ name: "launch", mode: "http", wsEnabled: true }] });
    ws.open();
    const status = robinhoodTransportStatus();
    expect(status).toMatchObject({ label: "WS", mode: "ws" });
    expect(status.pollers[0]).toMatchObject({ name: "launch", mode: "ws", ws: { url: "wss://robinhood-rpc.publicnode.com", connectedAt: START, subscriptions: 1, wantedLegs: 1 } });
    poller.stop();
    expect(robinhoodTransportStatus().pollers).toEqual([]);
  });
});

describe("transport registry", () => {
  it("lists two unnamed pollers side by side under distinct default names and labels the aggregate MIXED when only one is fully subscribed", async () => {
    const firstWs = new FakeWs();
    const first = build(fakeHttp({ head: HEAD, logs: [] }), firstWs);
    const second = build(fakeHttp({ head: HEAD, logs: [] }), new FakeWs());
    first.poller.start(first.onLogs);
    second.poller.start(second.onLogs);
    const names = robinhoodTransportStatus().pollers.map((poller) => poller.name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names.every((name) => /^poller-\d+$/.test(name))).toBe(true);
    firstWs.open();
    expect(robinhoodTransportStatus()).toMatchObject({ label: "MIXED", mode: "mixed" });
    first.poller.stop();
    expect(robinhoodTransportStatus()).toMatchObject({ label: "HTTP", pollers: [{ mode: "http" }] });
  });
});
