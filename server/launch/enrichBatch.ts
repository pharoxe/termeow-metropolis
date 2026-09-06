import type { Chain } from "../../shared/wire.js";
import { launchKey } from "./index.js";

/**
 * Pure batch selection for price enrichment. `candidates` arrive newest first (LaunchIndex.tokens). Tokens never
 * attempted rank first, keeping that order, then the least recently attempted; ties keep candidate order. So a single
 * high-throughput launchpad fills at most the never-attempted slice and older rows keep rotating through.
 */
export function pickEnrichBatch(candidates: readonly string[], attemptedAt: (token: string) => number | null, limit: number): string[] {
  const ranked = candidates.map((token, order) => ({ token, order, at: attemptedAt(token) ?? 0 }));
  ranked.sort((a, b) => a.at - b.at || a.order - b.order);
  return ranked.slice(0, Math.max(0, limit)).map((row) => row.token);
}

/** Forgets attempt stamps for `chain` tokens no longer in the enrichment window, so the map tracks the live index only. */
export function pruneAttempts(attempts: Map<string, number>, chain: Chain, candidates: readonly string[]): void {
  const live = new Set(candidates.map((token) => launchKey(chain, token)));
  const prefix = `${chain}:`;
  for (const key of [...attempts.keys()]) if (key.startsWith(prefix) && !live.has(key)) attempts.delete(key);
}
