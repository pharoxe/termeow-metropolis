import type { Anchor } from "./geometry";
import { translateAnchor } from "./geometry";

/** Pure, immutable drawing state + versioned (de)serialisation. No DOM, no chart, no Date.now(). */

export type Tool = "hline" | "trendline" | "measure";
export const TOOLS: readonly Tool[] = ["hline", "trendline", "measure"];
export const SCHEMA_VERSION = 1;
export const STORAGE_PREFIX = "drawings:";

export type HLineDrawing = { kind: "hline"; id: string; price: number };
export type TrendlineDrawing = { kind: "trendline"; id: string; a: Anchor; b: Anchor };
export type MeasureDrawing = { kind: "measure"; id: string; a: Anchor; b: Anchor };
export type Drawing = HLineDrawing | TrendlineDrawing | MeasureDrawing;
export type AnchorPart = "a" | "b" | "body";

export type Draft = { kind: "trendline" | "measure"; a: Anchor; b: Anchor };

export type DrawingsState = {
  readonly drawings: readonly Drawing[];
  readonly selectedId: string | null;
  readonly draft: Draft | null;
};

export const EMPTY_STATE: DrawingsState = Object.freeze({ drawings: [], selectedId: null, draft: null });

export function makeId(now = Date.now(), rand = Math.random): string {
  return `d${now.toString(36)}${Math.floor(rand() * 1e6).toString(36)}`;
}

export function addDrawing(state: DrawingsState, drawing: Drawing): DrawingsState {
  return { ...state, drawings: [...state.drawings, drawing], selectedId: drawing.id };
}

export function selectDrawing(state: DrawingsState, id: string | null): DrawingsState {
  if (id !== null && !state.drawings.some((d) => d.id === id)) return state;
  return state.selectedId === id ? state : { ...state, selectedId: id };
}

export function removeDrawing(state: DrawingsState, id: string): DrawingsState {
  const drawings = state.drawings.filter((d) => d.id !== id);
  if (drawings.length === state.drawings.length) return state;
  return { ...state, drawings, selectedId: state.selectedId === id ? null : state.selectedId };
}

export function removeSelected(state: DrawingsState): DrawingsState {
  return state.selectedId === null ? state : removeDrawing(state, state.selectedId);
}

export function clearDrawings(state: DrawingsState): DrawingsState {
  return { ...state, drawings: [], selectedId: null };
}

/**
 * Move one anchor (`a`/`b`) to `target`, or translate the whole drawing (`body`) by `target - origin`.
 * Horizontal lines only track the target price. Unknown ids return the same state.
 */
export function moveAnchor(state: DrawingsState, id: string, part: AnchorPart, target: Anchor, origin?: Anchor): DrawingsState {
  const index = state.drawings.findIndex((d) => d.id === id);
  if (index < 0) return state;
  const current = state.drawings[index];
  let next: Drawing;
  if (current.kind === "hline") {
    const price = part === "body" && origin ? current.price + (target.price - origin.price) : target.price;
    next = { ...current, price };
  } else if (part === "body") {
    if (!origin) return state;
    const dTime = target.time - origin.time;
    const dPrice = target.price - origin.price;
    next = { ...current, a: translateAnchor(current.a, dTime, dPrice), b: translateAnchor(current.b, dTime, dPrice) };
  } else {
    next = { ...current, [part]: target };
  }
  const drawings = state.drawings.map((d, i) => (i === index ? next : d));
  return { ...state, drawings };
}

export function beginDraft(state: DrawingsState, kind: Draft["kind"], a: Anchor): DrawingsState {
  return { ...state, draft: { kind, a, b: a }, selectedId: null };
}

export function updateDraft(state: DrawingsState, b: Anchor): DrawingsState {
  return state.draft ? { ...state, draft: { ...state.draft, b } } : state;
}

export function cancelDraft(state: DrawingsState): DrawingsState {
  return state.draft ? { ...state, draft: null } : state;
}

/** Promote the draft to a drawing. A zero-size draft (a === b) is discarded instead. */
export function commitDraft(state: DrawingsState, id: string): DrawingsState {
  const draft = state.draft;
  if (!draft) return state;
  if (draft.a.time === draft.b.time && draft.a.price === draft.b.price) return cancelDraft(state);
  const drawing: Drawing = draft.kind === "trendline"
    ? { kind: "trendline", id, a: draft.a, b: draft.b }
    : { kind: "measure", id, a: draft.a, b: draft.b };
  return addDrawing({ ...state, draft: null }, drawing);
}

export function serialize(drawings: readonly Drawing[]): string {
  return JSON.stringify({ version: SCHEMA_VERSION, drawings });
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function isAnchor(v: unknown): v is Anchor {
  return isRecord(v) && isFiniteNumber(v.time) && isFiniteNumber(v.price);
}

export function isDrawing(v: unknown): v is Drawing {
  if (!isRecord(v) || typeof v.id !== "string" || v.id.length === 0) return false;
  if (v.kind === "hline") return isFiniteNumber(v.price);
  if (v.kind === "trendline") return isAnchor(v.a) && isAnchor(v.b);
  if (v.kind === "measure") return isAnchor(v.a) && isAnchor(v.b);
  return false;
}

/** Parse a serialized envelope; wrong version, malformed JSON or non-array payloads yield []. Invalid entries are dropped. */
export function deserialize(raw: string | null | undefined): Drawing[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.drawings)) return [];
  const seen = new Set<string>();
  const out: Drawing[] = [];
  for (const entry of parsed.drawings) {
    if (!isDrawing(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function storageKey(instrumentKey: string): string {
  return `${STORAGE_PREFIX}${instrumentKey}`;
}

export function loadDrawings(storage: StorageLike | null | undefined, instrumentKey: string): Drawing[] {
  if (!storage) return [];
  try {
    return deserialize(storage.getItem(storageKey(instrumentKey)));
  } catch {
    return [];
  }
}

/** Persist; an empty list removes the key. Returns false when storage is missing or throws (quota, private mode). */
export function saveDrawings(storage: StorageLike | null | undefined, instrumentKey: string, drawings: readonly Drawing[]): boolean {
  if (!storage) return false;
  try {
    if (drawings.length === 0) storage.removeItem(storageKey(instrumentKey));
    else storage.setItem(storageKey(instrumentKey), serialize(drawings));
    return true;
  } catch {
    return false;
  }
}
