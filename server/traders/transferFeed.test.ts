import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TraderKind } from "../../shared/wire.js";
import type { ExtraLeg, LogsHandler, PollerStats, RawLog } from "../tape/robinhood/poller.js";
import { TRANSFER_TOPIC } from "./attribute.js";
import type { TraderFill } from "./book.js";
import type { Erc20MetaEntry } from "./erc20Meta.js";
import type { HandleEntry } from "./handles.js";
import { LEGS_CHECK_MS, MAX_QUEUED_BATCHES, TransferFeed, type TransferFeedTraders } from "./transferFeed.js";
import { padTopic, type TransferLogLike } from "./transfers.js";

type FixtureTx = { blockNumber: string; logs: TransferLogLike[] };
const FIXTURE = JSON.parse(readFileSync(new URL("./__fixtures__/r4/transfer-logs.json", import.meta.url), "utf8")) as { txs: Record<string, FixtureTx> };

const NOW = 1_800_000_000_000;
const BLOCK_TIME = 1_788_716_978_000;
/** Relay-B USDG buy from the capture: remusofmars bought 5,151,565.59 QC for 1,987.05953 USDG (tape row 58111). */
const TX = "0xb11a60d2032b0c5e6af9969ef0e4796a4771c4731d0a2499ce7a29f65f796027";
const WALLET = "0x8ab8c0843d9738885d6273dfe3de86c56eea364c";
const QC = "0xf2e122a481b440c40eee7a7ca6d5eef65a591b76";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const OTHER_WALLET = "0x0a6ebed0155edb4b21d92ad02897a626cd90119e";

