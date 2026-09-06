import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { HANDLES_POPULATION, HANDLES_RETRY_MS, HandleBook, TAPE_TTL_MS, TAPE_URL, TRADERS_TTL_MS, TRADERS_URL } from "./handles.js";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const UNIPCS = "0x0a6ebed0155edb4b21d92ad02897a626cd90119e";
const TAPE_ONLY = "0x281d6b1de357372bcba4f190748a6cedc655f0fd";
const LEARNED_ONLY = "0xf89f3858bc7bac05a83ec284e3e9acdb58bf892a";
const T0 = Date.parse("2026-09-06T16:08:08Z");

type TradersFixture = { totalRows: number; rows: Array<Record<string, unknown>> };

/** robinhoodtrenches /api/traders?window=all&limit=500 captured 2026-09-06 (147 rows, trimmed to 20). */
const TRADERS = JSON.parse(readFileSync(new URL("traders.json", FIXTURES), "utf8")) as TradersFixture;

/** Two /api/tape rows in the captured shape: one wallet already in traders, one only on the tape. */
const TAPE_ROWS = [
  { id: 1, tx: "0x01", wallet: UNIPCS, handle: "unipcs-on-tape", followers: 1, side: "buy" },
  { id: 2, tx: "0x02", wallet: TAPE_ONLY, handle: "pingucharts", followers: 27_395, side: "buy" },
  { id: 3, tx: "0x03", wallet: TAPE_ONLY, handle: "pingucharts", followers: 27_395, side: "sell" },
  { id: 4, tx: "0x04", wallet: "not-a-wallet", handle: "ghost", followers: null, side: "buy" }
];

type Bodies = Record<string, unknown | (() => unknown)>;

