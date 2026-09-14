import "dotenv/config";
import WebSocket from "ws";

// Minimal authorized diagnostic: no microphone, user memory or payment involved.
const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${process.env.ELEVENLABS_AGENT_ID}`, {
  headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(10000)
});
if (!response.ok) throw new Error(`Voice authorization failed: ${response.status}`);
const { signed_url } = await response.json();
await new Promise((resolve, reject) => {
  const socket = new WebSocket(signed_url);
  const timer = setTimeout(() => { socket.close(); reject(new Error("Voice handshake timed out")); }, 25000);
  let accepted = false;
  socket.on("open", () => socket.send(JSON.stringify({ type: "conversation_initiation_client_data", dynamic_variables: {
    termeow_greeting: "Voice connection test.", termeow_user_memory: "No private user memory supplied."
  } })));
  socket.on("message", (raw) => {
    const event = JSON.parse(String(raw));
    if (event.type === "conversation_initiation_metadata") { accepted = true; console.log("Voice handshake accepted."); }
    if (event.type === "audio") { clearTimeout(timer); console.log("Agent audio received."); socket.close(); resolve(); }
    if (event.type === "ping") socket.send(JSON.stringify({ type: "pong", event_id: event.ping_event.event_id }));
  });
  socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  socket.on("close", (code) => { clearTimeout(timer); if (!accepted || code === 1008) reject(new Error(`Voice rejected: ${code}`)); else resolve(); });
});
