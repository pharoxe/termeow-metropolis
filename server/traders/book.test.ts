import { describe, expect, it } from "vitest";
import { TraderBook } from "./book.js";
import type { TraderFill } from "./book.js";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const W1 = "0xaaaa";
const W2 = "0xbbbb";

let seq = 0;
function fill(over: Partial<TraderFill> = {}): TraderFill {
  seq += 1;
  return {
    chain: "robinhood",
    pair: "pool-A",
    tx: `tx-${seq}`,
    time: T0,
    side: "buy",
    usd: 100,
    source: "own",
    trader: W1,
    token: "TOK-A",
    ...over
  };
}

function book(over: ConstructorParameters<typeof TraderBook>[0] = {}) {
  return new TraderBook({ now: () => T0 + HOUR, ...over });
}

describe("TraderBook aggregation", () => {
  it("sums fills, buys, sells, usd and tokens per (chain, wallet)", () => {
    const b = book();
    b.recordAll([
      fill({ side: "buy", usd: 100 }),
      fill({ side: "buy", usd: 50, token: "TOK-B" }),
      fill({ side: "sell", usd: 30 }),
      fill({ side: "sell", usd: null, token: "TOK-C" })
    ]);
    const stats = b.stats("robinhood", W1);
    expect(stats).toMatchObject({
      fills: 4,
      buys: 2,
      sells: 2,
      buyUsd: 150,
      sellUsd: 30,
      netUsd: 120,
      tokens: 3,
      firstSeenAt: T0,
      lastSeenAt: T0
    });
  });

  it("keeps the same wallet apart per chain and returns null for unknown wallets", () => {
    const b = book();
    b.record(fill({ chain: "robinhood" }));
    b.record(fill({ chain: "solana", pair: "pool-S", token: "MINT" }));
    expect(b.stats("robinhood", W1)?.fills).toBe(1);
    expect(b.stats("solana", W1)?.fills).toBe(1);
    expect(b.stats("solana", W2)).toBeNull();
  });

  it("dedupes on chain+tx+pair+trader+side and rejects malformed fills", () => {
    const b = book();
    const f = fill();
    expect(b.record(f)).toBe("accepted");
    expect(b.record({ ...f, usd: 999 })).toBe("duplicate");
    expect(b.record({ ...f, side: "sell", usd: 40 })).toBe("accepted");
    expect(b.stats("robinhood", W1)).toMatchObject({ fills: 2, buys: 1, sells: 1, sellUsd: 40 });
    expect(b.record(fill({ trader: "" }))).toBe("rejected");
    expect(b.record(fill({ time: Number.NaN }))).toBe("rejected");
    expect(b.recordAll([fill(), f])).toEqual({ accepted: 1, duplicates: 1, rejected: 0 });
    expect(b.stats("robinhood", W1)?.buyUsd).toBe(200);
    expect(b.stats("robinhood", W1)?.fills).toBe(3);
  });

  it("keeps the latest non-null handle/followers/kind and never lets null erase them", () => {
    const b = book();
    b.record(fill({ handle: "unipcs", followers: 10, kind: "fomo" }));
    b.record(fill({ handle: null, followers: null, kind: null }));
    expect(b.stats("robinhood", W1)).toMatchObject({ handle: "unipcs", followers: 10, kind: "fomo" });
    b.record(fill({ followers: 12 }));
    expect(b.stats("robinhood", W1)?.followers).toBe(12);
    expect(b.stats("robinhood", W2)).toBeNull();
  });
});

describe("TraderBook round trips", () => {
  it("counts a token with priced buys and sells as one closed trade, win when sellUsd > buyUsd", () => {
    const b = book();
    b.recordAll([
      fill({ token: "A", side: "buy", usd: 100 }),
      fill({ token: "A", side: "buy", usd: 100 }),
      fill({ token: "A", side: "sell", usd: 250 }),
      fill({ token: "B", side: "buy", usd: 100 }),
      fill({ token: "B", side: "sell", usd: 40 }),
      fill({ token: "C", side: "buy", usd: 100 })
    ]);
    expect(b.stats("robinhood", W1)).toMatchObject({ closed: 2, wins: 1, wilsonLow: null });
  });

  it("does not close a round trip on unpriced fills", () => {
    const b = book();
    b.recordAll([fill({ token: "A", side: "buy", usd: 100 }), fill({ token: "A", side: "sell", usd: null })]);
    expect(b.stats("robinhood", W1)).toMatchObject({ closed: 0, wins: 0 });
  });

  it("reports a Wilson bound only from five closed trades", () => {
    const b = book();
    for (let i = 0; i < 4; i += 1) {
      b.record(fill({ token: `T${i}`, side: "buy", usd: 10 }));
      b.record(fill({ token: `T${i}`, side: "sell", usd: 20 }));
    }
    expect(b.stats("robinhood", W1)?.wilsonLow).toBeNull();
    b.record(fill({ token: "T4", side: "buy", usd: 10 }));
    b.record(fill({ token: "T4", side: "sell", usd: 5 }));
    const stats = b.stats("robinhood", W1);
    expect(stats?.closed).toBe(5);
    expect(stats?.wins).toBe(4);
    expect(stats?.wilsonLow).toBeCloseTo(0.376, 2);
  });
});

