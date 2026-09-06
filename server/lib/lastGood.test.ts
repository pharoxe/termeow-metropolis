import { describe, expect, it, vi } from "vitest";
import { createLastGoodCache } from "./lastGood.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("createLastGoodCache", () => {
  it("loads once within the TTL and reloads after it", async () => {
    const c = clock();
    const cache = createLastGoodCache<number>(60_000, c.now);
    const load = vi.fn(async () => 1);
    const first = await cache.get("k", load);
    expect(first).toEqual({ value: 1, observedAt: 1_000_000, stale: false });
    c.advance(59_999);
    expect(await cache.get("k", load)).toEqual(first);
    expect(load).toHaveBeenCalledTimes(1);
    c.advance(1);
    await cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent loads for the same key", async () => {
    const cache = createLastGoodCache<string>(1_000);
    const load = vi.fn(async () => "x");
    const [a, b] = await Promise.all([cache.get("k", load), cache.get("k", load)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("serves last-good with stale + error on failure and throws only when nothing was cached", async () => {
    const c = clock();
    const cache = createLastGoodCache<number>(1_000, c.now);
    await expect(cache.get("k", async () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(cache.peek("k")).toBeNull();
    await cache.get("k", async () => 7);
    c.advance(2_000);
    const stale = await cache.get("k", async () => Promise.reject(new Error("rate")));
    expect(stale).toEqual({ value: 7, observedAt: 1_000_000, stale: true, error: "rate" });
    expect(cache.peek("k")).toEqual({ value: 7, observedAt: 1_000_000, stale: true });
    cache.reset();
    expect(cache.peek("k")).toBeNull();
  });
});
