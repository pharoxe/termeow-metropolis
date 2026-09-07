import { readFileSync } from "node:fs";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RobinhoodWsLogs, type WsLogsHandlers } from "./wsLogs.js";
import { MAX_SUBSCRIPTIONS_PER_CONNECTION, type LegFilter } from "./wsLegs.js";

type Capture = { logSamples: Record<string, Array<Record<string, any>>>; newHeadsSamples: Array<Record<string, any>> };
const publicnode = JSON.parse(readFileSync(new URL("./__fixtures__/r7/ws-frames-publicnode.json", import.meta.url), "utf8")) as Capture;
const USEROP: LegFilter = { address: ["0x4337084d9e255ff0702461cf8895ce9e3b5ff108"], topics: [["0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f"]] };
const LAUNCH: LegFilter = { address: ["0x1111111111111111111111111111111111111111"], topics: [["0x" + "a".repeat(64)]] };

type Request = { id: number; method: string; params: unknown[] };
type Client = { socket: any; requests: Request[]; pings: number; subs: Map<string, unknown> };

/** Minimal JSON-RPC subscription node: acks every eth_subscribe with a fresh id unless told to stay silent, tracks pings. */
async function fakeNode(opts: { silentSubscribes?: number; rejectLogs?: (filter: unknown) => boolean; silentLogs?: (filter: unknown) => boolean } = {}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const clients: Client[] = [];
  let nextSub = 1;
  let silent = opts.silentSubscribes ?? 0;
  server.on("connection", (socket: any) => {
    const client: Client = { socket, requests: [], pings: 0, subs: new Map() };
    clients.push(client);
    socket.on("ping", () => {
      client.pings += 1;
    });
    socket.on("message", (data: Buffer) => {
      const req = JSON.parse(data.toString()) as Request;
      client.requests.push(req);
      if (req.method === "eth_subscribe") {
        if (silent > 0) {
          silent -= 1;
          return;
        }
        if (req.params[0] === "logs" && opts.silentLogs?.(req.params[1])) return;
        if (req.params[0] === "logs" && opts.rejectLogs?.(req.params[1])) {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "invalid argument 1: exceed max topics" } }));
          return;
        }
        const id = `0x${(nextSub++).toString(16).padStart(32, "0")}`;
        client.subs.set(id, req.params);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: id }));
        return;
      }
      if (req.method === "eth_unsubscribe") {
        client.subs.delete(String(req.params[0]));
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: true }));
        return;
      }
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "0x1" }));
    });
  });
  const subFor = (client: Client, kind: "newHeads" | "logs", match?: (params: unknown) => boolean) =>
    [...client.subs].find(([, params]) => (params as unknown[])[0] === kind && (!match || match((params as unknown[])[1])))?.[0] ?? null;
  const push = (client: Client, subscription: string, result: unknown) =>
    client.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription, result } }));
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { url: `ws://127.0.0.1:${port}`, clients, subFor, push, close, server };
}

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function handlers(): WsLogsHandlers & { logs: Array<{ log: unknown; blockTimeMs: number | null }>; heads: Array<[number, number | null]>; opens: number; closes: number } {
  const h = {
    logs: [] as Array<{ log: unknown; blockTimeMs: number | null }>,
    heads: [] as Array<[number, number | null]>,
    opens: 0,
    closes: 0,
    onLog(log: unknown, blockTimeMs: number | null) {
      h.logs.push({ log, blockTimeMs });
    },
    onHead(block: number, timestampMs: number | null) {
      h.heads.push([block, timestampMs]);
    },
    onOpen() {
      h.opens += 1;
    },
    onClose() {
      h.closes += 1;
    }
  };
  return h;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function transport(urls: string[], extra: Partial<ConstructorParameters<typeof RobinhoodWsLogs>[0]> = {}) {
  const log = vi.fn();
  const ws = new RobinhoodWsLogs({ urls, log, makeSocket: (url) => new WebSocket(url), legsDebounceMs: 20, backoffMinMs: 50, backoffMaxMs: 200, ackTimeoutMs: 300, ...extra });
  cleanups.push(() => ws.stop());
  return { ws, log };
}

describe("RobinhoodWsLogs", () => {
  it("subscribes newHeads plus one logs subscription per leg on open, then delivers captured frames with their block times", async () => {
    const node = await fakeNode();
    cleanups.push(node.close);
    const { ws } = transport([node.url]);
    const h = handlers();
    ws.setLegs([USEROP]);
    ws.start(h);
    await until(() => node.clients[0]?.subs.size === 2);
    const client = node.clients[0]!;
    expect(client.requests.map((req) => [req.method, req.params[0]])).toEqual([["eth_subscribe", "newHeads"], ["eth_subscribe", "logs"]]);
    expect(client.requests[1]!.params[1]).toEqual(USEROP);
    expect(h.opens).toBe(1);
    expect(ws.status()).toMatchObject({ connected: true, url: node.url, subscriptions: 1, wantedLegs: 1, rejectedLegs: 0 });

    const headSub = node.subFor(client, "newHeads")!;
    const logSub = node.subFor(client, "logs")!;
    for (const frame of publicnode.newHeadsSamples) node.push(client, headSub, frame.params.result);
    for (const frame of publicnode.logSamples.userop!) node.push(client, logSub, frame.params.result);
    node.push(client, "0xdeadbeef", { stray: true });
    await until(() => h.logs.length === 2 && h.heads.length === 2);
    expect(h.heads).toEqual([[0x366182b, 0x6a9ef827 * 1000], [0x366182c, 0x6a9ef827 * 1000]]);
    expect(h.logs.map((entry) => entry.log)).toEqual(publicnode.logSamples.userop!.map((frame) => frame.params.result));
    expect(h.logs.map((entry) => entry.blockTimeMs)).toEqual([0x6a9ef825 * 1000, 0x6a9ef826 * 1000]);
    await until(() => ws.status().stray === 1);
    expect(ws.status()).toMatchObject({ notifications: 2, heads: 2, stray: 1, lastBlock: 0x366182c });
  });

  it("resubscribes on a legs change: new legs are subscribed, departed ones unsubscribed, unchanged ones untouched", async () => {
    const node = await fakeNode();
    cleanups.push(node.close);
    const { ws } = transport([node.url]);
    ws.setLegs([USEROP]);
    ws.start(handlers());
    await until(() => node.clients[0]?.subs.size === 2);
    const client = node.clients[0]!;
    const useropSub = node.subFor(client, "logs")!;

    ws.setLegs([USEROP, LAUNCH]);
    ws.setLegs([LAUNCH]); // the debounce collapses both changes into one pass: USEROP out, LAUNCH in
    await until(() => client.requests.length === 4);
    const tail = client.requests.slice(2).map((req) => [req.method, req.params[0] === "logs" ? req.params[1] : req.params[0]]);
    expect(tail).toEqual(expect.arrayContaining([["eth_subscribe", LAUNCH], ["eth_unsubscribe", useropSub]]));
    await until(() => client.subs.size === 2 && node.subFor(client, "logs", (params) => JSON.stringify(params) === JSON.stringify(LAUNCH)) !== null);
    await until(() => ws.status().subscriptions === 1); // the ack has to reach the client too
    expect(ws.status()).toMatchObject({ subscriptions: 1, legChanges: 2, unsubscribes: 1 }); // open pass + this change

    // a frame the node still sends on the retired id is a legitimate log of a leg we asked for: forwarded, counted, not stray
    const h2 = handlers();
    ws.start(h2);
    node.push(client, useropSub, publicnode.logSamples.userop![0]!.params.result);
    await until(() => h2.logs.length === 1);
    expect(ws.status()).toMatchObject({ retiredFrames: 1, stray: 0 });

    ws.setLegs([LAUNCH]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(client.requests).toHaveLength(4);
  });

  it("treats a missing subscribe ack as failure: drops the socket, rotates to the next url, resubscribes there, counts the reconnect", async () => {
    const silentNode = await fakeNode({ silentSubscribes: 1 });
    const goodNode = await fakeNode();
    cleanups.push(silentNode.close, goodNode.close);
    const { ws, log } = transport([silentNode.url, goodNode.url]);
    const h = handlers();
    ws.setLegs([USEROP]);
    ws.start(h);
    await until(() => goodNode.clients[0]?.subs.size === 2, 5_000);
    expect(h.opens).toBe(2);
    expect(h.closes).toBe(1);
    expect(ws.status()).toMatchObject({ connected: true, url: goodNode.url, reconnects: 1, subscriptions: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no ack for newHeads subscribe"));
  });

  it("isolates a logs leg whose ack never comes: that leg alone is rejected, the socket and the acked legs stay live, a reconnect retries it", async () => {
    let silenced = 0;
    const node = await fakeNode({ silentLogs: (filter) => JSON.stringify(filter) === JSON.stringify(LAUNCH) && silenced++ === 0 });
    cleanups.push(node.close);
    const { ws, log } = transport([node.url]);
    const h = handlers();
    ws.setLegs([USEROP, LAUNCH]);
    ws.start(h);
    await until(() => ws.status().rejectedLegs === 1, 5_000);
    expect(ws.status()).toMatchObject({ connected: true, subscriptions: 1, wantedLegs: 2, rejectedLegs: 1, reconnects: 0 });
    expect(ws.status().lastError).toContain("no ack for logs subscribe");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no ack for logs subscribe"));
    expect(h.closes).toBe(0);
    node.push(node.clients[0]!, node.subFor(node.clients[0]!, "logs")!, publicnode.logSamples.userop![0]!.params.result);
    await until(() => h.logs.length === 1);
    node.clients[0]!.socket.terminate();
    await until(() => node.clients[1]?.subs.size === 3, 5_000);
    expect(ws.status()).toMatchObject({ connected: true, subscriptions: 2, wantedLegs: 2, rejectedLegs: 0, reconnects: 1 });
  });

  it("refuses legs past the measured per-connection ceiling instead of sending them to time out unacked", async () => {
    const node = await fakeNode();
    cleanups.push(node.close);
    const { ws } = transport([node.url]);
    const legs: LegFilter[] = Array.from({ length: MAX_SUBSCRIPTIONS_PER_CONNECTION + 2 }, (_, i) => ({ address: [`0x${i.toString(16).padStart(40, "0")}`], topics: [["0x" + "a".repeat(64)]] }));
    ws.setLegs(legs);
    ws.start(handlers());
    await until(() => node.clients[0]?.subs.size === MAX_SUBSCRIPTIONS_PER_CONNECTION + 1, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(node.clients[0]!.requests.filter((req) => req.method === "eth_subscribe")).toHaveLength(MAX_SUBSCRIPTIONS_PER_CONNECTION + 1);
    expect(ws.status()).toMatchObject({ subscriptions: MAX_SUBSCRIPTIONS_PER_CONNECTION, wantedLegs: MAX_SUBSCRIPTIONS_PER_CONNECTION + 2, rejectedLegs: 2 });
    expect(ws.status().lastError).toContain(`${MAX_SUBSCRIPTIONS_PER_CONNECTION} subscriptions per connection`);
  });

  it("reconnects after the node closes the socket (publicnode's 1006 idle drop) and reports the close code meanwhile", async () => {
    const node = await fakeNode();
    cleanups.push(node.close);
    const { ws } = transport([node.url]);
    const h = handlers();
    ws.setLegs([USEROP]);
    ws.start(h);
    await until(() => node.clients[0]?.subs.size === 2);
    node.clients[0]!.socket.terminate();
    await until(() => h.closes === 1);
    expect(ws.status()).toMatchObject({ connected: false, subscriptions: 0 });
    expect(ws.status().lastError).toMatch(/^closed \(1006\)/);
    await until(() => node.clients[1]?.subs.size === 2, 5_000);
    expect(h.opens).toBe(2);
    expect(ws.status()).toMatchObject({ connected: true, reconnects: 1, subscriptions: 1 });
  });

  it("keeps the socket alive with client pings and reconnects when frames stop arriving", async () => {
    const node = await fakeNode();
    cleanups.push(node.close);
    const { ws } = transport([node.url], { keepaliveMs: 40, silenceLimitMs: 150 });
    const h = handlers();
    ws.setLegs([USEROP]);
    ws.start(h);
    await until(() => node.clients[0]?.subs.size === 2);
    await until(() => node.clients[0]!.pings >= 2);
    // pongs count as frames, so a responsive socket survives; a socket whose pongs stop does not
    node.clients[0]!.socket.pong = () => undefined;
    await until(() => h.closes === 1, 5_000);
    expect(ws.status().lastError).toBe("no frame for 150 ms");
  });

  it("drops an over-limit leg before sending, records a node-rejected leg, keeps the rest live", async () => {
    const node = await fakeNode({ rejectLogs: (filter) => JSON.stringify(filter) === JSON.stringify(LAUNCH) });
    cleanups.push(node.close);
    const { ws } = transport([node.url]);
    const huge: LegFilter = { topics: [["0xa"], Array.from({ length: 1_001 }, (_, i) => `0x${i.toString(16)}`)] };
    ws.setLegs([USEROP, LAUNCH, huge]);
    ws.start(handlers());
    await until(() => node.clients[0]?.subs.size === 2);
    await until(() => ws.status().rejectedLegs === 2);
    expect(node.clients[0]!.requests.filter((req) => req.method === "eth_subscribe")).toHaveLength(3);
    expect(ws.status()).toMatchObject({ subscriptions: 1, wantedLegs: 3, rejectedLegs: 2 });
    expect(ws.status().lastError).toContain("exceed max topics");
  });

  it("stop closes the socket, tells the owner, and never reconnects", async () => {
    const node = await fakeNode();
    cleanups.push(node.close);
    const { ws } = transport([node.url]);
    const h = handlers();
    ws.start(h);
    await until(() => h.opens === 1);
    ws.stop();
    expect(h.closes).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(node.clients).toHaveLength(1);
    expect(ws.status()).toMatchObject({ connected: false, reconnects: 0 });
  });
});
