import type { FomoFill } from "../../shared/wire";
import { FLOW_PALETTE, type FlowChartTheme } from "./flowChart";
import { money, shortAddress } from "./format";

/** Pure marker builder for lightweight-charts v5 createSeriesMarkers. No chart-library imports: tested in node. */

export type FomoMarker = {
  time: number; // UTC seconds of the containing candle
  position: "aboveBar" | "belowBar";
  shape: "arrowUp" | "arrowDown";
  color: string;
  text: string;
  size?: number;
};

export type FomoMarkerOptions = { maxMarkers?: number; theme: FlowChartTheme };

/** `dropped` = markers cut by the cap; `beforeRange` = fills older than the first candle (no candle contains them). */
export type FomoMarkerResult = { markers: FomoMarker[]; dropped: number; beforeRange: number };

/** `wallets` = distinct addresses; `unpriced` fills are counted, never summed. `net` = buyUsd - sellUsd. */
export type FomoSummary = { buyUsd: number; sellUsd: number; net: number; wallets: number; fills: number; unpriced: number };

export type FomoSizeClass = 0 | 1 | 2;

export const DEFAULT_MAX_MARKERS = 60;
/** Size class boundaries in USD: class 0 below the first, class 1 below the second, class 2 at or above it. */
export const SIZE_THRESHOLDS: readonly [number, number] = [500, 5_000];
/** lightweight-charts clamps marker size at 0 (invisible), so classes map to visible multipliers of the default. */
export const MARKER_SIZE_BY_CLASS: Readonly<Record<FomoSizeClass, number>> = { 0: 0.8, 1: 1.1, 2: 1.6 };

type Group = {
  address: string;
  handle: string | null;
  side: FomoFill["side"];
  candleIndex: number;
  count: number;
  usd: number | null;
  unpriced: number;
};

/** Index of the last candle whose start is at or before `timeMs`; -1 when the fill predates the first candle. */
export function candleIndexFor(candleTimesMs: number[], timeMs: number): number {
  let lo = 0;
  let hi = candleTimesMs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candleTimesMs[mid] <= timeMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function sizeClass(usd: number | null): FomoSizeClass {
  if (usd == null || !Number.isFinite(usd)) return 0;
  if (usd < SIZE_THRESHOLDS[0]) return 0;
  if (usd < SIZE_THRESHOLDS[1]) return 1;
  return 2;
}

function priced(usd: number | null): usd is number {
  return usd != null && Number.isFinite(usd);
}

function walletKey(address: string): string {
  return address.toLowerCase();
}

function groupFills(fills: FomoFill[], candleTimesMs: number[]): { groups: Group[]; beforeRange: number } {
  const byKey = new Map<string, Group>();
  let beforeRange = 0;
  for (const fill of fills) {
    const candleIndex = candleIndexFor(candleTimesMs, fill.time);
    if (candleIndex < 0) {
      beforeRange += 1;
      continue;
    }
    const wallet = walletKey(fill.trader.address);
    const key = `${wallet}|${fill.side}|${candleIndex}`;
    const prior = byKey.get(key);
    const usd = priced(fill.usd) ? fill.usd : null;
    if (!prior) {
      byKey.set(key, {
        address: fill.trader.address,
        handle: fill.trader.handle,
        side: fill.side,
        candleIndex,
        count: 1,
        usd,
        unpriced: usd == null ? 1 : 0
      });
      continue;
    }
    byKey.set(key, {
      ...prior,
      handle: prior.handle ?? fill.trader.handle,
      count: prior.count + 1,
      usd: usd == null ? prior.usd : (prior.usd ?? 0) + usd,
      unpriced: prior.unpriced + (usd == null ? 1 : 0)
    });
  }
  return { groups: [...byKey.values()], beforeRange };
}

export function markerText(group: Pick<Group, "address" | "handle" | "count" | "usd">): string {
  const label = group.handle?.trim() || shortAddress(group.address);
  const parts = [label];
  if (group.count > 1) parts.push(`×${group.count}`);
  if (priced(group.usd)) parts.push(money(group.usd, true));
  return parts.join(" ");
}

function toMarker(group: Group, candleTimesMs: number[], theme: FlowChartTheme): FomoMarker {
  const palette = FLOW_PALETTE[theme];
  const buy = group.side === "buy";
  return {
    time: Math.floor(candleTimesMs[group.candleIndex] / 1000),
    position: buy ? "belowBar" : "aboveBar",
    shape: buy ? "arrowUp" : "arrowDown",
    color: buy ? palette.buy : palette.sell,
    text: markerText(group),
    size: MARKER_SIZE_BY_CLASS[sizeClass(group.usd)]
  };
}

function byTimeThenSide(a: Group, b: Group): number {
  if (a.candleIndex !== b.candleIndex) return a.candleIndex - b.candleIndex;
  if (a.side !== b.side) return a.side === "buy" ? -1 : 1;
  return walletKey(a.address) < walletKey(b.address) ? -1 : 1;
}

/** Largest priced first; unpriced groups rank below every priced one, ties broken by fill count. */
function byUsdDesc(a: Group, b: Group): number {
  const ua = priced(a.usd) ? a.usd : -1;
  const ub = priced(b.usd) ? b.usd : -1;
  if (ua !== ub) return ub - ua;
  return b.count - a.count;
}

export function buildFomoMarkers(fills: FomoFill[], candleTimesMs: number[], opts: FomoMarkerOptions): FomoMarkerResult {
  const maxMarkers = opts.maxMarkers ?? DEFAULT_MAX_MARKERS;
  if (candleTimesMs.length === 0) return { markers: [], dropped: 0, beforeRange: fills.length };
  const { groups, beforeRange } = groupFills(fills, candleTimesMs);
  const kept = groups.length > maxMarkers ? [...groups].sort(byUsdDesc).slice(0, Math.max(0, maxMarkers)) : groups;
  const markers = [...kept].sort(byTimeThenSide).map((group) => toMarker(group, candleTimesMs, opts.theme));
  return { markers, dropped: groups.length - kept.length, beforeRange };
}

/** Header-line totals over fills at or before `nowMs` (future-stamped fills are ignored) and within `windowMs` of it. */
export function summarizeFomo(fills: FomoFill[], nowMs: number, windowMs = Number.POSITIVE_INFINITY): FomoSummary {
  const wallets = new Set<string>();
  let buyUsd = 0;
  let sellUsd = 0;
  let unpriced = 0;
  let counted = 0;
  for (const fill of fills) {
    if (fill.time > nowMs || nowMs - fill.time > windowMs) continue;
    counted += 1;
    wallets.add(walletKey(fill.trader.address));
    if (!priced(fill.usd)) {
      unpriced += 1;
      continue;
    }
    if (fill.side === "buy") buyUsd += fill.usd;
    else sellUsd += fill.usd;
  }
  return { buyUsd, sellUsd, net: buyUsd - sellUsd, wallets: wallets.size, fills: counted, unpriced };
}
