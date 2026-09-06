/** Pure pixel/anchor math for chart drawings. No DOM, no lightweight-charts, no Date.now(). */

export type Point = { x: number; y: number };
/** A chart-space anchor: epoch milliseconds + price in the series' unit. */
export type Anchor = { time: number; price: number };
export type Segment = { x1: number; y1: number; x2: number; y2: number };
export type Rect = { left: number; top: number; right: number; bottom: number };

export const HIT_TOLERANCE_PX = 6;
export const HANDLE_RADIUS_PX = 4;
export const DRAG_THRESHOLD_PX = 3;

/** Snap a coordinate to the pixel centre so 1px strokes are crisp. */
export function crisp(value: number): number {
  return Math.round(value) + 0.5;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distanceToSegment(p: Point, s: Segment): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return distance(p, { x: s.x1, y: s.y1 });
  const t = Math.max(0, Math.min(1, ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / len2));
  return distance(p, { x: s.x1 + t * dx, y: s.y1 + t * dy });
}

export function rectFrom(a: Point, b: Point): Rect {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

export function pointInRect(p: Point, r: Rect, pad = 0): boolean {
  return p.x >= r.left - pad && p.x <= r.right + pad && p.y >= r.top - pad && p.y <= r.bottom + pad;
}

/** Distance from a point to the nearest rectangle edge (0 when on an edge). */
export function edgeDistance(p: Point, r: Rect): number {
  return Math.min(Math.abs(p.x - r.left), Math.abs(p.x - r.right), Math.abs(p.y - r.top), Math.abs(p.y - r.bottom));
}

export type ShapePart = "a" | "b" | "body";
export type HitTarget = { id: string; part: ShapePart; distance: number };

/** Pixel layout of one drawing; `label` lines are pre-formatted by the host. */
export type Shape =
  | { kind: "hline"; id: string; y: number; label: string[] }
  | { kind: "trendline"; id: string; a: Point; b: Point; drawn: Segment; label: string[] }
  | { kind: "measure"; id: string; a: Point; b: Point; rect: Rect; up: boolean; label: string[] };

export function hitTestShape(p: Point, shape: Shape, tol = HIT_TOLERANCE_PX): HitTarget | null {
  if (shape.kind !== "hline") {
    const da = distance(p, shape.a);
    if (da <= tol + HANDLE_RADIUS_PX) return { id: shape.id, part: "a", distance: da };
    const db = distance(p, shape.b);
    if (db <= tol + HANDLE_RADIUS_PX) return { id: shape.id, part: "b", distance: db };
  }
  if (shape.kind === "hline") {
    const d = Math.abs(p.y - shape.y);
    return d <= tol ? { id: shape.id, part: "body", distance: d } : null;
  }
  if (shape.kind === "trendline") {
    const d = distanceToSegment(p, shape.drawn);
    return d <= tol ? { id: shape.id, part: "body", distance: d } : null;
  }
  if (!pointInRect(p, shape.rect, tol)) return null;
  return { id: shape.id, part: "body", distance: pointInRect(p, shape.rect) ? 0 : edgeDistance(p, shape.rect) };
}

/** Topmost wins ties: handles beat bodies, then smaller distance, then later (drawn-on-top) shapes. */
export function hitTestShapes(p: Point, shapes: readonly Shape[], tol = HIT_TOLERANCE_PX): HitTarget | null {
  let best: HitTarget | null = null;
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    const hit = hitTestShape(p, shapes[i], tol);
    if (!hit) continue;
    if (!best) { best = hit; continue; }
    const bestIsHandle = best.part !== "body";
    const hitIsHandle = hit.part !== "body";
    if (hitIsHandle !== bestIsHandle) { if (hitIsHandle) best = hit; continue; }
    if (hit.distance < best.distance) best = hit;
  }
  return best;
}

export function translateAnchor(anchor: Anchor, dTime: number, dPrice: number): Anchor {
  return { time: anchor.time + dTime, price: anchor.price + dPrice };
}

export type MeasureStats = { priceChange: number; pctChange: number | null; barCount: number | null; spanMs: number; up: boolean };

/** Stats for a measure box from a → b. pct is null when the start price is 0; barCount is null without a bar interval. */
export function measureStats(a: Anchor, b: Anchor, barMs: number | null): MeasureStats {
  const priceChange = b.price - a.price;
  const pctChange = a.price !== 0 && Number.isFinite(a.price) ? (priceChange / Math.abs(a.price)) * 100 : null;
  const spanMs = Math.abs(b.time - a.time);
  const barCount = barMs !== null && barMs > 0 ? Math.round(spanMs / barMs) : null;
  return { priceChange, pctChange, barCount, spanMs, up: priceChange >= 0 };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Compact duration: "45s", "12m", "2h 05m", "1d 04h". */
export function formatSpan(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < MINUTE_MS) return `${Math.round(abs / 1000)}s`;
  if (abs < HOUR_MS) return `${Math.round(abs / MINUTE_MS)}m`;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (abs < DAY_MS) return `${Math.floor(abs / HOUR_MS)}h ${pad(Math.round((abs % HOUR_MS) / MINUTE_MS))}m`;
  return `${Math.floor(abs / DAY_MS)}d ${pad(Math.floor((abs % DAY_MS) / HOUR_MS))}h`;
}

export function formatPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

/** Time for a logical index beyond the data, extrapolated from the last bar at a fixed interval. */
export function timeForLogical(logical: number, lastIndex: number, lastTimeMs: number, barMs: number): number {
  return lastTimeMs + (logical - lastIndex) * barMs;
}

export function logicalForTime(timeMs: number, lastIndex: number, lastTimeMs: number, barMs: number): number {
  return lastIndex + (timeMs - lastTimeMs) / barMs;
}
