import type { PairRow } from "../../../shared/wire.js";
import { config } from "../../config.js";
import { flowCollector } from "../../flow/collector.js";
import { BlockTimeCache } from "../../tape/robinhood/blocks.js";
import { getLogsLane, type LaneKind, type LogsLane } from "../../tape/robinhood/logsLane.js";
import { poolResolveStatus, resolvePoolRef } from "../../tape/robinhood/pools.js";
import { EvmQuotePrice } from "../../tape/robinhood/price.js";
import { evmRpc, hexToNumber } from "../../tape/robinhood/rpc.js";
import { chainCandlesFor, type ChainCandlesResult } from "./chainCandles.js";
import { backfillSwaps, topUpSwaps, type BackfillRpc } from "./swapBackfill.js";
import { SwapCandleCache } from "./swapCache.js";

/**
 * Process-wide wiring of the chain-swap candle path against config.robinhood.rpcUrl through rpc.ts (the rpc-pool
 * track swaps that transport underneath; nothing here builds a URL). Built lazily on the first Robinhood market read
 * so tests and the Solana desk never touch it.
 */
const CHAIN = "robinhood" as const;

type Live = { cache: SwapCandleCache; blocks: BlockTimeCache; prices: EvmQuotePrice; rpc: BackfillRpc };

let live: Live | null = null;
let onCache: ((cache: SwapCandleCache) => void) | null = null;

/** Restart persistence hook (server/persist/live.ts): runs once on the swap cache right after construction, before its first read (at once when it already exists). */
export function setSwapCacheHook(hook: ((cache: SwapCandleCache) => void) | null): void {
  onCache = hook;
  if (live && hook) hook(live.cache);
}

/** Every eth_getLogs waits for a slot on the shared logs lane; `kind` decides whether it may jump queued poller ticks. */
function liveRpc(blocks: BlockTimeCache, lane: LogsLane, kind: LaneKind): BackfillRpc {
  const rpcUrl = config.robinhood.rpcUrl;
  return {
    getLogs: (filter) => lane.run(kind, () => evmRpc(rpcUrl, "eth_getLogs", [filter])),
    blockNumber: async () => hexToNumber(await evmRpc(rpcUrl, "eth_blockNumber", [])),
    blockTime: (block) => blocks.timeMs(block)
  };
}

function getLive(): Live {
  if (live) return live;
  const blocks = new BlockTimeCache({ rpcUrl: config.robinhood.rpcUrl });
  const lane = getLogsLane();
  const rpc = liveRpc(blocks, lane, "routine");
  const priority = liveRpc(blocks, lane, "priority");
  const cache = new SwapCandleCache({
    // The first fill of a pool (no continuation toBlock) takes priority slots so a paste shows bars under live load;
    // deeper continuations and top-ups queue behind poller ticks like any other logs request.
    backfill: (pool, run) => {
      return backfillSwaps(pool, run, run.toBlock === undefined ? priority : rpc);
    },
    topUp: (pool, fromBlock, onChunk) => topUpSwaps(pool, fromBlock, rpc, { onChunk })
  });
  live = { cache, blocks, prices: new EvmQuotePrice({ chain: CHAIN }), rpc };
  onCache?.(cache);
  return live;
}

async function quoteUsd(quote: string): Promise<number | null> {
  const { prices } = getLive();
  await prices.prime([quote]);
  return prices.get(quote);
}

/** Chain candles for the primary DexScreener pool (see chainCandles.ts); throws with the reason when it cannot. */
export function liveChainCandles(primary: PairRow, interval: string): Promise<ChainCandlesResult> {
  const { cache } = getLive();
  return chainCandlesFor(primary, interval, {
    resolvePool: (row) => resolvePoolRef(row, { rpcUrl: config.robinhood.rpcUrl }),
    resolveError: () => poolResolveStatus().lastError,
    cache,
    quoteUsd,
    livePrints: (pair) => flowCollector.ledger.recentPrints(CHAIN, pair)
  });
}
