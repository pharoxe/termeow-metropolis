import { describe, expect, it } from "vitest";
import { DEFAULT_HOVER_ROWS, fomoHoverView } from "./fomoHover";
import { buildFomoMarkers } from "./fomoMarkers";
import type { FomoFill, TraderRef } from "../../shared/wire";

const T0 = 1_700_000_000_000;
const CANDLES = [T0, T0 + 60_000];
const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WALLET_C = "0xcccccccccccccccccccccccccccccccccccccccc";
const ALICE: TraderRef = { address: WALLET_A, kind: "fomo", handle: "alice", followers: 10 };
const BOB: TraderRef = { address: WALLET_B, kind: "fomo", handle: null, followers: null };
const SEEDED_C: TraderRef = { address: WALLET_C, kind: "seeded", handle: "unipcs", followers: 1 };

function fill(time: number, side: FomoFill["side"], usd: number | null, trader: TraderRef = ALICE): FomoFill {
  return { chain: "robinhood", token: "0xtoken", pair: "0xpair", dex: "pons", tx: `0x${time}${side}${usd}${trader.address}`, time, side, usd, trader };
}

describe("fomoHoverView", () => {
  it("is null when the candle has no FOMO buckets", () => {
    expect(fomoHoverView([])).toBeNull();
  });

  it("lists every wallet across the candle's buckets, largest priced first, handle or short address, side and amount", () => {
    const fills = [fill(T0 + 1, "buy", 100), fill(T0 + 2, "buy", 900, BOB), fill(T0 + 3, "sell", null, SEEDED_C), fill(T0 + 4, "buy", 50)];
    const view = fomoHoverView(buildFomoMarkers(fills, CANDLES, { theme: "dark" }).markers);
    expect(view?.title).toBe("3 FOMO buys · $1.05K | SEEDED unipcs sell");
    expect(view?.rows).toEqual([
      { label: "0xbb…bbbb", side: "buy", amount: "$900", seeded: false },
      { label: "alice", side: "buy", amount: "×2 $150", seeded: false },
      { label: "unipcs", side: "sell", amount: "unpriced", seeded: true }
    ]);
    expect(view?.more).toBe(0);
  });

  it("flags a wallet mixing priced and unpriced fills instead of silently summing", () => {
    const view = fomoHoverView(buildFomoMarkers([fill(T0 + 1, "buy", 100), fill(T0 + 2, "buy", null)], CANDLES, { theme: "dark" }).markers);
    expect(view?.rows[0].amount).toBe("×2 $100 (+1 unpriced)");
  });

  it("caps rows at maxRows (default 8) and reports the remainder", () => {
    const fills = Array.from({ length: 11 }, (_, i) => fill(T0 + i, "buy", i, { ...BOB, address: `0x${String(i).padStart(40, "0")}` }));
    const markers = buildFomoMarkers(fills, CANDLES, { theme: "dark" }).markers;
    const view = fomoHoverView(markers);
    expect(DEFAULT_HOVER_ROWS).toBe(8);
    expect(view?.rows).toHaveLength(8);
    expect(view?.more).toBe(3);
    expect(fomoHoverView(markers, 20)?.more).toBe(0);
  });
});
