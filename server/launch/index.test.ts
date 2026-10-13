import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_LAUNCHES, LaunchIndex, UNKNOWN_LAUNCHPAD, launchKey } from "./index.js";

const T0 = 1_800_000_000_000;
const PONS = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
const TOKEN_A = "0xAaAa000000000000000000000000000000000001";
const TOKEN_B = "0xbbbb000000000000000000000000000000000002";
const TOKEN_C = "0xCcCc000000000000000000000000000000000003";

function clock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms), set: (at: number) => (t = at) };
}

function build(max = DEFAULT_MAX_LAUNCHES) {
  const c = clock();
  const index = new LaunchIndex({ max, now: c.now });
  return { index, c };
}

describe("launchKey", () => {
  it("lowercases the token and prefixes the chain", () => {
    expect(launchKey("monad", TOKEN_A)).toBe(`monad:${TOKEN_A.toLowerCase()}`);
  });
});

describe("LaunchIndex.upsert", () => {
  it("creates a row with nulls for everything a source did not say and stamps observedAt", () => {
    const { index } = build();
    const row = index.upsert({ chain: "monad", token: TOKEN_A, launchpad: "pons", createdAt: T0 - 1_000, tx: "0xtx", sources: ["rpc:pons"] });
    expect(row).toEqual({
      chain: "monad",
      launchpad: "pons",
      token: TOKEN_A,
      symbol: null,
      name: null,
      image: null,
      creator: null,
      curve: null,
      pool: null,
      createdAt: T0 - 1_000,
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
      sources: ["rpc:pons"],
      observedAt: T0
    });
  });

  it("defaults launchpad/createdAt/tx when an enrichment source is first to mention a token", () => {
    const { index } = build();
    const row = index.upsert({ chain: "monad", token: TOKEN_A, symbol: "FOO", sources: ["robinhoodtrenches"] });
    expect(row).toMatchObject({ launchpad: UNKNOWN_LAUNCHPAD, createdAt: T0, tx: "", symbol: "FOO" });
  });

  it("merges non-null fields, keeps known values against null/undefined, unions sources, keeps first-seen token case", () => {
    const { index, c } = build();
    index.upsert({ chain: "monad", token: TOKEN_A, launchpad: "pons", createdAt: T0 - 5_000, tx: "0xtx", symbol: "FOO", creator: "0xdeployer", sources: ["rpc:pons"] });
    c.advance(1_000);
    const merged = index.upsert({
      chain: "monad",
      token: TOKEN_A.toLowerCase(),
      symbol: null,
      name: "Foo Coin",
      creator: undefined,
      priceUsd: 0.5,
      sources: ["dexscreener", "rpc:pons"]
    });
    expect(merged).toMatchObject({
      token: TOKEN_A,
      launchpad: "pons",
      createdAt: T0 - 5_000,
      tx: "0xtx",
      symbol: "FOO",
      name: "Foo Coin",
      creator: "0xdeployer",
      priceUsd: 0.5,
      sources: ["rpc:pons", "dexscreener"],
      observedAt: T0 + 1_000
    });
    expect(index.stats().rows).toBe(1);
  });

  it("replaces launchpad 'unknown' once the on-chain create names it, and lets a later create fix createdAt", () => {
    const { index } = build();
    index.upsert({ chain: "monad", token: TOKEN_A, sources: ["robinhoodtrenches"] });
    const row = index.upsert({ chain: "monad", token: TOKEN_A, launchpad: "flap", createdAt: T0 - 60_000, tx: "0xcreate", sources: ["rpc:flap"] });
    expect(row).toMatchObject({ launchpad: "flap", createdAt: T0 - 60_000, tx: "0xcreate", sources: ["robinhoodtrenches", "rpc:flap"] });
  });

  it("replaces the tracked block wholesale and never overwrites it with null", () => {
    const { index } = build();
    const tracked = { buyers: 3, usdIn: 100, usdOut: 20, firstBuyer: { handle: "alice", followers: null, at: T0 - 10 }, honeypot: false };
    index.upsert({ chain: "monad", token: TOKEN_A, tracked });
    expect(index.upsert({ chain: "monad", token: TOKEN_A, tracked: null }).tracked).toEqual(tracked);
    const next = { ...tracked, buyers: 4 };
    expect(index.upsert({ chain: "monad", token: TOKEN_A, tracked: next }).tracked).toEqual(next);
  });

  it("returns a fresh snapshot per write; the previous snapshot is not mutated", () => {
    const { index } = build();
    const first = index.upsert({ chain: "monad", token: TOKEN_C, launchpad: "nadfun", sources: ["rpc:nadfun"] });
    const second = index.upsert({ chain: "monad", token: TOKEN_C, name: "Cat" });
    expect(first.name).toBeNull();
    expect(first.sources).toEqual(["rpc:nadfun"]);
    expect(second).not.toBe(first);
    expect(second.name).toBe("Cat");
  });

  it("keys tokens case-insensitively so two spellings of one address are one row", () => {
    const { index } = build();
    index.upsert({ chain: "monad", token: TOKEN_A, launchpad: "pons" });
    index.upsert({ chain: "monad", token: TOKEN_A.toLowerCase(), symbol: "A" });
    expect(index.stats().byChain).toEqual({ monad: 1 });
  });
});

