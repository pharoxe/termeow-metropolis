import { describe, expect, it } from "vitest";
import type { LaunchRow } from "../../shared/wire";
import {
  CHAIN_CHIPS,
  SMART_POPULATION,
  chainLabel,
  chipChain,
  coldCopy,
  curveCounts,
  defaultChip,
  filterByChip,
  smartBuyer,
  isHoneypot,
  launchAge,
  launchChange,
  launchMcap,
  launchPrice,
  launchQuery,
  padLabel,
  priceAgeTitle,
  rowKey,
  rowSubtitle,
  sortNewestFirst,
  symbolLabel
} from "./launches";

const NOW = 1_800_000_000_000;

function row(overrides: Partial<LaunchRow> = {}): LaunchRow {
  return {
    chain: "monad",
    launchpad: "pons",
    token: "0xaaaa000000000000000000000000000000000001",
    symbol: "MEAO",
    name: "Make Everyone An Owner",
    image: null,
    creator: null,
    curve: null,
    pool: null,
    createdAt: NOW - 90_000,
    tx: "0xtx",
    graduatedAt: null,
    priceUsd: null,
    marketCapUsd: null,
    liquidityUsd: null,
    volume24Usd: null,
    change24Pct: null,
    pricedAt: null,
    curveBuys: 0,
    curveSells: 0,
    curveNetUsd: null,
    tracked: null,
    sources: ["rpc:monad"],
    observedAt: NOW,
    ...overrides
  };
}

describe("chips and labels", () => {
  it("maps chips to chains and chains to chip labels", () => {
    expect(CHAIN_CHIPS).toEqual(["MON"]);
    expect(chipChain("ALL")).toBe("all");
    expect(chipChain("MON")).toBe("monad");
    expect(chainLabel("monad")).toBe("MON");
  });

  it("labels known pads and uppercases unknown ones instead of hiding them", () => {
    expect(padLabel("nadfun")).toBe("NAD.FUN");
    expect(padLabel("dexscreener-profile")).toBe("DEX PROFILE");
    expect(padLabel("unknown")).toBe("PAD ?");
    expect(padLabel("hoodit")).toBe("HOODIT");
  });

  it("builds the query from chip and stocks toggle", () => {
    expect(launchQuery("MON", false)).toEqual({ chain: "monad", stocks: false });
    expect(launchQuery("ALL", true)).toEqual({ chain: "all", stocks: true });
  });
});

describe("ordering and filtering", () => {
  it("sorts newest first with observedAt as the tie-break", () => {
    const a = row({ token: "a", createdAt: NOW - 10, observedAt: NOW - 5 });
    const b = row({ token: "b", createdAt: NOW - 1 });
    const c = row({ token: "c", createdAt: NOW - 10, observedAt: NOW });
    expect(sortNewestFirst([a, b, c]).map((item) => item.token)).toEqual(["b", "c", "a"]);
  });

  it("filters by chain chip and copies for ALL", () => {
    const rows = [row({ token: "r" }), row({ token: "s" })];
    expect(filterByChip(rows, "MON").map((item) => item.token)).toEqual(["r", "s"]);
    const all = filterByChip(rows, "ALL");
    expect(all).toEqual(rows);
    expect(all).not.toBe(rows);
  });
});

describe("cell formatting", () => {
  it("is null-safe for age, price, mcap and change", () => {
    expect(launchAge(row(), NOW)).toBe("2m");
    expect(launchPrice(row())).toBe("—");
    expect(launchPrice(row({ priceUsd: 0.0000123 }))).toBe("$0.0000123");
    expect(launchMcap(row())).toBe("—");
    expect(launchMcap(row({ marketCapUsd: 12_300 }))).toBe("$12.3K");
    expect(launchChange(row())).toEqual({ text: "—", tone: "" });
    expect(launchChange(row({ change24Pct: -3.5 }))).toEqual({ text: "-3.50%", tone: "dn" });
    expect(launchChange(row({ change24Pct: 12 }))).toEqual({ text: "+12.00%", tone: "up" });
  });

  it("titles the price cell with its refresh age and never pretends an unpriced row is current", () => {
    expect(priceAgeTitle(row(), NOW)).toBe("no price source yet");
    expect(priceAgeTitle(row({ pricedAt: NOW - 90_000 }), NOW)).toBe("priced 2m ago");
  });

  it("falls back to the short address when the symbol is missing", () => {
    expect(symbolLabel(row())).toBe("MEAO");
    expect(symbolLabel(row({ symbol: null }))).toBe("0xaa…0001");
    expect(symbolLabel(row({ symbol: "  " }))).toBe("0xaa…0001");
  });

  it("shows curve counts only once something printed", () => {
    expect(curveCounts(row())).toBe("—");
    expect(curveCounts(row({ curveBuys: 3, curveSells: 1 }))).toBe("B3/S1");
    expect(curveCounts(row({ curveSells: 2 }))).toBe("B0/S2");
  });

  it("derives the SMART buyer with followers and the population label in the title", () => {
    expect(smartBuyer(row(), NOW)).toBeNull();
    const tracked = { buyers: 24, usdIn: 100, usdOut: 0, firstBuyer: { handle: "fmpumpguy", followers: 65_621, at: NOW - 3_600_000 }, honeypot: null };
    const buyer = smartBuyer(row({ tracked }), NOW);
    expect(buyer?.handle).toBe("@fmpumpguy");
    expect(buyer?.title).toBe(`@fmpumpguy · 65,621 followers · first buy 1h ago · SMART first buyer · ${SMART_POPULATION}`);
    const unknownFollowers = smartBuyer(row({ tracked: { ...tracked, firstBuyer: { handle: "@x", followers: null, at: NOW } } }), NOW);
    expect(unknownFollowers).toMatchObject({ handle: "@x" });
    expect(unknownFollowers?.title).toContain("followers unknown");
    expect(smartBuyer(row({ tracked: { ...tracked, firstBuyer: null } }), NOW)).toBeNull();
  });

  it("flags honeypots only on an explicit true", () => {
    const tracked = { buyers: 1, usdIn: 1, usdOut: 0, firstBuyer: null, honeypot: null };
    expect(isHoneypot(row())).toBe(false);
    expect(isHoneypot(row({ tracked }))).toBe(false);
    expect(isHoneypot(row({ tracked: { ...tracked, honeypot: false } }))).toBe(false);
    expect(isHoneypot(row({ tracked: { ...tracked, honeypot: true } }))).toBe(true);
  });

  it("keys rows by chain and token and names sources in the cold copy", () => {
    expect(rowKey(row())).toBe("monad:0xaaaa000000000000000000000000000000000001");
    expect(coldCopy([])).toBe("Waiting for launches · sources: none reported yet");
    expect(coldCopy([{ name: "rpc:monad" }, { name: "pumpportal" }])).toBe("Waiting for launches · sources: rpc:monad, pumpportal");
  });
});

describe("R6 row completeness", () => {
  it("never leaves the subtitle blank: name, else the vouching sources", () => {
    expect(rowSubtitle(row())).toBe("Make Everyone An Owner");
    expect(rowSubtitle(row({ name: null }))).toBe("no name yet · rpc:monad");
    expect(rowSubtitle(row({ name: " ", sources: [] }))).toBe("no name yet");
  });
  it("starts on the MON chip", () => {
    expect(defaultChip("monad")).toBe("MON");
    expect(defaultChip()).toBe("MON");
  });
});
