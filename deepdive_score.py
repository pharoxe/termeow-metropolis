#!/usr/bin/env python3
"""Score deep-dive verdicts against realised price, and prune scored reports.

WHY THIS FILE EXISTS. deepdive_verdict has carried action/entry/stop/target/
horizon since the first run, and NOTHING has ever recorded what happened next.
31 verdicts, 0 outcomes. That is the same hole the equity book fell into --
180 decisions, 0 rows in `outcomes`, because its only outcome writer was a
manual CLI nothing ever called. So the rule here is: the scorer is wired into
the worker loop (score_due), and the CLI is the manual OVERRIDE, not the only
door. A scorer nothing runs is the bug, not the fix.

WHAT "SCORED" MEANS. Every verdict lands in exactly one of four states, and
every boundary between them is load-bearing:

  scored      TERMINAL. A judgement exists -- target, stop, ambiguous, timeout
              or no_fill. The lesson is on record and the reports may go.
  unscorable  TERMINAL. It can never be judged, and the row says exactly why
              (symbol on no dex, levels inconsistent with the action, levels
              off by 1000x, no stop AND no target AND no horizon). A verdict
              about the VERDICT, not about the market.
  open        NOT terminal. The call is still live and was deliberately not
              graded early. Never deleted.
  deferred    NOT terminal. We tried and the price source was unreachable.
              Retried next pass.

The four-way split is the point. "We looked and this cannot be graded"
(unscorable), "we could not look" (deferred), "it is not over yet" (open) and
"nobody has looked" (no outcome row at all) are four different facts, and any
two of them collapsed into one is the house invariant broken. In particular a
rate limit must never be able to condemn a verdict as unjudgeable -- that would
make it deletable on the strength of an HTTP 429.

WHAT IS NEVER INVENTED. A daily bar that touches BOTH the target and the stop
does not say which came first. The scanner drops to 1h/15m/5m/1m inside that
one bar and, if the finest data it can actually obtain still holds both,
records resolution='ambiguous' with result NULL. It does not pick a winner.
This desk has a recorded history of exactly that error (the V_reclaim
same-bar-resolution audit), and an invented winner is worse than an honest
unknown.

PRICES. Hyperliquid, the venue this terminal already charts: the main dex for
crypto (BTC/ETH/SOL/HYPE) and the `xyz` builder dex for equity perps
(NVDA/AAPL/MSFT/TSLA/META/MSTR/SPCX). The equity numbers are therefore a PERP
ON the equity, not the cash tape -- it prints around the clock and carries
basis. Every outcome records px_source and px_note so no reader can mistake
one for the other. A symbol on neither dex is `unscorable` with that reason
spelled out, never silently skipped.

Owner-facing calls (see main() for the full list):
    python3 deepdive_score.py score --dry        # judge, write nothing
    python3 deepdive_score.py score              # judge and persist
    python3 deepdive_score.py prune              # DRY RUN: what would go
    python3 deepdive_score.py prune --apply --confirm DELETE
"""

import argparse
import json
import os
import re
import shutil
import sys
import time
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import deepdive

SCORER_VERSION = "1"

# The only two statuses that permit report deletion. `open` (still live) and
# `deferred` (we could not look) are NOT terminal, and no flag overrides that:
# deleting the evidence for a call nobody has judged is the whole thing this
# feature exists to avoid.
TERMINAL = ("scored", "unscorable")


class Upstream(Exception):
    """A price source was unreachable RIGHT NOW.

    Kept distinct from "this verdict cannot be judged" on purpose. A 429 or
    a dropped connection says nothing about the call being graded, and
    recording it as `unscorable` would be terminal -- the row would never be
    retried and would become eligible for report deletion on the strength of
    a rate limit. Transient faults land in `deferred`, which is not terminal.
    """

# Root every deletable path must live under. A target that resolves outside
# this tree is refused, whatever the database says -- reports_dir is a stored
# string, and a stored string is not authority to unlink.
REPORTS_ROOT = os.path.expanduser("~/.tradingagents/logs")

# How often the worker loop is allowed to re-score. The queue polls every 30s;
# scoring makes network calls, and a verdict's outcome does not change minute
# to minute. 30 min is ~48 passes a day against a book of 31 rows.
SCORE_INTERVAL_S = 1800

# Level plausibility band, as a multiple of the close at as_of. Catches the
# unit-mixing the parser produces: verdict id 8 recorded BTC entry 63.76 and
# stop 60.50 (thousands) alongside target 69042 (absolute) against a 64696
# close. Scoring that row would have said "stop never hit" about a stop 1000x
# below the market. 10x is wide enough to clear any real stop or target.
LEVEL_BAND = 10.0

# Finest-first ladder used to break a bar that touched target AND stop.
REFINE_INTERVALS = ("1h", "15m", "5m", "1m")

DAYS_PER_UNIT = {"day": 1, "week": 7, "month": 30, "year": 365}
# LLM workups write "3-6 months" / "1-2 years". The upper bound of that
# (180-720d) left 43 of 46 Aug 26 calls sitting OPEN, with only 3 scored.
# A desk grades a swing in weeks. Cap the wait; keep the raw parse in basis.
SCORE_HORIZON_CAP_DAYS = 30

# Politeness toward a free, shared public API. See _throttle().
HL_MIN_GAP_S = 0.15
HL_RETRIES = 3
HL_BACKOFF_S = 1.0

_META_CACHE = {}        # dex -> set(coin names)
_BAR_CACHE = {}         # (coin, interval, start_ms) -> [bar, ...]
_LAST_CALL = {"t": 0.0}


# --------------------------------------------------------------------------
# price access
# --------------------------------------------------------------------------

def _hl():
    from datasources import hl
    return hl


def _dex_names(dex):
    """Coin names on a dex, cached for the life of the process."""
    if dex not in _META_CACHE:
        meta = _hl().meta(dex)
        _META_CACHE[dex] = {a["name"] for a in meta.get("universe", [])}
    return _META_CACHE[dex]


