"""Hourly open-interest snapshots, so position build-ups are measurable.

Hyperliquid publishes open interest as a LEVEL and keeps no history, so
"OI up 18% while price fell" — the shape that separates new shorts from
short covering — is unanswerable from the API alone. This records the
level on an hourly cadence and answers it from our own tape.

Like the flow collector, this can only accrue: there is no backfill, so
deltas are None until enough hours exist and the UI must say so rather
than imply a zero.
"""

import json
import os
import tempfile
import threading
import time

STORE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "data", "oi_history.json")
RETAIN_H = 24 * 14
# Below this the OI number is too small for a percentage change to mean
# anything, and storing 200 dust names triples the file for no signal.
MIN_VOLUME_USD = 1_000_000
_LOCK = threading.Lock()


def _load():
    try:
        with open(STORE) as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(d):
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(STORE), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(d, fh, separators=(",", ":"))
        os.replace(tmp, STORE)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def snapshot(ctxs):
    """Record this hour's OI for every liquid coin. Idempotent per hour."""
    hour = int(time.time() // 3600)
    cut = hour - RETAIN_H
    with _LOCK:
        store = _load()
        for coin, c in (ctxs or {}).items():
            oi = c.get("open_interest")
            px = c.get("mid_px") or c.get("mark_px")
            if oi is None or not px:
                continue
            if (c.get("day_volume") or 0) < MIN_VOLUME_USD:
                continue
            rec = store.setdefault(coin, {})
            # Store notional, not contracts: a coin whose price doubled has
            # twice the exposure at identical contract count, and exposure
            # is what a squeeze is made of.
            rec[str(hour)] = round(oi * px)
            for k in list(rec):
                if int(k) < cut:
                    del rec[k]
        _save(store)
    return hour


def delta(coin, hours):
    """Percent change in OI notional over `hours`, or None if not covered."""
    rec = _load().get(coin) or {}
    if not rec:
        return None
    keys = sorted(int(k) for k in rec)
    now_h = keys[-1]
    target = now_h - hours
    # Nearest sample to the target on EITHER side, then require the span it
    # actually delivers to be within 25% of the one asked for.
    #
    # This used to demand an anchor at or before `target`, which is off by
    # one bucket: N hourly samples span N-1 hours, so a store holding a full
    # 24 buckets has its oldest at now-23h and every delta(24) returned None
    # — while coverage() reported "24h, no gaps" and the UI declared the
    # squeeze screens ready. They would have sat empty indefinitely, which
    # reads identically to "no squeezes today".
    anchor = min(keys, key=lambda k: abs(k - target))
    span = now_h - anchor
    if span <= 0:
        return None
    if abs(span - hours) > max(1, hours * 0.25):
        return None
    a, b = rec[str(anchor)], rec[str(now_h)]
    if not a:
        return None
    return (b - a) / a * 100.0


def coverage():
    store = _load()
    if not store:
        return {"coins": 0, "hours": 0}
    spans = []
    for rec in store.values():
        if rec:
            ks = [int(k) for k in rec]
            spans.append(max(ks) - min(ks) + 1)
    return {"coins": len(store), "hours": max(spans) if spans else 0}
