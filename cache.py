"""Tiny thread-safe TTL cache for datasource results."""

import threading
import time

# Bound total entries: candle slices deep-size to ~340KB each, so an
# unbounded map retains tens of MB after a day of chart browsing. Eviction
# is by oldest expiry. Expired entries are NOT dead — get_or_fetch serves
# them as the stale-beats-nothing fallback — so they are only removed by
# this cap, never proactively.
MAX_ENTRIES = 300


class TTLCache:
    def __init__(self):
        self._data = {}
        self._lock = threading.Lock()
        # Per-key fetch locks give single-flight get_or_fetch: N concurrent
        # misses on one key used to do N upstream fetches, and the browser's
        # pollers are phase-locked siblings — expiry landed on a tick where
        # four universe readers fired at once, the exact burst pattern that
        # draws 429s from Hyperliquid.
        self._key_locks = {}

    def _key_lock(self, key):
        # Hold the main lock only long enough to get-or-create the key lock;
        # holding it across fetch_fn would deadlock the stale-on-exception
        # path, which needs the main lock to read the old entry.
        with self._lock:
            lk = self._key_locks.get(key)
            if lk is None:
                lk = self._key_locks[key] = threading.Lock()
            return lk

    def get(self, key):
        with self._lock:
            entry = self._data.get(key)
            if entry and entry[0] > time.time():
                return entry[1]
        return None

    def get_stale(self, key):
        """(value, fresh) — returns the value even when expired.

        `get()` hides expired entries, which makes "serve stale while a
        background thread rebuilds" impossible to express with it: the
        moment the TTL lapses the stale value becomes invisible and the
        caller ends up fetching on the request path anyway.
        """
        with self._lock:
            entry = self._data.get(key)
        if entry is None:
            return None, False
        return entry[1], entry[0] > time.time()

    def built_at(self, key):
        """Epoch seconds when `key` was last written, or None if absent.

        Reported even when the entry is EXPIRED, because get_or_fetch serves
        the stale value when a fetch raises — an age past the TTL is exactly
        the fact a consumer needs and the one it can least afford to guess.
        Added because /api/funding_x served a 300s-cached, continuously
        moving predicted rate with no timestamp at all: measured 2026-08-16,
        a cached BTC hl_apr of 1.81 next to a live recompute of 10.74 (6x) on
        a number the pane renders to one decimal with no age anywhere.
        """
        with self._lock:
            entry = self._data.get(key)
        if not entry or len(entry) < 3:
            return None
        return entry[2]

    def set(self, key, value, ttl_seconds):
        with self._lock:
            # Build time rides in the THIRD slot: appended, never inserted, so
            # every existing entry[0] (expiry) / entry[1] (value) read in this
            # file stays exactly as it was.
            now = time.time()
            self._data[key] = (now + ttl_seconds, value, now)
            if len(self._data) > MAX_ENTRIES:
                for stale_key in sorted(self._data, key=lambda k: self._data[k][0])[
                        :len(self._data) - MAX_ENTRIES]:
                    if stale_key != key:
                        del self._data[stale_key]
                        self._key_locks.pop(stale_key, None)

    def get_or_fetch(self, key, ttl_seconds, fetch_fn):
        """Return cached value, or run fetch_fn once and cache its result.

        Single-flight per key: concurrent misses queue on the key lock and
        all but the first are served from the winner's write. A failed fetch
        (exception) returns the stale value if one exists, else re-raises —
        callers decide how to degrade.
        """
        val = self.get(key)
        if val is not None:
            return val
        with self._key_lock(key):
            val = self.get(key)          # the winner may have filled it
            if val is not None:
                return val
            try:
                fresh = fetch_fn()
            except Exception:
                with self._lock:
                    entry = self._data.get(key)
                if entry is not None:
                    return entry[1]  # stale beats nothing
                raise
            self.set(key, fresh, ttl_seconds)
            return fresh


CACHE = TTLCache()
