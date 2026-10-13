import type { FeedHealth, FeedSourceHealth } from "../../shared/wire.js";
import type { OwnHealthStats, OwnSourceHealth, SourceHealth, SourceName } from "./collector.js";

/**
 * The own poller counts as healthy while its last successful poll is at most this old and no backoff is pending. One
 * bad cycle is a 15 s RPC abort plus a 20 s endpoint backoff, so 30 s flapped ok/down between reads; 60 s rides it out.
 */
export const OWN_FRESH_MS = 60_000;
export const POLLED_FRESH_MS = 180_000;

export type FeedHealthInput = {
  sources: Record<SourceName, SourceHealth>;
  own: OwnSourceHealth;
  /** Global GeckoTerminal 429 block (gecko.geckoBlockedUntilMs), null when not blocked. */
  geckoBlockedUntil: number | null;
  now: number;
};

function retryAt(until: number | null | undefined, now: number): number | null {
  return typeof until === "number" && until > now ? until : null;
}

/** A polled source is ok when its last attempt succeeded (fail() sets lastError, ok() clears it) and no backoff is pending. */
function polledHealth(source: SourceHealth, nextRetryAt: number | null, now: number): FeedSourceHealth {
  return {
    ok: nextRetryAt === null && source.lastOkAt !== null && now - source.lastOkAt <= POLLED_FRESH_MS && source.lastError === null,
    lastOkAt: source.lastOkAt,
    lastError: source.lastError,
    nextRetryAt
  };
}

/** Last successful transport round trip of the own tape; null when never. */
function ownLastOkAt(tape: OwnHealthStats | null): number | null {
  if (!tape) return null;
  return tape.poller.lastOkAt ?? tape.lastPrintAt;
}

/** The log poller's backoff deadline, when it is backing off. */
function ownNextRetryAt(tape: OwnHealthStats | null, now: number): number | null {
  if (!tape) return null;
  return retryAt(tape.poller.blockedUntil, now);
}

/**
 * Own-tape health: the Monad log poller is healthy when it polled successfully within OWN_FRESH_MS and is not backing
 * off. A tape fault (own.lastErrorAt set) or an untracked token is unhealthy.
 */
function ownFresh(tape: OwnHealthStats | null, lastOkAt: number | null, now: number): boolean {
  if (!tape) return false;
  return lastOkAt !== null && now - lastOkAt <= OWN_FRESH_MS;
}

export function ownFeedHealth(own: OwnSourceHealth, now: number): FeedSourceHealth {
  const lastOkAt = ownLastOkAt(own.tape);
  const nextRetryAt = ownNextRetryAt(own.tape, now);
  const faulted = own.lastErrorAt !== null;
  return { ok: !faulted && nextRetryAt === null && ownFresh(own.tape, lastOkAt, now), lastOkAt, lastError: own.lastError, nextRetryAt };
}

export function ownTapeHealthy(own: OwnSourceHealth, now: number): boolean {
  return ownFeedHealth(own, now).ok;
}

export function feedHealthOf(input: FeedHealthInput): FeedHealth {
  return {
    own: ownFeedHealth(input.own, input.now),
    gecko: polledHealth(input.sources.geckoterminal, retryAt(input.geckoBlockedUntil, input.now), input.now)
  };
}

/** True when no print source is ok: the ledger ring is then last-good data, not a live feed. */
export function allSourcesDown(health: FeedHealth): boolean {
  return !health.own.ok && !health.gecko.ok;
}
