import "dotenv/config";
import { z } from "zod";

const emptyAsUndefined = (value: unknown) => value === "" ? undefined : value;
const optionalString = z.preprocess(emptyAsUndefined, z.string().min(1).optional());
const optionalUrl = z.preprocess(emptyAsUndefined, z.string().url().optional());
const urlWithDefault = (fallback: string) => z.preprocess(emptyAsUndefined, z.string().url().default(fallback));

/**
 * Public Robinhood Chain (4663) JSON-RPC endpoints. Working hosts lead (publicnode / pocket / blxrbdn, not rate
 * limited). The official RPC and nodeflare are kept in the pool but last: both answered upstream 429s and must not
 * win a configured-order tie. The health-based picker also ranks any host with rateLimited > 0 behind clean ones.
 */
export const DEFAULT_ROBINHOOD_RPC_URLS = [
  "https://robinhood-rpc.publicnode.com",
  "https://robinhood.api.pocket.network",
  "https://robinhood.rpc.blxrbdn.com",
  "https://rpc-robinhood.blockmachine.io",
  "https://rpc.mainnet.chain.robinhood.com",
  "https://rpc.nodeflare.app/robinhood/public"
] as const;
const LEGACY_ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
/**
 * Robinhood Chain websocket endpoints that accepted every poller leg shape and matched HTTP eth_getLogs log-for-log over
 * 60 s windows (2026-09-07 23:14-23:45 IST, fixtures server/tape/robinhood/__fixtures__/r7/). Both deliver newHeads
 * every block and real blockTimestamps; blockmachine / blxrbdn / nodeflare websockets are unmeasured and left out.
 */
export const DEFAULT_ROBINHOOD_WS_URLS = [
  "wss://robinhood-rpc.publicnode.com",
  "wss://robinhood.api.pocket.network"
] as const;
const urlList = (fallback: readonly string[]) => z.preprocess(
  emptyAsUndefined,
  z.string().default(fallback.join(","))
    .transform((raw) => raw.split(",").map((part) => part.trim()).filter(Boolean))
    .pipe(z.array(z.string().url()).min(1))
);

