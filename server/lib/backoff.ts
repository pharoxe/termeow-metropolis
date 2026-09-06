import { UpstreamError } from "./http.js";

export type Backoff = {
  isBlocked: () => boolean;
  noteError: (error: unknown) => void;
  reset: () => void;
  blockedError: () => UpstreamError;
};

/** Blocks a source for `blockMs` after any 429, the same pattern sources/gecko.ts applies to GeckoTerminal. */
export function createBackoff(label: string, blockMs: number, now: () => number = () => Date.now()): Backoff {
  let blockedUntil = 0;
  return {
    isBlocked: () => now() < blockedUntil,
    noteError: (error) => {
      if (error instanceof UpstreamError && error.status === 429) blockedUntil = now() + blockMs;
    },
    reset: () => {
      blockedUntil = 0;
    },
    blockedError: () => new UpstreamError(`${label} backoff active after 429`, 429)
  };
}
