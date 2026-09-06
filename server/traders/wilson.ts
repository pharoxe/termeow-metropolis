/** Minimum closed trades before a Wilson bound is reported; below it the answer is null, not 0. */
export const WILSON_MIN_N = 5;

/** Default z for a 95% two-sided interval. */
export const WILSON_Z_95 = 1.96;

/**
 * Lower bound of the Wilson score interval for `wins` successes in `n` trials.
 * Returns null when n < WILSON_MIN_N or the inputs are not a valid count pair, so a
 * wallet with two lucky exits never outranks one with a measured record.
 */
export function wilsonLower(wins: number, n: number, z = WILSON_Z_95): number | null {
  if (!Number.isFinite(wins) || !Number.isFinite(n) || !Number.isFinite(z)) return null;
  if (n < WILSON_MIN_N || wins < 0 || wins > n || z <= 0) return null;
  const p = wins / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / denominator);
}
