import type { AlertRow, AlertRule, SmartChainScope, SmartCoverage } from "../../shared/wire";
import type { InstrumentRef } from "./address";
import { formatIst, istParts } from "./chartTime";
import { durationLabel, EM_DASH } from "./flowPanel";
import { smartCoverageLabel, followersLabel, walletLabel } from "./smartPanel";
import { money, shortAddress } from "./format";
import { chipChain, padLabel, type ChainChip } from "./launches";

/** Pure derivations for the ALERTS watch tab and its toasts. No React, no Date.now(): callers pass `now`. */

export const ALERTS_POLL_MS = 15_000;
export const ALERTS_LIMIT = 200;
/** At most this many toasts per poll; the tab is the persistent surface, the stack only shows the newest. */
export const ALERT_TOASTS_PER_POLL = 3;
/** Above this delivery lag the row says it is late (the public RPC 429 backlog reached ~60 min on 2026-09-07). */
export const LATE_LAG_MS = 5 * 60_000;
export const UNPRICED = "unpriced";
/** Ids remembered for toast dedupe: the newest page plus one page of history, so the set never grows past this. */
export const SEEN_CAP = ALERTS_LIMIT * 2;

const RULE_BADGE: Record<AlertRule, string> = { first_smart_buy: "1ST SMART BUY", big_handle_entry: "BIG HANDLE", graduation: "GRAD" };
/** Tones reuse the global .chip.good / .chip.warn styles. */
const RULE_TONE: Record<AlertRule, "warn" | "good"> = { first_smart_buy: "good", big_handle_entry: "warn", graduation: "good" };

export function alertQuery(chip: ChainChip): { chain: SmartChainScope; limit: number } {
  return { chain: chipChain(chip), limit: ALERTS_LIMIT };
}

export function ruleBadge(rule: AlertRule): string {
  return RULE_BADGE[rule];
}

export function ruleTone(rule: AlertRule): "warn" | "good" {
  return RULE_TONE[rule];
}

