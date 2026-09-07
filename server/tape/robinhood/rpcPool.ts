import { config } from "../../config.js";
import { EndpointPool, type EndpointPoolStats } from "./endpoints.js";

/**
 * The one Robinhood Chain endpoint pool per process, built from config.robinhood.rpcUrls on first use so tests that
 * inject their own fetchImpl never construct it. Every RPC client in the tree (evmRpc, PacedRpc, BlockTimeCache, the
 * log poller) defaults its `fetchImpl` to `robinhoodRpcFetch`, which routes requests addressed to any member URL
 * through the pool and passes every other URL straight to global fetch.
 */
let pool: EndpointPool | null = null;

export function getRobinhoodRpcPool(): EndpointPool {
  if (!pool) pool = new EndpointPool({ urls: config.robinhood.rpcUrls });
  return pool;
}

export const robinhoodRpcFetch: typeof fetch = (input, init) => getRobinhoodRpcPool().fetch(input, init);

export function robinhoodRpcStats(): EndpointPoolStats {
  return getRobinhoodRpcPool().stats();
}
