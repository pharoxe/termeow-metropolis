import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { QUOTES } from "../launch/monad/pads.js";
import { MonadLogPoller, type ExtraLeg, type RawLog } from "../tape/monad/poller.js";
import { TRANSFER_TOPIC, ZERO_ADDRESS } from "./attribute.js";
import { ENTRY_POINT } from "./service.js";
import {
  CUSTODY_HUB,
  QUOTE_TOKENS,
  TRANSFER_CHUNK,
  TRANSFER_MAX_CHUNKS,
  TRANSFER_WATCH_CAP,
  buildTransferLegs,
  decodeTransferFills,
  decodeTxTransfers,
  smartPair,
  isTransferLog,
  padTopic,
  transferFillKey,
  type DecodeContext
} from "./transfers.js";

/** 801 real EVM addresses harvested for the r5 topic-list probes. */
const REAL_WALLETS = JSON.parse(readFileSync(new URL("./__fixtures__/r5/wallets-real.json", import.meta.url), "utf8")) as string[];
const USDC = QUOTES.usdc;
const WMON = QUOTES.wmon;
const MON_USD = 3.5;

function ctx(overrides: Partial<DecodeContext> = {}): DecodeContext {
  return {
    population: new Set<string>(),
    quotePrice: (quote) => (quote === USDC ? 1 : quote === WMON ? MON_USD : null),
    decimalsOf: () => null,
    ...overrides
  };
}

function log(token: string, from: string, to: string, amount: bigint, logIndex: number, tx = "0xabc"): RawLog {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, padTopic(from), padTopic(to)],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
    blockNumber: "0x10",
    blockHash: "0x0",
    transactionHash: tx,
    transactionIndex: "0x0",
    logIndex: `0x${logIndex.toString(16)}`
  };
}

const WALLET = "0x1111111111111111111111111111111111111111";
const PEER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const OTHER = "0x4444444444444444444444444444444444444444";
const ROUTER = "0x5555555555555555555555555555555555555555";
const SINK = "0x6666666666666666666666666666666666666666";

