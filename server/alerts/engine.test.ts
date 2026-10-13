import { describe, expect, it } from "vitest";
import type { SmartCoverage, LaunchRow } from "../../shared/wire.js";
import { TraderBook } from "../traders/book.js";
import type { TraderFill } from "../traders/walletStats.js";
import { AlertEngine, type AlertEngineDeps } from "./engine.js";
import { LAUNCH_FRESH_MS } from "./rules.js";
import fixture from "./__fixtures__/launches-and-fills.json";

/** The SmartFill-shaped rows the capture holds (resolveJsonModule infers a per-entry literal type; this is the honest common shape). */
type FixtureFill = {
  token: string;
  pair: string;
  tx: string;
  time: number;
  side: string;
  usd: number | null;
  trader: { address: string; kind: string; handle: string | null; followers: number | null };
  usdVia?: string;
};

const COVERAGE: SmartCoverage = { watched: 600, population: 1517, label: "watching 600 of 1,517 SMART wallets · 147 named" };
const CAPTURED_AT = Date.parse(fixture.meta.capturedAt.utc);

function toFill(fill: FixtureFill): TraderFill {
  return {
    chain: "monad",
    pair: fill.pair,
    tx: fill.tx,
    time: fill.time,
    side: fill.side as "buy" | "sell",
    usd: fill.usd,
    source: "own",
    trader: fill.trader.address,
    token: fill.token,
    kind: fill.trader.kind as TraderFill["kind"],
    handle: fill.trader.handle,
    followers: fill.trader.followers,
    ...(fill.usdVia ? { usdVia: fill.usdVia as "hub_leg" } : {})
  };
}

/** The live wiring: a real TraderBook answers the "per the book" questions, the fixture launch rows stand in for the index. */
function harness(launches: LaunchRow[] = fixture.tokens.map((entry) => entry.launch as LaunchRow), over: Partial<AlertEngineDeps> = {}) {
  const book = new TraderBook({ now: () => CAPTURED_AT });
  const index = new Map(launches.map((row) => [row.token.toLowerCase(), row]));
  let now = CAPTURED_AT;
  const engine = new AlertEngine({
    launchOf: (_chain, token) => index.get(token) ?? null,
    walletTokenFills: (chain, wallet, token) => book.fillsOf(chain, wallet).filter((fill) => fill.token === token).length,
    smartFillsOf: (chain, token) => book.tape(chain, 20_000, { kind: "smart", token }).length,
    oldestFillAt: () => book.oldestFillAt(),
    coverage: () => COVERAGE,
    symbolOf: (_chain, token) => index.get(token)?.symbol ?? null,
    now: () => now,
    log: () => undefined,
    ...over
  });
  /** Mirrors TraderService.recordTransferFills: book first, sink only on "accepted". */
  const record = (fill: TraderFill) => (book.record(fill) === "accepted" ? engine.handle({ kind: "fill", fill }) : []);
  return { engine, book, record, tick: (ms: number) => (now += ms) };
}

/** Fixture fills in chain-time order, as the poller delivers them. */
const allFills = ([...fixture.tokens.flatMap((entry) => entry.fills), ...fixture.highFollowerFills] as FixtureFill[]).map(toFill).sort((a, b) => a.time - b.time);

