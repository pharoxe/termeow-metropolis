import { Router } from "express";
import { config, integrationStatus } from "../config.js";

export const systemRouter = Router();

systemRouter.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "terminal-v-solana",
    network: "solana-mainnet",
    integrations: integrationStatus(),
    now: new Date().toISOString()
  });
});

systemRouter.get("/config", (_request, response) => {
  response.json({
    network: "mainnet-beta",
    rpcEndpoint: "/api/rpc",
    executionEnabled: config.executionEnabled,
    ansemMint: config.ansemMint,
    usdcMint: config.usdcMint,
    privyEnabled: Boolean(config.privy.appId),
    integrations: integrationStatus()
  });
});

systemRouter.post("/rpc", async (request, response) => {
  const forward = async (url: string) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request.body)
  });

  try {
    let upstream = await forward(config.rpc.primary);
    let provider = "primary";
    if (!upstream.ok && config.rpc.fallback) {
      upstream = await forward(config.rpc.fallback);
      provider = "fallback";
    }
    response.status(upstream.status);
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    response.setHeader("X-RPC-Provider", provider);
    response.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    if (config.rpc.fallback) {
      try {
        const upstream = await forward(config.rpc.fallback);
        response.status(upstream.status);
        response.setHeader("X-RPC-Provider", "fallback");
        response.send(Buffer.from(await upstream.arrayBuffer()));
        return;
      } catch { /* report the primary error below */ }
    }
    response.status(502).json({ error: "Solana RPC is unavailable", detail: String(error) });
  }
});
