import { afterEach, describe, expect, it, vi } from "vitest";
import type { PairRow } from "../../shared/wire.js";
import {
  LAUNCHPAD_SOURCE,
  buildRegistry,
  getRegistry,
  isLaunchpadRow,
  resetRegistryCache,
  type RegistryDeps,
  type RegistryPool
} from "./registry.js";

const MINT = "0x9c00000000000000000000000000000000000001";

function dexRow(pairAddress: string, volume24Usd: number | null, extra: Partial<PairRow> = {}): PairRow {
  return {
    chain: "monad",
    dex: "kuru",
    pairAddress,
    baseMint: MINT,
    quoteMint: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a",
    liquidityUsd: 1000,
    volume24Usd,
    share24: null,
    txns: { m5: { buys: 1, sells: 2 }, h1: null, h6: null, h24: null },
    tier: "B",
    sources: ["dexscreener"],
    ...extra
  };
}

function pool(pairAddress: string, volume24Usd: number | null, dex = "uniswap", liquidityUsd: number | null = 500): RegistryPool {
  return { dex, pairAddress, liquidityUsd, volume24Usd };
}

function build(dexPairs: PairRow[], geckoPools: RegistryPool[] = []) {
  return buildRegistry({ chain: "monad", address: MINT, dexPairs, geckoPools });
}

function byAddress(pairs: PairRow[], address: string): PairRow {
  const found = pairs.find((pair) => pair.pairAddress.toLowerCase() === address.toLowerCase());
  if (!found) throw new Error(`missing ${address}`);
  return found;
}

afterEach(() => {
  vi.useRealTimers();
  resetRegistryCache();
});