describe("decodeTransferFills synthetic rules", () => {
  const small = ctx({ population: new Set([WALLET, PEER]), decimalsOf: () => 18 });

  it("a token moving between two tracked wallets (or minted/burned) with no cash leg is a transfer, counted once per tracked side and skipped", () => {
    const result = decodeTransferFills([log(TOKEN, WALLET, PEER, 5n, 0), log(TOKEN, ZERO_ADDRESS, WALLET, 7n, 1)], small);
    expect(result.fills).toEqual([]);
    // wallet -> peer counts for the sender (sell leg) and the receiver (buy leg); the mint counts once.
    expect(result.skipped).toEqual({ transfers: 3, foreignSegment: 0, unpaired: 0 });
  });

  it("uses the wallet's own quote leg first, merges split token legs and groups by tx", () => {
    const result = decodeTransferFills(
      [log(USDC, WALLET, OTHER, 2_000_000n, 0), log(TOKEN, OTHER, WALLET, 10n ** 18n, 1), log(TOKEN, OTHER, WALLET, 10n ** 18n, 2), log(TOKEN, WALLET, OTHER, 3n * 10n ** 18n, 0, "0xdef")],
      small
    );
    expect(result.fills).toHaveLength(2);
    expect(result.fills[0]).toMatchObject({ tx: "0xabc", side: "buy", units: 2, quote: USDC, usd: 2, usdVia: "wallet_leg", price: 1 });
    expect(result.fills[1]).toMatchObject({ tx: "0xdef", side: "sell", usd: null, price: null, quote: null });
  });

  it("does not attach a cash leg when the segment holds two token legs or two cash legs on that side", () => {
    const twoTokens = decodeTransferFills([log(USDC, WALLET, ROUTER, 1_000_000n, 0), log(TOKEN, ROUTER, WALLET, 1n, 1), log(OTHER, ROUTER, WALLET, 1n, 2)], small);
    expect(twoTokens.fills.map((fill) => fill.usd)).toEqual([null, null]);
    expect(twoTokens.skipped.unpaired).toBe(2);
    const twoCash = decodeTransferFills([log(USDC, ROUTER, WALLET, 1_000_000n, 0), log(USDC, ROUTER, WALLET, 1_000_000n, 1), log(TOKEN, WALLET, ROUTER, 1n, 2)], small);
    expect(twoCash.fills[0].usd).toBeNull();
    expect(twoCash.skipped.unpaired).toBe(1);
  });

  it("has no custody hub on Monad, so a third party's stable legs never price a wallet's fill", () => {
    expect(CUSTODY_HUB).toBeNull();
    const result = decodeTransferFills([log(USDC, ROUTER, SINK, 5_000_000n, 0), log(TOKEN, WALLET, ROUTER, 10n ** 18n, 1)], ctx({ population: new Set([WALLET]), decimalsOf: () => 18 }));
    expect(result.fills[0]).toMatchObject({ side: "sell", usd: null, usdVia: null, price: null });
    expect(result.skipped.unpaired).toBe(0);
  });

  it("prices a sell from the wallet's own WMON proceeds", () => {
    const result = decodeTxTransfers("0xAB", [{ ...log(TOKEN, WALLET, ROUTER, 2n * 10n ** 18n, 0), blockNumber: "0x2a" }, log(WMON, ROUTER, WALLET, 10n ** 18n, 1)], ctx({ population: new Set([WALLET]), decimalsOf: () => 18 }));
    expect(result.fills[0]).toMatchObject({ tx: "0xab", block: 42, side: "sell", quote: WMON, usd: MON_USD, usdVia: "wallet_leg", price: MON_USD / 2 });
    expect(transferFillKey("monad", result.fills[0])).toBe(`monad|0xab|${WALLET}|${TOKEN}|sell`);
  });

  it("keeps a quote known but usd null when the quote has no price, and treats an unknown-decimals cash token as unpriced", () => {
    const result = decodeTransferFills([log(WMON, WALLET, OTHER, 10n ** 17n, 0), log(TOKEN, OTHER, WALLET, 1n, 1)], ctx({ population: new Set([WALLET]), quotePrice: () => null }));
    expect(result.fills[0]).toMatchObject({ quote: WMON, usd: null, usdVia: "wallet_leg" });
  });

  it("ignores ERC-721 Transfers, self-transfers and malformed words", () => {
    const nft = { ...log(TOKEN, OTHER, WALLET, 1n, 0), topics: [TRANSFER_TOPIC, padTopic(OTHER), padTopic(WALLET), padTopic(OTHER)], data: "0x" };
    expect(isTransferLog(nft)).toBe(false);
    const result = decodeTransferFills([nft, log(TOKEN, WALLET, WALLET, 1n, 1), { ...log(TOKEN, OTHER, WALLET, 1n, 2), data: "0x12" }], small);
    expect(result.fills).toEqual([]);
  });

  it("attributes token legs only inside the wallet's own user-op segment", () => {
    const uoe = (sender: string, logIndex: number): RawLog => ({
      ...log(TOKEN, OTHER, WALLET, 0n, logIndex),
      address: ENTRY_POINT,
      topics: ["0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f", padTopic("0x" + "ab".repeat(20)), padTopic(sender), padTopic(ZERO_ADDRESS)],
      data: "0x"
    });
    const result = decodeTransferFills([log(TOKEN, OTHER, WALLET, 1n, 0), uoe(PEER, 1), log(TOKEN, ROUTER, WALLET, 2n, 2), uoe(WALLET, 3)], small);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]).toMatchObject({ units: 2e-18, usdVia: null });
    expect(result.skipped.foreignSegment).toBe(1);
  });
});

