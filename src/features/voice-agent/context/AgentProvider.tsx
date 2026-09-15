import { lazy, Suspense, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";
import type { AgentRuntime } from "../runtime/AgentRuntime";
import type { AgentStatus, OverlayMode, TermeowAgentContext } from "../runtime/agentTypes";
import { useAgentStore } from "../store/agentStore";
import { AgentOverlayHost } from "../surfaces/AgentOverlay";
import { VoiceExecutionBridge } from "../VoiceExecutionBridge";
import { hasPrivy } from "../../../auth/WalletProviders";

const ElevenLabsBridge = lazy(() => import("../runtime/ElevenLabsBridge"));

interface AgentApi {
  open(mode?: Exclude<OverlayMode, "hidden">): void;
  close(): void;
  start(): Promise<boolean>;
  startText(): Promise<boolean>;
  stop(): void;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  send(text: string): void;
  sendText(text: string): Promise<boolean>;
  updateContext(context: TermeowAgentContext): void;
  status: AgentStatus;
  sessionMode?: "voice" | "text";
  overlayMode: OverlayMode;
  volume: number;
}

const AgentContext = createContext<AgentApi | null>(null);

export function TermeowAgentProvider({ children }: PropsWithChildren) {
  const runtime = useRef<AgentRuntime | null>(null);
  const connecting = useRef<Promise<boolean> | null>(null);
  const initialVolume = useRef<number | null>(null);
  if (initialVolume.current == null) {
    const saved = typeof window === "undefined" ? null : localStorage.getItem("termeow-agent-volume");
    const stored = saved === null ? Number.NaN : Number(saved);
    initialVolume.current = Number.isFinite(stored) ? Math.max(0, Math.min(1, stored)) : 0.72;
  }
  const [volume, setVolumeState] = useState(initialVolume.current);
  const volumeRef = useRef(volume);
  const status = useAgentStore((state) => state.status);
  const overlayMode = useAgentStore((state) => state.overlayMode);
  const conversationId = useAgentStore((state) => state.conversationId);
  const sessionMode = useAgentStore((state) => state.sessionMode);
  const context = useAgentStore((state) => state.context);
  const registerRuntime = useCallback((value: AgentRuntime | null) => {
    runtime.current = value;
    value?.setVolume(volumeRef.current);
  }, []);

  const waitForRuntime = useCallback(async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (runtime.current) return runtime.current;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("VOICE RUNTIME TOOK TOO LONG TO LOAD");
  }, []);

  const start = useCallback((mode: "voice" | "text" = "voice") => {
    const current = useAgentStore.getState();
    if (current.conversationId && current.sessionMode === mode) return Promise.resolve(true);
    if (connecting.current) return connecting.current;
    const attempt = (async () => {
      try {
      const current = useAgentStore.getState();
      if (current.conversationId && current.sessionMode === mode) return true;
      useAgentStore.getState().setStatus("connecting");
      const activeRuntime = await waitForRuntime();
      await activeRuntime.connect(mode);
      activeRuntime.setVolume(volumeRef.current);
      for (let attempt = 0; attempt < 240 && !useAgentStore.getState().conversationId; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (!useAgentStore.getState().conversationId) throw new Error("CHAT LINK TOOK TOO LONG TO OPEN");
      return true;
      } catch (reason) {
        useAgentStore.getState().setStatus("error", reason instanceof Error ? reason.message : String(reason));
        return false;
      }
    })().finally(() => { connecting.current = null; });
    connecting.current = attempt;
    return attempt;
  }, [waitForRuntime]);
  const sendText = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message) return false;
    const current = useAgentStore.getState();
    if (!current.conversationId || current.sessionMode !== "text") {
      if (!await start("text")) return false;
    }
    const activeRuntime = runtime.current;
    if (!activeRuntime || !useAgentStore.getState().conversationId) {
      useAgentStore.getState().setStatus("error", "CHAT LINK IS NOT READY");
      return false;
    }
    activeRuntime.sendMessage(message);
    return true;
  }, [start]);
  const updateContext = useCallback((next: TermeowAgentContext) => {
    const changed = JSON.stringify(next) !== JSON.stringify(useAgentStore.getState().context);
    useAgentStore.getState().setContext(next);
    if (changed) runtime.current?.sendContext(next);
  }, []);
  const setVolume = useCallback((next: number) => {
    const normalized = Math.max(0, Math.min(1, next));
    volumeRef.current = normalized;
    setVolumeState(normalized);
    localStorage.setItem("termeow-agent-volume", String(normalized));
    runtime.current?.setVolume(normalized);
  }, []);
  const api = useMemo<AgentApi>(() => ({
    open: (value = "compact") => useAgentStore.getState().setOverlayMode(value),
    close: () => useAgentStore.getState().setOverlayMode("hidden"),
    start,
    startText: () => start("text"),
    stop: () => runtime.current?.disconnect(),
    setMuted: (muted) => muted ? runtime.current?.mute() : runtime.current?.unmute(),
    setVolume,
    send: (text) => runtime.current?.sendMessage(text),
    sendText,
    updateContext,
    status,
    sessionMode,
    overlayMode,
    volume
  }), [overlayMode, sendText, sessionMode, setVolume, start, status, updateContext, volume]);

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
    {hasPrivy && <VoiceExecutionBridge />}
  </AgentContext.Provider>;
}

export function useAgent() {
  const context = useContext(AgentContext);
  if (!context) throw new Error("useAgent must be used inside TermeowAgentProvider");
  return context;
}
