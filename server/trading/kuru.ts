import { NATIVE_MON, isNativeMon } from "../../shared/chains.js";
import { UpstreamError, fetchJson } from "../lib/http.js";

/**
 * Kuru Flow: the Monad-native swap aggregator over Kuru's CLOB and AMM liquidity (docs.monad.xyz/guides/kuru-flow).
 * Keyless: POST /generate-token with the wallet address returns a short-lived bearer token, then POST /quote returns a
 * ready-to-sign transaction. Native MON is the zero address; calldata comes back without a 0x prefix. For an ERC-20
 * input the wallet approves `transaction.to` (the Kuru Flow router) for the exact amount before sending.
 */
export type KuruQuoteRequest = {
  userAddress: string;
  tokenIn: string;
  tokenOut: string;
  /** Smallest units of tokenIn, decimal string. */
  amount: string;
  slippageBps?: number;
  referrerAddress?: string;
  referrerFeeBps?: number;
};

export type KuruTransaction = { to: string; data: string; value: string };

export type KuruQuote = {
  output: string;
  minOut: string | null;
  transaction: KuruTransaction;
  gasPrices: Record<string, string> | null;
  raw: Record<string, unknown>;
};

type TokenEntry = { token: string; expiresAt: number };
type RawQuote = {
  status?: string;
  message?: string;
  output?: string | number;
  minOut?: string | number;
  transaction?: { to?: string; calldata?: string; data?: string; value?: string | number };
  gasPrices?: Record<string, string>;
};

/** Refresh a cached bearer token this long before its stated expiry. */
const TOKEN_MARGIN_MS = 30_000;
/** Used when /generate-token does not say when the token expires. */
const DEFAULT_TOKEN_TTL_MS = 5 * 60_000;
const TOKEN_CACHE_MAX = 500;

export type KuruClientOptions = { apiUrl: string; fetchJsonImpl?: typeof fetchJson; now?: () => number };

/** Kuru addresses native MON as 0x000…0; the desk and 0x use the 0xEeee… sentinel. */
export function kuruToken(address: string): string {
  return isNativeMon(address) ? NATIVE_MON : address.toLowerCase();
}

function prefixed(hex: string): string {
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}

function decimalString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)).toString() : null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return text;
  if (/^0x[0-9a-f]+$/i.test(text)) return BigInt(text).toString();
  return null;
}

export function parseKuruQuote(body: unknown): KuruQuote {
  const raw = (body && typeof body === "object" ? body : {}) as RawQuote;
  if (raw.status && raw.status !== "success") throw new UpstreamError(raw.message || `Kuru Flow returned status ${raw.status}`, 502, body);
  const to = raw.transaction?.to;
  const calldata = raw.transaction?.calldata ?? raw.transaction?.data;
  const output = decimalString(raw.output);
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to) || !calldata || output === null) throw new UpstreamError("Kuru Flow quote did not include an executable route", 502, body);
  return {
    output,
    minOut: decimalString(raw.minOut),
    transaction: { to: to.toLowerCase(), data: prefixed(calldata), value: decimalString(raw.transaction?.value) ?? "0" },
    gasPrices: raw.gasPrices ?? null,
    raw: raw as Record<string, unknown>
  };
}

export class KuruFlowClient {
  private readonly apiUrl: string;
  private readonly fetchJsonImpl: typeof fetchJson;
  private readonly now: () => number;
  private readonly tokens = new Map<string, TokenEntry>();

  constructor(opts: KuruClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.fetchJsonImpl = opts.fetchJsonImpl ?? fetchJson;
    this.now = opts.now ?? Date.now;
  }

  /** Bearer token per wallet, cached until shortly before it expires. */
  async token(userAddress: string): Promise<string> {
    const key = userAddress.toLowerCase();
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this.now()) return cached.token;
    const body = await this.fetchJsonImpl<{ token?: string; expires_at?: number | string }>(`${this.apiUrl}/generate-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_address: userAddress })
    });
    if (!body?.token) throw new UpstreamError("Kuru Flow did not issue a token", 502, body);
    const stated = typeof body.expires_at === "number" ? body.expires_at : Date.parse(String(body.expires_at ?? ""));
    // expires_at may be epoch seconds or an ISO string; anything unreadable falls back to a short default.
    const expiresAt = Number.isFinite(stated) ? (stated < 1e12 ? stated * 1000 : stated) : this.now() + DEFAULT_TOKEN_TTL_MS;
    this.tokens.set(key, { token: body.token, expiresAt });
    while (this.tokens.size > TOKEN_CACHE_MAX) this.tokens.delete(this.tokens.keys().next().value!);
    return body.token;
  }

  async quote(request: KuruQuoteRequest): Promise<KuruQuote> {
    const bearer = await this.token(request.userAddress);
    const body: Record<string, unknown> = {
      userAddress: request.userAddress,
      tokenIn: kuruToken(request.tokenIn),
      tokenOut: kuruToken(request.tokenOut),
      amount: request.amount
    };
    if (request.slippageBps) body.slippageTolerance = request.slippageBps;
    else body.autoSlippage = true;
    if (request.referrerAddress && request.referrerFeeBps) {
      body.referrerAddress = request.referrerAddress;
      body.referrerFeeBps = request.referrerFeeBps;
    }
    const result = await this.fetchJsonImpl<unknown>(`${this.apiUrl}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body)
    });
    return parseKuruQuote(result);
  }
}
