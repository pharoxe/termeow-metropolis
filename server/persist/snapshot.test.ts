import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FlowPrint, LaunchRow } from "../../shared/wire.js";
import { FlowLedger, MINUTE_MS } from "../flow/ledger.js";
import { LaunchIndex } from "../launch/index.js";
import { TraderBook } from "../traders/book.js";
import { Erc20Meta, type Erc20MetaEntry } from "../traders/erc20Meta.js";
import { HandleBook } from "../traders/handles.js";
import { TraderService } from "../traders/service.js";
import type { TraderFill } from "../traders/walletStats.js";
import { erc20MetaComponent, launchIndexComponent, ledgerComponent, traderBookComponent, traderServiceComponent } from "./components.js";
import { SnapshotManager, formatIst } from "./snapshot.js";
import { snapshotFile } from "./store.js";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
function fixture<T>(name: string, key: string): T {
  return (JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as Record<string, T>)[key];
}
const ROWS = fixture<LaunchRow[]>("launch-rows.json", "rows");
const PRINTS = fixture<FlowPrint[]>("prints.json", "prints");
const FILLS = fixture<TraderFill[]>("fills.json", "fills");
const ERC20 = fixture<[string, Erc20MetaEntry][]>("erc20.json", "entries");

const T0 = 1_788_788_395_478; // the capture's observedAt, 2026-09-07 19:09:55 IST
const FP = "fp-test";
let dir: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "termeow-snap-"));
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function manager(now = T0, over: Partial<ConstructorParameters<typeof SnapshotManager>[0]> = {}) {
  return new SnapshotManager({ dir, intervalMs: 30_000, fingerprint: FP, now: () => now, log: (message) => logs.push(message), ...over });
}

const rpc = { call: () => Promise.reject(new Error("no network in tests")) };
const noClassifier = { classify: () => Promise.resolve(null), peek: () => undefined, stats: () => ({ pending: 0 }) };
const noReceipts = { get: () => Promise.resolve(null), stats: () => ({}) };
function service(now = () => T0) {
  const handles = new HandleBook({ now, source: { configured: false, dexTrades: () => Promise.reject(new Error("no network in tests")) } });
  return new TraderService({ classifier: noClassifier, receipts: noReceipts, handles, erc20Meta: new Erc20Meta({ rpc, now }), now, log: (message) => logs.push(message) });
}

describe("launch-index component", () => {
  it("round-trips real launch rows with observedAt untouched and reports age at restore", () => {
    const source = new LaunchIndex({ now: () => T0 });
    source.restore({ rows: ROWS, stocks: [] });
    expect(source.stats().rows).toBe(ROWS.length);
    manager().register(launchIndexComponent(() => source)).saveAll("test");

    const target = new LaunchIndex({ now: () => T0 + 90_000 });
    const restored = manager(T0 + 90_000).register(launchIndexComponent(() => target));
    const report = restored.restore("launch-index");
    expect(report).toMatchObject({ skipped: null, savedAt: T0, ageMs: 90_000, counts: { rows: ROWS.length } });
    expect(target.list({ chain: "monad", windowMs: 24 * 3_600_000 })).toEqual(source.list({ chain: "monad", windowMs: 24 * 3_600_000 }));
    expect(target.get("monad", ROWS[0].token)?.observedAt).toBe(ROWS[0].observedAt);
    expect(restored.status()).toMatchObject({ restoredAt: T0 + 90_000, snapshotAge: 90_000 });
    expect(logs.some((line) => line.includes("restored launch-index") && line.includes("aged 90s"))).toBe(true);
  });

  it("never overwrites a row already live in this process and does not restore twice", () => {
    const source = new LaunchIndex({ now: () => T0 });
    source.restore({ rows: ROWS, stocks: [] });
    manager().register(launchIndexComponent(() => source)).saveAll("test");
    const target = new LaunchIndex({ now: () => T0 + 1 });
    const live = target.upsert({ chain: ROWS[0].chain, token: ROWS[0].token, symbol: "LIVE" });
    const restored = manager(T0 + 1).register(launchIndexComponent(() => target));
    expect(restored.restore("launch-index").counts).toEqual({ rows: ROWS.length - 1 });
    expect(target.get(ROWS[0].chain, ROWS[0].token)).toEqual(live);
    expect(restored.restore("launch-index").counts).toEqual({ rows: ROWS.length - 1 });
    expect(target.stats().rows).toBe(ROWS.length);
  });

  it("caps rows at the component cap keeping the newest and logs the truncation", () => {
    const source = new LaunchIndex({ now: () => T0 });
    source.restore({ rows: ROWS, stocks: [] });
    manager().register(launchIndexComponent(() => source, 5)).saveAll("test");
    const file = JSON.parse(readFileSync(snapshotFile(dir, "launch-index", 1), "utf8")) as { truncated: number; data: { rows: LaunchRow[] } };
    expect(file.truncated).toBe(ROWS.length - 5);
    expect(file.data.rows).toHaveLength(5);
    const newest = [...ROWS].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map((row) => row.token).sort();
    expect(file.data.rows.map((row) => row.token).sort()).toEqual(newest);
    expect(logs).toContain(`snapshot: launch-index truncated by ${ROWS.length - 5} before writing`);
  });

  it("skips the save while the owner does not exist yet instead of writing an empty file", () => {
    const reports = manager().register(launchIndexComponent(() => null)).saveAll("test");
    expect(reports[0]).toMatchObject({ skipped: "no-owner" });
    expect(() => readFileSync(snapshotFile(dir, "launch-index", 1))).toThrow();
  });
});

