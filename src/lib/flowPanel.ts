import type { FlowWindow, LargePrint, SinceAnchor, SourceChip, TokenFlowResponse } from "../../shared/wire";
import type { FlowChartInput } from "./flowChart";
import { money, signedMoney } from "./format";

/** Pure derivations for the FLOW panel side outputs (F4). No React, no Date.now(): callers pass `now`. */

export const SOURCE_GOOD_MS = 60_000;
export const SOURCE_WARN_MS = 5 * 60_000;
export const EM_DASH = "—";

export type SourceTone = "good" | "warn" | "bad" | "off";
export type SourceLabel = "OWN" | "GECKO";
export type SourceChipState = { label: SourceLabel; tone: SourceTone; title: string };

const SOURCE_LABELS: Record<SourceChip["name"], SourceLabel> = { own: "OWN", geckoterminal: "GECKO" };

/** Age of `time` relative to `now` as 12s / 3m / 2h / 1d; em-dash when the time is unknown. */
/** Compact duration ("42s", "39m", "2h", "3d") for a non-negative span in ms; the single formatter for ages and spans. */
export function durationLabel(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export function printAgeLabel(time: number | null | undefined, now: number): string {
  if (time == null || !Number.isFinite(time) || !Number.isFinite(now)) return EM_DASH;
  return durationLabel(Math.max(0, now - time));
}

function sourceTone(chip: SourceChip, now: number): SourceTone {
  const age = chip.lastOkAt == null ? null : now - chip.lastOkAt;
  if (age == null) return chip.lastError ? "bad" : "off";
  if (!chip.lastError) return age <= SOURCE_GOOD_MS ? "good" : "warn";
  return age <= SOURCE_WARN_MS ? "warn" : "bad";
}

export function sourceChipState(chip: SourceChip, now: number): SourceChipState {
  const label = SOURCE_LABELS[chip.name];
  const ok = chip.lastOkAt == null ? "never ok" : `last ok ${printAgeLabel(chip.lastOkAt, now)} ago`;
  const parts = [label, ok];
  if (chip.lastError) parts.push(chip.lastError);
  if (chip.prints != null) parts.push(`${chip.prints} prints`);
  return { label, tone: sourceTone(chip, now), title: parts.join(" · ") };
}

export type WindowRow = { label: string; buy: string; sell: string; net: string; netTone: "up" | "dn" | ""; prints: string; aggr: string };

function netTone(net: number): "up" | "dn" | "" {
  return net > 0 ? "up" : net < 0 ? "dn" : "";
}

export function windowRow(w: FlowWindow): WindowRow {
  const prints = w.buys + w.sells;
  return {
    label: w.label.toUpperCase(),
    buy: money(w.buyUsd, true),
    sell: money(w.sellUsd, true),
    net: signedMoney(w.net),
    netTone: netTone(w.net),
    prints: w.unpriced > 0 ? `${prints} (${w.unpriced}u)` : String(prints),
    aggr: w.aggressor == null ? EM_DASH : `${Math.round(w.aggressor * 100)}%`
  };
}

export type LargePrintRow = { key: string; side: "BUY" | "SELL"; tone: "up" | "dn"; usd: string; dex: string; age: string };

export function largePrintRow(p: LargePrint, now: number): LargePrintRow {
  return {
    key: `${p.pair}:${p.tx}`,
    side: p.side === "buy" ? "BUY" : "SELL",
    tone: p.side === "buy" ? "up" : "dn",
    usd: money(p.usd, true),
    dex: (p.dex || EM_DASH).toUpperCase(),
    age: printAgeLabel(p.time, now)
  };
}

/** "SINCE LAUNCH net +$1.2K · 42 prints"; an unknown anchor start says so instead of showing zeros as a total. */
export function sinceAnchorLine(anchor: TokenFlowResponse["anchor"], since: SinceAnchor | undefined): string {
  const head = `SINCE ${anchor.toUpperCase()}`;
  if (!since) return `${head} ${EM_DASH}`;
  if (since.startMs == null) return `${head} ${EM_DASH} · anchor unknown`;
  return `${head} net ${signedMoney(since.net)} · ${since.prints} prints`;
}

function toMs(time: number): number {
  return time > 1e12 ? time : time * 1000;
}

/** Chart input from the polled flow response: Tier A pairs first, candle open times in ms. */
export function buildChartFlowInput(flow: TokenFlowResponse, candles: ReadonlyArray<{ time: number }>): FlowChartInput {
  const pairs = [...flow.pairs].sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "A" ? -1 : 1));
  return {
    bars: flow.bars,
    pairs,
    coverage: flow.coverage,
    candleTimes: candles.map((candle) => toMs(Number(candle.time)))
  };
}
