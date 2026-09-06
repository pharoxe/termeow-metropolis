/**
 * Micro-price formatting for the candle axis, crosshair label and legend.
 * Sub-0.001 values use subscript-zero notation (0.0₅1234: five zeros then four significant digits)
 * so pump-scale prices never collapse to 0.00000. Pure; tested in node.
 */

export const MICRO_THRESHOLD = 0.001;
export const MICRO_SIGNIFICANT_DIGITS = 4;
export const DEFAULT_MIN_MOVE = 0.00001;
const MIN_MOVE_FLOOR = 1e-12;
const MIN_MOVE_CEIL = 0.01;
const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";

export type CustomPriceFormat = { type: "custom"; formatter: (value: number) => string; minMove: number };

function subscript(count: number): string {
  return String(count).split("").map((digit) => SUBSCRIPT_DIGITS[Number(digit)]).join("");
}

/** "0.0₅1234" for 0.00000123456: zero count as subscript, then MICRO_SIGNIFICANT_DIGITS digits. */
export function formatSubscriptZeros(abs: number): string {
  const [mantissa, exponent] = abs.toExponential(MICRO_SIGNIFICANT_DIGITS - 1).split("e");
  const zeros = -Number(exponent) - 1;
  const digits = mantissa.replace(".", "");
  return zeros > 0 ? `0.0${subscript(zeros)}${digits}` : `0.${digits}`;
}

function decimalsFor(abs: number): number {
  if (abs >= 1000) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.1) return 4;
  if (abs >= 0.01) return 5;
  return 6;
}

/** Subscript-zero notation under MICRO_THRESHOLD, fixed decimals above; "" for null/NaN so axis labels stay blank, "0" for zero. */
export function formatMicroPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  if (value === 0) return "0";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs < MICRO_THRESHOLD) return `${sign}${formatSubscriptZeros(abs)}`;
  const fixed = abs.toFixed(decimalsFor(abs));
  return `${sign}${abs >= 1000 ? Number(fixed).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : fixed}`;
}

/** Axis step for a sample close: one unit in its MICRO_SIGNIFICANT_DIGITS-th significant digit, clamped to [1e-12, 0.01]. */
export function priceMinMove(sampleClose: number | null | undefined): number {
  if (sampleClose == null || !Number.isFinite(sampleClose) || sampleClose === 0) return DEFAULT_MIN_MOVE;
  const exponent = Math.floor(Math.log10(Math.abs(sampleClose)));
  const step = 10 ** (exponent - (MICRO_SIGNIFICANT_DIGITS - 1));
  return Math.min(MIN_MOVE_CEIL, Math.max(MIN_MOVE_FLOOR, step));
}

/** lightweight-charts `priceFormat` for the candle series (also drives the crosshair price label). */
export function pricePriceFormat(sampleClose: number | null | undefined): CustomPriceFormat {
  return { type: "custom", formatter: formatMicroPrice, minMove: priceMinMove(sampleClose) };
}
