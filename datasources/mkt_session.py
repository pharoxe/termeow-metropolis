"""Is the underlying cash market open right now?

WHY THIS EXISTS: the depth collector now records the xyz sleeve, and most of
that sleeve is a perp on a US-listed equity. An equity-perp book legitimately
thins when the underlying cash market is shut — market makers widen because
they cannot hedge — and a book that halves every night at 02:00 IST looks
exactly like a book that is being pulled. The drain read is the same number
in both cases; only the clock separates them.

So this module answers one narrow question — is the US cash session open —
and hands the caller a sentence to print next to any drain figure on an
`xyz:` market. It deliberately does NOT classify symbols into equity vs
commodity vs index: that would be another hand-maintained literal, and this
codebase already has too many. It states the session and lets the reader
apply it, which is honest for a 24h commodity perp (the caveat simply does
not bite) and honest for a single-name equity perp (it does).

Holidays are NOT modelled — there is no free structured US market-holiday
source wired into this terminal — so the note says so rather than implying a
precision it does not have.
"""

import datetime

try:
    from zoneinfo import ZoneInfo
    _ET = ZoneInfo("America/New_York")
except Exception:                       # pragma: no cover - stdlib since 3.9
    _ET = None

RTH_OPEN = (9, 30)
RTH_CLOSE = (16, 0)


def _et_now(now=None):
    if _ET is None:
        return None
    return (now or datetime.datetime.now(tz=datetime.timezone.utc)).astimezone(_ET)


def us_cash(now=None):
    """State of the US cash equity session: open / closed / unknown."""
    t = _et_now(now)
    if t is None:
        return {"open": None, "state": "unknown",
                "note": "no timezone database available; session unknown"}
    weekday = t.weekday() < 5
    mins = t.hour * 60 + t.minute
    o = RTH_OPEN[0] * 60 + RTH_OPEN[1]
    c = RTH_CLOSE[0] * 60 + RTH_CLOSE[1]
    is_open = bool(weekday and o <= mins < c)
    if is_open:
        state = "open"
    elif not weekday:
        state = "weekend"
    elif mins < o:
        state = "pre"
    else:
        state = "post"
    return {"open": is_open, "state": state,
            "et": t.strftime("%H:%M ET %a"),
            "note": "US cash session %s (09:30-16:00 ET, holidays not modelled)"
                    % ("OPEN" if is_open else "CLOSED")}


def caveat(coin, now=None):
    """The sentence to print beside a drain figure, or None if it does not apply.

    Only `xyz:` markets get it, because only they have a cash underlying whose
    clock can masquerade as liquidity withdrawal. Crypto trades continuously,
    so for a core-HL coin there is nothing to warn about and the field is
    absent rather than a reassuring "n/a".
    """
    if not coin or ":" not in coin:
        return None
    s = us_cash(now)
    if s.get("open"):
        return None
    if s.get("open") is None:
        return s["note"]
    return ("%s — an equity-perp book thins when its underlying cannot be "
            "hedged, so read a drain here against the clock, not only the "
            "flow. Commodity and index perps run near-24h and are unaffected."
            % s["note"])