/** Symbol when the server knows one, else the token's short address (never a guess). */
export function alertTokenLabel(row: Pick<AlertRow, "symbol" | "token">): string {
  const symbol = row.symbol?.trim();
  return symbol ? symbol.toUpperCase() : shortAddress(row.token);
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Chain time as an IST clock ("18:04:31"); the full stamp goes in the title. */
export function alertClockIst(time: number): string {
  if (!Number.isFinite(time)) return EM_DASH;
  const parts = istParts(time);
  return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

/** "usd" of a fill, or "unpriced" when the server left it null (bundled segment); never a zero. */
export function usdLabel(usd: number | null): string {
  return usd == null || !Number.isFinite(usd) ? UNPRICED : money(usd, true);
}

/** "seen 3m late" once the server ran more than LATE_LAG_MS behind the chain (observedAt - chain time); null when it was current. */
export function lagNote(row: Pick<AlertRow, "observedAt" | "time">): string | null {
  const deliveryLagMs = row.observedAt - row.time;
  if (!Number.isFinite(deliveryLagMs) || deliveryLagMs < LATE_LAG_MS) return null;
  return `seen ${durationLabel(deliveryLagMs)} late`;
}

/** Evidence line: handle · followers · usd or unpriced · launchpad · launch age. Every part comes from the row; nothing inferred. */
export function alertEvidenceLine(row: AlertRow): string {
  if (row.rule === "first_smart_buy") {
    const { fill } = row.evidence;
    const parts = [walletLabel(fill.wallet, fill.handle)];
    if (fill.followers != null) parts.push(`${followersLabel(fill.followers)} followers`);
    parts.push(`${fill.side.toUpperCase()} ${usdLabel(fill.usd)}`, padLabel(row.evidence.launchpad), `launch +${durationLabel(Math.max(0, row.evidence.launchAgeMs))}${row.evidence.createdAtEstimated ? "~" : ""}`);
    if (fill.kind === "seeded") parts.push("SEEDED");
    return parts.join(" · ");
  }
  if (row.rule === "big_handle_entry") {
    const fill = row.evidence;
    const parts = [fill.handle, `${followersLabel(fill.followers)} followers`, `${fill.side.toUpperCase()} ${usdLabel(fill.usd)}`];
    if (fill.kind === "seeded") parts.push("SEEDED");
    // "first" is bounded by the book: no earlier fill since its oldest fill, not since the token existed.
    parts.push(fill.bookSince == null ? "first in an empty book" : `first since ${alertClockIst(fill.bookSince)} IST`);
    return parts.join(" · ");
  }
  const parts = [padLabel(row.evidence.launchpad), `${row.evidence.smartFills} SMART fills`];
  if (row.evidence.pool) parts.push(`pool ${shortAddress(row.evidence.pool)}`);
  return parts.join(" · ");
}

/** The tx the alert rests on; graduation rows carry none (the index drops it), so null stays null. */
export function alertTx(row: AlertRow): string | null {
  if (row.rule === "first_smart_buy") return row.evidence.fill.tx;
  if (row.rule === "big_handle_entry") return row.evidence.tx;
  return row.evidence.graduationTx;
}

export type AlertRowView = {
  key: string;
  badge: string;
  tone: "warn" | "good";
  clock: string;
  /** Full IST stamp, token address, tx and coverage as of firing. */
  title: string;
  token: string;
  chain: "MON";
  evidence: string;
  /** "seen 3m late" when the server trailed the chain; null otherwise. */
  lag: string | null;
  age: string;
  instrument: InstrumentRef;
  side: "buy" | "sell" | null;
  xHandle: string | null;
  xUrl: string | null;
};

export function alertRowView(row: AlertRow, now: number): AlertRowView {
  const tx = alertTx(row);
  const fill = row.rule === "first_smart_buy" ? row.evidence.fill : row.rule === "big_handle_entry" ? row.evidence : null;
  const handle = fill?.handle?.trim().replace(/^@+/, "") || null;
  return {
    key: row.id,
    badge: ruleBadge(row.rule),
    tone: ruleTone(row.rule),
    clock: alertClockIst(row.time),
    title: [formatIst(row.time, "second"), row.token, tx ? `tx ${tx}` : "no tx carried", smartCoverageLabel(row.coverage)].join(" · "),
    token: alertTokenLabel(row),
    chain: "MON",
    evidence: alertEvidenceLine(row),
    lag: lagNote(row),
    age: durationLabel(Math.max(0, now - row.time)),
    instrument: { chain: row.chain, address: row.token },
    side: fill?.side === "buy" || fill?.side === "sell" ? fill.side : null,
    xHandle: handle,
    xUrl: handle ? `https://x.com/${encodeURIComponent(handle)}` : null
  };
}

export function sortNewestFirst(rows: readonly AlertRow[]): AlertRow[] {
  return [...rows].sort((a, b) => b.observedAt - a.observedAt || b.time - a.time);
}

/** Rows whose id the client has not seen, newest first; the seen set is never mutated (callers build the next one). */
export function unseenAlerts(rows: readonly AlertRow[], seen: ReadonlySet<string>): AlertRow[] {
  return sortNewestFirst(rows.filter((row) => !seen.has(row.id)));
}

/** The next seen set: this page's ids first, then the previous set, cut at `cap` so a tab left open for hours never grows it. */
export function withSeen(seen: ReadonlySet<string>, rows: readonly AlertRow[], cap: number = SEEN_CAP): Set<string> {
  return new Set([...rows.map((row) => row.id), ...seen].slice(0, Math.max(0, cap)));
}

export type AlertToast = { id: string; title: string; message: string; tone: "info" | "success" | "warning" };

/** Toast copy for one alert: rule + token in the title, the evidence line and coverage in the body. */
export function alertToast(row: AlertRow): AlertToast {
  const tone = row.rule === "graduation" ? "success" : row.rule === "big_handle_entry" ? "warning" : "info";
  const lag = lagNote(row);
  return {
    id: row.id,
    title: `${ruleBadge(row.rule)} · ${alertTokenLabel(row)}`,
    message: `${alertEvidenceLine(row)}${lag ? ` · ${lag}` : ""} · ${row.coverage.label}`,
    tone
  };
}

/** Header line: rule count plus the coverage label; a count is never shown without the coverage it was measured under, and an erroring engine says so. */
export function alertsHeader(count: number, coverage: SmartCoverage | undefined, ringSize: number | undefined, ringMax: number | undefined, engineErrors = 0): string {
  const ring = ringSize != null && ringMax != null && ringSize >= ringMax ? " · RING FULL" : "";
  const errors = engineErrors > 0 ? ` · ENGINE ERRORS ${engineErrors}` : "";
  return `${count} ALERTS · ${smartCoverageLabel(coverage)}${ring}${errors}`;
}

/** Cold copy for a chain scope with no alerts yet. */
export function coldCopy(_chain: SmartChainScope): string {
  return "No alerts fired yet on this server. Rules: first smart-money buy this server recorded of a fresh nad.fun launch, first fill in the book of a Nansen-labelled or watched wallet in a token, nad.fun graduation of a token with smart-money fills.";
}
