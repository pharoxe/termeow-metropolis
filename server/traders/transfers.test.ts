import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { RobinhoodLogPoller, type ExtraLeg, type RawLog } from "../tape/robinhood/poller.js";
import { TRANSFER_TOPIC, ZERO_ADDRESS } from "./attribute.js";
import { ENTRY_POINT } from "./service.js";
import {
  FOMO_FUNDING,
  FOMO_HUB,
  FOMO_SINK,
  QUOTE_TOKENS,
  TRANSFER_CHUNK,
  TRANSFER_MAX_CHUNKS,
  buildTransferLegs,
  decodeTransferFills,
  decodeTxTransfers,
  fomoPair,
  isTransferLog,
  padTopic,
  transferFillKey,
  type DecodeContext,
  type TransferLogLike
} from "./transfers.js";

type FixtureTx = { blockNumber: string; to: string; from: string; logs: TransferLogLike[] };
type Fixture = { ethUsdAtCapture: number; txs: Record<string, FixtureTx> };
type TapeRow = { id: number; tx: string; side: "buy" | "sell"; usd: number; amount: number; priced: string; quote_token: string | null; wallet: string; token: string; symbol: string };

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/r4/${name}.json`, import.meta.url), "utf8")) as T;
}

const LOGS = fixture<Fixture>("transfer-logs");
const TAPE = fixture<TapeRow[]>("trenches-tape");
const TRADERS = fixture<Array<{ address: string }>>("trenches-traders");
const META = fixture<{ tokenMeta: Array<{ token: string; decimals: number }> }>("getlogs-cost").tokenMeta;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const POPULATION = new Set(TRADERS.map((row) => row.address.toLowerCase()));
const DECIMALS = new Map(META.map((row) => [row.token.toLowerCase(), row.decimals]));

function ctx(overrides: Partial<DecodeContext> = {}): DecodeContext {
  return {
    population: POPULATION,
    quotePrice: (quote) => (quote === USDG ? 1 : quote === WETH ? LOGS.ethUsdAtCapture : null),
    decimalsOf: (token) => DECIMALS.get(token) ?? null,
    ...overrides
  };
}

function within(a: number, b: number, fraction: number): boolean {
  return Math.abs(a - b) / Math.abs(b) <= fraction;
}

describe("decodeTxTransfers against the robinhoodtrenches tape (25 receipts, 40 tape rows, 2026-09-06 capture)", () => {
  const rows = TAPE.filter((row) => row.tx.toLowerCase() in LOGS.txs);
  const decoded = new Map(Object.entries(LOGS.txs).map(([tx, entry]) => [tx, decodeTxTransfers(tx, entry.logs, ctx())]));

  it("covers 40 tape rows with a fill per row", () => {
    expect(rows).toHaveLength(40);
  });

  it("matches side, token and wallet on 40/40 rows and the token amount on every row with known decimals (measured)", () => {
    let sideToken = 0;
    let amounts = 0;
    for (const row of rows) {
      const fill = decoded.get(row.tx.toLowerCase())?.fills.find((candidate) => candidate.wallet === row.wallet.toLowerCase() && candidate.token === row.token.toLowerCase());
      if (fill?.side === row.side) sideToken += 1;
      if (fill?.units !== null && fill?.units !== undefined && within(fill.units, row.amount, 0.001)) amounts += 1;
    }
    expect(sideToken).toBe(40);
    expect(amounts).toBe(40);
  });

  it("prices 16/17 cash_leg rows within 5% of the tape (14 USDG exact via hub legs, 2 WETH via the wallet segment's hub leg); the 17th is a tape artifact", () => {
    const priced = rows.filter((row) => row.priced === "cash_leg");
    expect(priced).toHaveLength(17);
    const off: TapeRow[] = [];
    let ok = 0;
    for (const row of priced) {
      const fill = decoded.get(row.tx.toLowerCase())?.fills.find((candidate) => candidate.wallet === row.wallet.toLowerCase() && candidate.token === row.token.toLowerCase());
      if (fill?.usd !== null && fill?.usd !== undefined && within(fill.usd, row.usd, 0.05)) ok += 1;
      else off.push(row);
    }
    expect(ok).toBe(16);
    // GOOGL row 58097 (tx 0xba36f286, 4 bundled senders): the tape used a WETH leg from another sender's segment
    // (0.0109 WETH ~ $27); in the wallet's own segment the pool paid 141.797643 USDG hub -> sink for 0.418 GOOGL.
    expect(off.map((row) => row.id)).toEqual([58097]);
    const googl = decoded.get(off[0].tx.toLowerCase())?.fills.find((candidate) => candidate.token === off[0].token.toLowerCase());
    expect(googl).toMatchObject({ side: "sell", usd: 141.797643, usdVia: "hub_leg", quote: USDG });
  });

  it("leaves every no_cash_leg row (Multicall3 distributions, direct-EOA sell) unpriced instead of mark-pricing it", () => {
    const unpriced = rows.filter((row) => row.priced === "no_cash_leg");
    expect(unpriced).toHaveLength(23);
    for (const row of unpriced) {
      const fill = decoded.get(row.tx.toLowerCase())?.fills.find((candidate) => candidate.wallet === row.wallet.toLowerCase() && candidate.token === row.token.toLowerCase());
      expect(fill?.usd).toBeNull();
      expect(fill?.price).toBeNull();
    }
  });

  it("derives price = usd / units only when both are known", () => {
    const row = rows.find((candidate) => candidate.id === 58111) as TapeRow;
    const fill = decoded.get(row.tx.toLowerCase())?.fills.find((candidate) => candidate.token === row.token.toLowerCase());
    expect(fill?.usd).toBe(1987.05953);
    expect(fill?.price).toBeCloseTo(1987.05953 / 5151565.591056616, 12);
    const blind = decodeTxTransfers(row.tx, LOGS.txs[row.tx.toLowerCase()].logs, ctx({ decimalsOf: () => null })).fills[0];
    expect(blind).toMatchObject({ usd: 1987.05953, units: null, price: null });
  });

  it("finds the one fill the tape missed (unipcs also received 219.75 of 0x0a83fe17 in bundle 0x643b8ad8) and nothing else off-tape", () => {
    const tapeKeys = new Set(TAPE.map((row) => `${row.tx.toLowerCase()}|${row.wallet.toLowerCase()}|${row.token.toLowerCase()}`));
    const extra = [...decoded.values()].flatMap((result) => result.fills).filter((fill) => !tapeKeys.has(`${fill.tx}|${fill.wallet}|${fill.token}`));
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatchObject({ tx: expect.stringMatching(/^0x643b8ad8/), token: expect.stringMatching(/^0x0a83fe17/), side: "buy", usd: null });
  });

  it("reads the block from the logs", () => {
    const tx = "0xb11a60d2032b0c5e6af9969ef0e4796a4771c4731d0a2499ce7a29f65f796027";
    const withBlock = LOGS.txs[tx].logs.map((log) => ({ ...log, blockNumber: LOGS.txs[tx].blockNumber }));
    const [fill] = decodeTxTransfers(tx, withBlock, ctx()).fills;
    expect(fill).toMatchObject({ block: 56168785, tx });
    expect(transferFillKey("robinhood", fill)).toBe(`robinhood|${tx}|${fill.wallet}|${fill.token}|buy`);
  });
});

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
      [log(USDG, WALLET, OTHER, 2_000_000n, 0), log(TOKEN, OTHER, WALLET, 10n ** 18n, 1), log(TOKEN, OTHER, WALLET, 10n ** 18n, 2), log(TOKEN, WALLET, OTHER, 3n * 10n ** 18n, 0, "0xdef")],
      small
    );
    expect(result.fills).toHaveLength(2);
    expect(result.fills[0]).toMatchObject({ tx: "0xabc", side: "buy", units: 2, quote: USDG, usd: 2, usdVia: "wallet_leg", price: 1 });
    expect(result.fills[1]).toMatchObject({ tx: "0xdef", side: "sell", usd: null, price: null, quote: null });
  });

  it("does not attach a cash leg when the segment holds two token legs or two cash legs on that side", () => {
    const twoTokens = decodeTransferFills([log(USDG, FOMO_FUNDING, FOMO_HUB, 1_000_000n, 0), log(TOKEN, FOMO_HUB, WALLET, 1n, 1), log(OTHER, FOMO_HUB, WALLET, 1n, 2)], small);
    expect(twoTokens.fills.map((fill) => fill.usd)).toEqual([null, null]);
    expect(twoTokens.skipped.unpaired).toBe(2);
    const twoCash = decodeTransferFills([log(USDG, FOMO_HUB, FOMO_SINK, 1_000_000n, 0), log(USDG, FOMO_HUB, FOMO_SINK, 1_000_000n, 1), log(TOKEN, WALLET, FOMO_HUB, 1n, 2)], small);
    expect(twoCash.fills[0].usd).toBeNull();
    expect(twoCash.skipped.unpaired).toBe(1);
  });

  it("lends the hub USDG leg only to a hub-custodied token leg of the segment's single tracked wallet", () => {
    const pool = "0x9999999999999999999999999999999999999999";
    // Sell straight to a pool (ETH/WETH-funded shape): the HUB -> SINK USDG in the same segment is not this fill's cash.
    const direct = decodeTransferFills([log(USDG, FOMO_HUB, FOMO_SINK, 5_000_000n, 0), log(TOKEN, WALLET, pool, 10n ** 18n, 1)], ctx({ population: new Set([WALLET]), decimalsOf: () => 18 }));
    expect(direct.fills[0]).toMatchObject({ side: "sell", usd: null, usdVia: null, price: null });
    expect(direct.skipped.unpaired).toBe(1);
    // Hub-custodied sell: priced via the hub leg and labelled so.
    const custodied = decodeTransferFills([log(USDG, FOMO_HUB, FOMO_SINK, 5_000_000n, 0), log(TOKEN, WALLET, FOMO_HUB, 10n ** 18n, 1)], ctx({ population: new Set([WALLET]), decimalsOf: () => 18 }));
    expect(custodied.fills[0]).toMatchObject({ side: "sell", usd: 5, usdVia: "hub_leg", price: 5 });
    // Two tracked wallets in one segment cannot both claim the single FUNDING -> HUB leg.
    const shared = decodeTransferFills([log(USDG, FOMO_FUNDING, FOMO_HUB, 5_000_000n, 0), log(TOKEN, FOMO_HUB, WALLET, 1n, 1), log(OTHER, FOMO_HUB, PEER, 1n, 2)], small);
    expect(shared.fills.map((fill) => fill.usd)).toEqual([null, null]);
    expect(shared.skipped.unpaired).toBe(2);
  });

  it("keeps a quote known but usd null when the quote has no price, and treats an unknown-decimals cash token as unpriced", () => {
    const result = decodeTransferFills([log(WETH, WALLET, OTHER, 10n ** 17n, 0), log(TOKEN, OTHER, WALLET, 1n, 1)], ctx({ population: new Set([WALLET]), quotePrice: () => null }));
    expect(result.fills[0]).toMatchObject({ quote: WETH, usd: null, usdVia: "wallet_leg" });
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
    const result = decodeTransferFills([log(TOKEN, OTHER, WALLET, 1n, 0), uoe(PEER, 1), log(TOKEN, FOMO_HUB, WALLET, 2n, 2), uoe(WALLET, 3)], small);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]).toMatchObject({ units: 2e-18, usdVia: null });
    expect(result.skipped.foreignSegment).toBe(1);
  });
});

describe("buildTransferLegs", () => {
  it("emits a to-leg and a from-leg per chunk of 150, lowercased and padded, capped at 4 chunks with the overflow counted", () => {
    const wallets = Array.from({ length: 700 }, (_, i) => `0xA${(i + 1).toString(16).padStart(39, "0")}`);
    const built = buildTransferLegs(wallets);
    expect(built).toMatchObject({ wallets: TRANSFER_CHUNK * TRANSFER_MAX_CHUNKS, overflow: 100 });
    expect(built.legs).toHaveLength(8);
    expect(built.legs[0]).toEqual({ addresses: [], topics: [[TRANSFER_TOPIC], null, expect.any(Array)] });
    expect(built.legs[1]).toEqual({ addresses: [], topics: [[TRANSFER_TOPIC], expect.any(Array)] });
    expect((built.legs[0].topics[2] as string[])[0]).toBe(padTopic(wallets[0]));
    expect(built.legs[0].topics[2]).toHaveLength(150);
    expect(built.legs[7].topics[1]).toHaveLength(150);
  });

  it("dedupes case variants and yields no legs for an empty population", () => {
    expect(buildTransferLegs([WALLET, WALLET.toUpperCase()]).legs[0].topics[2]).toHaveLength(1);
    expect(buildTransferLegs([])).toEqual({ legs: [], wallets: 0, overflow: 0 });
    expect(fomoPair(TOKEN.toUpperCase())).toBe(`fomo:${TOKEN}`);
    expect([...QUOTE_TOKENS.keys()]).toEqual([USDG, WETH]);
  });
});

describe("RobinhoodLogPoller carries address-less legs in its one batch per tick", () => {
  it("sends the transfer legs without an address filter alongside the poller's own legs and delivers matching logs", async () => {
    vi.useFakeTimers();
    const bodies: unknown[] = [];
    const walletLog = log(TOKEN, FOMO_HUB, WALLET, 5n, 3, "0xfeed");
    const foreign = log(TOKEN, FOMO_HUB, OTHER, 5n, 4, "0xfeed");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Array<{ id: number; method: string }> | { id: number; method: string };
      bodies.push(body);
      if (!Array.isArray(body)) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "eth_blockNumber" ? "0x64" : [] }));
      return new Response(JSON.stringify(body.map((req, i) => ({ jsonrpc: "2.0", id: req.id, result: req.method === "eth_blockNumber" ? "0x65" : i === 2 ? [walletLog, foreign] : [] }))));
    });
    const poller = new RobinhoodLogPoller({ rpcUrl: "https://rpc.test", fetchImpl: fetchImpl as unknown as typeof fetch, log: vi.fn() });
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
