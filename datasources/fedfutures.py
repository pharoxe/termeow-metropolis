"""Meeting-level Fed odds implied by 30-day fed funds futures (ZQ).

Methodology (the same math CME FedWatch uses):
  - A ZQ contract settles at 100 minus the month's AVERAGE daily EFFR.
  - For a meeting month with decision day d of N days:
        avg = (d/N) * r_pre + ((N-d)/N) * r_post   ->  solve r_post.
  - When the meeting falls late in the month (few post-days make the solve
    unstable), the NEXT month's contract is used directly if that month has
    no meeting: r_post = 100 - price(next month).
  - The expected move r_post - r_pre decomposes into the two adjacent 25bp
    outcomes: e.g. +8bp = 32% chance of +25 and 68% chance of hold.
  - Meetings chain: each solve's expected r_post is the next meeting's r_pre
    (expectation-chaining — a simplification vs a full conditional tree,
    labeled as such).

Quotes come from Yahoo Finance (ZQ<month><yy>.CBT), already an accepted
source elsewhere in this stack. EFFR anchor comes from the NY Fed.
"""

import calendar
import json
import urllib.request
from datetime import date

from datasources.macro_cal import FOMC_DECISION_DAYS

TIMEOUT = 12
UA = {"User-Agent": "Mozilla/5.0 (hl-terminal research)"}
MONTH_CODES = "FGHJKMNQUVXZ"          # Jan..Dec futures month codes
MIN_POST_DAYS = 7                     # below this, prefer next-month contract
MAX_MEETINGS = 3

QUOTE_URL = ("https://query1.finance.yahoo.com/v8/finance/chart/"
             "{sym}?interval=1d&range=5d")


def _price(sym):
    req = urllib.request.Request(QUOTE_URL.format(sym=sym), headers=UA)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read().decode())
    return d["chart"]["result"][0]["meta"]["regularMarketPrice"]


def _zq_symbol(year, month):
    return "ZQ{}{}.CBT".format(MONTH_CODES[month - 1], str(year)[-2:])


def _meeting_months():
    """Upcoming meetings -> contract months we need prices for."""
    today = date.today().isoformat()
    meetings = [date.fromisoformat(m) for m in FOMC_DECISION_DAYS if m >= today]
    return meetings[:MAX_MEETINGS]


def _has_meeting(year, month):
    return any(m.startswith("{:04d}-{:02d}".format(year, month))
               for m in FOMC_DECISION_DAYS)


def _next_month(year, month):
    return (year + 1, 1) if month == 12 else (year, month + 1)


def _decompose(delta_bp):
    """Expected move -> the two adjacent 25bp outcomes with probabilities."""
    import math
    lower = math.floor(delta_bp / 25.0) * 25
    upper = lower + 25
    p_upper = (delta_bp - lower) / 25.0
    outs = [(lower, 1 - p_upper), (upper, p_upper)]
    return [{"move_bp": int(m), "prob": round(p, 3)}
            for m, p in outs if p > 0.005]


def implied_meeting_odds(effr_rate):
    """Per-meeting expected move and outcome probabilities."""
    meetings = _meeting_months()
    if not meetings or effr_rate is None:
        return None

    prices = {}
    def price_for(y, mo):
        key = (y, mo)
        if key not in prices:
            prices[key] = _price(_zq_symbol(y, mo))
        return prices[key]

    out = []
    r_pre = float(effr_rate)
    for mt in meetings:
        n_days = calendar.monthrange(mt.year, mt.month)[1]
        post_days = n_days - mt.day
        try:
            if post_days < MIN_POST_DAYS:
                ny, nm = _next_month(mt.year, mt.month)
                if _has_meeting(ny, nm):
                    raise ValueError("no clean contract")
                r_post = 100.0 - price_for(ny, nm)
                method = "next-month contract"
            else:
                avg = 100.0 - price_for(mt.year, mt.month)
                r_post = (avg * n_days - r_pre * mt.day) / post_days
                method = "day-weighted meeting month"
        except Exception:
            break  # later meetings without a clean solve are dropped
        delta_bp = round((r_post - r_pre) * 100, 1)
        out.append({
            "meeting": mt.isoformat(),
            "expected_move_bp": delta_bp,
            "outcomes": _decompose(delta_bp),
            "implied_rate_after": round(r_post, 3),
            "method": method,
        })
        r_pre = r_post  # expectation-chaining into the next meeting

    return {"meetings": out, "anchor_effr": effr_rate} if out else None
