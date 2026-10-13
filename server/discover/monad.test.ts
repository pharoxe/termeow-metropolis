import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoverRow, SmartCoverage } from "../../shared/wire.js";
import batch from "../sources/__fixtures__/r6/dexscreener-latest-tokens-batch.json";
import newPools from "../sources/__fixtures__/r6/gecko-new-pools.json";
import trending from "../sources/__fixtures__/r6/gecko-trending-pools.json";
import type { DexScreenerPair } from "../sources/dexscreener.js";
import type { TraderTapeRow } from "../traders/book.js";
import { DEXSCREENER_DISCOVERY_SOURCE } from "./dexscreenerLists.js";
import { GECKO_NEW_SOURCE, GECKO_TRENDING_SOURCE, type GeckoListRow } from "./geckoLists.js";
import { BOOK_SOURCE, DISCOVER_ROW_LIMIT, ERC20_SYMBOL_SOURCE, buildMonadDiscover, discoverMonad, resetDiscoverCache, type DiscoverTradersLike, type MonadDiscoverDeps } from "./monad.js";

const NOW = Date.parse("2026-09-07T14:20:00Z");
const ROBIN = "0x11b70d0243baf75e85ce03201a92b5b7c33beb59";
const GPU = "0xc9b5781714a370e74257450d279d57fb1afdfafe";
const UNLISTED = "0x9999000000000000000000000000000000000009";
const COVERAGE: SmartCoverage = { watched: 10, population: 12, label: "watching 10 of 12 SMART wallets · 3 named" };

function tapeRow(overrides: Partial<TraderTapeRow>): TraderTapeRow {
  return { chain: "monad", trader: "0xw1", handle: null, kind: "smart", token: ROBIN, pair: "p", tx: "0xt", side: "buy", usd: 10, time: NOW - 60_000, price: null, ...overrides };
}

function traders(tape: TraderTapeRow[], symbols: Record<string, string> = {}): DiscoverTradersLike & { tapeSpy: ReturnType<typeof vi.fn> } {
  const tapeSpy = vi.fn(() => tape);
  return { book: { tape: tapeSpy }, coverage: () => COVERAGE, erc20Meta: { get: (token) => (symbols[token] ? { symbol: symbols[token] } : null) }, tapeSpy };
}

function deps(overrides: Partial<MonadDiscoverDeps> = {}): MonadDiscoverDeps {
  return {
    now: () => NOW,
    geckoList: async (kind) => ({ value: (kind === "trending" ? trending.data : newPools.data) as GeckoListRow[], observedAt: NOW - 1_000, stale: false }),
    dexList: async () => ({ value: { requested: batch.requested as string[], pairs: batch.pairs as DexScreenerPair[] }, observedAt: NOW - 3_000, stale: false }),
    traders: () => null,
    ...overrides
  };
}

const find = (rows: DiscoverRow[], token: string) => rows.find((row) => row.token === token);