describe("buildRegistry union/merge", () => {
  it("unions by lowercase pairAddress and merges sources", () => {
    const pairs = build([dexRow("AbC", 100)], [pool("abc", 999, "uniswap")]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].pairAddress).toBe("AbC");
    expect(pairs[0].sources).toEqual(["dexscreener", "geckoterminal"]);
  });

  it("prefers DexScreener numbers and fills gaps from Gecko", () => {
    const pairs = build([dexRow("p1", 100, { liquidityUsd: null, dex: "unknown" })], [pool("p1", 999, "uniswap", 77)]);
    expect(pairs[0].volume24Usd).toBe(100);
    expect(pairs[0].liquidityUsd).toBe(77);
    expect(pairs[0].dex).toBe("uniswap");
    expect(pairs[0].txns.m5).toEqual({ buys: 1, sells: 2 });
  });

  it("keeps Gecko-only pools with the token as baseMint", () => {
    const pairs = build([], [pool("g1", 10), pool("g2", 5)]);
    expect(pairs.map((pair) => pair.pairAddress)).toEqual(["g1", "g2"]);
    expect(pairs.every((pair) => pair.baseMint === MINT && pair.chain === "monad")).toBe(true);
    expect(byAddress(pairs, "g1").sources).toEqual(["geckoterminal"]);
  });

  it("does not mutate the input rows", () => {
    const input = dexRow("p1", 100);
    const snapshot = JSON.stringify(input);
    build([input], [pool("p1", 1)]);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("buildRegistry share math", () => {
  it("computes share24 as volume / total over known volumes", () => {
    const pairs = build([dexRow("a", 60), dexRow("b", 40)]);
    expect(byAddress(pairs, "a").share24).toBeCloseTo(0.6, 12);
    expect(byAddress(pairs, "b").share24).toBeCloseTo(0.4, 12);
  });

  it("leaves share24 null for pairs with unknown volume and when the total is 0 or unknown", () => {
    const mixed = build([dexRow("a", 10), dexRow("b", null)]);
    expect(byAddress(mixed, "a").share24).toBe(1);
    expect(byAddress(mixed, "b").share24).toBeNull();
    expect(build([dexRow("a", 0), dexRow("b", 0)]).every((pair) => pair.share24 === null)).toBe(true);
    expect(build([dexRow("a", null)]).every((pair) => pair.share24 === null)).toBe(true);
  });
});

describe("buildRegistry tiering", () => {
  it("sorts by volume desc and takes the smallest prefix reaching exactly 95%", () => {
    const pairs = build([dexRow("small", 5), dexRow("big", 50), dexRow("mid", 45)]);
    expect(pairs.map((pair) => pair.pairAddress)).toEqual(["big", "mid", "small"]);
    expect(pairs.map((pair) => pair.tier)).toEqual(["A", "A", "B"]);
  });

  it("includes the pair that crosses 95% when the prefix before it is short", () => {
    const pairs = build([dexRow("a", 50), dexRow("b", 44), dexRow("c", 6)]);
    expect(pairs.map((pair) => pair.tier)).toEqual(["A", "A", "A"]);
  });

  it("caps Tier A at 4 pairs even when 95% is not reached", () => {
    const pairs = build(["a", "b", "c", "d", "e", "f"].map((address) => dexRow(address, 10)));
    expect(pairs.filter((pair) => pair.tier === "A")).toHaveLength(4);
    expect(pairs.slice(4).every((pair) => pair.tier === "B")).toBe(true);
  });

  it("stops at the first pair once 95% is reached, before the cap", () => {
    const pairs = build([dexRow("a", 96), dexRow("b", 2), dexRow("c", 2)]);
    expect(pairs.map((pair) => pair.tier)).toEqual(["A", "B", "B"]);
  });

  it("never tiers unknown-share pairs", () => {
    const pairs = build([dexRow("a", null), dexRow("b", null)]);
    expect(pairs.every((pair) => pair.tier === "B")).toBe(true);
  });
});

describe("buildRegistry launchpad pseudo-pairs", () => {
  const CURVE = "nadfun:0x9a6d239adb8ccf1e9eb8f0722cfac6bbda410b7b";
  const launchpad: RegistryPool = { dex: "nadfun", pairAddress: CURVE, liquidityUsd: null, volume24Usd: null };

  it("forces a launchpad pair to Tier A with the launchpad source and no share, outside the cap", () => {
    const pairs = buildRegistry({
      chain: "monad",
      address: "0xtoken",
      dexPairs: ["a", "b", "c", "d", "e"].map((address) => dexRow(address, 10, { chain: "monad" })),
      geckoPools: [],
      launchpadPools: [launchpad]
    });
    const curve = byAddress(pairs, CURVE);
    expect(curve).toMatchObject({ tier: "A", dex: "nadfun", baseMint: "0xtoken", quoteMint: null, share24: null, sources: [LAUNCHPAD_SOURCE] });
    expect(isLaunchpadRow(curve)).toBe(true);
    expect(pairs.filter((pair) => pair.tier === "A" && pair.pairAddress !== CURVE)).toHaveLength(4);
    expect(pairs.filter((pair) => pair.tier === "B")).toHaveLength(1);
  });

  it("is the only Tier A row for a curve-phase token with no DEX pool yet", () => {
    const pairs = buildRegistry({ chain: "monad", address: "0xtoken", dexPairs: [], geckoPools: [], launchpadPools: [launchpad] });
    expect(pairs.map((pair) => [pair.pairAddress, pair.tier])).toEqual([[CURVE, "A"]]);
  });

  it("changes nothing when launchpadPools is omitted or empty", () => {
    const without = build([dexRow("a", 60), dexRow("b", 40)]);
    const empty = buildRegistry({ chain: "monad", address: MINT, dexPairs: [dexRow("a", 60), dexRow("b", 40)], geckoPools: [], launchpadPools: [] });
    expect(empty).toEqual(without);
    expect(without.some(isLaunchpadRow)).toBe(false);
  });
});

describe("getRegistry", () => {
  function deps(overrides: Partial<RegistryDeps> = {}): RegistryDeps {
    return {
      getTokenPairs: vi.fn(async () => ({ pairs: [dexRow("a", 100)], stale: false })),
      geckoTokenPools: vi.fn(async () => [pool("g", 1)]),
      ...overrides
    };
  }

  it("builds from all deps, caches for 60s, and refreshes after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const d = deps();
    const first = await getRegistry("monad", MINT, d);
    expect(first.stale).toBe(false);
    expect(first.error).toBeUndefined();
    expect(first.observedAt).toBe(1_000_000);
    expect(first.pairs.map((pair) => pair.pairAddress)).toEqual(["a", "g"]);

    vi.setSystemTime(1_000_000 + 59_000);
    await getRegistry("monad", MINT, d);
    expect(d.getTokenPairs).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_000_000 + 61_000);
    const third = await getRegistry("monad", MINT, d);
    expect(d.getTokenPairs).toHaveBeenCalledTimes(2);
    expect(third.observedAt).toBe(1_000_000 + 61_000);
  });

  it("dedupes concurrent in-flight loads", async () => {
    const d = deps();
    const [x, y] = await Promise.all([getRegistry("monad", MINT, d), getRegistry("monad", MINT, d)]);
    expect(x).toBe(y);
    expect(d.getTokenPairs).toHaveBeenCalledTimes(1);
    expect(d.geckoTokenPools).toHaveBeenCalledTimes(1);
  });

  it("asks the optional launchpadPairs dep for the token and unions its rows", async () => {
    const launchpadPairs = vi.fn((): RegistryPool[] => [{ dex: "nadfun", pairAddress: "nadfun:0xtoken", liquidityUsd: null, volume24Usd: null }]);
    const result = await getRegistry("monad", "0xToken", deps({ launchpadPairs }));
    expect(launchpadPairs).toHaveBeenCalledWith("monad", "0xToken");
    expect(byAddress(result.pairs, "nadfun:0xtoken")).toMatchObject({ tier: "A", sources: [LAUNCHPAD_SOURCE] });
  });

  it("keys monad addresses case-insensitively", async () => {
    const d = deps();
    await getRegistry("monad", "0xABC", d);
    await getRegistry("monad", "0xabc", d);
    expect(d.getTokenPairs).toHaveBeenCalledTimes(1);
  });

  it("survives a partial source failure with a fresh result that reports the error", async () => {
    const d = deps({ geckoTokenPools: vi.fn(async () => { throw new Error("gecko down"); }) });
    const result = await getRegistry("monad", MINT, d);
    expect(result.stale).toBe(false);
    expect(result.error).toBe("geckoterminal: gecko down");
    expect(result.pairs.map((pair) => pair.pairAddress)).toEqual(["a"]);
  });

  it("forwards a stale DexScreener error while staying fresh itself", async () => {
    const d = deps({ getTokenPairs: vi.fn(async () => ({ pairs: [dexRow("a", 1)], stale: true, error: "429" })) });
    const result = await getRegistry("monad", MINT, d);
    expect(result.stale).toBe(false);
    expect(result.error).toBe("dexscreener: 429");
  });

  it("throws when every source fails and nothing is cached", async () => {
    const failing = deps({
      getTokenPairs: vi.fn(async () => { throw new Error("dex"); }),
      geckoTokenPools: vi.fn(async () => { throw new Error("gecko"); })
    });
    await expect(getRegistry("monad", MINT, failing)).rejects.toThrow("dexscreener: dex; geckoterminal: gecko");
  });

  it("serves last-good with stale:true when every source fails after a cached load", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const good = await getRegistry("monad", MINT, deps());
    vi.setSystemTime(5_000_000 + 61_000);
    const failing = deps({
      getTokenPairs: vi.fn(async () => { throw new Error("dex"); }),
      geckoTokenPools: vi.fn(async () => { throw new Error("gecko"); })
    });
    const result = await getRegistry("monad", MINT, failing);
    expect(result.stale).toBe(true);
    expect(result.pairs).toEqual(good.pairs);
    expect(result.observedAt).toBe(5_000_000);
    expect(result.error).toContain("geckoterminal: gecko");
  });
});

