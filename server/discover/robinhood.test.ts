import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoverRow, FomoCoverage } from "../../shared/wire.js";
import batch from "../sources/__fixtures__/r6/dexscreener-latest-tokens-batch.json";
import newPools from "../sources/__fixtures__/r6/gecko-new-pools.json";
import trending from "../sources/__fixtures__/r6/gecko-trending-pools.json";
import trench1h from "../sources/__fixtures__/r6/trenches-tokens-1h.json";
import trench24h from "../sources/__fixtures__/r6/trenches-tokens-24h.json";
import type { DexScreenerPair } from "../sources/dexscreener.js";
import { TRENCHES_SOURCE, normalizeTrenchToken, type TrenchToken, type TrenchTokensResult } from "../sources/trenches.js";
import type { TraderTapeRow } from "../traders/book.js";
import { DEXSCREENER_DISCOVERY_SOURCE } from "./dexscreenerLists.js";
import { GECKO_NEW_SOURCE, GECKO_TRENDING_SOURCE, type GeckoListRow } from "./geckoLists.js";
import { BOOK_SOURCE, DISCOVER_ROW_LIMIT, ERC20_SYMBOL_SOURCE, buildRobinhoodDiscover, discoverRobinhood, resetDiscoverCache, type DiscoverTradersLike, type RobinhoodDiscoverDeps } from "./robinhood.js";
import { trenchPartial } from "./trenchesList.js";

const NOW = Date.parse("2026-09-07T14:20:00Z");
const ROBIN = "0x11b70d0243baf75e85ce03201a92b5b7c33beb59";
const GPU = "0xc9b5781714a370e74257450d279d57fb1afdfafe";
const STONKSCAT = "0x7f908bd33e0d786039c73b144c675ca5f0e0b56f";
const XXX = "0xd79006843543b5ce041e489c79539e02eaa373cd";
const UNLISTED = "0x9999000000000000000000000000000000000009";
const COVERAGE: FomoCoverage = { watched: 10, population: 12, label: "watching 10 of 12 FOMO wallets · 3 named" };

const trenchRows = (rows: unknown[]) => rows.map(normalizeTrenchToken).filter((row): row is TrenchToken => row !== null);
const trenchResult = (window: "1h" | "24h", rows: TrenchToken[], extra: Partial<TrenchTokensResult> = {}): TrenchTokensResult => ({ rows, source: TRENCHES_SOURCE, window, observedAt: NOW - 2_000, stale: false, ...extra });

function tapeRow(overrides: Partial<TraderTapeRow>): TraderTapeRow {
  return { chain: "robinhood", trader: "0xw1", handle: null, kind: "fomo", token: ROBIN, pair: "p", tx: "0xt", side: "buy", usd: 10, time: NOW - 60_000, price: null, ...overrides };
}

function traders(tape: TraderTapeRow[], symbols: Record<string, string> = {}): DiscoverTradersLike & { tapeSpy: ReturnType<typeof vi.fn> } {
  const tapeSpy = vi.fn(() => tape);
  return { book: { tape: tapeSpy }, coverage: () => COVERAGE, erc20Meta: { get: (token) => (symbols[token] ? { symbol: symbols[token] } : null) }, tapeSpy };
}

function deps(overrides: Partial<RobinhoodDiscoverDeps> = {}): RobinhoodDiscoverDeps {
  return {
    now: () => NOW,
    geckoList: async (kind) => ({ value: (kind === "trending" ? trending.data : newPools.data) as GeckoListRow[], observedAt: NOW - 1_000, stale: false }),
    dexList: async () => ({ value: { requested: batch.requested as string[], pairs: batch.pairs as DexScreenerPair[] }, observedAt: NOW - 3_000, stale: false }),
    trenches: async (window) => trenchResult(window, trenchRows(window === "1h" ? trench1h.rows : trench24h.rows)),
    traders: () => null,
    ...overrides
  };
}

const find = (rows: DiscoverRow[], token: string) => rows.find((row) => row.token === token);

describe("trenchPartial", () => {
  const [xxx] = trenchRows([trench24h.rows[0]]);
  const [stonks] = trenchRows([trench1h.rows[0]]);

  it("maps 24h site figures with the site's tracked buyers and a pair-creation age", () => {
    expect(trenchPartial(xxx, "24h", NOW, NOW - 1, false)).toMatchObject({
      token: XXX,
      source: TRENCHES_SOURCE,
      symbol: "XXX",
      priceUsd: 1.981e-11,
      marketCapUsd: null,
      liquidityUsd: 0,
      volumeUsd: 14857.61,
      changePct: -100,
      txns: { buys: 41, sells: 1 },
      ageMs: NOW - 1788760991 * 1000,
      trackedBuyers: 36,
      pool: null,
      dex: null,
      fomoHolders: null
    });
  });

  it("under a 1h window leaves the 24h-only figures null rather than passing them off as hourly", () => {
    expect(trenchPartial(xxx, "1h", NOW, NOW, false)).toMatchObject({ volumeUsd: null, changePct: null, txns: null, priceUsd: 1.981e-11 });
    expect(trenchPartial(stonks, "1h", NOW, NOW, false)).toMatchObject({ token: STONKSCAT, symbol: "stonkscat", priceUsd: null, ageMs: NOW - 1788785040 * 1000, trackedBuyers: 36 });
  });
});

