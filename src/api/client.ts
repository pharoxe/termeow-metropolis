import type { OnchainMarket, PublicConfig } from "../types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.detail || body?.error || `Request failed (${response.status})`);
  }
  return body as T;
}

export const api = {
  config: () => request<PublicConfig>("/api/config"),
  market: (mint: string, interval = "5m") => request<OnchainMarket>(`/api/onchain/market/${mint}?interval=${interval}`),
  quote: (body: object) => request<Record<string, unknown>>("/api/onchain/quote", {
    method: "POST", body: JSON.stringify(body)
  }),
  transaction: (body: object) => request<Record<string, unknown>>("/api/onchain/transaction", {
    method: "POST", body: JSON.stringify(body)
  }),
  perpsMarkets: () => request<Record<string, unknown>>("/api/perps/markets"),
  perpMarket: (symbol: string) => request<Record<string, unknown>>(`/api/perps/market/${symbol}`),
  perpAccount: () => request<Record<string, unknown>>("/api/perps/account"),
  perpPreview: (body: object) => request<Record<string, unknown>>("/api/perps/preview", {
    method: "POST", body: JSON.stringify(body)
  }),
  perpExecute: (body: object) => request<Record<string, unknown>>("/api/perps/execute", {
    method: "POST", body: JSON.stringify(body)
  })
};

export function deepFind(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key) && child != null) return child;
  }
  for (const child of Object.values(value)) {
    const found = deepFind(child, keys);
    if (found != null) return found;
  }
  return undefined;
}
