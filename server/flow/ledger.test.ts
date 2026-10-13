import { describe, expect, it } from "vitest";
import type { FlowPrint } from "../../shared/wire.js";
import { FlowLedger, HOUR_MS, MINUTE_MS, toBars } from "./ledger.js";

const T0 = 1_700_000_000_000; // 2023-11-14T22:13:20Z, not aligned to anything
const H0 = Math.floor(T0 / HOUR_MS) * HOUR_MS;
const M0 = Math.floor(T0 / MINUTE_MS) * MINUTE_MS;

function print(over: Partial<FlowPrint> = {}): FlowPrint {
  return {
    chain: "monad",
    pair: "pool-A",
    tx: `tx-${over.time ?? T0}-${over.side ?? "buy"}`,
    time: T0,
    side: "buy",
    usd: 10,
    source: "geckoterminal",
    ...over
  };
}

function totals(ledger: FlowLedger, bucketMs: number, from: number, to: number, pair = "pool-A") {
  return ledger.series("monad", pair, bucketMs, from, to);
}

describe("FlowLedger ingest", () => {
  it("assigns prints at :59.999 and :00.000 to adjacent minute buckets", () => {
    const ledger = new FlowLedger({ now: () => T0 });
    const boundary = M0 + MINUTE_MS;
    ledger.ingest([
      print({ time: boundary - 1, tx: "a" }),
      print({ time: boundary, tx: "b" }),
      print({ time: boundary + MINUTE_MS - 1, tx: "c" })
    ]);
    const buckets = totals(ledger, MINUTE_MS, 0, Number.MAX_SAFE_INTEGER);
    expect(buckets.map((b) => [b.t, b.buys])).toEqual([
      [boundary - MINUTE_MS, 1],
      [boundary, 2]
    ]);
  });

  it("dedupes on (chain, tx, pair) across overlapping ingests", () => {
    const ledger = new FlowLedger({ now: () => T0 });
    const first = ledger.ingest([print({ tx: "x" }), print({ tx: "y" }), print({ tx: "x" })]);
    expect(first).toEqual({ accepted: 2, duplicates: 1 });
    const second = ledger.ingest([print({ tx: "y" }), print({ tx: "z" })]);
    expect(second).toEqual({ accepted: 1, duplicates: 1 });
    const other = ledger.ingest([
      print({ tx: "x", pair: "pool-B" }),
      print({ tx: "x", pair: "pool-C" })
    ]);
    expect(other).toEqual({ accepted: 2, duplicates: 0 });
    expect(totals(ledger, MINUTE_MS, 0, Number.MAX_SAFE_INTEGER)[0].buys).toBe(3);
  });

  it("forgets duplicates that fell out of the dedupe ring", () => {
    const ledger = new FlowLedger({ now: () => T0, dedupeRing: 2 });
    ledger.ingest([print({ tx: "1" }), print({ tx: "2" }), print({ tx: "3" })]);
    expect(ledger.ingest([print({ tx: "3" })])).toEqual({ accepted: 0, duplicates: 1 });
    expect(ledger.ingest([print({ tx: "1" })])).toEqual({ accepted: 1, duplicates: 0 });
  });

  it("counts unpriced prints without adding to usd sums", () => {
    const ledger = new FlowLedger({ now: () => T0 });
    ledger.ingest([
      print({ tx: "b1", side: "buy", usd: 5 }),
      print({ tx: "b2", side: "buy", usd: null }),
      print({ tx: "s1", side: "sell", usd: 7 }),
      print({ tx: "s2", side: "sell", usd: null }),
      print({ tx: "s3", side: "sell", usd: null })
    ]);
    const [bucket] = totals(ledger, MINUTE_MS, 0, Number.MAX_SAFE_INTEGER);
    expect(bucket).toEqual({
      t: M0,
      buyUsd: 5,
      sellUsd: 7,
      buys: 2,
      sells: 3,
      unpricedBuys: 1,
      unpricedSells: 2
    });
  });

  it("folds into the hourly tier at ingest", () => {
    const ledger = new FlowLedger({ now: () => T0 });
    ledger.ingest([
      print({ tx: "a", time: H0 + 5 * MINUTE_MS, usd: 3 }),
      print({ tx: "b", time: H0 + 50 * MINUTE_MS, usd: 4, side: "sell" }),
      print({ tx: "c", time: H0 + HOUR_MS + 1, usd: 9 })
    ]);
    expect(ledger.stats()).toEqual({ pairs: 1, buckets: 5 });
    const hours = totals(ledger, HOUR_MS, 0, Number.MAX_SAFE_INTEGER);
    expect(hours.map((b) => [b.t, b.buyUsd, b.sellUsd])).toEqual([
      [H0, 3, 4],
      [H0 + HOUR_MS, 9, 0]
    ]);
  });

  it("skips prints with a non-finite time", () => {
    const ledger = new FlowLedger({ now: () => T0 });
    expect(ledger.ingest([print({ tx: "nan", time: Number.NaN })])).toEqual({ accepted: 0, duplicates: 0 });
    expect(ledger.stats()).toEqual({ pairs: 0, buckets: 0 });
  });
});

