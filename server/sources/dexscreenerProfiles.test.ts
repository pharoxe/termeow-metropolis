import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import boosts from "../launch/__fixtures__/dexscreener-token-boosts.json";
import profiles from "../launch/__fixtures__/dexscreener-token-profiles.json";
import { fetchLatestBoosts, fetchLatestProfiles, latestProfilesStatus, normalizeProfile, resetProfilesCache } from "./dexscreenerProfiles.js";

const PROFILES_URL = "https://api.dexscreener.com/token-profiles/latest/v1";
const BOOSTS_URL = "https://api.dexscreener.com/token-boosts/latest/v1";
const T0 = 1_760_000_000_000;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(handler: (url: string) => Response) {
  const spy = vi.fn(async (input: string | URL | Request) => handler(String(input)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function byUrl(): (url: string) => Response {
  return (url) => (url === PROFILES_URL ? jsonResponse(profiles) : url === BOOSTS_URL ? jsonResponse(boosts) : jsonResponse({}, 404));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetProfilesCache();
});

describe("normalizeProfile", () => {
  it("maps a robinhood profile row, lowercases the address and keeps typed and labelled links", () => {
    expect(normalizeProfile(profiles[0])).toEqual({
      chain: "robinhood",
      address: "0xd9f59e399941e377f8ec33405bde522f7fc75901",
      icon: "https://cdn.dexscreener.com/cms/images/H7qQurH9Xmc5e-nE?width=64&height=64&fit=crop&quality=95&format=auto",
      description: "The 8-meter ginger cat that took over Hong Kong International Airport. The internet named him Catzilla.",
      links: [
        { label: "Website", url: "https://hk.trip.com/moments/detail/hong-kong-38-148116110?locale=en-HK" },
        { type: "twitter", url: "https://x.com/catzillafutu" }
      ],
      url: "https://dexscreener.com/robinhood/0xd9f59e399941e377f8ec33405bde522f7fc75901",
      boostTotal: null
    });
  });

  it("keeps solana addresses exact and maps unknown chains to null", () => {
    expect(normalizeProfile(profiles[1])).toMatchObject({ chain: "solana", address: "53NXKcDfVyy6m9xn5YhDFTEgss8CzXHQjLvJhEDk64Lu" });
    expect(normalizeProfile({ ...profiles[0], chainId: "base" })?.chain).toBeNull();
    expect(normalizeProfile({ ...profiles[0], chainId: "bsc" })?.chain).toBeNull();
  });

  it("turns missing description / non-URL icon / malformed links into null or empty, never invents", () => {
    const bare = normalizeProfile({ ...profiles[0], description: "", icon: "XRUwjpNTfGYdC88o", links: [{ type: "twitter" }, "junk", { url: "" }] });
    expect(bare).toMatchObject({ description: null, icon: null, links: [] });
    expect(normalizeProfile({ ...profiles[0], links: undefined })?.links).toEqual([]);
    expect(normalizeProfile({ ...profiles[0], tokenAddress: "" })).toBeNull();
    expect(normalizeProfile({ ...profiles[0], url: undefined })).toBeNull();
    expect(normalizeProfile(null)).toBeNull();
  });

  it("fills boostTotal from boost rows", () => {
    expect(normalizeProfile(boosts[0])).toMatchObject({ chain: "robinhood", address: "0x92788a4870ee8c00059188b1114baad3b89568e0", boostTotal: 100, icon: null });
  });
});

describe("fetchLatestProfiles / fetchLatestBoosts", () => {
  it("hits the two keyless endpoints and returns every row including other-chain rows as chain null", async () => {
    const spy = stubFetch(byUrl());
    const rows = await fetchLatestProfiles();
    const boosted = await fetchLatestBoosts();
    expect(spy.mock.calls.map((call) => String(call[0]))).toEqual([PROFILES_URL, BOOSTS_URL]);
    expect(rows).toHaveLength(10);
    expect(rows.filter((row) => row.chain === "robinhood")).toHaveLength(8);
    expect(rows.filter((row) => row.chain === "solana")).toHaveLength(2);
    expect(boosted).toHaveLength(10);
    expect(boosted.every((row) => row.boostTotal !== null)).toBe(true);
  });

  it("caches each feed for 60s and refetches after", async () => {
    const spy = stubFetch(byUrl());
    await fetchLatestProfiles();
    vi.setSystemTime(T0 + 59_000);
    await fetchLatestProfiles();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(latestProfilesStatus()).toEqual({ observedAt: T0, stale: false });
    vi.setSystemTime(T0 + 61_000);
    await fetchLatestProfiles();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("returns an empty list for a non-array body and never throws after the first success", async () => {
    let calls = 0;
    stubFetch(() => (calls++ === 0 ? jsonResponse({ nope: true }) : jsonResponse({ error: "rate" }, 429)));
    expect(await fetchLatestProfiles()).toEqual([]);
    vi.setSystemTime(T0 + 61_000);
    await expect(fetchLatestProfiles()).resolves.toEqual([]);
    expect(latestProfilesStatus()).toEqual({ observedAt: T0, stale: true });
  });

  it("throws before any success so the route can answer 200 + error", async () => {
    stubFetch(() => jsonResponse({ error: "down" }, 503));
    await expect(fetchLatestProfiles()).rejects.toThrow("503");
    expect(latestProfilesStatus()).toBeNull();
  });
});
