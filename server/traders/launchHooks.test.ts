import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FlowPrint } from "../../shared/wire.js";
import type { ExtraLeg, LogsHandler, PollerStats, RawLog } from "../tape/robinhood/poller.js";
import { USER_OPERATION_EVENT_TOPIC } from "./attribute.js";
import { USER_OP_LEG, curveTradeKey, curveTrader, isUserOpLog, userOpSenders, withTraderHooks, type TraderHooksLike } from "./launchHooks.js";
import { ENTRY_POINT, type AnnotateContext, type MetaOf } from "./service.js";

const NOW = 1_800_000_000_000;

function fixture(name: string): RawLog[] {
  return JSON.parse(readFileSync(new URL(`../launch/__fixtures__/${name}.json`, import.meta.url), "utf8")) as RawLog[];
}

const CURVE_BUY = fixture("pons-curve-CurveBuy")[0];
const CURVE_SELL = fixture("pons-curve-CurveSell")[0];
const FLAP_BOUGHT = fixture("flap-TokenBought")[0];
const TRENCH_PURCHASE = fixture("trench-TokenPurchase")[0];
const SENDER = "0x06de9c48b1e639ed5c13ec8fbd4080a38e39f2d1";

function topicAddr(log: RawLog, index: number): string {
  return `0x${log.topics[index].slice(-40).toLowerCase()}`;
}

function wordAddr(log: RawLog, index: number): string {
  return `0x${log.data.slice(2).slice(index * 64, (index + 1) * 64).slice(-40).toLowerCase()}`;
}

function userOpLog(sender: string, tx = "0xuserop"): RawLog {
  return {
    address: ENTRY_POINT,
    topics: [USER_OPERATION_EVENT_TOPIC, `0x${"11".repeat(32)}`, `0x${"0".repeat(24)}${sender.slice(2)}`, `0x${"0".repeat(64)}`],
    data: "0x",
    blockNumber: "0x1",
    blockHash: "0x2",
    transactionHash: tx,
    transactionIndex: "0x0",
    logIndex: "0x0"
  };
}

class FakePoller {
  legs: ExtraLeg[] = [];
  handler: LogsHandler | null = null;
  stopped = 0;
  setExtraLegs(legs: ExtraLeg[]): void {
    this.legs = legs;
  }
  start(onLogs: LogsHandler): void {
    this.handler = onLogs;
  }
  stop(): void {
    this.stopped += 1;
  }
  stats(): PollerStats {
    return { cursor: 1, head: 1, polls: 1, logs: 0, dropped: 0, errors: 0, lastError: null, lastOkAt: NOW, rpcCalls: 1, blockedUntil: null };
  }
}