describe("FlowLedger series", () => {
  it("merges the minute tier and hourly-only hours without double counting", () => {
    const clock = { now: T0 };
    const ledger = new FlowLedger({ now: () => clock.now, minuteRetentionMs: 2 * HOUR_MS });
    const oldHour = H0 - 5 * HOUR_MS;
    ledger.ingest([
      print({ tx: "old1", time: oldHour + 10 * MINUTE_MS, usd: 100 }),
      print({ tx: "old2", time: oldHour + 20 * MINUTE_MS, usd: 50, side: "sell" })
    ]);
    clock.now = H0 + HOUR_MS;
    ledger.ingest([
      print({ tx: "new1", time: H0 + MINUTE_MS, usd: 20 }),
      print({ tx: "new2", time: H0 + 2 * MINUTE_MS, usd: 5, side: "sell" })
    ]);
    const hours = totals(ledger, HOUR_MS, 0, Number.MAX_SAFE_INTEGER);
    expect(hours).toEqual([
      { t: oldHour, buyUsd: 100, sellUsd: 50, buys: 1, sells: 1, unpricedBuys: 0, unpricedSells: 0 },
      { t: H0, buyUsd: 20, sellUsd: 5, buys: 1, sells: 1, unpricedBuys: 0, unpricedSells: 0 }
    ]);
    const minutes = totals(ledger, MINUTE_MS, 0, Number.MAX_SAFE_INTEGER);
    expect(minutes.map((b) => b.t)).toEqual([H0 + MINUTE_MS, H0 + 2 * MINUTE_MS]);
    const fourHour = totals(ledger, 4 * HOUR_MS, 0, Number.MAX_SAFE_INTEGER);
    expect(fourHour.reduce((sum, b) => sum + b.buyUsd, 0)).toBe(120);
    expect(fourHour.reduce((sum, b) => sum + b.buys + b.sells, 0)).toBe(4);
  });

  it("aggregates minutes into wider sub-hour buckets and respects the window", () => {
    const ledger = new FlowLedger({ now: () => T0 });
    ledger.ingest([
      print({ tx: "a", time: H0 + 1 * MINUTE_MS, usd: 1 }),
      print({ tx: "b", time: H0 + 4 * MINUTE_MS, usd: 2 }),
      print({ tx: "c", time: H0 + 5 * MINUTE_MS, usd: 4 }),
      print({ tx: "d", time: H0 + 30 * MINUTE_MS, usd: 8 })
    ]);
    const fives = totals(ledger, 5 * MINUTE_MS, H0, H0 + 10 * MINUTE_MS);
    expect(fives.map((b) => [b.t, b.buyUsd])).toEqual([
      [H0, 3],
      [H0 + 5 * MINUTE_MS, 4]
    ]);
    expect(totals(ledger, MINUTE_MS, 0, Number.MAX_SAFE_INTEGER, "unknown")).toEqual([]);
  });
});

describe("FlowLedger housekeeping", () => {
  it("evicts the least recently ingested pair beyond maxPairs", () => {
    const ledger = new FlowLedger({ now: () => T0, maxPairs: 2 });
    ledger.ingest([print({ tx: "a", pair: "p1" })]);
    ledger.ingest([print({ tx: "b", pair: "p2" })]);
    ledger.ingest([print({ tx: "c", pair: "p1" })]);
    ledger.ingest([print({ tx: "d", pair: "p3" })]);
    expect(ledger.pairs()).toEqual(["monad:p1", "monad:p3"]);
    expect(ledger.firstPrintAt("monad", "p2")).toBeNull();
  });

  it("prunes minute and hour buckets past retention using the injected clock", () => {
    const clock = { now: T0 };
    const ledger = new FlowLedger({ now: () => clock.now });
    ledger.ingest([print({ tx: "a", time: T0 })]);
    expect(ledger.stats()).toEqual({ pairs: 1, buckets: 2 });
    clock.now = T0 + 49 * HOUR_MS;
    ledger.ingest([print({ tx: "b", time: clock.now })]);
    expect(totals(ledger, MINUTE_MS, 0, Number.MAX_SAFE_INTEGER).map((b) => b.t)).toEqual([
      Math.floor(clock.now / MINUTE_MS) * MINUTE_MS
    ]);
    expect(totals(ledger, HOUR_MS, 0, Number.MAX_SAFE_INTEGER)).toHaveLength(2);
    clock.now = T0 + 49 * HOUR_MS + 31 * 24 * HOUR_MS;
    ledger.ingest([print({ tx: "c", time: clock.now })]);
    expect(totals(ledger, HOUR_MS, 0, Number.MAX_SAFE_INTEGER).map((b) => b.t)).toEqual([
      Math.floor(clock.now / HOUR_MS) * HOUR_MS
    ]);
    expect(ledger.firstPrintAt("monad", "pool-A")).toBe(T0);
  });

  it("keeps whole hours in the minute tier so the hourly merge stays exact", () => {
    const clock = { now: T0 };
    const ledger = new FlowLedger({ now: () => clock.now, minuteRetentionMs: HOUR_MS });
    ledger.ingest([print({ tx: "a", time: H0 + 10 * MINUTE_MS, usd: 1 }), print({ tx: "b", time: H0 + 50 * MINUTE_MS, usd: 2 })]);
    clock.now = H0 + HOUR_MS + 30 * MINUTE_MS;
    ledger.ingest([print({ tx: "c", time: clock.now, usd: 4 })]);
    expect(totals(ledger, MINUTE_MS, 0, Number.MAX_SAFE_INTEGER)).toHaveLength(3);
    expect(totals(ledger, HOUR_MS, 0, Number.MAX_SAFE_INTEGER).map((b) => b.buyUsd)).toEqual([3, 4]);
  });
});

