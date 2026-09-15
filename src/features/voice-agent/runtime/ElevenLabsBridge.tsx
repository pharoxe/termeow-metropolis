import { ConversationProvider, useConversationClientTool, useConversationControls, useConversationInput, useConversationMode, useConversationStatus } from "@elevenlabs/react";
import { useEffect, useMemo, useRef } from "react";
import type { AgentRuntime } from "./AgentRuntime";
import type { TermeowAgentContext } from "./agentTypes";
import { resolveElevenLabsSession } from "./ElevenLabsRuntime";
import { useAgentStore } from "../store/agentStore";
import { audioReactiveEngine } from "../audio/AudioReactiveEngine";
import { getAccessToken, useWallets as useEvmWallets } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { api } from "../../../api/client";
import type { AutomationIntent } from "../../../../shared/automation";
import { recentRallyStructure } from "../../../lib/chartStructure";
import { filterRecentOrderFlow } from "../../../lib/agentOrderFlow";
import { agentMemoryText, pickAgentGreeting } from "../../../lib/agentMemory";
import { clawpumpAgentTools } from "../../../../shared/clawpumpAgentTools.mjs";

const optionalNumber = (value: unknown) => {
  const number = Number(value);
  return value == null || value === "" || !Number.isFinite(number) ? undefined : number;
};
let activeBillableConversationId: string | null = null;
let pendingTransferDraft: { amount: number; denomination: "sol" | "usd" } | null = null;
type TokenResolution = Awaited<ReturnType<typeof api.resolveToken>>;
const tokenResolutionCache = new Map<string, { at: number; result: Promise<TokenResolution> }>();
const TOKEN_RESOLUTION_TTL_MS = 2 * 60_000;

function resolveTokenFast(query: string, chain?: "solana" | "robinhood") {
  const key = `${chain || "any"}:${query.trim().replace(/^\$+/, "").toLowerCase()}`;
  const cached = tokenResolutionCache.get(key);
  if (cached && Date.now() - cached.at < TOKEN_RESOLUTION_TTL_MS) return cached.result;
  const result = api.resolveToken(query, chain).catch((error) => {
    tokenResolutionCache.delete(key);
    throw error;
  });
  tokenResolutionCache.set(key, { at: Date.now(), result });
  if (tokenResolutionCache.size > 100) tokenResolutionCache.delete(tokenResolutionCache.keys().next().value!);
  return result;
}

const exitConditions = (value: unknown, fallbackSlippageBps: number) => {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 8).map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const allowed = ["take_profit_pct", "stop_loss_pct", "trailing_stop_pct", "market_cap", "custom"] as const;
    const type = allowed.includes(item.type as typeof allowed[number]) ? item.type as typeof allowed[number] : "custom";
    return { id: String(item.id || `exit-${index + 1}`), type, value: optionalNumber(item.value), condition: String(item.condition || ""), sellPercent: Number(item.sell_percent || 100), slippageBps: optionalNumber(item.slippage_bps) ?? fallbackSlippageBps, activateAfter: "entry_confirmed" as const };
  }).filter((item) => item.condition.length >= 3);
};

const compactToolInput = (parameters: Record<string, unknown>) => Object.entries(parameters)
  .filter(([, value]) => value != null && value !== "")
  .slice(0, 5)
  .map(([key, value]) => `${key.replaceAll("_", " ")}: ${typeof value === "string" && value.length > 28 ? `${value.slice(0, 10)}…${value.slice(-6)}` : String(value)}`)
  .join(" · ");

async function resolveMarketTarget(parameters: Record<string, unknown>) {
  const context = useAgentStore.getState().context;
  let chain = parameters.chain === "robinhood" ? "robinhood" as const : parameters.chain === "solana" ? "solana" as const : context.chain;
  let address = String(parameters.token_address || context.token?.address || "").trim();
  let symbol = String(parameters.token_symbol || context.token?.symbol || "").replace(/^\$+/, "").trim() || undefined;
  const query = String(parameters.query || symbol || address || "").trim();
  if ((!address || !chain) && query) {
    const resolution = await resolveTokenFast(query, chain);
    if (!resolution.match) return { error: resolution.ambiguous ? "Ticker is ambiguous. Ask the user to choose from the matches." : "Token is not indexed. Ask for the exact contract address.", matches: resolution.matches };
    chain = resolution.match.chain; address = resolution.match.address; symbol = resolution.match.symbol;
  }
  if (!chain && /^0x[a-fA-F0-9]{40}$/.test(address)) chain = "robinhood";
  if (!chain && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) chain = "solana";
  return chain && address ? { chain, address, symbol } : { error: "Provide a ticker, token name, or contract address." };
}

async function directTokenEvidence(chain: "solana" | "robinhood", address: string, timeframe = "5m") {
  const [market, flow] = await Promise.all([api.market(chain, address, timeframe), api.flowToken(chain, address, timeframe).catch(() => null)]);
  const latest = market.candles.at(-1) || null;
  const structure = recentRallyStructure(market.candles);
  return { market, flow, latest, structure };
}

