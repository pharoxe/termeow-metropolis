import type {CSSProperties} from "react";
export const TERMINAL_COLORS = {
  "dark": {
    "bg": "#070b09",
    "bg2": "#0c120f",
    "surface": "#0c120f",
    "surface2": "#142019",
    "panel": "#0c120f",
    "panel-hi": "#111b15",
    "hover": "#1a3022",
    "line": "#213428",
    "line2": "#34523e",
    "chart-bg": "#0c120f",
    "text": "#cbded1",
    "text-strong": "#edfff3",
    "muted": "#94ad9d",
    "meta": "#94ad9d",
    "label": "#abc8b5",
    "select": "#39ff88",
    "warning": "#e0c374",
    "warning-bg": "#292416",
    "up": "#42c99a",
    "down": "#ef7885",
    "accent": "#39ff88"
  },
  "light": {
    "bg": "#e5eee7",
    "bg2": "#f6faf7",
    "surface": "#f6faf7",
    "surface2": "#e7f0ea",
    "panel": "#f6faf7",
    "panel-hi": "#edf5ef",
    "hover": "#d9efdf",
    "line": "#cfdfd4",
    "line2": "#abc4b3",
    "chart-bg": "#f6faf7",
    "text": "#263d2f",
    "text-strong": "#142a1c",
    "muted": "#506b5b",
    "meta": "#506b5b",
    "label": "#45634f",
    "select": "#087443",
    "warning": "#715700",
    "warning-bg": "#fff5cf",
    "up": "#0a7a4b",
    "down": "#c02d43",
    "accent": "#087443"
  }
} as const;
export function terminalStyle(theme:"dark"|"light"):CSSProperties{return Object.fromEntries(Object.entries(TERMINAL_COLORS[theme]).map(([key,value])=>[`--${key}`,value])) as CSSProperties;}
export function chartPalette(theme:"dark"|"light"){const c=TERMINAL_COLORS[theme];return {background:c["chart-bg"],text:c.muted,grid:c.line,crosshair:c.label,border:c.line,up:c.up,down:c.down,select:c.select};}
