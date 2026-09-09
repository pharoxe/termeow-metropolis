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
    propose_swap: async (parameters: Record<string, unknown>) => {
      const context = useAgentStore.getState().context;
      const chain = parameters.chain === "robinhood" ? "robinhood" : parameters.chain === "solana" ? "solana" : context.chain;
      const tokenAddress = String(parameters.token_address || context.token?.address || "");
      if (!chain || !tokenAddress) return JSON.stringify({ ok: false, error: "Select a token chart first." });
      const amountMode = parameters.amount_mode === "fixed" ? "fixed" : "wallet_percent";
      const allocationPercent = Number(parameters.allocation_percent);
      const intent: AutomationIntent = {
        kind: "swap", chain, tokenAddress, tokenSymbol: String(parameters.token_symbol || context.token?.symbol || "TOKEN"),
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
      const tokenAddress = String(parameters.target_address || context.token?.address || "");
      if (!chain || !tokenAddress) return JSON.stringify({ ok: false, error: "Select a token or provide a target address." });
      const intent: AutomationIntent = {
        kind: parameters.strategy === "conditional_swap" ? "conditional_swap" : "monitor_deployer", chain, tokenAddress,
        tokenSymbol: String(parameters.token_symbol || context.token?.symbol || "TOKEN"), side: parameters.side === "sell" ? "sell" : "buy",
        router: chain === "robinhood" ? "0x" : "jupiter", amountMode: "wallet_percent", allocationPercent: Number(parameters.allocation_percent),
        durationHours: Number(parameters.duration_hours || 24), condition: String(parameters.condition || ""),
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
    }
  }), []);

  // Register through the SDK's live registry instead of relying on provider option merging.
  // This makes every handler available before startSession and keeps it attached for the full call.
  useConversationClientTool("read_terminal_state", clientTools.read_terminal_state);
  useConversationClientTool("propose_swap", clientTools.propose_swap);
  useConversationClientTool("propose_automation", clientTools.propose_automation);
  useConversationClientTool("list_automations", clientTools.list_automations);
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
