/**
 * Insertion-ordered Map used as an LRU: a hit re-inserts the key, eviction drops the oldest. The same shape
 * tape/robinhood/blocks.ts keeps inline; factored out so the trader caches (code, receipt) bound memory the same way.
 */
export class LruMap<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly max: number) {
    if (!Number.isFinite(max) || max < 1) throw new Error(`LruMap: max must be >= 1, got ${String(max)}`);
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** A hit moves the key to the most-recent end. */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const hit = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  values(): IterableIterator<V> {
    return this.entries.values();
  }

  /** Oldest first (the LRU order), so re-inserting in this order rebuilds the same eviction order. */
  entriesOldestFirst(): IterableIterator<[K, V]> {
    return this.entries.entries();
  }
}
