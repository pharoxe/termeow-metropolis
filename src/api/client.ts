import type { BoardKind, IdentityBoardResponse, IdentityCoverageResponse, TraderIdentity } from "../../shared/identity";
import type { WalletPortfolio } from "../../shared/portfolio";
import type { AutomationIntent, AutomationRecord, TerminalAgentSnapshot } from "../../shared/automation";
import type { PublicConfig } from "../types";
import type { AlertRule, AlertsResponse, Chain, DiscoverResponse, DiscoverView, DiscoverWindow, FlowCandleInterval, FlowCandlesResponse, FomoBoardResponse, FomoBoardWindow, FomoChainScope, FomoTapeResponse, LaunchesResponse, MarketResponse, SystemHealth, TokenFlowResponse } from "../../shared/wire";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(45_000),
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.detail || body?.error || `Request failed (${response.status})`);
  }
  return body as T;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export const api = {
  capturedCandles: (chain: Chain, address: string, interval: FlowCandleInterval) => request<FlowCandlesResponse>(`/api/terminal/${chain}/${address}/candles?interval=${interval}`),
  config: () => request<PublicConfig>("/api/config"),
  market: (chain: Chain, address: string, interval = "5m") => request<MarketResponse>(`/api/market/${chain}/${address}?interval=${encodeURIComponent(interval)}`),
  flowToken: (chain: Chain, address: string, interval: string, anchor: TokenFlowResponse["anchor"] = "window") =>
    request<TokenFlowResponse>(`/api/flow/token/${chain}/${address}?interval=${encodeURIComponent(interval)}&anchor=${anchor}`),
  /** Own-tape candles (priced ring prints only); 200 with `error` when the token is untracked. */
  flowCandles: (chain: Chain, address: string, interval: FlowCandleInterval) =>
    request<FlowCandlesResponse>(`/api/flow/candles/${chain}/${address}?interval=${interval}`),
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
  /** Registry size, the boards read and the CU meter; `account` is the whole key's balance, repolled every 5 min. */
  identityCoverage: () => request<IdentityCoverageResponse>("/api/identity/coverage"),
  /** A stored board snapshot, never a fresh sweep. The server 400s outside 1-100, so `limit` is clamped here. */
  identityBoard: (board: BoardKind, window: string, limit?: number, chain?: Chain) => {
    const rows = limit == null || !Number.isFinite(limit) ? null : Math.min(100, Math.max(1, Math.trunc(limit)));
    const params = new URLSearchParams();
    if (rows != null) params.set("limit", String(rows));
    if (chain) params.set("chain", chain);
    const search = params.size ? `?${params.toString()}` : "";
    return request<IdentityBoardResponse>(`/api/identity/board/${board}/${encodeURIComponent(window)}${search}`);
  },
  identityWallet: (chain: Chain, address: string) => request<{ identity: TraderIdentity | null }>(`/api/identity/wallet/${chain}/${encodeURIComponent(address)}`),
  /** Alert ring (newest first); `since` = the last observedAt seen, `rule` narrows to one rule. 200 + error/stale on failure. */
  alerts: (params: { chain?: FomoChainScope; since?: number; rule?: AlertRule; limit?: number } = {}) => {
    const search = new URLSearchParams({ chain: params.chain ?? "all" });
    if (params.since != null) search.set("since", String(params.since));
    if (params.rule) search.set("rule", params.rule);
    if (params.limit) search.set("limit", String(params.limit));
    return request<AlertsResponse>(`/api/alerts?${search.toString()}`);
  },
  /** R6 discovery lists (Robinhood: trending / movers / new / holders); Solana answers rows [] + error (ClawPump paths serve it). */
  discover: (chain: Chain, view: DiscoverView, window: DiscoverWindow = "24h") =>
    request<DiscoverResponse>(`/api/discover/${chain}?view=${view}&window=${window}`),
  /** /api/health: snapshot age + Robinhood RPC endpoint pool; the shape is read defensively (older servers omit both). */
  health: () => request<SystemHealth>("/api/health"),
  search: (q: string) => request<Record<string, unknown>>(`/api/onchain/search?q=${encodeURIComponent(q)}`),
  trenches: (sort = "hot") => request<Record<string, unknown>>(`/api/onchain/trenches?sort=${encodeURIComponent(sort)}`),
  board: () => request<Record<string, unknown>>("/api/onchain/board"),
  holders: (mint: string) => request<Record<string, unknown>>(`/api/onchain/holders/${mint}`),
  portfolio: (wallet: string) => request<WalletPortfolio>(`/api/onchain/portfolio/${wallet}`),
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
  }),
  automations: (token: string) => request<{ automations: AutomationRecord[] }>("/api/automations", { headers: bearer(token) }),
  automationDelegation: (token: string) => request<{ configured: boolean; active: boolean; signerId?: string; policyIds: string[]; walletAddress?: string; allowedPrograms: string[] }>("/api/automations/delegation/solana", { headers: bearer(token) }),
  confirmAutomationDelegation: (token: string, body: { walletAddress: string; walletId: string }) =>
    request<{ delegation: { walletAddress: string; enabledAt: number } }>("/api/automations/delegation/solana", { method: "POST", headers: bearer(token), body: JSON.stringify(body) }),
  removeAutomationDelegation: (token: string) => request<{ removed: boolean }>("/api/automations/delegation/solana", { method: "DELETE", headers: bearer(token) }),
  createAutomation: (token: string, body: { intent: AutomationIntent; source: "elevenlabs_voice" | "terminal"; conversationId?: string; context?: TerminalAgentSnapshot }) =>
    request<{ automation: AutomationRecord }>("/api/automations", { method: "POST", headers: bearer(token), body: JSON.stringify(body) }),
  approveAutomation: (token: string, id: string) => request<{ automation: AutomationRecord }>(`/api/automations/${encodeURIComponent(id)}/approve`, {
    method: "POST", headers: bearer(token), body: JSON.stringify({ passkeyVerified: true })
  }),
  cancelAutomation: (token: string, id: string) => request<{ automation: AutomationRecord }>(`/api/automations/${encodeURIComponent(id)}/cancel`, {
    method: "POST", headers: bearer(token), body: "{}"
  }),
  reportAutomation: (token: string, id: string, body: { status: "executing" | "completed" | "failed"; transactionHash?: string; failure?: string }) =>
    request<{ automation: AutomationRecord }>(`/api/automations/${encodeURIComponent(id)}/report`, { method: "POST", headers: bearer(token), body: JSON.stringify(body) })
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
