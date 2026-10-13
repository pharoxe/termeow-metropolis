import "dotenv/config";
import { z } from "zod";
import { MONAD_NETWORKS, type MonadNetwork } from "../shared/chains.js";

const emptyAsUndefined = (value: unknown) => value === "" ? undefined : value;
const optionalString = z.preprocess(emptyAsUndefined, z.string().min(1).optional());
const optionalUrl = z.preprocess(emptyAsUndefined, z.string().url().optional());
const urlWithDefault = (fallback: string) => z.preprocess(emptyAsUndefined, z.string().url().default(fallback));

/**
 * Monad network profile (shared/chains.ts). MONAD_NETWORK=testnet switches every default below to Monad testnet (10143);
 * explicit MONAD_RPC_URL(S) / MONAD_WS_URLS still win.
 */
const MONAD_NETWORK_NAME: MonadNetwork = process.env.MONAD_NETWORK === "testnet" ? "testnet" : "mainnet";
export const MONAD_PROFILE = MONAD_NETWORKS[MONAD_NETWORK_NAME];
/** Public Monad JSON-RPC endpoints (docs.monad.xyz network-information): QuickNode, Alchemy, Ankr, Monad Foundation, Goldsky. */
export const DEFAULT_MONAD_RPC_URLS = MONAD_PROFILE.rpcUrls;
/** Public Monad websocket endpoints; all accept eth_subscribe("logs" | "newHeads"). */
export const DEFAULT_MONAD_WS_URLS = MONAD_PROFILE.wsUrls;
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
  /** Kuru Flow aggregator (docs.monad.xyz/guides/kuru-flow): keyless, a per-wallet bearer token from /generate-token. */
  KURU_API_URL: urlWithDefault("https://ws.kuru.io/api"),
  /** Optional referrer fee on Kuru Flow quotes (bps, 0-100) paid to KURU_REFERRER_ADDRESS. */
  KURU_REFERRER_ADDRESS: optionalString,
  KURU_REFERRER_FEE_BPS: z.preprocess(emptyAsUndefined, z.coerce.number().int().min(0).max(100).default(0)),
  ZEROEX_API_KEY: optionalString,
  ZEROEX_API_URL: urlWithDefault("https://api.0x.org"),
  /** Alias kept for one preferred endpoint: when set it leads the pool (and stays the snapshot fingerprint input). */
  MONAD_RPC_URL: optionalUrl,
  /** Comma-separated pool; MONAD_RPC_URL, when set, is prepended. Routing/backoff: tape/monad/endpoints.ts. */
  MONAD_RPC_URLS: urlList(DEFAULT_MONAD_RPC_URLS),
  MONAD_NETWORK: z.preprocess(emptyAsUndefined, z.enum(["mainnet", "testnet"]).default("mainnet")),
  /**
   * Logs-lane budget (tape/monad/logsLane.ts). rpc.monad.xyz allows 25 req/s and 100-block eth_getLogs; at 300 ms
   * blocks one poller needs one ~100-block request every 30 s, so a 1.5 s floor leaves room for backfills and both pollers.
   */
  MONAD_LOGS_MIN_GAP_MS: z.preprocess(emptyAsUndefined, z.coerce.number().int().min(0).default(1_500)),
  MONAD_LOGS_MAX_GAP_MS: z.preprocess(emptyAsUndefined, z.coerce.number().int().min(0).default(20_000)),
  /** Websocket log transport (tape/monad/wsLogs.ts): "false" keeps the log pollers HTTP-only. */
  MONAD_WS_ENABLED: z.preprocess(emptyAsUndefined, z.string().default("true")),
  /** Comma-separated wss:// pool, tried in order and rotated on every reconnect. */
  MONAD_WS_URLS: urlList(DEFAULT_MONAD_WS_URLS),
  SNAPSHOT_DIR: z.preprocess(emptyAsUndefined, z.string().default(".cache/termeow")),
  SNAPSHOT_INTERVAL_MS: z.preprocess(emptyAsUndefined, z.coerce.number().int().positive().default(30_000)),
  DATABASE_URL: optionalString,
  PRIVY_APP_ID: optionalString,
  PRIVY_APP_SECRET: optionalString,
  /** Public key-quorum ID and policy ID are safe identifiers; the PKCS8 key is server-only. */
  PRIVY_AUTOMATION_SIGNER_ID: optionalString,
  PRIVY_AUTOMATION_POLICY_ID: optionalString,
  PRIVY_AUTOMATION_AUTH_PRIVATE_KEY: optionalString,
  AUTOMATION_TRIGGER_SECRET: optionalString,
  AUTOMATION_INGRESS_URL: urlWithDefault("https://termeow-automation-ingress.anabilmahanta.workers.dev"),
  AUTOMATION_INGRESS_SECRET: optionalString,
  /** Nansen API (docs.nansen.ai): smart-money netflow / DEX trades / wallet labels on chain "monad". */
  NANSEN_API_KEY: optionalString,
  NANSEN_API_URL: urlWithDefault("https://api.nansen.ai/api/v1"),
  /** How often the smart-money population is refreshed from Nansen DEX trades (each refresh is one paid call). */
  NANSEN_REFRESH_MS: z.preprocess(emptyAsUndefined, z.coerce.number().int().min(60_000).default(600_000)),
  /** nad.fun REST (github.com/Naddotfun/api-intergration); 10 req/min keyless, 100 with NADFUN_API_KEY. */
  NADFUN_API_URL: urlWithDefault("https://api.nad.fun"),
  NADFUN_API_KEY: optionalString,
  /** Perpl perps DEX REST base; defaults to the selected network's (mainnet https://app.perpl.xyz/api). */
  PERPL_API_URL: optionalUrl,
  ELEVENLABS_API_KEY: optionalString,
  ELEVENLABS_AGENT_ID: optionalString,
  TWITTERAPI_IO_API_KEY: optionalString,
  TWITTERAPI_IO_POLL_MS: z.preprocess(emptyAsUndefined, z.coerce.number().int().min(15_000).default(60_000)),
  /** Token the desk opens on first visit; WMON (the MON market) unless overridden. */
  FEATURED_TOKEN: z.preprocess(emptyAsUndefined, z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional()),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}
