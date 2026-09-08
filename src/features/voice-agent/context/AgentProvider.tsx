import { lazy, Suspense, createContext, useCallback, useContext, useEffect, useMemo, useRef, type PropsWithChildren } from "react";
import type { AgentRuntime } from "../runtime/AgentRuntime";
import type { AgentStatus, OverlayMode, TermeowAgentContext } from "../runtime/agentTypes";
import { useAgentStore } from "../store/agentStore";
import { AgentOverlayHost } from "../surfaces/AgentOverlay";

const ElevenLabsBridge = lazy(() => import("../runtime/ElevenLabsBridge"));

interface AgentApi {
  open(mode?: Exclude<OverlayMode, "hidden">): void;
  close(): void;
  start(): Promise<void>;
  stop(): void;
  setMuted(muted: boolean): void;
  send(text: string): void;
  updateContext(context: TermeowAgentContext): void;
  status: AgentStatus;
  overlayMode: OverlayMode;
}

const AgentContext = createContext<AgentApi | null>(null);

export function TermeowAgentProvider({ children }: PropsWithChildren) {
  const runtime = useRef<AgentRuntime | null>(null);
  const status = useAgentStore((state) => state.status);
  const overlayMode = useAgentStore((state) => state.overlayMode);
  const conversationId = useAgentStore((state) => state.conversationId);
  const context = useAgentStore((state) => state.context);
  const registerRuntime = useCallback((value: AgentRuntime | null) => { runtime.current = value; }, []);

  const waitForRuntime = useCallback(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (runtime.current) return runtime.current;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("VOICE RUNTIME TOOK TOO LONG TO LOAD");
  }, []);

  const start = useCallback(async () => {
    try {
      useAgentStore.getState().setStatus("connecting");
      await (await waitForRuntime()).connect();
    } catch (reason) {
      useAgentStore.getState().setStatus("error", reason instanceof Error ? reason.message : String(reason));
    }
  }, [waitForRuntime]);
  const updateContext = useCallback((next: TermeowAgentContext) => {
    const changed = JSON.stringify(next) !== JSON.stringify(useAgentStore.getState().context);
    useAgentStore.getState().setContext(next);
    if (changed) runtime.current?.sendContext(next);
  }, []);
  const api = useMemo<AgentApi>(() => ({
    open: (value = "compact") => useAgentStore.getState().setOverlayMode(value),
    close: () => useAgentStore.getState().setOverlayMode("hidden"),
    start,
    stop: () => runtime.current?.disconnect(),
    setMuted: (muted) => muted ? runtime.current?.mute() : runtime.current?.unmute(),
    send: (text) => runtime.current?.sendMessage(text),
    updateContext,
    status,
    overlayMode
  }), [overlayMode, start, status, updateContext]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ".") {
        event.preventDefault();
        api.open(overlayMode === "hidden" ? "compact" : "orb");
      }
    };
    addEventListener("keydown", shortcut);
    return () => removeEventListener("keydown", shortcut);
  }, [api, overlayMode]);

  return <AgentContext.Provider value={api}>
    {children}
    {(overlayMode !== "hidden" || conversationId) && <Suspense fallback={null}><ElevenLabsBridge onRuntime={registerRuntime} initialContext={context} /></Suspense>}
    <AgentOverlayHost />
  </AgentContext.Provider>;
}

export function useAgent() {
  const context = useContext(AgentContext);
  if (!context) throw new Error("useAgent must be used inside TermeowAgentProvider");
  return context;
}
