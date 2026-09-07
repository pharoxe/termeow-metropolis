/**
 * Pure helpers shared by the websocket transport and its tests: the eth_subscribe("logs") filter shape (one per poller
 * leg, exactly the eth_getLogs filter minus the block range), stable keys for diffing leg sets across resubscribes,
 * the measured per-filter limits, and the frame parser. Measured 2026-09-07 on publicnode + pocket (fixtures r7/):
 * 64 subscriptions per connection accepted, topic OR-lists of 1000 accepted, 2000 rejected (pocket: "exceed max
 * topics"; publicnode: silent, no ack), address lists up to 10000 accepted.
 */
import { frameText } from "../solana/subscribe.js";

export type LegFilter = { address?: string[]; topics: Array<string[] | null> };

export const MAX_TOPICS_PER_POSITION = 1_000;
/** Measured ceiling (fixtures r7/ws-limits-*.json); setLegs refuses legs past it instead of letting them time out unacked. */
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 64;

export function legKey(leg: LegFilter): string {
  return JSON.stringify({ address: leg.address ?? [], topics: leg.topics });
}

/** False for a leg the nodes are known to reject (or silently ignore); the transport reports it instead of sending it. */
export function legWithinLimits(leg: LegFilter): boolean {
  return leg.topics.every((position) => position === null || position.length <= MAX_TOPICS_PER_POSITION);
}

export type LegDiff = { add: LegFilter[]; remove: string[] };

/** Legs to subscribe and keys to unsubscribe so that `current` becomes `next`. */
export function diffLegs(current: Iterable<string>, next: LegFilter[]): LegDiff {
  const wanted = new Map(next.map((leg) => [legKey(leg), leg] as const));
  const have = new Set(current);
  const add = [...wanted].filter(([key]) => !have.has(key)).map(([, leg]) => leg);
  const remove = [...have].filter((key) => !wanted.has(key));
  return { add, remove };
}

export type WsFrame =
  | { kind: "reply"; id: number; result: unknown; error: { code: number | null; message: string } | null }
  | { kind: "notification"; subscription: string; result: unknown }
  | { kind: "other" };

/** Classifies one inbound frame; malformed JSON is null, a well-formed frame of no interest is `other`. */
export function parseWsFrame(data: unknown): WsFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frameText(data));
  } catch {
    return null;
  }
  const frame = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  if (!frame) return null;
  if (typeof frame.id === "number") {
    const raw = frame.error && typeof frame.error === "object" ? (frame.error as Record<string, unknown>) : null;
    const error = raw ? { code: typeof raw.code === "number" ? raw.code : null, message: String(raw.message ?? "rpc error") } : null;
    return { kind: "reply", id: frame.id, result: frame.result, error };
  }
  if (frame.method === "eth_subscription") {
    const params = frame.params && typeof frame.params === "object" ? (frame.params as Record<string, unknown>) : null;
    if (params && typeof params.subscription === "string") return { kind: "notification", subscription: params.subscription, result: params.result };
  }
  return { kind: "other" };
}

function parseHex(value: unknown): number | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export type HeadFrame = { number: number; timestampMs: number | null };

/** newHeads payload -> block number and ms time; null when the header has no usable number. */
export function parseHead(result: unknown): HeadFrame | null {
  const header = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  if (!header) return null;
  const number = parseHex(header.number);
  if (number === null) return null;
  const seconds = parseHex(header.timestamp);
  return { number, timestampMs: seconds && seconds > 0 ? seconds * 1000 : null };
}

/** ms time a log frame carries in `blockTimestamp`, or null when absent or 0x0 (the official node's value). */
export function logBlockTimestampMs(log: unknown): number | null {
  const row = log && typeof log === "object" ? (log as Record<string, unknown>) : null;
  const seconds = row ? parseHex(row.blockTimestamp) : null;
  return seconds && seconds > 0 ? seconds * 1000 : null;
}

export function logBlockNumber(log: unknown): number | null {
  const row = log && typeof log === "object" ? (log as Record<string, unknown>) : null;
  return row ? parseHex(row.blockNumber) : null;
}
