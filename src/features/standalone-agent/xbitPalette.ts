/** X Bit Studio "signal" palette (xbit.studio) for canvas drawing; mirrors the --xb-* tokens in agent-xbit.css. */
export const XB = {
  bg: [21, 54, 255],
  deep: [11, 26, 140],
  ink: [242, 237, 225],
  line2: [128, 149, 255],
  mut: [201, 210, 255],
  hi: [255, 214, 10],
  mint: [118, 253, 195],
  down: [255, 143, 163]
} as const;

export type Rgb = readonly [number, number, number];

export const rgba = ([red, green, blue]: Rgb, alpha = 1) => `rgba(${red},${green},${blue},${alpha})`;

/** Linear blend from `from` (t = 0) to `to` (t = 1). */
export const mix = (from: Rgb, to: Rgb, t: number): Rgb => [
  Math.round(from[0] + (to[0] - from[0]) * t),
  Math.round(from[1] + (to[1] - from[1]) * t),
  Math.round(from[2] + (to[2] - from[2]) * t)
];
