import type { BoardKind, IdentityCoverage, TraderRanking } from "../../shared/identity";
import type { Tone } from "./deskFlow";
import { durationLabel, EM_DASH, printAgeLabel } from "./flowPanel";
import { shortAddress, signedMoney } from "./format";

/**
 * Pure derivations for the SMART MONEY tab (GET /api/identity/*). No React, no Date.now(): callers pass `now`.
 * Every label carries the population it was drawn from, and no unreported number is ever rendered as a zero.
 */

/**
 * The server refreshes a board at most once a day, the collector ticks once a minute and /v2/me is re-read every five
 * minutes, so at most three payload changes exist per 24h. 60s is the fastest poll that can ever see something new;
 * anything quicker re-reads the same stored snapshot.
 */
export const IDENTITY_POLL_MS = 60_000;

/** A board read costs 250 CU (resolving one unknown address costs 50,000) — the unit the budget copy is measured in. */
const BOARD_CALL_CU = 250;

/**
 * When a board's own sample stops describing the window it names. These are 24h, 7d and weekly rankings that upstream
 * recaptures at most daily, so a day plus an hour of grace is generous. This measures upstream's capture age, not this
 * server's read cadence: on 2026-09-08 the fomoscan boards carried capturedAt 2026-09-03 19:42Z — 4.8 days of sample
 * age — while this server had read them at 15:27Z the same day with the meter unthrottled (2,600 CU released, 750
 * spent, 0 refusals). Upstream had not recaptured, which is exactly what this flag exists to show.
 */
const BOARD_STALE_MS = 25 * 3_600_000;

/**
 * How far the open leg has to outweigh the taken one before a row is called paper. On the weekly pump board read at
 * 2026-09-08 the top two rows sit at 1,638x and 152x (rank 1 is -$1,152.81 taken against +$1,887,929.67 open) while
 * rank 3 sits at 1.14x with both legs real; 4x separates them with room on either side.
 */
const PAPER_DOMINANT_RATIO = 4;

export type BoardChoice = { board: BoardKind; window: string; label: string };

/**
 * Exactly the three boards server/routes/identity.ts collects. The two sources measure different things and the label
 * has to say which: the FomoScan sweep ranks 316,007 wallets on realized PnL, pump.fun ranks its own traders on
 * realized plus unrealized.
 */
export const BOARD_CHOICES: readonly BoardChoice[] = [
  { board: "fomoscan-traders", window: "24h", label: "FOMOSCAN SWEEP 24H" },
  { board: "fomoscan-traders", window: "7d", label: "FOMOSCAN SWEEP 7D" },
  { board: "pump-traders", window: "weekly", label: "PUMP.FUN BOARD WEEKLY" }
];

/**
 * What each board's `rank` was computed on, which the rows cannot show on their own. The pump board orders on the sum,
 * so its live weekly realized column climbs down the ranking — -$1.15K, +$9.58K, +$538.5K, +$1.29M across ranks 1-4,
 * with 18 of its 100 rows carrying a negative taken leg. Unstated, the order reads as a ranking of the number beside it.
 */
const RANKED_ON: Record<BoardKind, string> = {
  "fomoscan-traders": "ranked on realized PnL",
  "pump-traders": "ranked on realized + unrealized"
};

/**
 * 4…4, delegating the slice to shortAddress so the rule has one definition; an absent wallet is an em-dash rather than
 * "not connected". The blank coercion is not dead: api.identityCoverage casts its payload instead of parsing it.
 */
export function shortWallet(wallet: string): string {
  const value = wallet == null ? "" : String(wallet).trim();
  if (!value) return EM_DASH;
  return value.length <= 11 ? value : shortAddress(value);
}

/** Average hold from the board. durationLabel floors at 1s, so a measured zero hold is written out, not rounded up. */
export function holdLabel(seconds: number | null): string {
  const value = finite(seconds);
  if (value == null || value < 0) return EM_DASH;
  return value === 0 ? "0s" : durationLabel(value * 1000);
}

