import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { orderWatchList, type WatchRank } from "./watchOrder.js";

/** 801 real EVM addresses harvested 2026-09-07 (r5 capture) and 147 named traders from the r4 capture. */
const REAL = JSON.parse(readFileSync(new URL("./__fixtures__/r5/wallets-real.json", import.meta.url), "utf8")) as string[];
const NAMED = (JSON.parse(readFileSync(new URL("./__fixtures__/r4/trenches-traders.json", import.meta.url), "utf8")) as Array<{ address: string }>).map((row) => row.address.toLowerCase());

const NOW = 1_800_000_000_000;

function rank(overrides: Partial<WatchRank> = {}): WatchRank {
  return { priority: () => false, lastFillAt: () => null, verifiedRank: () => null, ...overrides };
}

describe("orderWatchList", () => {
  it("puts seeded/named wallets first, then the most recent fill, then the most recently verified, ties in input order", () => {
    const [a, b, c, d, e, f] = REAL;
    const named = new Set([c, e]);
    const fills = new Map<string, number>([
      [a, NOW - 5_000],
      [c, NOW - 60_000],
      [e, NOW - 1_000]
    ]);
    const verified = new Map<string, number>([
      [b, 3],
      [d, 0],
      [f, 1]
    ]);
    const out = orderWatchList([a, b, c, d, e, f], rank({ priority: (w) => named.has(w), lastFillAt: (w) => fills.get(w) ?? null, verifiedRank: (w) => verified.get(w) ?? null }));
    // named: e (newer fill) before c; then a (only anonymous fill); then verified rank d(0), f(1), b(3).
    expect(out).toEqual([e, c, a, d, f, b]);
  });

  it("keeps input order for wallets nothing ranks apart and never drops or duplicates a wallet", () => {
    const input = [...REAL.slice(0, 20), REAL[0].toUpperCase()];
    const out = orderWatchList(input, rank());
    expect(out).toEqual(REAL.slice(0, 20));
    expect(orderWatchList([], rank())).toEqual([]);
  });

  it("keeps all 147 named traders ahead of 654 anonymous wallets in the r5 harvest whatever their fill history", () => {
    const named = new Set(NAMED);
    const anonymous = REAL.filter((wallet) => !named.has(wallet));
    const out = orderWatchList([...anonymous, ...NAMED], rank({ priority: (w) => named.has(w), lastFillAt: (w) => (named.has(w) ? null : NOW) }));
    expect(out.slice(0, NAMED.length).every((wallet) => named.has(wallet))).toBe(true);
    expect(out).toHaveLength(anonymous.length + NAMED.length);
    expect(new Set(out).size).toBe(out.length);
  });

  it("does not mutate the input", () => {
    const input = [REAL[2], REAL[1], REAL[0]];
    const snapshot = [...input];
    orderWatchList(input, rank({ verifiedRank: (w) => REAL.indexOf(w) }));
    expect(input).toEqual(snapshot);
  });
});
