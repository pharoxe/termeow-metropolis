import { describe, expect, it, vi } from "vitest";
import type { SmartMoneyTrade } from "../sources/nansen.js";
import { HANDLES_POPULATION, HANDLES_RETRY_MS, HandleBook, profileUrlFor, type SmartTradesSource } from "./handles.js";

const ALPHA = "0x0a6ebed0155edb4b21d92ad02897a626cd90119e";
const BETA = "0x281d6b1de357372bcba4f190748a6cedc655f0fd";
const WATCHED = "0xf89f3858bc7bac05a83ec284e3e9acdb58bf892a";
const T0 = Date.parse("2026-09-06T16:08:08Z");
const REFRESH_MS = 600_000;

function trade(trader: string, label: string | null): SmartMoneyTrade {
  return { time: T0, tx: `0x${trader.slice(2, 10)}`, trader, label, boughtToken: "0x1", boughtSymbol: "X", soldToken: "0x2", soldSymbol: "MON", valueUsd: 100 };
}

function source(impl: () => Promise<{ data: SmartMoneyTrade[]; error: string | null }>, configured = true): SmartTradesSource & { dexTrades: ReturnType<typeof vi.fn> } {
  return { configured, dexTrades: vi.fn(impl) };
}

describe("HandleBook", () => {
  it("labels every Nansen smart-money trader and reports the population", async () => {
    let now = T0;
    const onTraders = vi.fn();
    const src = source(async () => ({ data: [trade(ALPHA, "Fund"), trade(BETA, null), trade(ALPHA, "Fund")], error: null }));
    const book = new HandleBook({ now: () => now, source: src, refreshMs: REFRESH_MS, onTraders });
    await book.refresh(true);
    expect(book.get(ALPHA.toUpperCase().replace("0X", "0x"))).toEqual({ handle: "Fund", followers: null, profileUrl: profileUrlFor(ALPHA), source: "nansen" });
    expect(book.get(BETA)?.handle).toBe("Smart Money");
    expect(book.isTracked(BETA)).toBe(true);
    expect(onTraders).toHaveBeenCalledWith([ALPHA, BETA]);
    expect(book.stats()).toMatchObject({ entries: 2, population: HANDLES_POPULATION, nansen: { rows: 3, lastOkAt: T0, lastError: null, configured: true } });
    now += REFRESH_MS - 1;
    book.get(ALPHA);
    expect(src.dexTrades).toHaveBeenCalledTimes(1);
  });

  it("keeps last-good entries on a failed load and retries after HANDLES_RETRY_MS", async () => {
    let now = T0;
    let fail = false;
    const src = source(async () => {
      if (fail) throw new Error("429");
      return { data: [trade(ALPHA, "Fund")], error: null };
    });
    const book = new HandleBook({ now: () => now, source: src, refreshMs: REFRESH_MS });
    await book.refresh(true);
    fail = true;
    await book.refresh(true);
    expect(book.get(ALPHA)?.handle).toBe("Fund");
    expect(book.stats().nansen.lastError).toBe("nansen: 429");
    now += HANDLES_RETRY_MS - 1;
    await book.refresh();
    expect(src.dexTrades).toHaveBeenCalledTimes(2);
    now += 1;
    await book.refresh();
    expect(src.dexTrades).toHaveBeenCalledTimes(3);
  });

  it("never fetches when Nansen is not configured", async () => {
    const src = source(async () => ({ data: [], error: null }), false);
    const book = new HandleBook({ now: () => T0, source: src });
    book.get(ALPHA);
    await book.refresh(true);
    expect(src.dexTrades).not.toHaveBeenCalled();
    expect(book.stats().nansen.configured).toBe(false);
  });

  it("watches valid wallets once, and learned labels never override Nansen or watchlist rows", async () => {
    const onTraders = vi.fn();
    const book = new HandleBook({ now: () => T0, source: source(async () => ({ data: [trade(ALPHA, "Fund")], error: null })), onTraders });
    await book.refresh(true);
    onTraders.mockClear();
    expect(book.watch([WATCHED, WATCHED.toUpperCase().replace("0X", "0x"), "not-an-address"])).toBe(1);
    expect(book.watch([WATCHED])).toBe(0);
    expect(onTraders).toHaveBeenCalledTimes(1);
    book.learn(ALPHA, "someone", 5);
    book.learn(WATCHED, "someone", 5);
    book.learn(BETA, "pingucharts", 27_395);
    expect(book.get(ALPHA)?.source).toBe("nansen");
    expect(book.get(WATCHED)).toMatchObject({ handle: "watched", source: "watchlist" });
    expect(book.get(BETA)).toMatchObject({ handle: "pingucharts", followers: 27_395, source: "learned" });
    expect(book.stats()).toMatchObject({ entries: 3, watchlist: 1, learned: 1 });
  });

  it("persists only watchlist and learned rows and restores them", async () => {
    const book = new HandleBook({ now: () => T0, source: source(async () => ({ data: [trade(ALPHA, "Fund")], error: null })) });
    await book.refresh(true);
    book.watch([WATCHED]);
    book.learn(BETA, "pingucharts", null);
    const saved = book.learned();
    expect(saved.map(([wallet]) => wallet).sort()).toEqual([BETA, WATCHED].sort());
    const onTraders = vi.fn();
    const restored = new HandleBook({ now: () => T0, source: source(async () => ({ data: [], error: null }), false), onTraders });
    expect(restored.restoreLearned([...saved, [ALPHA, { handle: "Fund", followers: null, profileUrl: null, source: "nansen" }]])).toBe(2);
    expect(onTraders).toHaveBeenCalledWith([WATCHED]);
    expect(restored.get(ALPHA)).toBeNull();
  });

  it("directory lists Nansen labels first", async () => {
    const book = new HandleBook({ now: () => T0, source: source(async () => ({ data: [trade(BETA, "Zeta Fund")], error: null })) });
    await book.refresh(true);
    book.learn(ALPHA, "aaa", null);
    expect(book.directory().map((row) => row.wallet)).toEqual([BETA, ALPHA]);
  });
});
