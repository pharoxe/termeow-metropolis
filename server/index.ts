import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import compression from "compression";
import helmet from "helmet";
import { ZodError } from "zod";
import { config } from "./config.js";
import { systemRouter } from "./routes/system.js";
import { onchainRouter } from "./routes/onchain.js";
import { terminalRouter } from "./routes/terminal.js";
import { thesesRouter } from './routes/theses.js';
import { identityRouter } from './routes/identity.js';
import { flowRouter } from "./routes/flow.js";
import { flowCandlesRouter } from "./routes/flowCandles.js";
import { marketRouter } from "./routes/market.js";
import { launchesRouter } from "./routes/launches.js";
import { fomoRouter } from "./routes/fomo.js";
import { liveAlertsRouter } from "./routes/alerts.js";
import { discoverRouter } from "./routes/discover.js";
import { agentRouter } from "./routes/agent.js";
import { automationsRouter } from "./routes/automations.js";
import { internalAutomationsRouter } from "./routes/internalAutomations.js";
import { automationRepository } from "./automation/runtime.js";
import { clawpumpMcp } from "./clawpump/mcp.js";
import { errorMessage, UpstreamError } from "./lib/http.js";
import { installSnapshots } from "./persist/live.js";

const snapshots = installSnapshots();

const app = express();
app.disable("x-powered-by");
if (config.nodeEnv === "production") app.set("trust proxy", 1);
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "256kb" }));

app.use("/api", systemRouter);
app.use("/api/onchain", onchainRouter);
app.use("/api/terminal", terminalRouter);
app.use('/api/theses',thesesRouter);
app.use('/api/identity',identityRouter);
app.use("/api/flow", flowRouter);
app.use("/api/flow", flowCandlesRouter);
app.use("/api/market", marketRouter);
app.use("/api/launches", launchesRouter);
app.use("/api/fomo", fomoRouter);
app.use("/api/alerts", liveAlertsRouter());
app.use("/api/discover", discoverRouter);
app.use("/api/agent", agentRouter);
app.use("/api/automations", automationsRouter);
app.use("/api/internal/automations", internalAutomationsRouter);

if (config.nodeEnv === "production") {
  const dist = path.resolve(process.cwd(), "dist");
  if (!existsSync(path.join(dist, "index.html"))) {
    console.error("Production frontend is missing. Run npm run build before npm start.");
    process.exit(1);
  }
  app.use(express.static(dist, { index: false }));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api/")) return next();
    response.sendFile(path.join(dist, "index.html"));
  });
}

app.use((_request, response) => response.status(404).json({ error: "Not found" }));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) {
    response.status(400).json({ error: "Invalid request", issues: error.issues });
    return;
  }
  if (error instanceof UpstreamError) {
    response.status(502).json({ error: error.message, upstreamStatus: error.status, detail: error.detail });
    return;
  }
  console.error(error);
  response.status(500).json({ error: "Server error", detail: config.nodeEnv === "development" ? errorMessage(error) : undefined });
});

const server = app.listen(config.port, config.host, () => {
  const visibleHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  console.log(`terminal-v-solana -> http://${visibleHost}:${config.port}`);
});
server.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

async function shutdown() {
  snapshots.saveAll("shutdown");
  server.close();
  await clawpumpMcp.close();
  await automationRepository.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
