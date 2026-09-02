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

export function signedMoney(value: number | null | undefined, compact = true) {
  if (value == null || !Number.isFinite(value)) return "—";
  const formatted = money(value, compact);
  return value > 0 && !formatted.startsWith("+") ? `+${formatted}` : formatted;
}

export function axisUsd(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const trim = (n: number) => n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
  if (abs >= 1e12) return `${sign}$${trim(abs / 1e12)}T`;
  if (abs >= 1e9) return `${sign}$${trim(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}$${trim(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}$${trim(abs / 1e3)}K`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  if (abs >= 0.01) return `${sign}$${abs.toFixed(4)}`;
  return `${sign}$${abs.toPrecision(3)}`;
}
