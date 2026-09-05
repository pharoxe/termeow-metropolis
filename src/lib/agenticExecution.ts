import type { AgentTradeSetup } from "./agenticAnalysis";

export type AgentExecutionIntent = {
  mint: string;
  symbol: string;
  setup: AgentTradeSetup;
  notionalUsd: number;
  maxSlippageBps: number;
};

export type AgentExecutionResult = {
  signature: string;
};

export interface SessionExecutionAdapter {
  state: "ready" | "not-configured";
  execute(intent: AgentExecutionIntent): Promise<AgentExecutionResult>;
}

export const magicBlockSessionAdapter: SessionExecutionAdapter = {
  state: "not-configured",
  async execute() {
    throw new Error("Session-key authorization is not active. No transaction was submitted.");
  }
};
