import type { AlertRow, AlertRule, Chain } from "../../shared/wire.js";
import { LruMap } from "../traders/lru.js";

export const DEFAULT_ALERT_RING = 500;
/** Ids remembered past ring eviction so an alert that scrolled out of the ring never fires again in this process. */
const DEFAULT_DEDUPE_IDS = 5_000;

export type AlertRingOptions = { max?: number; dedupe?: number };

export type AlertListQuery = {
  chain: "all" | Chain;
  /** Only alerts observed after this wall-clock ms (the client's last poll); chain time can trail by an hour. */
  since?: number;
  rule?: AlertRule;
  limit?: number;
};

/** Bounded, insertion-ordered alert store: `push` dedupes on the row id, `list` answers newest first. */
export class AlertRing {
  readonly max: number;
  private readonly rows: AlertRow[] = [];
  private readonly seen: LruMap<string, true>;

  constructor(opts: AlertRingOptions = {}) {
    this.max = Math.max(1, Math.floor(opts.max ?? DEFAULT_ALERT_RING));
    this.seen = new LruMap(Math.max(this.max, Math.floor(opts.dedupe ?? DEFAULT_DEDUPE_IDS)));
  }

  /** False when an alert with the same id already fired (this process). */
  push(row: AlertRow): boolean {
    if (this.seen.has(row.id)) return false;
    this.seen.set(row.id, true);
    this.rows.push(row);
    if (this.rows.length > this.max) this.rows.splice(0, this.rows.length - this.max);
    return true;
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  list(query: AlertListQuery): AlertRow[] {
    const limit = query.limit === undefined ? this.max : Math.max(0, Math.floor(query.limit));
    const out: AlertRow[] = [];
    for (let i = this.rows.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const row = this.rows[i];
      if (query.chain !== "all" && row.chain !== query.chain) continue;
      if (query.since !== undefined && !(row.observedAt > query.since)) continue;
      if (query.rule !== undefined && row.rule !== query.rule) continue;
      out.push(row);
    }
    return out;
  }

  size(): { size: number; max: number } {
    return { size: this.rows.length, max: this.max };
  }
}
