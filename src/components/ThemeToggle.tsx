import { useEffect, useState } from "react";

export type Theme = "dark" | "light";

const THEME_KEY = "termeow-theme";

function preferredTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch { /* use the system preference */ }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#eef3ed" : "#080b09");
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private browsing */ }
  }, [theme]);

  const next = theme === "dark" ? "light" : "dark";
  return (
    <button className="theme-toggle" type="button" onClick={() => onChange(next)} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      <span className="theme-pixels" aria-hidden="true"><i /><i /><i /><i /></span>
      {next}
    </button>
  );
}

export function useTheme() {
  return useState<Theme>(preferredTheme);
}
