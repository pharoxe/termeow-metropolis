import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { TraderKind } from "../../shared/wire.js";
import { TraderBook, type TraderFill } from "../traders/book.js";
import type { HandleEntry } from "../traders/handles.js";
import { FOMO_POPULATION_LABEL, SEEDED_POPULATION_LABEL, type TraderServiceStatus } from "../traders/service.js";
import {
  FOMO_TAPE_DEFAULT,
  FOMO_WINDOW_MS,
  buildFomoBoardResponse,
  buildFomoStatusResponse,
  buildFomoTapeResponse,
  fomoBoardQuerySchema,
  fomoTapeQuerySchema,
  truncatedAt,
  type FomoRouteDeps,
  type FomoTradersLike
} from "./fomo.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const FOMO_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FOMO_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER = "0xcccccccccccccccccccccccccccccccccccccccc";
/** unipcs on the robinhoodtrenches traders list (fixture r4/trenches-traders.json), 7702 check not yet answered. */
const SEEDED = "0x0a6ebed0155edb4b21d92ad02897a626cd90119e";
const TOKEN = "0x1111111111111111111111111111111111111111";

function fill(trader: string, kind: TraderKind, tx: string, side: "buy" | "sell", usd: number | null, ageMs: number, extra: Partial<TraderFill> = {}): TraderFill {
  return { chain: "robinhood", pair: "0xpool", tx, time: NOW - ageMs, side, usd, source: "own", trader, token: TOKEN, kind, handle: null, followers: null, ...extra };
}

function seeded(): TraderBook {
  const book = new TraderBook({ now: () => NOW });
  book.recordAll([
    fill(FOMO_A, "fomo", "0x1", "buy", 500, 30 * 60_000, { handle: "alpha", followers: 42 }),
    fill(FOMO_A, "fomo", "0x2", "sell", 700, 20 * 60_000),
    fill(FOMO_B, "fomo", "0x3", "buy", 100, 5 * HOUR, { pair: "pons:0xcurve" }),
    fill(OTHER, "other", "0x4", "buy", 9_000, 60_000),
    fill(SEEDED, "seeded", "0x5", "buy", 250, 25 * 60_000, { handle: "unipcs", followers: 514_576 })
  ]);
  return book;
}

const SOURCE_STATUS = { rows: 0, lastOkAt: null, lastError: null };
const STATUS: TraderServiceStatus = {
  population: { classified: 2, seeded: 1, seedQueue: 1, seededLabel: SEEDED_POPULATION_LABEL },
  populationLabel: FOMO_POPULATION_LABEL,
  handles: { entries: 1, population: "robinhoodtrenches handles", traders: SOURCE_STATUS, tape: SOURCE_STATUS, learned: 0 },
  classifier: { calls: 9, rateLimited: 1 },
  receipts: { calls: 4, rateLimited: 0 },
  book: { wallets: 3, fills: 4 },
  fomoLedger: { pairs: 1, buckets: 2 },
  counters: { annotated: 1, fomo: 1, other: 0, noMeta: 0, noReceipt: 2, unattributed: 0, ambiguous: 0, deadlined: 3, late: 1, classifyFailed: 1, classifyDeferred: 0, discoverChecked: 5, discoverDropped: 0, seedChecked: 0, seedFomo: 0, seedFailed: 0, seedReingested: 0, transferFills: 0, transferUnproven: 0 },
  transfers: null,
  erc20Meta: { cached: 0, pending: 0, resolved: 0, failed: 0, lastError: null, rpc: null },
  lastError: null
};

/** Shape TraderService.coverage() answers: legs watching 2 of a 3-wallet population, 1 named. */
const COVERAGE = { watched: 2, population: 3, label: "watching 2 of 3 FOMO wallets · 1 named" };
const EMPTY_COVERAGE = { watched: 0, population: 0, label: "watching 0 of 0 FOMO wallets · 0 named" };

function traders(book = seeded()): FomoTradersLike & { population: Set<string> } {
  const handles: Record<string, HandleEntry> = { [FOMO_A]: { handle: "alpha", followers: 42, profileUrl: "https://fomo.family/profile/alpha", source: "traders" } };
  return {
    book,
    population: new Set([FOMO_A, FOMO_B]),
    handles: { get: (address) => handles[address] ?? null, stats: () => ({ entries: 1 }) },
    coverage: () => COVERAGE,
    dexOf: (_chain, pair) => (pair.startsWith("pons:") ? "pons" : "uniswap"),
    status: () => STATUS
  };
}

function deps(overrides: Partial<FomoRouteDeps> = {}): FomoRouteDeps {
  return { traders: traders(), symbolOf: (_chain, token) => (token === TOKEN ? "MEME" : null), now: () => NOW, ...overrides };
}

describe("query schemas", () => {
  it("default to all chains, 60 rows and the 24h window; reject junk", () => {
    expect(fomoTapeQuerySchema.parse({})).toEqual({ chain: "all", limit: FOMO_TAPE_DEFAULT });
    expect(fomoTapeQuerySchema.parse({ chain: "robinhood", limit: "5" })).toEqual({ chain: "robinhood", limit: 5 });
    expect(() => fomoTapeQuerySchema.parse({ limit: "0" })).toThrow(ZodError);
    expect(() => fomoTapeQuerySchema.parse({ chain: "base" })).toThrow(ZodError);
    expect(fomoBoardQuerySchema.parse({})).toEqual({ chain: "all", window: "24h" });
    expect(() => fomoBoardQuerySchema.parse({ window: "30d" })).toThrow(ZodError);
  });
});

