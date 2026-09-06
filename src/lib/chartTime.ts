/**
 * Chart time helpers: epoch normalisation and explicit IST (UTC+5:30) rendering for
 * lightweight-charts axes, crosshair labels and the legend. No Date-locale or DOM dependence.
 */

export type TimeGranularity = "second" | "minute" | "hour" | "day";

/** A lightweight-charts `Time` without importing the library: UTC seconds, business day or ISO string. */
export type ChartTimeLike = number | string | { year: number; month: number; day: number };

export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const IST_SUFFIX = "IST";

/** Numeric values of lightweight-charts' TickMarkType enum (Year=0 … TimeWithSeconds=4), kept local so tests stay DOM-free. */
export const TICK_MARK = { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 } as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MS_THRESHOLD = 1e12;

/** Epoch seconds from a raw epoch that may be in ms (> 1e12) or already in seconds; floors to whole seconds. */
export function toSeconds(raw: number): number {
  const value = Number(raw);
  return Math.floor(value > MS_THRESHOLD ? value / 1000 : value);
}

/** Epoch ms from a raw epoch that may be in seconds or ms. */
export function toMillis(raw: number): number {
  const value = Number(raw);
  return value > MS_THRESHOLD ? value : value * 1000;
}

/** Parses a desk interval label ("1M" minute, "15S", "4H", "1D", "1W", any case) into ms; null when malformed. */
export function parseIntervalMs(label: string): number | null {
  const match = /^(\d+)\s*([smhdw])$/i.exec(label.trim());
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return null;
  const unit = match[2].toLowerCase();
  const unitMs = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
  return count * unitMs;
}

/** Legend/axis granularity for a bar interval: sub-minute bars need seconds, sub-day bars need minutes. */
export function granularityFor(intervalMs: number | null | undefined): TimeGranularity {
  if (intervalMs == null || !Number.isFinite(intervalMs) || intervalMs <= 0) return "minute";
  if (intervalMs < 60_000) return "second";
  if (intervalMs < 3_600_000) return "minute";
  if (intervalMs < 86_400_000) return "hour";
  return "day";
}

export type IstParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** Calendar fields of an epoch in IST, computed by shifting the epoch and reading UTC fields (no locale/timezone database). */
export function istParts(msOrSec: number): IstParts {
  const shifted = new Date(toMillis(msOrSec) + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds()
  };
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function clock(parts: IstParts, granularity: TimeGranularity): string {
  const base = `${pad(parts.hour)}:${pad(parts.minute)}`;
  return granularity === "second" ? `${base}:${pad(parts.second)}` : base;
}

function calendar(parts: IstParts): string {
  return `${pad(parts.day)} ${MONTHS[parts.month - 1]} ${parts.year}`;
}

/**
 * Full IST stamp for the legend, e.g. "06 Sep 2026 23:24 IST" (seconds appended for sub-minute bars,
 * clock omitted for daily bars). Non-finite input renders as "—".
 */
export function formatIst(msOrSec: number | null | undefined, granularity: TimeGranularity, suffix = true): string {
  if (msOrSec == null || !Number.isFinite(msOrSec)) return "—";
  const parts = istParts(msOrSec);
  const body = granularity === "day" ? calendar(parts) : `${calendar(parts)} ${clock(parts, granularity)}`;
  return suffix ? `${body} ${IST_SUFFIX}` : body;
}

function chartTimeToMs(time: ChartTimeLike): number | null {
  if (typeof time === "number") return toMillis(time);
  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return Date.UTC(time.year, time.month - 1, time.day);
}

/** Crosshair time label (lightweight-charts `localization.timeFormatter`): short IST stamp without the suffix. */
export function formatIstCrosshair(time: ChartTimeLike, granularity: TimeGranularity): string {
  const ms = chartTimeToMs(time);
  if (ms == null) return "";
  const parts = istParts(ms);
  const date = `${pad(parts.day)} ${MONTHS[parts.month - 1]}`;
  return granularity === "day" ? `${date} ${parts.year}` : `${date} ${clock(parts, granularity)}`;
}

/**
 * Time-axis tick label (lightweight-charts `timeScale.tickMarkFormatter`) in IST.
 * `tickMarkType` follows TickMarkType's numeric values; sub-minute bars render seconds on Time ticks too.
 */
export function formatIstTick(time: ChartTimeLike, tickMarkType: number, granularity: TimeGranularity): string {
  const ms = chartTimeToMs(time);
  if (ms == null) return "";
  const parts = istParts(ms);
  switch (tickMarkType) {
    case TICK_MARK.Year: return String(parts.year);
    case TICK_MARK.Month: return MONTHS[parts.month - 1];
    case TICK_MARK.DayOfMonth: return String(parts.day);
    case TICK_MARK.TimeWithSeconds: return clock(parts, "second");
    default: return clock(parts, granularity === "second" ? "second" : "minute");
  }
}

/** `localization` options for createChart/applyOptions: IST crosshair labels, en-IN locale. */
export function istLocalization(granularity: TimeGranularity) {
  return {
    locale: "en-IN",
    timeFormatter: (time: ChartTimeLike) => formatIstCrosshair(time, granularity)
  };
}

/** `timeScale` options for createChart/applyOptions: IST tick labels with seconds only for sub-minute bars. */
export function istTimeScaleOptions(granularity: TimeGranularity) {
  return {
    timeVisible: true,
    secondsVisible: granularity === "second",
    tickMarkFormatter: (time: ChartTimeLike, tickMarkType: number) => formatIstTick(time, tickMarkType, granularity)
  };
}
