import {TERMINAL_COLORS} from "../../lib/themeTokens";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, PrimitiveHoveredItem, SeriesAttachedParameter, Time } from "lightweight-charts";
import {
  HANDLE_RADIUS_PX,
  crisp,
  formatPct,
  formatSpan,
  hitTestShapes,
  measureStats,
  rectFrom,
  type HitTarget,
  type Point,
  type Rect,
  type Shape
} from "./geometry";
import { EMPTY_STATE, type Draft, type Drawing, type DrawingsState } from "./state";

/** Colours are CSS strings supplied by the host; these defaults mirror src/styles.css tokens. */
export type DrawingTheme = { line: string; selected: string; text: string; labelBg: string; up: string; down: string; handle: string; font: string };

const FONT = '10px ui-monospace, monospace';
function drawingTheme(mode:'dark'|'light'):DrawingTheme{const c=TERMINAL_COLORS[mode];return {line:c.label,selected:c.select,text:c['text-strong'],labelBg:c.surface,up:c.up,down:c.down,handle:c['text-strong'],font:FONT};}
export const DARK_DRAWING_THEME=drawingTheme('dark');
export const LIGHT_DRAWING_THEME=drawingTheme('light');

export type Formatters = { price: (price: number) => string; time: (epochMs: number) => string };

/** Chart-space mapping owned by index.ts; every call may return null when a value is off-scale or the chart has no data. */
export type Mapper = {
  xOf: (timeMs: number) => number | null;
  yOf: (price: number) => number | null;
  barMs: () => number | null;
  width: () => number;
  height: () => number;
};

const DRAFT_ID = "__draft__";
const LABEL_PAD = 4;
const LINE_HEIGHT = 12;
const FILL_ALPHA = 0.12;
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

type LayoutCtx = { mapper: Mapper; formatters: Formatters };

function layoutDrawing(d: Drawing | (Draft & { id: string }), ctx: LayoutCtx, selectedOrDraft: boolean): Shape | null {
  const { mapper, formatters } = ctx;
  if (d.kind === "hline") {
    const y = mapper.yOf(d.price);
    return y === null ? null : { kind: "hline", id: d.id, y, label: [formatters.price(d.price)] };
  }
  const ax = mapper.xOf(d.a.time), ay = mapper.yOf(d.a.price), bx = mapper.xOf(d.b.time), by = mapper.yOf(d.b.price);
  if (ax === null || ay === null || bx === null || by === null) return null;
  const a: Point = { x: ax, y: ay }, b: Point = { x: bx, y: by };
  if (d.kind === "trendline") {
    const label = selectedOrDraft ? [`${formatters.price(d.a.price)} → ${formatters.price(d.b.price)}`] : [];
    return { kind: "trendline", id: d.id, a, b, drawn: { x1: ax, y1: ay, x2: bx, y2: by }, label };
  }
  if (d.kind === "marker") {
    const size = 8;
    return { kind: "marker", id: d.id, a, b, direction: d.direction, rect: { left: a.x - size, top: a.y - size, right: a.x + size, bottom: a.y + size } };
  }
  if (d.kind === "fib") {
    const levels = FIB_LEVELS.map((ratio) => ({ y: ay + (by - ay) * ratio, label: `${ratio.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")} · ${formatters.price(d.a.price + (d.b.price - d.a.price) * ratio)}` }));
    return { kind: "fib", id: d.id, a, b, rect: rectFrom(a, b), levels };
  }
  const stats = measureStats(d.a, d.b, mapper.barMs());
  const bars = stats.barCount === null ? "? bars" : `${stats.barCount} bar${stats.barCount === 1 ? "" : "s"}`;
  const label = [
    `${formatPct(stats.pctChange)}  ${formatters.price(d.a.price)} → ${formatters.price(d.b.price)}`,
    `${bars} · ${formatSpan(stats.spanMs)}`,
    `${formatters.time(Math.min(d.a.time, d.b.time))} → ${formatters.time(Math.max(d.a.time, d.b.time))}`
  ];
  return { kind: "measure", id: d.id, a, b, rect: rectFrom(a, b), up: stats.up, label };
}

