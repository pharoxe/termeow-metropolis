import { errorMessage, fetchJson } from "../../lib/http.js";
import { MONAD_MAINNET, NATIVE_MON } from "../../../shared/chains.js";

const DEXSCREENER_TOKENS_BASE = "https://api.dexscreener.com/tokens/v1";
/** DexScreener accepts up to 30 comma-separated addresses per tokens/v1 call. */
export const TOKENS_PER_CALL = 30;
const DEFAULT_TTL_MS = 60_000;
/** Hard ceiling on how old a cached quote may be before get() stops returning it. */
export const STALE_MAX_MS = 5 * 60_000;

/** Circle USDC on Monad (6 decimals): the deepest USD quote on Uniswap and Kuru. */
export const USDC_ADDRESS = MONAD_MAINNET.tokens.usdc;
/** Agora AUSD on Monad: Kuru's MON-AUSD book and Perpl collateral quote in it. */
export const AUSD_ADDRESS = MONAD_MAINNET.tokens.ausd ?? "";
/** Wrapped MON: native-MON quotes (Uniswap v4 currency 0x0, nad.fun curves) are priced as WMON. */
export const WMON_ADDRESS = MONAD_MAINNET.tokens.wmon;
const DEFAULT_STABLE_ADDRESSES = [USDC_ADDRESS, AUSD_ADDRESS].filter(Boolean);

/** Native MON has no contract to look up; its usd is WMON's. */
function priceKey(address: string): string {
  const key = address.toLowerCase();
  return key === NATIVE_MON ? WMON_ADDRESS : key;
}

export type PriceFetch = (url: string) => Promise<unknown>;

export type EvmQuotePriceOptions = {
  chain: "monad";
  ttlMs?: number;
  fetchImpl?: PriceFetch;
  now?: () => number;
  stableAddresses?: string[];
};

export type EvmQuotePriceStatus = { cached: number; lastOkAt: number | null; lastError: string | null };