describe("first_smart_buy on the capture (3 unnamed Pons launches, unnamed SMART wallets)", () => {
  it("fires once per fresh token at the first SMART buy with chain-time age and coverage", () => {
    const h = harness();
    const fired = allFills.flatMap((fill) => h.record(fill)).filter((row) => row.rule === "first_smart_buy");
    expect(fired.map((row) => row.time)).toEqual([...fired.map((row) => row.time)].sort((a, b) => a - b));
    const byToken = new Map(fixture.tokens.map((entry) => [entry.token, entry]));
    expect(new Map(fired.map((row) => [row.token, row.rule === "first_smart_buy" ? row.evidence.launchAgeMs : null]))).toEqual(
      new Map(fixture.tokens.map((entry) => [entry.token, entry.firstSmartBuy.launchAgeMs]))
    );
    for (const row of fired) {
      const entry = byToken.get(row.token);
      if (!entry) throw new Error(`unexpected token ${row.token}`);
      const expected = entry.firstSmartBuy;
      expect(row.chain).toBe("monad");
      expect(row.symbol).toBeNull();
      expect(row.coverage).toEqual(COVERAGE);
      expect(row.time).toBe(expected.time);
      expect(row.observedAt).toBe(CAPTURED_AT);
      if (row.rule !== "first_smart_buy") throw new Error("rule");
      expect(row.evidence.fill).toMatchObject({ tx: expected.tx, wallet: expected.wallet, handle: null, kind: "smart", side: "buy", usd: expected.usd, usdVia: "hub_leg" });
      expect(row.evidence).toMatchObject({ launchpad: "pons", createdAtEstimated: true, launchTx: entry.launch.tx });
    }
    expect(h.engine.stats().fired.first_smart_buy).toBe(3);
  });

  it("a first SELL never fires; the first BUY afterwards does (token 0xe40b: sell at 125 s, buy at 408 s)", () => {
    const h = harness();
    const entry = fixture.tokens[1];
    const [sell, buy, later] = (entry.fills as FixtureFill[]).map(toFill);
    expect(sell.side).toBe("sell");
    expect(h.record(sell)).toEqual([]);
    const fired = h.record(buy);
    expect(fired).toHaveLength(1);
    if (fired[0].rule === "first_smart_buy") expect(fired[0].evidence.launchAgeMs).toBe(407_680);
    expect(h.record(later)).toEqual([]);
    expect(h.engine.stats().suppressed.first_smart_buy).toBe(1);
  });

  it("a stale first buy (launch 30 min old) is remembered so no later buy poses as first", () => {
    const entry = fixture.tokens[1];
    const stale = { ...(entry.launch as LaunchRow), createdAt: entry.fills[1].time - LAUNCH_FRESH_MS };
    const h = harness([stale]);
    const [, buy, later] = (entry.fills as FixtureFill[]).map(toFill);
    expect(h.record(buy)).toEqual([]);
    expect(h.record(later)).toEqual([]);
    expect(h.engine.stats().suppressed.first_smart_buy).toBe(2);
  });

  it("never fires for seeded or unclassified wallets, unknown tokens, or enrichment-only rows", () => {
    const entry = fixture.tokens[2];
    const buy = toFill(entry.fills[0]);
    expect(harness().record({ ...buy, kind: "seeded" })).toEqual([]);
    expect(harness().record({ ...buy, kind: null })).toEqual([]);
    expect(harness([]).record(buy)).toEqual([]);
    expect(harness([{ ...(entry.launch as LaunchRow), sources: ["dexscreener-profile"] }]).record(buy)).toEqual([]);
  });

  describe("a buy that reaches the book before its launch row (transfer feed and launch poller run independently)", () => {
    const entry = fixture.tokens[2];
    const launch = entry.launch as LaunchRow;
    const buy = toFill(entry.fills[0]);

    it("is parked, not latched: the launch event settles it and fires with the FIRST buy's evidence", () => {
      const h = harness([]);
      expect(h.record(buy)).toEqual([]);
      const later = { ...buy, tx: "0xlater", time: buy.time + 5_000, trader: "0x1111111111111111111111111111111111111111" };
      expect(h.record(later)).toEqual([]);
      const fired = h.engine.handle({ kind: "launch", row: launch });
      expect(fired).toHaveLength(1);
      expect(fired[0]).toMatchObject({ rule: "first_smart_buy", token: buy.token, time: buy.time });
      if (fired[0].rule === "first_smart_buy") expect(fired[0].evidence).toMatchObject({ launchAgeMs: 35_891, fill: { tx: buy.tx, wallet: buy.trader } });
      expect(h.engine.handle({ kind: "launch", row: launch })).toEqual([]);
      expect(h.record({ ...later, tx: "0xafter", time: later.time + 1_000 })).toEqual([]);
      expect(h.engine.stats()).toMatchObject({ seen: { launches: 2 }, fired: { first_smart_buy: 1 }, suppressed: { first_smart_buy: 3 } });
    });

    it("a parked buy is judged against the row when the next buy arrives after the row (no launch event seen)", () => {
      const index = new Map<string, LaunchRow>();
      const h = harness([], { launchOf: (_chain, token) => index.get(token) ?? null });
      expect(h.record(buy)).toEqual([]);
      index.set(launch.token.toLowerCase(), launch);
      const fired = h.record({ ...buy, tx: "0xlater", time: buy.time + 5_000, trader: "0x1111111111111111111111111111111111111111" });
      expect(fired).toHaveLength(1);
      if (fired[0].rule === "first_smart_buy") expect(fired[0].evidence.fill.tx).toBe(buy.tx);
    });

    it("an enrichment-only row parks the buy too; the chain-sourced row later fires it", () => {
      const h = harness([{ ...launch, sources: ["dexscreener-profile"], createdAt: buy.time - 1_000 }]);
      expect(h.record(buy)).toEqual([]);
      expect(h.engine.handle({ kind: "launch", row: launch })).toHaveLength(1);
    });

    it("a launch row that makes the parked buy stale latches the token silently", () => {
      const h = harness([]);
      expect(h.record(buy)).toEqual([]);
      expect(h.engine.handle({ kind: "launch", row: { ...launch, createdAt: buy.time - LAUNCH_FRESH_MS } })).toEqual([]);
      expect(h.record({ ...buy, tx: "0xlater", time: buy.time + 5_000 })).toEqual([]);
      expect(h.engine.stats().suppressed.first_smart_buy).toBe(3);
    });
  });

  it("the same fill replayed (book duplicate) reaches the engine zero times, and a direct replay is deduped by id", () => {
    const h = harness();
    const buy = toFill(fixture.tokens[2].fills[0]);
    expect(h.record(buy)).toHaveLength(1);
    expect(h.record(buy)).toEqual([]);
    expect(h.engine.handle({ kind: "fill", fill: buy })).toEqual([]);
    expect(h.engine.ring.size().size).toBe(1);
  });
});