describe("buildTransferLegs", () => {
  it("carries the 801 real r5 wallets in 2 chunks x 2 directions = 4 legs, lowercased and padded, no overflow", () => {
    expect(REAL_WALLETS).toHaveLength(801);
    const built = buildTransferLegs(REAL_WALLETS);
    expect(built).toMatchObject({ wallets: 801, overflow: 0 });
    expect(built.legs).toHaveLength(4);
    expect(built.legs[0]).toEqual({ addresses: [], topics: [[TRANSFER_TOPIC], null, expect.any(Array)] });
    expect(built.legs[1]).toEqual({ addresses: [], topics: [[TRANSFER_TOPIC], expect.any(Array)] });
    expect((built.legs[0].topics[2] as string[])[0]).toBe(padTopic(REAL_WALLETS[0]));
    expect(built.legs[0].topics[2]).toHaveLength(TRANSFER_CHUNK);
    expect(built.legs[2].topics[2]).toHaveLength(301);
    expect(built.legs[3].topics[1]).toHaveLength(301);
    // Every leg stays under the measured single-leg envelope (1,000 addresses, 69 kB).
    for (const leg of built.legs) expect(JSON.stringify(leg).length).toBeLessThan(69_198);
  });

  it("keeps the first TRANSFER_WATCH_CAP wallets in caller order and counts the rest as overflow (priority is the caller's job)", () => {
    const synthetic = Array.from({ length: 1_600 - REAL_WALLETS.length }, (_, i) => `0xA${(i + 1).toString(16).padStart(39, "0")}`);
    const wallets = [...REAL_WALLETS, ...synthetic];
    const built = buildTransferLegs(wallets);
    expect(built).toMatchObject({ wallets: TRANSFER_WATCH_CAP, overflow: 100 });
    expect(built.legs).toHaveLength(TRANSFER_MAX_CHUNKS * 2);
    const watched = built.legs.filter((_, i) => i % 2 === 0).flatMap((leg) => leg.topics[2] as string[]);
    expect(watched).toEqual(wallets.slice(0, TRANSFER_WATCH_CAP).map(padTopic));
    expect(built.legs[5].topics[1]).toHaveLength(TRANSFER_CHUNK);
    // Transfer legs alone stay ~207 kB, under the 296,744 B batch body measured OK (r5/rpc-batch-probe.json).
    expect(JSON.stringify(built.legs).length).toBeLessThan(220_000);
  });

  it("dedupes case variants and yields no legs for an empty population", () => {
    expect(buildTransferLegs([WALLET, WALLET.toUpperCase()]).legs[0].topics[2]).toHaveLength(1);
    expect(buildTransferLegs([])).toEqual({ legs: [], wallets: 0, overflow: 0 });
    expect(smartPair(TOKEN.toUpperCase())).toBe(`smart:${TOKEN}`);
    expect([...QUOTE_TOKENS.keys()].slice(0, 2)).toEqual([WMON, USDC]);
  });
});

describe("MonadLogPoller carries address-less legs in its one batch per tick", () => {
  it("sends the transfer legs without an address filter alongside the poller's own legs and delivers matching logs", async () => {
    vi.useFakeTimers();
    const bodies: unknown[] = [];
    const walletLog = log(TOKEN, ROUTER, WALLET, 5n, 3, "0xfeed");
    const foreign = log(TOKEN, ROUTER, OTHER, 5n, 4, "0xfeed");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Array<{ id: number; method: string }> | { id: number; method: string };
      bodies.push(body);
      if (!Array.isArray(body)) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "eth_blockNumber" ? "0x64" : [] }));
      return new Response(JSON.stringify(body.map((req, i) => ({ jsonrpc: "2.0", id: req.id, result: req.method === "eth_blockNumber" ? "0x65" : i === 2 ? [walletLog, foreign] : [] }))));
    });
    const poller = new MonadLogPoller({ rpcUrl: "https://rpc.test", fetchImpl: fetchImpl as unknown as typeof fetch, log: vi.fn() });
    const legs: ExtraLeg[] = [{ addresses: ["0xpad"], topics: [["0xaaaa"]] }, ...buildTransferLegs([WALLET]).legs];
    poller.setExtraLegs(legs);
    const delivered: RawLog[][] = [];
    poller.start((logs) => delivered.push(logs));
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(2_100);
    const batch = bodies.find((body) => Array.isArray(body)) as Array<{ method: string; params: Array<Record<string, unknown>> }>;
    expect(batch).toBeDefined();
    expect(batch.map((req) => req.method)).toEqual(["eth_blockNumber", "eth_getLogs", "eth_getLogs", "eth_getLogs"]);
    expect(batch[1].params[0]).toMatchObject({ address: ["0xpad"] });
    expect("address" in batch[2].params[0]).toBe(false);
    expect(batch[2].params[0].topics).toEqual([[TRANSFER_TOPIC], null, [padTopic(WALLET)]]);
    expect(batch[3].params[0].topics).toEqual([[TRANSFER_TOPIC], [padTopic(WALLET)]]);
    expect(delivered.flat().map((entry) => entry.logIndex)).toEqual(["0x3"]);
    expect(poller.stats().dropped).toBe(1);
    poller.stop();
    vi.useRealTimers();
  });
});
