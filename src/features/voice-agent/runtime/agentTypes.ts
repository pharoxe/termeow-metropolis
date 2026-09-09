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

export type TermeowAgentContext = TerminalAgentSnapshot;
export type PendingAgentApproval = AutomationRecord;
import type { AutomationRecord, TerminalAgentSnapshot } from "../../../../shared/automation";