def resolve_coin(symbol):
    """symbol -> (hl_coin, px_source, px_note) or (None, None, why_not).

    Deliberately refuses rather than guesses. A '-USD' suffix means crypto and
    is looked up on the main dex ONLY: falling through to the equity dex for a
    crypto ticker would price the wrong instrument, and a wrong price source is
    a silently wrong score, which is worse than no score.
    """
    sym = (symbol or "").strip().upper()
    if not sym:
        return None, None, "verdict has no symbol"
    crypto_shaped = sym.endswith("-USD") or sym.endswith("-PERP")
    base = re.sub(r"-(USD|PERP)$", "", sym)
    try:
        main = _dex_names("")
        xyz = _dex_names("xyz")
    except Exception as exc:
        raise Upstream("Hyperliquid universe unreachable ({}: {})".format(
            type(exc).__name__, exc))

    in_main = base in main
    in_xyz = ("xyz:" + base) in xyz
    if crypto_shaped:
        if in_main:
            return base, "hyperliquid:" + base, None
        return None, None, (
            "{} is not listed on the Hyperliquid main dex, and a '-USD' ticker "
            "is not looked up on the equity dex; this terminal has no other "
            "price history for it".format(base))
    if in_main and in_xyz:
        return None, None, (
            "{} exists on BOTH the Hyperliquid main dex and the xyz equity dex; "
            "which instrument the verdict meant is not recorded, and pricing "
            "the wrong one would be a silently wrong score".format(base))
    if in_main:
        return base, "hyperliquid:" + base, None
    if in_xyz:
        return ("xyz:" + base, "hyperliquid:xyz:" + base,
                "xyz:{} is a PERP on {}, not the cash equity: it prints around "
                "the clock and carries basis, so a level can be touched at an "
                "hour the exchange was shut".format(base, base))
    return None, None, (
        "{} is on neither the Hyperliquid main dex nor the xyz equity dex; "
        "this terminal has no price history for it".format(base))


def _utc_date(ms):
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%d")


def _throttle():
    """Keep a minimum gap between Hyperliquid calls.

    MEASURED: a scoring pass that refined several ambiguous bars walked
    straight into `HTTP Error 429: Too Many Requests`, and the row it was
    working on came back unjudged. The public info API is free and shared with
    every other pane in this terminal, so the scorer -- a background job nobody
    is waiting on -- yields rather than competing with the glass.
    """
    now = time.time()
    gap = HL_MIN_GAP_S - (now - _LAST_CALL["t"])
    if gap > 0:
        time.sleep(gap)
    _LAST_CALL["t"] = time.time()


def _bars(coin, interval, start_ms=0, use_cache=True):
    """Normalised candles, ascending. [] on any upstream failure is NOT ok --
    the caller must distinguish 'no data' from 'empty window', so this raises.

    Retries a 429 with backoff and then RAISES. It must never return [] on a
    rate limit: an empty list would read as "the market never traded there",
    which is the difference between an unmeasured row and a wrong grade.
    """
    key = (coin, interval, start_ms)
    if use_cache and key in _BAR_CACHE:
        return _BAR_CACHE[key]
    raw = None
    for attempt in range(HL_RETRIES):
        _throttle()
        try:
            raw = _hl().candles(coin, interval, start_ms)
            break
        except Exception as exc:
            transient = "429" in str(exc) or "Too Many Requests" in str(exc)
            if not transient or attempt == HL_RETRIES - 1:
                raise
            time.sleep(HL_BACKOFF_S * (2 ** attempt))
    out = []
    for c in raw or []:
        try:
            out.append({"t": int(c["t"]), "o": float(c["o"]), "h": float(c["h"]),
                        "l": float(c["l"]), "c": float(c["c"]),
                        "date": _utc_date(int(c["t"]))})
        except (KeyError, TypeError, ValueError):
            continue
    out.sort(key=lambda b: b["t"])
    if use_cache:
        _BAR_CACHE[key] = out
    return out


# --------------------------------------------------------------------------
# horizon
# --------------------------------------------------------------------------

def horizon_days(text):
    """'3-6 months' -> (180, basis). Returns (None, why) when unparseable.

    The UPPER bound, always. Scoring '3-6 months' at the 3-month mark would be
    scoring a call before it is over, which is the one thing the brief for this
    scorer forbids by name.
    """
    t = (text or "").strip()
    if not t or t.lower() in ("none", "null", "n/a", "-"):
        return None, "no horizon recorded on the verdict"
    m = re.search(r"(\d+)\s*(?:[-–to]+\s*(\d+))?\s*(day|week|month|year)s?",
                  t, re.I)
    if not m:
        return None, "horizon {!r} does not parse into a number of days".format(t[:40])
    lo = int(m.group(1))
    hi = int(m.group(2)) if m.group(2) else lo
    unit = m.group(3).lower()
    days = max(lo, hi) * DAYS_PER_UNIT[unit]
    if days > SCORE_HORIZON_CAP_DAYS:
        basis = ("upper bound of {!r} = {}d, capped at {}d for scoring "
                 "(LLM date ranges must not hide a call for half a year)"
                 .format(t[:40], days, SCORE_HORIZON_CAP_DAYS))
        days = SCORE_HORIZON_CAP_DAYS
    else:
        basis = "upper bound of {!r} = {}d".format(t[:40], days)
    return days, basis


# --------------------------------------------------------------------------
# the judgement
# --------------------------------------------------------------------------

def _blank(v):
    return {
        "verdict_id": v["id"], "symbol": v["symbol"], "as_of": v["as_of"],
        "action": v.get("action"), "status": None, "resolution": None,
        "reason": None, "direction": None,
        "entry_used": None, "entry_source": None, "fill_px": None, "fill_at": None,
        "stop_used": v.get("stop"), "target_used": v.get("target"),
        "ref_px": None, "horizon_days": None, "horizon_basis": None,
        "window_start": v["as_of"], "window_end": None, "horizon_elapsed": 0,
        "px_source": None, "px_note": None, "px_interval": None, "bars_n": None,
        "exit_px": None, "exit_at": None, "result_pct": None, "result_r": None,
        "mfe_pct": None, "mae_pct": None, "ambiguous": 0,
        "scored_basis": None, "scored_at": deepdive._now(),
        "scorer_version": SCORER_VERSION,
    }


def _unscorable(o, why):
    o["status"] = "unscorable"
    o["reason"] = why
    return o