/**
 * A 0 win rate is a measured result and prints as 0%; only an unreported rate is an em-dash. A rate that rounds down to
 * zero without being zero prints "<1%" instead: the 7d board carries a wallet with 1,314 trades, where four wins is
 * 0.3%, and "0%" there would claim a wallet that never won one.
 */
export function winRateLabel(rate: number | null): string {
  const value = finite(rate);
  if (value == null) return EM_DASH;
  const percent = Math.round(value * 100);
  return value > 0 && percent === 0 ? "<1%" : `${percent}%`;
}

/** Age of the wallet's first upstream sighting. Every row on the 2026-09-08 boards carries null here: unreported, not new. */
export function walletAgeLabel(firstSeenAt: number | null, now: number): string {
  return printAgeLabel(firstSeenAt, now);
}

export type PnlSplit = { realized: string; unrealized: string | null; paperDominant: boolean; tone: Tone; title: string };

/**
 * The two PnL legs kept apart. The pump board's `pnlUsd` is realized plus unrealized and is routinely almost entirely
 * unrealized, so the taken leg is the headline and the open leg travels beside it, marked when it dominates. The
 * combined figure appears only in the title, and only where both legs are known to add up to it.
 */
export function pnlSplit(row: TraderRanking): PnlSplit {
  const realizedUsd = finite(row?.realizedPnlUsd);
  const unrealizedUsd = finite(row?.unrealizedPnlUsd);
  const paperDominant = unrealizedUsd != null && unrealizedUsd !== 0 &&
    (realizedUsd == null || Math.abs(unrealizedUsd) > Math.abs(realizedUsd) * PAPER_DOMINANT_RATIO);
  return {
    realized: realizedUsd == null ? EM_DASH : signedMoney(realizedUsd),
    unrealized: unrealizedUsd == null ? null : signedMoney(unrealizedUsd),
    paperDominant,
    tone: realizedUsd == null || realizedUsd === 0 ? "" : realizedUsd > 0 ? "up" : "dn",
    title: pnlTitle(row, realizedUsd, unrealizedUsd, paperDominant)
  };
}

function pnlTitle(row: TraderRanking, realizedUsd: number | null, unrealizedUsd: number | null, paperDominant: boolean): string {
  const total = finite(row?.pnlUsd);
  const openLeg = row?.board === "fomoscan-traders"
    ? "unrealized not measured by the FomoScan sweep, which reports realized PnL only"
    : "unrealized not reported by this board";
  const parts = [
    realizedUsd == null ? "realized not reported by this board" : `realized ${signedMoney(realizedUsd, false)} (taken)`,
    unrealizedUsd == null ? openLeg : `unrealized ${signedMoney(unrealizedUsd, false)} (open, not taken)`
  ];
  // The sum is only ever named where both legs are known, so a one-legged board can never look like it netted out.
  if (total != null && realizedUsd != null && unrealizedUsd != null) parts.push(`board total ${signedMoney(total, false)} = realized + unrealized`);
  if (paperDominant) parts.push("the open leg dominates — a mark-to-market position, not a result");
  // The rank in the cell beside this one is the board's, and pump ranked it on the sum: say so where the legs are read.
  if (row?.board === "pump-traders") parts.push("this board ranks on realized + unrealized, not on the taken leg");
  return parts.join(" · ");
}

/**
 * Age of the board's own capture instant, which is not this server's read time: the boards table keeps `capturedAt` and
 * `observedAt` apart because they run days apart, and the tab prints the read clock from `observedAt` beside this. So
 * the verb here is "captured" — calling a 4.8-day-old upstream sample a 4.8-day-old read would blame the wrong clock.
 */
