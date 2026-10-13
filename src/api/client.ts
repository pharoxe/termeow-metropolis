import type { WalletPortfolio } from "../../shared/portfolio";
import type { AutomationIntent, AutomationRecord, TerminalAgentSnapshot, UserAutomationPreferences } from "../../shared/automation";
import type { PublicConfig } from "../types";
import type { TokenResolution } from "../../shared/tokenIndex";
import type { SmartMoneyNetflow, SmartMoneyTrade, TokenFlowIntelligence } from "../../server/sources/nansen";
import type { PerplSnapshot } from "../../server/sources/perpl";
import type { AlertRule, AlertsResponse, Chain, DiscoverResponse, DiscoverView, DiscoverWindow, FlowCandleInterval, FlowCandlesResponse, SmartBoardResponse, SmartBoardWindow, SmartChainScope, SmartTapeResponse, LaunchesResponse, MarketResponse, SystemHealth, TokenFlowResponse } from "../../shared/wire";

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
  smartTape: (params: { chain?: SmartChainScope; limit?: number } = {}) => {
    const search = new URLSearchParams({ chain: params.chain ?? "all" });
    if (params.limit) search.set("limit", String(params.limit));
    return request<SmartTapeResponse>(`/api/smart/tape?${search.toString()}`);
  },
  smartBoard: (params: { chain?: SmartChainScope; window?: SmartBoardWindow } = {}) =>
    request<SmartBoardResponse>(`/api/smart/board?${new URLSearchParams({ chain: params.chain ?? "all", window: params.window ?? "24h" }).toString()}`),
  smartHandles: (limit = 200) => request<{ source: string; observedAt: number; entries: Array<{ chain: "monad"; wallet: string; handle: string; followers: number | null; profileUrl: string | null; source: string }> }>(`/api/smart/handles?limit=${Math.min(500, Math.max(1, Math.trunc(limit)))}`),
  resolveToken: (query: string, chain?: Chain) => request<TokenResolution>(`/api/tokens/resolve?${new URLSearchParams({ q: query, ...(chain ? { chain } : {}) }).toString()}`),
  tokenLogos: (items: Array<{ chain: Chain; address: string }>) => request<{ logos: Array<{ chain: Chain; address: string; symbol: string | null; imageUrl: string | null }>; observedAt: number; source: string }>("/api/tokens/logos", { method: "POST", body: JSON.stringify({ items }) }),
  /** Alert ring (newest first); `since` = the last observedAt seen, `rule` narrows to one rule. 200 + error/stale on failure. */
  alerts: (params: { chain?: SmartChainScope; since?: number; rule?: AlertRule; limit?: number } = {}) => {
    const search = new URLSearchParams({ chain: params.chain ?? "all" });
    if (params.since != null) search.set("since", String(params.since));
    if (params.rule) search.set("rule", params.rule);
    if (params.limit) search.set("limit", String(params.limit));
    return request<AlertsResponse>(`/api/alerts?${search.toString()}`);
  },
  /** Discovery lists on Monad: trending / movers / new / holders. */
  discover: (chain: Chain, view: DiscoverView, window: DiscoverWindow = "24h") =>
    request<DiscoverResponse>(`/api/discover/${chain}?view=${view}&window=${window}`),
  /** /api/health: snapshot age + Monad RPC endpoint pool; the shape is read defensively (older servers omit both). */
  health: () => request<SystemHealth>("/api/health"),
  /** DexScreener token search narrowed to Monad (candidates, not identity). */
  search: (q: string) => request<{ candidates: Array<{ token: string | null; symbol: string | null; name: string | null; priceUsd: number | null; liquidityUsd: number | null }> }>(`/api/onchain/search?q=${encodeURIComponent(q)}`),
  /** On-chain MON + core assets (WMON/USDC/AUSD) plus any extra token contracts named. */
  monadPortfolio: (wallet: string, tokens: string[] = []) => request<WalletPortfolio>(`/api/onchain/portfolio/${wallet}${tokens.length ? `?tokens=${encodeURIComponent(tokens.join(","))}` : ""}`),
  /** Perpl perps context: mark / oracle / OI / 24h change per market. */
  perps: () => request<PerplSnapshot>("/api/onchain/perps"),
  /** Nansen smart-money netflows + DEX trades on Monad; `configured` false without a server key. */
  smartMoney: (token?: string) => request<{ source: string; configured: boolean; observedAt: number; netflows: SmartMoneyNetflow[]; trades: SmartMoneyTrade[]; error: string | null }>(`/api/onchain/smart-money${token ? `?token=${token}` : ""}`),
  smartMoneyFlows: (token: string, timeframe = "1d") => request<{ source: string; observedAt: number; data: TokenFlowIntelligence | null; error: string | null; configured: boolean }>(`/api/onchain/smart-money/${token}/flows?timeframe=${timeframe}`),
  rpc: async <T>(method: string, params: unknown[]) => {
    const body = await request<{ result?: T; error?: { message?: string } }>("/api/rpc", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    if (body.error) throw new Error(body.error.message || "Monad RPC request failed");
    return body.result as T;
  },
  quote: (body: object) => request<Record<string, unknown>>("/api/onchain/quote", {
    method: "POST", body: JSON.stringify(body)
  }),
  transaction: (body: object) => request<Record<string, unknown>>("/api/onchain/transaction", {
    method: "POST", body: JSON.stringify(body)
  }),
  automations: (token: string) => request<{ automations: AutomationRecord[] }>("/api/automations", { headers: bearer(token) }),
  automationDelegation: (token: string) => request<{ configured: boolean; active: boolean; signerId?: string; policyIds: string[]; walletAddress?: string; allowedContracts: string[]; chainId: number }>("/api/automations/delegation/monad", { headers: bearer(token) }),
  confirmAutomationDelegation: (token: string, body: { walletAddress: string; walletId: string }) =>
    request<{ delegation: { walletAddress: string; enabledAt: number } }>("/api/automations/delegation/monad", { method: "POST", headers: bearer(token), body: JSON.stringify(body) }),
  removeAutomationDelegation: (token: string) => request<{ removed: boolean }>("/api/automations/delegation/monad", { method: "DELETE", headers: bearer(token) }),
  createAutomation: (token: string, body: { intent: AutomationIntent; source: "elevenlabs_voice" | "terminal"; conversationId?: string; context?: TerminalAgentSnapshot }) =>
    request<{ automation: AutomationRecord }>("/api/automations", { method: "POST", headers: bearer(token), body: JSON.stringify(body) }),
  monTransferQuote: (token: string, body: { recipient: string; amount: number; denomination: "usd" | "mon" }) =>
    request<{ quote: { recipient: string; amountMon: string; amountWei: string; amountUsd: number; priceUsd: number; quotedAt: number } }>("/api/automations/transfers/quote", { method: "POST", headers: bearer(token), body: JSON.stringify(body) }),
  updateAutomation: (token: string, id: string, intent: AutomationIntent) => request<{ automation: AutomationRecord }>(`/api/automations/${encodeURIComponent(id)}`, { method: "PATCH", headers: bearer(token), body: JSON.stringify({ intent }) }),
  reviseAutomation: (token: string, id: string, intent: AutomationIntent) => request<{ automation: AutomationRecord }>(`/api/automations/${encodeURIComponent(id)}/revise`, { method: "PATCH", headers: bearer(token), body: JSON.stringify({ intent }) }),
  deleteAutomation: (token: string, id: string) => request<{ removed: boolean }>(`/api/automations/${encodeURIComponent(id)}`, { method: "DELETE", headers: bearer(token) }),
  automationPreferences: (token: string) => request<{ preferences: UserAutomationPreferences }>("/api/automations/preferences/me", { headers: bearer(token) }),
  updateAutomationPreferences: (token: string, body: Partial<Pick<UserAutomationPreferences, "favoriteTraders" | "favoriteTokens" | "linkedWallets" | "defaultAllocationPercent" | "defaultSlippageBps" | "defaultDurationHours">> & { onboardingCompleted?: boolean }) => request<{ preferences: UserAutomationPreferences }>("/api/automations/preferences/me", { method: "PATCH", headers: bearer(token), body: JSON.stringify(body) }),
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