def _deferred(o, why):
    """Examined, but the data was not available. NOT terminal: retried next
    pass, never deletable, and never counted as a graded outcome."""
    o["status"] = "deferred"
    o["reason"] = why
    return o


def _open(o, why):
    o["status"] = "open"
    o["reason"] = why
    return o


def _first_touch(bar, level, side):
    """Did this bar trade through `level`? side 'up' = high>=level."""
    return bar["h"] >= level if side == "up" else bar["l"] <= level


def _refine(coin, bar, interval_from, long_side, stop, target):
    """Break a bar that touched BOTH levels. Returns (resolution, interval).

    resolution is 'target' / 'stop' / None. None means the finest data actually
    obtained still holds both, i.e. genuinely unknowable -- the caller records
    ambiguous rather than choosing.
    """
    span_end = None
    order = list(REFINE_INTERVALS)
    if interval_from in order:
        order = order[order.index(interval_from) + 1:]
    finest = interval_from
    for iv in order:
        try:
            fine = _bars(coin, iv, bar["t"])
        except Exception:
            break
        # HL returns forward from startTime; keep only the parent bar's span.
        if span_end is None:
            span_end = _bar_span_ms(interval_from)
        window = [b for b in fine if bar["t"] <= b["t"] < bar["t"] + span_end]
        if not window:
            break
        finest = iv
        for b in window:
            hit_t = _first_touch(b, target, "up" if long_side else "down")
            hit_s = _first_touch(b, stop, "down" if long_side else "up")
            if hit_t and hit_s:
                sub, sub_iv = _refine(coin, b, iv, long_side, stop, target)
                return sub, sub_iv
            if hit_t:
                return "target", iv
            if hit_s:
                return "stop", iv
    return None, finest


_SPAN_MS = {"1d": 86400000, "1h": 3600000, "15m": 900000, "5m": 300000,
            "1m": 60000}


def _bar_span_ms(interval):
    return _SPAN_MS.get(interval, 86400000)