type Entry = { usd: number; fetchedAt: number };
type Candidate = { usd: number; liquidityUsd: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function addressOf(side: unknown): string {
  return isRecord(side) && typeof side.address === "string" ? side.address.toLowerCase() : "";
}

/** The token's usd on this pair: priceUsd when it is the base, priceUsd/priceNative when it is the quote. */
function candidateFor(pair: Record<string, unknown>, wanted: Set<string>): [string, Candidate] | null {
  const priceUsd = positive(pair.priceUsd);
  if (priceUsd === null) return null;
  const liquidityUsd = (isRecord(pair.liquidity) && positive(pair.liquidity.usd)) || 0;
  const base = addressOf(pair.baseToken);
  if (wanted.has(base)) return [base, { usd: priceUsd, liquidityUsd }];
  const quote = addressOf(pair.quoteToken);
  const priceNative = positive(pair.priceNative);
  if (wanted.has(quote) && priceNative !== null) return [quote, { usd: priceUsd / priceNative, liquidityUsd }];
  return null;
}

/** DexScreener tokens/v1 body: an array of pairs where each wanted token may sit on either side. Highest liquidity wins. */
export function parseDexScreenerTokenPrices(body: unknown, wanted: Set<string>, chain: string): Map<string, number> {
  const best = new Map<string, Candidate>();
  if (!Array.isArray(body)) return new Map();
  for (const raw of body) {
    if (!isRecord(raw) || raw.chainId !== chain) continue;
    const candidate = candidateFor(raw, wanted);
    if (!candidate) continue;
    const [address, next] = candidate;
    const current = best.get(address);
    if (!current || next.liquidityUsd > current.liquidityUsd) best.set(address, next);
  }
  return new Map([...best].map(([address, { usd }]) => [address, usd]));
}

export function dexScreenerTokensUrl(chain: string, addresses: string[]): string {
  return `${DEXSCREENER_TOKENS_BASE}/${chain}/${addresses.map(encodeURIComponent).join(",")}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}

/**
 * Quote-token usd for Monad from DexScreener tokens/v1, keyed by lowercase address.
 * Native MON (address 0) is priced as WMON; a token on the quote side is priced as priceUsd / priceNative.
 */
export class EvmQuotePrice {
  private readonly chain: string;
  private readonly ttlMs: number;
  private readonly fetchImpl: PriceFetch;
  private readonly now: () => number;
  private readonly stable: Set<string>;
  private readonly entries = new Map<string, Entry>();
  private lastOkAt: number | null = null;
  private lastError: string | null = null;
  /** address -> the request currently fetching it; overlapping primes join it instead of re-fetching. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(opts: EvmQuotePriceOptions) {
    this.chain = opts.chain;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = opts.fetchImpl ?? ((url) => fetchJson<unknown>(url, { headers: { Accept: "application/json" } }));
    this.now = opts.now ?? (() => Date.now());
    this.stable = new Set((opts.stableAddresses ?? DEFAULT_STABLE_ADDRESSES).map((address) => address.toLowerCase()));
  }

  /** One tokens/v1 call per 30 non-stable addresses that are unknown or past ttl; in-flight ones are joined. Never throws. */
  async prime(rawQuotes: string[]): Promise<void> {
    const quotes = rawQuotes.map(priceKey);
    this.rememberStables(quotes);
    const wanted = this.needsFetch(quotes);
    const pending = wanted.flatMap((address) => this.inFlight.get(address) ?? []);
    const fresh = wanted.filter((address) => !this.inFlight.has(address));
    await Promise.all([...pending, ...chunk(fresh, TOKENS_PER_CALL).map((batch) => this.launch(batch))]);
  }

  /** Stables are a known price (1) and must show up in status.cached; get() already returns 1 without a fetch. */
  private rememberStables(quotes: string[]): void {
    const now = this.now();
    let stored = false;
    for (const quote of quotes) {
      const address = quote.toLowerCase();
      if (!this.stable.has(address) || this.entries.has(address)) continue;
      this.entries.set(address, { usd: 1, fetchedAt: now });
      stored = true;
    }
    if (stored) this.lastOkAt = now;
  }

  /** 1 for stables; cached usd while younger than STALE_MAX_MS; null otherwise. */
  get(quote: string): number | null {
    const address = priceKey(quote);
    if (this.stable.has(address)) return 1;
    const entry = this.entries.get(address);
    if (!entry) return null;
    return this.ageOf(entry) < STALE_MAX_MS ? entry.usd : null;
  }

  status(): EvmQuotePriceStatus {
    return { cached: this.entries.size, lastOkAt: this.lastOkAt, lastError: this.lastError };
  }

  private needsFetch(quotes: string[]): string[] {
    const unique = new Set(quotes.map((quote) => quote.toLowerCase()).filter((address) => address !== "" && !this.stable.has(address)));
    return [...unique].filter((address) => {
      const entry = this.entries.get(address);
      return !entry || this.ageOf(entry) >= this.ttlMs;
    });
  }

  private launch(addresses: string[]): Promise<void> {
    const request = this.fetchInto(addresses);
    for (const address of addresses) this.inFlight.set(address, request);
    return request;
  }

  private async fetchInto(addresses: string[]): Promise<void> {
    try {
      const body = await this.fetchImpl(dexScreenerTokensUrl(this.chain, addresses));
      this.store(parseDexScreenerTokenPrices(body, new Set(addresses), this.chain));
    } catch (error) {
      this.lastError = errorMessage(error);
    } finally {
      for (const address of addresses) this.inFlight.delete(address);
    }
  }

  private store(prices: Map<string, number>): void {
    const fetchedAt = this.now();
    for (const [address, usd] of prices) this.entries.set(address, { usd, fetchedAt });
    this.lastOkAt = fetchedAt;
    this.lastError = null;
  }

  private ageOf(entry: Entry): number {
    return this.now() - entry.fetchedAt;
  }
}