const env = parsed.data;

export const config = {
  nodeEnv: env.NODE_ENV,
  host: env.HOST || (env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
  port: env.PORT,
  appOrigin: env.APP_ORIGIN,
  network: MONAD_PROFILE,
  featuredToken: (env.FEATURED_TOKEN ?? MONAD_PROFILE.tokens.wmon).toLowerCase(),
  monad: {
    rpcUrl: env.MONAD_RPC_URL ?? MONAD_PROFILE.rpcUrls[0],
    rpcUrls: [...new Set([...(env.MONAD_RPC_URL ? [env.MONAD_RPC_URL] : []), ...env.MONAD_RPC_URLS])],
    logsLane: {
      minGapMs: env.MONAD_LOGS_MIN_GAP_MS,
      maxGapMs: env.MONAD_LOGS_MAX_GAP_MS
    },
    ws: {
      enabled: env.MONAD_WS_ENABLED.toLowerCase() === "true",
      urls: env.MONAD_WS_URLS
    }
  },
  /** Restart persistence (server/persist): per-component JSON snapshots, relative to cwd unless absolute. */
  snapshot: {
    dir: env.SNAPSHOT_DIR,
    intervalMs: env.SNAPSHOT_INTERVAL_MS
  },
  database: {
    url: env.NODE_ENV === "test" ? undefined : env.DATABASE_URL
  },
  privy: {
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    automationSignerId: env.PRIVY_AUTOMATION_SIGNER_ID,
    automationPolicyId: env.PRIVY_AUTOMATION_POLICY_ID,
    automationAuthPrivateKey: env.PRIVY_AUTOMATION_AUTH_PRIVATE_KEY,
    automationTriggerSecret: env.AUTOMATION_TRIGGER_SECRET
  },
  automationIngress: {
    url: env.AUTOMATION_INGRESS_URL.replace(/\/$/, ""),
    secret: env.AUTOMATION_INGRESS_SECRET
  },
  kuru: {
    apiUrl: env.KURU_API_URL.replace(/\/$/, ""),
    referrerAddress: env.KURU_REFERRER_ADDRESS,
    referrerFeeBps: env.KURU_REFERRER_FEE_BPS
  },
  nansen: {
    apiKey: env.NANSEN_API_KEY,
    apiUrl: env.NANSEN_API_URL.replace(/\/$/, ""),
    refreshMs: env.NANSEN_REFRESH_MS
  },
  nadfun: {
    apiUrl: env.NADFUN_API_URL.replace(/\/$/, ""),
    apiKey: env.NADFUN_API_KEY
  },
  perpl: {
    apiUrl: (env.PERPL_API_URL ?? MONAD_PROFILE.perpl.api).replace(/\/$/, "")
  },
  zeroEx: {
    apiKey: env.ZEROEX_API_KEY,
    apiUrl: env.ZEROEX_API_URL.replace(/\/$/, "")
  },
  elevenlabs: {
    apiKey: env.ELEVENLABS_API_KEY,
    agentId: env.ELEVENLABS_AGENT_ID
  },
  twitterApi: { apiKey: env.TWITTERAPI_IO_API_KEY, pollMs: env.TWITTERAPI_IO_POLL_MS }
};

export function integrationStatus() {
  return {
    network: MONAD_PROFILE.network,
    chainId: MONAD_PROFILE.chainId,
    monadRpc: config.monad.rpcUrls.length,
    kuru: true,
    nansen: Boolean(config.nansen.apiKey),
    nadfun: true,
    perpl: true,
    privy: Boolean(config.privy.appId && config.privy.appSecret),
    privyAutomation: Boolean(config.privy.appId && config.privy.appSecret && config.privy.automationSignerId && config.privy.automationPolicyId && config.privy.automationAuthPrivateKey && config.privy.automationTriggerSecret),
    voiceAgent: Boolean(config.elevenlabs.apiKey && config.elevenlabs.agentId),
    database: Boolean(config.database.url),
    zeroEx: Boolean(config.zeroEx.apiKey),
    twitterApi: Boolean(config.twitterApi.apiKey),
    automationIngress: Boolean(config.automationIngress.secret)
  };
}