def score_verdict(v, today=None):
    """Judge one verdict. Pure -- reads price, writes nothing.

    `v` is a dict-shaped deepdive_verdict row.
    """
    today = today or date.today()
    o = _blank(v)

    action = (v.get("action") or "").upper()
    if action == "BUY":
        long_side = True
    elif action == "SELL":
        long_side = False
    else:
        return _unscorable(o, "action {!r} is not a directional call, so there "
                              "is no trade to grade".format(action or "missing"))
    o["direction"] = "long" if long_side else "short"

    stop, target = v.get("stop"), v.get("target")
    hd, hbasis = horizon_days(v.get("horizon"))
    o["horizon_days"], o["horizon_basis"] = hd, hbasis
    if stop is None and target is None and hd is None:
        return _unscorable(o, "no stop, no target and no horizon were recorded "
                              "— there is no level whose breach and no date "
                              "whose arrival could ever resolve this call")

    try:
        coin, src, note = resolve_coin(v["symbol"])
    except Upstream as exc:
        return _deferred(o, str(exc))
    if not coin:
        return _unscorable(o, note)
    o["px_source"], o["px_note"] = src, note

    try:
        daily = _bars(coin, "1d", 0)
    except Exception as exc:
        return _deferred(o, "price history for {} is unreachable ({}: {}) — "
                            "not judged, and retried on the next pass rather "
                            "than being called unjudgeable"
                            .format(coin, type(exc).__name__, exc))
    if not daily:
        return _deferred(o, "Hyperliquid returned no daily history for {} — "
                            "an empty answer is not evidence the price never "
                            "moved".format(coin))
    o["px_interval"] = "1d"

    as_of = v["as_of"]
    at_or_before = [b for b in daily if b["date"] <= as_of]
    if not at_or_before:
        return _unscorable(o, "no {} price history reaches back to {} (oldest "
                              "bar {})".format(coin, as_of, daily[0]["date"]))
    ref_bar = at_or_before[-1]
    ref_px = ref_bar["c"]
    o["ref_px"] = ref_px

    # The bar whose UTC date is today is still FORMING. Its high/low are not
    # final, so it never resolves anything -- the same forming-bar leak the
    # watch_tower audit found. It may still supply ref_px (a call issued today
    # has no elapsed window anyway), but it is cut from the walk.
    today_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    complete = [b for b in daily if b["date"] < today_utc]

    # --- levels have to be internally consistent before anything is measured
    for name, lvl in (("entry", v.get("entry")), ("stop", stop),
                      ("target", target)):
        if lvl is None:
            continue
        if lvl <= 0 or lvl > ref_px * LEVEL_BAND or lvl < ref_px / LEVEL_BAND:
            return _unscorable(o, (
                "{} {:g} is off the {:g} close at {} by more than {:g}x — the "
                "recorded levels are not on the same scale as the market (the "
                "parser mixes thousands with absolute units), so any grade "
                "would be measuring a price that was never quoted"
            ).format(name, lvl, ref_px, as_of, LEVEL_BAND))

    entry = v.get("entry")
    if entry is None:
        entry = ref_px
        o["entry_source"] = "close@{} (no entry recorded)".format(ref_bar["date"])
    else:
        # HOW FAR THE STATED ENTRY SITS FROM THE MARKET IS ITSELF A FINDING.
        # Measured across the live book: NVDA quoted 206.94 against a 218.87
        # close, MSFT 415.12 against 481.59, HYPE 51.49 against 58.48. Those
        # are not limits placed below the bid, they are the workup reasoning
        # off a price the tape had already left. The scorer will not guess
        # which was meant -- it treats the number as written (a limit) and
        # RECORDS the gap, so the pattern is countable instead of buried in a
        # pile of rows that merely "never filled".
        gap = (entry - ref_px) / ref_px * 100.0
        o["entry_source"] = ("verdict (treated as a limit; {:+.1f}% vs the {:g} "
                             "close at {})").format(gap, ref_px, ref_bar["date"])
    o["entry_used"] = entry

    if stop is not None:
        bad = (stop >= entry) if long_side else (stop <= entry)
        if bad:
            return _unscorable(o, (
                "stop {:g} is on the wrong side of entry {:g} for a {} — as "
                "recorded these levels do not describe a tradeable plan, and "
                "guessing which number was meant is exactly the invention this "
                "scorer refuses"
            ).format(stop, entry, o["direction"]))
    if target is not None:
        bad = (target <= entry) if long_side else (target >= entry)
        if bad:
            return _unscorable(o, (
                "target {:g} is on the wrong side of entry {:g} for a {} — as "
                "recorded these levels do not describe a tradeable plan"
            ).format(target, entry, o["direction"]))

    window_end = (date.fromisoformat(as_of) + timedelta(days=hd)).isoformat() \
        if hd is not None else None
    o["window_end"] = window_end
    elapsed = bool(window_end and window_end < today.isoformat())
    o["horizon_elapsed"] = 1 if elapsed else 0

    walk = [b for b in complete if b["date"] > as_of
            and (window_end is None or b["date"] <= window_end)]
    o["bars_n"] = len(walk)

    # --- fill ------------------------------------------------------------
    marketable = (ref_px <= entry) if long_side else (ref_px >= entry)
    if v.get("entry") is None or marketable:
        fill_px, fill_at, fill_i = ref_px, ref_bar["date"], -1
        if v.get("entry") is not None:
            o["entry_source"] += "; marketable at as_of ({:g} vs {:g})".format(
                ref_px, entry)
    else:
        fill_px = fill_at = None
        fill_i = None
        for i, b in enumerate(walk):
            if _first_touch(b, entry, "down" if long_side else "up"):
                fill_px, fill_at, fill_i = entry, b["date"], i
                break
        if fill_px is None:
            why = ("limit entry {:g} was never touched — the market has stayed "
                   "{} it since {} (ref close {:g})").format(
                       entry, "above" if long_side else "below", as_of, ref_px)
            if elapsed:
                o["status"] = "scored"
                o["resolution"] = "no_fill"
                o["scored_basis"] = "horizon_elapsed"
                o["reason"] = why + "; the horizon closed {} with no position " \
                                    "ever opened".format(window_end)
                return o
            return _open(o, why + "; the window runs to {}, so this is not yet "
                               "settled".format(window_end or "an unrecorded date"))
    o["fill_px"], o["fill_at"] = fill_px, fill_at

    # --- resolution -------------------------------------------------------
    scan = walk[fill_i:] if fill_i is not None and fill_i >= 0 else walk
    exit_px = exit_at = None
    resolution = None
    # None, not 0.0. A trade with no complete bar since the fill has an
    # UNMEASURED excursion; writing 0 would say the price never moved.
    mfe = mae = None
    for idx, b in enumerate(scan):
        move_up = (b["h"] - fill_px) / fill_px * 100.0
        move_dn = (b["l"] - fill_px) / fill_px * 100.0
        fav, adv = (move_up, move_dn) if long_side else (-move_dn, -move_up)
        mfe = fav if mfe is None else max(mfe, fav)
        mae = adv if mae is None else min(mae, adv)
        hit_t = target is not None and _first_touch(
            b, target, "up" if long_side else "down")
        hit_s = stop is not None and _first_touch(
            b, stop, "down" if long_side else "up")
        if hit_t and hit_s:
            fine, iv = _refine(coin, b, "1d", long_side, stop, target)
            o["px_interval"] = iv
            if fine is None:
                o["status"] = "scored"
                o["resolution"] = "ambiguous"
                o["ambiguous"] = 1
                o["scored_basis"] = "resolution"
                o["exit_at"] = b["date"]
                o["reason"] = (
                    "the {} bar touched BOTH target {:g} and stop {:g}; refined "
                    "down to {} and both were still inside one bar, so which "
                    "came first is not knowable from the data this terminal "
                    "has. Recorded as ambiguous rather than guessing a winner."
                ).format(b["date"], target, stop, iv)
                o["mfe_pct"] = None if mfe is None else round(mfe, 3)
                o["mae_pct"] = None if mae is None else round(mae, 3)
                return o
            resolution = fine
            exit_px = target if fine == "target" else stop
            exit_at = b["date"]
            o["reason"] = ("both levels traded on {}; {} resolution says {} "
                           "first".format(b["date"], iv, fine))
            break
        if hit_t and not hit_s and idx == 0 and fill_i is not None and fill_i >= 0:
            # THE FILL AND THE TARGET INSIDE ONE BAR. This bar is where the
            # LIMIT filled, and the target sits on the OPPOSITE side of the
            # entry, so their order is not implied by the geometry. (The stop
            # is: it sits beyond the entry on the SAME side, so a bar that
            # reaches the stop must have passed the entry first -- that case
            # needs no refinement and gets none.) _refine answers "which of
            # these two levels came first", and here the near side is `entry`,
            # so a "stop" verdict means the entry filled first.
            first, iv = _refine(coin, b, "1d", long_side, entry, target)
            o["px_interval"] = iv
            if first != "stop":
                o["status"] = "scored"
                o["resolution"] = "ambiguous"
                o["ambiguous"] = 1
                o["scored_basis"] = "resolution"
                o["exit_at"] = b["date"]
                o["reason"] = (
                    ("the {} bar is where limit entry {:g} filled AND where "
                     "target {:g} printed; refined to {} and {} — so whether "
                     "the position was ever open when the target traded is not "
                     "knowable here. Recorded as ambiguous rather than booking "
                     "a win that may have happened before the fill."
                     ).format(b["date"], entry, target, iv,
                              "the target came first" if first == "target"
                              else "the order was still not separable"))
                o["mfe_pct"] = None if mfe is None else round(mfe, 3)
                o["mae_pct"] = None if mae is None else round(mae, 3)
                return o
        if hit_t:
            resolution, exit_px, exit_at = "target", target, b["date"]
            break
        if hit_s:
            resolution, exit_px, exit_at = "stop", stop, b["date"]
            break

    if resolution is None:
        if not elapsed:
            live = "no target/stop recorded" if (target is None and stop is None) \
                else "neither target nor stop touched in {} complete bar{}".format(
                    len(scan), "" if len(scan) == 1 else "s")
            if window_end:
                when = "the {} window runs to {}".format(hbasis, window_end)
            else:
                when = ("there is no date at which this call expires ({}), so "
                        "only a target or stop touch can ever settle it"
                        .format(hbasis))
            return _open(o, "{}; {} — deliberately left unscored rather than "
                            "marked to market early".format(live, when))
        settle = [b for b in complete if b["date"] <= window_end]
        if not settle:
            return _unscorable(o, "horizon closed {} but there is no complete "
                                  "bar at or before it".format(window_end))
        resolution, exit_px, exit_at = "timeout", settle[-1]["c"], settle[-1]["date"]
        o["reason"] = ("horizon closed {} with neither level touched; marked to "
                       "the {} close".format(window_end, exit_at))

    o["status"] = "scored"
    o["resolution"] = resolution
    o["scored_basis"] = "horizon_elapsed" if resolution == "timeout" else "resolution"
    o["exit_px"], o["exit_at"] = exit_px, exit_at
    sign = 1.0 if long_side else -1.0
    o["result_pct"] = round((exit_px - fill_px) / fill_px * 100.0 * sign, 3)
    if stop is not None:
        risk = abs(fill_px - stop)
        o["result_r"] = round((exit_px - fill_px) * sign / risk, 3) if risk else None
    o["mfe_pct"] = None if mfe is None else round(mfe, 3)
    o["mae_pct"] = None if mae is None else round(mae, 3)
    return o


