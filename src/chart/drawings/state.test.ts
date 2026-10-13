import { describe, expect, it } from "vitest";
import {
  EMPTY_STATE,
  SCHEMA_VERSION,
  addDrawing,
  beginDraft,
  cancelDraft,
  clearDrawings,
  commitDraft,
  deserialize,
  isDrawing,
  loadDrawings,
  makeId,
  moveAnchor,
  removeDrawing,
  removeSelected,
  saveDrawings,
  selectDrawing,
  serialize,
  storageKey,
  updateDraft,
  type Drawing,
  type StorageLike
} from "./state";

const MINUTE = 60_000;
const T0 = 1_788_717_000_000;
const HLINE: Drawing = { kind: "hline", id: "h1", price: 0.25 };
const TREND: Drawing = { kind: "trendline", id: "t1", a: { time: T0, price: 0.2 }, b: { time: T0 + 5 * MINUTE, price: 0.3 } };
const BOX: Drawing = { kind: "measure", id: "m1", a: { time: T0, price: 0.2 }, b: { time: T0 + 2 * MINUTE, price: 0.1 } };

function fakeStorage(seed: Record<string, string> = {}, opts: { throwOnSet?: boolean } = {}): StorageLike & { store: Map<string, string> } {
  const store = new Map(Object.entries(seed));
  return {
    store,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => { if (opts.throwOnSet) throw new Error("quota"); store.set(k, v); },
    removeItem: (k) => { store.delete(k); }
  };
}

describe("add / select / remove", () => {
  it("adds immutably and selects the new drawing", () => {
    const next = addDrawing(EMPTY_STATE, HLINE);
    expect(next.drawings).toEqual([HLINE]);
    expect(next.selectedId).toBe("h1");
    expect(EMPTY_STATE.drawings).toEqual([]);
  });
  it("ignores selection of unknown ids and returns the same state when unchanged", () => {
    const s = addDrawing(EMPTY_STATE, HLINE);
    expect(selectDrawing(s, "nope")).toBe(s);
    expect(selectDrawing(s, "h1")).toBe(s);
    expect(selectDrawing(s, null).selectedId).toBeNull();
  });
  it("removes by id, clearing the selection only when it was the removed one", () => {
    const s = addDrawing(addDrawing(EMPTY_STATE, HLINE), TREND);
    expect(removeDrawing(s, "h1")).toMatchObject({ drawings: [TREND], selectedId: "t1" });
    expect(removeDrawing(s, "t1")).toMatchObject({ drawings: [HLINE], selectedId: null });
    expect(removeDrawing(s, "zzz")).toBe(s);
  });
  it("removeSelected and clearDrawings", () => {
    const s = addDrawing(addDrawing(EMPTY_STATE, HLINE), TREND);
    expect(removeSelected(s).drawings).toEqual([HLINE]);
    expect(removeSelected(EMPTY_STATE)).toBe(EMPTY_STATE);
    expect(clearDrawings(s)).toMatchObject({ drawings: [], selectedId: null });
  });
});

describe("moveAnchor", () => {
  it("moves a single anchor of a trendline without touching the other", () => {
    const s = addDrawing(EMPTY_STATE, TREND);
    const moved = moveAnchor(s, "t1", "b", { time: T0 + 9 * MINUTE, price: 0.4 });
    expect(moved.drawings[0]).toEqual({ ...TREND, b: { time: T0 + 9 * MINUTE, price: 0.4 } });
    expect(s.drawings[0]).toBe(TREND);
  });
  it("translates the body by target - origin and is a no-op without an origin", () => {
    const s = addDrawing(EMPTY_STATE, BOX);
    const moved = moveAnchor(s, "m1", "body", { time: T0 + MINUTE, price: 0.25 }, { time: T0, price: 0.2 });
    expect(moved.drawings[0]).toEqual({ ...BOX, a: { time: T0 + MINUTE, price: 0.25 }, b: { time: T0 + 3 * MINUTE, price: 0.15 } });
    expect(moveAnchor(s, "m1", "body", { time: T0, price: 1 })).toBe(s);
  });
  it("tracks price only for horizontal lines and ignores unknown ids", () => {
    const s = addDrawing(EMPTY_STATE, HLINE);
    expect(moveAnchor(s, "h1", "a", { time: 1, price: 0.5 }).drawings[0]).toEqual({ ...HLINE, price: 0.5 });
    expect(moveAnchor(s, "h1", "body", { time: 1, price: 0.3 }, { time: 0, price: 0.25 }).drawings[0]).toEqual({ ...HLINE, price: 0.3 });
    expect(moveAnchor(s, "ghost", "a", { time: 1, price: 0.5 })).toBe(s);
  });
});

