import type { Chain, LaunchRow } from "../../shared/wire";
import { printAgeLabel } from "./flowPanel";
import { money, pct, shortAddress } from "./format";

/** Pure helpers for the LAUNCHES tab. No React, no Date.now(): callers pass `now`. */

export type ChainChip = "ALL" | "MON";
export const CHAIN_CHIPS: readonly ChainChip[] = ["MON"];
export const LAUNCH_POLL_MS = 15_000;
/** The tracked-trader population wired today; every SMART label names it. */
export const SMART_POPULATION = "Nansen smart money";
const EM_DASH = "—";

const CHAIN_LABELS: Record<Chain, "MON"> = { monad: "MON" };

const PAD_LABELS: Record<string, string> = {
  nadfun: "NAD.FUN",
  "dexscreener-profile": "DEX PROFILE",
  unknown: "PAD ?"
};

export function chipChain(chip: ChainChip): "all" | Chain {
  return chip === "MON" ? "monad" : "all";
}

export function chainLabel(chain: Chain): "MON" {
  return CHAIN_LABELS[chain];
}

/** Short chip text for a launchpad id; unknown ids are shown uppercased rather than hidden. */
export function padLabel(launchpad: string): string {
  return PAD_LABELS[launchpad] ?? launchpad.toUpperCase();
}

export function launchAge(row: Pick<LaunchRow, "createdAt">, now: number): string {
  return printAgeLabel(row.createdAt, now);
}

export function sortNewestFirst(rows: readonly LaunchRow[]): LaunchRow[] {
  return [...rows].sort((a, b) => b.createdAt - a.createdAt || b.observedAt - a.observedAt);
}

export function filterByChip(rows: readonly LaunchRow[], chip: ChainChip): LaunchRow[] {
  const chain = chipChain(chip);
  return chain === "all" ? [...rows] : rows.filter((row) => row.chain === chain);
}

/** Query parameters for api.launches; the stocks toggle is server-side because `isStock` is not on the wire row. */
export function launchQuery(chip: ChainChip, stocks: boolean): { chain: "all" | Chain; stocks: boolean } {
  return { chain: chipChain(chip), stocks };
}

export function symbolLabel(row: Pick<LaunchRow, "symbol" | "token">): string {
  return row.symbol?.trim() || shortAddress(row.token);
}

export function launchPrice(row: Pick<LaunchRow, "priceUsd">): string {
  return money(row.priceUsd);
}

export function launchMcap(row: Pick<LaunchRow, "marketCapUsd">): string {
  return money(row.marketCapUsd, true);
}

export function launchChange(row: Pick<LaunchRow, "change24Pct">): { text: string; tone: "up" | "dn" | "" } {
  const value = row.change24Pct;
  if (value == null || !Number.isFinite(value)) return { text: EM_DASH, tone: "" };
  return { text: pct(value), tone: value < 0 ? "dn" : "up" };
}

/** MCAP / PX tooltip: how old the last price refresh is, or that no source has priced the row yet (nothing is invented). */
export function priceAgeTitle(row: Pick<LaunchRow, "pricedAt">, now: number): string {
  return row.pricedAt === null ? "no price source yet" : `priced ${printAgeLabel(row.pricedAt, now)} ago`;
}

/** "B3/S1" once the curve tape has printed; an em-dash while nothing has been observed (not a measured zero). */
export function curveCounts(row: Pick<LaunchRow, "curveBuys" | "curveSells">): string {
  return row.curveBuys + row.curveSells > 0 ? `B${row.curveBuys}/S${row.curveSells}` : EM_DASH;
}

export type SmartBuyer = { handle: string; title: string };

/** First tracked buyer from the labelled population; the title carries followers and the population name. */
export function smartBuyer(row: Pick<LaunchRow, "tracked">, now: number): SmartBuyer | null {
  const buyer = row.tracked?.firstBuyer;
  if (!buyer) return null;
  const followers = buyer.followers == null ? "followers unknown" : `${buyer.followers.toLocaleString("en-US")} followers`;
  return { handle: `@${buyer.handle.replace(/^@/, "")}`, title: `@${buyer.handle} · ${followers} · first buy ${printAgeLabel(buyer.at, now)} ago · SMART first buyer · ${SMART_POPULATION}` };
}

/** Second line under the symbol: the name when a source gave one, else the sources that vouch for the row (never blank). */
export function rowSubtitle(row: Pick<LaunchRow, "name" | "sources">): string {
  const name = row.name?.trim();
  if (name) return name;
  return row.sources.length ? `no name yet · ${row.sources.join(" · ")}` : "no name yet";
}

/** Monad is the only chain, so the chip always starts on it. */
export function defaultChip(_network: "monad" = "monad"): ChainChip {
  return "MON";
}

export function isHoneypot(row: Pick<LaunchRow, "tracked">): boolean {
  return row.tracked?.honeypot === true;
}

export function rowKey(row: Pick<LaunchRow, "chain" | "token">): string {
  return `${row.chain}:${row.token}`;
}

/** Copy for the cold feed: names the sources the server reports so an empty list is never mistaken for "no launches". */
export function coldCopy(sources: ReadonlyArray<{ name: string }>): string {
  const names = sources.map((source) => source.name);
  return `Waiting for launches · sources: ${names.length ? names.join(", ") : "none reported yet"}`;
}
