import { create } from "zustand";
import type { AgentHudWindow, AgentLeftWidget, AgentMessage, AgentStatus, AgentToolEvent, OverlayMode, PendingAgentApproval, TermeowAgentContext } from "../runtime/agentTypes";

interface AgentState {
  status: AgentStatus;
  overlayMode: OverlayMode;
  muted: boolean;
  /** The voice session's published mic track has carried no signal for several seconds. */
  micSilent: boolean;
  error?: string;
  conversationId?: string;
  sessionMode?: "voice" | "text";
  context: TermeowAgentContext;
  transcript: AgentMessage[];
  toolActivity: AgentToolEvent[];
  pendingApproval?: PendingAgentApproval;
  hudWindow?: AgentHudWindow;
  leftWidget?: AgentLeftWidget;
  setStatus: (status: AgentStatus, error?: string) => void;
  setOverlayMode: (mode: OverlayMode) => void;
  setMuted: (muted: boolean) => void;
  setMicSilent: (micSilent: boolean) => void;
  setConversationId: (id?: string) => void;
  setSessionMode: (mode?: "voice" | "text") => void;
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
  micSilent: false,
  context: {},
  transcript: [],
  toolActivity: [],
  setStatus: (status, error) => set({ status, error }),
  setOverlayMode: (overlayMode) => set({ overlayMode }),
  setMuted: (muted) => set({ muted }),
  setMicSilent: (micSilent) => set({ micSilent }),
  setConversationId: (conversationId) => set({ conversationId }),
  setSessionMode: (sessionMode) => set({ sessionMode }),
  setContext: (context) => set({ context }),
  addMessage: (message) => set((state) => {
    const now = Date.now();
    const last = state.transcript.at(-1);
    if (last?.role === message.role && last.text === message.text && now - last.at < 2_500) return state;
    return { transcript: [...state.transcript, { ...message, id: crypto.randomUUID(), at: now }].slice(-40) };
  }),
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
  resetSession: () => set({ status: "dormant", conversationId: undefined, sessionMode: undefined, muted: false, micSilent: false })
}));
