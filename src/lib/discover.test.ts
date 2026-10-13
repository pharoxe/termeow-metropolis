import { describe, expect, it } from "vitest";
import type { DiscoverResponse, DiscoverRow } from "../../shared/wire";
import {
  ageLabel, changeCell, disputedLabel, emptyCopy, smartHoldersCell, isDiscoverTab, rowKey, sourceChipLabel, sourceChips, sourcesSummary, symbolLabel, txnsLabel, viewFor, windowParam
} from "./discover";

const NOW = 1_788_790_000_000;
const TOKEN = "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01";

function row(overrides: Partial<DiscoverRow> = {}): DiscoverRow {
  return {
    chain: "monad", token: TOKEN, symbol: "FATCOIN", name: "Fatcoin",
    priceUsd: 0.0204, marketCapUsd: 20_400_000, liquidityUsd: 1_000_000, volumeUsd: 550_000, changePct: -3.2,
    txns: { buys: 120, sells: 80 }, ageMs: 5 * 3_600_000, pool: "0xpool", dex: "uniswap", smartHolders: 4, trackedBuyers: 36,
    sources: [
      { source: "dexscreener profiles+boosts", lastOkAt: NOW - 20_000, stale: false, symbol: "FATCOIN", name: "Fatcoin", rank: null, priceUsd: 0.0204, marketCapUsd: 20_400_000, liquidityUsd: 1_000_000, volumeUsd: 550_000, changePct: -3.2, txns: { buys: 120, sells: 80 }, ageMs: null, pool: "0xpool", dex: "uniswap", smartHolders: null, trackedBuyers: null },
      { source: "geckoterminal trending_pools", lastOkAt: NOW - 90_000, stale: true, symbol: "FATCOIN", name: null, rank: 2, priceUsd: 0.0198, marketCapUsd: null, liquidityUsd: null, volumeUsd: 600_000, changePct: null, txns: null, ageMs: null, pool: "0xpool", dex: "uniswap", smartHolders: null, trackedBuyers: null }
    ],
    disputed: ["volumeUsd"],
    ...overrides
  };
}

function feed(overrides: Partial<DiscoverResponse> = {}): DiscoverResponse {
  return { chain: "monad", view: "trending", window: "24h", rows: [], observedAt: NOW, sources: [{ name: "dexscreener profiles+boosts", lastOkAt: NOW, lastError: null, stale: false }, { name: "geckoterminal new_pools", lastOkAt: null, lastError: "Upstream returned 429", stale: true }], coverage: null, ...overrides };
}

describe("tabs and params", () => {
  it("maps watch tabs to discover views and window chips to params", () => {
    expect(viewFor("TRENDING")).toBe("trending");
    expect(viewFor("BIGGEST MOVERS")).toBe("movers");
    expect(viewFor("SMART HOLDERS")).toBe("holders");
    expect(viewFor("NEW")).toBe("new");
    expect(windowParam("1H")).toBe("1h");
    expect(windowParam("24H")).toBe("24h");
    expect(isDiscoverTab("NEW")).toBe(true);
    expect(isDiscoverTab("LAUNCHES")).toBe(false);
  });
});

describe("cells", () => {
  it("falls back to the short address when the symbol is missing", () => {
    expect(symbolLabel(row())).toBe("FATCOIN");
    expect(symbolLabel(row({ symbol: null }))).toBe("0x12…8a01");
    expect(symbolLabel(row({ symbol: "  " }))).toBe("0x12…8a01");
  });
  it("is null-safe for txns, age and change", () => {
    expect(txnsLabel({ buys: 3, sells: 1 })).toBe("B3/S1");
    expect(txnsLabel(null)).toBe("—");
    expect(ageLabel(5 * 3_600_000)).toBe("5h");
    expect(ageLabel(null)).toBe("—");
    expect(changeCell(-3.2)).toEqual({ text: "-3.20%", tone: "dn" });
    expect(changeCell(null)).toEqual({ text: "—", tone: "" });
  });
  it("labels every source with a chip and keeps each source's own figures in the title", () => {
    const chips = sourceChips(row(), NOW);
    expect(chips.map((chip) => chip.label)).toEqual(["DEXSCREENER", "GECKO TREND"]);
    expect(chips[1].stale).toBe(true);
    expect(chips[1].title).toContain("rank #3");
    expect(chips[1].title).toContain("vol $600K");
    expect(chips[1].title).toContain("stale");
    expect(sourceChipLabel("robinhoodtrenches · unofficial")).toBe("TRENCHES");
    expect(sourceChipLabel("trader book · verified-SMART buyers seen by this server")).toBe("BOOK");
    expect(sourceChipLabel("something else")).toBe("SOMETHING");
  });
  it("names disputed fields and stays silent when sources agree", () => {
    expect(disputedLabel(row())).toBe("DISPUTED vol");
    expect(disputedLabel(row({ disputed: ["marketCapUsd", "priceUsd"] }))).toBe("DISPUTED mcap, px");
    expect(disputedLabel(row({ disputed: [] }))).toBeNull();
  });
  it("renders SMART holders against the coverage label and never turns an empty book into 0", () => {
    const coverage = { watched: 1200, population: 1377, label: "watching 1,200 of 1,377 SMART wallets · 147 named" };
    const cell = smartHoldersCell(row(), coverage);
    expect(cell.text).toBe("4");
    expect(cell.title).toContain("WATCHING 1,200 OF 1,377 SMART WALLETS");
    expect(cell.title).toContain("36 tracked buyers per robinhoodtrenches");
    const empty = smartHoldersCell(row({ smartHolders: null, trackedBuyers: null }), null);
    expect(empty.text).toBe("—");
    expect(empty.title).toContain("SMART COVERAGE UNKNOWN");
  });
});

describe("feed summary", () => {
  it("counts healthy sources and flags stale", () => {
    expect(sourcesSummary(feed().sources, undefined)).toBe("1/2 SRC");
    expect(sourcesSummary(feed().sources, true)).toBe("1/2 SRC · STALE");
    expect(sourcesSummary([], false)).toBe("SRC —");
  });
  it("explains an empty list by view and by failure", () => {
    expect(emptyCopy(null, "")).toBe("Loading discovery rows…");
    expect(emptyCopy(null, "boom")).toBe("Discovery unavailable · boom");
    expect(emptyCopy(feed({ error: "geckoterminal new_pools: Upstream returned 429" }), "")).toBe("No rows · geckoterminal new_pools: Upstream returned 429");
    expect(emptyCopy(feed({ view: "holders" }), "")).toContain("book for this window");
    expect(emptyCopy(feed(), "")).toBe("No rows from dexscreener profiles+boosts, geckoterminal new_pools in this window.");
    expect(rowKey(row())).toBe(`monad:${TOKEN}`);
  });
});
