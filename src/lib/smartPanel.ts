import type { Chain, FlowWindow, SmartBoardRow, SmartBoardWindow, SmartCoverage, SmartFill, TokenFlowSmart, TraderKind } from "../../shared/wire";
import type { InstrumentRef } from "./address";
import { EM_DASH, printAgeLabel, windowRow, type WindowRow } from "./flowPanel";
import { money, shortAddress, signedMoney } from "./format";

/** Pure derivations for the SMART tape panel, the SMART watch tab and the SMART side block. No React, no Date.now(). */

export const SMART_TAPE_POLL_MS = 10_000;
export const SMART_BOARD_POLL_MS = 15_000;
export const SMART_TAPE_LIMIT = 60;
/** Nansen profiler page for a Monad wallet: a constructed link-out keyed by address. */
export const SMART_PROFILE_BASE = "https://app.nansen.ai/profiler?chain=monad&address=";
/** Every population shown is this server's own; the label travels with the number. */
export const SMART_POPULATION_LABEL = "smart-money wallets seen by this server";
/** Below this many closed round trips the Wilson lower bound is meaningless and shown as an em-dash. */
export const WILSON_MIN_CLOSED = 5;
export const BOARD_WINDOWS: readonly SmartBoardWindow[] = ["1h", "24h", "7d"];

export type BoardChip = "1H" | "24H" | "7D";
export const BOARD_CHIPS: readonly BoardChip[] = ["1H", "24H", "7D"];
const BOARD_WINDOW: Record<BoardChip, SmartBoardWindow> = { "1H": "1h", "24H": "24h", "7D": "7d" };

export function boardWindowParam(chip: BoardChip): SmartBoardWindow {
  return BOARD_WINDOW[chip];
}

/** Handle when the Nansen population names the wallet, else the short address. Never invents a name. */
export function walletLabel(address: string, handle: string | null | undefined): string {
  const name = handle?.trim();
  return name ? name : shortAddress(address);
}

/** A server-supplied profile url wins; else the Nansen profiler page for the wallet address; else null. */
export function profileHref(_handle: string | null | undefined, serverUrl?: string | null, address?: string | null): string | null {
  if (serverUrl) return serverUrl;
  return address ? `${SMART_PROFILE_BASE}${encodeURIComponent(address)}` : null;
}

export function followersLabel(followers: number | null | undefined): string {
  if (followers == null || !Number.isFinite(followers)) return EM_DASH;
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 0 }).format(followers);
}

export function chainTag(chain: Chain): string {
  return chain === "monad" ? "MON" : String(chain).toUpperCase();
}

/** Row tag for a wallet taken from the Nansen smart-money list whose smart-money check has not answered here; null for verified SMART (and anything else). */
export function provenanceTag(kind: TraderKind | null | undefined): "SEEDED" | null {
  return kind === "seeded" ? "SEEDED" : null;
}

const SEEDED_TITLE = " · seeded from Nansen / your watchlist · smart-money check pending";

/** Symbol from the launch index when known, else the token's short address (never a guess). */
export function tokenLabel(fill: Pick<SmartFill, "symbol" | "token">): string {
  const symbol = fill.symbol?.trim();
  return symbol ? symbol.toUpperCase() : shortAddress(fill.token);
}

export type SmartTapeRowView = {
  key: string;
  label: string;
  /** Nansen profiler link for the wallet. `profileUrl` is the same value. */
  href: string | null;
  profileUrl: string | null;
  title: string;
  /** "SEEDED" when the wallet awaits its smart-money check (provenance shown, never upgraded to SMART); null otherwise. */
  tag: "SEEDED" | null;
  followers: string;
  side: "BUY" | "SELL";
  tone: "up" | "dn";
  usd: string;
  token: string;
  chain: string;
  age: string;
  instrument: InstrumentRef;
};

export function smartTapeRow(fill: SmartFill, now: number): SmartTapeRowView {
  const side = fill.side === "buy" ? "BUY" : "SELL";
  const href = profileHref(fill.trader.handle, null, fill.trader.address);
  const tag = provenanceTag(fill.trader.kind);
  return {
    key: `${fill.chain}:${fill.tx}:${fill.pair}:${fill.trader.address}`,
    label: walletLabel(fill.trader.address, fill.trader.handle),
    href,
    profileUrl: href,
    title: `${fill.trader.address} · ${side} ${fill.token} · ${fill.dex || fill.pair} · ${fill.tx}${fill.usdVia === "hub_leg" ? " · usd via custody hub leg" : ""}${tag ? SEEDED_TITLE : ""}`,
    tag,
    followers: followersLabel(fill.trader.followers),
    side,
    tone: fill.side === "buy" ? "up" : "dn",
    usd: money(fill.usd, true),
    token: tokenLabel(fill),
    chain: chainTag(fill.chain),
    age: printAgeLabel(fill.time, now),
    instrument: { chain: fill.chain, address: fill.token }
  };
}

