import { describe, expect, it } from "vitest";
import type { FomoBoardRow, FomoFill } from "../../shared/wire";
import {
  BOARD_WINDOWS,
  FOMO_PROFILE_BASE,
  WILSON_MIN_CLOSED,
  fomoBoardRowView,
  fomoHeaderLabel,
  fomoTapeRow,
  fomoWindowRows,
  followersLabel,
  profileHref,
  truncationNote,
  walletLabel
} from "./fomoPanel";

const NOW = 1_800_000_000_000;
const WALLET = "0x06de9c48b1e639ed5c13ec8fbd4080a38e39f2d1";

function fill(overrides: Partial<FomoFill> = {}): FomoFill {
  return {
    chain: "robinhood",
    token: "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01",
    pair: "0x353f2bd390d8db7bfc9b3dd389f8b71e8df524fa",
    dex: "uniswap",
    tx: "0x51e1a0bc",
    time: NOW - 90_000,
    side: "buy",
    usd: 1234,
    trader: { address: WALLET, kind: "fomo", handle: "AvgJoesCrypto", followers: 12_400 },
    ...overrides
  };
}

function boardRow(overrides: Partial<FomoBoardRow> = {}): FomoBoardRow {
  return {
    chain: "robinhood",
    wallet: WALLET,
    handle: "AvgJoesCrypto",
    followers: 12_400,
    fills: 9,
    buyUsd: 5000,
    sellUsd: 1500,
    netUsd: 3500,
    closed: 6,
    wins: 4,
    wilsonLow: 0.3,
    lastSeenAt: NOW - 60_000,
    profileUrl: null,
    ...overrides
  };
}

describe("walletLabel / profileHref / followersLabel", () => {
  it("prefers the handle and falls back to the short address, never inventing a name", () => {
    expect(walletLabel(WALLET, "AvgJoesCrypto")).toBe("AvgJoesCrypto");
    expect(walletLabel(WALLET, "   ")).toBe("0x06…f2d1");
    expect(walletLabel(WALLET, null)).toBe("0x06…f2d1");
  });

  it("links out to fomo.family only when a handle is known, and prefers a server-supplied url", () => {
    expect(profileHref("AvgJoesCrypto")).toBe(`${FOMO_PROFILE_BASE}AvgJoesCrypto`);
    expect(profileHref("@AvgJoesCrypto")).toBe(`${FOMO_PROFILE_BASE}AvgJoesCrypto`);
    expect(profileHref("a b/c")).toBe(`${FOMO_PROFILE_BASE}a%20b%2Fc`);
    expect(profileHref(null)).toBeNull();
    expect(profileHref(null, "https://fomo.family/profile/x")).toBe("https://fomo.family/profile/x");
  });

  it("shows an em-dash for unknown follower counts instead of zero", () => {
    expect(followersLabel(12_400)).toBe("12K");
    expect(followersLabel(0)).toBe("0");
    expect(followersLabel(null)).toBe("—");
    expect(followersLabel(Number.NaN)).toBe("—");
  });
});

describe("fomoTapeRow", () => {
  it("formats a priced buy with handle, symbol and age", () => {
    const row = fomoTapeRow(fill({ symbol: "pons" }), NOW);
    expect(row).toMatchObject({ label: "AvgJoesCrypto", side: "BUY", tone: "up", usd: "$1.23K", token: "PONS", age: "2m", followers: "12K" });
    expect(row.href).toBe(`${FOMO_PROFILE_BASE}AvgJoesCrypto`);
    expect(row.title).toContain(WALLET);
  });

  it("keeps an unpriced fill unpriced and falls back to the short token address", () => {
    const row = fomoTapeRow(fill({ usd: null, side: "sell", symbol: null, trader: { address: WALLET, kind: "fomo", handle: null, followers: null } }), NOW);
    expect(row).toMatchObject({ usd: "—", side: "SELL", tone: "dn", label: "0x06…f2d1", href: null, followers: "—" });
    expect(row.token).toBe("0x12…8a01");
  });

  it("keys a row by chain, tx, pair and wallet so bundled multi-trader txs stay distinct", () => {
    const a = fomoTapeRow(fill(), NOW);
    const b = fomoTapeRow(fill({ trader: { address: "0xother", kind: "fomo", handle: null, followers: null } }), NOW);
    expect(a.key).not.toBe(b.key);
  });
});

describe("fomoBoardRowView", () => {
  it("formats totals and the win record", () => {
    expect(fomoBoardRowView(boardRow(), NOW)).toMatchObject({
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
    expect(fomoBoardRowView(boardRow({ closed: WILSON_MIN_CLOSED - 1, wins: 2, wilsonLow: null }), NOW).wilson).toBe("—");
    expect(fomoBoardRowView(boardRow({ closed: 0, wins: 0, wilsonLow: null }), NOW).record).toBe("—");
  });

  it("marks a negative net and keeps the server profile url when one is given", () => {
    const row = fomoBoardRowView(boardRow({ netUsd: -250, profileUrl: "https://fomo.family/profile/zz" }), NOW);
    expect(row.netTone).toBe("dn");
    expect(row.net.startsWith("+")).toBe(false);
    expect(row.href).toBe("https://fomo.family/profile/zz");
  });
});

describe("labels and windows", () => {
  it("names both populations in the header", () => {
    expect(fomoHeaderLabel(128, 47)).toBe("FOMO WALLETS · 128 SEEN · 47 NAMED");
  });

  it("reports truncation only when the ring is shorter than the window", () => {
    expect(truncationNote(null, NOW)).toBeNull();
    expect(truncationNote(NOW - 3_600_000, NOW)?.toLowerCase()).toContain("1h");
  });

  it("formats FOMO window rows like the all-flow windows and tolerates a missing block", () => {
    expect(fomoWindowRows(undefined)).toEqual([]);
    const rows = fomoWindowRows({
      fills: [],
      population: 1,
      handles: 1,
      windows: [{ label: "1m", buyUsd: 100, sellUsd: 40, net: 60, buys: 2, sells: 1, unpriced: 1, aggressor: 0.714 }]
    });
    expect(rows).toEqual([{ label: "1M", buy: "$100", sell: "$40", net: "+$60", netTone: "up", prints: "3 (1u)", aggr: "71%" }]);
  });

  it("offers exactly the three board windows", () => {
    expect(BOARD_WINDOWS).toEqual(["1h", "24h", "7d"]);
  });
});