describe("buildMonadDiscover", () => {
  it("trending: Gecko's order leads, DexScreener-only tokens follow, every source keeps its own figures", async () => {
    const response = await buildMonadDiscover("trending", "24h", deps());
    expect(response).toMatchObject({ chain: "monad", view: "trending", window: "24h", observedAt: NOW, coverage: null });
    expect(response.stale).toBeUndefined();
    expect(response.error).toBeUndefined();
    expect(response.sources.map((source) => source.name)).toEqual([DEXSCREENER_DISCOVERY_SOURCE, GECKO_TRENDING_SOURCE]);
    expect(response.sources.map((source) => source.lastOkAt)).toEqual([NOW - 3_000, NOW - 1_000]);
    expect(response.rows[0].token).toBe(ROBIN);
    expect(response.rows[0].symbol).toBe("ROBIN");
    expect(response.rows[0].sources[0]).toMatchObject({ source: GECKO_TRENDING_SOURCE, rank: 0, volumeUsd: 2236013.44744839 });
    const geckoTokens = response.rows.filter((row) => row.sources.some((source) => source.source === GECKO_TRENDING_SOURCE));
    expect(geckoTokens.map((row) => row.sources.find((source) => source.source === GECKO_TRENDING_SOURCE)?.rank)).toEqual(geckoTokens.map((_, index) => index));
    expect(response.rows.every((row) => row.smartHolders === null)).toBe(true);
    expect(response.rows.length).toBeLessThanOrEqual(DISCOVER_ROW_LIMIT);
  });

  it("movers keeps only rows with a change figure, largest absolute move first; new uses the new_pools list", async () => {
    const movers = await buildMonadDiscover("movers", "24h", deps());
    expect(movers.rows.every((row) => row.changePct !== null)).toBe(true);
    const moves = movers.rows.map((row) => Math.abs(row.changePct as number));
    expect(moves).toEqual([...moves].sort((a, b) => b - a));
    const fresh = await buildMonadDiscover("new", "24h", deps());
    expect(fresh.sources.map((source) => source.name)).toContain(GECKO_NEW_SOURCE);
    expect(find(fresh.rows, GPU)).toMatchObject({ symbol: "GPU", marketCapUsd: null });
    const ages = fresh.rows.map((row) => row.ageMs).filter((age): age is number => age !== null);
    expect(ages).toEqual([...ages].sort((a, b) => a - b));
  });

  it("with an empty trader book smartHolders stays null on every row and holders answers no rows, coverage still attached", async () => {
    const response = await buildMonadDiscover("holders", "24h", deps({ traders: () => traders([]) }));
    expect(response.rows).toEqual([]);
    expect(response.coverage).toEqual(COVERAGE);
    const trendingResponse = await buildMonadDiscover("trending", "24h", deps({ traders: () => traders([]) }));
    expect(trendingResponse.rows.every((row) => row.smartHolders === null)).toBe(true);
  });

  it("holders ranks tokens by distinct verified-SMART buyers inside the window, naming unlisted tokens from erc20Meta", async () => {
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
    const day = await buildMonadDiscover("holders", "24h", deps({ traders: () => fake }));
    expect(fake.tapeSpy).toHaveBeenCalledWith("monad", expect.any(Number), { kind: "smart" });
    // Tie at 3 buyers each: ROBIN carries list volume and ranks first; the unlisted token has no figures at all.
    expect(day.rows.map((row) => [row.token, row.smartHolders])).toEqual([
      [ROBIN, 3],
      [UNLISTED, 3]
    ]);
    const unlisted = find(day.rows, UNLISTED) as DiscoverRow;
    expect(unlisted.symbol).toBe("UNL");
    expect(unlisted.sources.map((source) => source.source)).toEqual([BOOK_SOURCE, ERC20_SYMBOL_SOURCE]);
    expect(unlisted.priceUsd).toBeNull();
    const hour = await buildMonadDiscover("holders", "1h", deps({ traders: () => fake }));
    expect(find(hour.rows, ROBIN)?.smartHolders).toBe(2);
    const trendingResponse = await buildMonadDiscover("trending", "24h", deps({ traders: () => fake }));
    expect(find(trendingResponse.rows, GPU)).toBeUndefined();
    expect(trendingResponse.rows.find((row) => row.token !== ROBIN && row.token !== UNLISTED)?.smartHolders).toBe(0);
    expect(trendingResponse.coverage).toEqual(COVERAGE);
  });

  it("a provider that throws before any last-good answers rows from the others plus stale and error", async () => {
    const response = await buildMonadDiscover("trending", "24h", deps({ geckoList: async () => Promise.reject(new Error("GeckoTerminal backoff active after 429")) }));
    expect(response.stale).toBe(true);
    expect(response.error).toBe(`${GECKO_TRENDING_SOURCE}: GeckoTerminal backoff active after 429`);
    expect(response.sources.find((source) => source.name === GECKO_TRENDING_SOURCE)).toEqual({ name: GECKO_TRENDING_SOURCE, lastOkAt: null, lastError: "GeckoTerminal backoff active after 429", stale: true });
    expect(find(response.rows, ROBIN)).toBeUndefined();
    expect(response.rows.length).toBeGreaterThan(0);
  });

  it("a stale last-good provider is passed through as stale with its error and the old observedAt", async () => {
    const dexList: MonadDiscoverDeps["dexList"] = async () => ({ value: { requested: batch.requested as string[], pairs: batch.pairs as DexScreenerPair[] }, observedAt: NOW - 90_000, stale: true, error: "Upstream returned 503" });
    const response = await buildMonadDiscover("trending", "24h", deps({ dexList }));
    expect(response.stale).toBe(true);
    expect(response.error).toBe(`${DEXSCREENER_DISCOVERY_SOURCE}: Upstream returned 503`);
    expect(response.sources.find((source) => source.name === DEXSCREENER_DISCOVERY_SOURCE)).toEqual({ name: DEXSCREENER_DISCOVERY_SOURCE, lastOkAt: NOW - 90_000, lastError: "Upstream returned 503", stale: true });
  });

  it("every provider failing still answers 200-shaped: no rows, all errors joined", async () => {
    const boom = async () => Promise.reject(new Error("down"));
    const response = await buildMonadDiscover("new", "1h", deps({ geckoList: boom, dexList: boom }));
    expect(response.rows).toEqual([]);
    expect(response.error).toBe([`${DEXSCREENER_DISCOVERY_SOURCE}: down`, `${GECKO_NEW_SOURCE}: down`].join("; "));
  });

  it("a trader service that throws on access is treated as no book", async () => {
    const response = await buildMonadDiscover("trending", "24h", deps({ traders: () => { throw new Error("not built"); } }));
    expect(response.coverage).toBeNull();
    expect(response.rows[0].smartHolders).toBeNull();
  });
});

describe("discoverMonad cache", () => {
  beforeEach(() => resetDiscoverCache());

  it("asks the providers once per (view, window) inside the TTL", async () => {
    const geckoList = vi.fn(deps().geckoList as NonNullable<MonadDiscoverDeps["geckoList"]>);
    const d = deps({ geckoList });
    await discoverMonad("trending", "24h", d);
    await discoverMonad("trending", "24h", d);
    await discoverMonad("movers", "24h", d);
    await discoverMonad("trending", "1h", d);
    expect(geckoList).toHaveBeenCalledTimes(3);
    expect(geckoList.mock.calls.every(([kind]) => kind === "trending")).toBe(true);
  });
});
