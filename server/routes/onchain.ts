import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { clawpumpMcp } from "../clawpump/mcp.js";
import { getOnchainMarket } from "../clawpump/market.js";
import { fetchJson } from "../lib/http.js";

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const quoteSchema = z.object({
  inputMint: address,
  outputMint: address,
  amount: z.string().regex(/^\d+$/),
  slippageBps: z.number().int().min(1).max(500).default(50),
  walletAddress: address.optional()
});

export const onchainRouter = Router();
const quoteCache = new Map<string, { expiresAt: number; quote: unknown }>();

function findJupiterQuote(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.routePlan) && typeof record.inputMint === "string" && typeof record.outputMint === "string") return record;
  for (const child of Object.values(record)) {
    const found = findJupiterQuote(child);
    if (found) return found;
  }
  return undefined;
}

onchainRouter.get("/market/:mint", async (request, response, next) => {
  try {
    const mint = address.parse(request.params.mint);
    const interval = z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).default("5m").parse(request.query.interval);
    response.json(await getOnchainMarket(mint, interval));
  } catch (error) { next(error); }
});

onchainRouter.post("/quote", async (request, response, next) => {
  try {
    const input = quoteSchema.parse(request.body);
    const result = await clawpumpMcp.call("swap_quote", {
      ...(config.clawpump.agentId ? { agent_id: config.clawpump.agentId } : {}),
      input_mint: input.inputMint,
      output_mint: input.outputMint,
      amount: input.amount,
      slippage_bps: input.slippageBps
    });
    if (!result.ok) {
      response.status(502).json({ error: "ClawPump quote failed", detail: result.error });
      return;
    }
    const quoteId = randomUUID();
    quoteCache.set(quoteId, { expiresAt: Date.now() + 60_000, quote: result.data });
    response.json({ quoteId, source: "clawpump", observedAt: Date.now(), ...result });
  } catch (error) { next(error); }
});

onchainRouter.post("/transaction", async (request, response, next) => {
  try {
    if (!config.executionEnabled) {
      response.status(403).json({ error: "Mainnet execution is disabled", hint: "Set ENABLE_MAINNET_EXECUTION=true after configuring credentials." });
      return;
    }
    const input = quoteSchema.extend({
      walletAddress: address,
      quoteId: z.string().uuid().optional()
    }).parse(request.body);
    const cached = input.quoteId ? quoteCache.get(input.quoteId) : undefined;
    if (!cached || cached.expiresAt < Date.now()) {
      response.status(409).json({ error: "Quote expired", hint: "Request a fresh ClawPump quote before building the transaction." });
      return;
    }
    quoteCache.delete(input.quoteId!);
    const quoteResponse = findJupiterQuote(cached.quote);
    if (!quoteResponse) {
      response.status(502).json({ error: "ClawPump quote did not contain a Jupiter-compatible route" });
      return;
    }
    const result = await fetchJson<Record<string, unknown>>(`${config.jupiter.apiUrl}/swap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.jupiter.apiKey ? { "x-api-key": config.jupiter.apiKey } : {})
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: input.walletAddress,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto"
      })
    });
    response.json({ source: "clawpump+jupiter", signingMode: "user-wallet", ...result });
  } catch (error) { next(error); }
});

onchainRouter.get("/portfolio/:wallet", async (request, response, next) => {
  try {
    const walletAddress = address.parse(request.params.wallet);
    const args = { walletAddress, ...(config.clawpump.agentId ? { agentId: config.clawpump.agentId } : {}) };
    const result = await clawpumpMcp.call("get_portfolio", args);
    response.status(result.ok ? 200 : 502).json(result);
  } catch (error) { next(error); }
});
