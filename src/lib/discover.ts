import type { DiscoverProvenance, DiscoverResponse, DiscoverRow, DiscoverSourceHealth, DiscoverView, DiscoverWindow, SmartCoverage, PairTxns } from "../../shared/wire";
import { durationLabel, EM_DASH, printAgeLabel } from "./flowPanel";
import { money, pct, shortAddress } from "./format";
import { smartCoverageLabel } from "./smartPanel";

/** Pure helpers for the Monad discovery tabs (GET /api/discover/monad). No React, no Date.now(): callers pass `now`. */

export const DISCOVER_POLL_MS = 30_000;
export type DiscoverTab = "TRENDING" | "BIGGEST MOVERS" | "SMART HOLDERS" | "NEW";
export type WindowChip = "1H" | "24H";
export const WINDOW_CHIPS: readonly WindowChip[] = ["1H", "24H"];

const TAB_VIEWS: Record<DiscoverTab, DiscoverView> = { TRENDING: "trending", "BIGGEST MOVERS": "movers", "SMART HOLDERS": "holders", NEW: "new" };
const WINDOW_PARAMS: Record<WindowChip, DiscoverWindow> = { "1H": "1h", "24H": "24h" };

/** Short chip text per server source label; unknown labels keep their first word uppercased rather than vanishing. */
const SOURCE_CHIPS: ReadonlyArray<[RegExp, string]> = [
  [/^geckoterminal trending/i, "GECKO TREND"],
  [/^geckoterminal new/i, "GECKO NEW"],
  [/^dexscreener/i, "DEXSCREENER"],
  [/^trader book/i, "BOOK"],
  [/^erc20/i, "ERC20"]
];

export function viewFor(tab: DiscoverTab): DiscoverView {
  return TAB_VIEWS[tab];
}

export function windowParam(chip: WindowChip): DiscoverWindow {
  return WINDOW_PARAMS[chip];
}

export function isDiscoverTab(tab: string): tab is DiscoverTab {
  return tab in TAB_VIEWS;
}

export function sourceChipLabel(source: string): string {
  const hit = SOURCE_CHIPS.find(([pattern]) => pattern.test(source));
  return hit ? hit[1] : (source.split(/\s|·/)[0] || "SRC").toUpperCase();
}

export function symbolLabel(row: Pick<DiscoverRow, "symbol" | "token">): string {
  return row.symbol?.trim() || shortAddress(row.token);
}

export function txnsLabel(txns: PairTxns): string {
  return txns ? `B${txns.buys}/S${txns.sells}` : EM_DASH;
}

export function ageLabel(ageMs: number | null): string {
  return ageMs == null || !Number.isFinite(ageMs) || ageMs < 0 ? EM_DASH : durationLabel(ageMs);
}

export function changeCell(changePct: number | null): { text: string; tone: "up" | "dn" | "" } {
  if (changePct == null || !Number.isFinite(changePct)) return { text: EM_DASH, tone: "" };
  return { text: pct(changePct), tone: changePct < 0 ? "dn" : "up" };
}

export type SourceChipView = { key: string; label: string; stale: boolean; title: string };

/** One chip per contributing source with its own figures in the title, so disputed numbers are inspectable, never averaged away. */
export function sourceChips(row: Pick<DiscoverRow, "sources">, now: number): SourceChipView[] {
  return row.sources.map((source) => ({
    key: source.source,
    label: sourceChipLabel(source.source),
    stale: source.stale,
    title: provenanceTitle(source, now)
  }));
}

function provenanceTitle(source: DiscoverProvenance, now: number): string {
  const parts = [source.source, source.lastOkAt == null ? "never ok" : `last ok ${printAgeLabel(source.lastOkAt, now)} ago`];
  if (source.stale) parts.push("stale");
  if (source.rank != null) parts.push(`rank #${source.rank + 1}`);
  if (source.priceUsd != null) parts.push(`px ${money(source.priceUsd)}`);
  if (source.marketCapUsd != null) parts.push(`mcap ${money(source.marketCapUsd, true)}`);
  if (source.volumeUsd != null) parts.push(`vol ${money(source.volumeUsd, true)}`);
  if (source.changePct != null) parts.push(`chg ${pct(source.changePct)}`);
  if (source.trackedBuyers != null) parts.push(`${source.trackedBuyers} tracked buyers (their population)`);
  return parts.join(" · ");
}

/** "DISPUTED mcap, vol" when two sources disagree by more than 5%; null when they agree. */
export function disputedLabel(row: Pick<DiscoverRow, "disputed">): string | null {
  if (!row.disputed.length) return null;
  const names: Record<string, string> = { priceUsd: "px", marketCapUsd: "mcap", liquidityUsd: "liq", volumeUsd: "vol", changePct: "chg" };
  return `DISPUTED ${row.disputed.map((field) => names[field] ?? field).join(", ")}`;
}

export type SmartCell = { text: string; title: string };

/**
 * Verified-SMART buyers per the server's own book (null = the book holds no fills, shown as an em-dash, never 0);
 * the title always carries the coverage label so a count is read against the wallets actually watched.
 */
export function smartHoldersCell(row: Pick<DiscoverRow, "smartHolders" | "trackedBuyers">, coverage: SmartCoverage | null): SmartCell {
  const label = smartCoverageLabel(coverage);
  const tracked = row.trackedBuyers == null ? "" : ` · ${row.trackedBuyers} tracked buyers reported by the source`;
  if (row.smartHolders == null) return { text: EM_DASH, title: `no SMART buy fills in this server's book for this token · ${label}${tracked}` };
  return { text: String(row.smartHolders), title: `${row.smartHolders} distinct verified-SMART buyers in the window · this server's book · ${label}${tracked}` };
}

/** "3/4 SRC · STALE" header summary; a source is counted healthy when its last attempt succeeded and it is not stale. */
export function sourcesSummary(sources: ReadonlyArray<DiscoverSourceHealth>, stale: boolean | undefined): string {
  if (!sources.length) return "SRC —";
  const healthy = sources.filter((source) => !source.lastError && !source.stale).length;
  return `${healthy}/${sources.length} SRC${stale ? " · STALE" : ""}`;
}

export function sourcesTitle(sources: ReadonlyArray<DiscoverSourceHealth>, now: number): string {
  return sources.map((source) => `${source.name} · ${source.lastOkAt == null ? "never ok" : `last ok ${printAgeLabel(source.lastOkAt, now)} ago`}${source.lastError ? ` · ${source.lastError}` : ""}${source.stale ? " · stale" : ""}`).join("\n");
}

/** Copy for an empty list that names the failing sources, so "no rows" is never mistaken for "no activity". */
export function emptyCopy(feed: DiscoverResponse | null, failure: string): string {
  if (!feed) return failure ? `Discovery unavailable · ${failure}` : "Loading discovery rows…";
  if (feed.error) return `No rows · ${feed.error}`;
  if (feed.view === "holders") return `No verified-SMART buy fills in this server's book for this window · ${smartCoverageLabel(feed.coverage)}`;
  const names = feed.sources.map((source) => source.name);
  return `No rows from ${names.length ? names.join(", ") : "any source"} in this window.`;
}

export function rowKey(row: Pick<DiscoverRow, "chain" | "token">): string {
  return `${row.chain}:${row.token}`;
}
