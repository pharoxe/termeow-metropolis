"""Yahoo Finance options chain — ATM-straddle implied move (best effort).

Yahoo gates this behind a cookie+crumb handshake and rate-limits hard.
Everything here is best-effort: failures return None and the caller falls
back to historical event-vol. Results are cached upstream for hours since
implied moves drift slowly.
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
TIMEOUT = 12

_session = {"cookie": None, "crumb": None, "ts": 0}
_SESSION_TTL = 1800


def _handshake():
    """Fetch a fresh cookie + crumb pair. Returns True on success."""
    if _session["crumb"] and time.time() - _session["ts"] < _SESSION_TTL:
        return True
    try:
        req = urllib.request.Request("https://fc.yahoo.com", headers={"User-Agent": UA})
        try:
            resp = urllib.request.urlopen(req, timeout=TIMEOUT)
        except urllib.error.HTTPError as e:  # fc.yahoo 404s but still sets cookie
            resp = e
        cookie = resp.headers.get("Set-Cookie", "").split(";")[0]
        if not cookie:
            return False
        req = urllib.request.Request(
            "https://query2.finance.yahoo.com/v1/test/getcrumb",
            headers={"User-Agent": UA, "Cookie": cookie},
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            crumb = resp.read().decode().strip()
        if not crumb or len(crumb) > 30 or "Too Many" in crumb:
            return False
        _session.update(cookie=cookie, crumb=crumb, ts=time.time())
        return True
    except Exception:
        return False


def implied_move_pct(symbol):
    """ATM straddle price / spot for the nearest expiry, as a % move.

    Returns (pct, expiry_date_str) or (None, None) when unavailable.
    """
    if not _handshake():
        return None, None
    url = ("https://query2.finance.yahoo.com/v7/finance/options/{}?crumb={}"
           .format(symbol, urllib.parse.quote(_session["crumb"])))
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": UA, "Cookie": _session["cookie"]})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read().decode())
        result = (data.get("optionChain", {}).get("result") or [None])[0]
        if not result:
            return None, None
        spot = result.get("quote", {}).get("regularMarketPrice")
        options = (result.get("options") or [{}])[0]
        calls, puts = options.get("calls", []), options.get("puts", [])
        if not (spot and calls and puts):
            return None, None
        atm_call = min(calls, key=lambda o: abs(o.get("strike", 1e12) - spot))
        atm_put = min(puts, key=lambda o: abs(o.get("strike", 1e12) - spot))
        call_px = atm_call.get("lastPrice") or 0
        put_px = atm_put.get("lastPrice") or 0
        if call_px <= 0 or put_px <= 0:
            return None, None
        pct = (call_px + put_px) / spot * 100.0
        exp = options.get("expirationDate")
        exp_str = (datetime.fromtimestamp(exp, tz=timezone.utc).strftime("%Y-%m-%d")
                   if exp else None)
        return round(pct, 2), exp_str
    except Exception:
        return None, None
