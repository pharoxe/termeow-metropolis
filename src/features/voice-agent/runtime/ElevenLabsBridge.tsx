import { ConversationProvider, useConversationControls, useConversationInput, useConversationMode, useConversationStatus } from "@elevenlabs/react";
import { useEffect, useMemo } from "react";
import type { AgentRuntime } from "./AgentRuntime";
import type { TermeowAgentContext } from "./agentTypes";
import { resolveElevenLabsSession } from "./ElevenLabsRuntime";
import { useAgentStore } from "../store/agentStore";
import { audioReactiveEngine } from "../audio/AudioReactiveEngine";

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
  ><ControlsBridge {...props} /></ConversationProvider>;
}
