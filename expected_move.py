"""Hybrid expected-move estimation for calendar events.

Method ladder (most to least forward-looking):
  1. options-implied  — ATM straddle / spot from Yahoo (equities, best effort)
  2. historical-event — avg |move| on past similar event dates (HL candles)
  3. realized-vol     — plain daily sigma * sqrt(1) as a floor estimate

Every estimate carries its `method` so the UI can label provenance honestly.
"""

import statistics
from datetime import date, timedelta

from cache import CACHE
from datasources import hl, yahoo_opts

# Macro events move the whole tape; estimate on liquid proxies.
MACRO_PROXIES = {"fomc": "BTC", "cpi": "BTC", "nfp": "BTC", "opex": "BTC"}
# Past decision/release days used for historical macro event-vol (2025-2026).
PAST_EVENT_DAYS = {
    "fomc": ["2025-09-17", "2025-10-29", "2025-12-10", "2026-01-28",
             "2026-03-18", "2026-04-29", "2026-06-17"],
    "cpi": ["2025-12-18", "2026-01-13", "2026-02-11", "2026-03-11",
            "2026-04-10", "2026-05-12", "2026-06-10", "2026-07-14"],
    "nfp": ["2026-01-09", "2026-02-06", "2026-03-06", "2026-04-03",
            "2026-05-01", "2026-06-05", "2026-07-02"],
    "opex": ["2026-01-16", "2026-02-20", "2026-03-20", "2026-04-17",
             "2026-05-15", "2026-06-19", "2026-07-17"],
}


def _moves_for(coin):
    return CACHE.get_or_fetch(
        "moves:" + coin, 3600, lambda: hl.daily_moves(coin, limit=420))


def historical_event_move(coin, event_days):
    """Avg |%| move on the given past event dates. None if <3 samples."""
    moves = _moves_for(coin)
    samples = [abs(moves[d]) for d in event_days if d in moves]
    if len(samples) < 3:
        return None, 0
    return round(statistics.mean(samples), 2), len(samples)


def realized_vol_floor(coin):
    """One-day sigma of daily moves over ~90d, as a floor estimate."""
    moves = _moves_for(coin)
    recent = list(moves.values())[-90:]
    if len(recent) < 30:
        return None
    return round(statistics.pstdev(recent), 2)


def equity_event_move(base_symbol, hl_coin, past_earnings_days):
    """Expected move for an equity earnings event.

    Tries implied (Yahoo), then historical past-earnings moves on the HL perp,
    then realized-vol floor. Returns dict or None.
    """
    def _try_implied():
        pct, expiry = yahoo_opts.implied_move_pct(base_symbol)
        return {"pct": pct, "expiry": expiry} if pct else None

    implied = CACHE.get_or_fetch(
        "implied:" + base_symbol, 4 * 3600, lambda: _try_implied() or {})
    if implied and implied.get("pct"):
        return {"expected_move_pct": implied["pct"], "method": "options-implied",
                "detail": "ATM straddle, exp {}".format(implied.get("expiry"))}

    if past_earnings_days:
        pct, n = historical_event_move(hl_coin, past_earnings_days)
        if pct is not None:
            return {"expected_move_pct": pct, "method": "historical-event",
                    "detail": "avg |move| last {} earnings".format(n)}

    floor = realized_vol_floor(hl_coin)
    if floor is not None:
        return {"expected_move_pct": floor, "method": "realized-vol",
                "detail": "1-day sigma (90d) — floor estimate"}
    return None


def macro_event_move(event_type):
    """Expected move for a macro event, on its liquid proxy (BTC)."""
    proxy = MACRO_PROXIES.get(event_type, "BTC")
    pct, n = historical_event_move(proxy, PAST_EVENT_DAYS.get(event_type, []))
    if pct is not None:
        return {"expected_move_pct": pct, "method": "historical-event",
                "detail": "{} avg |move| last {} {} days".format(
                    proxy, n, event_type.upper()), "proxy": proxy}
    floor = realized_vol_floor(proxy)
    if floor is not None:
        return {"expected_move_pct": floor, "method": "realized-vol",
                "detail": "{} 1-day sigma (90d)".format(proxy), "proxy": proxy}
    return None


def crypto_funding_reads(coins):
    """Funding crowding per coin from current asset contexts (main dex).

    Positive funding = longs pay = crowded long. Thresholds mirror the
    research pipeline's crypto_events module (0.05%/8h avg = crowded).
    """
    ctxs = CACHE.get_or_fetch("ctx:main", 120, lambda: hl.asset_ctxs(""))
    out = []
    for coin in coins:
        ctx = ctxs.get(coin)
        if not ctx or ctx.get("funding") is None:
            continue
        f8h = ctx["funding"] * 8  # hourly -> 8h equivalent
        side = "long" if f8h > 0.0005 else "short" if f8h < -0.0005 else None
        if side:
            out.append({"coin": coin, "funding_8h_pct": round(f8h * 100, 4),
                        "crowded_side": side})
    return out
