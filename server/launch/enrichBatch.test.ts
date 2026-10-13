import { describe, expect, it } from "vitest";
import { pickEnrichBatch, pruneAttempts } from "./enrichBatch.js";

const NOW = 1_800_000_000_000;

describe("pickEnrichBatch", () => {
  it("takes never-attempted tokens first in candidate order, then the least recently attempted", () => {
    const attempts = new Map([["a", NOW - 3_000], ["b", NOW - 1_000], ["d", NOW - 2_000]]);
    const picked = pickEnrichBatch(["a", "b", "c", "d", "e"], (token) => attempts.get(token) ?? null, 4);
    expect(picked).toEqual(["c", "e", "a", "d"]);
  });

  it("falls back to newest-first when nothing was attempted and respects the limit", () => {
    expect(pickEnrichBatch(["n1", "n2", "n3"], () => null, 2)).toEqual(["n1", "n2"]);
    expect(pickEnrichBatch(["n1", "n2"], () => null, 0)).toEqual([]);
    expect(pickEnrichBatch([], () => null, 5)).toEqual([]);
  });

  it("rotates: a token attempted this cycle drops behind every older or unattempted one next cycle", () => {
    const attempts = new Map<string, number>();
    const candidates = ["t1", "t2", "t3", "t4", "t5"];
    const first = pickEnrichBatch(candidates, (token) => attempts.get(token) ?? null, 2);
    for (const token of first) attempts.set(token, NOW);
    const second = pickEnrichBatch(candidates, (token) => attempts.get(token) ?? null, 2);
    for (const token of second) attempts.set(token, NOW + 60_000);
    const third = pickEnrichBatch(candidates, (token) => attempts.get(token) ?? null, 2);
    expect(first).toEqual(["t1", "t2"]);
    expect(second).toEqual(["t3", "t4"]);
    expect(third).toEqual(["t5", "t1"]);
  });
});

describe("pruneAttempts", () => {
  it("drops stamps for tokens of that chain outside the window and leaves the other chain alone", () => {
    const attempts = new Map([["monad:0xa", NOW], ["monad:0xb", NOW], ["solana:mint", NOW]]);
    pruneAttempts(attempts, "monad", ["0xA"]);
    expect([...attempts.keys()]).toEqual(["monad:0xa", "solana:mint"]);
  });
});
