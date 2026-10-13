import { describe, expect, it } from "vitest";
import type { SmartBoardRow, SmartFill } from "../../shared/wire";
import {
  BOARD_WINDOWS,
  COVERAGE_UNKNOWN,
  SMART_PROFILE_BASE,
  WILSON_MIN_CLOSED,
  smartBoardRowView,
  smartCoverageLabel,
  smartTapeRow,
  smartWindowRows,
  followersLabel,
  profileHref,
  provenanceTag,
  truncationNote,
  walletLabel
} from "./smartPanel";

const NOW = 1_800_000_000_000;
const WALLET = "0x06de9c48b1e639ed5c13ec8fbd4080a38e39f2d1";

function fill(overrides: Partial<SmartFill> = {}): SmartFill {
  return {
    chain: "monad",
    token: "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01",
    pair: "0x353f2bd390d8db7bfc9b3dd389f8b71e8df524fa",
    dex: "uniswap",
    tx: "0x51e1a0bc",
    time: NOW - 90_000,
    side: "buy",
    usd: 1234,
    trader: { address: WALLET, kind: "smart", handle: "AvgJoesCrypto", followers: 12_400 },
    ...overrides
  };
}

function boardRow(overrides: Partial<SmartBoardRow> = {}): SmartBoardRow {
  return {
    chain: "monad",
    wallet: WALLET,
    handle: "AvgJoesCrypto",
    followers: 12_400,
    fills: 9,
    buyUsd: 5000,
    sellUsd: 1500,
    netUsd: 3500,
    unpriced: 0,
    closed: 6,
    wins: 4,
    wilsonLow: 0.3,
    lastSeenAt: NOW - 60_000,
    profileUrl: null,
    kind: "smart",
    ...overrides
  };
}

describe("walletLabel / profileHref / followersLabel", () => {
  it("prefers the handle and falls back to the short address, never inventing a name", () => {
    expect(walletLabel(WALLET, "AvgJoesCrypto")).toBe("AvgJoesCrypto");
    expect(walletLabel(WALLET, "   ")).toBe("0x06…f2d1");
    expect(walletLabel(WALLET, null)).toBe("0x06…f2d1");
  });

  it("links out to Nansen smart money only when a handle is known, and prefers a server-supplied url", () => {
    expect(profileHref("AvgJoesCrypto")).toBe(`${SMART_PROFILE_BASE}AvgJoesCrypto`);
    expect(profileHref("@AvgJoesCrypto")).toBe(`${SMART_PROFILE_BASE}AvgJoesCrypto`);
    expect(profileHref("a b/c")).toBe(`${SMART_PROFILE_BASE}a%20b%2Fc`);
    expect(profileHref(null)).toBeNull();
    expect(profileHref(null, "https://app.nansen.ai/profiler?chain=monad&address=x")).toBe("https://app.nansen.ai/profiler?chain=monad&address=x");
  });

  it("shows an em-dash for unknown follower counts instead of zero", () => {
    expect(followersLabel(12_400)).toBe("12K");
    expect(followersLabel(0)).toBe("0");
    expect(followersLabel(null)).toBe("—");
    expect(followersLabel(Number.NaN)).toBe("—");
  });
});

describe("smartTapeRow", () => {
  it("formats a priced buy with handle, symbol and age", () => {
    const row = smartTapeRow(fill({ symbol: "pons" }), NOW);
    expect(row).toMatchObject({ label: "AvgJoesCrypto", side: "BUY", tone: "up", usd: "$1.23K", token: "PONS", age: "2m", followers: "12K" });
    expect(row.href).toBe(`${SMART_PROFILE_BASE}AvgJoesCrypto`);
    expect(row.title).toContain(WALLET);
  });

  it("keeps an unpriced fill unpriced and falls back to the short token address", () => {
    const row = smartTapeRow(fill({ usd: null, side: "sell", symbol: null, trader: { address: WALLET, kind: "smart", handle: null, followers: null } }), NOW);
    expect(row).toMatchObject({ usd: "—", side: "SELL", tone: "dn", label: "0x06…f2d1", href: null, followers: "—" });
    expect(row.token).toBe("0x12…8a01");
  });

  it("keys a row by chain, tx, pair and wallet so bundled multi-trader txs stay distinct", () => {
    const a = smartTapeRow(fill(), NOW);
    const b = smartTapeRow(fill({ trader: { address: "0xother", kind: "smart", handle: null, followers: null } }), NOW);
    expect(a.key).not.toBe(b.key);
  });
});

