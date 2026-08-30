"""Alert when a buyback rate drops sharply.

Buyback spend is a derivative of protocol revenue, so a sustained drop is the
programme telling you the business slowed — the one part of this data that is
forward-looking rather than a restatement of volume.

Two guards against crying wolf:
  * compare a 7-day mean against a 30-day mean, never day-vs-day. Daily spend
    is lumpy (HYPE ranges $0.4M-$1.5M day to day) and a single quiet day means
    nothing.
  * require the recent window to be materially below, and re-arm only after
    recovery, so one crossing does not fire every poll for a week.
"""

import json
import os
import tempfile
import threading
import time

STORE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "data", "buyback_alerts.json")

# Every programme with a daily history. Batch burners are listed but the
# cadence guard in check() skips them: CAKE burns in weekly batches and ASTER
# every ~2-4 weeks, so a 7d-vs-30d mean swings between -100% (no batch this
# week) and +300% (batch landed yesterday) — pure cadence noise, not a slowing
# programme. Only daily-cadence spenders produce a meaningful 7d mean.
WATCH = ("HYPE", "JUP", "PUMP", "CAKE", "ASTER", "VVV")
DROP_PCT = 35.0          # 7d mean this far below the 30d mean
RECOVER_PCT = 15.0       # must climb back to within this to re-arm
MIN_BASE_USD = 5000.0    # ignore programmes too small for the ratio to mean much
COOLDOWN_S = 12 * 3600
_LOCK = threading.Lock()


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


SUSTAINED_PCT = 25.0     # lower bar, but only with a monotonic decline behind it


def evaluate(token, stats):
    """Compare the 7d mean to the 30d baseline. None when not assessable."""
    recent, base = stats.get("d7"), stats.get("d30")
    if recent is None or base is None or base < MIN_BASE_USD:
        return None
    drop = (base - recent) / base * 100.0
    # 7d < 30d < 90d is a decline three windows agree on, which is stronger
    # evidence than one ratio clearing a bigger number. JUP sits at -33% with
    # 90d $82k -> 30d $61k -> 7d $41k; that is a trend, not a quiet week.
    long = stats.get("d90")
    monotonic = long is not None and recent < base < long
    return {"recent": recent, "base": base, "drop_pct": drop,
            "long": long, "monotonic": monotonic,
            "threshold": SUSTAINED_PCT if monotonic else DROP_PCT}


# Mean event-interval misses "daily dust + periodic batch" programmes: VVV has
# an entry most days, but 3 days carry 35% of the month's value (vs 15% for the
# genuinely daily HYPE/PUMP/JUP), so its 7d mean swings with batch timing.
LUMPY_TOP3_SHARE = 0.30


def _lumpy(history):
    cut = time.time() * 1000 - 30 * 86400000
    vals = [r.get("usd", 0.0) for r in history if r.get("ms", 0) >= cut]
    tot = sum(vals)
    if len(vals) < 10 or tot <= 0:
        return False
    return sum(sorted(vals)[-3:]) / tot > LUMPY_TOP3_SHARE


def check(programs, notify):
    """Fire once per sustained drop; re-arm only after the rate recovers."""
    state = _load()
    fired = []
    now = time.time()
    for p in programs:
        token = p.get("token")
        if token not in WATCH:
            continue
        cad = ((p.get("history_meta") or {}).get("cadence")) or {}
        if cad.get("batch"):
            continue        # batch cadence: 7d mean is noise (see WATCH note)
        if _lumpy(p.get("history") or []):
            continue        # daily dust + periodic batches — same noise, hidden
                            # from the interval test by the dust days (VVV)
        ev = evaluate(token, p.get("history_stats") or {})
        if not ev:
            continue
        rec = state.setdefault(token, {"armed": True, "last_fire": 0})
        if not rec["armed"]:
            if ev["drop_pct"] <= RECOVER_PCT:
                rec["armed"] = True          # recovered — watch again
            continue
        if ev["drop_pct"] < ev["threshold"]:
            continue
        if now - rec.get("last_fire", 0) < COOLDOWN_S:
            continue
        msg = (
            "BUYBACK SLOWING - {tok}\n"
            "7d avg ${r:,.0f}/day vs 30d ${b:,.0f}/day  ({d:.0f}% below)\n"
            "{trend}"
            "{note}"
        ).format(tok=token, r=ev["recent"], b=ev["base"], d=ev["drop_pct"],
                 trend=("90d ${l:,.0f}/day - declining across all three windows\n"
                        .format(l=ev["long"]) if ev["monotonic"] else ""),
                 note={"HYPE": "Assistance Fund spend tracks HL fee revenue.",
                       "JUP": "Litterbox Trust deposits track Jupiter protocol revenue.",
                       "PUMP": "PUMP burn tracks pump.fun fee revenue.",
                       }.get(token, "%s programme spend, measured on-chain." % token))
        try:
            notify(msg)
        except Exception:
            continue                          # do not consume the alert on a send failure
        try:
            from datasources import alert_log
            alert_log.record(msg, kind="buyback slowing", token=token)
        except Exception:
            pass                              # logging must never eat an alert
        rec["armed"] = False
        rec["last_fire"] = now
        rec["last"] = ev
        fired.append({"token": token, **ev})
    with _LOCK:
        _save(state)
    return fired


def monitors(programs):
    """Live state of every watched programme, for the ALERTS tab.

    Returns one row per WATCH token describing what would fire it, how far
    it currently is from that, and — when a programme is deliberately not
    assessable (batch cadence, lumpy spend, too small) — why it is silent.
    A monitor the user cannot see is a monitor they cannot trust.
    """
    state = _load()
    by_token = {p.get("token"): p for p in programs or []}
    out = []
    for token in WATCH:
        p = by_token.get(token) or {}
        rec = state.get(token) or {"armed": True, "last_fire": 0}
        row = {"token": token, "rule": "buyback slowing",
               "armed": bool(rec.get("armed", True)),
               "last_fire": rec.get("last_fire") or None}
        cad = ((p.get("history_meta") or {}).get("cadence")) or {}
        if not p:
            row.update(state_="no data", detail="programme not in the report yet")
            out.append(row)
            continue
        if cad.get("batch"):
            row.update(state_="not assessable",
                       detail="burns in batches — a 7d mean is cadence noise, "
                              "not a slowdown")
            out.append(row)
            continue
        if _lumpy(p.get("history") or []):
            row.update(state_="not assessable",
                       detail="spend is lumpy (top 3 days carry >30% of the "
                              "month) — a 7d mean swings with batch timing")
            out.append(row)
            continue
        ev = evaluate(token, p.get("history_stats") or {})
        if not ev:
            row.update(state_="warming",
                       detail="needs 30d of measured history above $%s/day"
                              % format(MIN_BASE_USD, ",.0f"))
            out.append(row)
            continue
        row.update(state_="watching" if rec.get("armed", True) else "fired",
                   drop_pct=ev["drop_pct"], threshold=ev["threshold"],
                   recent_usd_day=ev["recent"], base_usd_day=ev["base"],
                   monotonic=ev["monotonic"],
                   detail="fires if the 7d average falls %.0f%% below the 30d "
                          "average%s; now %.0f%%"
                          % (ev["threshold"],
                             " (lower bar: declining across 7d/30d/90d)"
                             if ev["monotonic"] else "",
                             ev["drop_pct"]))
        out.append(row)
    return out


def status():
    return _load()
