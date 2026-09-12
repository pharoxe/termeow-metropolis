import { Router } from "express";
import { z } from "zod";
import { getLaunchService } from "../launch/service.js";
import { tokenRegistry } from "../terminal/tokenStore.js";

const chain = z.enum(["solana", "robinhood"]);

function refreshLocalIndex() {
  tokenRegistry.ingestLaunches(getLaunchService().index.snapshot().rows);
}

export const tokensRouter = Router();

tokensRouter.get("/resolve", (request, response, next) => {
  try {
    const query = z.string().trim().min(1).max(120).parse(request.query.q);
    const requestedChain = chain.optional().parse(request.query.chain);
    refreshLocalIndex();
    response.json(tokenRegistry.resolve(query, requestedChain));
  } catch (error) { next(error); }
});

tokensRouter.get("/index", (_request, response) => {
  refreshLocalIndex();
  response.json({ tokens: tokenRegistry.list(), source: "termeow-token-index", observedAt: Date.now() });
});
