"""Live buyback tape — what the fund is buying right now.

The BURN tab answers "how much per day" on a 15-minute cadence, which is right
for a rate that moves slowly. It cannot tell you the fund is stepping in HARD
in the last ten minutes, and that is the only part of this data with any
time-sensitivity to it.

Hyperliquid's Assistance Fund buys on the public spot book, so every purchase
is a real fill with an exact time, size and price. This reads the last hour of
them and expresses the recent pace against the programme's own 30-day baseline,
so "is it buying more than usual, right now" is answerable at a glance.

Only HYPE qualifies: it is the one programme whose purchases are individually
observable. The on-chain ones settle in batches, so a minute-level pace for
them would be an artefact of block timing rather than intent.
"""

import time

from cache import CACHE
from datasources import hl

AF_ADDR = "0xfefefefefefefefefefefefefefefefefefefefe"
TTL_S = 30                       # short: this panel exists to be current
WINDOWS_MIN = (5, 15, 60)
HOT_RATIO = 1.75                 # this far above baseline reads as stepping in
COLD_RATIO = 0.4


def _fills(hours=1.0):
    return hl.user_fills_by_time(AF_ADDR, (time.time() - hours * 3600) * 1000) or []


def snapshot(baseline_usd_day=None):
    """Rolling buy pace plus the most recent prints."""
    now = time.time()
    try:
        fills = _fills(1.0)
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:120]}

    buys = [f for f in fills
            if str(f.get("dir", "")).lower().startswith("buy")]
    rows = []
    for f in buys:
        try:
            rows.append({"ms": int(f["time"]), "sz": float(f["sz"]),
                         "px": float(f["px"]),
                         "usd": float(f["sz"]) * float(f["px"])})
        except (KeyError, TypeError, ValueError):
            continue
    rows.sort(key=lambda r: r["ms"])

    windows = {}
    for w in WINDOWS_MIN:
        cut = (now - w * 60) * 1000
        sel = [r for r in rows if r["ms"] >= cut]
        usd = sum(r["usd"] for r in sel)
        windows["m%d" % w] = {
            "fills": len(sel), "usd": usd,
            # Extrapolated pace, NOT a prediction — a quiet five minutes reads
            # as $0/day and a single large print reads as enormous. The ratio
            # below is what makes it interpretable.
            "pace_usd_day": usd / w * 1440.0,
        }

    out = {"ok": True, "at": now, "coin": "HYPE",
           "windows": windows,
           "recent": [dict(r) for r in rows[-12:][::-1]],
           "hour_fills": len(rows),
           "hour_usd": sum(r["usd"] for r in rows)}

    if baseline_usd_day and baseline_usd_day > 0:
        ratio = windows["m60"]["pace_usd_day"] / baseline_usd_day
        out["baseline_usd_day"] = baseline_usd_day
        out["ratio_60m"] = ratio
        out["state"] = ("stepping in" if ratio >= HOT_RATIO
                        else "quiet" if ratio <= COLD_RATIO
                        else "normal")
    return out


def cached(baseline_usd_day=None):
    return CACHE.get_or_fetch("buyflow", TTL_S,
                              lambda: snapshot(baseline_usd_day))