# --------------------------------------------------------------------------
# persistence
# --------------------------------------------------------------------------

_OUT_COLS = ("verdict_id", "symbol", "as_of", "action", "status", "resolution",
             "reason", "direction", "entry_used", "entry_source", "fill_px",
             "fill_at", "stop_used", "target_used", "ref_px", "horizon_days",
             "horizon_basis", "window_start", "window_end", "horizon_elapsed",
             "px_source", "px_note", "px_interval", "bars_n", "exit_px",
             "exit_at", "result_pct", "result_r", "mfe_pct", "mae_pct",
             "ambiguous", "scored_basis", "scored_at", "scorer_version")


def _store(conn, o):
    conn.execute(
        "INSERT INTO deepdive_outcome ({}) VALUES ({}) "
        "ON CONFLICT(verdict_id) DO UPDATE SET {}".format(
            ",".join(_OUT_COLS), ",".join("?" * len(_OUT_COLS)),
            ",".join("{0}=excluded.{0}".format(c) for c in _OUT_COLS[1:])),
        [o[c] for c in _OUT_COLS])


def score_all(apply=True, only_ids=None, rescore=False, today=None):
    """Judge every verdict that needs it. Returns the list of outcome dicts.

    Terminal outcomes are NOT recomputed by default: once a call has hit its
    stop, re-reading the tape a week later must not be able to change what it
    hit. `open` and `deferred` rows are always revisited -- that is the whole
    point of them being non-terminal.
    """
    # Per-PASS caching, not per-process. Within one pass every BTC verdict
    # should share one daily fetch; ACROSS passes a long-lived worker would
    # otherwise keep grading against the first day's bars forever.
    _BAR_CACHE.clear()
    _META_CACHE.clear()
    conn = deepdive._conn()
    try:
        verdicts = [dict(r) for r in conn.execute(
            "SELECT * FROM deepdive_verdict ORDER BY id")]
        prior = {r["verdict_id"]: dict(r) for r in conn.execute(
            "SELECT * FROM deepdive_outcome")}
        out = []
        for v in verdicts:
            if only_ids is not None and v["id"] not in only_ids:
                continue
            was = prior.get(v["id"])
            if was and not rescore and was.get("status") in TERMINAL:
                continue
            try:
                o = score_verdict(v, today=today)
            except Exception as exc:      # never let one row stop the pass
                o = _blank(v)
                o["status"] = "deferred"
                o["reason"] = ("scorer raised {}: {} — recorded as deferred "
                               "rather than skipped (so it cannot look like it "
                               "was never examined) and rather than unscorable "
                               "(a fault here is not evidence the call is "
                               "unjudgeable); it is retried next pass"
                               ).format(type(exc).__name__, exc)
            out.append(o)
            if apply:
                _store(conn, o)
        if apply:
            conn.execute(
                "INSERT INTO deepdive_meta (key,value,updated_at) VALUES "
                "('last_score_at',?,?) ON CONFLICT(key) DO UPDATE SET "
                "value=excluded.value, updated_at=excluded.updated_at",
                (deepdive._now(), deepdive._now()))
            conn.commit()
        return out
    finally:
        conn.close()


def last_score_at():
    conn = deepdive._conn()
    try:
        row = conn.execute(
            "SELECT value FROM deepdive_meta WHERE key='last_score_at'").fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def score_due(interval_s=SCORE_INTERVAL_S, log=None):
    """Throttled entry point for the WORKER LOOP. This is the thing that makes
    scoring happen without anyone remembering to run it.

    Returns the outcomes written, or [] when it was not yet due. Never raises:
    a scorer fault must not be able to stall the queue that drains workups.
    """
    try:
        # Both sides through _age_s / _parse / _as_utc so a naive last_score_at
        # never meets an aware clock (the 30s TypeError that froze scoring).
        elapsed = deepdive._age_s(last_score_at())
        if elapsed is not None and elapsed < interval_s:
            return []
        out = score_all(apply=True)
        if log and out:
            done = sum(1 for o in out if o["status"] == "scored")
            opn = sum(1 for o in out if o["status"] == "open")
            bad = sum(1 for o in out if o["status"] == "unscorable")
            defer = sum(1 for o in out if o["status"] == "deferred")
            log("scorer: {} examined — {} scored, {} still open, {} unscorable, "
                "{} deferred (price source unreachable)"
                .format(len(out), done, opn, bad, defer))
        return out
    except Exception as exc:
        if log:
            log("scorer failed ({}: {}); verdicts stay unscored and the pane "
                "will keep saying so".format(type(exc).__name__, exc))
        return []


# --------------------------------------------------------------------------
# delete-once-scored
# --------------------------------------------------------------------------

def _under_root(path):
    """True only when `path` really resolves inside REPORTS_ROOT."""
    try:
        root = os.path.realpath(REPORTS_ROOT)
        p = os.path.realpath(path)
    except OSError:
        return False
    return p == root or p.startswith(root + os.sep)