describe("FlowLedger coverage", () => {
  it("returns 0 with a null firstPrintAt when the pair is unknown", () => {
    const ledger = new FlowLedger({ now: () => T0 });
    expect(ledger.coverage("monad", "none", T0, T0 + HOUR_MS)).toEqual({ fraction: 0, firstPrintAt: null });
  });

  it("reports the share of the window at or after the first print", () => {
    const ledger = new FlowLedger({ now: () => T0 });
    ledger.ingest([print({ tx: "b", time: T0 + 30 * MINUTE_MS }), print({ tx: "a", time: T0 + 15 * MINUTE_MS })]);
    const first = T0 + 15 * MINUTE_MS;
    expect(ledger.coverage("monad", "pool-A", T0, T0 + HOUR_MS)).toEqual({ fraction: 0.75, firstPrintAt: first });
    expect(ledger.coverage("monad", "pool-A", first, T0 + HOUR_MS).fraction).toBe(1);
    expect(ledger.coverage("monad", "pool-A", T0 - HOUR_MS, T0).fraction).toBe(0);
    expect(ledger.coverage("monad", "pool-A", T0 + HOUR_MS, T0).fraction).toBe(0);
  });
});

describe("FlowLedger recentPrints", () => {
  it("returns accepted prints newest first and an empty list for unknown pairs", () => {
    const ledger = new FlowLedger({ now: () => T0 });
    ledger.ingest([print({ tx: "a", time: T0 }), print({ tx: "b", time: T0 + 5000, side: "sell" }), print({ tx: "c", time: T0 + 2000, usd: null })]);
    expect(ledger.recentPrints("monad", "pool-A").map((p) => p.tx)).toEqual(["b", "c", "a"]);
    expect(ledger.recentPrints("monad", "pool-A", 2).map((p) => p.tx)).toEqual(["b", "c"]);
    expect(ledger.recentPrints("monad", "pool-A", 0)).toEqual([]);
    expect(ledger.recentPrints("monad", "nope")).toEqual([]);
  });

  it("keeps only the newest `recentRing` prints by time, whatever the ingest order", () => {
    const ledger = new FlowLedger({ now: () => T0, recentRing: 3 });
    ledger.ingest([print({ tx: "d", time: T0 + 4000 }), print({ tx: "b", time: T0 + 2000 }), print({ tx: "a", time: T0 + 1000 })]);
    ledger.ingest([print({ tx: "c", time: T0 + 3000 }), print({ tx: "z", time: T0 - 9000 })]);
    expect(ledger.recentPrints("monad", "pool-A").map((p) => p.tx)).toEqual(["d", "c", "b"]);
    expect(ledger.recentPrints("monad", "pool-A", 99)).toHaveLength(3);
  });

  it("never admits a duplicate tx into the ring and does not change bucket sums", () => {
    const ledger = new FlowLedger({ now: () => T0 });
    ledger.ingest([print({ tx: "dup", time: T0, usd: 10 })]);
    expect(ledger.ingest([print({ tx: "dup", time: T0 + 1000, usd: 999 })])).toEqual({ accepted: 0, duplicates: 1 });
    expect(ledger.recentPrints("monad", "pool-A").map((p) => [p.tx, p.usd])).toEqual([["dup", 10]]);
    expect(totals(ledger, MINUTE_MS, M0, M0)[0]).toMatchObject({ buyUsd: 10, buys: 1 });
  });
});

describe("toBars", () => {
  it("computes delta and a running cvd from the anchor", () => {
    const bucket = { buys: 0, sells: 0, unpricedBuys: 0, unpricedSells: 0 };
    const bars = toBars(
      [
        { ...bucket, t: 1, buyUsd: 10, sellUsd: 4 },
        { ...bucket, t: 2, buyUsd: 1, sellUsd: 9 },
        { ...bucket, t: 3, buyUsd: 0, sellUsd: 0 }
      ],
      MINUTE_MS,
      100
    );
    expect(bars.map((b) => [b.t, b.delta, b.cvd])).toEqual([
      [1, 6, 106],
      [2, -8, 98],
      [3, 0, 98]
    ]);
    expect(toBars([], MINUTE_MS)).toEqual([]);
  });
});
