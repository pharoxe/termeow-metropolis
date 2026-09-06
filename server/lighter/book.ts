import type { LighterTrade } from "../sources/lighter.js";

export const TRADE_RING = 500;

/** Price string -> size string. Prices stay strings so map keys match the venue's fixed-decimal formatting exactly. */
export type SideMap = Map<string, string>;

export type BookLevel = { price: number; size: number };
export type BookView = { asks: BookLevel[]; bids: BookLevel[]; mid: number | null; spreadBps: number | null; updatedAt: number };

export type RawLevel = { price?: unknown; size?: unknown };
export type BookFrame = { asks?: RawLevel[]; bids?: RawLevel[]; nonce?: unknown; begin_nonce?: unknown };
export type StreamFrame = { type?: string; channel?: string; order_book?: BookFrame; trades?: unknown; liquidation_trades?: unknown };

function frameText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

export function parseFrame(data: unknown): StreamFrame | null {
  try {
    const parsed: unknown = JSON.parse(frameText(data));
    return parsed && typeof parsed === "object" ? (parsed as StreamFrame) : null;
  } catch {
    return null;
  }
}

/** "order_book:12" -> { kind: "order_book", marketId: 12 }; null for anything else. */
export function parseChannel(channel: unknown): { kind: "order_book" | "trade"; marketId: number } | null {
  if (typeof channel !== "string") return null;
  const match = /^(order_book|trade):(\d+)$/.exec(channel);
  if (!match) return null;
  return { kind: match[1] as "order_book" | "trade", marketId: Number(match[2]) };
}

/** Applies one delta side in place: size 0 removes the level, any other size replaces it (absolute, not incremental). */
export function applyLevels(side: SideMap, levels: RawLevel[] | undefined): void {
  for (const level of levels ?? []) {
    const price = String(level.price ?? "");
    const size = String(level.size ?? "");
    if (!price || size === "") continue;
    if (Number(size) === 0) side.delete(price);
    else side.set(price, size);
  }
}

/** A fresh side built from a snapshot frame. */
export function replaceSide(levels: RawLevel[] | undefined): SideMap {
  const side: SideMap = new Map();
  applyLevels(side, levels);
  return side;
}

/** Best `depth` levels: asks ascending, bids descending. Never relies on array order after merging. */
export function topLevels(side: SideMap, ascending: boolean, depth: number): BookLevel[] {
  return [...side.entries()]
    .map(([price, size]) => ({ price: Number(price), size: Number(size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size))
    .sort((a, b) => (ascending ? a.price - b.price : b.price - a.price))
    .slice(0, depth);
}

export function midAndSpread(asks: BookLevel[], bids: BookLevel[]): { mid: number | null; spreadBps: number | null } {
  const bestAsk = asks[0]?.price ?? null;
  const bestBid = bids[0]?.price ?? null;
  if (bestAsk === null || bestBid === null) return { mid: null, spreadBps: null };
  const mid = (bestAsk + bestBid) / 2;
  return { mid, spreadBps: mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : null };
}

/** Merges new trades into a newest-first ring, deduped by id; returns the new ring and the accepted trades. */
export function mergeTradeRing(ring: LighterTrade[], seen: Set<string>, incoming: LighterTrade[], cap = TRADE_RING): { ring: LighterTrade[]; accepted: LighterTrade[] } {
  const accepted = incoming.filter((trade) => {
    if (seen.has(trade.id)) return false;
    seen.add(trade.id);
    return true;
  });
  if (accepted.length === 0) return { ring, accepted };
  const next = [...accepted, ...ring].sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1));
  const kept = next.slice(0, cap);
  for (const dropped of next.slice(cap)) seen.delete(dropped.id);
  return { ring: kept, accepted };
}
