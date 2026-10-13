import { describe, expect, it } from "vitest";
import type { FlowPrint, SmartFill, PairRow } from "../../shared/wire.js";
import { FlowLedger } from "./ledger.js";
import { smartFillKey, smartWindowsFromFills, ledgerSmartFills, mergeSmartFills } from "./smartFills.js";
import { smartPair } from "../traders/transfers.js";

const TOKEN = "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01";
const POOL = "0x00000000000000000000000000000000000000aa";
const POOL_B = "0x00000000000000000000000000000000000000bb";
const WALLET = "0x06de9c48b1e639ed5c13ec8fbd4080a38e39f2d1";
const NOW = 1_800_000_000_000;
const TRADER = { address: WALLET, kind: "smart" as const, handle: "AvgJoesCrypto", followers: 1200 };

function row(pairAddress: string, tier: PairRow["tier"]): PairRow {
  return {
    chain: "monad", dex: "uniswap", pairAddress, baseMint: TOKEN, quoteMint: null, liquidityUsd: 1000, volume24Usd: 5000,
    share24: 1, txns: { m5: null, h1: null, h6: null, h24: null }, tier, sources: ["dexscreener"]
  };
}

function print(pair: string, tx: string, time: number, side: FlowPrint["side"], usd: number | null, extra: Partial<FlowPrint> = {}): FlowPrint {
  return { chain: "monad", pair, tx, time, side, usd, source: "own", trader: TRADER, ...extra };
}

function fill(tx: string, time: number, side: SmartFill["side"], usd: number | null, extra: Partial<SmartFill> = {}): SmartFill {
  return { chain: "monad", token: TOKEN, pair: POOL, dex: "uniswap", tx, time, side, usd, trader: TRADER, ...extra };
}

describe("ledgerSmartFills", () => {
  it("reads Tier A pairs and the smart pseudo-pair, skips Tier B and unattributed prints, keeps price only when numeric", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    ledger.ingest([
      print(POOL, "a", NOW - 1000, "buy", 10, { price: 0.25 }),
      print(POOL_B, "b", NOW - 2000, "sell", 5),
      print(smartPair(TOKEN), "c", NOW - 3000, "buy", null, { price: null }),
      { ...print(POOL, "d", NOW - 4000, "buy", 7), trader: undefined }
    ]);
    const fills = ledgerSmartFills(ledger, "monad", TOKEN, [row(POOL, "A"), row(POOL_B, "B")], (pair) => (pair === POOL ? "uniswap" : ""));
    expect(fills.map((f) => f.tx)).toEqual(["a", "c"]);
    expect(fills[0]).toMatchObject({ dex: "uniswap", price: 0.25, token: TOKEN, trader: TRADER });
    expect(fills[1].dex).toBe("");
    expect("price" in fills[1]).toBe(false);
  });
});

describe("mergeSmartFills", () => {
  it("keeps one row per tx+wallet with the earlier list winning, sorted newest first", () => {
    const book = [fill("x", NOW - 1000, "buy", 10, { symbol: "FAT" }), fill("y", NOW - 5000, "sell", 3)];
    const ledger = [fill("X", NOW - 1000, "buy", 10, { pair: smartPair(TOKEN) }), fill("z", NOW - 2000, "buy", null)];
    const merged = mergeSmartFills(book, ledger);
    expect(merged.map((f) => f.tx)).toEqual(["x", "z", "y"]);
    expect(merged[0].symbol).toBe("FAT");
    expect(merged[0].pair).toBe(POOL);
  });

  it("keeps a wallet's buy and sell of the token inside one tx as two fills", () => {
    const merged = mergeSmartFills([fill("x", NOW, "buy", 10)], [fill("x", NOW, "sell", 4, { pair: smartPair(TOKEN) })]);
    expect(merged.map((f) => f.side)).toEqual(["buy", "sell"]);
    expect(smartWindowsFromFills(merged, NOW)[0]).toMatchObject({ buys: 1, sells: 1, buyUsd: 10, sellUsd: 4 });
  });

  it("treats a different wallet on the same tx as a different fill", () => {
    const other = { ...TRADER, address: "0x000000000000000000000000000000000000dead" };
    const merged = mergeSmartFills([fill("x", NOW, "buy", 1)], [fill("x", NOW, "buy", 1, { trader: other })]);
    expect(merged).toHaveLength(2);
    expect(smartFillKey(merged[0])).not.toBe(smartFillKey(merged[1]));
  });
});

describe("smartWindowsFromFills", () => {
  it("sums priced usd per window, counts unpriced fills, and leaves aggressor null when nothing is priced", () => {
    const fills = [
      fill("a", NOW - 30_000, "buy", 100),
      fill("b", NOW - 4 * 60_000, "sell", 40),
      fill("c", NOW - 10 * 60_000, "buy", null),
      fill("d", NOW - 2 * 3_600_000, "buy", 999),
      fill("e", NOW + 1000, "buy", 999)
    ];
    const windows = smartWindowsFromFills(fills, NOW);
    expect(windows.map((w) => w.label)).toEqual(["1m", "5m", "15m", "1h"]);
    expect(windows[0]).toMatchObject({ buyUsd: 100, sellUsd: 0, net: 100, buys: 1, sells: 0, unpriced: 0, aggressor: 1 });
    expect(windows[1]).toMatchObject({ buyUsd: 100, sellUsd: 40, net: 60, buys: 1, sells: 1, unpriced: 0 });
    expect(windows[2]).toMatchObject({ buys: 2, sells: 1, unpriced: 1, buyUsd: 100, sellUsd: 40 });
    expect(windows[3]).toMatchObject({ buys: 2, sells: 1 });
    expect(smartWindowsFromFills([fill("u", NOW - 1000, "buy", null)], NOW)[0]).toMatchObject({ buys: 1, unpriced: 1, aggressor: null, net: 0 });
  });
});
