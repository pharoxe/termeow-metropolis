export function money(value: number | null | undefined, compact = false) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (compact) return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value);
  const digits = value < 0.01 ? 7 : value < 1 ? 5 : 2;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits }).format(value);
}

export function pct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function shortAddress(value?: string | null) {
  return value ? `${value.slice(0, 4)}…${value.slice(-4)}` : "not connected";
}
