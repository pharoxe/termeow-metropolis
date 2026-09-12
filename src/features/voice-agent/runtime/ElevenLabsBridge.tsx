import { ConversationProvider, useConversationClientTool, useConversationControls, useConversationInput, useConversationMode, useConversationStatus } from "@elevenlabs/react";
import { useEffect, useMemo } from "react";
import type { AgentRuntime } from "./AgentRuntime";
import type { TermeowAgentContext } from "./agentTypes";
import { resolveElevenLabsSession } from "./ElevenLabsRuntime";
import { useAgentStore } from "../store/agentStore";
import { audioReactiveEngine } from "../audio/AudioReactiveEngine";
import { getAccessToken } from "@privy-io/react-auth";
import { api } from "../../../api/client";
import type { AutomationIntent } from "../../../../shared/automation";

const optionalNumber = (value: unknown) => {
  const number = Number(value);
  return value == null || value === "" || !Number.isFinite(number) ? undefined : number;
};

const exitConditions = (value: unknown, fallbackSlippageBps: number) => {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 8).map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const allowed = ["take_profit_pct", "stop_loss_pct", "trailing_stop_pct", "market_cap", "custom"] as const;
    const type = allowed.includes(item.type as typeof allowed[number]) ? item.type as typeof allowed[number] : "custom";
    return { id: String(item.id || `exit-${index + 1}`), type, value: optionalNumber(item.value), condition: String(item.condition || ""), sellPercent: Number(item.sell_percent || 100), slippageBps: optionalNumber(item.slippage_bps) ?? fallbackSlippageBps, activateAfter: "entry_confirmed" as const };
  }).filter((item) => item.condition.length >= 3);
};

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

  const runtime = useMemo<AgentRuntime>(() => ({
    connect: async () => {
      const session = await resolveElevenLabsSession();
      await Promise.resolve(controls.startSession(session));
    },
    disconnect: () => { controls.endSession(); useAgentStore.getState().resetSession(); },
    sendMessage: (text) => controls.sendUserMessage(text),
    sendContext: (next) => {
      if (useAgentStore.getState().conversationId) controls.sendContextualUpdate(`Termeow view context: ${JSON.stringify(next)}`);
    },
    mute: () => { input.setMuted(true); useAgentStore.getState().setMuted(true); },
    unmute: () => { input.setMuted(false); useAgentStore.getState().setMuted(false); }
  }), [controls, input]);

  useEffect(() => { onRuntime(runtime); return () => onRuntime(null); }, [onRuntime, runtime]);
  useEffect(() => { audioReactiveEngine.bind(controls); }, [controls]);
  useEffect(() => {
    if (connection.status === "connecting") useAgentStore.getState().setStatus("connecting");
    else if (connection.status === "error") useAgentStore.getState().setStatus("error", connection.message || "VOICE CONNECTION FAILED");
    else if (connection.status === "connected") {
      useAgentStore.getState().setStatus(mode.isSpeaking ? "speaking" : "listening");
      audioReactiveEngine.start(() => useAgentStore.getState().status === "speaking");
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
  const clientTools = useMemo(() => ({
    read_terminal_state: async () => {
      const connected = Boolean(await getAccessToken().catch(() => null));
      const terminal = useAgentStore.getState().context;
      return JSON.stringify({ ok: true, warning: "This is a point-in-time terminal snapshot, not a guarantee of execution quality.", terminal: { ...terminal, wallet: { ...terminal.wallet, connected } } });
    },
    resolve_trader_handle: async (parameters: Record<string, unknown>) => {
      const handle = String(parameters.handle || "").replace(/^@/, "").trim();
      if (!handle) return JSON.stringify({ ok: false, error: "Provide a Fomo handle." });
      try {
        const result = await api.identityHandle(handle);
        const chain = parameters.chain === "solana" || parameters.chain === "robinhood" ? parameters.chain : undefined;
        const addresses = chain ? result.addresses.filter((item) => item.chain === chain) : result.addresses;
        return JSON.stringify({ ok: addresses.length > 0, handle, indexed: true, addresses: addresses.map((item) => ({ chain: item.chain, wallet: item.wallet, display_name: item.displayName, twitter: item.twitter, followers: item.followers, source: item.source })), error: addresses.length ? undefined : "No indexed wallet matches this handle and chain. Ask for an address; do not guess." });
      } catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }); }
    },
    read_automation_preferences: async () => {
      try { const token = await getAccessToken(); if (!token) return JSON.stringify({ ok: false, error: "The user must log in." }); return JSON.stringify({ ok: true, ...(await api.automationPreferences(token)) }); }
      catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }); }
    },
    update_automation_preferences: async (parameters: Record<string, unknown>) => {
      try {
        const token = await getAccessToken(); if (!token) return JSON.stringify({ ok: false, error: "The user must log in." });
        const body = { defaultAllocationPercent: optionalNumber(parameters.default_allocation_percent), defaultSlippageBps: optionalNumber(parameters.default_slippage_bps), defaultDurationHours: optionalNumber(parameters.default_duration_hours) };
        return JSON.stringify({ ok: true, ...(await api.updateAutomationPreferences(token, body)) });
      } catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }); }
    },
    propose_swap: async (parameters: Record<string, unknown>) => {
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
        useAgentStore.getState().setOverlayMode("expanded");
        return JSON.stringify({ ok: true, automation_id: result.automation.id, status: "pending_passkey_confirmation", message: "The proposal is visible. Ask the user to review it and press CONFIRM WITH PASSKEY. Do not claim it executed." });
      } catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }); }
    },
    propose_automation: async (parameters: Record<string, unknown>) => {
      const context = useAgentStore.getState().context;
      const chain = parameters.chain === "robinhood" ? "robinhood" : parameters.chain === "solana" ? "solana" : context.chain;
      if (!chain) return JSON.stringify({ ok: false, error: "Choose Solana or Robinhood." });
      const requestedHandle = String(parameters.tracked_wallet_username || "").replace(/^@/, "").trim();
      const trackedXAccount = String(parameters.tracked_x_account || "").replace(/^@/, "").trim();
      let trackedWallet = String(parameters.target_address || "").trim();
      let identity = trackedWallet ? await api.identityWallet(chain, trackedWallet).then(result => result.identity).catch(() => null) : null;
      if (!trackedWallet && requestedHandle) {
        const matches = await api.identityHandle(requestedHandle).then(result => result.addresses.filter((item) => item.chain === chain)).catch(() => []);
        if (matches.length !== 1) return JSON.stringify({ ok: false, error: matches.length ? `Multiple ${chain} wallets match @${requestedHandle}; ask the user which wallet.` : `No indexed ${chain} wallet matches @${requestedHandle}; ask for the address and do not guess.` , matches: matches.map((item) => item.wallet) });
        identity = matches[0]; trackedWallet = matches[0].wallet;
      }
      const tokenAddress = String(parameters.token_address || context.token?.address || "").trim() || undefined;
      if (!trackedWallet && !tokenAddress && !trackedXAccount) return JSON.stringify({ ok: false, error: "Provide a tracked handle/address, an X account, or select a token." });
      const slippageBps = Math.round(optionalNumber(parameters.slippage_bps) ?? 50);
      const intent: AutomationIntent = {
        kind: parameters.strategy === "conditional_swap" ? "conditional_swap" : parameters.strategy === "monitor_deployer" ? "monitor_deployer" : parameters.strategy === "monitor_x_launch" ? "monitor_x_launch" : "monitor_wallet", chain, tokenAddress,
        tokenSymbol: String(parameters.token_symbol || context.token?.symbol || (tokenAddress ? "TOKEN" : "ANY")), tokenName: context.token?.name,
        tokenLogoUrl: context.token?.logoUrl, trackedWallet: trackedWallet || undefined,
        trackedWalletUsername: requestedHandle || identity?.handle || undefined,
        trackedXAccount: trackedXAccount || undefined,
        side: parameters.side === "sell" ? "sell" : "buy",
        router: chain === "robinhood" ? "0x" : "jupiter", amountMode: "wallet_percent", allocationPercent: Number(parameters.allocation_percent),
        durationHours: Number(parameters.duration_hours || 24), marketCapMinUsd: optionalNumber(parameters.market_cap_min_usd),
        marketCapMaxUsd: optionalNumber(parameters.market_cap_max_usd), entryPriceTolerancePct: optionalNumber(parameters.entry_price_tolerance_percent), slippageBps,
        condition: String(parameters.condition || ""), exitConditions: exitConditions(parameters.exit_conditions, slippageBps),
        description: String(parameters.description || "Voice-created monitored trading strategy")
      };
      try {
        const token = await getAccessToken();
        if (!token) return JSON.stringify({ ok: false, error: "The user must log in before an automation can be proposed." });
        const result = await api.createAutomation(token, { intent, source: "elevenlabs_voice", conversationId: useAgentStore.getState().conversationId, context });
        useAgentStore.getState().setPendingApproval(result.automation);
        useAgentStore.getState().setOverlayMode("expanded");
        return JSON.stringify({ ok: true, automation_id: result.automation.id, status: "pending_passkey_confirmation", message: "Ask the user to review and confirm with their passkey. The automation is not armed yet." });
      } catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }); }
    },
    list_automations: async () => {
      try {
        const token = await getAccessToken();
        if (!token) return JSON.stringify({ ok: false, error: "The user must log in." });
        const result = await api.automations(token);
        return JSON.stringify({ ok: true, automations: result.automations.slice(0, 20).map((item) => ({ id: item.id, status: item.status, description: item.intent.description, chain: item.intent.chain, kind: item.intent.kind, created_at: item.createdAt })) });
      } catch (reason) { return JSON.stringify({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }); }
    },
    open_market_hud: async (parameters: Record<string, unknown>) => {
      const context = useAgentStore.getState().context;
      const chain = parameters.chain === "robinhood" ? "robinhood" : parameters.chain === "solana" ? "solana" : context.chain;
      const tokenAddress = String(parameters.token_address || context.token?.address || "").trim();
      const requested = String(parameters.timeframe || "5m").toLowerCase();
      const timeframe = ["1m", "5m", "15m", "1h", "4h", "1d"].includes(requested) ? requested : "5m";
      if (!chain || !tokenAddress) return JSON.stringify({ ok: false, error: "A chain and exact token address are required to open the market HUD." });
      useAgentStore.getState().setHudWindow({ type: "market_chart", chain, tokenAddress, tokenSymbol: String(parameters.token_symbol || context.token?.symbol || "") || undefined, timeframe, requestedAt: Date.now() });
      return JSON.stringify({ ok: true, surface: "market_chart", status: "visible", message: "The live market HUD is open beside the conversation." });
    },
    dismiss_agent_ui: async () => {
      useAgentStore.getState().setHudWindow();
      return JSON.stringify({ ok: true, status: "dismissed" });
    }
  }), []);

  // Register through the SDK's live registry instead of relying on provider option merging.
  // This makes every handler available before startSession and keeps it attached for the full call.
  useConversationClientTool("read_terminal_state", clientTools.read_terminal_state);
  useConversationClientTool("resolve_trader_handle", clientTools.resolve_trader_handle);
  useConversationClientTool("read_automation_preferences", clientTools.read_automation_preferences);
  useConversationClientTool("update_automation_preferences", clientTools.update_automation_preferences);
  useConversationClientTool("propose_swap", clientTools.propose_swap);
  useConversationClientTool("propose_automation", clientTools.propose_automation);
  useConversationClientTool("list_automations", clientTools.list_automations);
  useConversationClientTool("open_market_hud", clientTools.open_market_hud);
  useConversationClientTool("dismiss_agent_ui", clientTools.dismiss_agent_ui);
  return null;
}

export default function ElevenLabsBridge(props: Props) {
  return <ConversationProvider
    onConnect={({ conversationId }) => useAgentStore.getState().setConversationId(conversationId)}
    onDisconnect={() => useAgentStore.getState().resetSession()}
    onError={(message) => useAgentStore.getState().setStatus("error", message)}
    onMessage={(message) => useAgentStore.getState().addMessage({ role: message.role, text: message.message })}
    onAgentTyping={() => useAgentStore.getState().setStatus("thinking")}
    onAgentToolRequest={() => useAgentStore.getState().setStatus("executing")}
    onAgentToolResponse={() => useAgentStore.getState().setStatus("success")}
    onInterruption={() => useAgentStore.getState().setStatus("listening")}
  ><ClientToolsBridge /><ControlsBridge {...props} /></ConversationProvider>;
}
