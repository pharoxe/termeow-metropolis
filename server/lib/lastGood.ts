import { errorMessage } from "./http.js";

export type LastGood<T> = { value: T; observedAt: number; stale: boolean; error?: string };

export type LastGoodCache<T> = {
  /** Fresh value within the TTL, one in-flight load per key, last-good marked `stale` when the load fails. */
  get(key: string, load: () => Promise<T>): Promise<LastGood<T>>;
  /** The cached entry without loading; null when nothing has ever succeeded for the key. */
  peek(key: string): LastGood<T> | null;
  reset(): void;
};

type Entry<T> = { value: T; observedAt: number };

/**
 * The 60s-TTL / in-flight dedupe / last-good contract from sources/dexscreener.ts, factored out so every polled read source
 * behaves the same way. Throws only when a load fails and nothing was ever cached for that key.
 */
export function createLastGoodCache<T>(ttlMs: number, now: () => number = () => Date.now()): LastGoodCache<T> {
  const cache = new Map<string, Entry<T>>();
  const inFlight = new Map<string, Promise<LastGood<T>>>();

  async function refresh(key: string, load: () => Promise<T>, previous: Entry<T> | undefined): Promise<LastGood<T>> {
    try {
      const entry = { value: await load(), observedAt: now() };
      cache.set(key, entry);
      return { ...entry, stale: false };
    } catch (error) {
      if (!previous) throw error;
      return { ...previous, stale: true, error: errorMessage(error) };
    }
  }

  return {
    get(key, load) {
      const cached = cache.get(key);
      if (cached && now() - cached.observedAt < ttlMs) return Promise.resolve({ ...cached, stale: false });
      const pending = inFlight.get(key);
      if (pending) return pending;
      const request = refresh(key, load, cached).finally(() => inFlight.delete(key));
      inFlight.set(key, request);
      return request;
    },
    peek(key) {
      const cached = cache.get(key);
      return cached ? { ...cached, stale: now() - cached.observedAt >= ttlMs } : null;
    },
    reset() {
      cache.clear();
      inFlight.clear();
    }
  };
}
