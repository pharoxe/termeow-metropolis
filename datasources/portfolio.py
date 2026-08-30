"""Read-only position and risk state for a Hyperliquid account.

STRICTLY READ-ONLY. This module fetches public account state from the HL
info endpoint and derives risk metrics. It never signs, never places or
cancels an order, and holds no key material — the terminal is a decision
surface, not an execution venue.

What the raw API gives you is a list of positions. What a risk decision
needs is the distance to the things that hurt: liquidation, concentration,
and the funding bill you pay every day just to keep the book on. Those are
derived here so the pane can state them rather than imply them.
"""

import json
import time
import urllib.request

INFO = "https://api.hyperliquid.xyz/info"
TIMEOUT = 30

# Distance-to-liquidation bands, in percent of mark price. A position 5%
# from liquidation is a different object from one 60% away, and the pane
# should say so without the user doing arithmetic.
LIQ_DANGER_PCT = 10.0
LIQ_WARN_PCT = 25.0


def _post(payload):
    req = urllib.request.Request(
        INFO, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read())


def _f(x, default=None):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def state(address, dex=""):
    """Raw clearinghouse state for an address on ONE perp dex.

    `dex` is the HIP-3 deployment key ("" = core Hyperliquid, "xyz" = the
    equity/commodity DEX). Omitting it does not return "all positions" — it
    returns CORE positions only, which is how this pane came to print
    "account is flat" to an account holding twenty xyz positions. Measured on
    one wallet: no dex -> 0 positions / $3,054 account value; dex="xyz" ->
    20 positions / $23,598. 87% of the book was invisible.
    """
    payload = {"type": "clearinghouseState", "user": address}
    if dex:
        payload["dex"] = dex
    return _post(payload)


def spot_state(address):
    try:
        return _post({"type": "spotClearinghouseState", "user": address})
    except Exception:
        return {}


def build(address, ctxs=None, mids=None, dex=""):
    """Positions + account risk on ONE venue, shaped for the PORT pane.

    ``ctxs`` is the universe asset-context map (funding, mark px) so the
    daily funding bill is computed at LIVE rates rather than the rate that
    happened to apply when the position opened.

    Scoped to a single dex on purpose: `marginSummary` is PER DEX on
    Hyperliquid, so account value, margin used and leverage from two venues
    cannot be added together. build_all() below assembles the venues without
    ever summing those fields.
    """
    raw = state(address, dex=dex)
    ms = raw.get("marginSummary") or {}
    acct = _f(ms.get("accountValue"), 0.0) or 0.0
    total_ntl = _f(ms.get("totalNtlPos"), 0.0) or 0.0
    margin_used = _f(ms.get("totalMarginUsed"), 0.0) or 0.0
    maint = _f(raw.get("crossMaintenanceMarginUsed"), 0.0) or 0.0

    ctxs = ctxs or {}
    positions = []
    funding_day = 0.0
    long_ntl = short_ntl = 0.0

    for ap in raw.get("assetPositions") or []:
        p = ap.get("position") or {}
        coin = p.get("coin")
        szi = _f(p.get("szi"), 0.0) or 0.0
        if not coin or szi == 0:
            continue
        ntl = abs(_f(p.get("positionValue"), 0.0) or 0.0)
        entry = _f(p.get("entryPx"))
        upnl = _f(p.get("unrealizedPnl"), 0.0) or 0.0
        liq = _f(p.get("liquidationPx"))
        lev = (p.get("leverage") or {})
        ctx = ctxs.get(coin) or {}
        mark = _f(ctx.get("mid_px")) or ((mids or {}).get(coin) and _f(mids[coin]))
        if mark is None and entry and ntl:
            mark = ntl / abs(szi)

        # Funding at the CURRENT hourly rate. Sign convention: a long pays
        # when funding is positive, a short receives it.
        fr_hr = _f(ctx.get("funding"))
        fund_day = None
        if fr_hr is not None and ntl:
            fund_day = -(1 if szi > 0 else -1) * fr_hr * 24 * ntl
            funding_day += fund_day

        liq_dist = None
        if liq and mark:
            liq_dist = (mark - liq) / mark * 100.0 if szi > 0 else (liq - mark) / mark * 100.0
        band = None
        if liq_dist is not None:
            band = ("danger" if liq_dist <= LIQ_DANGER_PCT
                    else "warn" if liq_dist <= LIQ_WARN_PCT else "ok")

        if szi > 0:
            long_ntl += ntl
        else:
            short_ntl += ntl

        positions.append({
            "coin": coin, "side": "long" if szi > 0 else "short",
            "size": abs(szi), "notional": ntl, "entry_px": entry,
            "mark_px": mark, "upnl": upnl,
            "upnl_pct": (upnl / ntl * 100.0) if ntl else None,
            "roe_pct": (_f(p.get("returnOnEquity")) or 0.0) * 100.0,
            "liq_px": liq, "liq_dist_pct": liq_dist, "liq_band": band,
            "margin_used": _f(p.get("marginUsed")),
            "leverage": _f(lev.get("value")), "lev_type": lev.get("type"),
            "funding_usd_day": fund_day,
            "funding_paid_since_open": _f((p.get("cumFunding") or {}).get("sinceOpen")),
            "pct_of_equity": (ntl / acct * 100.0) if acct else None,
        })

    positions.sort(key=lambda r: r["notional"], reverse=True)
    gross = long_ntl + short_ntl
    biggest = positions[0] if positions else None

    return {
        "address": address,
        "venue": dex or "HL core",
        "dex": dex,
        "account_value": acct,
        "total_notional": total_ntl,
        "margin_used": margin_used,
        "maint_margin": maint,
        "withdrawable": _f(raw.get("withdrawable")),
        # Headroom before maintenance margin bites — the account-level
        # analogue of per-position liquidation distance.
        "margin_ratio_pct": (margin_used / acct * 100.0) if acct else None,
        "maint_headroom_pct": ((acct - maint) / acct * 100.0) if acct else None,
        "gross_leverage": (gross / acct) if acct else None,
        "net_exposure": long_ntl - short_ntl,
        "net_exposure_pct": ((long_ntl - short_ntl) / acct * 100.0) if acct else None,
        "long_notional": long_ntl, "short_notional": short_ntl,
        "unrealized": sum(p["upnl"] for p in positions),
        "funding_usd_day": funding_day,
        # A funding bill is only meaningful against what it is eating.
        "funding_pct_equity_day": (funding_day / acct * 100.0) if acct else None,
        "concentration_pct": biggest["pct_of_equity"] if biggest else None,
        "concentration_coin": biggest["coin"] if biggest else None,
        "positions": positions,
        "n_positions": len(positions),
        "at": time.time(),
    }