describe("getRegistry last-good per source (registry flap)", () => {
  const gecko429 = () => vi.fn(async (): Promise<RegistryPool[]> => { throw new Error("429"); });
  const rejecting = (label: string) => vi.fn(async () => { throw new Error(label); });

  function deps(overrides: Partial<RegistryDeps> = {}): RegistryDeps {
    return {
      getTokenPairs: vi.fn(async () => ({ pairs: [dexRow("a", 100)], stale: false })),
      geckoTokenPools: vi.fn(async () => [pool("g", 80)]),
      ...overrides
    };
  }

  function tiers(pairs: PairRow[]): Array<[string, string]> {
    return pairs.map((pair) => [pair.pairAddress, pair.tier]);
  }

  it("reuses Gecko's last-good rows when Gecko 429s, so pairs and tiers do not flap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(7_000_000);
    const good = await getRegistry("monad", MINT, deps());
    expect(tiers(good.pairs)).toEqual([["a", "A"], ["g", "A"]]);

    vi.setSystemTime(7_000_000 + 61_000);
    const flapped = await getRegistry("monad", MINT, deps({ geckoTokenPools: gecko429() }));
    expect(flapped.stale).toBe(false);
    expect(flapped.error).toBe("geckoterminal: 429");
    expect(flapped.observedAt).toBe(7_000_000 + 61_000);
    expect(flapped.pairs).toEqual(good.pairs);
  });

  it("drops a pool when Gecko succeeds with a genuinely empty list", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(8_000_000);
    await getRegistry("monad", MINT, deps());
    vi.setSystemTime(8_000_000 + 61_000);
    const emptied = await getRegistry("monad", MINT, deps({ geckoTokenPools: vi.fn(async () => []) }));
    expect(emptied.stale).toBe(false);
    expect(emptied.error).toBeUndefined();
    expect(tiers(emptied.pairs)).toEqual([["a", "A"]]);

    vi.setSystemTime(8_000_000 + 122_000);
    const after = await getRegistry("monad", MINT, deps({ geckoTokenPools: gecko429() }));
    expect(after.error).toBe("geckoterminal: 429");
    expect(tiers(after.pairs)).toEqual([["a", "A"]]);
  });

  it("substitutes last-good rows for a DexScreener error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(9_000_000);
    const good = await getRegistry("monad", MINT, deps());
    vi.setSystemTime(9_000_000 + 61_000);
    const partial = await getRegistry(
      "monad",
      MINT,
      deps({
        getTokenPairs: vi.fn(async () => ({ pairs: [], stale: true, error: "429" }))
      })
    );
    expect(partial.stale).toBe(false);
    expect(partial.error).toBe("dexscreener: 429");
    expect(partial.pairs).toEqual(good.pairs);
  });

  it("uses the rows a failed source returned when it has never succeeded for the key", async () => {
    const result = await getRegistry(
      "monad",
      MINT,
      deps({ getTokenPairs: vi.fn(async () => ({ pairs: [dexRow("own-stale", 5)], stale: true, error: "429" })), geckoTokenPools: gecko429() })
    );
    expect(result.stale).toBe(false);
    expect(result.error).toBe("dexscreener: 429; geckoterminal: 429");
    expect(result.pairs.map((pair) => pair.pairAddress)).toEqual(["own-stale"]);
  });

  it("serves the previous result stale:true when every source rejects, keeping last-good for the next refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const good = await getRegistry("monad", MINT, deps());
    vi.setSystemTime(10_000_000 + 61_000);
    const down = deps({ getTokenPairs: rejecting("dex"), geckoTokenPools: rejecting("gecko") });
    const stale = await getRegistry("monad", MINT, down);
    expect(stale).toMatchObject({ stale: true, observedAt: 10_000_000, pairs: good.pairs });

    vi.setSystemTime(10_000_000 + 122_000);
    const recovered = await getRegistry("monad", MINT, deps({ geckoTokenPools: gecko429() }));
    expect(recovered.stale).toBe(false);
    expect(recovered.pairs).toEqual(good.pairs);
  });

  it("keeps last-good per key and forgets it on resetRegistryCache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(11_000_000);
    await getRegistry("monad", MINT, deps());
    const other = await getRegistry("monad", "0x0000000000000000000000000000000000000bad", deps({ geckoTokenPools: gecko429() }));
    expect(other.pairs.map((pair) => pair.pairAddress)).toEqual(["a"]);

    resetRegistryCache();
    const reset = await getRegistry("monad", MINT, deps({ geckoTokenPools: gecko429() }));
    expect(reset.error).toBe("geckoterminal: 429");
    expect(reset.pairs.map((pair) => pair.pairAddress)).toEqual(["a"]);
  });
});
