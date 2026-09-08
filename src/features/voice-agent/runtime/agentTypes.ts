export type AgentStatus =
  | "dormant"
  | "connecting"
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "executing"
  | "success"
  | "warning"
  | "error";

export type OverlayMode = "hidden" | "orb" | "compact" | "expanded";

export interface AgentMessage {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  at: number;
}

export interface TermeowAgentContext {
  route?: string;
  chain?: string;
  token?: { address: string; symbol?: string };
  chart?: { timeframe: string };
  wallet?: { connected: boolean };
}