async function liveTraderMatches(handle: string, chain?: "solana" | "robinhood") {
  if (chain === "solana") return [];
  const directory = await api.fomoHandles(500).catch(() => null);
  const key = handle.replace(/^@/, "").toLowerCase();
  return (directory?.entries || []).filter((row) => row.handle.replace(/^@/, "").toLowerCase() === key).map((row) => ({
    chain: row.chain, wallet: row.wallet, display_name: row.handle, twitter: null, followers: row.followers,
    source: row.source, profile_url: row.profileUrl
  }));
}

function toolSummary(raw: string) {
  try {
    const result = JSON.parse(raw) as Record<string, any>;
    if (result.source === "ClawPump") return result.evidence?.error || `ClawPump ${result.evidence?.tool || "research"} · ${result.observedAt}`;
    if (result.error) return String(result.error);
    if (result.token) return `${result.token.symbol || "TOKEN"} · ${result.token.chain} · indexed ${result.token.source || "local"}`;
    if (result.surface) return `${result.token_symbol || "TOKEN"} ${result.surface.replaceAll("_", " ")} visible`;
    if (result.automation_id) return `Draft ${String(result.automation_id).slice(0, 8)} · awaiting confirmation`;
    if (Array.isArray(result.automations)) return `${result.automations.length} automation records`;
    return result.message || (result.ok ? "Evidence returned" : "No result");
  } catch { return raw.slice(0, 120); }
}

function compactFlowEvidence(flow: Awaited<ReturnType<typeof api.flowToken>> | null) {
  if (!flow) return { availability: "warming", windows: null, large_prints: [], tape: [], fomo_fills: [], stale: true };
  const tape = flow.tape?.slice(0, 20) || [];
  const hasEvidence = tape.length > 0 || Boolean(flow.windows && Object.values(flow.windows).some(Boolean)) || Boolean(flow.largePrints?.length);
  return {
    availability: hasEvidence ? "available" : "warming", windows: flow.windows, large_prints: flow.largePrints || [], tape,
    fomo_fills: flow.fomo?.fills.slice(0, 12) || [], feed_health: flow.feedHealth, stale: flow.stale,
    provider_note: !hasEvidence && flow.error ? "One upstream source is backing off; local/RPC capture is still warming." : undefined
  };
}

function ClawpumpTool({ name }: { name: string }) {
  const handler = useMemo(() => trackedTool(name, async (args) => {
    const token = await getAccessToken();
    if (!token) return JSON.stringify({ ok: false, error: "Log in to use research tools." });
    const response = await fetch("/api/agent/tools/clawpump", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ tool: name, args }), signal: AbortSignal.timeout(20_000) });
    const body = await response.json();
    return JSON.stringify({ ...body, ok: response.ok && body.evidence?.ok !== false });
  }), [name]);
  useConversationClientTool(name, handler);
  return null;
}

function trackedTool(name: string, handler: (parameters: Record<string, unknown>) => Promise<string>) {
  return async (parameters: Record<string, unknown> = {}) => {
    const id = useAgentStore.getState().beginTool(name, compactToolInput(parameters));
    try {
      const result = await handler(parameters);
      let ok = true;
      try { ok = JSON.parse(result)?.ok !== false; } catch { /* non-JSON tools still complete */ }
      useAgentStore.getState().finishTool(id, ok ? "complete" : "failed", toolSummary(result));
      return result;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      useAgentStore.getState().finishTool(id, "failed", message);
      return JSON.stringify({ ok: false, error: message });
    }
  };
}

interface Props {
  onRuntime(runtime: AgentRuntime | null): void;
  initialContext: TermeowAgentContext;
}

