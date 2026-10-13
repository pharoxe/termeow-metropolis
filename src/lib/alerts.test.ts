import { describe, expect, it } from "vitest";
import type { AlertRow, SmartCoverage } from "../../shared/wire";
import {
  ALERTS_POLL_MS,
  LATE_LAG_MS,
  SEEN_CAP,
  alertClockIst,
  alertEvidenceLine,
  alertQuery,
  alertRowView,
  alertToast,
  alertTokenLabel,
  alertsHeader,
  coldCopy,
  lagNote,
  ruleBadge,
  sortNewestFirst,
  unseenAlerts,
  usdLabel,
  withSeen
} from "./alerts";
import { COVERAGE_UNKNOWN } from "./smartPanel";

// 2026-09-07T11:37:07Z = 17:07:07 IST, the newest book fill at the R5 capture.
const TIME = Date.UTC(2026, 8, 7, 11, 37, 7);
const NOW = TIME + 3_611_938; // delivery lag measured at capture
const TOKEN = "0x85cbb08468de217650fe1f684f4961a88808ff93";
const WALLET = "0x7ab2095b1a4c9e0d3f2b6c8e1a5d7f9b0c2e4a6d";
const COVERAGE: SmartCoverage = { watched: 600, population: 1519, label: "watching 600 of 1,519 SMART wallets · 147 named" };

function firstBuy(overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    id: `first_smart_buy:monad:${TOKEN}`,
    rule: "first_smart_buy",
    chain: "monad",
    time: TIME,
    observedAt: NOW,
    token: TOKEN,
    symbol: null,
    coverage: COVERAGE,
    evidence: {
      launchpad: "pons",
      createdAt: TIME - 35_891,
      createdAtEstimated: true,
      launchAgeMs: 35_891,
      launchTx: "0xlaunch",
      fill: { tx: "0x728c7806", wallet: WALLET, kind: "smart", handle: null, followers: null, side: "buy", usd: 64.09, usdVia: "hub_leg" }
    },
    ...overrides
  } as AlertRow;
}

function bigHandle(): AlertRow {
  return {
    id: `big_handle_entry:monad:0x22ce1696:${WALLET}`,
    rule: "big_handle_entry",
    chain: "monad",
    time: TIME - 60_000,
    observedAt: TIME - 48_000,
    token: "0x22ce16960000000000000000000000000000abcd",
    symbol: "HOODSHOP",
    coverage: COVERAGE,
    evidence: { tx: "0xbig", wallet: WALLET, kind: "smart", handle: "DopamineFeenFr1", followers: 64_149, side: "buy", usd: 993.44, usdVia: "hub_leg", bookSince: TIME - 3_600_000 }
  };
}

function graduation(): AlertRow {
  return {
    id: `graduation:monad:${TOKEN}`,
    rule: "graduation",
    chain: "monad",
    time: TIME + 5_000,
    observedAt: NOW + 5_000,
    token: TOKEN,
    symbol: null,
    coverage: COVERAGE,
    evidence: { launchpad: "pons", pool: null, launchTx: "0xlaunch", graduationTx: null, smartFills: 3 }
  };
}