describe("big_handle_entry on the capture (DopamineFeenFr1, 64,149 followers, 6 fills)", () => {
  it("fires on the wallet's first fill per token, whatever the side, and stays quiet on the other 4", () => {
    const h = harness();
    const fired = allFills.flatMap((fill) => h.record(fill)).filter((row) => row.rule === "big_handle_entry");
    expect(fired).toHaveLength(2);
    const [pare, hoodshop] = fired;
    if (pare.rule !== "big_handle_entry" || hoodshop.rule !== "big_handle_entry") throw new Error("rule");
    expect(pare.token).toBe("0x15d36b6a28d8327abc7afabf0f106ae2c9af5c4d");
    expect(pare.evidence).toMatchObject({ handle: "DopamineFeenFr1", followers: 64_149, side: "sell", usd: 987.308396, kind: "smart", tx: fixture.highFollowerFills[0].tx });
    // "first per the book" is bounded by the book's oldest fill: the PARE sell is the oldest fill in this run.
    expect(pare.evidence.bookSince).toBe(pare.time);
    expect(hoodshop.token).toBe("0x22ce16962f51ac19c34616efacffb1fee2efe6b1");
    expect(hoodshop.evidence).toMatchObject({ side: "buy", usd: 993.440382, bookSince: pare.time });
    expect(pare.symbol).toBeNull();
    expect(h.engine.stats()).toMatchObject({ fired: { big_handle_entry: 2 }, suppressed: { big_handle_entry: 4 } });
  });

  it("an earlier fill of the wallet in the token (per the book) blocks the alert; the follower floor and kind gate it", () => {
    const h = harness();
    const [first, second] = (fixture.highFollowerFills as FixtureFill[]).map(toFill);
    expect(h.book.record(first)).toBe("accepted");
    expect(h.record(second)).toEqual([]);
    expect(harness(undefined, { bigFollowers: 10_000 }).record({ ...first, followers: 9_999 })).toEqual([]);
    expect(harness().record({ ...first, kind: "other" })).toEqual([]);
    const unpriced = harness().record({ ...first, usd: null, usdVia: undefined, tx: "0xunpriced" });
    expect(unpriced).toHaveLength(1);
    if (unpriced[0].rule === "big_handle_entry") expect(unpriced[0].evidence.usd).toBeNull();
  });

  it("a seeded (check pending) big handle never fires: the ring row is immutable and the wallet may still prove other", () => {
    const seeded = toFill(fixture.earlierProcessHighFollowerFills[0]);
    expect(seeded).toMatchObject({ handle: "unipcs", followers: 514_576, kind: "seeded" });
    const h = harness();
    expect(h.record(seeded)).toEqual([]);
    expect(h.engine.stats().fired.big_handle_entry).toBe(0);
  });
});