describe("LaunchIndex.recordTrade", () => {
  it("counts buys and sells, moves net only for priced trades, and keeps net null until the first priced trade", () => {
    const { index, c } = build();
    index.upsert({ chain: "monad", token: TOKEN_A, launchpad: "pons" });
    expect(index.recordTrade("monad", TOKEN_A, "buy", null)).toBe(true);
    expect(index.get("monad", TOKEN_A)).toMatchObject({ curveBuys: 1, curveSells: 0, curveNetUsd: null });

    c.advance(5);
    index.recordTrade("monad", TOKEN_A.toLowerCase(), "buy", 40);
    index.recordTrade("monad", TOKEN_A, "sell", 15.5);
    index.recordTrade("monad", TOKEN_A, "sell", null);
    index.recordTrade("monad", TOKEN_A, "buy", Number.NaN);
    expect(index.get("monad", TOKEN_A)).toMatchObject({ curveBuys: 3, curveSells: 2, curveNetUsd: 24.5, observedAt: T0 + 5 });
  });

  it("returns false and records nothing for a token the index has never seen", () => {
    const { index } = build();
    expect(index.recordTrade("monad", TOKEN_B, "buy", 10)).toBe(false);
    expect(index.stats().rows).toBe(0);
  });
});

describe("LaunchIndex.recordGraduation", () => {
  it("sets graduatedAt and the pool, keeping a known pool when the event carries none", () => {
    const { index } = build();
    index.upsert({ chain: "monad", token: TOKEN_A, launchpad: "pons", pool: "0xpool-from-launch" });
    expect(index.recordGraduation("monad", TOKEN_A, T0 + 99, null)).toBe(true);
    expect(index.get("monad", TOKEN_A)).toMatchObject({ graduatedAt: T0 + 99, pool: "0xpool-from-launch" });
    index.recordGraduation("monad", TOKEN_A, T0 + 100, "0xv4pool");
    expect(index.get("monad", TOKEN_A)).toMatchObject({ graduatedAt: T0 + 100, pool: "0xv4pool" });
    expect(index.stats().graduated).toBe(1);
  });

  it("returns false for an unknown token", () => {
    const { index } = build();
    expect(index.recordGraduation("monad", TOKEN_C, T0, "pool")).toBe(false);
  });
});

describe("LaunchIndex.list / tokens", () => {
  function seeded() {
    const { index, c } = build();
    index.upsert({ chain: "monad", token: "0x01", launchpad: "pons", createdAt: T0 - 3 * 3_600_000 });
    index.upsert({ chain: "monad", token: "0x02", launchpad: "flap", createdAt: T0 - 30 * 60_000 });
    index.upsert({ chain: "monad", token: "0x03", launchpad: "pons", createdAt: T0 - 60_000, isStock: true });
    index.upsert({ chain: "monad", token: "0x04", launchpad: "nadfun", createdAt: T0 - 10_000 });
    c.advance(1);
    index.upsert({ chain: "monad", token: "0x05", launchpad: "nadfun", createdAt: T0 - 10_000 });
    return { index, c };
  }

  it("filters by window and chain, newest first, ties broken by the most recently observed", () => {
    const { index } = seeded();
    expect(index.list({ chain: "all", windowMs: 3_600_000 }).map((r) => r.token)).toEqual(["0x05", "0x04", "0x03", "0x02"]);
    expect(index.list({ chain: "all", windowMs: 4 * 3_600_000 }).map((r) => r.token)).toEqual(["0x05", "0x04", "0x03", "0x02", "0x01"]);
    expect(index.list({ chain: "monad", windowMs: 3_600_000 }).map((r) => r.token)).toEqual(["0x05", "0x04", "0x03", "0x02"]);
    expect(index.list({ chain: "monad", windowMs: 1_000 })).toEqual([]);
  });

  it("filters by pad, hides flagged stocks only when asked, and honours limit", () => {
    const { index } = seeded();
    expect(index.list({ chain: "all", windowMs: 24 * 3_600_000, pad: "pons" }).map((r) => r.token)).toEqual(["0x03", "0x01"]);
    expect(index.list({ chain: "all", windowMs: 24 * 3_600_000, pad: "pons", includeStocks: false }).map((r) => r.token)).toEqual(["0x01"]);
    expect(index.list({ chain: "all", windowMs: 24 * 3_600_000, limit: 2 }).map((r) => r.token)).toEqual(["0x05", "0x04"]);
    index.upsert({ chain: "monad", token: "0x03", isStock: false });
    expect(index.list({ chain: "monad", windowMs: 3_600_000, includeStocks: false }).map((r) => r.token)).toEqual(["0x05", "0x04", "0x03", "0x02"]);
  });

  it("tokens() returns the addresses on one chain inside the window, newest first, with stored case", () => {
    const { index } = seeded();
    expect(index.tokens("monad", 30_000)).toEqual(["0x05", "0x04"]);
    expect(index.tokens("monad", 3_600_000)).toEqual(["0x05", "0x04", "0x03", "0x02"]);
    expect(index.tokens("monad", 0)).toEqual([]);
  });

});