describe("alert formatting", () => {
  it("polls every 15 s and follows the chain chip", () => {
    expect(ALERTS_POLL_MS).toBe(15_000);
    expect(alertQuery("ALL").chain).toBe("all");
    expect(alertQuery("MON").chain).toBe("monad");
  });

  it("renders chain time as an IST clock", () => {
    expect(alertClockIst(TIME)).toBe("17:07:07");
    expect(alertClockIst(Number.NaN)).toBe("—");
  });

  it("names tokens by symbol or short address, never a guess", () => {
    expect(alertTokenLabel({ symbol: null, token: TOKEN })).toBe("0x85…ff93");
    expect(alertTokenLabel({ symbol: "hoodshop", token: TOKEN })).toBe("HOODSHOP");
  });

  it("keeps unpriced fills unpriced", () => {
    expect(usdLabel(null)).toBe("unpriced");
    expect(usdLabel(64.09)).toBe("$64.09");
  });

  it("builds the first-SMART-buy evidence line from the row alone", () => {
    const line = alertEvidenceLine(firstBuy());
    expect(line).toBe("0x7a…4a6d · BUY $64.09 · PONS · launch +36s~");
    const seeded = firstBuy({ evidence: { ...firstBuy().evidence, fill: { ...(firstBuy() as Extract<AlertRow, { rule: "first_smart_buy" }>).evidence.fill, kind: "seeded", usd: null } } } as Partial<AlertRow>);
    expect(alertEvidenceLine(seeded)).toBe("0x7a…4a6d · BUY unpriced · PONS · launch +36s~ · SEEDED");
  });

  it("builds the big-handle line with the book's temporal bound, and the graduation line", () => {
    expect(alertEvidenceLine(bigHandle())).toBe("DopamineFeenFr1 · 64K followers · BUY $993.44 · first since 16:07:07 IST");
    const emptyBook = { ...bigHandle(), evidence: { ...bigHandle().evidence, bookSince: null } } as AlertRow;
    expect(alertEvidenceLine(emptyBook)).toBe("DopamineFeenFr1 · 64K followers · BUY $993.44 · first in an empty book");
    expect(alertEvidenceLine(graduation())).toBe("PONS · 3 SMART fills");
  });

  it("derives the delivery lag from observedAt - chain time, says when it was late, and stays quiet when current", () => {
    expect(lagNote({ observedAt: NOW, time: TIME })).toBe("seen 1h late");
    expect(lagNote({ observedAt: TIME + LATE_LAG_MS - 1, time: TIME })).toBeNull();
  });

  it("derives a row view with badge, IST clock, coverage title and instrument", () => {
    const view = alertRowView(firstBuy(), NOW);
    expect(view.badge).toBe("1ST SMART BUY");
    expect(view.tone).toBe("good");
    expect(view.clock).toBe("17:07:07");
    expect(view.title).toContain("07 Sep 2026 17:07:07 IST");
    expect(view.title).toContain("tx 0x728c7806");
    expect(view.title).toContain("WATCHING 600 OF 1,519 SMART WALLETS · 147 NAMED");
    expect(view.lag).toBe("seen 1h late");
    expect(view.age).toBe("1h");
    expect(view.instrument).toEqual({ chain: "monad", address: TOKEN });
    expect(alertRowView(graduation(), NOW).title).toContain("no tx carried");
    expect(ruleBadge("graduation")).toBe("GRAD");
  });

  it("sorts newest first by observedAt and finds unseen ids without mutating the seen set", () => {
    const rows = [bigHandle(), graduation(), firstBuy()];
    expect(sortNewestFirst(rows).map((row) => row.rule)).toEqual(["graduation", "first_smart_buy", "big_handle_entry"]);
    const seen = new Set([firstBuy().id]);
    const unseen = unseenAlerts(rows, seen);
    expect(unseen.map((row) => row.rule)).toEqual(["graduation", "big_handle_entry"]);
    expect(seen.size).toBe(1);
    const next = withSeen(seen, unseen);
    expect(next.size).toBe(3);
    expect(unseenAlerts(rows, next)).toEqual([]);
  });

  it("caps the seen set at SEEN_CAP, keeping this page's ids and the newest history first", () => {
    expect(SEEN_CAP).toBe(400);
    const history = new Set(Array.from({ length: 450 }, (_, i) => `old:${i}`));
    const next = withSeen(history, [firstBuy(), graduation()]);
    expect(next.size).toBe(SEEN_CAP);
    expect(next.has(firstBuy().id)).toBe(true);
    expect(next.has("old:0")).toBe(true);
    expect(next.has("old:449")).toBe(false);
    expect(withSeen(history, [], 3)).toEqual(new Set(["old:0", "old:1", "old:2"]));
    expect(history.size).toBe(450);
  });

  it("writes toast copy with the evidence and the coverage label", () => {
    const toast = alertToast(bigHandle());
    expect(toast.id).toBe(bigHandle().id);
    expect(toast.title).toBe("BIG HANDLE · HOODSHOP");
    expect(toast.message).toBe("DopamineFeenFr1 · 64K followers · BUY $993.44 · first since 16:07:07 IST · watching 600 of 1,519 SMART wallets · 147 named");
    expect(toast.tone).toBe("warning");
    expect(alertToast(firstBuy()).message).toContain("seen 1h late");
    expect(alertToast(graduation()).tone).toBe("success");
  });

  it("never shows a count without coverage in the header", () => {
    expect(alertsHeader(3, COVERAGE, 3, 500)).toBe("3 ALERTS · WATCHING 600 OF 1,519 SMART WALLETS · 147 NAMED");
    expect(alertsHeader(0, undefined, undefined, undefined)).toBe(`0 ALERTS · ${COVERAGE_UNKNOWN}`);
    expect(alertsHeader(500, COVERAGE, 500, 500)).toContain("RING FULL");
    expect(alertsHeader(3, COVERAGE, 3, 500, 2)).toBe("3 ALERTS · WATCHING 600 OF 1,519 SMART WALLETS · 147 NAMED · ENGINE ERRORS 2");
    expect(alertsHeader(3, COVERAGE, 3, 500, 0)).not.toContain("ENGINE");
  });

  it("says no alert has fired yet and names the rules", () => {
    expect(coldCopy("monad")).toContain("No alerts fired yet");
    expect(coldCopy("all")).toContain("nad.fun graduation");
  });
});