describe("smartBoardRowView", () => {
  it("formats totals and the win record", () => {
    expect(smartBoardRowView(boardRow(), NOW)).toMatchObject({
      label: "AvgJoesCrypto",
      fills: "9",
      buy: "$5K",
      sell: "$1.5K",
      net: "+$3.5K",
      netTone: "up",
      record: "4/6",
      wilson: "30%"
    });
  });

  it("shows an em-dash for Wilson under the minimum closed trades and for no round trips at all", () => {
    expect(smartBoardRowView(boardRow({ closed: WILSON_MIN_CLOSED - 1, wins: 2, wilsonLow: null }), NOW).wilson).toBe("—");
    expect(smartBoardRowView(boardRow({ closed: 0, wins: 0, wilsonLow: null }), NOW).record).toBe("—");
  });

  it("shows em-dashes, not $0, for a wallet whose fills are all unpriced and counts unpriced fills next to the total", () => {
    const view = smartBoardRowView(boardRow({ fills: 3, unpriced: 3, buyUsd: 0, sellUsd: 0, netUsd: 0 }), NOW);
    expect(view).toMatchObject({ fills: "3 (3u)", buy: "—", sell: "—", net: "—", netTone: "" });
    expect(smartBoardRowView(boardRow({ fills: 4, unpriced: 1 }), NOW).fills).toBe("4 (1u)");
  });

  it("marks a negative net and keeps the server profile url when one is given", () => {
    const row = smartBoardRowView(boardRow({ netUsd: -250, profileUrl: "https://app.nansen.ai/profiler?chain=monad&address=zz" }), NOW);
    expect(row.netTone).toBe("dn");
    expect(row.net.startsWith("+")).toBe(false);
    expect(row.href).toBe("https://app.nansen.ai/profiler?chain=monad&address=zz");
  });
});

describe("labels and windows", () => {
  it("renders the server's coverage label on every SMART header and never a bare count without it", () => {
    expect(smartCoverageLabel({ watched: 600, population: 1519, label: "watching 600 of 1,519 SMART wallets · 147 named" })).toBe("WATCHING 600 OF 1,519 SMART WALLETS · 147 NAMED");
    expect(smartCoverageLabel(undefined)).toBe(COVERAGE_UNKNOWN);
    expect(smartCoverageLabel({ watched: 0, population: 0, label: "  " })).toBe(COVERAGE_UNKNOWN);
  });

  it("tags seeded rows with their provenance and never tags verified SMART rows", () => {
    expect(provenanceTag("seeded")).toBe("SEEDED");
    expect(provenanceTag("smart")).toBeNull();
    expect(provenanceTag("other")).toBeNull();
    expect(provenanceTag(null)).toBeNull();
    const seeded = smartTapeRow(fill({ trader: { address: WALLET, kind: "seeded", handle: "unipcs", followers: 514_576 } }), NOW);
    expect(seeded.tag).toBe("SEEDED");
    expect(seeded.title).toContain("seeded from Nansen / your watchlist · smart-money check pending");
    const verified = smartTapeRow(fill(), NOW);
    expect(verified.tag).toBeNull();
    expect(verified.title).not.toContain("7702");
    expect(smartBoardRowView(boardRow({ kind: "seeded" }), NOW).tag).toBe("SEEDED");
    expect(smartBoardRowView(boardRow({ kind: "seeded" }), NOW).title).toContain("7702 check pending");
    expect(smartBoardRowView(boardRow(), NOW).tag).toBeNull();
  });

  it("reports truncation only when the ring is shorter than the window", () => {
    expect(truncationNote(null, NOW)).toBeNull();
    expect(truncationNote(NOW - 3_600_000, NOW)?.toLowerCase()).toContain("1h");
  });

  it("formats SMART window rows like the all-flow windows and tolerates a missing block", () => {
    expect(smartWindowRows(undefined)).toEqual([]);
    const rows = smartWindowRows({
      fills: [],
      population: 1,
      handles: 1,
      coverage: { watched: 1, population: 1, label: "watching 1 of 1 SMART wallets · 1 named" },
      windows: [{ label: "1m", buyUsd: 100, sellUsd: 40, net: 60, buys: 2, sells: 1, unpriced: 1, aggressor: 0.714 }]
    });
    expect(rows).toEqual([{ label: "1M", buy: "$100", sell: "$40", net: "+$60", netTone: "up", prints: "3 (1u)", aggr: "71%" }]);
  });

  it("offers exactly the three board windows", () => {
    expect(BOARD_WINDOWS).toEqual(["1h", "24h", "7d"]);
  });
});
