import { describe, expect, it } from "vitest";
import type { IdentityCoverage, TraderRanking } from "../../shared/identity";
import {
  BOARD_CHOICES, budgetLabel, capturedLabel, holdLabel, IDENTITY_POLL_MS, namedLabel, pnlSplit, populationLabel, shortWallet, walletAgeLabel, winRateLabel
} from "./identity";

/** Live payloads read from GET /api/identity/* on 2026-09-08 (API on 127.0.0.1:9301), trimmed to the fields under test. */
const NOW = 1_788_882_930_593;
/** Upstream's capture instants and this server's reads of them, which the live boards table keeps 4.8 days apart. */
const FOMOSCAN_CAPTURED = 1_788_464_524_000;
const FOMOSCAN_OBSERVED = 1_788_881_233_005;
const PUMP_CAPTURED = 1_788_881_131_138;
const PUMP_OBSERVED = 1_788_881_477_587;
const PUMP_WALLET = "3jWTgYPG5s7WfaRvppPBXio4hHQxg18fLUkV2z5covSQ";

function ranking(overrides: Partial<TraderRanking> = {}): TraderRanking {
  return {
    board: "pump-traders", window: "weekly", rank: 1, chain: "solana", wallet: PUMP_WALLET, capturedAt: PUMP_CAPTURED,
    pnlUsd: null, realizedPnlUsd: null, unrealizedPnlUsd: null, returnPct: null, volumeUsd: null, trades: null,
    uniqueTokens: null, winRate: null, avgHoldSeconds: null, tokensCreated: null, walletFirstSeenAt: null,
    ...overrides
  };
}

/**
 * The row the doctrine is written about, copied from the live board at full float precision rather than rounded: a
 * paper gain of nearly $1.9M sitting on top of a realized loss. The unrounded realized leg is what catches money()'s
 * negative-precision branch, which a hand-typed -1123.91 cannot.
 */
function pumpPaperRow(): TraderRanking {
  return ranking({ pnlUsd: 1_886_776.85968169, realizedPnlUsd: -1_152.80684065719, unrealizedPnlUsd: 1_887_929.66652234, returnPct: 2_097.99574548293 });
}

/** A FomoScan sweep row: realized PnL only, the unrealized leg unmeasured rather than zero. */
function fomoscanRow(overrides: Partial<TraderRanking> = {}): TraderRanking {
  return ranking({
    board: "fomoscan-traders", window: "24h", wallet: "FZ8ofuKKQbZ6QKRGYb75hD2Un56MKJzF6zErpcLn3Cma", capturedAt: FOMOSCAN_CAPTURED,
    pnlUsd: 26_005.26, realizedPnlUsd: 26_005.26, unrealizedPnlUsd: null, returnPct: 121.82, volumeUsd: 61_490.14,
    trades: 26, uniqueTokens: 2, winRate: 0.5, avgHoldSeconds: 29_470, tokensCreated: 0, ...overrides
  });
}

function coverage(overrides: Partial<IdentityCoverage> = {}): IdentityCoverage {
  return {
    // No robinhood key: the server emits only the chains it holds rows for, and identity is harvested from Solana
    // boards, so the count is absent rather than 0. `bySource` is seeded server-side and does come back complete.
    identities: 288, byChain: { solana: 288 }, bySource: { "pump-board": 100, "fomoscan-board": 188, "pump-profile": 0, "fomo-profile": 0 },
    observedWallets: { solana: { seen: 594, named: 1 }, robinhood: { seen: 9019, named: 0 } },
    boards: [
      { board: "fomoscan-traders", window: "24h", capturedAt: FOMOSCAN_CAPTURED, count: 100, walletsRanked: 316_007, coverage: 1, observedAt: FOMOSCAN_OBSERVED },
      { board: "fomoscan-traders", window: "7d", capturedAt: FOMOSCAN_CAPTURED, count: 100, walletsRanked: 316_007, coverage: 1, observedAt: FOMOSCAN_OBSERVED },
      { board: "pump-traders", window: "weekly", capturedAt: PUMP_CAPTURED, count: 100, walletsRanked: null, coverage: null, observedAt: PUMP_OBSERVED }
    ],
    budget: { period: "2026-09", spent: 750, budget: 25_000, allowance: 2_600, accountRemaining: 19_250, checkedAt: NOW },
    refusedForBudget: 0, lastError: null,
    ...overrides
  };
}

/** A coverage payload from a server that has read nothing yet: every population unknown, none of them zero. */
function emptyCoverage(): IdentityCoverage {
  return {
    identities: 0, byChain: {}, bySource: { "pump-board": 0, "fomoscan-board": 0, "pump-profile": 0, "fomo-profile": 0 },
    observedWallets: null, boards: [], budget: null, refusedForBudget: 0, lastError: null
  };
}

