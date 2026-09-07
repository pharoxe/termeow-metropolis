import type {
  AlertFillEvidence,
  AlertRule,
  AlertRuleInfo,
  BigHandleEntryEvidence,
  Chain,
  FirstFomoBuyEvidence,
  GraduationEvidence,
  LaunchRow,
  TraderKind
} from "../../shared/wire.js";
import type { TraderFill } from "../traders/walletStats.js";

/** A launch row younger than this at the fill's chain time counts as fresh. */
export const LAUNCH_FRESH_MS = 30 * 60_000;
/** robinhoodtrenches follower floor for big_handle_entry. */
export const BIG_FOLLOWERS = 10_000;
/**
 * rpc:robinhood createdAt is estimateBlockTimeMs (100.7 ms/block from the poll head, clamped to now); a fill whose
 * block timestamp lands a few seconds before that estimate is still a fill on that launch, not a leak.
 */
export const CREATED_AT_SLACK_MS = 5_000;
/** Sources that mean "this server saw the create event on chain"; rows first seen through enrichment (dexscreener, trenches) never make a launch fresh. */
const CHAIN_LAUNCH_SOURCES: readonly string[] = ["rpc:robinhood", "pumpportal"];
/** Only rows with these sources carry an estimated createdAt; PumpPortal frames carry their own timestamp. */
const ESTIMATED_CREATED_AT_SOURCES: readonly string[] = ["rpc:robinhood"];
/**
 * Kinds a big_handle_entry may name: verified FOMO only. A seeded wallet's check is still pending (it may prove "other"),
 * and the live window showed 43 of 57 alerts on pending wallets from bundled multi-wallet txs; the ring row is immutable.
 */
const BIG_HANDLE_KINDS: readonly TraderKind[] = ["fomo"];

/** FOMO fills are Robinhood-only by construction (eth_getCode 7702 check); no rule has real evidence on Solana yet. */
export const ALERT_RULES: readonly AlertRuleInfo[] = [
  {
    rule: "first_fomo_buy",
    chains: ["robinhood"],
    description: `first verified-FOMO buy this server recorded (arrival order; untimed fills are dropped upstream) of a token whose launch row is younger than ${LAUNCH_FRESH_MS / 60_000} min at the fill's block time`
  },
  {
    rule: "big_handle_entry",
    chains: ["robinhood"],
    description: `first fill (per the book, since its oldest fill) of a verified-FOMO robinhoodtrenches handle with >= ${BIG_FOLLOWERS.toLocaleString("en-US")} followers in a token`
  },
  { rule: "graduation", chains: ["robinhood"], description: "decoded graduation (Pons LaunchSwept / PoolGraduated) of a token with verified-FOMO fills in the book" }
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

/** Verified FOMO only: a seeded wallet's buy is never the first FOMO buy. */
export function isFomoBuy(fill: Pick<TraderFill, "kind" | "side">): boolean {
  return fill.kind === "fomo" && fill.side === "buy";
}

export type BigHandleFill = TraderFill & { handle: string; followers: number };

export function isBigHandle(fill: TraderFill, floor: number = BIG_FOLLOWERS): fill is BigHandleFill {
  return (
    typeof fill.handle === "string" &&
    fill.handle.length > 0 &&
    typeof fill.followers === "number" &&
    Number.isFinite(fill.followers) &&
    fill.followers >= floor &&
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

export function firstFomoBuyEvidence(row: LaunchRow, fill: TraderFill): FirstFomoBuyEvidence {
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

export function graduationEvidence(row: LaunchRow, fomoFills: number): GraduationEvidence {
  return { launchpad: row.launchpad, pool: row.pool, launchTx: row.tx, graduationTx: null, fomoFills };
}