describe("draft lifecycle", () => {
  it("begins with b === a, deselects, updates b, and commits as the right kind", () => {
    const a = { time: T0, price: 0.2 };
    const started = beginDraft(addDrawing(EMPTY_STATE, HLINE), "measure", a);
    expect(started.draft).toEqual({ kind: "measure", a, b: a });
    expect(started.selectedId).toBeNull();
    const b = { time: T0 + MINUTE, price: 0.3 };
    const committed = commitDraft(updateDraft(started, b), "new");
    expect(committed.draft).toBeNull();
    expect(committed.drawings[1]).toEqual({ kind: "measure", id: "new", a, b });
    expect(committed.selectedId).toBe("new");
    const trend = commitDraft(updateDraft(beginDraft(EMPTY_STATE, "trendline", a), b), "tl");
    expect(trend.drawings[0]).toEqual({ kind: "trendline", id: "tl", a, b });
  });
  it("discards a zero-size draft and tolerates missing drafts", () => {
    const a = { time: T0, price: 0.2 };
    const s = beginDraft(EMPTY_STATE, "trendline", a);
    expect(commitDraft(s, "x")).toMatchObject({ draft: null, drawings: [] });
    expect(cancelDraft(s).draft).toBeNull();
    expect(cancelDraft(EMPTY_STATE)).toBe(EMPTY_STATE);
    expect(updateDraft(EMPTY_STATE, a)).toBe(EMPTY_STATE);
    expect(commitDraft(EMPTY_STATE, "x")).toBe(EMPTY_STATE);
  });
});

describe("serialize / deserialize", () => {
  it("round-trips every kind under a versioned envelope", () => {
    const raw = serialize([HLINE, TREND, BOX]);
    expect(JSON.parse(raw).version).toBe(SCHEMA_VERSION);
    expect(deserialize(raw)).toEqual([HLINE, TREND, BOX]);
  });
  it("rejects malformed JSON, wrong versions and non-array payloads", () => {
    expect(deserialize("{nope")).toEqual([]);
    expect(deserialize(null)).toEqual([]);
    expect(deserialize(JSON.stringify({ version: 99, drawings: [HLINE] }))).toEqual([]);
    expect(deserialize(JSON.stringify({ version: SCHEMA_VERSION, drawings: {} }))).toEqual([]);
    expect(deserialize(JSON.stringify([HLINE]))).toEqual([]);
  });
  it("drops invalid or duplicate entries but keeps the valid ones", () => {
    const junk = [
      HLINE,
      { kind: "hline", id: "", price: 1 },
      { kind: "hline", id: "nan", price: Number.NaN },
      { kind: "trendline", id: "t2", a: { time: 1, price: 1 }, b: { time: "2", price: 2 } },
      { kind: "circle", id: "c1" },
      { ...HLINE },
      BOX,
      null
    ];
    expect(deserialize(JSON.stringify({ version: SCHEMA_VERSION, drawings: junk }))).toEqual([HLINE, BOX]);
  });
  it("isDrawing accepts the three kinds only", () => {
    expect(isDrawing(HLINE)).toBe(true);
    expect(isDrawing(TREND)).toBe(true);
    expect(isDrawing(BOX)).toBe(true);
    expect(isDrawing({ kind: "hline", id: "x", price: "1" })).toBe(false);
    expect(isDrawing("hline")).toBe(false);
  });
});

describe("storage helpers", () => {
  it("namespaces by instrument key", () => {
    expect(storageKey("monad:0x12d5")).toBe("drawings:monad:0x12d5");
  });
  it("saves, loads, and removes the key when empty", () => {
    const storage = fakeStorage();
    expect(saveDrawings(storage, "k", [HLINE])).toBe(true);
    expect(loadDrawings(storage, "k")).toEqual([HLINE]);
    expect(loadDrawings(storage, "other")).toEqual([]);
    expect(saveDrawings(storage, "k", [])).toBe(true);
    expect(storage.store.has("drawings:k")).toBe(false);
  });
  it("survives a missing or throwing storage", () => {
    expect(loadDrawings(null, "k")).toEqual([]);
    expect(saveDrawings(undefined, "k", [HLINE])).toBe(false);
    const broken = fakeStorage({}, { throwOnSet: true });
    expect(saveDrawings(broken, "k", [HLINE])).toBe(false);
    const poison: StorageLike = { getItem: () => { throw new Error("denied"); }, setItem: () => undefined, removeItem: () => undefined };
    expect(loadDrawings(poison, "k")).toEqual([]);
  });
  it("makeId is deterministic given its inputs and unique across random draws", () => {
    expect(makeId(1000, () => 0.5)).toBe(makeId(1000, () => 0.5));
    expect(makeId(1000, () => 0.1)).not.toBe(makeId(1000, () => 0.9));
    expect(makeId()).toMatch(/^d[0-9a-z]+$/);
  });
});
