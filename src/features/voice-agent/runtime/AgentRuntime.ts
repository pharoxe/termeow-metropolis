import type { TermeowAgentContext } from "./agentTypes";

export interface AgentRuntime {
  connect(mode?: "voice" | "text"): Promise<void>;
  disconnect(): void;
  sendMessage(text: string): void;
  sendContext(context: TermeowAgentContext): void;
  mute(): void;
  unmute(): void;
  setVolume(volume: number): void;
  /** Live microphone level, 0-1; 0 outside a voice session. */
  inputVolume(): number;
  /** Switches the microphone mid-session and remembers it for the next voice session. */
  changeInputDevice(deviceId: string): Promise<void>;
}