function fakeFetch(bodies: Bodies) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = bodies[url];
    const value = typeof body === "function" ? (body as () => unknown)() : body;
    if (value instanceof Error) throw value;
    if (value === undefined) return new Response("nope", { status: 404 });
    return new Response(typeof value === "string" ? value : JSON.stringify(value), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function clock(start = T0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function book(fetch: ReturnType<typeof fakeFetch>, time = clock()): HandleBook {
  return new HandleBook({ fetchImpl: fetch.fetchImpl, now: time.now });
}

describe("HandleBook", () => {
  it("loads the robinhoodtrenches traders list and answers get() case-insensitively", async () => {
    const fetch = fakeFetch({ [TRADERS_URL]: TRADERS.rows, [TAPE_URL]: [] });
    const handles = book(fetch);
    expect(handles.get(UNIPCS)).toBeNull();
    await handles.refresh();
    expect(handles.get(UNIPCS.toUpperCase().replace("0X", "0x"))).toEqual({
      handle: "unipcs",
      followers: 514_576,
      profileUrl: "https://fomo.family/profile/unipcs",
      source: "traders"
    });
    expect(handles.get(`0x${"9".repeat(40)}`)).toBeNull();
    expect(handles.stats()).toMatchObject({ entries: TRADERS.rows.length, population: HANDLES_POPULATION, traders: { rows: TRADERS.rows.length, lastOkAt: T0, lastError: null }, tape: { rows: 0 }, learned: 0 });
    expect(fetch.calls.sort()).toEqual([TAPE_URL, TRADERS_URL].sort());
  });

  it("get() schedules the first load in the background and dedupes it with refresh()", async () => {
    const fetch = fakeFetch({ [TRADERS_URL]: TRADERS.rows, [TAPE_URL]: TAPE_ROWS });
    const handles = book(fetch);
    handles.get(UNIPCS);
    handles.get(UNIPCS);
    await handles.refresh();
    expect(fetch.calls).toHaveLength(2);
    expect(handles.get(UNIPCS)?.handle).toBe("unipcs");
  });

  it("tape rows fill gaps with a fomo.family profile link but never override a traders entry", async () => {
    const fetch = fakeFetch({ [TRADERS_URL]: TRADERS.rows, [TAPE_URL]: TAPE_ROWS });
    const handles = book(fetch);
    await handles.refresh();
    expect(handles.get(UNIPCS)?.handle).toBe("unipcs");
    expect(handles.get(TAPE_ONLY)).toEqual({ handle: "pingucharts", followers: 27_395, profileUrl: "https://fomo.family/profile/pingucharts", source: "tape" });
    expect(handles.stats()).toMatchObject({ entries: TRADERS.rows.length + 1, tape: { rows: 3, lastError: null } });
  });

  it("learn() fills a gap and never overrides a feed entry; malformed input is ignored", async () => {
    const fetch = fakeFetch({ [TRADERS_URL]: TRADERS.rows, [TAPE_URL]: TAPE_ROWS });
    const handles = book(fetch);
    handles.learn(LEARNED_ONLY, "MEADGod", 1_234);
    handles.learn(UNIPCS, "someone-else", 5);
    handles.learn("0x1234", "short", null);
    handles.learn(LEARNED_ONLY.replace("0x", "0x").toUpperCase().replace("0X", "0x"), "  ", null);
    expect(handles.get(LEARNED_ONLY)).toEqual({ handle: "MEADGod", followers: 1_234, profileUrl: "https://fomo.family/profile/MEADGod", source: "learned" });
    expect(handles.get(UNIPCS)?.handle).toBe("someone-else");
    await handles.refresh();
    expect(handles.get(UNIPCS)?.handle).toBe("unipcs");
    expect(handles.get(TAPE_ONLY)?.source).toBe("tape");
    handles.learn(TAPE_ONLY, "learned-later", null);
    expect(handles.get(TAPE_ONLY)?.handle).toBe("pingucharts");
    expect(handles.stats().learned).toBe(1);
  });

  it("refreshes the tape every 15 min and the traders list every 60 min", async () => {
    const time = clock();
    const fetch = fakeFetch({ [TRADERS_URL]: TRADERS.rows, [TAPE_URL]: TAPE_ROWS });
    const handles = book(fetch, time);
    await handles.refresh();
    expect(fetch.calls).toHaveLength(2);
    time.advance(TAPE_TTL_MS - 1);
    handles.get(UNIPCS);
    await handles.refresh();
    expect(fetch.calls).toHaveLength(2);
    time.advance(1);
    handles.get(UNIPCS);
    await handles.refresh();
    expect(fetch.calls.filter((url) => url === TAPE_URL)).toHaveLength(2);
    expect(fetch.calls.filter((url) => url === TRADERS_URL)).toHaveLength(1);
    time.advance(TRADERS_TTL_MS);
    await handles.refresh();
    expect(fetch.calls.filter((url) => url === TRADERS_URL)).toHaveLength(2);
  });

  it("keeps last-good entries and records lastError when a feed fails, then retries after HANDLES_RETRY_MS", async () => {
    const time = clock();
    let tradersBody: unknown = TRADERS.rows;
    const fetch = fakeFetch({ [TRADERS_URL]: () => tradersBody, [TAPE_URL]: { not: "an array" } });
    const handles = book(fetch, time);
    await handles.refresh();
    expect(handles.stats().tape.lastError).toContain("not an array");
    expect(handles.get(UNIPCS)?.handle).toBe("unipcs");
    tradersBody = new Error("socket hang up");
    time.advance(TRADERS_TTL_MS);
    await expect(handles.refresh()).resolves.toBeUndefined();
    expect(handles.get(UNIPCS)?.handle).toBe("unipcs");
    expect(handles.stats().traders).toMatchObject({ rows: TRADERS.rows.length, lastOkAt: T0, lastError: "traders: socket hang up" });
    const before = fetch.calls.length;
    time.advance(HANDLES_RETRY_MS - 1);
    await handles.refresh();
    expect(fetch.calls).toHaveLength(before);
    time.advance(1);
    await handles.refresh();
    expect(fetch.calls.length).toBeGreaterThan(before);
  });

  it("never throws: a 404, a non-JSON body and a rejecting fetch all land in lastError", async () => {
    const net = fakeFetch({ [TRADERS_URL]: "<html>", [TAPE_URL]: undefined });
    const handles = book(net);
    await expect(handles.refresh()).resolves.toBeUndefined();
    expect(handles.stats().traders.lastError).toMatch(/traders: /);
    expect(handles.stats().tape.lastError).toContain("404");
    expect(handles.stats().entries).toBe(0);
    const throwing = new HandleBook({
      fetchImpl: (() => {
        throw new Error("sync throw");
      }) as unknown as typeof globalThis.fetch,
      now: () => T0
    });
    expect(() => throwing.get(UNIPCS)).not.toThrow();
    await expect(throwing.refresh(true)).resolves.toBeUndefined();
    expect(throwing.stats().traders.lastError).toContain("sync throw");
  });
});
