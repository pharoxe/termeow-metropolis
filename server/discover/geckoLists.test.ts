import { describe, expect, it } from "vitest";
import newPools from "../sources/__fixtures__/r6/gecko-new-pools.json";
import trending from "../sources/__fixtures__/r6/gecko-trending-pools.json";
import { GECKO_NEW_SOURCE, GECKO_TRENDING_SOURCE, baseSymbolFromPoolName, normalizeGeckoListRow, tokenFromRelationshipId, type GeckoListRow } from "./geckoLists.js";

const NOW = Date.parse("2026-09-07T14:20:00Z");
const ROBIN = "0x11b70d0243baf75e85ce03201a92b5b7c33beb59";
const rows = trending.data as GeckoListRow[];
const fresh = newPools.data as GeckoListRow[];

describe("tokenFromRelationshipId", () => {
  it("strips the network prefix and lowercases a 0x address", () => {
    expect(tokenFromRelationshipId("monad_0x11B70d0243baf75e85ce03201a92b5b7c33beb59", "monad")).toBe(ROBIN);
  });

  it("rejects other networks, non-addresses and non-strings", () => {
    expect(tokenFromRelationshipId("solana_So11111111111111111111111111111111111111112", "monad")).toBeNull();
    expect(tokenFromRelationshipId("monad_notanaddress", "monad")).toBeNull();
    expect(tokenFromRelationshipId(42, "monad")).toBeNull();
  });
});

describe("baseSymbolFromPoolName", () => {
  it("reads the base leg before the separator", () => {
    expect(baseSymbolFromPoolName("ROBIN / USDG")).toBe("ROBIN");
    expect(baseSymbolFromPoolName("GPU / NVDA")).toBe("GPU");
  });

  it("is null without a separator or a base", () => {
    expect(baseSymbolFromPoolName("ROBIN")).toBeNull();
    expect(baseSymbolFromPoolName(" / USDG")).toBeNull();
    expect(baseSymbolFromPoolName(null)).toBeNull();
  });
});

describe("normalizeGeckoListRow (trending fixture)", () => {
  it("maps the 24h window of the first ROBIN / USDG pool with its rank and pool", () => {
    const partial = normalizeGeckoListRow(rows[0], 0, "trending", "24h", "monad", NOW, NOW - 5_000, false);
    expect(partial).toMatchObject({
      token: ROBIN,
      source: GECKO_TRENDING_SOURCE,
      rank: 0,
      symbol: "ROBIN",
      name: null,
      priceUsd: 0.0121723554875435,
      marketCapUsd: 12172355.49,
      liquidityUsd: 287068.1888,
      volumeUsd: 2236013.44744839,
      changePct: -29.639,
      txns: { buys: 3814, sells: 4258 },
      pool: "0x5eac4195930d5ff8b7a34a347f2bde951c42eb730d6e26075bea3dd7c66feb40",
      dex: "pons-v2-dex",
      lastOkAt: NOW - 5_000,
      stale: false,
      smartHolders: null,
      trackedBuyers: null
    });
    expect(partial?.ageMs).toBe(NOW - Date.parse("2026-09-05T16:54:01Z"));
  });

  it("maps the 1h window from the h1 keys, not h24", () => {
    const partial = normalizeGeckoListRow(rows[0], 3, "trending", "1h", "monad", NOW, NOW, false);
    expect(partial).toMatchObject({ rank: 3, volumeUsd: 32750.6128522804, changePct: -2.612, txns: { buys: 65, sells: 108 } });
  });

  it("keeps every fixture row: all carry a monad base token", () => {
    const mapped = rows.map((row, index) => normalizeGeckoListRow(row, index, "trending", "24h", "monad", NOW, NOW, false));
    expect(mapped.every((partial) => partial !== null)).toBe(true);
    expect(new Set(mapped.map((partial) => partial?.token)).size).toBe(rows.length);
  });
});

describe("normalizeGeckoListRow (new_pools fixture)", () => {
  it("leaves market cap null on a new pool instead of substituting fdv", () => {
    const partial = normalizeGeckoListRow(fresh[0], 0, "new", "24h", "monad", NOW, NOW, true);
    expect(partial).toMatchObject({ token: "0xc9b5781714a370e74257450d279d57fb1afdfafe", source: GECKO_NEW_SOURCE, symbol: "GPU", marketCapUsd: null, stale: true, dex: "pons-v2" });
    expect(partial?.ageMs).toBe(NOW - Date.parse("2026-09-07T13:45:19Z"));
  });

  it("returns null for a row without a base token relationship", () => {
    expect(normalizeGeckoListRow({ attributes: { address: "0x1" } }, 0, "new", "24h", "monad", NOW, NOW, false)).toBeNull();
  });
});