/** One primitive renders every drawing of a series on a single "top" pane view. */
export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private state: DrawingsState = EMPTY_STATE;
  private shapes: Shape[] = [];
  private draftShape: Shape | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly view: IPrimitivePaneView;
  private readonly paneRenderer: IPrimitivePaneRenderer;

  constructor(private readonly mapper: Mapper, private formatters: Formatters, private theme: DrawingTheme) {
    this.paneRenderer = { draw: (target: CanvasRenderingTarget2D) => target.useMediaCoordinateSpace(({ context }) => this.paint(context)) };
    this.view = { zOrder: () => "top", renderer: () => this.paneRenderer };
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = null;
  }

  setState(state: DrawingsState): void {
    this.state = state;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    const ctx = { mapper: this.mapper, formatters: this.formatters };
    this.shapes = this.state.drawings.flatMap((d) => layoutDrawing(d, ctx, d.id === this.state.selectedId) ?? []);
    this.draftShape = this.state.draft ? layoutDrawing({ ...this.state.draft, id: DRAFT_ID }, ctx, true) : null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  /** Library hook: drives cursor + hoveredObjectId. Pointer logic in index.ts uses hitAt() directly. */
  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const hit = this.hitAt({ x, y });
    if (!hit) return null;
    return { externalId: hit.id, zOrder: "top", cursorStyle: hit.part === "body" ? "move" : "pointer", distance: hit.distance, hitTestPriority: hit.part === "body" ? 1 : 2 };
  }

  hitAt(p: Point): HitTarget | null {
    return hitTestShapes(p, this.shapes);
  }

  private paint(ctx: CanvasRenderingContext2D): void {
    const width = this.mapper.width();
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = this.theme.font;
    ctx.textBaseline = "top";
    for (const shape of this.shapes) this.paintShape(ctx, shape, shape.id === this.state.selectedId, width);
    if (this.draftShape) this.paintShape(ctx, this.draftShape, true, width);
    ctx.restore();
  }

  private paintShape(ctx: CanvasRenderingContext2D, shape: Shape, selected: boolean, width: number): void {
    const stroke = selected ? this.theme.selected : this.theme.line;
    if (shape.kind === "hline") {
      const y = crisp(shape.y);
      this.line(ctx, 0, y, width, y, stroke);
      this.label(ctx, shape.label, width - LABEL_PAD, y - LINE_HEIGHT / 2 - LABEL_PAD, "right");
      return;
    }
    if (shape.kind === "trendline") {
      this.line(ctx, crisp(shape.drawn.x1), crisp(shape.drawn.y1), crisp(shape.drawn.x2), crisp(shape.drawn.y2), stroke);
      if (selected) {
        this.handles(ctx, shape.a, shape.b);
        this.label(ctx, shape.label, shape.b.x + LABEL_PAD * 2, shape.b.y - LINE_HEIGHT / 2 - LABEL_PAD, "left");
      }
      return;
    }
    if (shape.kind === "marker") {
      const color = shape.direction === "up" ? this.theme.up : this.theme.down;
      const sign = shape.direction === "up" ? -1 : 1;
      ctx.save();
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(shape.a.x, shape.a.y + sign * 9);
      ctx.lineTo(shape.a.x - 7, shape.a.y - sign * 5);
      ctx.lineTo(shape.a.x + 7, shape.a.y - sign * 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      if (selected) this.handles(ctx, shape.a);
      return;
    }
    if (shape.kind === "fib") {
      ctx.save();
      ctx.globalAlpha = FILL_ALPHA;
      ctx.fillStyle = this.theme.selected;
      ctx.fillRect(shape.rect.left, shape.rect.top, Math.max(1, shape.rect.right - shape.rect.left), Math.max(1, shape.rect.bottom - shape.rect.top));
      ctx.restore();
      shape.levels.forEach((level) => {
        this.line(ctx, crisp(shape.rect.left), crisp(level.y), crisp(shape.rect.right), crisp(level.y), stroke);
        this.label(ctx, [level.label], shape.rect.right + LABEL_PAD, level.y - LINE_HEIGHT / 2, "left");
      });
      if (selected) this.handles(ctx, shape.a, shape.b);
      return;
    }
    this.box(ctx, shape.rect, shape.up ? this.theme.up : this.theme.down, selected ? this.theme.selected : undefined);
    if (selected) this.handles(ctx, shape.a, shape.b);
    this.label(ctx, shape.label, (shape.rect.left + shape.rect.right) / 2, shape.rect.top - shape.label.length * LINE_HEIGHT - LABEL_PAD * 3, "center");
  }

  private line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string): void {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  private box(ctx: CanvasRenderingContext2D, r: Rect, fill: string, outline?: string): void {
    const w = Math.max(1, r.right - r.left), h = Math.max(1, r.bottom - r.top);
    ctx.save();
    ctx.globalAlpha = FILL_ALPHA;
    ctx.fillStyle = fill;
    ctx.fillRect(r.left, r.top, w, h);
    ctx.restore();
    ctx.strokeStyle = outline ?? fill;
    ctx.strokeRect(crisp(r.left), crisp(r.top), Math.round(w), Math.round(h));
  }

  private handles(ctx: CanvasRenderingContext2D, ...points: Point[]): void {
    ctx.fillStyle = this.theme.handle;
    ctx.strokeStyle = this.theme.selected;
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_RADIUS_PX, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  private label(ctx: CanvasRenderingContext2D, lines: string[], x: number, y: number, align: "left" | "right" | "center"): void {
    if (lines.length === 0) return;
    const textWidth = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const w = textWidth + LABEL_PAD * 2, h = lines.length * LINE_HEIGHT + LABEL_PAD * 2;
    const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    const top = Math.max(0, y);
    ctx.fillStyle = this.theme.labelBg;
    ctx.fillRect(Math.round(left), Math.round(top), Math.round(w), Math.round(h));
    ctx.strokeStyle = this.theme.line;
    ctx.strokeRect(crisp(left), crisp(top), Math.round(w), Math.round(h));
    ctx.fillStyle = this.theme.text;
    ctx.textAlign = "left";
    lines.forEach((l, i) => ctx.fillText(l, Math.round(left) + LABEL_PAD, Math.round(top) + LABEL_PAD + i * LINE_HEIGHT));
  }
}
