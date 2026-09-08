import { Router } from "express";
import { config } from "../config.js";

export const agentRouter = Router();

agentRouter.post("/session", async (_request, response) => {
  if (!config.elevenlabs.apiKey || !config.elevenlabs.agentId) {
    response.status(503).json({ error: "Voice agent is not configured" });
    return;
  }
  try {
    const query = new URLSearchParams({ agent_id: config.elevenlabs.agentId, environment: "production" });
    const upstream = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/token?${query}`, {
      headers: { "xi-api-key": config.elevenlabs.apiKey, Accept: "application/json" }
    });
    const body = await upstream.text();
    response.setHeader("Cache-Control", "no-store");
    response.status(upstream.status).type("application/json").send(body);
  } catch (error) {
    response.status(502).json({ error: "ElevenLabs authorization unavailable", detail: config.nodeEnv === "development" ? String(error) : undefined });
  }
});