describe("buildFomoTapeResponse", () => {
  it("lists FOMO and seeded fills newest first with dex, symbol, handle and followers, never the other-kind fill", () => {
    const response = buildFomoTapeResponse({ chain: "all", limit: 10 }, deps());
    expect(response.error).toBeUndefined();
    expect(response).toMatchObject({ chain: "all", population: 2, handles: 1, coverage: COVERAGE, observedAt: NOW });
    expect(response.fills.map((f) => f.tx)).toEqual(["0x2", "0x5", "0x1", "0x3"]);
    expect(response.fills[1].trader).toEqual({ address: SEEDED, kind: "seeded", handle: "unipcs", followers: null });
    expect(response.fills.some((f) => f.trader.address === OTHER)).toBe(false);
    expect(response.fills[0]).toEqual({
      chain: "robinhood",
      token: TOKEN,
      pair: "0xpool",
      dex: "uniswap",
      tx: "0x2",
      time: NOW - 20 * 60_000,
      side: "sell",
      usd: 700,
      trader: { address: FOMO_A, kind: "fomo", handle: "alpha", followers: 42 },
      symbol: "MEME"
    });
    expect(response.fills[3]).toMatchObject({ dex: "pons", trader: { address: FOMO_B, handle: null, followers: null } });
    expect(buildFomoTapeResponse({ chain: "solana", limit: 10 }, deps()).fills).toEqual([]);
    expect(buildFomoTapeResponse({ chain: "all", limit: 1 }, deps()).fills).toHaveLength(1);
  });

  it("keeps the 200 + error contract when the book throws", () => {
    const broken = traders();
    broken.book.tape = () => {
      throw new Error("ring exploded");
    };
    const response = buildFomoTapeResponse({ chain: "all", limit: 10 }, deps({ traders: broken }));
    expect(response).toMatchObject({ fills: [], population: 0, handles: 0, coverage: EMPTY_COVERAGE, stale: true, error: "tape: ring exploded", observedAt: NOW });
  });
});

describe("buildFomoBoardResponse", () => {
  it("ranks FOMO wallets by net flow over the window with the population label and profile links", () => {
    const response = buildFomoBoardResponse({ chain: "all", window: "24h" }, deps());
    expect(response.error).toBeUndefined();
    expect(response).toMatchObject({ chain: "all", window: "24h", population: 2, populationLabel: FOMO_POPULATION_LABEL, coverage: COVERAGE, observedAt: NOW });
    expect(response.rows.map((row) => [row.wallet, row.netUsd, row.kind])).toEqual([
      [SEEDED, 250, "seeded"],
      [FOMO_B, 100, "fomo"],
      [FOMO_A, -200, "fomo"]
    ]);
    expect(response.rows[0]).toMatchObject({ handle: "unipcs", followers: 514_576, kind: "seeded", profileUrl: `https://fomo.family/profile/unipcs` });
    expect(response.rows[2]).toMatchObject({ handle: "alpha", followers: 42, fills: 2, buyUsd: 500, sellUsd: 700, unpriced: 0, closed: 1, wins: 1, wilsonLow: null, profileUrl: "https://fomo.family/profile/alpha" });
    expect(response.rows[1].profileUrl).toBeNull();
    expect(response.rows.some((row) => row.wallet === OTHER)).toBe(false);
  });

  it("narrows by window and reports where the ring truncates a longer window", () => {
    const hour = buildFomoBoardResponse({ chain: "all", window: "1h" }, deps());
    expect(hour.rows.map((row) => row.wallet)).toEqual([SEEDED, FOMO_A]);
    expect(hour.truncatedAt).toBeNull();
    const week = buildFomoBoardResponse({ chain: "all", window: "7d" }, deps());
    expect(week.truncatedAt).toBe(NOW - 5 * HOUR);
    expect(truncatedAt(null, FOMO_WINDOW_MS["7d"], NOW)).toBeNull();
    expect(truncatedAt(NOW - 10 * 24 * HOUR, FOMO_WINDOW_MS["7d"], NOW)).toBeNull();
  });

  it("keeps the 200 + error contract when rank throws", () => {
    const broken = traders();
    broken.book.rank = () => {
      throw new Error("no rank");
    };
    expect(buildFomoBoardResponse({ chain: "robinhood", window: "1h" }, deps({ traders: broken }))).toMatchObject({ rows: [], population: 0, truncatedAt: null, coverage: EMPTY_COVERAGE, stale: true, error: "board: no rank" });
  });
});

describe("buildFomoStatusResponse", () => {
  it("passes the service status through verbatim with observedAt", () => {
    expect(buildFomoStatusResponse(deps())).toEqual({ status: STATUS, observedAt: NOW });
    expect(buildFomoStatusResponse(deps()).status?.counters).toMatchObject({ deadlined: 3, late: 1, classifyFailed: 1 });
  });

  it("keeps the 200 + error contract when status throws", () => {
    const broken = traders();
    broken.status = () => {
      throw new Error("no status");
    };
    expect(buildFomoStatusResponse(deps({ traders: broken }))).toEqual({ status: null, observedAt: NOW, stale: true, error: "status: no status" });
  });
});
