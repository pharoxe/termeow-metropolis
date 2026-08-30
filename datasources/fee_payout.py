"""Fee revenue beside buyback spend — is the bid funded, and how durable?

A buyback rate on its own says how much is being bought. It does not say
whether the protocol can keep doing it. Payout ratio (buyback / fees) answers
that: under 100% the programme is funded out of revenue and can continue;
over 100% it is drawing down reserves and cannot, whatever the headline rate.

Fees come from DeFiLlama (public, no key). Buyback comes from the same
per-token measured history the BURN tab uses, so both sides are real numbers
rather than protocol claims.
"""

import collections
import json
import os
import tempfile
import threading
import time
import urllib.request

from datasources import buyback_history

STORE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "data", "fee_payout.json")
LLAMA = "https://api.llama.fi/summary/fees/{}?dataType=dailyFees"
TIMEOUT = 60
REBUILD_S = 6 * 3600
_LOCK = threading.Lock()
_BUILDING = set()

# Verified against DeFiLlama: each returns a dailyFees chart.
SLUGS = {"HYPE": "hyperliquid", "LIT": "lighter", "UNI": "uniswap",
         "WLFI": "world-liberty-financial", "ETHFI": "ether.fi", "JUP": "jupiter", "CAKE": "pancakeswap",
         "PUMP": "pump.fun", "ASTER": "aster"}


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "hl-terminal research"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode())


def daily_fees(slug):
    d = _get(LLAMA.format(slug))
    return d.get("totalDataChart") or []


def _month(ts):
    return time.strftime("%Y-%m", time.gmtime(ts))


def _month_bounds(key):
    y, m = (int(x) for x in key.split("-"))
    start = time.mktime((y, m, 1, 0, 0, 0, 0, 0, 0))
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    return start, time.mktime((ny, nm, 1, 0, 0, 0, 0, 0, 0))


def build(token):
    """Monthly [{month, fees, buyback, payout_pct, partial}] oldest first."""
    slug = SLUGS.get(token)
    if not slug:
        return []
    series = buyback_history.get(token)
    if not series:
        return []

    fees = collections.defaultdict(float)
    for ts, v in daily_fees(slug):
        fees[_month(ts)] += (v or 0.0)

    buys = collections.defaultdict(float)
    for r in series:
        buys[_month(r["ms"] / 1000.0)] += r.get("usd", 0.0)

    first = series[0]["ms"] / 1000.0
    last = series[-1]["ms"] / 1000.0

    out = []
    for key in sorted(set(fees) | set(buys)):
        if key not in buys:
            continue                      # no buyback data: nothing to compare
        m_start, m_end = _month_bounds(key)
        # A month the buyback series only partly covers would divide a partial
        # numerator by a full denominator. HYPE's history starts 2026-06-25, so
        # June looked like an 8% payout when it is simply 6 days of data.
        partial = first > m_start or last < min(m_end, time.time())
        f = fees.get(key, 0.0)
        b = buys[key]
        out.append({"month": key, "fees": f, "buyback": b,
                    "payout_pct": (b / f * 100.0) if f else None,
                    "partial": bool(partial)})
    return out


# A programme cannot spend materially more than it earns for long. Above this,
# the flow is not being funded out of fees — which means it is not market
# buying at all. CAKE reads ~7,500%: its "burn" is fee revenue destroyed in
# kind, not tokens purchased, matching the separate finding that its burn is
# ~296% of a day's traded volume. Printing that as a payout ratio would imply
# a bid that does not exist.
IMPLAUSIBLE_PAYOUT_PCT = 300.0


def summary(rows):
    """Headline payout over COMPLETE months only."""
    full = [r for r in rows if not r["partial"] and r["fees"]]
    if not full:
        return None
    tf = sum(r["fees"] for r in full)
    tb = sum(r["buyback"] for r in full)
    last = full[-1]
    pct = (tb / tf * 100.0) if tf else None
    implausible = pct is not None and pct > IMPLAUSIBLE_PAYOUT_PCT
    return {"months": len(full), "fees": tf, "buyback": tb,
            "payout_pct": pct,
            "latest_month": last["month"],
            "latest_payout_pct": last["payout_pct"],
            "funded": (pct < 100) if (pct is not None and not implausible) else None,
            "implausible": implausible,
            "note": ("spend exceeds fee revenue %.0fx — not fee-funded, so this "
                     "flow is tokens destroyed in kind rather than bought"
                     % (pct / 100.0)) if implausible else None}


