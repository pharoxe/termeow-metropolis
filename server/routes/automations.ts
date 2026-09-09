import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { PrivyClient } from "@privy-io/server-auth";
import { z } from "zod";
import { config } from "../config.js";
import { AutomationStore } from "../automation/store.js";

const intentSchema = z.object({
  kind: z.enum(["swap", "monitor_deployer", "conditional_swap"]),
  chain: z.enum(["solana", "robinhood"]),
  tokenAddress: z.string().min(20).max(64), tokenSymbol: z.string().max(20).optional(),
  side: z.enum(["buy", "sell"]).optional(), router: z.enum(["0x", "jupiter"]).optional(),
  amountMode: z.enum(["fixed", "wallet_percent"]).optional(), amount: z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
  allocationPercent: z.number().positive().max(25).optional(), durationHours: z.number().int().positive().max(24 * 30).optional(),
  condition: z.string().max(1000).optional(), description: z.string().min(3).max(1000)
}).superRefine((intent, context) => {
  if (intent.kind === "swap" && (!intent.side || !intent.amountMode)) context.addIssue({ code: "custom", message: "A swap requires side and amountMode" });
  if (intent.amountMode === "fixed" && !intent.amount) context.addIssue({ code: "custom", message: "A fixed swap requires amount" });
  if (intent.amountMode === "wallet_percent" && !intent.allocationPercent) context.addIssue({ code: "custom", message: "A wallet-percent action requires allocationPercent" });
  if (intent.chain === "robinhood" && intent.router && intent.router !== "0x") context.addIssue({ code: "custom", message: "Robinhood actions must use 0x" });
  if (intent.chain === "solana" && intent.router && intent.router !== "jupiter" && intent.router !== "0x") context.addIssue({ code: "custom", message: "Unsupported Solana router" });
});
const createSchema = z.object({ intent: intentSchema, conversationId: z.string().max(200).optional(), context: z.unknown().optional(), source: z.enum(["elevenlabs_voice", "terminal"]).default("terminal") });
const approveSchema = z.object({ passkeyVerified: z.literal(true) });
const reportSchema = z.object({ status: z.enum(["executing", "completed", "failed"]), transactionHash: z.string().max(200).optional(), failure: z.string().max(1000).optional() });
const store = new AutomationStore(config.snapshot.dir);
const privy = config.privy.appId && config.privy.appSecret ? new PrivyClient(config.privy.appId, config.privy.appSecret) : null;

type AuthRequest = Request & { privyUserId?: string };
async function requirePrivy(request: AuthRequest, response: Response, next: NextFunction) {
  if (!privy) { response.status(503).json({ error: "Privy server authentication is not configured" }); return; }
  const token = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) { response.status(401).json({ error: "Log in with Privy to manage automations" }); return; }
  try { request.privyUserId = (await privy.verifyAuthToken(token)).userId; next(); }
  catch { response.status(401).json({ error: "Invalid or expired Privy access token" }); }
}

export const automationsRouter = Router();
automationsRouter.use(requirePrivy);
automationsRouter.get("/", (request: AuthRequest, response) => response.json({ automations: store.list(request.privyUserId!) }));
automationsRouter.post("/", (request: AuthRequest, response) => {
  const parsed = createSchema.parse(request.body);
  const contextDigest = parsed.context == null ? undefined : createHash("sha256").update(JSON.stringify(parsed.context)).digest("hex");
  response.status(201).json({ automation: store.create(request.privyUserId!, parsed.intent, { source: parsed.source, conversationId: parsed.conversationId, contextDigest }) });
});
automationsRouter.post("/:id/approve", (request: AuthRequest, response) => {
  approveSchema.parse(request.body);
  const automation = store.approve(request.privyUserId!, String(request.params.id));
  if (!automation) { response.status(409).json({ error: "Automation is missing or no longer awaiting approval" }); return; }
  response.json({ automation });
});
automationsRouter.post("/:id/cancel", (request: AuthRequest, response) => {
  const automation = store.cancel(request.privyUserId!, String(request.params.id));
  if (!automation) { response.status(409).json({ error: "Automation cannot be cancelled" }); return; }
  response.json({ automation });
});
automationsRouter.post("/:id/report", (request: AuthRequest, response) => {
  const parsed = reportSchema.parse(request.body);
  const automation = store.report(request.privyUserId!, String(request.params.id), parsed.status, parsed);
  if (!automation) { response.status(409).json({ error: "Automation is not in an executable state" }); return; }
  response.json({ automation });
});
