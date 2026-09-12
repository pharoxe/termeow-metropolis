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

export type OverlayMode = "hidden" | "surface" | "orb" | "compact" | "expanded";

export interface AgentMessage {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  at: number;
}

export interface AgentHudWindow {
  type: "market_chart";
  chain: "solana" | "robinhood";
  tokenAddress: string;
  tokenSymbol?: string;
  timeframe: string;
  requestedAt: number;
}

export type TermeowAgentContext = TerminalAgentSnapshot;
export type PendingAgentApproval = AutomationRecord;
import type { AutomationRecord, TerminalAgentSnapshot } from "../../../../shared/automation";