describe("LaunchIndex bounds", () => {
  it("evicts the oldest-created row past max, so a late old token cannot displace a fresh launch", () => {
    const { index } = build(3);
    index.upsert({ chain: "monad", token: "0x01", createdAt: T0 - 300 });
    index.upsert({ chain: "monad", token: "0x02", createdAt: T0 - 200 });
    index.upsert({ chain: "monad", token: "0x03", createdAt: T0 - 100 });
    index.upsert({ chain: "monad", token: "0x04", createdAt: T0 - 50 });
    expect(index.list({ chain: "all", windowMs: 1_000 }).map((r) => r.token)).toEqual(["0x04", "0x03", "0x02"]);
    expect(index.get("monad", "0x01")).toBeNull();

    index.upsert({ chain: "monad", token: "0x00", createdAt: T0 - 9_999, isStock: true });
    expect(index.get("monad", "0x00")).toBeNull();
    expect(index.list({ chain: "all", windowMs: 1_000 }).map((r) => r.token)).toEqual(["0x04", "0x03", "0x02"]);
    expect(index.stats()).toMatchObject({ rows: 3, max: 3, evicted: 2, oldestCreatedAt: T0 - 200, newestCreatedAt: T0 - 50 });
  });

  it("re-upserting an existing key never triggers eviction", () => {
    const { index } = build(2);
    index.upsert({ chain: "monad", token: "0x01", createdAt: T0 - 2 });
    index.upsert({ chain: "monad", token: "0x02", createdAt: T0 - 1 });
    index.upsert({ chain: "monad", token: "0x01", symbol: "ONE" });
    expect(index.stats()).toMatchObject({ rows: 2, evicted: 0 });
  });

  it("defaults to 3000 rows and clamps max to at least 1", () => {
    expect(new LaunchIndex().stats().max).toBe(3_000);
    expect(new LaunchIndex({ max: 0 }).stats().max).toBe(1);
  });
});

describe("LaunchIndex.stats", () => {
  it("counts rows by chain and pad, graduations, and the created range", () => {
    const { index } = build();
    expect(index.stats()).toEqual({ rows: 0, max: DEFAULT_MAX_LAUNCHES, evicted: 0, byChain: { monad: 0 }, byPad: {}, graduated: 0, oldestCreatedAt: null, newestCreatedAt: null });
    index.upsert({ chain: "monad", token: TOKEN_A, launchpad: "pons", createdAt: T0 - 10, creator: PONS });
    index.upsert({ chain: "monad", token: TOKEN_B, launchpad: "pons", createdAt: T0 - 20 });
    index.upsert({ chain: "monad", token: TOKEN_C, launchpad: "nadfun", createdAt: T0 - 5 });
    index.recordGraduation("monad", TOKEN_B, T0, "0xpool");
    expect(index.stats()).toEqual({
      rows: 3,
      max: DEFAULT_MAX_LAUNCHES,
      evicted: 0,
      byChain: { monad: 3 },
      byPad: { pons: 2, nadfun: 1 },
      graduated: 1,
      oldestCreatedAt: T0 - 20,
      newestCreatedAt: T0 - 5
    });
  });
});
