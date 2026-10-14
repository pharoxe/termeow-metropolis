import { Container, getContainer } from "@cloudflare/containers";
import { lockPage } from "./lock";

/** Server secrets forwarded into the container's environment (see server/config.ts); unset ones are left out. */
const APP_SECRETS = [
  "DATABASE_URL",
  "MONAD_RPC_URL",
  "COINGECKO_API_KEY",
  "COINGECKO_API_PLAN",
  "PRIVY_APP_ID",
  "PRIVY_APP_SECRET",
  "PRIVY_AUTOMATION_SIGNER_ID",
  "PRIVY_AUTOMATION_POLICY_ID",
  "PRIVY_AUTOMATION_AUTH_PRIVATE_KEY",
  "AUTOMATION_TRIGGER_SECRET",
  "AUTOMATION_INGRESS_SECRET",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_AGENT_ID",
  "ZEROEX_API_KEY",
  "NANSEN_API_KEY",
  "NADFUN_API_KEY",
  "TWITTERAPI_IO_API_KEY"
] as const;

type AppSecret = (typeof APP_SECRETS)[number];

interface Env extends Partial<Record<AppSecret, string>> {
  APP: DurableObjectNamespace<TermeowApp>;
  GATE_LIMITER: RateLimit;
  GATE_PASSWORD: string;
  GATE_SECRET: string;
  APP_ORIGIN: string;
  AUTOMATION_INGRESS_URL: string;
}

export class TermeowApp extends Container<Env> {
  defaultPort = 9300;
  sleepAfter = "20m";
  pingEndpoint = "localhost/api/health";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const secrets = Object.fromEntries(APP_SECRETS.flatMap((key) => (env[key] ? [[key, env[key] as string]] : [])));
    this.envVars = {
      ...secrets,
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      PORT: "9300",
      APP_ORIGIN: env.APP_ORIGIN,
      AUTOMATION_INGRESS_URL: env.AUTOMATION_INGRESS_URL,
      SNAPSHOT_DIR: "/tmp/termeow/snapshots"
    };
  }

  /**
   * A running container keeps the environment it started with, and the keep-alive cron means it never sleeps, so a
   * new secret would otherwise never arrive. Restart once whenever the environment's fingerprint changes.
   */
  override async fetch(request: Request): Promise<Response> {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(this.envVars)));
    const fingerprint = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const stored = await this.ctx.storage.get<string>(ENV_FINGERPRINT);
    if (stored !== fingerprint) {
      const { status } = await this.getState();
      console.log(`[container] environment changed (${Object.keys(this.envVars ?? {}).sort().join(",")}); state ${status}, restarting`);
      if (status === "running" || status === "healthy") {
        await this.stop();
        for (let attempt = 0; attempt < 40 && !(await this.getState()).status.startsWith("stopped"); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      await this.ctx.storage.put(ENV_FINGERPRINT, fingerprint);
    }
    return super.fetch(request);
  }
}

const ENV_FINGERPRINT = "env-fingerprint";

const COOKIE = "termeow_gate";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();

const app = (env: Env) => getContainer(env.APP, "termeow");

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameBytes(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** A session cookie is `<expiry seconds>.<hmac(expiry)>`; nothing else is stored anywhere. */
async function hasSession(request: Request, env: Env): Promise<boolean> {
  const [expiry, signature] = (cookieValue(request, COOKIE) ?? "").split(".");
  if (!expiry || !signature || Number(expiry) * 1000 < Date.now()) return false;
  return sameBytes(encoder.encode(signature), encoder.encode(await hmacHex(env.GATE_SECRET, expiry)));
}

async function passwordMatches(candidate: string, env: Env): Promise<boolean> {
  const [a, b] = await Promise.all([candidate, env.GATE_PASSWORD].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  return sameBytes(a, b);
}

/** Only same-site paths survive the round trip through the lock page. */
function safeNext(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/__gate") ? value : "/";
}

function html(body: string, status: number, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
      ...headers
    }
  });
}

async function unlock(request: Request, env: Env): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const next = safeNext(form?.get("next"));
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  // The limiter only slows guessing; if it is unavailable the password check below still stands.
  const allowed = await env.GATE_LIMITER.limit({ key: ip }).then((outcome) => outcome.success, (error) => (console.error("gate limiter", error), true));
  if (!allowed) return html(lockPage({ next, error: "too many attempts — wait a minute" }), 429);
  const password = form?.get("password");
  if (typeof password !== "string" || !(await passwordMatches(password, env))) {
    return html(lockPage({ next, error: "access denied" }), 401);
  }
  const expiry = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
  const cookie = `${COOKIE}=${expiry}.${await hmacHex(env.GATE_SECRET, expiry)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
  return new Response(null, { status: 303, headers: { location: next, "set-cookie": cookie, "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Machine callers: the automation queue authenticates to the server with its own bearer secret.
    if (url.pathname.startsWith("/api/internal/")) return app(env).fetch(request);
    if (url.pathname === "/__gate" && request.method === "POST") return unlock(request, env);
    if (url.pathname === "/__gate/lock") {
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
    }
    if (await hasSession(request, env)) return app(env).fetch(request);
    if (url.pathname.startsWith("/api/") || request.headers.get("upgrade")?.toLowerCase() === "websocket" || request.method !== "GET") {
      return Response.json({ error: "locked" }, { status: 401, headers: { "cache-control": "no-store" } });
    }
    return html(lockPage({ next: safeNext(url.pathname + url.search) }), 401);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(app(env).fetch(new Request(`${env.APP_ORIGIN}/api/health`)).then((response) => response.body?.cancel()));
  }
} satisfies ExportedHandler<Env>;
