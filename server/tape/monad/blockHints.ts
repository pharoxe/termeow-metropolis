/**
 * Process-wide block -> ms clock fed only by the websocket transport: newHeads headers (poller.onWsHead) and the
 * non-zero `blockTimestamp` publicnode/pocket attach to log frames (poller.onWsLog; three samples were checked equal
 * to the official node's eth_getBlockByNumber timestamp, fixture r7/ws-blocktimestamp-vs-official-block.json, pinned
 * by wsCaptures.test.ts). BlockTimeCache consults it
 * before spending an RPC, so consumers that own their own cache get websocket block times without being touched.
 * Never fed from the HTTP path: the official RPC returns blockTimestamp 0x0 and must never become a clock.
 */
export const DEFAULT_BLOCK_HINTS_MAX = 20_000;

const hints = new Map<number, number>();
let max = DEFAULT_BLOCK_HINTS_MAX;
let counters = { stored: 0, served: 0 };

/** Records a block time in ms; ignores anything that is not a positive integer block with a positive ms time. */
export function rememberBlockTime(blockNumber: number, ms: number): void {
  if (!Number.isInteger(blockNumber) || blockNumber < 0 || !Number.isFinite(ms) || ms <= 0) return;
  if (hints.has(blockNumber)) return;
  hints.set(blockNumber, ms);
  counters = { ...counters, stored: counters.stored + 1 };
  while (hints.size > max) {
    const oldest = hints.keys().next().value;
    if (oldest === undefined) break;
    hints.delete(oldest);
  }
}

/** ms epoch of the block when a websocket frame has reported it, else null (the caller falls back to RPC). */
export function hintedBlockTimeMs(blockNumber: number): number | null {
  const hit = hints.get(blockNumber);
  if (hit === undefined) return null;
  counters = { ...counters, served: counters.served + 1 };
  return hit;
}

export function blockHintStats(): { size: number; stored: number; served: number } {
  return { size: hints.size, ...counters };
}

/** Test seam: empties the registry and optionally resizes the ring. */
export function resetBlockHints(nextMax = DEFAULT_BLOCK_HINTS_MAX): void {
  hints.clear();
  max = Math.max(1, nextMax);
  counters = { stored: 0, served: 0 };
}