export type SmartBoardRowView = {
  key: string;
  label: string;
  href: string | null;
  profileUrl: string | null;
  title: string;
  tag: "SEEDED" | null;
  followers: string;
  fills: string;
  buy: string;
  sell: string;
  net: string;
  netTone: "up" | "dn" | "";
  /** "wins/closed" realized-partial round trips; em-dash when nothing closed. `trips` is the same value. */
  record: string;
  trips: string;
  wilson: string;
  age: string;
};

/** Wilson lower bound as a percent; em-dash under WILSON_MIN_CLOSED closed trades (the server already answers null there). */
export function wilsonLabel(wilsonLow: number | null, closed: number): string {
  if (wilsonLow == null || closed < WILSON_MIN_CLOSED || !Number.isFinite(wilsonLow)) return EM_DASH;
  return `${Math.round(wilsonLow * 100)}%`;
}

export function smartBoardRowView(row: SmartBoardRow, now: number): SmartBoardRowView {
  const href = profileHref(row.handle, row.profileUrl, row.wallet);
  const record = row.closed > 0 ? `${row.wins}/${row.closed}` : EM_DASH;
  // Every fill unpriced: the dollars are unknown, not zero.
  const unpricedOnly = row.fills > 0 && row.unpriced >= row.fills;
  const tag = provenanceTag(row.kind);
  return {
    key: `${row.chain}:${row.wallet}`,
    label: walletLabel(row.wallet, row.handle),
    href,
    profileUrl: href,
    title: `${row.wallet} · ${followersLabel(row.followers)} followers · last fill ${printAgeLabel(row.lastSeenAt, now)} ago${tag ? SEEDED_TITLE : ""}`,
    tag,
    followers: followersLabel(row.followers),
    fills: row.unpriced > 0 ? `${row.fills} (${row.unpriced}u)` : String(row.fills),
    buy: unpricedOnly ? EM_DASH : money(row.buyUsd, true),
    sell: unpricedOnly ? EM_DASH : money(row.sellUsd, true),
    net: unpricedOnly ? EM_DASH : signedMoney(row.netUsd),
    netTone: unpricedOnly ? "" : row.netUsd > 0 ? "up" : row.netUsd < 0 ? "dn" : "",
    record,
    trips: record,
    wilson: wilsonLabel(row.wilsonLow, row.closed),
    age: printAgeLabel(row.lastSeenAt, now)
  };
}

/** Alias kept for the board tab. */
export const smartBoardRow = smartBoardRowView;

/** Shown when a response carries no coverage (old server, failed request): a count without coverage is never read as complete. */
export const COVERAGE_UNKNOWN = "SMART COVERAGE UNKNOWN";

/**
 * R5 header for every SMART surface (tape, board, flow block): the server's own "watching N of M SMART wallets · K named",
 * uppercased for the panel chrome. Fills can only come from the N watched wallets, so this label travels with every SMART count.
 */
export function smartCoverageLabel(coverage: SmartCoverage | null | undefined): string {
  const label = coverage?.label?.trim();
  return label ? label.toUpperCase() : COVERAGE_UNKNOWN;
}

/** Population line under the board header, always carrying the server's own label. */
export function populationNote(population: number, label: string): string {
  return `${population} ${label}`.toUpperCase();
}

/** Says when the ring cannot cover the window, so smaller numbers are not read as totals. */
export function truncationNote(truncatedAt: number | null, now: number): string | null {
  if (truncatedAt == null) return null;
  return `ring covers ${printAgeLabel(truncatedAt, now)} only · older fills not counted`;
}

export type SmartWindowRow = WindowRow & { fills: string };

/** One SMART-cohort window row, formatted like the all-flow windows; `fills` mirrors `prints`. */
export function smartWindowRow(window: FlowWindow): SmartWindowRow {
  const base = windowRow(window);
  return { ...base, fills: base.prints };
}

/** SMART-cohort window rows, formatted exactly like the all-flow windows; [] when the block is absent. */
export function smartWindowRows(smart: TokenFlowSmart | undefined): WindowRow[] {
  return (smart?.windows ?? []).map(windowRow);
}

/** Chart-meta suffix: marker count plus what was cut ("+N more") or lies before the first candle. */
export function markerMetaLabel(shown: number, dropped: number, beforeRange: number): string | null {
  if (shown === 0 && dropped === 0 && beforeRange === 0) return null;
  const parts = [`SMART ${shown}`];
  if (dropped > 0) parts.push(`+${dropped} more`);
  if (beforeRange > 0) parts.push(`${beforeRange} off-chart`);
  return parts.join(" ");
}

/** Candle open times in ms regardless of the feed's unit. */
export function candleTimesMs(candles: ReadonlyArray<{ time: number }>): number[] {
  return candles.map((candle) => {
    const raw = Number(candle.time);
    return raw > 1e12 ? raw : raw * 1000;
  });
}
