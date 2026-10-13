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

export type AgentHudWindow = {
  type: "market_chart";
  chain: "monad";
  tokenAddress: string;
  tokenSymbol?: string;
  timeframe: string;
  requestedAt: number;
} | {
  type: "order_flow";
  chain: "monad";
  tokenAddress: string;
  tokenSymbol?: string;
  windowMinutes: number;
  minUsd: number;
  side?: "buy" | "sell";
  requestedAt: number;
};

export type AgentLeftWidget =
  | { type: "automations" }
  | { type: "portfolio" }
  | { type: "handles"; query?: string }
  | { type: "tokens"; query: string };

export interface AgentToolEvent {
  id: string;
  name: string;
  status: "running" | "complete" | "failed";
  input?: string;
  summary?: string;
  startedAt: number;
  finishedAt?: number;
}

export type TermeowAgentContext = TerminalAgentSnapshot;
export type PendingAgentApproval = AutomationRecord;
import type { AutomationRecord, TerminalAgentSnapshot } from "../../../../shared/automation";
