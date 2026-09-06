import type { LargePrint } from "../../shared/wire";
import { toSeconds } from "./chartTime";
import { FLOW_PALETTE, type FlowChartTheme } from "./flowChart";
import { MARKER_SIZE_BY_CLASS, candleIndexFor, sizeClass, type FomoMarker } from "./fomoMarkers";
import { money } from "./format";

/**
 * Pure event-marker builder (launch, graduation, large prints) plus the merge step that keeps one
 * sorted marker list for lightweight-charts' single createSeriesMarkers instance. No chart imports.
 */

export type ChartMarker = {
  time: number; // UTC seconds of the containing candle
  position: "aboveBar" | "belowBar" | "inBar";
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  color: string;
  text?: string;
  size?: number;
};

export type EventMarkerInput = {
  launch?: { createdAt: number; launchpad: string } | null;
  graduation?: { time: number } | null;
  largePrints?: LargePrint[];
};

export type EventMarkerOptions = { theme: FlowChartTheme; maxLargePrintMarkers?: number };

/** `dropped` = large-print groups cut by the cap; `beforeRange` = events older than the first candle (never placed). */
export type EventMarkerResult = { markers: ChartMarker[]; dropped: number; beforeRange: number };

export const DEFAULT_MAX_LARGE_PRINT_MARKERS = 40;
export const LAUNCH_MARKER_SIZE = 1.2;

type LargeGroup = { candleIndex: number; side: LargePrint["side"]; count: number; maxUsd: number };

const POSITION_RANK: Record<ChartMarker["position"], number> = { belowBar: 0, inBar: 1, aboveBar: 2 };

function groupLargePrints(prints: LargePrint[], candleTimesMs: number[]): { groups: LargeGroup[]; beforeRange: number } {
  const byKey = new Map<string, LargeGroup>();
  let beforeRange = 0;
  for (const print of prints) {
    if (!Number.isFinite(print.usd) || !Number.isFinite(print.time)) continue;
    const candleIndex = candleIndexFor(candleTimesMs, print.time);
    if (candleIndex < 0) {
      beforeRange += 1;
      continue;
    }
    const key = `${candleIndex}|${print.side}`;
    const prior = byKey.get(key);
    byKey.set(key, prior
      ? { ...prior, count: prior.count + 1, maxUsd: Math.max(prior.maxUsd, print.usd) }
      : { candleIndex, side: print.side, count: 1, maxUsd: print.usd });
  }
  return { groups: [...byKey.values()], beforeRange };
}

/** "$12K" for one print, "×3 ≤$12K" when several collapsed into the candle (≤ marks the max, not a sum). */
export function largePrintText(group: Pick<LargeGroup, "count" | "maxUsd">): string {
  const usd = money(group.maxUsd, true);
  return group.count > 1 ? `×${group.count} ≤${usd}` : usd;
}

function largeGroupMarker(group: LargeGroup, candleTimesMs: number[], theme: FlowChartTheme): ChartMarker {
  const palette = FLOW_PALETTE[theme];
  const buy = group.side === "buy";
  return {
    time: toSeconds(candleTimesMs[group.candleIndex]),
    position: buy ? "belowBar" : "aboveBar",
    shape: "circle",
    color: buy ? palette.buy : palette.sell,
    text: largePrintText(group),
    size: MARKER_SIZE_BY_CLASS[sizeClass(group.maxUsd)]
  };
}

function byMaxUsdDesc(a: LargeGroup, b: LargeGroup): number {
  return b.maxUsd - a.maxUsd || b.count - a.count;
}

/** Ascending time, then belowBar < inBar < aboveBar, then insertion order (Array.prototype.sort is stable). */
export function sortMarkers<T extends Pick<ChartMarker, "time" | "position">>(markers: T[]): T[] {
  return markers.slice().sort((a, b) => a.time - b.time || POSITION_RANK[a.position] - POSITION_RANK[b.position]);
}

/** One sorted list for the single markers plugin; FomoMarker is structurally a ChartMarker. */
export function mergeMarkers(...lists: Array<Array<ChartMarker | FomoMarker> | undefined>): ChartMarker[] {
  return sortMarkers(lists.flatMap((list) => list ?? []));
}

export function buildEventMarkers(input: EventMarkerInput, candleTimesMs: number[], opts: EventMarkerOptions): EventMarkerResult {
  if (!candleTimesMs.length) {
    const pending = (input.launch ? 1 : 0) + (input.graduation ? 1 : 0) + (input.largePrints?.length ?? 0);
    return { markers: [], dropped: 0, beforeRange: pending };
  }
  const palette = FLOW_PALETTE[opts.theme];
  const fixed: ChartMarker[] = [];
  let beforeRange = 0;
  const place = (timeMs: number, marker: Omit<ChartMarker, "time">) => {
    const index = candleIndexFor(candleTimesMs, timeMs);
    if (index < 0) beforeRange += 1;
    else fixed.push({ ...marker, time: toSeconds(candleTimesMs[index]) });
  };
  if (input.launch && Number.isFinite(input.launch.createdAt)) {
    place(input.launch.createdAt, { position: "belowBar", shape: "square", color: palette.pair[0], text: `LAUNCH ${input.launch.launchpad}`.trim(), size: LAUNCH_MARKER_SIZE });
  }
  if (input.graduation && Number.isFinite(input.graduation.time)) {
    place(input.graduation.time, { position: "aboveBar", shape: "square", color: palette.pair[1], text: "GRADUATED", size: LAUNCH_MARKER_SIZE });
  }
  const cap = opts.maxLargePrintMarkers ?? DEFAULT_MAX_LARGE_PRINT_MARKERS;
  const grouped = groupLargePrints(input.largePrints ?? [], candleTimesMs);
  const kept = grouped.groups.length > cap ? grouped.groups.slice().sort(byMaxUsdDesc).slice(0, Math.max(0, cap)) : grouped.groups;
  const large = kept.map((group) => largeGroupMarker(group, candleTimesMs, opts.theme));
  return {
    markers: sortMarkers([...fixed, ...large]),
    dropped: grouped.groups.length - kept.length,
    beforeRange: beforeRange + grouped.beforeRange
  };
}
