import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { PrivyClient } from "@privy-io/server-auth";
import { z } from "zod";
import { config } from "../config.js";
import { automationRepository } from "../automation/runtime.js";
import { SOLANA_AUTOMATION_PROGRAM_ALLOWLIST } from "../automation/privyPolicy.js";
import { verifyDelegatedSolanaWallet } from "../automation/privyExecutor.js";

const intentSchema = z.object({
  kind: z.enum(["swap", "monitor_deployer", "monitor_wallet", "monitor_x_launch", "conditional_swap"]),
  chain: z.enum(["solana", "robinhood"]), tokenAddress: z.string().min(20).max(64).optional(),
  tokenSymbol: z.string().max(20).optional(), tokenName: z.string().max(120).optional(), tokenLogoUrl: z.string().url().max(1000).optional(),
  trackedWallet: z.string().min(20).max(64).optional(), trackedWalletUsername: z.string().max(80).optional(),
  trackedXAccount: z.string().max(80).optional(),
  side: z.enum(["buy", "sell"]).optional(), router: z.enum(["0x", "jupiter"]).optional(),
  amountMode: z.enum(["fixed", "wallet_percent"]).optional(), amount: z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
  allocationPercent: z.number().positive().max(25).optional(), durationHours: z.number().int().positive().max(24 * 30).optional(),
  maxSlippageBps: z.number().int().min(1).max(2500).optional(),
  marketCapMinUsd: z.number().nonnegative().optional(), marketCapMaxUsd: z.number().nonnegative().optional(),
  entryPriceTolerancePct: z.number().positive().max(100).optional(), slippageBps: z.number().int().min(1).max(500).optional(),
  condition: z.string().max(1000).optional(), description: z.string().min(3).max(1000),
  exitConditions: z.array(z.object({
    id: z.string().min(1).max(80), type: z.enum(["take_profit_pct", "stop_loss_pct", "trailing_stop_pct", "market_cap", "custom"]),
    value: z.number().optional(), condition: z.string().min(3).max(1000), sellPercent: z.number().positive().max(100),
    slippageBps: z.number().int().min(1).max(500).optional(), activateAfter: z.literal("entry_confirmed")
  })).max(8).optional()
}).superRefine((intent, context) => {
  if (intent.kind === "swap" && (!intent.side || !intent.amountMode)) context.addIssue({ code: "custom", message: "A swap requires side and amountMode" });
  if (intent.kind === "swap" && !intent.tokenAddress) context.addIssue({ code: "custom", message: "A swap requires a token address" });
  if (intent.kind === "monitor_wallet" && !intent.trackedWallet) context.addIssue({ code: "custom", message: "A wallet monitor requires a resolved tracked wallet" });
  if (intent.kind === "monitor_x_launch" && !intent.trackedXAccount) context.addIssue({ code: "custom", message: "An X launch monitor requires an X account" });
  if (intent.amountMode === "fixed" && !intent.amount) context.addIssue({ code: "custom", message: "A fixed swap requires amount" });
  if (intent.amountMode === "wallet_percent" && !intent.allocationPercent) context.addIssue({ code: "custom", message: "A wallet-percent action requires allocationPercent" });
  if (intent.chain === "robinhood" && intent.router && intent.router !== "0x") context.addIssue({ code: "custom", message: "Robinhood actions must use 0x" });
  if (intent.chain === "solana" && intent.router && intent.router !== "jupiter" && intent.router !== "0x") context.addIssue({ code: "custom", message: "Unsupported Solana router" });
  if (intent.marketCapMinUsd != null && intent.marketCapMaxUsd != null && intent.marketCapMinUsd > intent.marketCapMaxUsd)
    context.addIssue({ code: "custom", message: "Minimum market cap cannot exceed maximum market cap" });
  if (intent.exitConditions?.length && intent.side !== "buy") context.addIssue({ code: "custom", message: "Linked sell conditions require a buy entry" });
  if ((intent.exitConditions?.reduce((sum, item) => sum + item.sellPercent, 0) ?? 0) > 100) context.addIssue({ code: "custom", message: "Linked exits cannot sell more than 100% of the acquired position" });
});
const createSchema = z.object({ intent: intentSchema, conversationId: z.string().max(200).optional(), context: z.unknown().optional(), source: z.enum(["elevenlabs_voice", "terminal"]).default("terminal") });
const approveSchema = z.object({ passkeyVerified: z.literal(true) });
const reportSchema = z.object({ status: z.enum(["executing", "completed", "failed"]), transactionHash: z.string().max(200).optional(), failure: z.string().max(1000).optional() });
const store = automationRepository;
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
automationsRouter.get("/", async (request: AuthRequest, response) => response.json({ automations: await store.list(request.privyUserId!) }));
automationsRouter.get("/delegation/solana", async (request: AuthRequest, response) => {
  const configured = Boolean(config.privy.automationSignerId && config.privy.automationPolicyId && config.privy.automationAuthPrivateKey);
  const current = await store.getDelegation(request.privyUserId!);
  response.json({
    configured,
    active: configured && Boolean(current),
    signerId: config.privy.automationSignerId,
    policyIds: config.privy.automationPolicyId ? [config.privy.automationPolicyId] : [],
    walletAddress: current?.walletAddress,
    allowedPrograms: SOLANA_AUTOMATION_PROGRAM_ALLOWLIST
  });
});
automationsRouter.post("/delegation/solana", async (request: AuthRequest, response, next) => {
  if (!config.privy.automationSignerId || !config.privy.automationPolicyId || !config.privy.automationAuthPrivateKey) {
    response.status(503).json({ error: "Privy automation signer is not configured" }); return;
  }
  try {
    const body = z.object({ walletAddress: z.string().min(32).max(64), walletId: z.string().min(3).max(200) }).parse(request.body);
    await verifyDelegatedSolanaWallet(body);
    const delegation = await store.setDelegation({
      userId: request.privyUserId!, chain: "solana", walletAddress: body.walletAddress, walletId: body.walletId,
      signerId: config.privy.automationSignerId, policyId: config.privy.automationPolicyId
    });
    response.json({ delegation });
  } catch (error) { next(error); }
});
automationsRouter.delete("/delegation/solana", async (request: AuthRequest, response) => {
  await store.removeDelegation(request.privyUserId!);
  response.json({ removed: true });
});
automationsRouter.post("/", async (request: AuthRequest, response) => {
  const parsed = createSchema.parse(request.body);
  const contextDigest = parsed.context == null ? undefined : createHash("sha256").update(JSON.stringify(parsed.context)).digest("hex");
  response.status(201).json({ automation: await store.create(request.privyUserId!, parsed.intent, { source: parsed.source, conversationId: parsed.conversationId, contextDigest }) });
});
automationsRouter.get("/preferences/me", async (request: AuthRequest, response) => response.json({ preferences: await store.userPreferences(request.privyUserId!) }));
automationsRouter.patch("/preferences/me", async (request: AuthRequest, response) => {
  const parsed = z.object({
    favoriteTraders: z.array(z.object({ handle: z.string().min(1).max(64), chain: z.enum(["solana", "robinhood"]), wallet: z.string().min(32).max(120), followers: z.number().int().nonnegative().nullable().optional() })).max(25).optional(),
    favoriteTokens: z.array(z.object({ symbol: z.string().min(1).max(32), chain: z.enum(["solana", "robinhood"]).optional(), address: z.string().min(32).max(120).optional(), name: z.string().max(120).optional() })).max(25).optional(),
    defaultAllocationPercent: z.number().positive().max(25).optional(), defaultSlippageBps: z.number().int().min(1).max(500).optional(), defaultDurationHours: z.number().int().positive().max(720).optional(), onboardingCompleted: z.boolean().optional()
  }).parse(request.body);
  const { onboardingCompleted, ...patch } = parsed;
  response.json({ preferences: await store.updatePreferences(request.privyUserId!, { ...patch, onboardingCompletedAt: onboardingCompleted ? Date.now() : undefined }) });
});
automationsRouter.patch("/:id", async (request: AuthRequest, response) => {
  const intent = intentSchema.parse(request.body?.intent);
  const automation = await store.updatePending(request.privyUserId!, String(request.params.id), intent);
  if (!automation) { response.status(409).json({ error: "Only a pending automation can be edited" }); return; }
  response.json({ automation });
});
automationsRouter.post("/:id/approve", async (request: AuthRequest, response) => {
  approveSchema.parse(request.body);
  const pending = await store.get(request.privyUserId!, String(request.params.id));
  if (pending?.intent.chain === "solana" && pending.intent.kind !== "swap" && !await store.getDelegation(request.privyUserId!)) {
    response.status(409).json({ error: "Enable the scoped Privy automation signer before arming this workflow" }); return;
  }
  const automation = await store.approve(request.privyUserId!, String(request.params.id));
  if (!automation) { response.status(409).json({ error: "Automation is missing or no longer awaiting approval" }); return; }
  response.json({ automation });
});
automationsRouter.post("/:id/cancel", async (request: AuthRequest, response) => {
  const automation = await store.cancel(request.privyUserId!, String(request.params.id));
  if (!automation) { response.status(409).json({ error: "Automation cannot be cancelled" }); return; }
  response.json({ automation });
});
automationsRouter.post("/:id/report", async (request: AuthRequest, response) => {
  const parsed = reportSchema.parse(request.body);
  const automation = await store.report(request.privyUserId!, String(request.params.id), parsed.status, parsed);
  if (!automation) { response.status(409).json({ error: "Automation is not in an executable state" }); return; }
  response.json({ automation });
});