function ControlsBridge({ onRuntime, initialContext }: Props) {
  const controls = useConversationControls();
  const input = useConversationInput();
  const connection = useConversationStatus();
  const mode = useConversationMode();
  const conversationId = useAgentStore((state) => state.conversationId);
  const desiredVolume = useRef(0.72);

  const runtime = useMemo<AgentRuntime>(() => ({
    connect: async (sessionMode = "voice") => {
      if (useAgentStore.getState().conversationId) {
        controls.endSession();
        for (let attempt = 0; attempt < 40 && useAgentStore.getState().conversationId; attempt += 1)
          await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const session = await resolveElevenLabsSession();
      const greeting = pickAgentGreeting();
      const token = await getAccessToken().catch(() => null);
      const preferences = token ? await api.automationPreferences(token).then((result) => result.preferences).catch(() => undefined) : undefined;
      useAgentStore.getState().setSessionMode(sessionMode);
      await Promise.resolve(controls.startSession({
        ...session,
        textOnly: sessionMode === "text",
        overrides: { conversation: { textOnly: sessionMode === "text" } },
        userId: preferences?.userId,
        dynamicVariables: { termeow_greeting: greeting, termeow_user_memory: agentMemoryText(preferences) }
      }));
    },
    disconnect: () => { controls.endSession(); useAgentStore.getState().resetSession(); },
    sendMessage: (text) => {
      try { controls.sendUserMessage(text); }
      catch (reason) { useAgentStore.getState().setStatus("error", reason instanceof Error ? reason.message : String(reason)); }
    },
    sendContext: (next) => {
      if (useAgentStore.getState().conversationId) {
        try { controls.sendContextualUpdate(`Termeow view context: ${JSON.stringify(next)}`); }
        catch { /* A disconnect can clear the SDK conversation before store callbacks settle. */ }
      }
    },
    mute: () => { try { input.setMuted(true); useAgentStore.getState().setMuted(true); } catch { /* Session has ended. */ } },
    unmute: () => { try { input.setMuted(false); useAgentStore.getState().setMuted(false); } catch { /* Session has ended. */ } },
    setVolume: (volume) => {
      desiredVolume.current = volume;
      if (useAgentStore.getState().conversationId) {
        try { controls.setVolume({ volume }); }
        catch { /* Retain the desired level for the next live session. */ }
      }
    }
  }), [controls, input]);

  useEffect(() => { onRuntime(runtime); return () => onRuntime(null); }, [onRuntime, runtime]);
  useEffect(() => { audioReactiveEngine.bind(controls); }, [controls]);
  useEffect(() => {
    if (connection.status === "connecting") useAgentStore.getState().setStatus("connecting");
    else if (connection.status === "error") useAgentStore.getState().setStatus("error", connection.message || "VOICE CONNECTION FAILED");
    else if (connection.status === "connected") {
      const textSession = useAgentStore.getState().sessionMode === "text";
      useAgentStore.getState().setStatus(mode.isSpeaking ? "speaking" : textSession ? "idle" : "listening");
      try { controls.setVolume({ volume: desiredVolume.current }); }
      catch { /* The connected status may briefly precede the SDK conversation ref. */ }
      if (!textSession) audioReactiveEngine.start(() => useAgentStore.getState().status === "speaking");
      if (conversationId) runtime.sendContext(initialContext);
    } else {
      audioReactiveEngine.stop();
      if (useAgentStore.getState().conversationId) useAgentStore.getState().resetSession();
    }
    return () => audioReactiveEngine.stop();
  }, [connection.message, connection.status, conversationId, initialContext, mode.isSpeaking, runtime]);
  return null;
}

function ClientToolsBridge() {
  const { wallets: solanaWallets } = useSolanaWallets();
  const { wallets: evmWallets } = useEvmWallets();
  const solanaAddress = solanaWallets[0]?.address;
  const evmAddress = evmWallets[0]?.address;
  const clientTools = useMemo(() => ({
    read_terminal_state: trackedTool("read_terminal_state", async () => {
      const connected = Boolean(await getAccessToken().catch(() => null));
      const terminal = useAgentStore.getState().context;
      if (!terminal.chain || !terminal.token?.address) return JSON.stringify({ ok: true, warning: "No token is focused yet. Resolve a ticker or address first.", terminal: { ...terminal, wallet: { ...terminal.wallet, connected } } });
      try {
        const evidence = await directTokenEvidence(terminal.chain, terminal.token.address, terminal.chart?.timeframe || "5m");
        const direct = { ...terminal, chart: { ...terminal.chart, timeframe: terminal.chart?.timeframe || evidence.market.interval, unit: terminal.chart?.unit || "price", scale: terminal.chart?.scale || "linear", priceUsd: evidence.market.priceUsd, marketCapUsd: evidence.market.marketCapUsd, change24Pct: evidence.market.change24Pct, latestCandle: evidence.latest, loadedBars: evidence.market.candles.length, structure: { recentRally: evidence.structure, calculation: "visible-loaded-bars" as const } }, observedAt: evidence.market.observedAt, wallet: { ...terminal.wallet, connected } };
        return JSON.stringify({ ok: true, source: "direct_chain_and_market_apis", warning: "Point-in-time evidence; refresh the route before execution.", terminal: direct, market: { liquidity_usd: evidence.market.liquidityUsd, volume_24h_usd: evidence.market.volume24Usd, source: evidence.market.source, stale: evidence.market.stale }, flow: compactFlowEvidence(evidence.flow) });
      } catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason), terminal }); }
    }),
    resolve_trader_handle: trackedTool("resolve_trader_handle", async (parameters: Record<string, unknown>) => {
      const handle = String(parameters.handle || "").replace(/^@/, "").trim();
      if (!handle) return JSON.stringify({ ok: false, error: "Provide a Fomo handle." });
      try {
        const result = await api.identityHandle(handle);
        const chain = parameters.chain === "solana" || parameters.chain === "robinhood" ? parameters.chain : undefined;
        const stored = chain ? result.addresses.filter((item) => item.chain === chain) : result.addresses;
        const addresses = stored.length ? stored.map((item) => ({ chain: item.chain, wallet: item.wallet, display_name: item.displayName, twitter: item.twitter, followers: item.followers, source: item.source })) : await liveTraderMatches(handle, chain);
        if (addresses.length !== 1) useAgentStore.getState().setLeftWidget({ type: "handles", query: handle });
        return JSON.stringify({ ok: addresses.length > 0, handle, indexed: true, addresses, picker_visible: addresses.length !== 1, error: addresses.length ? undefined : "No exact indexed wallet matches. Ask the user to choose from the visible handle directory or provide an address; do not guess." });
      } catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }); }
    }),
    analyze_token: trackedTool("analyze_token", async (parameters: Record<string, unknown>) => {
      const target = await resolveMarketTarget(parameters);
      if ("error" in target) return JSON.stringify({ ok: false, ...target });
      const timeframe = String(parameters.timeframe || "5m");
      const evidence = await directTokenEvidence(target.chain, target.address, timeframe);
      useAgentStore.getState().setContext({ route: "/agent", chain: target.chain, token: { address: target.address, symbol: evidence.market.instrument.symbol || target.symbol, name: evidence.market.instrument.name, logoUrl: evidence.market.instrument.image || undefined }, chart: { timeframe, unit: "price", scale: "linear", priceUsd: evidence.market.priceUsd, marketCapUsd: evidence.market.marketCapUsd, change24Pct: evidence.market.change24Pct, latestCandle: evidence.latest, loadedBars: evidence.market.candles.length, structure: { recentRally: evidence.structure, calculation: "visible-loaded-bars" } }, observedAt: evidence.market.observedAt });
      return JSON.stringify({ ok: true, source: "direct_chain_and_market_apis", token: { chain: target.chain, address: target.address, symbol: evidence.market.instrument.symbol || target.symbol, name: evidence.market.instrument.name }, market: { price_usd: evidence.market.priceUsd, market_cap_usd: evidence.market.marketCapUsd, liquidity_usd: evidence.market.liquidityUsd, volume_24h_usd: evidence.market.volume24Usd, change_24h_pct: evidence.market.change24Pct, candles: evidence.market.candles.length, source: evidence.market.source, stale: evidence.market.stale }, structure: evidence.structure, flow: compactFlowEvidence(evidence.flow) });
    }),
    inspect_large_orders: trackedTool("inspect_large_orders", async (parameters: Record<string, unknown>) => {
      const target = await resolveMarketTarget(parameters);
      if ("error" in target) return JSON.stringify({ ok: false, ...target });
      const windowMinutes = Math.min(240, Math.max(1, Math.round(optionalNumber(parameters.window_minutes) ?? 15)));
      const minUsd = Math.max(1_000, optionalNumber(parameters.min_usd) ?? 1_000);
      const side = parameters.side === "buy" || parameters.side === "sell" ? parameters.side : undefined;
      const flow = await api.flowToken(target.chain, target.address, "1m");
      const orders = filterRecentOrderFlow(flow.tape || [], { now: Date.now(), windowMinutes, minUsd, side }).slice(0, 30);
      useAgentStore.getState().setHudWindow({ type: "order_flow", chain: target.chain, tokenAddress: target.address, tokenSymbol: target.symbol, windowMinutes, minUsd, side, requestedAt: Date.now() });
      return JSON.stringify({ ok: true, surface: "order_flow", source: flow.source, token: { chain: target.chain, address: target.address, symbol: target.symbol }, filters: { window_minutes: windowMinutes, min_usd: minUsd, side: side || "both" }, orders, count: orders.length, feed_health: flow.feedHealth, stale: flow.stale, error: flow.error });
    }),
    analyze_wallet: trackedTool("analyze_wallet", async (parameters: Record<string, unknown>) => {
      const address = String(parameters.wallet_address || "").trim();
      const chain = parameters.chain === "robinhood" ? "robinhood" as const : parameters.chain === "solana" ? "solana" as const : /^0x[a-fA-F0-9]{40}$/.test(address) ? "robinhood" as const : "solana" as const;
      if (!address) return JSON.stringify({ ok: false, error: "Provide the wallet address." });
      const [identity, portfolio, tape, activity] = await Promise.all([api.identityWallet(chain, address).then((result) => result.identity).catch(() => null), chain === "solana" ? api.portfolio(address).catch(() => null) : api.robinhoodPortfolio(address).catch(() => null), api.fomoTape({ chain, limit: 200 }).catch(() => null), chain === "solana" ? api.walletActivity("solana", address, optionalNumber(parameters.limit) ?? 20).catch(() => null) : Promise.resolve(null)]);
      const recent = (tape?.fills || []).filter((fill) => fill.trader.address.toLowerCase() === address.toLowerCase()).slice(0, 30);
      if (!identity) useAgentStore.getState().setLeftWidget({ type: "handles" });
      return JSON.stringify({ ok: true, source: "direct_chain_rpc_portfolio_and_local_fomo_gateway", chain, wallet: address, identity, portfolio, recent_orders: recent, recent_activity: activity?.items || [], activity_partial: activity?.partial, attribution_warning: identity ? undefined : "No indexed identity is attached; do not infer a person from this address." });
    }),
    analyze_my_wallet: trackedTool("analyze_my_wallet", async (parameters: Record<string, unknown>) => {
      const token = await getAccessToken();
      if (!token) return JSON.stringify({ ok: false, error: "The user must log in." });
      const preferences = (await api.automationPreferences(token)).preferences;
      const requested = String(parameters.chain || "all").toLowerCase();
      const targets = [
        ...(solanaAddress && requested !== "robinhood" ? [{ chain: "solana" as const, address: solanaAddress, role: "connected" }] : []),
        ...(evmAddress && requested !== "solana" ? [{ chain: "robinhood" as const, address: evmAddress, role: "connected" }] : []),
        ...(preferences.linkedWallets || []).filter((wallet) => requested === "all" || wallet.chain === requested).map((wallet) => ({ chain: wallet.chain, address: wallet.address, role: "linked" }))
      ].slice(0, 12);
      if (!targets.length) return JSON.stringify({ ok: false, error: "No connected or linked wallet is available for that chain." });
      const wallets = await Promise.all(targets.map(async (target) => {
        const [portfolio, activity] = await Promise.all([
          target.chain === "solana" ? api.portfolio(target.address).catch(() => null) : api.robinhoodPortfolio(target.address).catch(() => null),
          target.chain === "solana" ? api.walletActivity("solana", target.address, optionalNumber(parameters.limit) ?? 20).catch(() => null) : Promise.resolve(null)
        ]);
        return { ...target, portfolio, recent_activity: activity?.items || [], activity_partial: activity?.partial };
      }));
      return JSON.stringify({ ok: true, source: "connected_and_linked_wallet_chain_analysis", wallets });
    }),
    show_handle_picker: trackedTool("show_handle_picker", async (parameters: Record<string, unknown>) => {
      useAgentStore.getState().setLeftWidget({ type: "handles", query: String(parameters.query || "").replace(/^@/, "") });
      return JSON.stringify({ ok: true, surface: "tracked_handle_picker", status: "visible" });
    }),
    resolve_token: trackedTool("resolve_token", async (parameters: Record<string, unknown>) => {
      const query = String(parameters.query || parameters.token_symbol || parameters.token_address || "").trim();
      const chain = parameters.chain === "solana" || parameters.chain === "robinhood" ? parameters.chain : undefined;
      if (!query) return JSON.stringify({ ok: false, error: "Provide a ticker, token name, or contract address." });
      try {
        const result = await resolveTokenFast(query, chain);
        if (!result.match && result.matches.length) useAgentStore.getState().setLeftWidget({ type: "tokens", query });
        return JSON.stringify({
          ok: Boolean(result.match), indexed: result.indexed, ambiguous: result.ambiguous,
          token: result.match ? { chain: result.match.chain, address: result.match.address, symbol: result.match.symbol, name: result.match.name, source: result.match.source, verified: result.match.verified, verification_source: result.match.verificationSource } : undefined,
          matches: result.matches.map((item) => ({ chain: item.chain, address: item.address, symbol: item.symbol, name: item.name, source: item.source, verified: item.verified })),
          error: result.match ? undefined : result.ambiguous ? "Ticker is ambiguous. Ask the user to choose from the token panel." : result.matches.length ? "No exact token match. Ask the user to choose a nearby indexed token from the token panel." : "No indexed token matches. Ask for the contract address; do not guess."
        });
      } catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }); }
    }),
    read_automation_preferences: trackedTool("read_automation_preferences", async () => {
      try { const token = await getAccessToken(); if (!token) return JSON.stringify({ ok: false, error: "The user must log in." }); return JSON.stringify({ ok: true, ...(await api.automationPreferences(token)) }); }
      catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }); }
    }),
    read_user_memory: trackedTool("read_user_memory", async () => {
      try {
        const token = await getAccessToken();
        if (!token) return JSON.stringify({ ok: false, error: "The user must log in." });
        const result = await api.automationPreferences(token);
        return JSON.stringify({ ok: true, memory: agentMemoryText(result.preferences) });
      } catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }); }
    }),
    update_automation_preferences: trackedTool("update_automation_preferences", async (parameters: Record<string, unknown>) => {
      try {
        const token = await getAccessToken(); if (!token) return JSON.stringify({ ok: false, error: "The user must log in." });
        const body = { defaultAllocationPercent: optionalNumber(parameters.default_allocation_percent), defaultSlippageBps: optionalNumber(parameters.default_slippage_bps), defaultDurationHours: optionalNumber(parameters.default_duration_hours) };
        return JSON.stringify({ ok: true, ...(await api.updateAutomationPreferences(token, body)) });
      } catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }); }
    }),
    propose_swap: trackedTool("propose_swap", async (parameters: Record<string, unknown>) => {
      const context = useAgentStore.getState().context;
      const chain = parameters.chain === "robinhood" ? "robinhood" : parameters.chain === "solana" ? "solana" : context.chain;
      const tokenAddress = String(parameters.token_address || context.token?.address || "");
      if (!chain || !tokenAddress) return JSON.stringify({ ok: false, error: "Select a token chart first." });
      const amountMode = parameters.amount_mode === "fixed" ? "fixed" : "wallet_percent";
      const allocationPercent = Number(parameters.allocation_percent);
      const intent: AutomationIntent = {
        kind: "swap", chain, tokenAddress, tokenSymbol: String(parameters.token_symbol || context.token?.symbol || "TOKEN"),
        tokenName: context.token?.name, tokenLogoUrl: context.token?.logoUrl,
        side: parameters.side === "sell" ? "sell" : "buy", router: chain === "robinhood" ? "0x" : parameters.router === "0x" ? "0x" : "jupiter",
        amountMode, amount: amountMode === "fixed" ? String(parameters.amount || "") : undefined,
        allocationPercent: amountMode === "wallet_percent" ? allocationPercent : undefined,
        description: String(parameters.description || `${parameters.side === "sell" ? "Sell" : "Buy"} ${context.token?.symbol || tokenAddress}`)
      };
      try {
        const token = await getAccessToken();
        if (!token) return JSON.stringify({ ok: false, error: "The user must log in before a swap can be proposed." });
        const result = await api.createAutomation(token, { intent, source: "elevenlabs_voice", conversationId: useAgentStore.getState().conversationId, context });
        useAgentStore.getState().setPendingApproval(result.automation);
        if (window.location.pathname !== "/agent") useAgentStore.getState().setOverlayMode("expanded");
        return JSON.stringify({ ok: true, automation_id: result.automation.id, status: "pending_passkey_confirmation", message: "The proposal is visible. Ask the user to review it and press CONFIRM WITH PASSKEY. Do not claim it executed." });
      } catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }); }
    }),
    propose_transfer: trackedTool("propose_transfer", async (parameters: Record<string, unknown>) => {
      const recipient = String(parameters.recipient_address || parameters.wallet_address || parameters.destination_address || "").trim();
      const requestedAmount = optionalNumber(parameters.amount);
      const requestedDenomination = String(parameters.denomination || "usd").toLowerCase() === "sol" ? "sol" as const : "usd" as const;
      const amount = requestedAmount ?? pendingTransferDraft?.amount;
      const denomination = requestedAmount == null && pendingTransferDraft ? pendingTransferDraft.denomination : requestedDenomination;
      if (requestedAmount && requestedAmount > 0) pendingTransferDraft = { amount: requestedAmount, denomination: requestedDenomination };
      if (!recipient) return JSON.stringify({
        ok: false,
        status: "needs_recipient",
        missing_fields: ["recipient_address"],
        next_action: "Ask one brief question for the exact Solana wallet address, then call propose_transfer again using the address from the user's reply.",
        error: "The exact recipient Solana wallet address is required."
      });
      if (!amount || amount <= 0) return JSON.stringify({ ok: false, error: "Provide a positive transfer amount." });
      try {
        const token = await getAccessToken();
        if (!token) return JSON.stringify({ ok: false, error: "The user must log in before a transfer can be proposed." });
        const { quote } = await api.solanaTransferQuote(token, { recipient, amount, denomination });
        const intent: AutomationIntent = {
          kind: "transfer", chain: "solana", recipientAddress: quote.recipient,
          transferAmountSol: quote.amountSol, transferAmountUsd: quote.amountUsd,
          transferPriceUsd: quote.priceUsd, transferQuotedAt: quote.quotedAt,
          description: denomination === "usd"
            ? `Send ${quote.amountSol} SOL (quoted at $${amount.toFixed(2)}) to the recipient wallet`
            : `Send ${quote.amountSol} SOL (about $${quote.amountUsd.toFixed(2)}) to the recipient wallet`
        };
        const context = useAgentStore.getState().context;
        const result = await api.createAutomation(token, { intent, source: "elevenlabs_voice", conversationId: useAgentStore.getState().conversationId, context });
        pendingTransferDraft = null;
        useAgentStore.getState().setPendingApproval(result.automation);
        if (window.location.pathname !== "/agent") useAgentStore.getState().setOverlayMode("expanded");
        return JSON.stringify({ ok: true, transaction_id: result.automation.id, status: "pending_passkey_confirmation", exact_sol: quote.amountSol, usd_at_quote: quote.amountUsd, message: "Draft ready—review the recipient and confirm." });
      } catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }); }
    }),
    propose_automation: trackedTool("propose_automation", async (parameters: Record<string, unknown>) => {
      const context = useAgentStore.getState().context;
      const token = await getAccessToken();
      if (!token) return JSON.stringify({ ok: false, error: "The user must log in before an automation can be proposed." });
      const preferencesPromise = api.automationPreferences(token).then((result) => result.preferences).catch(() => undefined);
      let chain = parameters.chain === "robinhood" ? "robinhood" as const : parameters.chain === "solana" ? "solana" as const : context.chain;
      const requestedHandle = String(parameters.tracked_wallet_username || "").replace(/^@/, "").trim();
      const trackedXAccount = String(parameters.tracked_x_account || "").replace(/^@/, "").trim();
      let trackedWallet = String(parameters.target_address || "").trim();
      let identity = trackedWallet && chain ? await api.identityWallet(chain, trackedWallet).then(result => result.identity).catch(() => null) : null;
      if (!trackedWallet && requestedHandle) {
        const indexed = await api.identityHandle(requestedHandle).then(result => result.addresses).catch(() => []);
        const filtered = chain ? indexed.filter((item) => item.chain === chain) : indexed;
        const matches = filtered.length ? filtered : await liveTraderMatches(requestedHandle, chain);
        if (matches.length !== 1) { useAgentStore.getState().setLeftWidget({ type: "handles", query: requestedHandle }); return JSON.stringify({ ok: false, error: matches.length ? `Multiple wallets match @${requestedHandle}; choose one in the handle panel.` : `No indexed wallet matches @${requestedHandle}; choose a handle or provide the address.`, matches: matches.map((item) => item.wallet) }); }
        chain = matches[0].chain; identity = matches[0] as typeof identity; trackedWallet = matches[0].wallet;
      }
      let tokenAddress = String(parameters.token_address || context.token?.address || "").trim() || undefined;
      const requestedSymbol = String(parameters.token_symbol || context.token?.symbol || "").replace(/^\$+/, "").trim();
      if (!tokenAddress && requestedSymbol) {
        const resolution = await resolveTokenFast(requestedSymbol, chain).catch(() => null);
        if (resolution?.match) { chain = resolution.match.chain; tokenAddress = resolution.match.address; }
        else if (resolution?.matches.length) { useAgentStore.getState().setLeftWidget({ type: "tokens", query: requestedSymbol }); return JSON.stringify({ ok: false, error: "Choose the intended token from the indexed token panel.", matches: resolution.matches }); }
      }
      if (!chain) return JSON.stringify({ ok: false, error: "Choose Solana or Robinhood." });
      if (!trackedWallet && !tokenAddress && !trackedXAccount) return JSON.stringify({ ok: false, error: "Provide a tracked handle/address, an X account, or select a token." });
      const preferences = await preferencesPromise;
      const slippageBps = Math.round(optionalNumber(parameters.slippage_bps) ?? preferences?.defaultSlippageBps ?? 50);
      const allocationPercent = optionalNumber(parameters.allocation_percent) ?? preferences?.defaultAllocationPercent ?? 10;
      const durationHours = optionalNumber(parameters.duration_hours) ?? preferences?.defaultDurationHours ?? 24;
      const intent: AutomationIntent = {
        kind: parameters.strategy === "conditional_swap" ? "conditional_swap" : parameters.strategy === "monitor_deployer" ? "monitor_deployer" : parameters.strategy === "monitor_x_launch" ? "monitor_x_launch" : "monitor_wallet", chain, tokenAddress,
        tokenSymbol: String(parameters.token_symbol || context.token?.symbol || (tokenAddress ? "TOKEN" : "ANY")), tokenName: context.token?.name,
        tokenLogoUrl: context.token?.logoUrl, trackedWallet: trackedWallet || undefined,
        trackedWalletUsername: requestedHandle || identity?.handle || undefined,
        trackedXAccount: trackedXAccount || undefined,
        side: parameters.side === "sell" ? "sell" : "buy",
        router: chain === "robinhood" ? "0x" : "jupiter", amountMode: "wallet_percent", allocationPercent,
        durationHours, marketCapMinUsd: optionalNumber(parameters.market_cap_min_usd),
        marketCapMaxUsd: optionalNumber(parameters.market_cap_max_usd), entryPriceTolerancePct: optionalNumber(parameters.entry_price_tolerance_percent), slippageBps,
        condition: String(parameters.condition || ""), exitConditions: exitConditions(parameters.exit_conditions, slippageBps),
        description: String(parameters.description || "Voice-created monitored trading strategy")
      };
      try {
        const result = await api.createAutomation(token, { intent, source: "elevenlabs_voice", conversationId: useAgentStore.getState().conversationId, context });
        useAgentStore.getState().setPendingApproval(result.automation);
        if (window.location.pathname !== "/agent") useAgentStore.getState().setOverlayMode("expanded");
        return JSON.stringify({ ok: true, automation_id: result.automation.id, status: "pending_passkey_confirmation", message: "Draft ready—review and confirm." });
      } catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }); }
    }),
    list_automations: trackedTool("list_automations", async () => {
      try {
        const token = await getAccessToken();
        if (!token) return JSON.stringify({ ok: false, error: "The user must log in." });
        const result = await api.automations(token);
        return JSON.stringify({ ok: true, automations: result.automations.slice(0, 20).map((item) => ({ id: item.id, status: item.status, description: item.intent.description, chain: item.intent.chain, kind: item.intent.kind, created_at: item.createdAt })) });
      } catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }); }
    }),
    open_market_hud: trackedTool("open_market_hud", async (parameters: Record<string, unknown>) => {
      const context = useAgentStore.getState().context;
      let chain = parameters.chain === "robinhood" ? "robinhood" as const : parameters.chain === "solana" ? "solana" as const : context.chain;
      let tokenAddress = String(parameters.token_address || context.token?.address || "").trim();
      let tokenSymbol = String(parameters.token_symbol || context.token?.symbol || "").replace(/^\$+/, "").trim() || undefined;
      const query = String(parameters.query || tokenSymbol || "").trim();
      const requested = String(parameters.timeframe || "5m").toLowerCase();
      const timeframe = ["1m", "5m", "15m", "1h", "4h", "1d"].includes(requested) ? requested : "5m";
      if (!tokenAddress && query) {
        const resolution = await resolveTokenFast(query, chain).catch(() => null);
        if (!resolution?.match) { useAgentStore.getState().setLeftWidget({ type: "tokens", query }); return JSON.stringify({
          ok: false, indexed: Boolean(resolution?.indexed), ambiguous: Boolean(resolution?.ambiguous),
          matches: resolution?.matches.map((item) => ({ chain: item.chain, address: item.address, symbol: item.symbol, name: item.name, verified: item.verified })) ?? [],
          error: resolution?.matches.length ? "Show the indexed token picker and ask the user to choose." : "Ticker is not indexed. Ask for the contract address; do not guess."
        }); }
        chain = resolution.match.chain;
        tokenAddress = resolution.match.address;
        tokenSymbol = resolution.match.symbol;
      }
      if (!chain && /^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) chain = "robinhood";
      if (!chain && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenAddress)) chain = "solana";
      if (!chain || !tokenAddress) return JSON.stringify({ ok: false, error: "Provide a ticker, token name, or contract address to open the market HUD." });
      useAgentStore.getState().setContext({ ...context, route: "/agent", chain, token: { address: tokenAddress, symbol: tokenSymbol || context.token?.symbol, name: context.token?.name, logoUrl: context.token?.logoUrl }, chart: { ...context.chart, timeframe, unit: context.chart?.unit || "price", scale: context.chart?.scale || "linear" }, observedAt: Date.now() });
      useAgentStore.getState().setHudWindow({ type: "market_chart", chain, tokenAddress, tokenSymbol, timeframe, requestedAt: Date.now() });
      return JSON.stringify({ ok: true, surface: "market_chart", status: "visible", chain, token_address: tokenAddress, token_symbol: tokenSymbol, message: "Chart open." });
    }),
    dismiss_agent_ui: trackedTool("dismiss_agent_ui", async () => {
      useAgentStore.getState().setHudWindow();
      return JSON.stringify({ ok: true, status: "dismissed" });
    })
  }), [evmAddress, solanaAddress]);

  // Register through the SDK's live registry instead of relying on provider option merging.
  // This makes every handler available before startSession and keeps it attached for the full call.
  useConversationClientTool("read_terminal_state", clientTools.read_terminal_state);
  useConversationClientTool("resolve_trader_handle", clientTools.resolve_trader_handle);
  useConversationClientTool("resolve_token", clientTools.resolve_token);
  useConversationClientTool("analyze_token", clientTools.analyze_token);
  useConversationClientTool("inspect_large_orders", clientTools.inspect_large_orders);
  useConversationClientTool("analyze_wallet", clientTools.analyze_wallet);
  useConversationClientTool("analyze_my_wallet", clientTools.analyze_my_wallet);
  useConversationClientTool("show_handle_picker", clientTools.show_handle_picker);
  useConversationClientTool("read_automation_preferences", clientTools.read_automation_preferences);
  useConversationClientTool("read_user_memory", clientTools.read_user_memory);
  useConversationClientTool("update_automation_preferences", clientTools.update_automation_preferences);
  useConversationClientTool("propose_swap", clientTools.propose_swap);
  useConversationClientTool("propose_transfer", clientTools.propose_transfer);
  useConversationClientTool("propose_automation", clientTools.propose_automation);
  useConversationClientTool("list_automations", clientTools.list_automations);
  useConversationClientTool("open_market_hud", clientTools.open_market_hud);
  useConversationClientTool("dismiss_agent_ui", clientTools.dismiss_agent_ui);
  return null;
}

