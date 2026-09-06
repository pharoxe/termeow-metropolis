import type { Chain, FlowWindow, FomoBoardRow, FomoBoardWindow, FomoFill, TokenFlowFomo } from "../../shared/wire";
import type { InstrumentRef } from "./address";
import { EM_DASH, printAgeLabel, windowRow, type WindowRow } from "./flowPanel";
import { money, shortAddress, signedMoney } from "./format";

/** Pure derivations for the FOMO tape panel, the FOMO watch tab and the FOMO side block. No React, no Date.now(). */

export const FOMO_TAPE_POLL_MS = 10_000;
export const FOMO_BOARD_POLL_MS = 15_000;
export const FOMO_TAPE_LIMIT = 60;
/** fomo.family has no public API: profile pages are constructed link-outs, only when a handle is known. */
export const FOMO_PROFILE_BASE = "https://fomo.family/profile/";
/** Every population shown is this server's own; the label travels with the number. */
export const FOMO_POPULATION_LABEL = "FOMO wallets seen by this server";
/** Below this many closed round trips the Wilson lower bound is meaningless and shown as an em-dash. */
export const WILSON_MIN_CLOSED = 5;
export const BOARD_WINDOWS: readonly FomoBoardWindow[] = ["1h", "24h", "7d"];

export type BoardChip = "1H" | "24H" | "7D";
export const BOARD_CHIPS: readonly BoardChip[] = ["1H", "24H", "7D"];
const BOARD_WINDOW: Record<BoardChip, FomoBoardWindow> = { "1H": "1h", "24H": "24h", "7D": "7d" };

export function boardWindowParam(chip: BoardChip): FomoBoardWindow {
  return BOARD_WINDOW[chip];
}

/** Handle when the robinhoodtrenches population names the wallet, else the short address. Never invents a name. */
export function walletLabel(address: string, handle: string | null | undefined): string {
  const name = handle?.trim();
  return name ? name : shortAddress(address);
}

/** A server-supplied profile url wins; else a constructed fomo.family link from the handle (leading @ dropped); else null. */
export function profileHref(handle: string | null | undefined, serverUrl?: string | null): string | null {
  if (serverUrl) return serverUrl;
  const name = handle?.trim().replace(/^@+/, "");
  return name ? `${FOMO_PROFILE_BASE}${encodeURIComponent(name)}` : null;
}

export function followersLabel(followers: number | null | undefined): string {
  if (followers == null || !Number.isFinite(followers)) return EM_DASH;
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 0 }).format(followers);
}

export function chainTag(chain: Chain): string {
  return chain === "solana" ? "SOL" : "RH";
}

/** Symbol from the launch index when known, else the token's short address (never a guess). */
export function tokenLabel(fill: Pick<FomoFill, "symbol" | "token">): string {
  const symbol = fill.symbol?.trim();
  return symbol ? symbol.toUpperCase() : shortAddress(fill.token);
}

export type FomoTapeRowView = {
  key: string;
  label: string;
  /** Constructed fomo.family link when a handle is known; null otherwise. `profileUrl` is the same value. */
  href: string | null;
  profileUrl: string | null;
  title: string;
  followers: string;
  side: "BUY" | "SELL";
  tone: "up" | "dn";
  usd: string;
  token: string;
  chain: string;
  age: string;
  instrument: InstrumentRef;
};

export function fomoTapeRow(fill: FomoFill, now: number): FomoTapeRowView {
  const side = fill.side === "buy" ? "BUY" : "SELL";
  const href = profileHref(fill.trader.handle);
  return {
    key: `${fill.chain}:${fill.tx}:${fill.pair}:${fill.trader.address}`,
    label: walletLabel(fill.trader.address, fill.trader.handle),
    href,
    profileUrl: href,
    title: `${fill.trader.address} · ${side} ${fill.token} · ${fill.dex || fill.pair} · ${fill.tx}`,
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

export type FomoBoardRowView = {
  key: string;
  label: string;
  href: string | null;
  profileUrl: string | null;
  title: string;
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

export function fomoBoardRowView(row: FomoBoardRow, now: number): FomoBoardRowView {
  const href = profileHref(row.handle, row.profileUrl);
  const record = row.closed > 0 ? `${row.wins}/${row.closed}` : EM_DASH;
  return {
    key: `${row.chain}:${row.wallet}`,
    label: walletLabel(row.wallet, row.handle),
    href,
    profileUrl: href,
    title: `${row.wallet} · ${followersLabel(row.followers)} followers · last fill ${printAgeLabel(row.lastSeenAt, now)} ago`,
    followers: followersLabel(row.followers),
    fills: String(row.fills),
    buy: money(row.buyUsd, true),
    sell: money(row.sellUsd, true),
    net: signedMoney(row.netUsd),
    netTone: row.netUsd > 0 ? "up" : row.netUsd < 0 ? "dn" : "",
    record,
    trips: record,
    wilson: wilsonLabel(row.wilsonLow, row.closed),
    age: printAgeLabel(row.lastSeenAt, now)
  };
}

/** Alias kept for the board tab. */
export const fomoBoardRow = fomoBoardRowView;

/** "FOMO WALLETS · 12 SEEN · 5 NAMED": both populations are this server's, never all of fomo.family. */
export function fomoHeaderLabel(population: number, handles: number): string {
  return `FOMO WALLETS · ${population} SEEN · ${handles} NAMED`;
}

/** Alias kept for the tape panel and the side block. */
export const fomoHeader = fomoHeaderLabel;

/** Population line under the board header, always carrying the server's own label. */
export function populationNote(population: number, label: string): string {
  return `${population} ${label}`.toUpperCase();
}

/** Says when the ring cannot cover the window, so smaller numbers are not read as totals. */
export function truncationNote(truncatedAt: number | null, now: number): string | null {
  if (truncatedAt == null) return null;
  return `ring covers ${printAgeLabel(truncatedAt, now)} only · older fills not counted`;
}

export type FomoWindowRow = WindowRow & { fills: string };

/** One FOMO-cohort window row, formatted like the all-flow windows; `fills` mirrors `prints`. */
export function fomoWindowRow(window: FlowWindow): FomoWindowRow {
  const base = windowRow(window);
  return { ...base, fills: base.prints };
}

/** FOMO-cohort window rows, formatted exactly like the all-flow windows; [] when the block is absent. */
export function fomoWindowRows(fomo: TokenFlowFomo | undefined): WindowRow[] {
  return (fomo?.windows ?? []).map(windowRow);
}

/** Chart-meta suffix: marker count plus what was cut ("+N more") or lies before the first candle. */
export function markerMetaLabel(shown: number, dropped: number, beforeRange: number): string | null {
  if (shown === 0 && dropped === 0 && beforeRange === 0) return null;
  const parts = [`FOMO ${shown}`];
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