def _dir_bytes(path):
    total = 0
    for dirpath, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass
    return total


def _targets_for(v):
    """The on-disk artefacts that belong to ONE verdict.

    THE TRAP THIS SOLVES. reports_dir is per-SYMBOL, not per-run: four NVDA
    verdicts all store .../logs/NVDA/TradingAgentsStrategy_logs. Deleting "the
    verdict's report directory" would take three other verdicts' evidence with
    it. The artefact that is actually per-run is the file
    full_states_log_<as_of>.json inside that directory -- and even that is
    shared when two runs used the same as_of (verdict 1 and verdict 3 are both
    NVDA @ 2026-08-18). Refcounting in prune_plan() is what makes it safe;
    this function only enumerates.
    """
    out = []
    rd = (v.get("reports_dir") or "").strip()
    if rd:
        out.append({"path": os.path.join(rd, "full_states_log_{}.json".format(
            v["as_of"])), "kind": "file"})
    # The CLI writes a second, older shape: <root>/<SYM>/<as_of>/reports/*.md
    legacy = os.path.join(REPORTS_ROOT, v["symbol"], v["as_of"])
    out.append({"path": legacy, "kind": "dir"})
    for t in out:
        t["exists"] = os.path.exists(t["path"])
        t["under_root"] = _under_root(t["path"])
        if not t["exists"]:
            t["bytes"] = 0
        elif t["kind"] == "dir":
            t["bytes"] = _dir_bytes(t["path"])
        else:
            try:
                t["bytes"] = os.path.getsize(t["path"])
            except OSError:
                t["bytes"] = 0
    return out


def prune_plan(only_ids=None):
    """DRY RUN. What would be deleted, why, and how many bytes. Writes nothing.

    Every verdict lands in `deletable`, `held` or `never`:
      deletable  terminal outcome, and every artefact it claims is claimed
                 only by other verdicts that are ALSO in this selection.
      held       terminal, but at least one artefact is shared with a verdict
                 outside the selection. Nothing of its is removed.
      never      no terminal outcome (open, or never scored). The score is the
                 precondition; there is no flag that overrides it.
    """
    conn = deepdive._conn()
    try:
        verdicts = [dict(r) for r in conn.execute(
            "SELECT * FROM deepdive_verdict ORDER BY id")]
        outcomes = {r["verdict_id"]: dict(r) for r in conn.execute(
            "SELECT * FROM deepdive_outcome")}
    finally:
        conn.close()

    targets = {v["id"]: _targets_for(v) for v in verdicts}
    refs = {}                       # path -> [verdict ids claiming it]
    for vid, ts in targets.items():
        for t in ts:
            refs.setdefault(t["path"], []).append(vid)

    selected = set(v["id"] for v in verdicts) if only_ids is None else set(only_ids)
    eligible, held, never = [], [], []
    for v in verdicts:
        o = outcomes.get(v["id"])
        status = (o or {}).get("status")
        if status not in TERMINAL:
            never.append({
                "verdict_id": v["id"], "symbol": v["symbol"], "as_of": v["as_of"],
                "status": status or "never scored",
                "why": (o or {}).get("reason") or
                       "no outcome row exists yet — run `score` first"})
            continue
        if v["id"] not in selected:
            continue
        rows, blockers, freed = [], [], 0
        for t in targets[v["id"]]:
            sharers = [i for i in refs[t["path"]] if i != v["id"]]
            outside = [i for i in sharers
                       if i not in selected
                       or (outcomes.get(i) or {}).get("status") not in TERMINAL]
            row = dict(t, shared_with=sharers, blocked_by=outside)
            rows.append(row)
            if not t["exists"]:
                continue
            if not t["under_root"]:
                blockers.append("{} resolves outside {} and will not be "
                                "touched".format(t["path"], REPORTS_ROOT))
                continue
            if outside:
                blockers.append(
                    "{} is still claimed by verdict(s) {} — deleting it would "
                    "destroy their evidence".format(
                        os.path.basename(t["path"]),
                        ", ".join(str(i) for i in outside)))
                continue
            freed += t["bytes"]
        # The ids that would have to join the selection for this verdict's
        # artefacts to become removable -- but only the ones that are THEMSELVES
        # terminal. A sibling that is still open can never be added, and saying
        # so here stops the owner reaching for a --force that does not exist.
        need = sorted({i for t in rows for i in t["blocked_by"]
                       if (outcomes.get(i) or {}).get("status") in TERMINAL})
        stuck = sorted({i for t in rows for i in t["blocked_by"]
                        if (outcomes.get(i) or {}).get("status") not in TERMINAL})
        entry = {"verdict_id": v["id"], "symbol": v["symbol"], "as_of": v["as_of"],
                 "status": status, "resolution": (o or {}).get("resolution"),
                 "result_pct": (o or {}).get("result_pct"),
                 "reports_dir": v.get("reports_dir"), "targets": rows,
                 "bytes": freed, "blocked": blockers,
                 "retry_with_ids": need, "waiting_on_unscored": stuck}
        (held if blockers else eligible).append(entry)

    # THE TOTAL IS A UNION, NOT A SUM. Four BTC verdicts share one
    # full_states_log_2026-05-01.json; adding up their per-verdict claims would
    # promise the owner 4x the disk he will actually get back. `bytes` on each
    # entry is what THAT verdict claims; `deletable_bytes` below is what the
    # filesystem would actually give up.
    freed_paths = {}
    for e in eligible:
        for t in e["targets"]:
            if t["exists"] and t["under_root"] and not t["blocked_by"]:
                freed_paths[t["path"]] = t["bytes"]

    claimed = set(refs)
    orphans = []
    if os.path.isdir(REPORTS_ROOT):
        for dirpath, _dirs, files in os.walk(REPORTS_ROOT):
            for f in files:
                p = os.path.join(dirpath, f)
                if p in claimed:
                    continue
                if any(p.startswith(c + os.sep) for c in claimed):
                    continue
                try:
                    orphans.append({"path": p, "bytes": os.path.getsize(p)})
                except OSError:
                    pass
    return {
        "generated_at": deepdive._now(),
        "root": REPORTS_ROOT,
        "dry_run": True,
        "deletable": eligible,
        "held": held,
        "never": never,
        "unreferenced": sorted(orphans, key=lambda r: -r["bytes"]),
        "totals": {
            "deletable_verdicts": len(eligible),
            "deletable_scored": sum(1 for e in eligible if e["status"] == "scored"),
            "deletable_unscorable": sum(1 for e in eligible
                                        if e["status"] == "unscorable"),
            "deletable_files": len(freed_paths),
            # union across verdicts -- see the comment above
            "deletable_bytes": sum(freed_paths.values()),
            "deletable_bytes_claimed": sum(e["bytes"] for e in eligible),
            "held_verdicts": len(held),
            "unscored_verdicts": len(never),
            "unreferenced_files": len(orphans),
            "unreferenced_bytes": sum(r["bytes"] for r in orphans),
        },
        "note": ("reports_dir is per-SYMBOL and shared: nothing is removed at "
                 "directory granularity. The unit is the per-run file "
                 "full_states_log_<as_of>.json, and a file claimed by any "
                 "verdict outside this selection is held, not deleted. "
                 "Verdict ROWS are never deleted — the outcome is the whole "
                 "point of keeping them."),
    }


