import { config } from "../../config.js";
import { DEPRIORITIZED_HOSTS, EndpointPool, type EndpointPoolStats } from "./endpoints.js";
import { getLogsLane } from "./logsLane.js";

/**
 * The one Monad endpoint pool per process, built from config.monad.rpcUrls on first use so tests that
 * inject their own fetchImpl never construct it. Every RPC client in the tree (evmRpc, PacedRpc, BlockTimeCache, the
 * log poller) defaults its `fetchImpl` to `monadRpcFetch`, which routes requests addressed to any member URL
 * through the pool and passes every other URL straight to global fetch.
 */
let pool: EndpointPool | null = null;

export function getMonadRpcPool(): EndpointPool {
  if (!pool) {
    // The pool reports logs-lane 429s and lane-wide blocks to the shared lane; callers pace themselves through it.
    pool = new EndpointPool({ urls: config.monad.rpcUrls, chainId: config.network.chainId, logsLane: getLogsLane() });
  }
  return pool;
}

export const monadRpcFetch: typeof fetch = (input, init) => getMonadRpcPool().fetch(input, init);

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** Health lists clean endpoints first; known 429 hosts stay in the pool but are not the preferred face of it. */
export function monadRpcStats(): EndpointPoolStats {
  const stats = getMonadRpcPool().stats();
  const later = (url: string, rateLimited: number) => (rateLimited > 0 || DEPRIORITIZED_HOSTS.has(hostOf(url)) ? 1 : 0);
  return {
    ...stats,
    endpoints: [...stats.endpoints].sort((a, b) =>
      later(a.url, a.rateLimited) - later(b.url, b.rateLimited) ||
      a.rateLimited - b.rateLimited ||
      Number(b.ok) - Number(a.ok)
    )
  };
}