describe("flow ledger component", () => {
  it("restores rings, rebuilds buckets from them, dedupes a re-poll and reports coverage only from the oldest ring print", () => {
    const source = new FlowLedger({ now: () => T0 });
    expect(source.ingest(PRINTS).accepted).toBe(PRINTS.length);
    manager().register(ledgerComponent("flow-ledger", () => source, 64)).saveAll("test");

    const target = new FlowLedger({ now: () => T0 });
    const report = manager().register(ledgerComponent("flow-ledger", () => target, 64)).restore("flow-ledger");
    const pairs = [...new Set(PRINTS.map((print) => print.pair))];
    expect(report.counts).toEqual({ pairs: pairs.length, prints: PRINTS.length });
    const from = T0 - 2 * 3_600_000;
    for (const pair of pairs) {
      expect(target.recentPrints("monad", pair)).toEqual(source.recentPrints("monad", pair));
      // same prints folded in a different order: counts match exactly, usd sums to floating-point rounding
      const expected = source.series("monad", pair, MINUTE_MS, from, T0);
      const actual = target.series("monad", pair, MINUTE_MS, from, T0);
      expect(actual.map(({ buyUsd: _b, sellUsd: _s, ...rest }) => rest)).toEqual(expected.map(({ buyUsd: _b, sellUsd: _s, ...rest }) => rest));
      actual.forEach((bucket, i) => {
        expect(bucket.buyUsd).toBeCloseTo(expected[i].buyUsd, 6);
        expect(bucket.sellUsd).toBeCloseTo(expected[i].sellUsd, 6);
      });
      expect(target.firstPrintAt("monad", pair)).toBe(Math.min(...PRINTS.filter((print) => print.pair === pair).map((print) => print.time)));
    }
    expect(target.ingest(PRINTS)).toEqual({ accepted: 0, duplicates: PRINTS.length });
  });

  it("claims no coverage before the ring when the saved firstPrintAt predates it", () => {
    const early = T0 - 5 * 3_600_000;
    const target = new FlowLedger({ now: () => T0 });
    const ring = PRINTS.slice(0, 5);
    target.restore({ pairs: [{ key: `monad:${ring[0].pair}`, recent: ring, firstPrintAt: early }] });
    expect(target.firstPrintAt("monad", ring[0].pair)).toBe(Math.min(...ring.map((print) => print.time)));
    expect(target.coverage("monad", ring[0].pair, early, T0).fraction).toBeLessThan(1);
  });

  it("rejects a ring file whose prints are malformed", () => {
    writeFileSync(snapshotFile(dir, "flow-ledger", 1), JSON.stringify({ component: "flow-ledger", version: 1, savedAt: T0, fingerprint: FP, truncated: 0, data: { pairs: [{ key: "x", recent: [{ tx: 1 }], firstPrintAt: null }] } }));
    const target = new FlowLedger({ now: () => T0 });
    expect(manager().register(ledgerComponent("flow-ledger", () => target, 64)).restore("flow-ledger")).toMatchObject({ skipped: "invalid" });
    expect(target.pairs()).toEqual([]);
  });
});

describe("trader book component", () => {
  it("round-trips real fills and the wallets' post-classification identity", () => {
    const source = new TraderBook({ now: () => T0 });
    expect(source.recordAll(FILLS).accepted).toBe(FILLS.length);
    source.classify("monad", FILLS[0].trader, "other");
    manager().register(traderBookComponent(() => source)).saveAll("test");

    const target = new TraderBook({ now: () => T0 });
    const report = manager().register(traderBookComponent(() => target)).restore("trader-book");
    expect(report.counts).toEqual({ fills: FILLS.length, duplicates: 0, rejected: 0 });
    expect(target.tape("monad", 100)).toEqual(source.tape("monad", 100));
    expect(target.stats("monad", FILLS[0].trader)).toEqual(source.stats("monad", FILLS[0].trader));
    expect(target.stats("monad", FILLS[0].trader)?.kind).toBe("other");
    expect(target.recordAll(FILLS).duplicates).toBe(FILLS.length);
  });

  it("keeps only the newest fills at the cap", () => {
    const source = new TraderBook({ now: () => T0 });
    source.recordAll(FILLS);
    manager().register(traderBookComponent(() => source, 3)).saveAll("test");
    const target = new TraderBook({ now: () => T0 });
    manager().register(traderBookComponent(() => target, 3)).restore("trader-book");
    expect(target.size().fills).toBe(3);
    expect(target.tape("monad", 3).map((row) => row.tx)).toEqual(source.tape("monad", 3).map((row) => row.tx));
  });
});

