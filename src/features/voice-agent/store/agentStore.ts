import { create } from "zustand";
import type { AgentHudWindow, AgentLeftWidget, AgentMessage, AgentStatus, AgentToolEvent, OverlayMode, PendingAgentApproval, TermeowAgentContext } from "../runtime/agentTypes";

interface AgentState {
  status: AgentStatus;
  overlayMode: OverlayMode;
  muted: boolean;
  error?: string;
  conversationId?: string;
  context: TermeowAgentContext;
  transcript: AgentMessage[];
  toolActivity: AgentToolEvent[];
  pendingApproval?: PendingAgentApproval;
  hudWindow?: AgentHudWindow;
  leftWidget?: AgentLeftWidget;
  setStatus: (status: AgentStatus, error?: string) => void;
  setOverlayMode: (mode: OverlayMode) => void;
  setMuted: (muted: boolean) => void;
  setConversationId: (id?: string) => void;
  setContext: (context: TermeowAgentContext) => void;
  addMessage: (message: Omit<AgentMessage, "id" | "at">) => void;
  beginTool: (name: string, input?: string) => string;
  finishTool: (id: string, status: "complete" | "failed", summary?: string) => void;
  setPendingApproval: (pendingApproval?: PendingAgentApproval) => void;
  setHudWindow: (hudWindow?: AgentHudWindow) => void;
  setLeftWidget: (leftWidget?: AgentLeftWidget) => void;
  resetSession: () => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  status: "dormant",
  overlayMode: "hidden",
  muted: false,
  context: {},
  transcript: [],
  toolActivity: [],
  setStatus: (status, error) => set({ status, error }),
  setOverlayMode: (overlayMode) => set({ overlayMode }),
  setMuted: (muted) => set({ muted }),
  setConversationId: (conversationId) => set({ conversationId }),
  setContext: (context) => set({ context }),
  addMessage: (message) => set((state) => ({
    transcript: [...state.transcript, { ...message, id: crypto.randomUUID(), at: Date.now() }].slice(-40)
  })),
  beginTool: (name, input) => {
    const id = crypto.randomUUID();
    const event: AgentToolEvent = { id, name, input, status: "running", startedAt: Date.now() };
    set((state) => ({ toolActivity: [...state.toolActivity, event].slice(-30) }));
    return id;
  },
  finishTool: (id, status, summary) => set((state) => ({
    toolActivity: state.toolActivity.map((event) => event.id === id ? { ...event, status, summary, finishedAt: Date.now() } : event)
  })),
  setPendingApproval: (pendingApproval) => set({ pendingApproval }),
  setHudWindow: (hudWindow) => set({ hudWindow }),
  setLeftWidget: (leftWidget) => set({ leftWidget }),
  resetSession: () => set({ status: "dormant", conversationId: undefined, muted: false })
}));
