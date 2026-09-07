import { describe, expect, it } from "vitest";
import type { RobinhoodOwnTapeStats } from "../tape/robinhood/ownTape.js";
import type { OwnTapeStats } from "../tape/solana/ownTape.js";
import type { OwnSourceHealth, SourceHealth } from "./collector.js";
import { allSourcesDown, feedHealthOf, OWN_FRESH_MS, ownFeedHealth, ownTapeHealthy } from "./feedHealth.js";

const NOW = 1_800_000_000_000;
const RH: RobinhoodOwnTapeStats = {
  prints: 2, undecoded: 0, untimed: 0, lastPrintAt: NOW - 500, tokens: 1, pools: 1, lastError: null,
  poller: { cursor: 10, head: 10, polls: 1, logs: 2, dropped: 0, errors: 1, lastError: "rpc 429 rate limited", lastOkAt: NOW - 2000, rpcCalls: 1, blockedUntil: null },
  blocks: { cached: 1, inFlight: 0, hits: 1, misses: 1, failures: 0, lastError: null },
  price: { cached: 1, lastOkAt: NOW, lastError: null },
  resolve: { lastError: null, decimalsCached: 2 }
};
const SOL: OwnTapeStats = {
  prints: 3, unattributed: 1, skipped: 0, lastPrintAt: NOW - 1000, mints: 1, lastError: null,
  subscriber: { connected: true, mints: 1, reconnects: 0, lastFrameAt: NOW - 500, lastError: null },
  reader: { queued: 0, inFlight: false, read: 3, dropped: 0, missing: 0, rateLimited: 0, maxQueueSeen: 1, lastError: null },
  price: { cached: 1, lastOkAt: NOW - 2000, lastError: null }
};
const own = (tape: OwnSourceHealth["tape"], extra: Partial<OwnSourceHealth> = {}): OwnSourceHealth => ({ lastOkAt: tape?.lastPrintAt ?? null, lastError: null, lastErrorAt: null, tape, ...extra });
const ok: SourceHealth = { lastOkAt: NOW - 3000, lastError: null, lastErrorAt: NOW - 60_000 };
const failed: SourceHealth = { lastOkAt: NOW - 30_000, lastError: "GeckoTerminal request budget exhausted", lastErrorAt: NOW - 1000 };
const never: SourceHealth = { lastOkAt: null, lastError: null, lastErrorAt: null };

describe("ownFeedHealth", () => {
  it("calls a robinhood poller healthy on a recent ok poll even with a stale lastError, and reads its backoff as nextRetryAt", () => {
    expect(ownFeedHealth(own(RH), NOW)).toEqual({ ok: true, lastOkAt: NOW - 2000, lastError: null, nextRetryAt: null });
    const blocked = own({ ...RH, poller: { ...RH.poller, blockedUntil: NOW + 8000 } }, { lastError: "rpc 429 rate limited" });
    expect(ownFeedHealth(blocked, NOW)).toEqual({ ok: false, lastOkAt: NOW - 2000, lastError: "rpc 429 rate limited", nextRetryAt: NOW + 8000 });
    expect(ownFeedHealth(own({ ...RH, poller: { ...RH.poller, blockedUntil: NOW - 1 } }), NOW).nextRetryAt).toBeNull();
  });

  it("goes unhealthy once the last ok poll is older than OWN_FRESH_MS, when the tape faulted, or when untracked", () => {
    expect(ownTapeHealthy(own(RH), NOW - 2000 + OWN_FRESH_MS)).toBe(true);
    expect(ownTapeHealthy(own(RH), NOW - 2000 + OWN_FRESH_MS + 1)).toBe(false);
    expect(ownTapeHealthy(own(RH, { lastError: "tape down", lastErrorAt: NOW }), NOW)).toBe(false);
    expect(ownFeedHealth(own(null), NOW)).toEqual({ ok: false, lastOkAt: null, lastError: null, nextRetryAt: null });
  });

  it("uses the subscriber connection for a solana tape and never reports a retry time there", () => {
    expect(ownFeedHealth(own(SOL), NOW)).toEqual({ ok: true, lastOkAt: NOW - 500, lastError: null, nextRetryAt: null });
    const offline = own({ ...SOL, subscriber: { ...SOL.subscriber, connected: false, lastFrameAt: null } });
    expect(ownFeedHealth(offline, NOW)).toEqual({ ok: false, lastOkAt: NOW - 1000, lastError: null, nextRetryAt: null });
  });
});

describe("feedHealthOf / allSourcesDown", () => {
  it("marks a polled source ok only when its last attempt succeeded, and carries the global gecko block as nextRetryAt", () => {
    const health = feedHealthOf({ sources: { pumpfun: never, geckoterminal: ok }, own: own(RH), geckoBlockedUntil: null, now: NOW });
    expect(health.gecko).toEqual({ ok: true, lastOkAt: NOW - 3000, lastError: null, nextRetryAt: null });
    expect(health.pumpfun).toEqual({ ok: false, lastOkAt: null, lastError: null, nextRetryAt: null });
    expect(allSourcesDown(health)).toBe(false);
    const blocked = feedHealthOf({ sources: { pumpfun: never, geckoterminal: ok }, own: own(null), geckoBlockedUntil: NOW + 20_000, now: NOW });
    expect(blocked.gecko).toEqual({ ok: false, lastOkAt: NOW - 3000, lastError: null, nextRetryAt: NOW + 20_000 });
    expect(allSourcesDown(blocked)).toBe(true);
  });

  it("is all-down when gecko last failed, pumpfun never ran and the own poller is backing off", () => {
    const backingOff = own({ ...RH, poller: { ...RH.poller, blockedUntil: NOW + 30_000 } }, { lastError: "rpc 429 rate limited" });
    const health = feedHealthOf({ sources: { pumpfun: never, geckoterminal: failed }, own: backingOff, geckoBlockedUntil: null, now: NOW });
    expect(health).toEqual({
      own: { ok: false, lastOkAt: NOW - 2000, lastError: "rpc 429 rate limited", nextRetryAt: NOW + 30_000 },
      gecko: { ok: false, lastOkAt: NOW - 30_000, lastError: "GeckoTerminal request budget exhausted", nextRetryAt: null },
      pumpfun: { ok: false, lastOkAt: null, lastError: null, nextRetryAt: null }
    });
    expect(allSourcesDown(health)).toBe(true);
  });
});
