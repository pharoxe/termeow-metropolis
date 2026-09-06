import { describe, expect, it } from "vitest";
import {
  HANDLE_RADIUS_PX,
  HIT_TOLERANCE_PX,
  crisp,
  distanceToSegment,
  edgeDistance,
  formatPct,
  formatSpan,
  hitTestShape,
  hitTestShapes,
  logicalForTime,
  measureStats,
  pointInRect,
  rectFrom,
  timeForLogical,
  translateAnchor,
  type Shape
} from "./geometry";

const MINUTE = 60_000;
const T0 = 1_788_717_000_000;

const HLINE: Shape = { kind: "hline", id: "h1", y: 100, label: ["$0.25"] };
const TREND: Shape = { kind: "trendline", id: "t1", a: { x: 10, y: 10 }, b: { x: 110, y: 110 }, drawn: { x1: 10, y1: 10, x2: 110, y2: 110 }, label: [] };
const BOX: Shape = { kind: "measure", id: "m1", a: { x: 200, y: 50 }, b: { x: 300, y: 150 }, rect: rectFrom({ x: 200, y: 50 }, { x: 300, y: 150 }), up: true, label: [] };

describe("crisp", () => {
  it("snaps to the pixel centre", () => {
    expect(crisp(10)).toBe(10.5);
    expect(crisp(10.4)).toBe(10.5);
    expect(crisp(10.6)).toBe(11.5);
  });
});

describe("distanceToSegment", () => {
  it("measures perpendicular distance inside the span and endpoint distance outside it", () => {
    const seg = { x1: 0, y1: 0, x2: 10, y2: 0 };
    expect(distanceToSegment({ x: 5, y: 3 }, seg)).toBe(3);
    expect(distanceToSegment({ x: 14, y: 3 }, seg)).toBe(5);
    expect(distanceToSegment({ x: -4, y: 0 }, seg)).toBe(4);
  });
  it("treats a zero-length segment as a point", () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x1: 0, y1: 0, x2: 0, y2: 0 })).toBe(5);
  });
});

describe("rectFrom / pointInRect / edgeDistance", () => {
  it("normalises corners regardless of drag direction", () => {
    expect(rectFrom({ x: 30, y: 40 }, { x: 10, y: 20 })).toEqual({ left: 10, top: 20, right: 30, bottom: 40 });
  });
  it("honours padding and reports edge distance", () => {
    const r = { left: 10, top: 20, right: 30, bottom: 40 };
    expect(pointInRect({ x: 32, y: 30 }, r)).toBe(false);
    expect(pointInRect({ x: 32, y: 30 }, r, 3)).toBe(true);
    expect(edgeDistance({ x: 12, y: 30 }, r)).toBe(2);
  });
});

describe("hitTestShape", () => {
  it("hits a horizontal line within tolerance only", () => {
    expect(hitTestShape({ x: 400, y: 100 + HIT_TOLERANCE_PX }, HLINE)).toEqual({ id: "h1", part: "body", distance: HIT_TOLERANCE_PX });
    expect(hitTestShape({ x: 400, y: 100 + HIT_TOLERANCE_PX + 1 }, HLINE)).toBeNull();
  });
  it("prefers the anchor handle over the body of a trendline", () => {
    expect(hitTestShape({ x: 12, y: 12 }, TREND)?.part).toBe("a");
    expect(hitTestShape({ x: 108, y: 112 }, TREND)?.part).toBe("b");
    expect(hitTestShape({ x: 60, y: 62 }, TREND)?.part).toBe("body");
    expect(hitTestShape({ x: 60, y: 90 }, TREND)).toBeNull();
  });
  it("hits anywhere inside a measure box with distance 0 and near its edges with the edge distance", () => {
    expect(hitTestShape({ x: 250, y: 100 }, BOX)).toEqual({ id: "m1", part: "body", distance: 0 });
    expect(hitTestShape({ x: 303, y: 100 }, BOX)).toEqual({ id: "m1", part: "body", distance: 3 });
    expect(hitTestShape({ x: 200 + HIT_TOLERANCE_PX + HANDLE_RADIUS_PX + 1, y: 40 }, BOX)).toBeNull();
  });
});

describe("hitTestShapes", () => {
  it("returns null with no shapes and lets handles beat bodies across shapes", () => {
    expect(hitTestShapes({ x: 0, y: 0 }, [])).toBeNull();
    const lineUnderHandle: Shape = { kind: "hline", id: "h2", y: 10, label: [] };
    expect(hitTestShapes({ x: 10, y: 10 }, [TREND, lineUnderHandle])).toMatchObject({ id: "t1", part: "a" });
  });
  it("picks the closer body and, on ties, the later (topmost) shape", () => {
    const low: Shape = { kind: "hline", id: "low", y: 104, label: [] };
    expect(hitTestShapes({ x: 5, y: 103 }, [HLINE, low])?.id).toBe("low");
    const twin: Shape = { ...HLINE, id: "twin" };
    expect(hitTestShapes({ x: 5, y: 100 }, [HLINE, twin])?.id).toBe("twin");
  });
});

describe("measureStats", () => {
  it("computes signed change, pct, bar count and span", () => {
    const stats = measureStats({ time: T0, price: 0.2 }, { time: T0 + 12 * MINUTE, price: 0.25 }, MINUTE);
    expect(stats.priceChange).toBeCloseTo(0.05, 12);
    expect(stats.pctChange).toBeCloseTo(25, 9);
    expect(stats.barCount).toBe(12);
    expect(stats.spanMs).toBe(12 * MINUTE);
    expect(stats.up).toBe(true);
  });
  it("is direction-agnostic for span and reports down moves", () => {
    const stats = measureStats({ time: T0 + 5 * MINUTE, price: 0.25 }, { time: T0, price: 0.2 }, MINUTE);
    expect(stats.spanMs).toBe(5 * MINUTE);
    expect(stats.barCount).toBe(5);
    expect(stats.up).toBe(false);
    expect(stats.pctChange).toBeCloseTo(-20, 9);
  });
  it("leaves pct null at a zero start price and barCount null without an interval", () => {
    const stats = measureStats({ time: T0, price: 0 }, { time: T0 + MINUTE, price: 1 }, null);
    expect(stats.pctChange).toBeNull();
    expect(stats.barCount).toBeNull();
  });
});

describe("formatSpan / formatPct", () => {
  it("formats compact durations", () => {
    expect(formatSpan(45_000)).toBe("45s");
    expect(formatSpan(12 * MINUTE)).toBe("12m");
    expect(formatSpan(2 * 3_600_000 + 5 * MINUTE)).toBe("2h 05m");
    expect(formatSpan(28 * 3_600_000)).toBe("1d 04h");
    expect(formatSpan(-MINUTE)).toBe("1m");
  });
  it("formats signed percentages and a dash for null", () => {
    expect(formatPct(3.456)).toBe("+3.46%");
    expect(formatPct(-0.5)).toBe("-0.50%");
    expect(formatPct(null)).toBe("—");
    expect(formatPct(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("extrapolation", () => {
  it("round-trips time <-> logical beyond the last bar", () => {
    expect(timeForLogical(103, 99, T0, MINUTE)).toBe(T0 + 4 * MINUTE);
    expect(logicalForTime(T0 + 4 * MINUTE, 99, T0, MINUTE)).toBe(103);
    expect(logicalForTime(T0 - 30_000, 99, T0, MINUTE)).toBe(98.5);
  });
  it("translates anchors additively", () => {
    expect(translateAnchor({ time: T0, price: 1 }, MINUTE, -0.5)).toEqual({ time: T0 + MINUTE, price: 0.5 });
  });
});
