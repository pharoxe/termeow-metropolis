import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { LaunchRow } from "../../shared/wire.js";
import { LAUNCHES_LIMIT, buildLaunchesResponse, resolveLaunchesQuery, toListQuery, type LaunchesRouteDeps } from "./launches.js";

const NOW = 1_800_000_000_000;

function row(overrides: Partial<LaunchRow> = {}): LaunchRow {
  return {
    chain: "monad",
    launchpad: "pons",
    token: "0xaaaa000000000000000000000000000000000001",
    symbol: "MEAO",
    name: null,
    image: null,
    creator: null,
    curve: null,
    pool: null,
    createdAt: NOW - 1000,
    tx: "0xtx",
    graduatedAt: null,
    priceUsd: null,
    marketCapUsd: null,
    liquidityUsd: null,
    volume24Usd: null,
    change24Pct: null,
    pricedAt: null,
    curveBuys: 0,
    curveSells: 0,
    curveNetUsd: null,
    tracked: null,
    sources: ["rpc:monad"],
    observedAt: NOW,
    ...overrides
  };
}

const SOURCES = [{ name: "rpc:monad", lastOkAt: NOW - 100, lastError: null }];

function deps(overrides: Partial<LaunchesRouteDeps["service"]> = {}): LaunchesRouteDeps & { list: ReturnType<typeof vi.fn> } {
  const list = vi.fn(() => [row()]);
  return { service: { list, status: () => ({ sources: SOURCES }), ...overrides }, now: () => NOW, list };
}

describe("resolveLaunchesQuery", () => {
  it("defaults to all chains, 24h, stocks hidden, no pad", () => {
    expect(resolveLaunchesQuery({})).toEqual({ chain: "all", window: "24h", stocks: "0" });
    expect(resolveLaunchesQuery(undefined)).toEqual({ chain: "all", window: "24h", stocks: "0" });
  });

  it("parses chain, window, pad and stocks from query strings", () => {
    expect(resolveLaunchesQuery({ chain: "monad", window: "1h", pad: " nad.fun ", stocks: "1" })).toEqual({ chain: "monad", window: "1h", pad: "nad.fun", stocks: "1" });
  });

  it("rejects unknown chains, windows, stock flags and empty pads", () => {
    expect(() => resolveLaunchesQuery({ chain: "base" })).toThrow(ZodError);
    expect(() => resolveLaunchesQuery({ chain: "solana" })).toThrow(ZodError);
    expect(() => resolveLaunchesQuery({ window: "7d" })).toThrow(ZodError);
    expect(() => resolveLaunchesQuery({ stocks: "yes" })).toThrow(ZodError);
    expect(() => resolveLaunchesQuery({ pad: "  " })).toThrow(ZodError);
  });
});

describe("toListQuery", () => {
  it("maps windows to ms, stocks to includeStocks, and caps the list", () => {
    expect(toListQuery({ chain: "all", window: "24h", stocks: "0" })).toEqual({ chain: "all", windowMs: 86_400_000, includeStocks: false, limit: LAUNCHES_LIMIT });
    expect(toListQuery({ chain: "monad", window: "6h", stocks: "1", pad: "pons" })).toEqual({ chain: "monad", windowMs: 21_600_000, pad: "pons", includeStocks: true, limit: LAUNCHES_LIMIT });
    expect(toListQuery({ chain: "all", window: "1h", stocks: "0" }).windowMs).toBe(3_600_000);
  });
});

describe("buildLaunchesResponse", () => {
  it("returns the LaunchesResponse envelope with rows, sources and observedAt", () => {
    const d = deps();
    const response = buildLaunchesResponse({ chain: "monad", window: "6h", stocks: "1" }, d);
    expect(d.list).toHaveBeenCalledWith({ chain: "monad", windowMs: 21_600_000, includeStocks: true, limit: LAUNCHES_LIMIT });
    expect(response).toEqual({ launches: [row()], window: "6h", chain: "monad", observedAt: NOW, sources: SOURCES });
  });

  it("flags a capacity-truncated list so a full page is not mistaken for the whole window", () => {
    const full = Array.from({ length: LAUNCHES_LIMIT }, (_, i) => row({ token: `0x${String(i).padStart(40, "0")}` }));
    const response = buildLaunchesResponse({ chain: "all", window: "24h", stocks: "0" }, deps({ list: () => full }));
    expect(response.truncated).toBe(true);
    expect(response.launches).toHaveLength(LAUNCHES_LIMIT);
    expect(buildLaunchesResponse({ chain: "all", window: "24h", stocks: "0" }, deps()).truncated).toBeUndefined();
  });

  it("degrades to 200 + error with an empty list when the service throws", () => {
    const d = deps({ list: () => { throw new Error("index locked"); } });
    const response = buildLaunchesResponse({ chain: "all", window: "24h", stocks: "0" }, d);
    expect(response).toEqual({ launches: [], window: "24h", chain: "all", observedAt: NOW, sources: SOURCES, stale: true, error: "list: index locked" });
  });

  it("keeps rows and reports a status failure as error when only status() throws", () => {
    const d = deps({ status: () => { throw new Error("stats broke"); } });
    const response = buildLaunchesResponse({ chain: "all", window: "1h", stocks: "0" }, d);
    expect(response.launches).toHaveLength(1);
    expect(response.sources).toEqual([]);
    expect(response.error).toBe("status: stats broke");
    expect(response.stale).toBeUndefined();
  });
});