def _load():
    try:
        with open(STORE) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _save(d):
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(STORE), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(d, fh)
        os.replace(tmp, STORE)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def get(token):
    """Cached rows; rebuilds in the background when stale."""
    store = _load()
    rec = store.get(token)
    if not rec or (time.time() - rec.get("at", 0)) > REBUILD_S:
        if token in SLUGS:
            with _LOCK:
                if token not in _BUILDING:
                    _BUILDING.add(token)
                    threading.Thread(target=_build, args=(token,),
                                     daemon=True).start()
    return (rec or {}).get("rows") or []


def _build(token):
    try:
        rows = build(token)
        daily = []
        try:
            cut = time.time() - 60 * 86400
            daily = [[int(ts), float(v or 0)] for ts, v in
                     daily_fees(SLUGS[token]) if ts >= cut]
        except Exception:
            pass
        if rows or daily:
            store = _load()
            store[token] = {"at": time.time(), "rows": rows,
                            "summary": summary(rows) if rows else None,
                            "daily": daily}
            _save(store)
    except Exception:
        pass
    finally:
        with _LOCK:
            _BUILDING.discard(token)


def cached_summary(token):
    return (_load().get(token) or {}).get("summary")


def expected(token):
    """Expected buyback from live revenue x the programme's own pass-through.

    Validated on HYPE (44 joined days): same-day corr fees-vs-buyback +0.873
    and weekly pass-through 65.6-69.7% IQR — but lag-1 corr is only +0.17, so
    this is a RUN-RATE expectation, not a daily point forecast. Its real use
    is attribution: measured falling WITH fees = revenue-driven (business);
    measured falling while fees hold = policy-driven (the AAVE-pause class,
    and the more actionable signal).
    """
    rec = _load().get(token) or {}
    daily = rec.get("daily") or []
    if len(daily) < 21:
        return None
    today = int(time.time() // 86400)
    days = {int(ts // 86400): v for ts, v in daily if int(ts // 86400) < today}
    keys = sorted(days)
    if len(keys) < 21:
        return None
    fees7 = sum(days[k] for k in keys[-7:]) / 7.0
    fees30 = sum(days[k] for k in keys[-30:]) / min(30, len(keys))
    from datasources import buyback_history
    st = buyback_history.stats(buyback_history.get(token))
    buy7, buy30 = st.get("d7"), st.get("d30")
    if not fees30:
        return None
    if buy30 is None:
        # Distinguish "no instrument" from "instrument reads zero lately":
        # WLFI's burn counter is real but batch-driven (last burn can sit
        # months back) — that idleness IS the intel, so say it.
        hist = buyback_history.get(token) or []
        last_ms = max((pt.get("ms") or 0) for pt in hist) if hist else 0
        if last_ms:
            idle_d = max(0, int((time.time() * 1000 - last_ms) / 86400000))
            attr = ("fees accruing, burn counter idle %dd since last batch"
                    % idle_d)
        else:
            attr = "revenue-only (no measurable buyback counter)"
        return {"fees_usd_day_7d": fees7, "fees_usd_day_30d": fees30,
                "passthrough_pct": None, "expected_usd_day": None,
                "measured_usd_day": None, "gap_pct": None,
                "attribution": attr}
    passthrough = buy30 / fees30
    if passthrough > 3.0:
        return None          # not fee-funded (CAKE) — expectation meaningless
    exp = fees7 * passthrough
    out = {"fees_usd_day_7d": fees7, "fees_usd_day_30d": fees30,
           "passthrough_pct": passthrough * 100.0,
           "expected_usd_day": exp, "measured_usd_day": buy7,
           "gap_pct": ((buy7 / exp - 1.0) * 100.0
                       if exp and buy7 is not None else None)}
    fee_chg = (fees7 / fees30 - 1.0) * 100.0
    buy_chg = ((buy7 / buy30 - 1.0) * 100.0
               if (buy30 and buy7 is not None) else 0.0)
    if buy_chg < -15.0:
        out["attribution"] = ("revenue-driven (fees also %+.0f%%)" % fee_chg
                              if fee_chg < -10.0 else
                              "POLICY-driven (fees only %+.0f%% but buyback %+.0f%%)"
                              % (fee_chg, buy_chg))
    return out
