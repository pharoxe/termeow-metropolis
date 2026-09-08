import { create } from "zustand";
import type { AgentMessage, AgentStatus, OverlayMode, TermeowAgentContext } from "../runtime/agentTypes";

interface AgentState {
  status: AgentStatus;
  overlayMode: OverlayMode;
  muted: boolean;
  error?: string;
  conversationId?: string;
  context: TermeowAgentContext;
  transcript: AgentMessage[];
  setStatus: (status: AgentStatus, error?: string) => void;
  setOverlayMode: (mode: OverlayMode) => void;
  setMuted: (muted: boolean) => void;
  setConversationId: (id?: string) => void;
  setContext: (context: TermeowAgentContext) => void;
  addMessage: (message: Omit<AgentMessage, "id" | "at">) => void;
  resetSession: () => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  status: "dormant",
  overlayMode: "hidden",
  muted: false,
  context: {},
  transcript: [],
  setStatus: (status, error) => set({ status, error }),
  setOverlayMode: (overlayMode) => set({ overlayMode }),
  setMuted: (muted) => set({ muted }),
  setConversationId: (conversationId) => set({ conversationId }),
  setContext: (context) => set({ context }),
  addMessage: (message) => set((state) => ({
    transcript: [...state.transcript, { ...message, id: crypto.randomUUID(), at: Date.now() }].slice(-40)
  })),
  resetSession: () => set({ status: "dormant", conversationId: undefined, muted: false })
}));
