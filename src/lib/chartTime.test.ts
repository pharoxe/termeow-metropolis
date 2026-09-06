import { describe, expect, it } from "vitest";
import {
  IST_OFFSET_MS,
  TICK_MARK,
  formatIst,
  formatIstCrosshair,
  formatIstTick,
  granularityFor,
  istLocalization,
  istParts,
  istTimeScaleOptions,
  parseIntervalMs,
  toMillis,
  toSeconds
} from "./chartTime";

// 2026-09-06 17:54:15 UTC == 2026-09-06 23:24:15 IST
const UTC_MS = Date.UTC(2026, 8, 6, 17, 54, 15);
const UTC_SEC = UTC_MS / 1000;

describe("toSeconds / toMillis", () => {
  it("normalises ms and seconds without assuming a minimum bar size", () => {
    expect(toSeconds(UTC_MS)).toBe(UTC_SEC);
    expect(toSeconds(UTC_SEC)).toBe(UTC_SEC);
    expect(toSeconds(UTC_MS + 999)).toBe(UTC_SEC); // floors sub-second remainders
    expect(toSeconds(UTC_SEC + 5)).toBe(UTC_SEC + 5); // 5-second buckets survive
    expect(toMillis(UTC_SEC)).toBe(UTC_MS);
    expect(toMillis(UTC_MS)).toBe(UTC_MS);
  });
});

describe("parseIntervalMs", () => {
  it("parses desk labels in any case, S through W", () => {
    expect(parseIntervalMs("5S")).toBe(5_000);
    expect(parseIntervalMs("15s")).toBe(15_000);
    expect(parseIntervalMs("1M")).toBe(60_000);
    expect(parseIntervalMs("15m")).toBe(900_000);
    expect(parseIntervalMs("4H")).toBe(14_400_000);
    expect(parseIntervalMs("1D")).toBe(86_400_000);
    expect(parseIntervalMs("1W")).toBe(604_800_000);
  });
  it("rejects malformed labels", () => {
    expect(parseIntervalMs("")).toBeNull();
    expect(parseIntervalMs("0M")).toBeNull();
    expect(parseIntervalMs("M")).toBeNull();
    expect(parseIntervalMs("1X")).toBeNull();
  });
});

describe("granularityFor", () => {
  it("maps bar size to the legend clock precision", () => {
    expect(granularityFor(5_000)).toBe("second");
    expect(granularityFor(15_000)).toBe("second");
    expect(granularityFor(60_000)).toBe("minute");
    expect(granularityFor(900_000)).toBe("minute");
    expect(granularityFor(3_600_000)).toBe("hour");
    expect(granularityFor(86_400_000)).toBe("day");
    expect(granularityFor(null)).toBe("minute");
    expect(granularityFor(0)).toBe("minute");
  });
});

describe("istParts", () => {
  it("shifts by +5:30 and accepts seconds or ms", () => {
    expect(IST_OFFSET_MS).toBe(19_800_000);
    const expected = { year: 2026, month: 9, day: 6, hour: 23, minute: 24, second: 15 };
    expect(istParts(UTC_MS)).toEqual(expected);
    expect(istParts(UTC_SEC)).toEqual(expected);
  });
  it("rolls the calendar day across IST midnight", () => {
    const lateUtc = Date.UTC(2026, 8, 6, 18, 45, 0); // 00:15 IST next day
    expect(istParts(lateUtc)).toMatchObject({ day: 7, hour: 0, minute: 15 });
    const dec31 = Date.UTC(2026, 11, 31, 20, 0, 0); // 01:30 IST Jan 1 2027
    expect(istParts(dec31)).toMatchObject({ year: 2027, month: 1, day: 1, hour: 1, minute: 30 });
  });
});

describe("formatIst", () => {
  it("renders an explicit IST suffix at each granularity", () => {
    expect(formatIst(UTC_MS, "minute")).toBe("06 Sep 2026 23:24 IST");
    expect(formatIst(UTC_MS, "second")).toBe("06 Sep 2026 23:24:15 IST");
    expect(formatIst(UTC_MS, "hour")).toBe("06 Sep 2026 23:24 IST");
    expect(formatIst(UTC_MS, "day")).toBe("06 Sep 2026 IST");
    expect(formatIst(UTC_SEC, "minute", false)).toBe("06 Sep 2026 23:24");
  });
  it("never invents a time for missing input", () => {
    expect(formatIst(null, "minute")).toBe("—");
    expect(formatIst(Number.NaN, "minute")).toBe("—");
  });
});

describe("formatIstCrosshair", () => {
  it("formats UTC seconds, business days and ISO strings in IST", () => {
    expect(formatIstCrosshair(UTC_SEC, "minute")).toBe("06 Sep 23:24");
    expect(formatIstCrosshair(UTC_SEC, "second")).toBe("06 Sep 23:24:15");
    expect(formatIstCrosshair({ year: 2026, month: 9, day: 6 }, "day")).toBe("06 Sep 2026");
    expect(formatIstCrosshair("2026-09-06T17:54:15Z", "minute")).toBe("06 Sep 23:24");
    expect(formatIstCrosshair("not a date", "minute")).toBe("");
  });
});

describe("formatIstTick", () => {
  it("follows TickMarkType and shows seconds for sub-minute bars", () => {
    expect(formatIstTick(UTC_SEC, TICK_MARK.Year, "minute")).toBe("2026");
    expect(formatIstTick(UTC_SEC, TICK_MARK.Month, "minute")).toBe("Sep");
    expect(formatIstTick(UTC_SEC, TICK_MARK.DayOfMonth, "minute")).toBe("6");
    expect(formatIstTick(UTC_SEC, TICK_MARK.Time, "minute")).toBe("23:24");
    expect(formatIstTick(UTC_SEC, TICK_MARK.Time, "second")).toBe("23:24:15");
    expect(formatIstTick(UTC_SEC, TICK_MARK.TimeWithSeconds, "minute")).toBe("23:24:15");
  });
  it("uses IST for the day boundary, not UTC", () => {
    const lateUtc = Date.UTC(2026, 8, 6, 18, 45, 0) / 1000;
    expect(formatIstTick(lateUtc, TICK_MARK.DayOfMonth, "minute")).toBe("7");
  });
});

describe("option builders", () => {
  it("wire the IST formatters into lightweight-charts option shapes", () => {
    const localization = istLocalization("minute");
    expect(localization.locale).toBe("en-IN");
    expect(localization.timeFormatter(UTC_SEC)).toBe("06 Sep 23:24");
    const seconds = istTimeScaleOptions("second");
    expect(seconds.secondsVisible).toBe(true);
    expect(seconds.timeVisible).toBe(true);
    expect(seconds.tickMarkFormatter(UTC_SEC, TICK_MARK.Time)).toBe("23:24:15");
    expect(istTimeScaleOptions("minute").secondsVisible).toBe(false);
  });
});