export default function ElevenLabsBridge(props: Props) {
  return <ConversationProvider
    onConnect={({ conversationId }) => { activeBillableConversationId = conversationId; useAgentStore.getState().setConversationId(conversationId); }}
    onDisconnect={() => {
      const conversationId = activeBillableConversationId;
      activeBillableConversationId = null;
      useAgentStore.getState().resetSession();
      if (conversationId) void getAccessToken().then((token) => token ? fetch("/api/agent/session/reconcile", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ conversationId })
      }) : null).catch(() => undefined).finally(() => window.dispatchEvent(new Event("termeow:credits-changed")));
    }}
    onError={(message) => useAgentStore.getState().setStatus("error", message)}
    onMessage={(message) => {
      useAgentStore.getState().addMessage({ role: message.role, text: message.message });
      if (message.role === "agent" && useAgentStore.getState().sessionMode === "text") useAgentStore.getState().setStatus("idle");
    }}
    onAgentTyping={() => useAgentStore.getState().setStatus("thinking")}
    onAgentToolRequest={() => useAgentStore.getState().setStatus("executing")}
    onAgentToolResponse={() => useAgentStore.getState().setStatus("success")}
    onInterruption={() => useAgentStore.getState().setStatus("listening")}
  ><ClientToolsBridge />{clawpumpAgentTools.map((tool) => <ClawpumpTool key={tool.name} name={tool.name} />)}<ControlsBridge {...props} /></ConversationProvider>;
}
