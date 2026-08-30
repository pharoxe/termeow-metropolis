"""Market-implied Fed path from official, keyless sources.

Prediction markets (Polymarket, Kalshi) are ISP-blocked in this region and
CME prohibits scripted access, so rate expectations are derived the classic
way instead: T-bill yields vs the effective fed funds rate.

  - NY Fed:      current EFFR + target range (markets.newyorkfed.org)
  - Treasury:    daily par yield curve (home.treasury.gov XML)

3M bill minus EFFR ~= policy moves priced over the next quarter
(+25bp ~ one hike, -25bp ~ one cut). An approximation, labeled as such —
not a meeting-by-meeting probability tree.
"""

import json
import re
import urllib.request
from datetime import date, timedelta

TIMEOUT = 15
UA = {"User-Agent": "hl-terminal research vish2030@gmail.com"}

EFFR_URL = "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json"
CURVE_URL = ("https://home.treasury.gov/resource-center/data-chart-center/"
             "interest-rates/pages/xml?data=daily_treasury_yield_curve"
             "&field_tdr_date_value_month={month}")

_TENORS = ("BC_1MONTH", "BC_3MONTH", "BC_6MONTH", "BC_1YEAR",
           "BC_2YEAR", "BC_10YEAR")


def _get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read().decode(errors="ignore")


def effr():
    d = json.loads(_get(EFFR_URL))
    rows = d.get("refRates") or []
    if not rows:
        return None
    r = rows[0]
    return {
        "rate": r.get("percentRate"),
        "date": r.get("effectiveDate"),
        "target_from": r.get("targetRateFrom"),
        "target_to": r.get("targetRateTo"),
    }


def yield_curve():
    """Latest daily par yields; falls back a month at the month boundary."""
    for back in (0, 1):
        d = date.today().replace(day=1) - timedelta(days=back * 2)
        xml = _get(CURVE_URL.format(month=d.strftime("%Y%m")))
        entries = re.findall(r"<content[^>]*>.*?</content>", xml, re.S)
        if not entries:
            continue
        last = entries[-1]
        out = {}
        m = re.search(r"<d:NEW_DATE[^>]*>([^<T]+)", last)
        out["date"] = m.group(1) if m else None
        for tag in _TENORS:
            m = re.search(r"<d:%s[^>]*>([\d.]+)" % tag, last)
            if m:
                out[tag.replace("BC_", "").lower()] = float(m.group(1))
        if len(out) > 1:
            return out
    return None


def fed_path():
    """Combined read: EFFR, curve, and bill-implied policy moves."""
    out = {"effr": None, "curve": None, "implied": None}
    try:
        out["effr"] = effr()
    except Exception:
        pass
    try:
        out["curve"] = yield_curve()
    except Exception:
        pass
    e, c = out["effr"], out["curve"]
    if e and e.get("rate") is not None and c:
        implied = {}
        for tenor, label in (("3month", "3m"), ("6month", "6m")):
            if c.get(tenor) is not None:
                bp = round((c[tenor] - e["rate"]) * 100)
                implied[label + "_spread_bp"] = bp
                implied[label + "_moves_priced"] = round(bp / 25, 1)
        if c.get("2year") is not None and c.get("10year") is not None:
            implied["s2s10_bp"] = round((c["10year"] - c["2year"]) * 100)
        out["implied"] = implied or None
    return out