describe("graduation", () => {
  const launch = fixture.tokens[2].launch as LaunchRow;
  const at = launch.createdAt + 20 * 60_000;

  it("fires once for a token with SMART fills in the book, counting them; the second Pons topic is deduped", () => {
    const h = harness();
    h.record(toFill(fixture.tokens[2].fills[0]));
    const first = h.engine.handle({ kind: "graduation", row: { ...launch, graduatedAt: at }, at });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ rule: "graduation", token: launch.token, time: at, observedAt: CAPTURED_AT, coverage: COVERAGE });
    if (first[0].rule === "graduation") expect(first[0].evidence).toEqual({ launchpad: "pons", pool: null, launchTx: launch.tx, graduationTx: null, smartFills: 1 });
    expect(h.engine.handle({ kind: "graduation", row: { ...launch, graduatedAt: at }, at })).toEqual([]);
    expect(h.engine.stats()).toMatchObject({ seen: { graduations: 2 }, fired: { graduation: 1 }, suppressed: { graduation: 1 } });
  });

  it("a graduation with no SMART fill in the book is not an alert", () => {
    const h = harness();
    expect(h.engine.handle({ kind: "graduation", row: launch, at })).toEqual([]);
    expect(h.engine.stats().fired.graduation).toBe(0);
  });
});

describe("engine hygiene", () => {
  it("launch events are counted, fire nothing, and unclassified fills (kind null, no handle) never fire", () => {
    const h = harness();
    expect(h.engine.handle({ kind: "launch", row: fixture.tokens[0].launch as LaunchRow })).toEqual([]);
    const unclassified: TraderFill = { chain: "monad", pair: "pool", tx: "0xsig", time: CAPTURED_AT, side: "buy", usd: 5, source: "own", trader: "0x1111111111111111111111111111111111111111", token: fixture.tokens[0].token, kind: null, handle: null, followers: null };
    expect(h.record(unclassified)).toEqual([]);
    expect(h.engine.stats().seen).toEqual({ fills: 1, launches: 1, graduations: 0 });
  });

  it("a throwing dependency is counted and logged, never thrown at the producer", () => {
    const logs: string[] = [];
    const h = harness(undefined, {
      launchOf: () => {
        throw new Error("index down");
      },
      log: (msg) => logs.push(msg)
    });
    expect(() => h.record(toFill(fixture.tokens[2].fills[0]))).not.toThrow();
    expect(h.engine.stats()).toMatchObject({ errors: 1, lastError: "index down" });
    expect(logs[0]).toContain("index down");
  });

  it("symbol comes from the resolver at firing and stays null when nobody knows it", () => {
    const named = { ...(fixture.tokens[2].launch as LaunchRow), symbol: "FRESH" };
    const fired = harness([named]).record(toFill(fixture.tokens[2].fills[0]));
    expect(fired[0].symbol).toBe("FRESH");
  });

  it("list honours since (observedAt, wall clock) so a poller sees only new alerts", () => {
    const h = harness();
    h.record(toFill(fixture.tokens[2].fills[0]));
    const mark = CAPTURED_AT;
    h.tick(10_000);
    h.record(toFill(fixture.tokens[0].fills[0]));
    expect(h.engine.list({ chain: "all" })).toHaveLength(2);
    expect(h.engine.list({ chain: "all", since: mark }).map((row) => row.token)).toEqual([fixture.tokens[0].token]);
    expect(h.engine.list({ chain: "monad" })).toHaveLength(2);
  });
});
