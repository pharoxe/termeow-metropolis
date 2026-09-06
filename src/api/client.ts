import type { PublicConfig } from "../types";
import type { Chain, FomoBoardResponse, FomoBoardWindow, FomoChainScope, FomoTapeResponse, LaunchesResponse, MarketResponse, TokenFlowResponse } from "../../shared/wire";

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
  market: (chain: Chain, address: string, interval = "5m") => request<MarketResponse>(`/api/market/${chain}/${address}?interval=${encodeURIComponent(interval)}`),
  trades: (pair: string) => request<import("../types").PoolCvd>(`/api/onchain/trades/${pair}`),
  flowToken: (chain: Chain, address: string, interval: string, anchor: TokenFlowResponse["anchor"] = "window") =>
    request<TokenFlowResponse>(`/api/flow/token/${chain}/${address}?interval=${encodeURIComponent(interval)}&anchor=${anchor}`),
  launches: (params: { chain?: "all" | Chain; window?: "1h" | "6h" | "24h"; stocks?: boolean; pad?: string } = {}) => {
    const search = new URLSearchParams({ chain: params.chain ?? "all", window: params.window ?? "24h", stocks: params.stocks ? "1" : "0" });
    if (params.pad) search.set("pad", params.pad);
    return request<LaunchesResponse>(`/api/launches?${search.toString()}`);
  },
  fomoTape: (params: { chain?: FomoChainScope; limit?: number } = {}) => {
    const search = new URLSearchParams({ chain: params.chain ?? "all" });
    if (params.limit) search.set("limit", String(params.limit));
    return request<FomoTapeResponse>(`/api/fomo/tape?${search.toString()}`);
  },
  fomoBoard: (params: { chain?: FomoChainScope; window?: FomoBoardWindow } = {}) =>
    request<FomoBoardResponse>(`/api/fomo/board?${new URLSearchParams({ chain: params.chain ?? "all", window: params.window ?? "24h" }).toString()}`),
  search: (q: string) => request<Record<string, unknown>>(`/api/onchain/search?q=${encodeURIComponent(q)}`),
  trenches: (sort = "hot") => request<Record<string, unknown>>(`/api/onchain/trenches?sort=${encodeURIComponent(sort)}`),
  board: () => request<Record<string, unknown>>("/api/onchain/board"),
  holders: (mint: string) => request<Record<string, unknown>>(`/api/onchain/holders/${mint}`),
  portfolio: (wallet: string) => request<Record<string, unknown>>(`/api/onchain/portfolio/${wallet}`),
  rpc: async <T>(method: string, params: unknown[]) => {
    const body = await request<{ result?: T; error?: { message?: string } }>("/api/rpc", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    if (body.error) throw new Error(body.error.message || "Solana RPC request failed");
    return body.result as T;
  },
  quote: (body: object) => request<Record<string, unknown>>("/api/onchain/quote", {
    method: "POST", body: JSON.stringify(body)
  }),
  transaction: (body: object) => request<Record<string, unknown>>("/api/onchain/transaction", {
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
