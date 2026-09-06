import "dotenv/config";
import { z } from "zod";

const emptyAsUndefined = (value: unknown) => value === "" ? undefined : value;
const optionalString = z.preprocess(emptyAsUndefined, z.string().min(1).optional());
const optionalUrl = z.preprocess(emptyAsUndefined, z.string().url().optional());
const urlWithDefault = (fallback: string) => z.preprocess(emptyAsUndefined, z.string().url().default(fallback));

const envSchema = z.object({
  NODE_ENV: z.preprocess(emptyAsUndefined, z.enum(["development", "test", "production"]).default("development")),
  HOST: optionalString,
  PORT: z.preprocess(emptyAsUndefined, z.coerce.number().int().positive().default(9300)),
  APP_ORIGIN: z.preprocess(emptyAsUndefined, z.string().default("http://localhost:5173")),
  CLAWPUMP_API_KEY: optionalString,
  CLAWPUMP_AGENT_ID: optionalString,
  CLAWPUMP_API_URL: urlWithDefault("https://ai-agents-production-6ca0.up.railway.app"),
  CLAWPUMP_MCP_ENABLED: z.preprocess(emptyAsUndefined, z.string().default("true")),
  JUPITER_API_KEY: optionalString,
  JUPITER_API_URL: urlWithDefault("https://lite-api.jup.ag/swap/v1"),
  HELIUS_API_KEY: optionalString,
  HELIUS_SOLANA_RPC_URL: optionalUrl,
  ALCHEMY_API_KEY: optionalString,
  ALCHEMY_SOLANA_RPC_URL: optionalUrl,
  ROBINHOOD_RPC_URL: urlWithDefault("https://rpc.mainnet.chain.robinhood.com"),
  PRIVY_APP_ID: optionalString,
  PRIVY_APP_SECRET: optionalString,
  ENABLE_MAINNET_EXECUTION: z.preprocess(emptyAsUndefined, z.string().default("false")),
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
  executionEnabled: env.ENABLE_MAINNET_EXECUTION.toLowerCase() === "true",
  ansemMint: env.ANSEM_MINT,
  usdcMint: env.USDC_MINT,
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
    rpcUrl: env.ROBINHOOD_RPC_URL
  },
  privy: {
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET
  }
};

export function integrationStatus() {
  return {
    clawpump: Boolean(config.clawpump.apiKey),
    clawpumpAgent: Boolean(config.clawpump.agentId),
    primaryRpc: config.rpc.primary.includes("api.mainnet-beta.solana.com") ? "public" : "helius",
    fallbackRpc: Boolean(config.rpc.fallback),
    privy: Boolean(config.privy.appId && config.privy.appSecret),
    executionEnabled: config.executionEnabled
  };
}