describe("trader population + erc20 components", () => {
  it("round-trips population, seeded wallets (re-queued for their check) and learned handles, bumping the version once", () => {
    const source = service();
    const wallets = [...new Set(FILLS.map((fill) => fill.trader))];
    source.seed(wallets.slice(0, 3), "robinhoodtrenches");
    (source.handles as HandleBook).learn(wallets[4], FILLS.find((fill) => fill.trader === wallets[4])?.handle ?? "x", 7);
    // verified population has no public setter: a wallet the classifier proved is admitted through restore() itself
    source.restore({ population: wallets.slice(3, 5), seeded: [], handlesLearned: [] });
    expect(source.transferWallets().length).toBe(5);
    manager().register(traderServiceComponent(() => source)).saveAll("test");

    const target = service();
    const before = target.populationVersion();
    const report = manager().register(traderServiceComponent(() => target)).restore("trader-population");
    expect(report.counts).toEqual({ population: 2, seeded: 3, seedQueue: 3, handlesLearned: 1 });
    expect(target.populationVersion()).toBe(before + 1);
    expect(target.status().population).toMatchObject({ classified: 2, seeded: 3, seedQueue: 3 });
    expect(target.peekKind(wallets[0])).toBe("seeded");
    expect(target.peekKind(wallets[3])).toBe("smart");
    expect(target.handles.get(wallets[4])?.source).toBe("learned");
    expect(target.snapshot()).toEqual(source.snapshot());
  });

  it("restores measured erc20 facts without RPC and never overrides a fresh entry", async () => {
    const source = new Erc20Meta({ rpc, now: () => T0 });
    expect(source.restore(ERC20)).toBe(1);
    manager().register(erc20MetaComponent(() => source)).saveAll("test");
    const target = new Erc20Meta({ rpc, now: () => T0 + 10 * 24 * 3_600_000 });
    const report = manager(T0 + 10 * 24 * 3_600_000).register(erc20MetaComponent(() => target)).restore("erc20-meta");
    expect(report.counts).toEqual({ entries: 1 });
    expect(target.get(ERC20[0][0])).toEqual({ decimals: 18, symbol: "Parlay", resolvedAt: ERC20[0][1].resolvedAt });
    expect(await target.resolve(ERC20[0][0])).toEqual(target.get(ERC20[0][0]));
    expect(target.restore(ERC20)).toBe(0);
  });
});

describe("SnapshotManager", () => {
  it("skips corrupt, mismatched and unknown files without touching the owner and lists every outcome on status()", () => {
    writeFileSync(snapshotFile(dir, "launch-index", 1), "garbage");
    writeFileSync(snapshotFile(dir, "erc20-meta", 1), JSON.stringify({ component: "erc20-meta", version: 1, savedAt: T0, fingerprint: "elsewhere", truncated: 0, data: [] }));
    const index = new LaunchIndex({ now: () => T0 });
    const meta = new Erc20Meta({ rpc, now: () => T0 });
    const live = manager().register(launchIndexComponent(() => index)).register(erc20MetaComponent(() => meta));
    expect(live.restore("launch-index")).toMatchObject({ skipped: "corrupt" });
    expect(live.restore("erc20-meta")).toMatchObject({ skipped: "fingerprint" });
    expect(live.restore("nope")).toMatchObject({ skipped: "error" });
    expect(index.stats().rows).toBe(0);
    expect(meta.stats().cached).toBe(0);
    const status = live.status();
    expect(status.restoredAt).toBeNull();
    expect(status.snapshotAge).toBeNull();
    expect(status.snapshot.components.map((report) => report.skipped)).toEqual(["corrupt", "fingerprint", "error"]);
    expect(logs.filter((line) => line.startsWith("snapshot: skipped"))).toHaveLength(3);
  });

  it("records the last save per component and formats the IST label", () => {
    const index = new LaunchIndex({ now: () => T0 });
    index.restore({ rows: ROWS, stocks: [] });
    const live = manager().register(launchIndexComponent(() => index)).register(erc20MetaComponent(() => null));
    live.saveAll("shutdown");
    const status = live.status();
    expect(status.snapshot.lastSaveAt).toBe(T0);
    expect(status.snapshot.lastSave.map((report) => [report.component, report.skipped])).toEqual([["launch-index", null], ["erc20-meta", "no-owner"]]);
    expect(status.snapshot.lastSave[0].bytes).toBeGreaterThan(1000);
    expect(logs.at(-1)).toMatch(/^snapshot: shutdown wrote 1\/2 components, \d+ bytes$/);
    expect(formatIst(T0)).toBe("07/09/2026, 19:09:55 IST");
  });
});
