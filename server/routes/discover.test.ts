import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { DiscoverResponse } from "../../shared/wire.js";
import { SOLANA_DISCOVER_ERROR, buildDiscoverResponse, resolveDiscoverQuery } from "./discover.js";

const NOW = 1_800_000_000_000;

function response(overrides: Partial<DiscoverResponse> = {}): DiscoverResponse {
  return { chain: "robinhood", view: "trending", window: "24h", rows: [], observedAt: NOW - 5, sources: [], coverage: null, ...overrides };
}

describe("resolveDiscoverQuery", () => {
  it("defaults to trending over 24h and requires a modelled chain", () => {
    expect(resolveDiscoverQuery({ chain: "robinhood" }, {})).toEqual({ chain: "robinhood", view: "trending", window: "24h" });
    expect(resolveDiscoverQuery({ chain: "solana" }, undefined)).toEqual({ chain: "solana", view: "trending", window: "24h" });
    expect(resolveDiscoverQuery({ chain: "robinhood" }, { view: "holders", window: "1h" })).toEqual({ chain: "robinhood", view: "holders", window: "1h" });
  });

  it("rejects unknown chains, views and windows", () => {
    expect(() => resolveDiscoverQuery({ chain: "base" }, {})).toThrow(ZodError);
    expect(() => resolveDiscoverQuery({ chain: "robinhood" }, { view: "gems" })).toThrow(ZodError);
    expect(() => resolveDiscoverQuery({ chain: "robinhood" }, { window: "7d" })).toThrow(ZodError);
    expect(() => resolveDiscoverQuery({}, {})).toThrow(ZodError);
  });
});

describe("buildDiscoverResponse", () => {
  it("hands robinhood queries to the builder as-is", async () => {
    const robinhood = vi.fn(async () => response({ view: "movers", window: "1h" }));
    const out = await buildDiscoverResponse({ chain: "robinhood", view: "movers", window: "1h" }, { robinhood, now: () => NOW });
    expect(robinhood).toHaveBeenCalledWith("movers", "1h");
    expect(out).toEqual(response({ view: "movers", window: "1h" }));
  });

  it("answers solana with the redirect error and no rows, without calling the builder", async () => {
    const robinhood = vi.fn(async () => response());
    const out = await buildDiscoverResponse({ chain: "solana", view: "new", window: "24h" }, { robinhood, now: () => NOW });
    expect(robinhood).not.toHaveBeenCalled();
    expect(out).toEqual({ chain: "solana", view: "new", window: "24h", rows: [], observedAt: NOW, sources: [], coverage: null, stale: true, error: SOLANA_DISCOVER_ERROR });
  });

  it("turns a throwing builder into a 200-shaped error envelope", async () => {
    const out = await buildDiscoverResponse({ chain: "robinhood", view: "holders", window: "24h" }, { robinhood: async () => Promise.reject(new Error("boom")), now: () => NOW });
    expect(out).toEqual({ chain: "robinhood", view: "holders", window: "24h", rows: [], observedAt: NOW, sources: [], coverage: null, stale: true, error: "discover: boom" });
  });
});