# Per-venue fetch pace. Five sequential info calls in a burst is well inside
# the limit, but venues.py was rate-shed at ten and the whale sweep is a
# noisy neighbour, so they are spaced rather than fired together.
PACE_S = 0.1


def build_all(address, dexs, ctxs=None, mids=None):
    """Every venue this account might hold on, assembled WITHOUT summing.

    Returns one full risk record per venue plus a flat position list tagged
    with its venue. There is deliberately no account-level headline: the two
    quantities a trader would want summed — account value and leverage —
    are the two Hyperliquid reports per dex, so a single "gross leverage"
    figure across venues would be arithmetic on incomparable denominators.
    The pane prints leverage per venue instead.

    A venue that FAILS is reported in `failed`, never dropped. A partial book
    presented as a whole one is the single most dangerous thing this pane can
    do — worse than an empty pane, because an empty pane is honest.
    """
    out, failed, positions = [], [], []
    for dex in dexs:
        try:
            rec = build(address, ctxs=ctxs, mids=mids, dex=dex)
        except Exception as exc:
            failed.append({"venue": dex or "HL core", "dex": dex,
                           "error": str(exc)[:120]})
            time.sleep(PACE_S)
            continue
        time.sleep(PACE_S)
        for p in rec["positions"]:
            positions.append({**p, "venue": rec["venue"], "dex": dex})
        out.append(rec)
    # Venues with nothing on them are still reported (as empty), so "flat on
    # xyz" and "xyz never queried" cannot look the same.
    out.sort(key=lambda r: -(r.get("total_notional") or 0))
    positions.sort(key=lambda p: -p["notional"])
    return {
        "address": address,
        "venues": out,
        "venues_queried": [d or "HL core" for d in dexs],
        "failed": failed,
        "positions": positions,
        "n_positions": len(positions),
        "n_venues_with_positions": sum(1 for r in out if r["n_positions"]),
        "unrealized": sum(p["upnl"] for p in positions),
        "funding_usd_day": sum(p["funding_usd_day"] or 0.0 for p in positions),
        "long_notional": sum(p["notional"] for p in positions if p["side"] == "long"),
        "short_notional": sum(p["notional"] for p in positions if p["side"] == "short"),
        # Notional and PnL ARE additive across venues (they are dollars of
        # exposure and dollars of profit). Account value and leverage are not,
        # and are absent here by design — see the docstring.
        "total_notional": sum(p["notional"] for p in positions),
        "no_sum_note": "account value, margin and leverage are reported PER "
                       "VENUE: Hyperliquid keeps a separate marginSummary for "
                       "each HIP-3 dex, so there is no cross-venue account "
                       "value to state.",
        "at": time.time(),
    }
