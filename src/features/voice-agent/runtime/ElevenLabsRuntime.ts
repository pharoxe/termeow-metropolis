import { getAccessToken } from "@privy-io/react-auth";

type ElevenLabsSession =
  { conversationToken: string; connectionType: "webrtc" };

/** Paid voice authorization must always come from the authenticated server. */
export async function resolveElevenLabsSession(): Promise<ElevenLabsSession> {
  const token = await getAccessToken();
  if (!token) throw new Error("Log in to talk to Termeow.");
  const response = await fetch("/api/agent/session", { method: "POST", headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  const body = await response.json() as { token?: string; error?: string };
  if (response.status === 402) window.dispatchEvent(new Event("termeow:credits-exhausted"));
  if (!response.ok || !body.token) throw new Error(body.error || "Voice authorization unavailable.");
  window.dispatchEvent(new Event("termeow:credits-changed"));
  return { conversationToken: body.token, connectionType: "webrtc" };
}
