import { Router } from "express";
import { PrivyClient } from "@privy-io/server-auth";
import { z } from "zod";
import { config } from "../config.js";
import { hasVoiceReservation } from "../agent/credits.js";
import { parseResearchTool, runResearchTool } from "../agent/monadTools.js";
import { balance, createQuote, creditError, MAX_VOICE_SECONDS, reconcileVoice, reserveVoice, settleQuote, VOICE_CREDITS_PER_MINUTE, VOICE_RESERVE_CREDITS } from "../agent/credits.js";

export const agentRouter = Router();
const privy = config.privy.appId && config.privy.appSecret ? new PrivyClient(config.privy.appId, config.privy.appSecret) : null;
let agentDurationCache: { checkedAt: number; maxSeconds: number } | null = null;
async function checkVoiceDuration() {
  if (agentDurationCache && Date.now() - agentDurationCache.checkedAt < 5 * 60_000) return agentDurationCache.maxSeconds;
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${config.elevenlabs.agentId}`, { headers: { "xi-api-key": config.elevenlabs.apiKey || "" }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw creditError("Cannot verify voice call limit.", 503);
  const agent = await response.json() as { conversation_config?: { conversation?: { max_duration_seconds?: number } } };
  const maxSeconds = Number(agent.conversation_config?.conversation?.max_duration_seconds);
  if (!Number.isFinite(maxSeconds) || maxSeconds > MAX_VOICE_SECONDS || maxSeconds < 1) throw creditError(`Voice agent must cap calls at ${MAX_VOICE_SECONDS} seconds before credits can be used.`, 503);
  agentDurationCache = { checkedAt: Date.now(), maxSeconds };
  return maxSeconds;
}

async function userId(request: { headers: { authorization?: string } }) {
  if (!privy) throw creditError("Privy authentication is unavailable.", 503);
  const token = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) throw creditError("Log in to use Termeow credits.", 401);
  try { return (await privy.verifyAuthToken(token)).userId; }
  catch { throw creditError("Your login expired. Please log in again.", 401); }
}
function failed(response: { status: (status: number) => { json: (body: unknown) => void } }, error: unknown) {
  const failure = error as Error & { status?: number };
  if (error instanceof z.ZodError) { response.status(400).json({ error: "Invalid request", issues: error.issues }); return; }
  if (!failure.status) console.error("Agent service failure:", error);
  response.status(failure.status || 503).json({ error: failure.status ? failure.message : "Agent service temporarily unavailable. Please retry shortly." });
}
const toolWindows = new Map<string, { start: number; count: number }>();
agentRouter.post("/tools/research", async (request, response) => {
  try {
    const uid = await userId(request);
    if (!await hasVoiceReservation(uid)) throw creditError("Start an authenticated voice session to use agent research tools.", 402);
    const { tool, args } = z.object({ tool: z.string().max(60), args: z.record(z.string(), z.unknown()).default({}) }).strict().parse(request.body);
    try { parseResearchTool(tool, args); } catch { throw creditError("Invalid or unavailable research tool arguments."); }
    const now = Date.now();
    for (const [key, value] of toolWindows) if (now - value.start > 60_000) toolWindows.delete(key);
    const window = toolWindows.get(uid) || { start: now, count: 0 };
    if (++window.count > 15) throw creditError("Research request limit reached. Try again in a minute.", 429);
    toolWindows.set(uid, window);
    response.setHeader("Cache-Control", "no-store"); response.json(await runResearchTool(tool, args));
  } catch (error) { failed(response, error); }
});

agentRouter.get("/credits", async (request, response) => {
  try { response.setHeader("Cache-Control", "no-store"); response.json({ balance: await balance(await userId(request)), creditsPerDollar: 100, voiceCreditsPerMinute: VOICE_CREDITS_PER_MINUTE, voiceHoldCredits: VOICE_RESERVE_CREDITS }); }
  catch (error) { failed(response, error); }
});

agentRouter.post("/credits/quote", async (request, response) => {
  try {
    const uid = await userId(request);
    const { asset, usd, sender } = z.object({ asset: z.enum(["MON", "USDC", "AUSD"]), usd: z.number().int().min(5).max(500), sender: z.string().regex(/^0x[a-fA-F0-9]{40}$/) }).parse(request.body);
    // A user must not quote another wallet and ask us to credit the resulting payment.
    const user = await privy!.getUser(uid);
    const linked = [user.wallet, ...user.linkedAccounts].filter(Boolean) as Array<{ type?: string; address?: string }>;
    if (!linked.some((item) => item.address && item.address.toLowerCase() === sender.toLowerCase())) throw creditError("Use a wallet connected to your Privy account.", 403);
    response.json({ quote: await createQuote(uid, asset, usd, sender) });
  } catch (error) { failed(response, error); }
});

agentRouter.post("/credits/settle", async (request, response) => {
  try {
    const uid = await userId(request);
    const { quoteId, transactionHash } = z.object({ quoteId: z.string().uuid(), transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/) }).parse(request.body);
    response.setHeader("Cache-Control", "no-store"); response.json(await settleQuote(uid, quoteId, transactionHash));
  } catch (error) { failed(response, error); }
});

agentRouter.post("/session/reconcile", async (request, response) => {
  try {
    const uid = await userId(request);
    const { conversationId } = z.object({ conversationId: z.string().min(10).max(200) }).parse(request.body);
    response.setHeader("Cache-Control", "no-store"); response.json(await reconcileVoice(conversationId, uid));
  }
  catch (error) { failed(response, error); }
});

agentRouter.post("/session", async (request, response) => {
  if (!config.elevenlabs.apiKey || !config.elevenlabs.agentId) {
    response.status(503).json({ error: "Voice agent is not configured" });
    return;
  }
  try {
    const uid = await userId(request);
    if (await balance(uid) < VOICE_RESERVE_CREDITS) throw creditError(`A call needs a refundable ${VOICE_RESERVE_CREDITS}-credit hold. Add funds to continue.`, 402);
    await checkVoiceDuration();
    const query = new URLSearchParams({ agent_id: config.elevenlabs.agentId, environment: "production" });
    const upstream = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/token?${query}`, {
      headers: { "xi-api-key": config.elevenlabs.apiKey, Accept: "application/json" }
    });
    const body = await upstream.text();
    if (upstream.ok) {
      const parsed = JSON.parse(body) as { conversation_id?: string; token?: string };
      if (!parsed.conversation_id || !parsed.token) throw creditError("ElevenLabs did not return a billable conversation ID.", 502);
      const payload = JSON.parse(Buffer.from(parsed.token.split(".")[1] || "", "base64url").toString()) as { exp?: number };
      if (!payload.exp || !Number.isFinite(payload.exp)) throw creditError("ElevenLabs token expiry is unavailable.", 502);
      await reserveVoice(uid, parsed.conversation_id, new Date(payload.exp * 1000));
    }
    response.setHeader("Cache-Control", "no-store");
    response.status(upstream.status).type("application/json").send(body);
  } catch (error) {
    failed(response, error);
  }
});
