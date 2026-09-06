import { afterEach, describe, expect, it, vi } from "vitest";
import type { PairRow } from "../../shared/wire.js";
import {
  buildRegistry,
  clawPools,
  getRegistry,
  resetRegistryCache,
  type RegistryDeps,
  type RegistryPool
} from "./registry.js";

const MINT = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const PUMP = `pumpfun:${MINT}`;

function dexRow(pairAddress: string, volume24Usd: number | null, extra: Partial<PairRow> = {}): PairRow {
  return {
    chain: "solana",
    dex: "raydium",
    pairAddress,
    baseMint: MINT,
    quoteMint: "So11111111111111111111111111111111111111112",
    liquidityUsd: 1000,
    volume24Usd,
    share24: null,
    txns: { m5: { buys: 1, sells: 2 }, h1: null, h6: null, h24: null },
    tier: "B",
    sources: ["dexscreener"],
    ...extra
  };
}

function pool(pairAddress: string, volume24Usd: number | null, dex = "orca", liquidityUsd: number | null = 500): RegistryPool {
  return { dex, pairAddress, liquidityUsd, volume24Usd };
}

function build(dexPairs: PairRow[], geckoPools: RegistryPool[] = [], clawTopPools: unknown = null, pumpPool: string | null = null) {
  return buildRegistry({ chain: "solana", address: MINT, dexPairs, geckoPools, clawTopPools, pumpPool });
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

describe("clawPools", () => {
  it("returns [] for non-arrays and drops rows without a pool address", () => {
    expect(clawPools(null)).toEqual([]);
    expect(clawPools({ pool_address: "x" })).toEqual([]);
    expect(clawPools([null, 3, {}, { protocol: "meteora" }])).toEqual([]);
  });

  it("reads pool_address/protocol/liquidity_usd/volume_24h_usd defensively", () => {
    expect(clawPools([{ pool_address: " P1 ", protocol: "meteora", liquidity_usd: "12.5", volume_24h_usd: "abc" }])).toEqual([
      { dex: "meteora", pairAddress: "P1", liquidityUsd: 12.5, volume24Usd: null }
    ]);
  });
});

describe("buildRegistry union/merge", () => {
  it("unions by lowercase pairAddress and merges sources", () => {
    const pairs = build([dexRow("AbC", 100)], [pool("abc", 999, "orca")], [{ pool_address: "ABC", protocol: "meteora" }]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].pairAddress).toBe("AbC");
    expect(pairs[0].sources).toEqual(["dexscreener", "geckoterminal", "clawpump"]);
  });

  it("prefers DexScreener numbers and fills gaps from Gecko then Claw", () => {
    const pairs = build(
      [dexRow("p1", 100, { liquidityUsd: null, dex: "unknown" })],
      [pool("p1", 999, "orca", null)],
      [{ pool_address: "p1", protocol: "meteora", liquidity_usd: 77, volume_24h_usd: 555 }]
    );
    expect(pairs[0].volume24Usd).toBe(100);
    expect(pairs[0].liquidityUsd).toBe(77);
    expect(pairs[0].dex).toBe("orca");
    expect(pairs[0].txns.m5).toEqual({ buys: 1, sells: 2 });
  });

  it("keeps Gecko-only and Claw-only pools with the token as baseMint", () => {
    const pairs = build([], [pool("g1", 10)], [{ pool_address: "c1", volume_24h_usd: 5 }]);
    expect(pairs.map((pair) => pair.pairAddress)).toEqual(["g1", "c1"]);
    expect(pairs.every((pair) => pair.baseMint === MINT && pair.chain === "solana")).toBe(true);
    expect(byAddress(pairs, "g1").sources).toEqual(["geckoterminal"]);
    expect(byAddress(pairs, "c1").sources).toEqual(["clawpump"]);
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

  it("makes the pump pseudo-pair Tier A without counting toward the cap", () => {
    const pairs = build(["a", "b", "c", "d", "e"].map((address) => dexRow(address, 10)), [], null, PUMP);
    const pump = byAddress(pairs, PUMP);
    expect(pump.tier).toBe("A");
    expect(pump.dex).toBe("pumpfun");
    expect(pump.sources).toEqual(["pumpfun"]);
    expect(pump.share24).toBeNull();
    expect(pairs.filter((pair) => pair.tier === "A" && pair.pairAddress !== PUMP)).toHaveLength(4);
  });

  it("keeps pump-venue pools Tier B behind the pseudo-pair, which inherits their volume and share", () => {
    const pairs = build(
      [dexRow("m1", 80, { dex: "meteora" }), dexRow("swap", 16, { dex: "pumpswap" }), dexRow("g1", 3, { dex: "orca" })],
      [pool("curve", 1, "pump-fun")],
      null,
      PUMP
    );
    expect(byAddress(pairs, "swap").tier).toBe("B");
    expect(byAddress(pairs, "curve").tier).toBe("B");
    expect(byAddress(pairs, PUMP)).toMatchObject({ tier: "A", volume24Usd: 17, share24: 0.17 });
    expect(byAddress(pairs, "m1").tier).toBe("A");
    expect(byAddress(pairs, "g1").tier).toBe("B");
  });

  it("leaves pump-venue pools eligible for Tier A when there is no pseudo-pair", () => {
    const pairs = build([dexRow("swap", 90, { dex: "pumpswap" }), dexRow("m1", 10, { dex: "meteora" })]);
    expect(pairs.map((pair) => [pair.pairAddress, pair.tier])).toEqual([["swap", "A"], ["m1", "A"]]);
  });

  it("omits the pump pseudo-pair when pumpPool is null and never tiers unknown-share pairs", () => {
    const pairs = build([dexRow("a", null), dexRow("b", null)]);
    expect(pairs.some((pair) => pair.pairAddress === PUMP)).toBe(false);
    expect(pairs.every((pair) => pair.tier === "B")).toBe(true);
  });
});

describe("getRegistry", () => {
  function deps(overrides: Partial<RegistryDeps> = {}): RegistryDeps {
    return {
      getTokenPairs: vi.fn(async () => ({ pairs: [dexRow("a", 100)], stale: false })),
      geckoTokenPools: vi.fn(async () => [pool("g", 1)]),
      clawTopPools: vi.fn(async () => [{ pool_address: "c", volume_24h_usd: 2 }]),
      pumpPool: vi.fn(() => PUMP),
      ...overrides
    };
  }

  it("builds from all deps, caches for 60s, and refreshes after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const d = deps();
    const first = await getRegistry("solana", MINT, d);
    expect(first.stale).toBe(false);
    expect(first.error).toBeUndefined();
    expect(first.observedAt).toBe(1_000_000);
    expect(first.pairs.map((pair) => pair.pairAddress)).toEqual(["a", "c", "g", PUMP]);

    vi.setSystemTime(1_000_000 + 59_000);
    await getRegistry("solana", MINT, d);
    expect(d.getTokenPairs).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_000_000 + 61_000);
    const third = await getRegistry("solana", MINT, d);
    expect(d.getTokenPairs).toHaveBeenCalledTimes(2);
    expect(third.observedAt).toBe(1_000_000 + 61_000);
  });

  it("dedupes concurrent in-flight loads", async () => {
    const d = deps();
    const [x, y] = await Promise.all([getRegistry("solana", MINT, d), getRegistry("solana", MINT, d)]);
    expect(x).toBe(y);
    expect(d.getTokenPairs).toHaveBeenCalledTimes(1);
    expect(d.geckoTokenPools).toHaveBeenCalledTimes(1);
  });

  it("keys robinhood addresses case-insensitively", async () => {
    const d = deps({ pumpPool: () => null });
    await getRegistry("robinhood", "0xABC", d);
    await getRegistry("robinhood", "0xabc", d);
    expect(d.getTokenPairs).toHaveBeenCalledTimes(1);
  });

  it("survives a partial source failure with a fresh result that reports the error", async () => {
    const d = deps({ geckoTokenPools: vi.fn(async () => { throw new Error("gecko down"); }) });
    const result = await getRegistry("solana", MINT, d);
    expect(result.stale).toBe(false);
    expect(result.error).toBe("geckoterminal: gecko down");
    expect(result.pairs.map((pair) => pair.pairAddress)).toEqual(["a", "c", PUMP]);
  });

  it("forwards a stale DexScreener error while staying fresh itself", async () => {
    const d = deps({ getTokenPairs: vi.fn(async () => ({ pairs: [dexRow("a", 1)], stale: true, error: "429" })) });
    const result = await getRegistry("solana", MINT, d);
    expect(result.stale).toBe(false);
    expect(result.error).toBe("dexscreener: 429");
  });

  it("throws when every source fails and nothing is cached", async () => {
    const failing = deps({
      getTokenPairs: vi.fn(async () => { throw new Error("dex"); }),
      geckoTokenPools: vi.fn(async () => { throw new Error("gecko"); }),
      clawTopPools: vi.fn(async () => { throw new Error("claw"); })
    });
    await expect(getRegistry("solana", MINT, failing)).rejects.toThrow("dexscreener: dex; geckoterminal: gecko; clawpump: claw");
  });

  it("serves last-good with stale:true when every source fails after a cached load", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const good = await getRegistry("solana", MINT, deps());
    vi.setSystemTime(5_000_000 + 61_000);
    const failing = deps({
      getTokenPairs: vi.fn(async () => { throw new Error("dex"); }),
      geckoTokenPools: vi.fn(async () => { throw new Error("gecko"); }),
      clawTopPools: vi.fn(async () => { throw new Error("claw"); })
    });
    const result = await getRegistry("solana", MINT, failing);
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
      clawTopPools: vi.fn(async () => [{ pool_address: "c", volume_24h_usd: 2 }]),
      pumpPool: vi.fn(() => null),
      ...overrides
    };
  }

  function tiers(pairs: PairRow[]): Array<[string, string]> {
    return pairs.map((pair) => [pair.pairAddress, pair.tier]);
  }

  it("reuses Gecko's last-good rows when Gecko 429s, so pairs and tiers do not flap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(7_000_000);
    const good = await getRegistry("solana", MINT, deps());
    expect(tiers(good.pairs)).toEqual([["a", "A"], ["g", "A"], ["c", "B"]]);

    vi.setSystemTime(7_000_000 + 61_000);
    const flapped = await getRegistry("solana", MINT, deps({ geckoTokenPools: gecko429() }));
    expect(flapped.stale).toBe(false);
    expect(flapped.error).toBe("geckoterminal: 429");
    expect(flapped.observedAt).toBe(7_000_000 + 61_000);
    expect(flapped.pairs).toEqual(good.pairs);
  });

  it("drops a pool when Gecko succeeds with a genuinely empty list", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(8_000_000);
    await getRegistry("solana", MINT, deps());
    vi.setSystemTime(8_000_000 + 61_000);
    const emptied = await getRegistry("solana", MINT, deps({ geckoTokenPools: vi.fn(async () => []) }));
    expect(emptied.stale).toBe(false);
    expect(emptied.error).toBeUndefined();
    expect(tiers(emptied.pairs)).toEqual([["a", "A"], ["c", "B"]]);

    vi.setSystemTime(8_000_000 + 122_000);
    const after = await getRegistry("solana", MINT, deps({ geckoTokenPools: gecko429() }));
    expect(after.error).toBe("geckoterminal: 429");
    expect(tiers(after.pairs)).toEqual([["a", "A"], ["c", "B"]]);
  });

  it("substitutes last-good rows for a DexScreener error and a rejected Claw independently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(9_000_000);
    const good = await getRegistry("solana", MINT, deps());
    vi.setSystemTime(9_000_000 + 61_000);
    const partial = await getRegistry(
      "solana",
      MINT,
      deps({
        getTokenPairs: vi.fn(async () => ({ pairs: [], stale: true, error: "429" })),
        clawTopPools: rejecting("claw down")
      })
    );
    expect(partial.stale).toBe(false);
    expect(partial.error).toBe("dexscreener: 429; clawpump: claw down");
    expect(partial.pairs).toEqual(good.pairs);
  });

  it("uses the rows a failed source returned when it has never succeeded for the key", async () => {
    const result = await getRegistry(
      "solana",
      MINT,
      deps({ getTokenPairs: vi.fn(async () => ({ pairs: [dexRow("own-stale", 5)], stale: true, error: "429" })), geckoTokenPools: gecko429() })
    );
    expect(result.stale).toBe(false);
    expect(result.error).toBe("dexscreener: 429; geckoterminal: 429");
    expect(result.pairs.map((pair) => pair.pairAddress)).toEqual(["own-stale", "c"]);
  });

  it("serves the previous result stale:true when every source rejects, keeping last-good for the next refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const good = await getRegistry("solana", MINT, deps());
    vi.setSystemTime(10_000_000 + 61_000);
    const down = deps({ getTokenPairs: rejecting("dex"), geckoTokenPools: rejecting("gecko"), clawTopPools: rejecting("claw") });
    const stale = await getRegistry("solana", MINT, down);
    expect(stale).toMatchObject({ stale: true, observedAt: 10_000_000, pairs: good.pairs });

    vi.setSystemTime(10_000_000 + 122_000);
    const recovered = await getRegistry("solana", MINT, deps({ geckoTokenPools: gecko429() }));
    expect(recovered.stale).toBe(false);
    expect(recovered.pairs).toEqual(good.pairs);
  });

  it("keeps last-good per key and forgets it on resetRegistryCache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(11_000_000);
    await getRegistry("solana", MINT, deps());
    const other = await getRegistry("solana", "OtherMint", deps({ geckoTokenPools: gecko429() }));
    expect(other.pairs.map((pair) => pair.pairAddress)).toEqual(["a", "c"]);

    resetRegistryCache();
    const reset = await getRegistry("solana", MINT, deps({ geckoTokenPools: gecko429() }));
    expect(reset.error).toBe("geckoterminal: 429");
    expect(reset.pairs.map((pair) => pair.pairAddress)).toEqual(["a", "c"]);
  });
});
