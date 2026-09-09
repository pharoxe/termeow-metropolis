import type { IChartApi, ISeriesApi, Logical, SeriesType, Time, UTCTimestamp } from "lightweight-charts";
import { DRAG_THRESHOLD_PX, distance, logicalForTime, timeForLogical, type Anchor, type Point } from "./geometry";
import { DARK_DRAWING_THEME, DrawingsPrimitive, LIGHT_DRAWING_THEME, type DrawingTheme, type Formatters, type Mapper } from "./primitives";
import {
  EMPTY_STATE,
  addDrawing,
  beginDraft,
  cancelDraft,
  clearDrawings,
  commitDraft,
  loadDrawings,
  makeId,
  moveAnchor,
  removeSelected,
  saveDrawings,
  selectDrawing,
  updateDraft,
  type AnchorPart,
  type DrawingsState,
  type StorageLike,
  type Tool
} from "./state";

export type { Anchor } from "./geometry";
export type { Drawing, DrawingsState, Tool } from "./state";
export type { DrawingTheme, Formatters } from "./primitives";
export { DARK_DRAWING_THEME, LIGHT_DRAWING_THEME } from "./primitives";
export { DrawingToolbar, type DrawingToolbarProps } from "./DrawingToolbar";

export type DrawingsSnapshot = { tool: Tool | null; count: number; selectedId: string | null; drafting: boolean };
export type DrawingsListener = (snapshot: DrawingsSnapshot) => void;

export type AttachDrawingsOptions = {
  chart: IChartApi;
  /** The price series drawings are anchored to; it must live in the chart's first pane. */
  series: ISeriesApi<SeriesType>;
  /** Persistence namespace, e.g. `${chain}:${address}`; stored under localStorage key `drawings:<instrumentKey>`. */
  instrumentKey: string;
  /** price → axis label text (e.g. formatMicroPrice); time(ms) → IST label text. */
  formatters: Formatters;
  theme?: "dark" | "light" | Partial<DrawingTheme>;
  /** Defaults to window.localStorage; pass null to disable persistence. */
  storage?: StorageLike | null;
};

export type DrawingsApi = {
  setTool: (tool: Tool | null) => void;
  clear: () => void;
  destroy: () => void;
  /** Calls the listener immediately with the current snapshot; returns an unsubscribe function. */
  subscribe: (listener: DrawingsListener) => () => void;
};

type Drag = { id: string; part: AnchorPart; origin: Anchor; start: Point; moved: boolean };
type SeriesRef = { lastIndex: number; lastTimeMs: number; barMs: number };
const DRAFT = "__draft__";

function resolveTheme(theme: AttachDrawingsOptions["theme"]): DrawingTheme {
  if (theme === "light") return LIGHT_DRAWING_THEME;
  if (theme === undefined || theme === "dark") return DARK_DRAWING_THEME;
  return { ...DARK_DRAWING_THEME, ...theme };
}

function safeLocalStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function timeToMs(time: Time): number | null {
  return typeof time === "number" && Number.isFinite(time) ? time * 1000 : null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

export function attachDrawings(opts: AttachDrawingsOptions): DrawingsApi {
  const { chart, series, instrumentKey, formatters } = opts;
  const storage = opts.storage === undefined ? safeLocalStorage() : opts.storage;
  const el = chart.chartElement();
  const listeners = new Set<DrawingsListener>();
  let state: DrawingsState = { ...EMPTY_STATE, drawings: loadDrawings(storage, instrumentKey) };
  let tool: Tool | null = null;
  let drag: Drag | null = null;
  let destroyed = false;

  /** Last two bars of the series: lets us map times/logicals in the whitespace right of the data. */
  const seriesRef = (): SeriesRef | null => {
    const data = series.data();
    if (data.length < 2) return null;
    const lastTimeMs = timeToMs(data[data.length - 1].time);
    const prevTimeMs = timeToMs(data[data.length - 2].time);
    if (lastTimeMs === null || prevTimeMs === null || lastTimeMs <= prevTimeMs) return null;
    const lastIndex = chart.timeScale().timeToIndex(data[data.length - 1].time, true);
    return lastIndex === null ? null : { lastIndex, lastTimeMs, barMs: lastTimeMs - prevTimeMs };
  };

  const timeToX = (timeMs: number): number | null => {
    const ts = chart.timeScale();
    const sec = Math.floor(timeMs / 1000) as UTCTimestamp;
    const direct = ts.timeToCoordinate(sec);
    if (direct !== null) return direct;
    const ref = seriesRef();
    if (!ref) return null;
    if (timeMs <= ref.lastTimeMs) {
      const index = ts.timeToIndex(sec, true);
      return index === null ? null : ts.logicalToCoordinate(index as unknown as Logical);
    }
    return ts.logicalToCoordinate(logicalForTime(timeMs, ref.lastIndex, ref.lastTimeMs, ref.barMs) as Logical);
  };

  const xToTime = (x: number): number | null => {
    const ts = chart.timeScale();
    const direct = ts.coordinateToTime(x);
    if (direct !== null) return timeToMs(direct);
    const logical = ts.coordinateToLogical(x);
    const ref = seriesRef();
    return logical === null || !ref ? null : timeForLogical(Math.round(logical), ref.lastIndex, ref.lastTimeMs, ref.barMs);
  };

  const paneIndex = () => series.getPane().paneIndex();
  const paneTop = () => {
    let top = 0;
    for (let i = 0; i < paneIndex(); i += 1) top += chart.paneSize(i).height;
    return top;
  };
  const mapper: Mapper = {
    xOf: timeToX,
    yOf: (price) => series.priceToCoordinate(price),
    barMs: () => seriesRef()?.barMs ?? null,
    width: () => chart.timeScale().width(),
    height: () => chart.paneSize(paneIndex()).height
  };
  const primitive = new DrawingsPrimitive(mapper, formatters, resolveTheme(opts.theme));
  series.attachPrimitive(primitive);
  primitive.setState(state);

  const snapshot = (): DrawingsSnapshot => ({ tool, count: state.drawings.length, selectedId: state.selectedId, drafting: state.draft !== null });
  const notify = () => { const snap = snapshot(); listeners.forEach((l) => l(snap)); };
  const setState = (next: DrawingsState) => { if (next === state) return; state = next; primitive.setState(state); notify(); };
  const persist = () => { saveDrawings(storage, instrumentKey, state.drawings); };
  const commit = (next: DrawingsState) => { setState(next); persist(); };

  const setTool = (next: Tool | null) => {
    if (destroyed) return;
    tool = next;
    drag = null;
    el.style.cursor = next ? "crosshair" : "";
    setState(cancelDraft(state));
    notify();
  };

  const localPoint = (clientX: number, clientY: number): Point => {
    const rect = el.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top - paneTop() };
  };
  const inPane = (p: Point) => p.x >= 0 && p.x <= mapper.width() && p.y >= 0 && p.y <= mapper.height();
  const anchorAt = (p: Point): Anchor | null => {
    const price = series.coordinateToPrice(p.y);
    const time = xToTime(p.x);
    return price === null || time === null ? null : { time, price };
  };
  const finishDraft = (b: Anchor) => {
    commit(commitDraft(updateDraft(state, b), makeId()));
    setTool(null);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const p = localPoint(e.clientX, e.clientY);
    if (!inPane(p)) return;
    const anchor = anchorAt(p);
    if (tool) {
      if (!anchor) return;
      e.preventDefault();
      if (tool === "hline") { commit(addDrawing(state, { kind: "hline", id: makeId(), price: anchor.price })); setTool(null); return; }
      if (state.draft) { finishDraft(anchor); return; }
      setState(beginDraft(state, tool, anchor));
      drag = { id: DRAFT, part: "b", origin: anchor, start: p, moved: false };
      return;
    }
    const hit = primitive.hitAt(p);
    if (!hit) { setState(selectDrawing(state, null)); return; }
    e.preventDefault();
    setState(selectDrawing(state, hit.id));
    if (anchor) drag = { id: hit.id, part: hit.part, origin: anchor, start: p, moved: false };
  };

  const onPointerMove = (e: PointerEvent) => {
    const p = localPoint(e.clientX, e.clientY);
    const anchor = anchorAt(p);
    if (!anchor) return;
    if (!drag) { if (state.draft) setState(updateDraft(state, anchor)); return; }
    if (!drag.moved && distance(p, drag.start) < DRAG_THRESHOLD_PX) return;
    const origin = drag.origin;
    drag = { ...drag, moved: true, origin: anchor };
    if (drag.id === DRAFT) { setState(updateDraft(state, anchor)); return; }
    setState(moveAnchor(state, drag.id, drag.part, anchor, origin));
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!drag) return;
    const done = drag;
    drag = null;
    if (done.id === DRAFT) {
      if (!done.moved) return; // click-click mode: the next pointerdown places the second anchor
      const anchor = anchorAt(localPoint(e.clientX, e.clientY)) ?? state.draft?.b;
      if (anchor) finishDraft(anchor);
      return;
    }
    if (done.moved) persist();
  };

  /** Stop the chart's own pan from starting when the gesture belongs to a tool or an existing drawing. */
  const blockChartGesture = (e: MouseEvent | TouchEvent) => {
    const touch = "touches" in e ? e.touches[0] : e;
    if (!touch) return;
    const p = localPoint(touch.clientX, touch.clientY);
    if (!inPane(p)) return;
    if (tool || primitive.hitAt(p)) e.stopPropagation();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const tile=el.closest('.workspace-chart');
    if(tile && !tile.classList.contains('active'))return;
    if (isEditableTarget(e.target)) return;
    if (e.key === "Escape") {
      if (state.draft || tool) { setTool(null); e.preventDefault(); return; }
      if (state.selectedId) { setState(selectDrawing(state, null)); e.preventDefault(); }
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId) { commit(removeSelected(state)); e.preventDefault(); }
  };

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  el.addEventListener("mousedown", blockChartGesture, true);
  el.addEventListener("touchstart", blockChartGesture, true);
  window.addEventListener("keydown", onKeyDown);

  return {
    setTool,
    clear: () => { if (!destroyed) { setTool(null); commit(clearDrawings(state)); } },
    subscribe: (listener) => { listeners.add(listener); listener(snapshot()); return () => { listeners.delete(listener); }; },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("mousedown", blockChartGesture, true);
      el.removeEventListener("touchstart", blockChartGesture, true);
      window.removeEventListener("keydown", onKeyDown);
      el.style.cursor = "";
      listeners.clear();
      try { series.detachPrimitive(primitive); } catch { /* chart already removed */ }
    }
  };
}
