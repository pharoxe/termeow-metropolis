import type { AgentStatus } from "../voice-agent/runtime/agentTypes";
import { AsciiImage } from "./AsciiImage";

export function AsciiPersona({ status, src = "/assets/termeow-persona.webp" }: { status: AgentStatus; src?: string }) {
  return <AsciiImage src={src} status={status} alt="Termeow, a cat-eared market operator rendered in animated ASCII" />;
}
