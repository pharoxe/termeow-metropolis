import type { AlertEngineStats, AlertRow, AlertRule, Chain, SmartCoverage, LaunchRow } from "../../shared/wire.js";
import { LruMap } from "../traders/lru.js";
import type { TraderFill } from "../traders/walletStats.js";
import { AlertRing, type AlertListQuery, type AlertRingOptions } from "./ring.js";
import {
  BIG_FOLLOWERS,
  LAUNCH_FRESH_MS,
  alertId,
  bigHandleEvidence,
  firstSmartBuyEvidence,
  graduationEvidence,
  hasChainLaunchSource,
  isBigHandle,
  isSmartBuy,
  isFreshLaunch
} from "./rules.js";
import type { AlertEvent } from "./sink.js";

/** Tokens remembered as "a SMART buy was already judged here" so a later buy never poses as the first one. */
const SMART_BUY_SEEN_MAX = 20_000;

export type AlertEngineDeps = {
  /** The launch row as the index holds it now; null when the token is unknown to this server. */
  launchOf(chain: Chain, token: string): LaunchRow | null;
  /** Fills of this wallet in this token as the book holds them now (the fill just recorded included). */
  walletTokenFills(chain: Chain, wallet: string, token: string): number;
  /** Verified-SMART fills of the token in the book now (ring-bounded). */
  smartFillsOf(chain: Chain, token: string): number;
  /** Oldest fill still in the book (chain ms): the temporal bound of every "per the book" answer; null when empty. */
  oldestFillAt(): number | null;
  /** SMART coverage as of firing (TraderService.coverage()). */
  coverage(): SmartCoverage;
  symbolOf?(chain: Chain, token: string): string | null;
  now(): number;
  freshMs?: number;
  bigFollowers?: number;
  ring?: AlertRingOptions;
  log?: (msg: string) => void;
};

/** An alert before the engine stamps observedAt, symbol and coverage; distributes over the rule union so evidence stays typed per rule. */
type Draft<R> = R extends AlertRow ? Pick<R, "id" | "chain" | "token" | "time" | "rule" | "evidence"> : never;
type AlertDraft = Draft<AlertRow>;

function zeroByRule(): Record<AlertRule, number> {
  return { first_smart_buy: 0, big_handle_entry: 0, graduation: 0 };
}

function tokenKey(chain: Chain, token: string): string {
  return `${chain}:${token}`;
}

/**
 * Turns sink events into AlertRows on the producer's tick (no timer, no polling): every rule is a pure predicate over
 * the event plus the book/index as they stand, the ring dedupes by id. Nothing here throws to a producer.
 */
export class AlertEngine {
  readonly ring: AlertRing;
  private readonly deps: AlertEngineDeps;
  private readonly freshMs: number;
  private readonly bigFollowers: number;
  private readonly log: (msg: string) => void;
  private readonly smartBuySeen = new LruMap<string, true>(SMART_BUY_SEEN_MAX);
  /**
   * First SMART buy per token whose launch row was not yet known on chain when it arrived. The transfer feed and the
   * launch poller run independently, so the buy can land first; the token is NOT latched in smartBuySeen until a
   * chain-sourced row exists, and onLaunch judges the remembered buy against the row when it arrives.
   */
  private readonly pendingFirstBuy = new LruMap<string, TraderFill>(SMART_BUY_SEEN_MAX);
  private seen = { fills: 0, launches: 0, graduations: 0 };
  private fired = zeroByRule();
  private suppressed = zeroByRule();
  private errors = 0;
  private lastError: string | null = null;

  constructor(deps: AlertEngineDeps) {
    this.deps = deps;
    this.ring = new AlertRing(deps.ring);
    this.freshMs = deps.freshMs ?? LAUNCH_FRESH_MS;
    this.bigFollowers = deps.bigFollowers ?? BIG_FOLLOWERS;
    this.log = deps.log ?? ((msg) => console.warn(msg));
  }

  /** Sink listener: dispatches one event; a rule failure is counted and logged, never rethrown. */
  handle(event: AlertEvent): AlertRow[] {
    try {
      if (event.kind === "fill") return this.onFill(event.fill);
      if (event.kind === "graduation") {
        const row = this.onGraduation(event.row, event.at);
        return row ? [row] : [];
      }
      const row = this.onLaunch(event.row);
      return row ? [row] : [];
    } catch (error) {
      this.errors += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log(`alert engine: ${event.kind}: ${this.lastError}`);
      return [];
    }
  }