describe("board choices", () => {
  it("lists exactly the three boards the server collects, named by source", () => {
    expect(BOARD_CHOICES.map((choice) => [choice.board, choice.window])).toEqual([
      ["fomoscan-traders", "24h"], ["fomoscan-traders", "all"], ["pump-traders", "weekly"]
    ]);
    expect(BOARD_CHOICES[0].label).toContain("FOMOSCAN");
    expect(BOARD_CHOICES[2].label).toContain("PUMP");
    expect(new Set(BOARD_CHOICES.map((choice) => choice.label)).size).toBe(BOARD_CHOICES.length);
  });
  it("never polls faster than the server can produce a new snapshot", () => {
    expect(IDENTITY_POLL_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe("cells", () => {
  it("shortens a wallet and never invents one", () => {
    expect(shortWallet(PUMP_WALLET)).toBe("3jWT…ovSQ");
    expect(shortWallet("short")).toBe("short");
    expect(shortWallet("")).toBe("—");
    expect(shortWallet("   ")).toBe("—");
  });
  it("formats hold time, keeping an unreported hold apart from a zero one", () => {
    expect(holdLabel(29_470)).toBe("8h");
    expect(holdLabel(41_295)).toBe("11h");
    expect(holdLabel(45)).toBe("45s");
    expect(holdLabel(0)).toBe("0s");
    expect(holdLabel(null)).toBe("—");
    expect(holdLabel(-1)).toBe("—");
    expect(holdLabel(Number.NaN)).toBe("—");
  });
  it("prints a measured 0% win rate but an em-dash for an unreported one", () => {
    expect(winRateLabel(0.5)).toBe("50%");
    expect(winRateLabel(1)).toBe("100%");
    expect(winRateLabel(0)).toBe("0%");
    expect(winRateLabel(0.6667)).toBe("67%");
    expect(winRateLabel(null)).toBe("—");
    expect(winRateLabel(Number.POSITIVE_INFINITY)).toBe("—");
  });
  it("keeps a win rate that rounds to nothing apart from a wallet that never won", () => {
    // 4 wins on the 7d board's 1,314-trade wallet is 0.3%: reachable on live data, and "0%" there is a false claim.
    expect(winRateLabel(0.003)).toBe("<1%");
    expect(winRateLabel(0.0049)).toBe("<1%");
    expect(winRateLabel(0.005)).toBe("1%");
  });
  it("shows wallet age only when the board reported a first sighting", () => {
    expect(walletAgeLabel(NOW - 3 * 86_400_000, NOW)).toBe("3d");
    expect(walletAgeLabel(NOW - 90_000, NOW)).toBe("2m");
    expect(walletAgeLabel(null, NOW)).toBe("—");
  });
});

describe("pnlSplit", () => {
  it("labels the current FomoScan board value as cash flow rather than profit", () => {
    const split = pnlSplit(fomoscanRow({ netUsd: -12_345, pnlUsd: null, realizedPnlUsd: null }));
    expect(split.realized).toBe("-$12.35K");
    expect(split.unrealized).toBeNull();
    expect(split.title).toContain("net cash flow");
    expect(split.title).toContain("not realized PnL");
  });
  it("keeps the pump paper gain apart from the realized loss and marks it", () => {
    const split = pnlSplit(pumpPaperRow());
    expect(split.realized).toBe("-$1.15K");
    expect(split.unrealized).toBe("+$1.89M");
    expect(split.paperDominant).toBe(true);
    expect(split.tone).toBe("dn");
    expect(split.title).toContain("realized -$1,152.81 (taken)");
    expect(split.title).toContain("unrealized +$1,887,929.67 (open, not taken)");
    expect(split.title).toContain("board total +$1,886,776.86 = realized + unrealized");
    expect(split.title).toContain("not a result");
    // The rank beside the cell is this board's, and it was taken on the sum — which the realized column contradicts.
    expect(split.title).toContain("this board ranks on realized + unrealized, not on the taken leg");
  });
  it("states a negative taken leg in cents, not in money()'s sub-cent branch", () => {
    // money() reads precision off the raw value, so any negative fell into `value < 0.01 ? 7`: the live rank-1 row
    // rendered "realized -$1,152.8068407 (taken)" — seven decimals of dollars on the one number the doctrine is about.
    const title = pnlSplit(pumpPaperRow()).title;
    expect(title).not.toContain("-$1,152.8068407");
    expect(/-\$[\d,]+\.\d{3,}/.test(title)).toBe(false);
    expect(pnlSplit(ranking({ realizedPnlUsd: -0.5, unrealizedPnlUsd: -1.234567 })).title)
      .toBe("realized -$0.50 (taken) · unrealized -$1.23 (open, not taken) · this board ranks on realized + unrealized, not on the taken leg");
  });
  it("never presents the combined figure as the headline result", () => {
    const split = pnlSplit(pumpPaperRow());
    expect(split.realized).not.toContain("1.89M");
    expect(split.realized).not.toContain("1.87M");
    expect(split.realized.startsWith("-")).toBe(true);
  });
  it("reads a fomoscan row as realized-only, with no invented zero for the open leg", () => {
    const split = pnlSplit(fomoscanRow());
    expect(split.realized).toBe("+$26.01K");
    expect(split.unrealized).toBeNull();
    expect(split.paperDominant).toBe(false);
    expect(split.tone).toBe("up");
    expect(split.title).toContain("unrealized not measured by the FomoScan sweep");
    expect(split.title).not.toContain("$0.00");
    expect(split.title).not.toContain("board total");
    expect(split.title).not.toContain("ranks on realized + unrealized");
  });
  it("leaves a genuinely mixed row unmarked at 1.14x", () => {
    const split = pnlSplit(ranking({ rank: 3, pnlUsd: 1_153_895.62, realizedPnlUsd: 538_499.22, unrealizedPnlUsd: 615_396.41 }));
    expect(split.paperDominant).toBe(false);
    expect(split.realized).toBe("+$538.5K");
    expect(split.unrealized).toBe("+$615.4K");
  });
  it("marks the row paper when nothing was taken at all", () => {
    const zeroTaken = pnlSplit(ranking({ pnlUsd: 4_200, realizedPnlUsd: 0, unrealizedPnlUsd: 4_200 }));
    expect(zeroTaken.paperDominant).toBe(true);
    expect(zeroTaken.realized).toBe("$0");
    expect(zeroTaken.tone).toBe("");
    const unreportedTaken = pnlSplit(ranking({ pnlUsd: 4_200, realizedPnlUsd: null, unrealizedPnlUsd: 4_200 }));
    expect(unreportedTaken.paperDominant).toBe(true);
    expect(unreportedTaken.realized).toBe("—");
    expect(unreportedTaken.tone).toBe("");
    expect(unreportedTaken.title).toContain("realized not reported by this board");
  });
  it("survives a row with no legs at all without printing a zero", () => {
    const split = pnlSplit(ranking());
    expect(split).toMatchObject({ realized: "—", unrealized: null, paperDominant: false, tone: "" });
    expect(split.title).toBe("realized not reported by this board · unrealized not reported by this board · this board ranks on realized + unrealized, not on the taken leg");
  });
});

describe("capturedLabel", () => {
  it("ages the board's own capture instant, never calling it this server's read", () => {
    expect(capturedLabel(PUMP_CAPTURED, NOW)).toEqual({ text: "captured 30m ago", stale: false });
    // The live 24h sweep: captured 2026-09-03 19:42Z but read 2026-09-08 15:27Z, 28 minutes before NOW. The 5 days
    // belong to upstream's sample, and the tab prints the read clock beside this from the boards row's observedAt.
    expect(capturedLabel(FOMOSCAN_CAPTURED, NOW)).toEqual({ text: "captured 5d ago", stale: true });
    expect(capturedLabel(FOMOSCAN_CAPTURED, NOW).text).not.toContain("read");
    expect(capturedLabel(NOW - 20 * 3_600_000, NOW)).toEqual({ text: "captured 20h ago", stale: false });
    expect(capturedLabel(NOW - 26 * 3_600_000, NOW).stale).toBe(true);
  });
  it("says there is no snapshot rather than implying a fresh one", () => {
    expect(capturedLabel(null, NOW)).toEqual({ text: "no snapshot", stale: true });
    expect(capturedLabel(Number.NaN, NOW)).toEqual({ text: "no snapshot", stale: true });
    expect(capturedLabel(PUMP_CAPTURED, Number.NaN)).toEqual({ text: "captured at an unknown time", stale: true });
  });
});

describe("populationLabel", () => {
  it("says the board is the top of a sweep, using the server's own denominator", () => {
    expect(populationLabel(coverage(), "fomoscan-traders", "24h")).toBe("top 100 of 316,007 wallets swept · sweep coverage 100% · ranked on net cash flow");
    const smaller = coverage({ boards: [{ board: "fomoscan-traders", window: "24h", capturedAt: FOMOSCAN_CAPTURED, count: 40, walletsRanked: 12_345, coverage: 0.482, observedAt: FOMOSCAN_OBSERVED }] });
    expect(populationLabel(smaller, "fomoscan-traders", "24h")).toBe("top 40 of 12,345 wallets swept · sweep coverage 48.2% · ranked on net cash flow");
  });
  it("drops the coverage clause rather than zeroing or guessing a unit for it", () => {
    const unpublished = coverage({ boards: [{ board: "fomoscan-traders", window: "24h", capturedAt: FOMOSCAN_CAPTURED, count: 40, walletsRanked: 12_345, coverage: null, observedAt: FOMOSCAN_OBSERVED }] });
    expect(populationLabel(unpublished, "fomoscan-traders", "24h")).toBe("top 40 of 12,345 wallets swept · ranked on net cash flow");
    const outOfRange = coverage({ boards: [{ board: "fomoscan-traders", window: "24h", capturedAt: FOMOSCAN_CAPTURED, count: 40, walletsRanked: 12_345, coverage: 48.2, observedAt: FOMOSCAN_OBSERVED }] });
    expect(populationLabel(outOfRange, "fomoscan-traders", "24h")).not.toContain("coverage");
  });
  it("names the number the ranking was taken on, which the rows cannot show", () => {
    // Live weekly pump ranks 1-4 read -$1.15K, +$9.58K, +$538.5K, +$1.29M realized: the order is on the sum, not this.
    expect(populationLabel(coverage(), "pump-traders", "weekly")).toContain("ranked on realized + unrealized");
    expect(populationLabel(coverage(), "fomoscan-traders", "7d")).toContain("ranked on net cash flow");
  });
  it("claims no denominator for a board that does not publish one", () => {
    expect(populationLabel(coverage(), "pump-traders", "weekly")).toBe("top 100 of a population this board does not publish · ranked on realized + unrealized");
  });
  it("says nothing has been read rather than showing an empty top", () => {
    expect(populationLabel(coverage(), "pump-traders", "daily")).toBe("no snapshot read for this board yet");
    expect(populationLabel(emptyCoverage(), "fomoscan-traders", "24h")).toBe("no snapshot read for this board yet");
  });
});

describe("namedLabel", () => {
  it("reports the named share per chain, with 0 of 9,019 robinhood as coverage, not an error", () => {
    expect(namedLabel(coverage())).toBe("named 1 of 594 solana · 0 of 9,019 robinhood wallets seen trading here");
  });
  it("says no wallets have been seen rather than naming zero of zero", () => {
    expect(namedLabel(emptyCoverage())).toBe("no wallets seen trading here yet");
    expect(namedLabel(coverage({ observedWallets: { solana: { seen: 0, named: 0 }, robinhood: { seen: 0, named: 0 } } }))).toBe("no wallets seen trading here yet");
  });
});

describe("budgetLabel", () => {
  it("stays quiet while the meter can still afford the next board read", () => {
    expect(budgetLabel(coverage())).toBeNull();
    expect(budgetLabel(emptyCoverage())).toBeNull();
  });
  it("says the budget is throttling, with the released and spent units", () => {
    const throttled = coverage({ budget: { period: "2026-09", spent: 2_500, budget: 25_000, allowance: 2_600, accountRemaining: 19_250, checkedAt: NOW }, refusedForBudget: 3 });
    const label = budgetLabel(throttled);
    expect(label).toContain("budget throttling");
    expect(label).toContain("2,500 CU spent of the 2,600 released so far in 2026-09");
    expect(label).toContain("250 CU board read waits");
    expect(label).toContain("3 board reads refused for budget since this server started");
  });
  it("says the account is exhausted when the balance cannot cover a 250 CU read", () => {
    const drained = coverage({ budget: { period: "2026-09", spent: 750, budget: 25_000, allowance: 2_600, accountRemaining: 100, checkedAt: NOW }, refusedForBudget: 1 });
    const label = budgetLabel(drained);
    expect(label).toContain("FomoScan balance exhausted");
    expect(label).toContain("100 CU left of the 2026-09 grant");
    // Attempts since boot, not lost snapshots: one unaffordable board is offered ~20 times an hour.
    expect(label).toContain("1 board read refused for budget since this server started");
    expect(label).not.toContain("1 board reads");
  });
  it("reports deferrals even when the meter itself has not been read", () => {
    expect(budgetLabel(coverage({ budget: null, refusedForBudget: 2 }))).toBe("2 board reads refused for budget since this server started");
    expect(budgetLabel(coverage({ budget: null }))).toBeNull();
  });
  it("does not treat an unread account balance as an exhausted one", () => {
    const unread = coverage({ budget: { period: "2026-09", spent: 750, budget: 25_000, allowance: 2_600, accountRemaining: null, checkedAt: null } });
    expect(budgetLabel(unread)).toBeNull();
  });
});