const envSchema = z.object({
  NODE_ENV: z.preprocess(emptyAsUndefined, z.enum(["development", "test", "production"]).default("development")),
  HOST: optionalString,
  PORT: z.preprocess(emptyAsUndefined, z.coerce.number().int().positive().default(9300)),
  APP_ORIGIN: z.preprocess(emptyAsUndefined, z.string().default("http://localhost:5173")),
  FOMOSCAN_API_KEY: optionalString,
  /**
   * FomoScan units. The plan grant is monthly, does not roll over, and every read is priced: 250 CU for a thesis page
   * or any leaderboard, 2,500 to resolve a handle, 50,000 to resolve an unknown address. Shares are the fraction of
   * the grant each consumer may spend, released evenly across the UTC month; the burst is what a newly watched token
   * may spend at once. Defaults keep an unattended server inside a 250,000 CU starter plan.
   */
  FOMOSCAN_MONTHLY_UNITS: z.preprocess(emptyAsUndefined, z.coerce.number().int().nonnegative().default(250_000)),
  FOMOSCAN_THESIS_SHARE: z.preprocess(emptyAsUndefined, z.coerce.number().min(0).max(1).default(0.5)),
  FOMOSCAN_BOARD_SHARE: z.preprocess(emptyAsUndefined, z.coerce.number().min(0).max(1).default(0.1)),
  FOMOSCAN_BURST_UNITS: z.preprocess(emptyAsUndefined, z.coerce.number().int().nonnegative().default(5_000)),
  FOMOSCAN_BOARD_INTERVAL_MS: z.preprocess(emptyAsUndefined, z.coerce.number().int().positive().default(86_400_000)),
  CLAWPUMP_API_KEY: optionalString,
  CLAWPUMP_AGENT_ID: optionalString,
  CLAWPUMP_API_URL: urlWithDefault("https://ai-agents-production-6ca0.up.railway.app"),
  CLAWPUMP_MCP_ENABLED: z.preprocess(emptyAsUndefined, z.string().default("true")),
  JUPITER_API_KEY: optionalString,
  JUPITER_API_URL: urlWithDefault("https://lite-api.jup.ag/swap/v1"),
  ZEROEX_API_KEY: optionalString,
  ZEROEX_API_URL: urlWithDefault("https://api.0x.org"),
  HELIUS_API_KEY: optionalString,
  HELIUS_SOLANA_RPC_URL: optionalUrl,
  ALCHEMY_API_KEY: optionalString,
  ALCHEMY_SOLANA_RPC_URL: optionalUrl,
  /** Alias kept for one preferred endpoint: when set it leads the pool (and stays the snapshot fingerprint input). */
  ROBINHOOD_RPC_URL: optionalUrl,
  /** Comma-separated pool; ROBINHOOD_RPC_URL, when set, is prepended. Routing/backoff: tape/robinhood/endpoints.ts. */
  ROBINHOOD_RPC_URLS: urlList(DEFAULT_ROBINHOOD_RPC_URLS),
  /**
   * Logs-lane budget (tape/robinhood/logsLane.ts), measured 2026-09-07 22:00 IST on the official RPC with the real
   * 8-leg poller batch: 2 s and 5 s cadences drew 429s, 10 s drew none. Two pollers share the gap, so 5 s here is
   * ~10 s per poller (50 blocks of 0.1 s per tick, still continuous inside the 400-block window).
   */
  ROBINHOOD_LOGS_MIN_GAP_MS: z.preprocess(emptyAsUndefined, z.coerce.number().int().min(0).default(5_000)),
  ROBINHOOD_LOGS_MAX_GAP_MS: z.preprocess(emptyAsUndefined, z.coerce.number().int().min(0).default(30_000)),
  /** Websocket log transport (tape/robinhood/wsLogs.ts): "false" keeps the log pollers HTTP-only. */
  ROBINHOOD_WS_ENABLED: z.preprocess(emptyAsUndefined, z.string().default("true")),
  /** Comma-separated wss:// pool, tried in order and rotated on every reconnect. */
  ROBINHOOD_WS_URLS: urlList(DEFAULT_ROBINHOOD_WS_URLS),
  SNAPSHOT_DIR: z.preprocess(emptyAsUndefined, z.string().default(".cache/termeow")),
  SNAPSHOT_INTERVAL_MS: z.preprocess(emptyAsUndefined, z.coerce.number().int().positive().default(30_000)),
  PRIVY_APP_ID: optionalString,
  PRIVY_APP_SECRET: optionalString,
  ELEVENLABS_API_KEY: optionalString,
  ELEVENLABS_AGENT_ID: optionalString,
  ANSEM_MINT: z.preprocess(emptyAsUndefined, z.string().default("9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump")),
  USDC_MINT: z.preprocess(emptyAsUndefined, z.string().default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"))
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}
const env = parsed.data;

function rpcUrl(provider: "helius" | "alchemy") {
  if (provider === "helius") {
    return env.HELIUS_SOLANA_RPC_URL ||
      (env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : undefined);
  }
  return env.ALCHEMY_SOLANA_RPC_URL ||
    (env.ALCHEMY_API_KEY ? `https://solana-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}` : undefined);
}

export const config = {
  nodeEnv: env.NODE_ENV,
  host: env.HOST || (env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
  port: env.PORT,
  appOrigin: env.APP_ORIGIN,
  ansemMint: env.ANSEM_MINT,
  usdcMint: env.USDC_MINT,
  fomoscan: {
    apiKey: env.FOMOSCAN_API_KEY,
    monthlyUnits: env.FOMOSCAN_MONTHLY_UNITS,
    thesisShare: env.FOMOSCAN_THESIS_SHARE,
    boardShare: env.FOMOSCAN_BOARD_SHARE,
    burstUnits: env.FOMOSCAN_BURST_UNITS,
    boardIntervalMs: env.FOMOSCAN_BOARD_INTERVAL_MS
  },
  clawpump: {
    apiKey: env.CLAWPUMP_API_KEY,
    agentId: env.CLAWPUMP_AGENT_ID,
    apiUrl: env.CLAWPUMP_API_URL.replace(/\/$/, ""),
    mcpEnabled: env.CLAWPUMP_MCP_ENABLED.toLowerCase() === "true"
  },
  jupiter: {
    apiKey: env.JUPITER_API_KEY,
    apiUrl: env.JUPITER_API_URL.replace(/\/$/, "")
  },
  rpc: {
    primary: rpcUrl("helius") || "https://api.mainnet-beta.solana.com",
    fallback: rpcUrl("alchemy")
  },
  robinhood: {
    rpcUrl: env.ROBINHOOD_RPC_URL ?? LEGACY_ROBINHOOD_RPC_URL,
    rpcUrls: [...new Set([...(env.ROBINHOOD_RPC_URL ? [env.ROBINHOOD_RPC_URL] : []), ...env.ROBINHOOD_RPC_URLS])],
    logsLane: {
      minGapMs: env.ROBINHOOD_LOGS_MIN_GAP_MS,
      maxGapMs: env.ROBINHOOD_LOGS_MAX_GAP_MS
    },
    ws: {
      enabled: env.ROBINHOOD_WS_ENABLED.toLowerCase() === "true",
      urls: env.ROBINHOOD_WS_URLS
    }
  },
  /** Restart persistence (server/persist): per-component JSON snapshots, relative to cwd unless absolute. */
  snapshot: {
    dir: env.SNAPSHOT_DIR,
    intervalMs: env.SNAPSHOT_INTERVAL_MS
  },
  privy: {
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET
  },
  zeroEx: {
    apiKey: env.ZEROEX_API_KEY,
    apiUrl: env.ZEROEX_API_URL.replace(/\/$/, "")
  },
  elevenlabs: {
    apiKey: env.ELEVENLABS_API_KEY,
    agentId: env.ELEVENLABS_AGENT_ID
  }
};

export function integrationStatus() {
  return {
    clawpump: Boolean(config.clawpump.apiKey),
    fomoscan: Boolean(config.fomoscan.apiKey),
    clawpumpAgent: Boolean(config.clawpump.agentId),
    primaryRpc: config.rpc.primary.includes("api.mainnet-beta.solana.com") ? "public" : "helius",
    fallbackRpc: Boolean(config.rpc.fallback),
    privy: Boolean(config.privy.appId && config.privy.appSecret),
    voiceAgent: Boolean(config.elevenlabs.apiKey && config.elevenlabs.agentId),
    zeroEx: Boolean(config.zeroEx.apiKey)
  };
}
