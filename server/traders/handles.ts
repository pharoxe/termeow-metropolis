import { errorMessage } from "../lib/http.js";
import { isAddress } from "../tape/robinhood/rpc.js";

export const TRADERS_URL = "https://robinhoodtrenches.com/api/traders?window=all&limit=500";
export const TAPE_URL = "https://robinhoodtrenches.com/api/tape?limit=200";
export const TRADERS_TTL_MS = 60 * 60_000;
export const TAPE_TTL_MS = 15 * 60_000;
/** A failed feed load is retried after this instead of on every get(). */
export const HANDLES_RETRY_MS = 60_000;
/** Unofficial community site; every handle shown must be labelled with this population. */
export const HANDLES_POPULATION = "robinhoodtrenches handles";
/** fomo.family has no public API: handles link out only. */
export const FOMO_PROFILE_BASE = "https://fomo.family/profile/";
const FETCH_TIMEOUT_MS = 15_000;

export type HandleSource = "traders" | "tape" | "learned";
export type HandleEntry = { handle: string; followers: number | null; profileUrl: string | null; source: HandleSource };
export type HandleSourceStatus = { rows: number; lastOkAt: number | null; lastError: string | null };
export type HandleBookStats = {
  entries: number;
  population: typeof HANDLES_POPULATION;
  traders: HandleSourceStatus;
  tape: HandleSourceStatus;
  learned: number;
};

export type HandleBookOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  tradersUrl?: string;
  tapeUrl?: string;
  tradersTtlMs?: number;
  tapeTtlMs?: number;
};

type FeedName = Exclude<HandleSource, "learned">;
type Feed = { name: FeedName; url: string; ttlMs: number; nextAt: number; status: HandleSourceStatus };
type Row = { address: string; entry: HandleEntry };

/** A richer source never loses to a poorer one; a source refreshing itself overwrites its own rows. */
const RANK: Record<HandleSource, number> = { traders: 3, tape: 2, learned: 1 };

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function profileUrlFor(handle: string): string {
  return `${FOMO_PROFILE_BASE}${encodeURIComponent(handle)}`;
}

function normalizeRow(raw: unknown, source: FeedName): Row | null {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!row) return null;
  const address = textOrNull(source === "traders" ? row.address : row.wallet)?.toLowerCase() ?? "";
  const handle = textOrNull(row.handle);
  if (!isAddress(address) || handle === null) return null;
  const profileUrl = source === "traders" ? (textOrNull(row.profile_url) ?? profileUrlFor(handle)) : profileUrlFor(handle);
  return { address, entry: { handle, followers: finiteOrNull(row.followers), profileUrl, source } };
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`upstream returned ${response.status}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Lowercase wallet -> handle from robinhoodtrenches: the traders list (147 rows, refreshed hourly) plus the recent tape
 * (wallet + handle + followers per fill, refreshed every 15 min), plus handles learned from tape rows the server saw
 * itself. get() is synchronous and schedules a background refresh when a feed is due; a failed load keeps the
 * last-good entries and records lastError. Nothing here throws.
 */
export class HandleBook {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly feeds: Feed[];
  private readonly entries = new Map<string, HandleEntry>();
  private inFlight: Promise<void> | null = null;

  constructor(opts: HandleBookOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    const status = (): HandleSourceStatus => ({ rows: 0, lastOkAt: null, lastError: null });
    this.feeds = [
      { name: "traders", url: opts.tradersUrl ?? TRADERS_URL, ttlMs: opts.tradersTtlMs ?? TRADERS_TTL_MS, nextAt: 0, status: status() },
      { name: "tape", url: opts.tapeUrl ?? TAPE_URL, ttlMs: opts.tapeTtlMs ?? TAPE_TTL_MS, nextAt: 0, status: status() }
    ];
  }

  /** Known handle for the wallet, or null; kicks off a background refresh when a feed is due. */
  get(address: string): HandleEntry | null {
    if (this.feeds.some((feed) => this.now() >= feed.nextAt)) void this.refresh();
    return this.entries.get(address.trim().toLowerCase()) ?? null;
  }

  /** A handle seen on a tape row this server processed; fills gaps, never overrides a feed entry. */
  learn(address: string, handle: string, followers: number | null): void {
    const key = address.trim().toLowerCase();
    const name = textOrNull(handle);
    if (!isAddress(key) || name === null) return;
    this.merge(key, { handle: name, followers: finiteOrNull(followers), profileUrl: profileUrlFor(name), source: "learned" });
  }

  /** Loads every feed that is due (all of them when `force`); one refresh in flight at a time; never rejects. */
  refresh(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const due = this.feeds.filter((feed) => force || this.now() >= feed.nextAt);
    if (due.length === 0) return Promise.resolve();
    this.inFlight = Promise.all(due.map((feed) => this.loadFeed(feed)))
      .then(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  stats(): HandleBookStats {
    const [traders, tape] = this.feeds.map((feed) => ({ ...feed.status }));
    const learned = [...this.entries.values()].filter((entry) => entry.source === "learned").length;
    return { entries: this.entries.size, population: HANDLES_POPULATION, traders, tape, learned };
  }

  private merge(address: string, entry: HandleEntry): void {
    const existing = this.entries.get(address);
    if (existing && RANK[existing.source] > RANK[entry.source]) return;
    this.entries.set(address, entry);
  }

  private async loadFeed(feed: Feed): Promise<void> {
    try {
      const body = await getJson(this.fetchImpl, feed.url);
      if (!Array.isArray(body)) throw new Error("feed body is not an array");
      const rows = body.map((raw) => normalizeRow(raw, feed.name)).filter((row): row is Row => row !== null);
      for (const row of rows) this.merge(row.address, row.entry);
      feed.status = { rows: rows.length, lastOkAt: this.now(), lastError: null };
      feed.nextAt = this.now() + feed.ttlMs;
    } catch (error) {
      feed.status = { ...feed.status, lastError: `${feed.name}: ${errorMessage(error)}` };
      feed.nextAt = this.now() + HANDLES_RETRY_MS;
    }
  }
}