describe("TraderBook rank", () => {
  it("sorts by netUsd desc and applies the kind filter", () => {
    const b = book();
    b.recordAll([
      fill({ trader: W1, usd: 100, kind: "fomo" }),
      fill({ trader: W2, usd: 500 }),
      fill({ trader: "0xcccc", usd: 300, side: "sell", kind: "fomo" })
    ]);
    expect(b.rank("all", Number.POSITIVE_INFINITY).map((r) => r.wallet)).toEqual([W2, W1, "0xcccc"]);
    expect(b.rank("all", Number.POSITIVE_INFINITY, { kind: "fomo" }).map((r) => r.wallet)).toEqual([W1, "0xcccc"]);
    expect(b.rank("solana", Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("re-folds a finite window from the ring and leaves lifetime stats untouched", () => {
    const b = book();
    b.recordAll([
      fill({ trader: W1, usd: 1000, time: T0 - 3 * HOUR, token: "OLD" }),
      fill({ trader: W1, usd: 10, time: T0 + HOUR - 60_000 }),
      fill({ trader: W2, usd: 20, time: T0 - 3 * HOUR })
    ]);
    const windowed = b.rank("robinhood", HOUR);
    expect(windowed.map((r) => [r.wallet, r.netUsd, r.fills])).toEqual([[W1, 10, 1]]);
    const lifetime = b.rank("robinhood", Number.POSITIVE_INFINITY);
    expect(lifetime.map((r) => [r.wallet, r.netUsd])).toEqual([
      [W1, 1010],
      [W2, 20]
    ]);
    expect(b.oldestFillAt()).toBe(T0 - 3 * HOUR);
  });

  it("carries lifetime identity onto windowed rows", () => {
    const b = book();
    b.record(fill({ handle: "unipcs", kind: "fomo", time: T0 - 3 * HOUR }));
    b.record(fill({ time: T0 + HOUR }));
    expect(b.rank("all", HOUR)[0]).toMatchObject({ handle: "unipcs", kind: "fomo", fills: 1 });
  });
});

describe("TraderBook tape and bounds", () => {
  it("returns newest fills first with token filter, kind filter and limit", () => {
    const b = book();
    b.recordAll([
      fill({ time: T0 + 1, token: "A", tx: "t1", kind: "fomo" }),
      fill({ time: T0 + 3, token: "B", tx: "t3", trader: W2 }),
      fill({ time: T0 + 2, token: "A", tx: "t2", side: "sell" })
    ]);
    expect(b.tape("all", 10).map((r) => r.tx)).toEqual(["t3", "t2", "t1"]);
    expect(b.tape("all", 10, { token: "A" }).map((r) => r.tx)).toEqual(["t2", "t1"]);
    expect(b.tape("all", 10, { kind: "fomo" }).map((r) => r.tx)).toEqual(["t2", "t1"]);
    expect(b.tape("all", 1).map((r) => r.tx)).toEqual(["t3"]);
    expect(b.tape("solana", 10)).toEqual([]);
    expect(b.tape("all", 0)).toEqual([]);
    expect(b.tape("all", 1)[0]).toMatchObject({ trader: W2, pair: "pool-A", side: "buy", usd: 100, kind: null });
  });

  it("drops the oldest fills once the ring is full and the least-recently-seen wallets past max", () => {
    const b = book({ fills: 3, max: 2 });
    b.recordAll([
      fill({ trader: W1, time: T0 + 1, tx: "a" }),
      fill({ trader: W2, time: T0 + 2, tx: "b" }),
      fill({ trader: W1, time: T0 + 3, tx: "c" }),
      fill({ trader: "0xcccc", time: T0 + 4, tx: "d" })
    ]);
    expect(b.size()).toEqual({ wallets: 2, fills: 3 });
    expect(b.tape("all", 10).map((r) => r.tx)).toEqual(["d", "c", "b"]);
    expect(b.stats("robinhood", W2)).toBeNull();
    expect(b.stats("robinhood", W1)?.fills).toBe(2);
    expect(b.stats("robinhood", "0xcccc")?.fills).toBe(1);
  });

  it("bounds distinct tokens per wallet by evicting the oldest position", () => {
    const b = book({ maxTokens: 2 });
    b.recordAll([fill({ token: "A" }), fill({ token: "B" }), fill({ token: "C" })]);
    expect(b.stats("robinhood", W1)?.tokens).toBe(2);
    b.record(fill({ token: "A", side: "sell", usd: 200 }));
    expect(b.stats("robinhood", W1)?.closed).toBe(0);
  });
});
