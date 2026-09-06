import { errorMessage, fetchJson } from "../../lib/http.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCdyfy1Ma7z";

const JUP_PRICE_URL = "https://lite-api.jup.ag/price/v3";
const DEFAULT_TTL_MS = 30_000;
/** Hard ceiling on how old a cached quote may be before get() stops returning it. */
export const STALE_MAX_MS = 5 * 60_000;
const DEFAULT_STABLE_MINTS = [USDC_MINT, USDT_MINT];

export type PriceFetch = (url: string) => Promise<unknown>;

export type QuotePriceCacheOptions = {
  ttlMs?: number;
  fetchImpl?: PriceFetch;
  now?: () => number;
  stableMints?: string[];
};

export type QuotePriceStatus = { cached: number; lastOkAt: number | null; lastError: string | null };

type Entry = { usd: number; fetchedAt: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Jupiter price v3 body: { "<mint>": { usdPrice, ... } }. Rows without a finite usdPrice are skipped. */
export function parseJupiterPrices(body: unknown): Map<string, number> {
  const prices = new Map<string, number>();
  if (!isRecord(body)) return prices;
  for (const [mint, row] of Object.entries(body)) {
    if (!isRecord(row)) continue;
    const usd = Number(row.usdPrice);
    if (Number.isFinite(usd) && usd > 0) prices.set(mint, usd);
  }
  return prices;
}

export function jupiterPriceUrl(mints: string[]): string {
  return `${JUP_PRICE_URL}?ids=${mints.map(encodeURIComponent).join(",")}`;
}

export class QuotePriceCache {
  private readonly ttlMs: number;
  private readonly fetchImpl: PriceFetch;
  private readonly now: () => number;
  private readonly stable: Set<string>;
  private readonly entries = new Map<string, Entry>();
  private lastOkAt: number | null = null;
  private lastError: string | null = null;
  /** mint -> the Jupiter request currently fetching it; overlapping primes join it instead of re-fetching. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(opts: QuotePriceCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = opts.fetchImpl ?? ((url) => fetchJson<unknown>(url));
    this.now = opts.now ?? (() => Date.now());
    this.stable = new Set(opts.stableMints ?? DEFAULT_STABLE_MINTS);
  }

  /** One Jupiter call for every non-stable mint that is unknown or past ttl; mints already in flight join that request. Never throws. */
  async prime(mints: string[]): Promise<void> {
    const wanted = this.needsFetch(mints);
    const pending = wanted.flatMap((mint) => this.inFlight.get(mint) ?? []);
    const fresh = wanted.filter((mint) => !this.inFlight.has(mint));
    await Promise.all(fresh.length > 0 ? [...pending, this.launch(fresh)] : pending);
  }

  /** 1 for stable mints; cached usd while younger than STALE_MAX_MS; null otherwise. */
  get(mint: string): number | null {
    if (this.stable.has(mint)) return 1;
    const entry = this.entries.get(mint);
    if (!entry) return null;
    return this.ageOf(entry) < STALE_MAX_MS ? entry.usd : null;
  }

  status(): QuotePriceStatus {
    return { cached: this.entries.size, lastOkAt: this.lastOkAt, lastError: this.lastError };
  }

  private needsFetch(mints: string[]): string[] {
    const unique = new Set(mints.filter((mint) => mint !== "" && !this.stable.has(mint)));
    return [...unique].filter((mint) => {
      const entry = this.entries.get(mint);
      return !entry || this.ageOf(entry) >= this.ttlMs;
    });
  }

  private launch(mints: string[]): Promise<void> {
    const request = this.fetchInto(mints);
    for (const mint of mints) this.inFlight.set(mint, request);
    return request;
  }

  private async fetchInto(mints: string[]): Promise<void> {
    try {
      const body = await this.fetchImpl(jupiterPriceUrl(mints));
      this.store(parseJupiterPrices(body));
    } catch (error) {
      this.lastError = errorMessage(error);
    } finally {
      for (const mint of mints) this.inFlight.delete(mint);
    }
  }

  private store(prices: Map<string, number>): void {
    const fetchedAt = this.now();
    for (const [mint, usd] of prices) this.entries.set(mint, { usd, fetchedAt });
    this.lastOkAt = fetchedAt;
    this.lastError = null;
  }

  private ageOf(entry: Entry): number {
    return this.now() - entry.fetchedAt;
  }
}