class FakeTraders implements TraderHooksLike {
  annotateCalls: Array<{ prints: FlowPrint[]; ctx: AnnotateContext }> = [];
  recordCalls: Array<{ prints: FlowPrint[]; meta: MetaOf }> = [];
  discovered: string[][] = [];
  delay: Promise<void> = Promise.resolve();
  async annotate(prints: FlowPrint[], ctx: AnnotateContext): Promise<FlowPrint[]> {
    this.annotateCalls.push({ prints, ctx });
    await this.delay;
    return prints.map((print) => {
      const meta = ctx.meta(print);
      return meta?.trader ? { ...print, trader: { address: meta.trader, kind: "fomo", handle: null, followers: null } } : print;
    });
  }
  record(prints: FlowPrint[], meta: MetaOf): void {
    this.recordCalls.push({ prints, meta });
  }
  async discover(senders: string[]): Promise<void> {
    this.discovered.push(senders);
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("curveTrader", () => {
  it("reads the wallet from Pons CurveBuy topic2 / CurveSell topic1 keyed by the pons:<curve> pair", () => {
    const buy = curveTrader(CURVE_BUY);
    expect(buy).toEqual({ key: `${CURVE_BUY.transactionHash.toLowerCase()}:pons:${CURVE_BUY.address.toLowerCase()}`, trader: topicAddr(CURVE_BUY, 2), token: null });
    expect(curveTrader(CURVE_SELL)?.trader).toBe(topicAddr(CURVE_SELL, 1));
  });

  it("reads Flap wallets from the data words and Trench wallets from topic2, both carrying the token", () => {
    expect(curveTrader(FLAP_BOUGHT)).toEqual({ key: `${FLAP_BOUGHT.transactionHash.toLowerCase()}:flap:${wordAddr(FLAP_BOUGHT, 1)}`, trader: wordAddr(FLAP_BOUGHT, 2), token: wordAddr(FLAP_BOUGHT, 1) });
    expect(curveTrader(TRENCH_PURCHASE)).toEqual({
      key: `${TRENCH_PURCHASE.transactionHash.toLowerCase()}:trench:${topicAddr(TRENCH_PURCHASE, 1)}`,
      trader: topicAddr(TRENCH_PURCHASE, 2),
      token: topicAddr(TRENCH_PURCHASE, 1)
    });
  });

  it("answers null for anything else and matches the key the stream's print would carry", () => {
    expect(curveTrader(userOpLog(SENDER))).toBeNull();
    expect(curveTradeKey({ tx: CURVE_BUY.transactionHash.toUpperCase(), pair: `pons:${CURVE_BUY.address}` })).toBe(curveTrader(CURVE_BUY)?.key);
  });
});

describe("userOpSenders", () => {
  it("collects distinct topics[2] senders from EntryPoint UserOperationEvent logs only", () => {
    const other = "0x2222222222222222222222222222222222222222";
    expect(isUserOpLog(userOpLog(SENDER))).toBe(true);
    expect(isUserOpLog(CURVE_BUY)).toBe(false);
    expect(userOpSenders([userOpLog(SENDER), userOpLog(SENDER, "0xb"), userOpLog(other), CURVE_BUY])).toEqual([SENDER, other]);
    expect(USER_OP_LEG).toEqual({ addresses: [ENTRY_POINT], topics: [[USER_OPERATION_EVENT_TOPIC]] });
  });
});

describe("withTraderHooks", () => {
  function harness(delay?: Promise<void>) {
    const poller = new FakePoller();
    const ingested: FlowPrint[][] = [];
    const traders = new FakeTraders();
    if (delay) traders.delay = delay;
    const log = vi.fn();
    const hooked = withTraderHooks({ poller, ledger: { ingest: (prints) => ingested.push(prints) }, traders, tokenOf: (pair) => (pair.startsWith("pons:") ? "0xtoken" : null), log });
    return { poller, ingested, traders, hooked, log };
  }

  it("appends the user-op leg, routes senders to discover and hides user-op logs from the stream", () => {
    const h = harness();
    h.hooked.poller.setExtraLegs([{ addresses: ["0xpad"], topics: [["0xtopic"]] }]);
    expect(h.poller.legs).toEqual([{ addresses: ["0xpad"], topics: [["0xtopic"]] }, USER_OP_LEG]);
    const received: RawLog[][] = [];
    h.hooked.poller.start((logs) => received.push(logs));
    h.poller.handler?.([userOpLog(SENDER), CURVE_BUY], 10);
    expect(h.traders.discovered).toEqual([[SENDER]]);
    expect(received).toEqual([[CURVE_BUY]]);
    h.poller.handler?.([userOpLog(SENDER)], 11);
    expect(received).toHaveLength(1);
    h.hooked.poller.stop();
    expect(h.poller.stopped).toBe(1);
    expect(h.hooked.poller.stats().cursor).toBe(1);
  });

  it("annotates a curve print with the wallet its log named, ingests the annotated batch and records it", async () => {
    const h = harness();
    h.hooked.poller.start(() => undefined);
    h.poller.handler?.([CURVE_BUY], 10);
    const print: FlowPrint = { chain: "robinhood", pair: `pons:${CURVE_BUY.address.toLowerCase()}`, tx: CURVE_BUY.transactionHash, time: NOW, side: "buy", usd: 12, source: "own" };
    await h.hooked.ledger.ingest([print]);
    expect(h.ingested).toHaveLength(1);
    expect(h.ingested[0][0].trader?.address).toBe(topicAddr(CURVE_BUY, 2));
    const meta = h.traders.annotateCalls[0].ctx.meta(print);
    expect(meta).toEqual({ token: "0xtoken", dex: "pons", trader: topicAddr(CURVE_BUY, 2) });
    expect(h.traders.recordCalls[0].prints).toBe(h.ingested[0]);
  });

  it("marks an unnamed curve print unattributable rather than guessing, and skips prints whose token is unknown", async () => {
    const h = harness();
    h.hooked.poller.start(() => undefined);
    const named: FlowPrint = { chain: "robinhood", pair: "pons:0xnobody", tx: "0xunseen", time: NOW, side: "sell", usd: null, source: "own" };
    const unknown: FlowPrint = { ...named, pair: "bags:0xamm", tx: "0xbags" };
    await h.hooked.ledger.ingest([named, unknown]);
    const meta = h.traders.annotateCalls[0].ctx.meta;
    expect(meta(named)).toEqual({ token: "0xtoken", dex: "pons", trader: null });
    expect(meta(unknown)).toBeNull();
    expect(h.ingested[0]).toEqual([named, unknown]);
  });

  it("keeps ingestion order across batches while annotation is in flight", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness(gate);
    const first: FlowPrint = { chain: "robinhood", pair: "pons:0xa", tx: "0x1", time: NOW, side: "buy", usd: 1, source: "own" };
    const second: FlowPrint = { ...first, tx: "0x2" };
    void h.hooked.ledger.ingest([first]);
    void h.hooked.ledger.ingest([second]);
    await flush();
    expect(h.ingested).toEqual([]);
    release();
    await flush();
    await flush();
    expect(h.ingested.map((batch) => batch[0].tx)).toEqual(["0x1", "0x2"]);
  });

  it("ingests unannotated and logs when the service throws", async () => {
    const h = harness();
    h.traders.annotate = () => Promise.reject(new Error("boom"));
    const print: FlowPrint = { chain: "robinhood", pair: "pons:0xa", tx: "0x1", time: NOW, side: "buy", usd: 1, source: "own" };
    await h.hooked.ledger.ingest([print]);
    expect(h.ingested).toEqual([[print]]);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