  /** A launch is not evidence of anything SMART did; it only settles a first SMART buy that arrived before the row did. */
  onLaunch(row: LaunchRow): AlertRow | null {
    this.seen = { ...this.seen, launches: this.seen.launches + 1 };
    const pending = this.pendingFirstBuy.get(tokenKey(row.chain, row.token.toLowerCase()));
    return pending ? this.judgeFirstSmartBuy(pending, row) : null;
  }

  /** One accepted book fill may satisfy first_smart_buy and big_handle_entry at once; both are returned. */
  onFill(fill: TraderFill): AlertRow[] {
    this.seen = { ...this.seen, fills: this.seen.fills + 1 };
    const out: AlertRow[] = [];
    const fresh = this.firstSmartBuy(fill);
    if (fresh) out.push(fresh);
    const big = this.bigHandleEntry(fill);
    if (big) out.push(big);
    return out;
  }

  onGraduation(row: LaunchRow, at: number): AlertRow | null {
    this.seen = { ...this.seen, graduations: this.seen.graduations + 1 };
    const smartFills = this.deps.smartFillsOf(row.chain, row.token.toLowerCase());
    if (smartFills < 1) return this.decline("graduation");
    return this.fire({
      id: alertId("graduation", row.chain, row.token.toLowerCase()),
      chain: row.chain,
      token: row.token.toLowerCase(),
      time: at,
      rule: "graduation",
      evidence: graduationEvidence(row, smartFills)
    });
  }

  list(query: AlertListQuery): AlertRow[] {
    return this.ring.list(query);
  }

  stats(): AlertEngineStats {
    return { seen: { ...this.seen }, fired: { ...this.fired }, suppressed: { ...this.suppressed }, errors: this.errors, lastError: this.lastError };
  }

  /**
   * The first SMART buy this server sees in a token decides the rule once a chain-sourced launch row exists: fresh fires,
   * stale is remembered so a later buy cannot fire. With no such row yet the buy is parked (see pendingFirstBuy).
   */
  private firstSmartBuy(fill: TraderFill): AlertRow | null {
    if (!isSmartBuy(fill)) return null;
    const key = tokenKey(fill.chain, fill.token);
    if (this.smartBuySeen.has(key)) return this.decline("first_smart_buy");
    const row = this.deps.launchOf(fill.chain, fill.token);
    if (!row || !hasChainLaunchSource(row.sources)) {
      if (!this.pendingFirstBuy.has(key)) this.pendingFirstBuy.set(key, fill);
      return this.decline("first_smart_buy");
    }
    return this.judgeFirstSmartBuy(this.pendingFirstBuy.get(key) ?? fill, row);
  }

  /** Latches the token, then fires only when the (earliest known) buy sits inside the freshness window of the row. */
  private judgeFirstSmartBuy(fill: TraderFill, row: LaunchRow): AlertRow | null {
    const key = tokenKey(fill.chain, fill.token);
    this.pendingFirstBuy.delete(key);
    if (this.smartBuySeen.has(key)) return this.decline("first_smart_buy");
    this.smartBuySeen.set(key, true);
    if (!isFreshLaunch(row, fill.time, this.freshMs)) return this.decline("first_smart_buy");
    return this.fire({
      id: alertId("first_smart_buy", fill.chain, fill.token),
      chain: fill.chain,
      token: fill.token,
      time: fill.time,
      rule: "first_smart_buy",
      evidence: firstSmartBuyEvidence(row, fill)
    });
  }

  /** "No earlier fill in this token" is asked of the book at firing: at most the fill just recorded may be there. */
  private bigHandleEntry(fill: TraderFill): AlertRow | null {
    if (!isBigHandle(fill, this.bigFollowers)) return null;
    if (this.deps.walletTokenFills(fill.chain, fill.trader, fill.token) > 1) return this.decline("big_handle_entry");
    return this.fire({
      id: alertId("big_handle_entry", fill.chain, fill.token, fill.trader),
      chain: fill.chain,
      token: fill.token,
      time: fill.time,
      rule: "big_handle_entry",
      evidence: bigHandleEvidence(fill, this.deps.oldestFillAt())
    });
  }

  private fire(draft: AlertDraft): AlertRow | null {
    if (this.ring.has(draft.id)) return this.decline(draft.rule);
    const row: AlertRow = {
      ...draft,
      observedAt: this.deps.now(),
      symbol: this.deps.symbolOf?.(draft.chain, draft.token) ?? null,
      coverage: this.deps.coverage()
    };
    if (!this.ring.push(row)) return this.decline(draft.rule);
    this.fired = { ...this.fired, [draft.rule]: this.fired[draft.rule] + 1 };
    return row;
  }

  private decline(rule: AlertRule): null {
    this.suppressed = { ...this.suppressed, [rule]: this.suppressed[rule] + 1 };
    return null;
  }
}