export function capturedLabel(capturedAt: number | null, now: number): { text: string; stale: boolean } {
  const at = finite(capturedAt);
  if (at == null) return { text: "no snapshot", stale: true };
  const age = Math.max(0, now - at);
  if (!Number.isFinite(age)) return { text: "captured at an unknown time", stale: true };
  return { text: `captured ${durationLabel(age)} ago`, stale: age > BOARD_STALE_MS };
}

/**
 * What the rows are: the top of a sweep, never the top of everyone trading. The denominator is the server's and never a
 * constant, the sweep's own coverage travels with it when the board publishes one, and the rank basis is named because
 * nothing in the rows themselves says which number the ranking was taken on.
 */
export function populationLabel(coverage: IdentityCoverage, board: BoardKind, window: string): string {
  const snapshot = coverage?.boards?.find((entry) => entry?.board === board && entry?.window === window);
  if (!snapshot) return "no snapshot read for this board yet";
  const ranked = finite(snapshot.walletsRanked);
  const top = `top ${count(finite(snapshot.count) ?? 0)}`;
  const population = ranked == null ? `${top} of a population this board does not publish` : `${top} of ${count(ranked)} wallets swept`;
  return [population, sweepCoverage(snapshot.coverage), RANKED_ON[board]].filter((part): part is string => Boolean(part)).join(" · ");
}

/**
 * The share of the population the sweep actually reached: live 1 on both fomoscan boards, null on pump, which publishes
 * neither leg. Only a 0..1 fraction is rendered — a value outside that range would need a unit the board never states,
 * and the clause is dropped rather than guessed. Tenths are kept so a thin sweep never rounds to a full 100%.
 */
function sweepCoverage(value: number | null): string | null {
  const fraction = finite(value);
  if (fraction == null || fraction < 0 || fraction > 1) return null;
  return `sweep coverage ${Math.round(fraction * 1000) / 10}%`;
}

/**
 * How many of the wallets this server has seen trade the registry can name, per chain. Robinhood reads 0 of 9,019
 * because identity is harvested from Solana boards — a coverage statement, not a failure.
 */
export function namedLabel(coverage: IdentityCoverage): string {
  const parts = Object.entries(coverage?.observedWallets ?? {})
    .filter(([, wallets]) => (finite(wallets?.seen) ?? 0) > 0)
    .map(([chain, wallets]) => `${count(finite(wallets.named) ?? 0)} of ${count(wallets.seen)} ${chain}`);
  if (!parts.length) return "no wallets seen trading here yet";
  return `named ${parts.join(" · ")} wallets seen trading here`;
}

/** Null when the meter has nothing to report; otherwise why the boards are not being refreshed, with the real units. */
export function budgetLabel(coverage: IdentityCoverage): string | null {
  const refused = finite(coverage?.refusedForBudget) ?? 0;
  // Attempts, not lost snapshots: the collector offers one due board a minute and never resets this, so a single
  // unaffordable board counts ~20 an hour and ~480 a day, and a restart returns it to 0 with the throttle unchanged.
  const deferred = refused > 0 ? `${count(refused)} board read${refused === 1 ? "" : "s"} refused for budget since this server started` : null;
  const budget = coverage?.budget ?? null;
  if (!budget) return deferred;
  const remaining = finite(budget.accountRemaining);
  const allowance = finite(budget.allowance) ?? 0;
  const spent = finite(budget.spent) ?? 0;
  const state = remaining != null && remaining < BOARD_CALL_CU
    ? `FomoScan balance exhausted · ${count(remaining)} CU left of the ${budget.period} grant, a board read costs ${BOARD_CALL_CU}`
    : allowance - spent < BOARD_CALL_CU
      ? `budget throttling · ${count(spent)} CU spent of the ${count(allowance)} released so far in ${budget.period}, the next ${BOARD_CALL_CU} CU board read waits`
      : null;
  const line = [state, deferred].filter((part): part is string => Boolean(part)).join(" · ");
  return line || null;
}

function finite(value: number | null | undefined): number | null {
  return value == null || !Number.isFinite(value) ? null : value;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}
