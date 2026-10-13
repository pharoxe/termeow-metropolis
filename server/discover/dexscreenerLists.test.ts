import { afterEach, describe, expect, it, vi } from "vitest";
import batch from "../sources/__fixtures__/r6/dexscreener-latest-tokens-batch.json";
import boostsFixture from "../sources/__fixtures__/r6/dexscreener-token-boosts-top.json";
import profilesFixture from "../sources/__fixtures__/r6/dexscreener-token-profiles-latest.json";
import type { DexScreenerPair } from "../sources/dexscreener.js";
import { normalizeProfile, type TokenProfile } from "../sources/dexscreenerProfiles.js";
import { resetTokenBatchCache } from "../sources/dexscreenerTokens.js";
import { DEXSCREENER_DISCOVERY_SOURCE, DEXSCREENER_LIST_MAX, dexScreenerListPartials, discoveryAddresses, fetchDexScreenerList, normalizeDexScreenerPair } from "./dexscreenerLists.js";

const NOW = Date.parse("2026-09-07T14:20:00Z");
const profiles = profilesFixture.items.map(normalizeProfile).filter((row): row is TokenProfile => row !== null);
const boosts = boostsFixture.items.map(normalizeProfile).filter((row): row is TokenProfile => row !== null);
const pairs = batch.pairs as DexScreenerPair[];
const requested = batch.requested as string[];
const MARSCOIN = "0x56e82e94b1354c771f5901e4af7ee4f1b08d4011";

describe("discoveryAddresses", () => {
  it("unions profiles and boosts, lowercased, deduped, profiles first, capped to one call", () => {
    const addresses = discoveryAddresses("monad", profiles, boosts);
    expect(addresses.length).toBeLessThanOrEqual(DEXSCREENER_LIST_MAX);
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(addresses.every((address) => /^0x[0-9a-f]{40}$/.test(address))).toBe(true);
    expect(addresses[0]).toBe(profiles[0].address.toLowerCase());
    expect(addresses).toContain("0xfd1c237b46d03a614ebd69a51455dce3a0ce4487");
  });

  it("drops other chains", () => {
    const other = { ...profiles[0], chain: "solana", address: "So11111111111111111111111111111111111111112" } as unknown as TokenProfile;
    expect(discoveryAddresses("monad", [other], [])).toEqual([]);
  });
});

describe("fetchDexScreenerList", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetTokenBatchCache();
  });

  it("asks the shared /tokens/v1 fetcher once for the feeds' addresses and hands back its pairs with provenance", async () => {
    const spy = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify(pairs), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", spy);
    const feeds = { profiles: async () => profiles, boosts: async () => boosts };
    const first = await fetchDexScreenerList("monad", feeds);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toMatch(/^https:\/\/api\.dexscreener\.com\/tokens\/v1\/monad\//);
    expect(first.stale).toBe(false);
    expect(first.value.requested).toEqual(discoveryAddresses("monad", profiles, boosts));
    expect(dexScreenerListPartials("monad", first.value, "24h", NOW, first.observedAt, first.stale).length).toBeGreaterThan(0);
    // the launch enrichment and a second discovery read within 60 s reuse the same cached call
    await fetchDexScreenerList("monad", feeds);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await fetchDexScreenerList("monad", { profiles: async () => [], boosts: async () => [] })).value).toEqual({ requested: [], pairs: [] });
  });
});

describe("normalizeDexScreenerPair", () => {
  const marscoin = pairs.find((pair) => pair.pairAddress === "0xc0552ac30c13d77b9dfd3a04738670c7d041f98ebdd603485cce37de07751fc1") as DexScreenerPair;

  it("maps the 24h window from the pair with symbol, name, per-pool figures and age", () => {
    const partial = normalizeDexScreenerPair(MARSCOIN.toUpperCase(), marscoin, "24h", NOW, NOW - 1, false);
    expect(partial).toMatchObject({
      token: MARSCOIN,
      source: DEXSCREENER_DISCOVERY_SOURCE,
      symbol: "MARSCOIN",
      name: "MarsCoin",
      priceUsd: 0.00004838,
      marketCapUsd: 48387,
      liquidityUsd: 20757.61,
      volumeUsd: 493866.75,
      changePct: -11.13,
      txns: { buys: 3201, sells: 2420 },
      ageMs: NOW - 1788703544000,
      pool: "0xc0552ac30c13d77b9dfd3a04738670c7d041f98ebdd603485cce37de07751fc1",
      dex: "uniswap",
      rank: null
    });
  });

  it("maps the 1h window from h1 keys", () => {
    expect(normalizeDexScreenerPair(MARSCOIN, marscoin, "1h", NOW, NOW, false)).toMatchObject({ volumeUsd: 3895.6, changePct: -17, txns: { buys: 26, sells: 30 } });
  });

  it("leaves symbol, name, pool and age null when the pair lacks them", () => {
    const partial = normalizeDexScreenerPair(MARSCOIN, { chainId: "monad", baseToken: { address: MARSCOIN } }, "24h", NOW, null, true);
    expect(partial).toMatchObject({ symbol: null, name: null, pool: null, dex: null, ageMs: null, priceUsd: null, txns: null, stale: true, lastOkAt: null });
  });
});

describe("dexScreenerListPartials", () => {
  it("yields one partial per listed token; the unlisted requested address is absent, not a blank row", () => {
    const partials = dexScreenerListPartials("monad", { requested, pairs }, "24h", NOW, NOW, false);
    expect(partials).toHaveLength(9);
    expect(new Set(partials.map((partial) => partial.token)).size).toBe(9);
    expect(partials.every((partial) => partial.symbol !== null)).toBe(true);
  });
});
