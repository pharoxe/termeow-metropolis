import { useEffect, useRef, useState } from "react";

export type Theme = "dark" | "light";

const THEME_KEY = "termeow-theme";
const ACCENT_KEY = "termeow-accent";
type Accent = "purple" | "blue" | "yellow" | "white" | "red";
const ACCENTS: Accent[] = ["purple", "blue", "yellow", "white", "red"];

function preferredAccent(): Accent {
  try { const saved = localStorage.getItem(ACCENT_KEY) as Accent | null; if (saved && ACCENTS.includes(saved)) return saved; } catch { /* default */ }
  return "purple";
}

function preferredTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch { /* use the system preference */ }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const [accent, setAccent] = useState<Accent>(preferredAccent);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f4f2f9" : "#050407");
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private browsing */ }
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.accent = accent;
    try { localStorage.setItem(ACCENT_KEY, accent); } catch { /* private browsing */ }
  }, [accent]);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    addEventListener("pointerdown", close);
    return () => removeEventListener("pointerdown", close);
  }, []);

  const next = theme === "dark" ? "light" : "dark";
  return <div className="theme-control" ref={root}>
    <button className="theme-toggle" type="button" onClick={() => onChange(next)} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      <span className="theme-pixels" aria-hidden="true"><i /><i /><i /><i /></span>
      {next}
    </button>
    <button className="accent-trigger" type="button" aria-label="Choose accent color" aria-expanded={open} onClick={() => setOpen((value) => !value)}>⌄</button>
    {open && <div className="accent-menu" role="menu" aria-label="Accent color">
      {ACCENTS.map((value) => <button key={value} type="button" role="menuitemradio" aria-checked={accent === value} className={`accent-${value}`} onClick={() => { setAccent(value); setOpen(false); }}><i />{value}</button>)}
    </div>}
  </div>;
}

export function useTheme() {
  return useState<Theme>(preferredTheme);
}