def prune_apply(only_ids=None, confirm=False, include_unreferenced=False,
                log=None):
    """Owner-triggered deletion. Never called on a read, never on a timer.

    Re-derives the plan from disk immediately before acting -- a plan handed in
    from outside could be stale, and stale is how a shared file gets unlinked.

    DELETION IS BY PATH, BOOKKEEPING IS BY VERDICT, and conflating the two was
    a real bug here. Three verdicts (8, 1007, 1008) claim one
    full_states_log_2026-08-18.json. A per-verdict delete loop unlinked it once
    for verdict 8 and then got FileNotFoundError for the other two, counted
    them as failures, and left BOTH still advertising a reports_dir whose file
    no longer existed -- the house invariant broken in the direction nobody
    watches. So: unlink each unique path exactly once, then clear every verdict
    whose claimed artefacts are gone, however they came to be gone.
    """
    if not confirm:
        raise ValueError("prune_apply requires confirm=True; run the dry run first")
    plan = prune_plan(only_ids=only_ids)

    # 1. the union of paths this prune is allowed to touch, deduped
    doomed = {}
    for entry in plan["deletable"]:
        for t in entry["targets"]:
            if t["exists"] and t["under_root"] and not t["blocked_by"]:
                doomed[t["path"]] = t

    claimants = {}
    for entry in plan["deletable"]:
        for t in entry["targets"]:
            if t["path"] in doomed:
                claimants.setdefault(t["path"], []).append(entry["verdict_id"])

    # 2. unlink each once. An already-absent path is a SUCCESS, not a failure:
    #    the postcondition is "it is not there", and it is not there.
    removed, failed, failed_paths = [], [], set()
    for path, t in doomed.items():
        try:
            if not _under_root(path):
                raise OSError("refusing a path outside the reports root")
            if t["kind"] == "dir":
                shutil.rmtree(path)
            else:
                os.remove(path)
        except FileNotFoundError:
            pass
        except OSError as exc:
            failed.append({"path": path, "error": str(exc)})
            failed_paths.add(path)
            continue
        removed.append({"path": path, "bytes": t["bytes"],
                        "verdict_ids": claimants.get(path, [])})

    if include_unreferenced:
        for orphan in plan["unreferenced"]:
            if not _under_root(orphan["path"]):
                continue
            try:
                os.remove(orphan["path"])
                removed.append(dict(orphan, verdict_ids=[]))
            except FileNotFoundError:
                pass
            except OSError as exc:
                failed.append({"path": orphan["path"], "error": str(exc)})

    # 3. a verdict stops claiming a reports_dir once EVERY artefact it owned is
    #    gone. Verdicts whose file was held (shared with an unselected row) are
    #    untouched -- for them the directory is still a true statement.
    cleared = []
    for entry in plan["deletable"]:
        mine = [t for t in entry["targets"]
                if t["exists"] and t["under_root"] and not t["blocked_by"]]
        if not mine:
            continue                      # nothing of this verdict's was on disk
        if any(t["path"] in failed_paths for t in mine):
            continue                      # a removal failed; the claim is still true
        if any(os.path.exists(t["path"]) for t in mine):
            continue                      # belt and braces: it is still there
        cleared.append((entry, len(mine)))

    conn = deepdive._conn()
    try:
        for entry, n in cleared:
            note = ("reports removed {} ({} file/dir, {} bytes). The OUTCOME "
                    "row is untouched: the score is kept, only the bulk is "
                    "dropped.").format(deepdive._now(), n, entry["bytes"])
            conn.execute(
                "UPDATE deepdive_verdict SET reports_dir=NULL, "
                "reports_deleted_at=?, reports_note=? WHERE id=?",
                (deepdive._now(), note, entry["verdict_id"]))
        conn.commit()
    finally:
        conn.close()

    # 4. directories go only once EMPTY, and only by rmdir. Never a recursive
    #    delete of a symbol directory that other runs still live in.
    pruned_dirs = []
    for dirpath in sorted({os.path.dirname(r["path"]) for r in removed},
                          key=len, reverse=True):
        d = dirpath
        while _under_root(d) and os.path.realpath(d) != os.path.realpath(REPORTS_ROOT):
            try:
                os.rmdir(d)
            except OSError:
                break                     # not empty, or not ours: leave it
            pruned_dirs.append(d)
            d = os.path.dirname(d)

    out = {"applied_at": deepdive._now(), "removed": removed, "failed": failed,
           "empty_dirs_removed": pruned_dirs,
           "verdicts_cleared": [e["verdict_id"] for e, _ in cleared],
           "bytes_freed": sum(r["bytes"] for r in removed),
           "held": plan["held"], "never": plan["never"]}
    if log:
        log("prune: removed {} path(s), {} bytes; cleared reports_dir on "
            "verdict(s) {}{}".format(
                len(removed), out["bytes_freed"],
                out["verdicts_cleared"] or "none",
                "; {} FAILED".format(len(failed)) if failed else ""))
    return out


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def _fmt_bytes(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return "{:.1f} {}".format(n, unit)
        n /= 1024.0


def _print_scores(rows):
    if not rows:
        print("nothing to judge (every verdict already has a terminal outcome)")
        return
    for o in rows:
        head = "v{:<3} {:<9} {:<11} {:<10}".format(
            o["verdict_id"], o["symbol"], o["as_of"], o["status"])
        if o["status"] == "scored":
            head += " {:<10}".format(o["resolution"] or "")
            if o["result_pct"] is not None:
                head += " {:+.2f}%".format(o["result_pct"])
                if o["result_r"] is not None:
                    head += " ({:+.2f}R)".format(o["result_r"])
            else:
                head += " result not measured"
        print(head)
        if o.get("reason"):
            print("      {}".format(o["reason"]))
    n = len(rows)
    print("\n{} examined — {} scored, {} open, {} unscorable, {} deferred".format(
        n, sum(1 for o in rows if o["status"] == "scored"),
        sum(1 for o in rows if o["status"] == "open"),
        sum(1 for o in rows if o["status"] == "unscorable"),
        sum(1 for o in rows if o["status"] == "deferred")))


def _print_plan(plan):
    print("DRY RUN — nothing has been deleted.")
    print("root: {}".format(plan["root"]))
    t = plan["totals"]
    print("\nWOULD DELETE — {} verdict(s) ({} scored, {} unscorable), "
          "{} file(s), {} freed:".format(
              t["deletable_verdicts"], t["deletable_scored"],
              t["deletable_unscorable"], t["deletable_files"],
              _fmt_bytes(t["deletable_bytes"])))
    if t["deletable_bytes_claimed"] != t["deletable_bytes"]:
        print("      (verdicts claim {} between them; the difference is shared "
              "files counted once)".format(
                  _fmt_bytes(t["deletable_bytes_claimed"])))
    for e in plan["deletable"]:
        print("  v{} {} @{}  [{}/{}]  {}".format(
            e["verdict_id"], e["symbol"], e["as_of"], e["status"],
            e["resolution"] or "-", _fmt_bytes(e["bytes"])))
        for t in e["targets"]:
            if t["exists"]:
                print("      - {}  {}{}".format(
                    t["path"], _fmt_bytes(t["bytes"]),
                    "  (also claimed by v{})".format(
                        ", v".join(str(i) for i in t["shared_with"]))
                    if t["shared_with"] else ""))
    print("\nHELD — terminal, but the artefact is shared ({}):".format(
        plan["totals"]["held_verdicts"]))
    for e in plan["held"]:
        print("  v{} {} @{}".format(e["verdict_id"], e["symbol"], e["as_of"]))
        for b in e["blocked"]:
            print("      ! {}".format(b))
        if e.get("waiting_on_unscored"):
            print("      -> blocked by verdict(s) {} that have no terminal "
                  "outcome yet; nothing releases this until they do".format(
                      ", ".join(str(i) for i in e["waiting_on_unscored"])))
        elif e.get("retry_with_ids"):
            print("      -> re-run with --ids {},{} to take them together"
                  .format(e["verdict_id"],
                          ",".join(str(i) for i in e["retry_with_ids"])))
    print("\nNOT DELETABLE — no terminal outcome ({}):".format(
        plan["totals"]["unscored_verdicts"]))
    for e in plan["never"]:
        print("  v{} {} @{}  [{}]".format(
            e["verdict_id"], e["symbol"], e["as_of"], e["status"]))
        print("      {}".format(e["why"]))
    print("\nUNREFERENCED — on disk, claimed by no verdict ({} files, {}):"
          .format(plan["totals"]["unreferenced_files"],
                  _fmt_bytes(plan["totals"]["unreferenced_bytes"])))
    for r in plan["unreferenced"][:10]:
        print("  {}  {}".format(r["path"], _fmt_bytes(r["bytes"])))
    if len(plan["unreferenced"]) > 10:
        print("  ... {} more".format(len(plan["unreferenced"]) - 10))
    print("\n{}".format(plan["note"]))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=("score", "prune", "show"))
    ap.add_argument("--dry", action="store_true",
                    help="score: judge and print, write nothing")
    ap.add_argument("--apply", action="store_true",
                    help="prune: actually delete (needs --confirm DELETE)")
    ap.add_argument("--confirm", default="",
                    help="prune --apply: must be the literal word DELETE")
    ap.add_argument("--ids", default="",
                    help="comma-separated verdict ids to limit the action to")
    ap.add_argument("--rescore", action="store_true",
                    help="score: recompute rows that already have a terminal outcome")
    ap.add_argument("--include-unreferenced", action="store_true",
                    help="prune: also remove report files no verdict claims")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    ids = [int(x) for x in a.ids.split(",") if x.strip()] or None

    if a.cmd == "score":
        rows = score_all(apply=not a.dry, only_ids=ids, rescore=a.rescore)
        print(json.dumps(rows, indent=2)) if a.json else _print_scores(rows)
        if a.dry:
            print("\n(--dry: nothing was written)")
        return 0

    if a.cmd == "show":
        conn = deepdive._conn()
        try:
            rows = [dict(r) for r in conn.execute(
                "SELECT * FROM deepdive_outcome ORDER BY verdict_id")]
        finally:
            conn.close()
        print(json.dumps(rows, indent=2)) if a.json else _print_scores(
            [dict(r, verdict_id=r["verdict_id"]) for r in rows])
        return 0

    plan = prune_plan(only_ids=ids)
    if not a.apply:
        print(json.dumps(plan, indent=2)) if a.json else _print_plan(plan)
        return 0
    if a.confirm != "DELETE":
        print("refusing: --apply requires --confirm DELETE. Run without "
              "--apply first and read the dry run.")
        return 2
    res = prune_apply(only_ids=ids, confirm=True,
                      include_unreferenced=a.include_unreferenced)
    print(json.dumps(res, indent=2)) if a.json else print(
        "removed {} path(s), {} freed; reports_dir cleared on verdict(s) {}"
        .format(len(res["removed"]), _fmt_bytes(res["bytes_freed"]),
                res["verdicts_cleared"] or "none"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
