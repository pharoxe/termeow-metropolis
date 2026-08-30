"""Estimated IPO share-lockup expirations (vested/insider stock unlocks).

There is no free structured lockup calendar. What IS public: IPO dates
(Finnhub IPO calendar) and the market convention that insider/employee
lockups run 180 days post-IPO (occasionally 90/365 — stated in each S-1).
So expiries here are ESTIMATES: ipo_date + 180d, labeled as such. Staggered
early releases and secondary offerings are not modeled.
"""

import json
import urllib.parse
import urllib.request
from datetime import date, timedelta

from datasources.finnhub_cal import _api_key

IPO_URL = "https://finnhub.io/api/v1/calendar/ipo"
TIMEOUT = 12
LOCKUP_DAYS = 180
LOOKBACK_DAYS = 300   # IPOs whose 180d lockup could land in the window

# Blank-check shells flood the feed; their lockup mechanics differ anyway.
_SHELL_MARKERS = ("acquisition", "merger corp", "capital corp", "spac")


def _fetch_window(key, frm, to):
    qs = urllib.parse.urlencode({"from": frm, "to": to, "token": key})
    req = urllib.request.Request("{}?{}".format(IPO_URL, qs))
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode()).get("ipoCalendar", [])


def _is_shell(name, symbol=""):
    low = (name or "").lower()
    if any(m in low for m in _SHELL_MARKERS):
        return True
    # SPAC units trade under 5-letter symbols ending in U (e.g. GIXXU).
    sym = (symbol or "").upper()
    return len(sym) == 5 and sym.endswith("U")


def estimated_lockup_expiries(days_ahead=45, today=None):
    """Estimated lockup-expiry events within the window, nearest first.

    Each event: symbol, name, ipo_date, date (est. expiry), shares/price
    when Finnhub provides them. Chunked monthly to dodge the row cap.
    """
    key = _api_key()
    if not key:
        return []
    today = today or date.today()
    horizon = today + timedelta(days=days_ahead)
    start = today - timedelta(days=LOOKBACK_DAYS)

    ipos, seen = [], set()
    cursor = start
    while cursor <= today:
        chunk_end = min(cursor + timedelta(days=30), today)
        try:
            for r in _fetch_window(key, cursor.isoformat(), chunk_end.isoformat()):
                sym = (r.get("symbol") or "").strip().upper()
                if not sym or sym in seen:
                    continue
                seen.add(sym)
                ipos.append(r)
        except Exception:
            pass  # partial coverage beats none
        cursor = chunk_end + timedelta(days=1)

    events = []
    for r in ipos:
        if (r.get("status") or "").lower() != "priced":
            continue
        if _is_shell(r.get("name"), r.get("symbol")):
            continue
        try:
            ipo_d = date.fromisoformat(r["date"])
        except (KeyError, ValueError, TypeError):
            continue
        expiry = ipo_d + timedelta(days=LOCKUP_DAYS)
        if today <= expiry <= horizon:
            events.append({
                "symbol": (r.get("symbol") or "").upper(),
                "name": r.get("name"),
                "ipo_date": r["date"],
                "date": expiry.isoformat(),
                "shares": r.get("numberOfShares"),
                "ipo_price": r.get("price"),
            })
    events.sort(key=lambda e: e["date"])
    return events