function walletLogs(tx: string, wallet: string): RawLog[] {
  const entry = FIXTURE.txs[tx];
  return entry.logs
    .filter((log) => log.topics[0] === TRANSFER_TOPIC && (log.topics[1] === padTopic(wallet) || log.topics[2] === padTopic(wallet)))
    .map((log) => ({ ...log, logIndex: log.logIndex ?? "0x0", blockNumber: entry.blockNumber, blockHash: "0x0", transactionHash: tx, transactionIndex: "0x0" }));
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

class FakeTraders implements TransferFeedTraders {
  wallets: string[] = [WALLET];
  version = 1;
  kinds: Record<string, TraderKind> = { [WALLET]: "fomo" };
  receiptFor: (tx: string) => Promise<{ logs: TransferLogLike[] } | null> = async (tx) => FIXTURE.txs[tx] ?? null;
  meta: Record<string, Erc20MetaEntry> = { [QC]: { decimals: 18, symbol: "QC", resolvedAt: NOW } };
  resolved: string[] = [];
  refreshed = 0;
  recorded: TraderFill[] = [];
  private keys = new Set<string>();
  receipts = { get: (tx: string) => this.receiptFor(tx) };
  handles = {
    get: (address: string): HandleEntry | null => (address === WALLET ? { handle: "remusofmars", followers: 143043, profileUrl: null, source: "traders" } : null),
    refresh: async () => {
      this.refreshed += 1;
    }
  };
  erc20Meta = {
    get: (token: string) => this.meta[token] ?? null,
    resolve: async (token: string) => {
      this.resolved.push(token);
      return this.meta[token] ?? null;
    }
  };
  transferWallets(): string[] {
    return this.wallets;
  }
  populationVersion(): number {
    return this.version;
  }
  peekKind(wallet: string): TraderKind | null {
    return this.kinds[wallet] ?? null;
  }
  recordTransferFills(fills: TraderFill[]): { accepted: number; duplicates: number; rejected: number } {
    const result = { accepted: 0, duplicates: 0, rejected: 0 };
    for (const fill of fills) {
      const key = `${fill.tx}:${fill.trader}:${fill.token}:${fill.side}`;
      if (this.keys.has(key)) result.duplicates += 1;
      else {
        this.keys.add(key);
        this.recorded.push(fill);
        result.accepted += 1;
      }
    }
    return result;
  }
}

function harness(overrides: { blockTime?: number | null } = {}) {
  const traders = new FakeTraders();
  const poller = new FakePoller();
  const blocks = { asked: [] as number[], timeMs: async (block: number) => (blocks.asked.push(block), overrides.blockTime === undefined ? BLOCK_TIME : overrides.blockTime), stats: () => ({ cached: 0, inFlight: 0, hits: 0, misses: 0, failures: 0, lastError: null }) };
  const prices = { primed: [] as string[][], prime: async (quotes: string[]) => void prices.primed.push(quotes), get: (quote: string) => (quote === USDG ? 1 : null), status: () => ({ cached: 0, lastOkAt: null, lastError: null }) };
  const log = vi.fn();
  const feed = new TransferFeed({ traders, blocks, prices, now: () => NOW, log });
  const wrapped = feed.wrapPoller(poller);
  return { traders, poller, blocks, prices, feed, wrapped, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TransferFeed poller wrapping", () => {
  it("appends the population's transfer legs to the stream's legs, rebuilds them when the population version moves, and refreshes the handle feeds once at start", async () => {
    vi.useFakeTimers();
    const h = harness();
    const base: ExtraLeg[] = [{ addresses: ["0xpad"], topics: [["0xaaaa"]] }];
    h.wrapped.setExtraLegs(base);
    expect(h.poller.legs).toHaveLength(3);
    expect(h.poller.legs[0]).toEqual(base[0]);
    expect(h.poller.legs[1].topics).toEqual([[TRANSFER_TOPIC], null, [padTopic(WALLET)]]);
    expect(h.poller.legs[2].topics).toEqual([[TRANSFER_TOPIC], [padTopic(WALLET)]]);
    h.wrapped.start(vi.fn());
    expect(h.traders.refreshed).toBe(1);
    h.traders.wallets = [WALLET, OTHER_WALLET];
    await vi.advanceTimersByTimeAsync(LEGS_CHECK_MS - 1);
    expect(h.poller.legs[1].topics[2]).toHaveLength(1);
    h.traders.version = 2;
    await vi.advanceTimersByTimeAsync(LEGS_CHECK_MS);
    expect(h.poller.legs[1].topics[2]).toHaveLength(2);
    expect(h.feed.stats()).toMatchObject({ legs: 2, wallets: 2, overflow: 0, populationVersion: 2 });
    h.wrapped.stop();
    expect(h.poller.stopped).toBe(1);
    await vi.advanceTimersByTimeAsync(LEGS_CHECK_MS * 3);
    expect(h.traders.refreshed).toBe(1);
  });

  it("diverts Transfer logs to the feed and passes everything else to the stream", async () => {
    const h = harness();
    const onLogs = vi.fn();
    h.wrapped.start(onLogs);
    const transfer = walletLogs(TX, WALLET)[0];
    const other: RawLog = { ...transfer, topics: ["0xbeef"], transactionHash: "0xother" };
    h.poller.handler?.([transfer, other], 100);
    expect(onLogs).toHaveBeenCalledWith([other], 100);
    await h.feed.handleLogs([], 100);
    expect(h.feed.stats().logsSeen).toBe(1);
  });
});

describe("TransferFeed batch processing", () => {
  it("decodes a wallet's fill from the full receipt: pair fomo:<token>, usd from the hub leg, price, handle, kind, block time", async () => {
    const h = harness();
    await h.feed.handleLogs(walletLogs(TX, WALLET), 56_168_800);
    expect(h.traders.recorded).toHaveLength(1);
    expect(h.traders.recorded[0]).toMatchObject({
      chain: "robinhood",
      pair: `fomo:${QC}`,
      tx: TX,
      time: BLOCK_TIME,
      side: "buy",
      usd: 1987.05953,
      source: "own",
      trader: WALLET,
      token: QC,
      handle: "remusofmars",
      followers: 143043,
      kind: "fomo",
      usdVia: "hub_leg"
    });
    expect(h.traders.recorded[0].price).toBeCloseTo(1987.05953 / 5151565.591056616, 12);
    expect(h.blocks.asked).toEqual([56_168_785]);
    expect(h.traders.resolved).toEqual([QC]);
    expect(h.prices.primed).toEqual([[USDG]]);
    expect(h.feed.stats()).toMatchObject({ batches: 1, logsSeen: 1, fills: 1, duplicates: 0, unpriced: 0, untimed: 0, receiptsMissing: 0, lastOkAt: NOW, lastError: null });
    await h.feed.handleLogs(walletLogs(TX, WALLET), 56_168_800);
    expect(h.traders.recorded).toHaveLength(1);
    expect(h.feed.stats().duplicates).toBe(1);
    expect(h.traders.receipts).toBeDefined();
  });

  it("falls back to the batch view (usd null) when the receipt is unavailable and counts it", async () => {
    const h = harness();
    h.traders.receiptFor = async () => null;
    await h.feed.handleLogs(walletLogs(TX, WALLET), 56_168_800);
    expect(h.traders.recorded).toHaveLength(1);
    expect(h.traders.recorded[0]).toMatchObject({ side: "buy", usd: null, price: null, token: QC });
    expect("usdVia" in h.traders.recorded[0]).toBe(false);
    expect(h.feed.stats()).toMatchObject({ fills: 1, unpriced: 1, receiptsMissing: 1 });
  });

  it("drops a fill whose block time cannot be read instead of estimating it", async () => {
    const h = harness({ blockTime: null });
    await h.feed.handleLogs(walletLogs(TX, WALLET), 56_168_800);
    expect(h.traders.recorded).toEqual([]);
    expect(h.feed.stats()).toMatchObject({ fills: 0, untimed: 1 });
  });

  it("records a seeded wallet's fill with kind null (never labelled FOMO before its check) and ignores logs of untracked wallets", async () => {
    const h = harness();
    h.traders.kinds = {};
    await h.feed.handleLogs(walletLogs(TX, WALLET), 56_168_800);
    expect(h.traders.recorded[0].kind).toBeNull();
    h.traders.wallets = [];
    h.traders.recorded = [];
    await h.feed.handleLogs(walletLogs(TX, WALLET), 56_168_800);
    expect(h.traders.recorded).toEqual([]);
  });

  it("keeps a failing batch in lastError and processes the next one", async () => {
    const h = harness();
    h.traders.receiptFor = async () => {
      throw new Error("boom");
    };
    await h.feed.handleLogs(walletLogs(TX, WALLET), 56_168_800);
    expect(h.feed.stats()).toMatchObject({ receiptsMissing: 1, fills: 1 });
    const broken = { ...h.traders, transferWallets: () => (() => { throw new Error("population exploded"); })() } as unknown as TransferFeedTraders;
    const feed = new TransferFeed({ traders: broken, blocks: h.blocks, prices: h.prices, now: () => NOW, log: h.log });
    await feed.handleLogs(walletLogs(TX, WALLET), 56_168_800);
    expect(feed.stats().lastError).toBe("batch: population exploded");
    expect(h.log).toHaveBeenCalledWith("transfer feed: batch: population exploded");
  });

  it("drops batches past the queue cap while a lookup stalls, counting them", async () => {
    const h = harness();
    h.traders.receiptFor = () => new Promise(() => undefined);
    for (let i = 0; i < MAX_QUEUED_BATCHES + 3; i += 1) void h.feed.handleLogs(walletLogs(TX, WALLET), 56_168_800);
    expect(h.feed.stats()).toMatchObject({ queued: MAX_QUEUED_BATCHES, batchesDropped: 3 });
  });
});
