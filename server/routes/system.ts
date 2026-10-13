import { Router } from "express";
import { config, integrationStatus } from "../config.js";
import { snapshotStatus } from "../persist/live.js";
import { monadRpcFetch, monadRpcStats } from "../tape/monad/rpcPool.js";
import { monadTransportStatus } from "../tape/monad/wsStatus.js";
import { automationRepository } from "../automation/runtime.js";

export const systemRouter = Router();

systemRouter.get("/health", async (_request, response, next) => {
  try {
    const database = await automationRepository.health();
  response.json({
    status: "ok",
    service: "termeow-monad",
    network: `monad-${config.network.network}`,
    chainId: config.network.chainId,
    integrations: integrationStatus(),
    database,
    now: new Date().toISOString(),
    ...snapshotStatus(),
    monadRpc: monadRpcStats(),
    /** Which transport carries Monad log prints per poller: "WS" while subscribed, "HTTP" while polling only. */
    monadTransport: monadTransportStatus()
  });
  } catch (error) { next(error); }
});

systemRouter.get("/config", (_request, response) => {
  const network = config.network;
  response.json({
    network: network.network,
    chain: {
      id: network.chainId,
      caip2: network.caip2,
      name: network.name,
      nativeSymbol: network.nativeSymbol,
      explorer: network.explorer,
      rpcUrl: network.rpcUrls[0],
      blockMs: network.blockMs
    },
    rpcEndpoint: "/api/rpc",
    routers: [
      { id: "kuru", label: "Kuru Flow", available: true, chains: ["monad"] },
      { id: "0x", label: "0x Protocol", available: Boolean(config.zeroEx.apiKey), chains: ["monad"] }
    ],
    tokens: network.tokens,
    featuredToken: config.featuredToken,
    privyEnabled: Boolean(config.privy.appId),
    integrations: integrationStatus()
  });
});

/** Read-only JSON-RPC methods the browser may proxy through the server's Monad endpoint pool. */
const BROWSER_RPC_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas",
  "eth_feeHistory", "eth_getCode", "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByNumber"
]);

systemRouter.post("/rpc", async (request, response) => {
  const calls = Array.isArray(request.body) ? request.body : [request.body];
  if (!calls.length || calls.length > 20 || calls.some((call) => !call || typeof call !== "object" || !BROWSER_RPC_METHODS.has(String((call as { method?: unknown }).method)))) {
    response.status(400).json({ error: "Only read-only Monad RPC methods may be proxied" });
    return;
  }
  try {
    const upstream = await monadRpcFetch(config.monad.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.body)
    });
    response.status(upstream.status);
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    response.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    response.status(502).json({ error: "Monad RPC is unavailable", detail: String(error) });
  }
});
