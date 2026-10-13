import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { DiscoverResponse } from "../../shared/wire.js";
import { buildDiscoverResponse, resolveDiscoverQuery } from "./discover.js";

const NOW = 1_800_000_000_000;

function response(overrides: Partial<DiscoverResponse> = {}): DiscoverResponse {
  return { chain: "monad", view: "trending", window: "24h", rows: [], observedAt: NOW - 5, sources: [], coverage: null, ...overrides };
}

describe("resolveDiscoverQuery", () => {
  it("defaults to trending over 24h and requires a modelled chain", () => {
    expect(resolveDiscoverQuery({ chain: "monad" }, {})).toEqual({ chain: "monad", view: "trending", window: "24h" });
    expect(resolveDiscoverQuery({ chain: "monad" }, undefined)).toEqual({ chain: "monad", view: "trending", window: "24h" });
    expect(resolveDiscoverQuery({ chain: "monad" }, { view: "holders", window: "1h" })).toEqual({ chain: "monad", view: "holders", window: "1h" });
  });

  it("rejects unknown chains, views and windows", () => {
    expect(() => resolveDiscoverQuery({ chain: "base" }, {})).toThrow(ZodError);
    expect(() => resolveDiscoverQuery({ chain: "solana" }, {})).toThrow(ZodError);
    expect(() => resolveDiscoverQuery({ chain: "monad" }, { view: "gems" })).toThrow(ZodError);
    expect(() => resolveDiscoverQuery({ chain: "monad" }, { window: "7d" })).toThrow(ZodError);
    expect(() => resolveDiscoverQuery({}, {})).toThrow(ZodError);
  });
});

describe("buildDiscoverResponse", () => {
  it("hands monad queries to the builder as-is", async () => {
    const monad = vi.fn(async () => response({ view: "movers", window: "1h" }));
    const out = await buildDiscoverResponse({ chain: "monad", view: "movers", window: "1h" }, { monad, now: () => NOW });
    expect(monad).toHaveBeenCalledWith("movers", "1h");
    expect(out).toEqual(response({ view: "movers", window: "1h" }));
  });

  it("turns a throwing builder into a 200-shaped error envelope", async () => {
    const out = await buildDiscoverResponse({ chain: "monad", view: "holders", window: "24h" }, { monad: async () => Promise.reject(new Error("boom")), now: () => NOW });
    expect(out).toEqual({ chain: "monad", view: "holders", window: "24h", rows: [], observedAt: NOW, sources: [], coverage: null, stale: true, error: "discover: boom" });
  });
});
