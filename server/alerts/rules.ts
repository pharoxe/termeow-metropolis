import type {
  AlertFillEvidence,
  AlertRule,
  AlertRuleInfo,
  BigHandleEntryEvidence,
  Chain,
  FirstSmartBuyEvidence,
  GraduationEvidence,
  LaunchRow,
  TraderKind
} from "../../shared/wire.js";
import type { TraderFill } from "../traders/walletStats.js";

/** A launch row younger than this at the fill's chain time counts as fresh. */
export const LAUNCH_FRESH_MS = 30 * 60_000;
/** Follower floor for big_handle_entry; 0 on Monad, where the label (Nansen cohort or watchlist) is the signal, not followers. */
export const BIG_FOLLOWERS = 0;
/**
 * rpc:monad createdAt is estimateBlockTimeMs (~300 ms/block from the poll head, clamped to now); a fill whose
 * block timestamp lands a few seconds before that estimate is still a fill on that launch, not a leak.
 */
export const CREATED_AT_SLACK_MS = 5_000;
/** Sources that mean "this server saw the create event on chain"; rows first seen through enrichment (dexscreener) never make a launch fresh. */
const CHAIN_LAUNCH_SOURCES: readonly string[] = ["rpc:monad"];
/** Only rows with these sources carry an estimated createdAt. */
const ESTIMATED_CREATED_AT_SOURCES: readonly string[] = ["rpc:monad"];
/**
 * Kinds a big_handle_entry may name: classified smart money only; a seeded wallet's check is still pending and the ring row is immutable.
 */
const BIG_HANDLE_KINDS: readonly TraderKind[] = ["smart"];

/** Smart-money fills come from the Monad trader book (Nansen labels + watchlist). */
export const ALERT_RULES: readonly AlertRuleInfo[] = [
  {
    rule: "first_smart_buy",
    chains: ["monad"],
    description: `first verified-SMART buy this server recorded (arrival order; untimed fills are dropped upstream) of a token whose launch row is younger than ${LAUNCH_FRESH_MS / 60_000} min at the fill's block time`
  },
  {
    rule: "big_handle_entry",
    chains: ["monad"],
    description: "first fill (per the book, since its oldest fill) of a Nansen-labelled or watched wallet in a token"
  },
  { rule: "graduation", chains: ["monad"], description: "decoded nad.fun graduation (CurveGraduate) of a token with smart-money fills in the book" }
];

export const ALERT_RULE_NAMES = ALERT_RULES.map((info) => info.rule) as [AlertRule, ...AlertRule[]];

export function rulesFor(chain: "all" | Chain): AlertRuleInfo[] {
  return ALERT_RULES.filter((info) => chain === "all" || info.chains.includes(chain)).map((info) => ({ ...info, chains: [...info.chains] }));
}

export function alertId(rule: AlertRule, chain: Chain, token: string, wallet?: string): string {
  return wallet === undefined ? `${rule}:${chain}:${token}` : `${rule}:${chain}:${token}:${wallet}`;
}

export function hasChainLaunchSource(sources: readonly string[] | undefined): boolean {
  return (sources ?? []).some((source) => CHAIN_LAUNCH_SOURCES.includes(source));
}

export function createdAtEstimated(row: Pick<LaunchRow, "sources">): boolean {
  return row.sources.some((source) => ESTIMATED_CREATED_AT_SOURCES.includes(source));
}

/** Chain time on both sides: fill block time minus the row's createdAt. Negative within CREATED_AT_SLACK_MS is estimate error. */
export function launchAgeMs(row: Pick<LaunchRow, "createdAt">, atMs: number): number {
  return atMs - row.createdAt;
}

export function isFreshLaunch(row: Pick<LaunchRow, "createdAt" | "sources">, atMs: number, freshMs: number = LAUNCH_FRESH_MS): boolean {
  if (!hasChainLaunchSource(row.sources)) return false;
  if (!Number.isFinite(atMs) || !Number.isFinite(row.createdAt)) return false;
  const age = launchAgeMs(row, atMs);
  return age >= -CREATED_AT_SLACK_MS && age < freshMs;
}

/** Verified SMART only: a seeded wallet's buy is never the first SMART buy. */
export function isSmartBuy(fill: Pick<TraderFill, "kind" | "side">): boolean {
  return fill.kind === "smart" && fill.side === "buy";
}

export type BigHandleFill = TraderFill & { handle: string; followers: number | null };

export function isBigHandle(fill: TraderFill, floor: number = BIG_FOLLOWERS): fill is BigHandleFill {
  return (
    typeof fill.handle === "string" &&
    fill.handle.length > 0 &&
    (floor <= 0 || (typeof fill.followers === "number" && Number.isFinite(fill.followers) && fill.followers >= floor)) &&
    fill.kind !== undefined &&
    fill.kind !== null &&
    BIG_HANDLE_KINDS.includes(fill.kind)
  );
}

export function fillEvidence(fill: TraderFill): AlertFillEvidence {
  return {
    tx: fill.tx,
    wallet: fill.trader,
    kind: fill.kind ?? null,
    handle: fill.handle ?? null,
    followers: fill.followers ?? null,
    side: fill.side,
    usd: fill.usd,
    ...(fill.usdVia ? { usdVia: fill.usdVia } : {})
  };
}

export function firstSmartBuyEvidence(row: LaunchRow, fill: TraderFill): FirstSmartBuyEvidence {
  return {
    launchpad: row.launchpad,
    createdAt: row.createdAt,
    createdAtEstimated: createdAtEstimated(row),
    launchAgeMs: launchAgeMs(row, fill.time),
    launchTx: row.tx,
    fill: fillEvidence(fill)
  };
}

/** `bookSince` = book.oldestFillAt() at firing: the temporal bound of "first fill per the book". */
export function bigHandleEvidence(fill: BigHandleFill, bookSince: number | null): BigHandleEntryEvidence {
  return { ...fillEvidence(fill), handle: fill.handle, followers: fill.followers, bookSince };
}

export function graduationEvidence(row: LaunchRow, smartFills: number): GraduationEvidence {
  return { launchpad: row.launchpad, pool: row.pool, launchTx: row.tx, graduationTx: null, smartFills };
}
