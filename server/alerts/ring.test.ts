import { describe, expect, it } from "vitest";
import type { AlertRow } from "../../shared/wire.js";
import { AlertRing, DEFAULT_ALERT_RING } from "./ring.js";

const COVERAGE = { watched: 600, population: 1517, label: "watching 600 of 1,517 FOMO wallets · 147 named" };

function row(id: string, observedAt: number, over: Partial<AlertRow> = {}): AlertRow {
  return {
    id,
    rule: "graduation",
    chain: "robinhood",
    time: observedAt - 1_000,
    observedAt,
    token: "0xtoken",
    symbol: null,
    coverage: COVERAGE,
    evidence: { launchpad: "pons", pool: null, launchTx: "0xlaunch", graduationTx: null, fomoFills: 1 },
    ...over
  } as AlertRow;
}

describe("AlertRing", () => {
  it("defaults to 500 and drops the oldest past the cap while remembering evicted ids", () => {
    const ring = new AlertRing();
    expect(ring.max).toBe(DEFAULT_ALERT_RING);
    for (let i = 0; i < 600; i += 1) ring.push(row(`g:${i}`, i));
    expect(ring.size()).toEqual({ size: 500, max: 500 });
    expect(ring.list({ chain: "all" })[0].id).toBe("g:599");
    expect(ring.push(row("g:0", 700))).toBe(false);
    expect(ring.has("g:0")).toBe(true);
  });

  it("dedupes on id and lists newest first with chain / since / rule / limit filters", () => {
    const ring = new AlertRing({ max: 10 });
    expect(ring.push(row("a", 1))).toBe(true);
    expect(ring.push(row("a", 2))).toBe(false);
    ring.push(row("b", 2, { chain: "solana" }));
    ring.push(row("c", 3, { rule: "first_fomo_buy" } as Partial<AlertRow>));
    expect(ring.list({ chain: "all" }).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(ring.list({ chain: "robinhood" }).map((r) => r.id)).toEqual(["c", "a"]);
    expect(ring.list({ chain: "all", since: 2 }).map((r) => r.id)).toEqual(["c"]);
    expect(ring.list({ chain: "all", rule: "graduation" }).map((r) => r.id)).toEqual(["b", "a"]);
    expect(ring.list({ chain: "all", limit: 1 }).map((r) => r.id)).toEqual(["c"]);
    expect(ring.list({ chain: "all", limit: 0 })).toEqual([]);
  });
});
