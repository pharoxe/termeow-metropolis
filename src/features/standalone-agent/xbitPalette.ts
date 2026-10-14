import { useSyncExternalStore } from "react";

/**
 * The agent palette for canvas drawing, read from the --xb-* variables in components/xbit-tokens.css so the persona,
 * boot screen and charts follow the light/dark theme. Cached per theme; reading it every frame is cheap.
 */
export type Rgb = readonly [number, number, number];
export type Palette = Record<"bg" | "deep" | "ink" | "line2" | "mut" | "hi" | "mint" | "down", Rgb>;

const DARK: Palette = {
  bg: [34, 39, 43], deep: [34, 39, 43], ink: [226, 232, 229], line2: [92, 104, 110],
  mut: [156, 168, 166], hi: [168, 230, 207], mint: [196, 181, 253], down: [242, 160, 168]
};

let cached: { key: string; palette: Palette } | null = null;

function themeKey() {
  const explicit = document.documentElement.dataset.theme;
  return explicit || (matchMedia?.("(prefers-color-scheme: light)").matches ? "auto-light" : "auto-dark");
}

export function palette(): Palette {
  if (typeof document === "undefined") return DARK;
  const key = themeKey();
  if (cached?.key === key) return cached.palette;
  const style = getComputedStyle(document.documentElement);
  const read = (name: keyof Palette): Rgb => {
    const parts = style.getPropertyValue(`--xb-${name}`).trim().split(/\s+/).map(Number);
    return parts.length === 3 && parts.every(Number.isFinite) ? [parts[0], parts[1], parts[2]] : DARK[name];
  };
  const next = Object.fromEntries((Object.keys(DARK) as Array<keyof Palette>).map((name) => [name, read(name)])) as Palette;
  cached = { key, palette: next };
  return next;
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", onChange);
  return () => { observer.disconnect(); media.removeEventListener("change", onChange); };
}

/** Re-renders when the theme changes, for canvases (charts) that are built once rather than drawn every frame. */
export function useThemeKey() {
  return useSyncExternalStore(subscribeTheme, themeKey, () => "auto-dark");
}

export const rgba =([red, green, blue]: Rgb, alpha = 1) => `rgba(${red},${green},${blue},${alpha})`;

/** Linear blend from `from` (t = 0) to `to` (t = 1). */
export const mix = (from: Rgb, to: Rgb, t: number): Rgb => [
  Math.round(from[0] + (to[0] - from[0]) * t),
  Math.round(from[1] + (to[1] - from[1]) * t),
  Math.round(from[2] + (to[2] - from[2]) * t)
];
