type ElevenLabsSession =
  | { conversationToken: string; connectionType: "webrtc" }
  | { agentId: string; connectionType: "webrtc" };

const publicAgentId = (import.meta.env.VITE_ELEVENLABS_AGENT_ID as string | undefined)?.trim();

/** Resolve short-lived server authorization, with a public-agent fallback for local visual development. */
export async function resolveElevenLabsSession(): Promise<ElevenLabsSession> {
  try {
    const response = await fetch("/api/agent/session", { method: "POST", headers: { Accept: "application/json" } });
    if (response.ok) {
      const body = await response.json() as { token?: string };
      if (body.token) return { conversationToken: body.token, connectionType: "webrtc" };
    }
  } catch {
    // Local frontend-only development may intentionally have no token server.
  }
  if (publicAgentId) return { agentId: publicAgentId, connectionType: "webrtc" };
  throw new Error("VOICE AGENT UNCONFIGURED · ADD ELEVENLABS_AGENT_ID + ELEVENLABS_API_KEY");
}
