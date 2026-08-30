import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { clawpumpMcp } from "../clawpump/mcp.js";

const symbol = z.string().regex(/^[A-Z0-9._-]{2,24}$/);
const previewSchema = z.object({
  symbol,
  side: z.enum(["bid", "ask"]),
  orderType: z.enum(["market", "limit"]),
  quantity: z.number().positive().max(100_000),
  price: z.number().positive().optional(),
  transferAmountUsdc: z.number().positive().max(100_000).optional(),
  acknowledgeNoPriceGuard: z.boolean().default(false)
});

function agentArgs(extra: Record<string, unknown> = {}) {
  return { ...(config.clawpump.agentId ? { agent_id: config.clawpump.agentId } : {}), ...extra };
}

export const perpsRouter = Router();

perpsRouter.get("/markets", async (_request, response) => {
  const result = await clawpumpMcp.call("perps_markets", agentArgs());
  response.status(result.ok ? 200 : 502).json(result);
});

perpsRouter.get("/market/:symbol", async (request, response, next) => {
  try {
    const marketSymbol = symbol.parse(request.params.symbol);
    const result = await clawpumpMcp.call("perps_market_data", agentArgs({ symbol: marketSymbol, timeframe: "1h", candleLimit: 100, includeCandles: true, includeOrderbook: true }));
    response.status(result.ok ? 200 : 502).json(result);
  } catch (error) { next(error); }
});

perpsRouter.get("/account", async (_request, response) => {
  const result = await clawpumpMcp.call("perps_account", agentArgs());
  response.status(result.ok ? 200 : 502).json(result);
});

perpsRouter.post("/preview", async (request, response, next) => {
  try {
    const input = previewSchema.parse(request.body);
    const result = await clawpumpMcp.call("perps_order_preview", agentArgs(input));
    response.status(result.ok ? 200 : 502).json({ previewId: randomUUID(), observedAt: Date.now(), ...result });
  } catch (error) { next(error); }
});

perpsRouter.post("/execute", async (request, response, next) => {
  try {
    if (!config.executionEnabled) {
      response.status(403).json({ error: "Mainnet execution is disabled" });
      return;
    }
    const input = previewSchema.extend({
      previewId: z.string().uuid(),
      confirmRisk: z.literal(true),
      idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/)
    }).parse(request.body);
    const { previewId: _previewId, ...toolInput } = input;
    const result = await clawpumpMcp.call("perps_order_execute", agentArgs(toolInput));
    response.status(result.ok ? 200 : 502).json(result);
  } catch (error) { next(error); }
});

perpsRouter.post("/cancel", async (request, response, next) => {
  try {
    if (!config.executionEnabled) {
      response.status(403).json({ error: "Mainnet execution is disabled" });
      return;
    }
    const input = z.object({ symbol, cancelAll: z.boolean().default(false) }).parse(request.body);
    const result = await clawpumpMcp.call("perps_order_cancel", agentArgs(input));
    response.status(result.ok ? 200 : 502).json(result);
  } catch (error) { next(error); }
});
