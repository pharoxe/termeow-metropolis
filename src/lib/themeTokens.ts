import type {CSSProperties} from "react";
export const TERMINAL_COLORS = {
  "dark": {
    "bg": "#050407",
    "bg2": "#09080d",
    "surface": "#0b0a10",
    "surface2": "#131119",
    "panel": "#0d0c13",
    "panel-hi": "#13111b",
    "hover": "#1b1726",
    "line": "#1f1c29",
    "line2": "#2f2a3d",
    "chart-bg": "#09080d",
    "text": "#e2deea",
    "text-strong": "#faf8ff",
    "muted": "#8c8799",
    "meta": "#857f93",
    "label": "#a8a2b6",
    "select": "#b9a4ff",
    "warning": "#e3c46b",
    "warning-bg": "#1b170c",
    "up": "#4fd1a5",
    "down": "#f2788a",
    "accent": "#b9a4ff"
  },
  "light": {
    "bg": "#f4f2f9",
    "bg2": "#faf9fd",
    "surface": "#faf9fd",
    "surface2": "#f0edf7",
    "panel": "#ffffff",
    "panel-hi": "#f6f4fb",
    "hover": "#ece7fa",
    "line": "#e0dbea",
    "line2": "#cbc4da",
    "chart-bg": "#fdfcff",
    "text": "#1c1825",
    "text-strong": "#0b0911",
    "muted": "#5f5970",
    "meta": "#6b657c",
    "label": "#4a4459",
    "select": "#7c5cf0",
    "warning": "#715700",
    "warning-bg": "#fff5cf",
    "up": "#0a7a4b",
    "down": "#c02d43",
    "accent": "#7c5cf0"
  }
} as const;
export function terminalStyle(theme:"dark"|"light"):CSSProperties{return Object.fromEntries(Object.entries(TERMINAL_COLORS[theme]).map(([key,value])=>[`--${key}`,value])) as CSSProperties;}
export function chartPalette(theme:"dark"|"light"){const c=TERMINAL_COLORS[theme];return {background:c["chart-bg"],text:c.muted,grid:c.line,crosshair:c.label,border:c.line,up:c.up,down:c.down,select:c.select};}
