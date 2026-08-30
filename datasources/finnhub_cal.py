"""Finnhub earnings calendar (uses FINNHUB_API_KEY from ~/.hermes/.env)."""

import json
import os
import urllib.parse
import urllib.request

CAL_URL = "https://finnhub.io/api/v1/calendar/earnings"
TIMEOUT = 12
_ENV_PATH = os.path.expanduser("~/.hermes/.env")


def _api_key():
    key = os.environ.get("FINNHUB_API_KEY", "").strip()
    if key:
        return key
    try:
        with open(_ENV_PATH) as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("FINNHUB_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def _fetch_window(key, from_date, to_date):
    qs = urllib.parse.urlencode({"from": from_date, "to": to_date, "token": key})
    req = urllib.request.Request("{}?{}".format(CAL_URL, qs))
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        data = json.loads(resp.read().decode())
    return data.get("earningsCalendar", [])


def earnings_calendar(from_date, to_date, symbols=None):
    """Earnings events between dates; optionally filtered to a symbol set.

    Finnhub caps responses at ~1500 rows, which silently drops part of a wide
    window — so the range is fetched in 7-day chunks and merged. Returns []
    with no key (declared, not raised) — caller surfaces coverage.
    """
    key = _api_key()
    if not key:
        return []
    from datetime import date, timedelta
    start = date.fromisoformat(from_date)
    end = date.fromisoformat(to_date)
    rows, seen = [], set()
    cursor = start
    while cursor <= end:
        chunk_end = min(cursor + timedelta(days=6), end)
        try:
            for r in _fetch_window(key, cursor.isoformat(), chunk_end.isoformat()):
                dedupe = (r.get("symbol"), r.get("date"))
                if dedupe not in seen:
                    seen.add(dedupe)
                    rows.append(r)
        except Exception:
            pass  # partial coverage beats none; caller sees what arrived
        cursor = chunk_end + timedelta(days=1)
    wanted = {s.upper() for s in symbols} if symbols else None
    out = []
    for r in rows:
        sym = (r.get("symbol") or "").upper()
        if wanted is not None and sym not in wanted:
            continue
        out.append({
            "symbol": sym,
            "date": r.get("date"),
            "hour": r.get("hour"),          # bmo|amc|dmh
            "eps_estimate": r.get("epsEstimate"),
            "revenue_estimate": r.get("revenueEstimate"),
            "quarter": r.get("quarter"),
            "year": r.get("year"),
        })
    return out


def past_earnings_dates(symbol, from_date, to_date):
    """Past earnings dates for ONE symbol (calendar endpoint, symbol filter).

    One cheap call per symbol — used only for the small watchlist, so the
    wide-window row cap never applies.
    """
    key = _api_key()
    if not key:
        return []
    qs = urllib.parse.urlencode({
        "from": from_date, "to": to_date, "symbol": symbol.upper(), "token": key})
    req = urllib.request.Request("{}?{}".format(CAL_URL, qs))
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read().decode())
        return sorted({r.get("date") for r in data.get("earningsCalendar", [])
                       if r.get("date")})
    except Exception:
        return []
