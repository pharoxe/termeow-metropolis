import type { PairRow } from "../../../shared/wire.js";
import { config } from "../../config.js";
import { flowCollector } from "../../flow/collector.js";
import { BlockTimeCache } from "../../tape/robinhood/blocks.js";
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

function liveRpc(blocks: BlockTimeCache): BackfillRpc {
  const rpcUrl = config.robinhood.rpcUrl;
  return {
    getLogs: (filter) => evmRpc(rpcUrl, "eth_getLogs", [filter]),
    blockNumber: async () => hexToNumber(await evmRpc(rpcUrl, "eth_blockNumber", [])),
    blockTime: (block) => blocks.timeMs(block)
  };
}

function getLive(): Live {
  if (live) return live;
  const blocks = new BlockTimeCache({ rpcUrl: config.robinhood.rpcUrl });
  const rpc = liveRpc(blocks);
  const cache = new SwapCandleCache({
    backfill: (pool, run) => backfillSwaps(pool, run, rpc),
    topUp: (pool, fromBlock, onChunk) => topUpSwaps(pool, fromBlock, rpc, { onChunk })
  });
  live = { cache, blocks, prices: new EvmQuotePrice({ chain: CHAIN }), rpc };
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
