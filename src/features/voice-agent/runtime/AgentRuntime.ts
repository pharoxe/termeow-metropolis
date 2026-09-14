import type { TermeowAgentContext } from "./agentTypes";

export interface AgentRuntime {
  connect(): Promise<void>;
  disconnect(): void;
  sendMessage(text: string): void;
  sendContext(context: TermeowAgentContext): void;
  mute(): void;
  unmute(): void;
  setVolume(volume: number): void;
}