describe("buildRobinhoodDiscover", () => {
  it("trending: Gecko's order leads, DexScreener-only and trenches-only tokens follow, every source keeps its own figures", async () => {
    const response = await buildRobinhoodDiscover("trending", "24h", deps());
    expect(response).toMatchObject({ chain: "robinhood", view: "trending", window: "24h", observedAt: NOW, coverage: null });
    expect(response.stale).toBeUndefined();
    expect(response.error).toBeUndefined();
    expect(response.sources.map((source) => source.name)).toEqual([DEXSCREENER_DISCOVERY_SOURCE, GECKO_TRENDING_SOURCE, TRENCHES_SOURCE]);
    expect(response.sources.map((source) => source.lastOkAt)).toEqual([NOW - 3_000, NOW - 1_000, NOW - 2_000]);
    expect(response.rows[0].token).toBe(ROBIN);
    expect(response.rows[0].symbol).toBe("ROBIN");
    expect(response.rows[0].sources[0]).toMatchObject({ source: GECKO_TRENDING_SOURCE, rank: 0, volumeUsd: 2236013.44744839 });
    const geckoTokens = response.rows.filter((row) => row.sources.some((source) => source.source === GECKO_TRENDING_SOURCE));
    expect(geckoTokens.map((row) => row.sources.find((source) => source.source === GECKO_TRENDING_SOURCE)?.rank)).toEqual(geckoTokens.map((_, index) => index));
    const xxx = find(response.rows, XXX);
    expect(xxx?.sources.map((source) => source.source)).toEqual([TRENCHES_SOURCE]);
    expect(xxx?.fomoHolders).toBeNull();
    expect(response.rows.length).toBeLessThanOrEqual(DISCOVER_ROW_LIMIT);
  });

  it("movers keeps only rows with a change figure, largest absolute move first; new uses the new_pools list", async () => {
    const movers = await buildRobinhoodDiscover("movers", "24h", deps());
    expect(movers.rows.every((row) => row.changePct !== null)).toBe(true);
    const moves = movers.rows.map((row) => Math.abs(row.changePct as number));
    expect(moves).toEqual([...moves].sort((a, b) => b - a));
    const fresh = await buildRobinhoodDiscover("new", "24h", deps());
    expect(fresh.sources.map((source) => source.name)).toContain(GECKO_NEW_SOURCE);
    expect(find(fresh.rows, GPU)).toMatchObject({ symbol: "GPU", marketCapUsd: null });
    const ages = fresh.rows.map((row) => row.ageMs).filter((age): age is number => age !== null);
    expect(ages).toEqual([...ages].sort((a, b) => a - b));
  });

  it("reports disagreement between two sources' figures instead of averaging them", async () => {
    const rows = trenchRows(trench24h.rows);
    const robinRow: TrenchToken = { ...rows[0], address: ROBIN, symbol: "ROBIN", priceUsd: 0.02, volume24Usd: 1_000 };
    const response = await buildRobinhoodDiscover("trending", "24h", deps({ trenches: async () => trenchResult("24h", [robinRow]) }));
    const robin = find(response.rows, ROBIN) as DiscoverRow;
    expect(robin.priceUsd).toBe(0.0121723554875435);
    expect(robin.disputed).toEqual(expect.arrayContaining(["priceUsd", "volumeUsd"]));
    expect(robin.sources.map((source) => [source.source, source.priceUsd])).toEqual([
      [GECKO_TRENDING_SOURCE, 0.0121723554875435],
      [TRENCHES_SOURCE, 0.02]
    ]);
  });

  it("with an empty trader book fomoHolders stays null on every row and holders answers no rows, coverage still attached", async () => {
    const response = await buildRobinhoodDiscover("holders", "24h", deps({ traders: () => traders([]) }));
    expect(response.rows).toEqual([]);
    expect(response.coverage).toEqual(COVERAGE);
    const trendingResponse = await buildRobinhoodDiscover("trending", "24h", deps({ traders: () => traders([]) }));
    expect(trendingResponse.rows.every((row) => row.fomoHolders === null)).toBe(true);
  });

  it("holders ranks tokens by distinct verified-FOMO buyers inside the window, naming unlisted tokens from erc20Meta", async () => {
    const tape = [
      tapeRow({ trader: "0xw1" }),
      tapeRow({ trader: "0xw2" }),
      tapeRow({ trader: "0xw2", side: "sell" }),
      tapeRow({ trader: "0xw3", time: NOW - 2 * 3_600_000 }),
      tapeRow({ token: UNLISTED, trader: "0xw1" }),
      tapeRow({ token: UNLISTED, trader: "0xw4" }),
      tapeRow({ token: UNLISTED, trader: "0xw5" }),
      tapeRow({ token: UNLISTED, trader: "0xw6", side: "sell" })
    ];
    const fake = traders(tape, { [UNLISTED]: "UNL" });
    const day = await buildRobinhoodDiscover("holders", "24h", deps({ traders: () => fake }));
    expect(fake.tapeSpy).toHaveBeenCalledWith("robinhood", expect.any(Number), { kind: "fomo" });
    // Tie at 3 buyers each: ROBIN carries list volume and ranks first; the unlisted token has no figures at all.
    expect(day.rows.map((row) => [row.token, row.fomoHolders])).toEqual([
      [ROBIN, 3],
      [UNLISTED, 3]
    ]);
    const unlisted = find(day.rows, UNLISTED) as DiscoverRow;
    expect(unlisted.symbol).toBe("UNL");
    expect(unlisted.sources.map((source) => source.source)).toEqual([BOOK_SOURCE, ERC20_SYMBOL_SOURCE]);
    expect(unlisted.priceUsd).toBeNull();
    const hour = await buildRobinhoodDiscover("holders", "1h", deps({ traders: () => fake }));
    expect(find(hour.rows, ROBIN)?.fomoHolders).toBe(2);
    const trendingResponse = await buildRobinhoodDiscover("trending", "24h", deps({ traders: () => fake }));
    expect(find(trendingResponse.rows, GPU)).toBeUndefined();
    expect(find(trendingResponse.rows, XXX)?.fomoHolders).toBe(0);
    expect(trendingResponse.coverage).toEqual(COVERAGE);
  });

  it("a provider that throws before any last-good answers rows from the others plus stale and error", async () => {
    const response = await buildRobinhoodDiscover("trending", "24h", deps({ geckoList: async () => Promise.reject(new Error("GeckoTerminal backoff active after 429")) }));
    expect(response.stale).toBe(true);
    expect(response.error).toBe(`${GECKO_TRENDING_SOURCE}: GeckoTerminal backoff active after 429`);
    expect(response.sources.find((source) => source.name === GECKO_TRENDING_SOURCE)).toEqual({ name: GECKO_TRENDING_SOURCE, lastOkAt: null, lastError: "GeckoTerminal backoff active after 429", stale: true });
    expect(find(response.rows, ROBIN)).toBeUndefined();
    expect(response.rows.length).toBeGreaterThan(0);
  });

  it("a stale last-good provider is passed through as stale with its error and the old observedAt", async () => {
    const response = await buildRobinhoodDiscover("trending", "24h", deps({ trenches: async (window) => trenchResult(window, trenchRows(trench24h.rows), { stale: true, error: "Upstream returned 503" }) }));
    expect(response.stale).toBe(true);
    expect(response.error).toBe(`${TRENCHES_SOURCE}: Upstream returned 503`);
    expect(find(response.rows, XXX)?.sources[0]).toMatchObject({ stale: true, lastOkAt: NOW - 2_000 });
  });

  it("every provider failing still answers 200-shaped: no rows, all errors joined", async () => {
    const boom = async () => Promise.reject(new Error("down"));
    const response = await buildRobinhoodDiscover("new", "1h", deps({ geckoList: boom, dexList: boom, trenches: boom }));
    expect(response.rows).toEqual([]);
    expect(response.error).toBe([`${DEXSCREENER_DISCOVERY_SOURCE}: down`, `${GECKO_NEW_SOURCE}: down`, `${TRENCHES_SOURCE}: down`].join("; "));
  });

  it("a trader service that throws on access is treated as no book", async () => {
    const response = await buildRobinhoodDiscover("trending", "24h", deps({ traders: () => { throw new Error("not built"); } }));
    expect(response.coverage).toBeNull();
    expect(response.rows[0].fomoHolders).toBeNull();
  });
});

describe("discoverRobinhood cache", () => {
  beforeEach(() => resetDiscoverCache());

  it("asks the providers once per (view, window) inside the TTL", async () => {
    const geckoList = vi.fn(deps().geckoList as NonNullable<RobinhoodDiscoverDeps["geckoList"]>);
    const d = deps({ geckoList });
    await discoverRobinhood("trending", "24h", d);
    await discoverRobinhood("trending", "24h", d);
    await discoverRobinhood("movers", "24h", d);
    await discoverRobinhood("trending", "1h", d);
    expect(geckoList).toHaveBeenCalledTimes(3);
    expect(geckoList.mock.calls.every(([kind]) => kind === "trending")).toBe(true);
  });
});
