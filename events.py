"""Assemble the forward event calendar with expected-move estimates."""

from datetime import date, timedelta

import expected_move
from cache import CACHE
from datasources import finnhub_cal, lockups, macro_cal

DAYS_AHEAD = 45
PAST_LOOKBACK_DAYS = 500  # for historical per-symbol earnings moves


def _equity_symbols(xyz_universe):
    """Base symbols for xyz equity perps (strip the 'xyz:' prefix)."""
    out = {}
    for name in xyz_universe:
        if ":" in name:
            out[name.split(":", 1)[1].upper()] = name
    return out


def _past_earnings_by_symbol(watch_symbols):
    """Past earnings dates for the WATCHLIST symbols (one cheap per-symbol
    call each, cached 24h). Historical event-vol is only computed for these,
    so the wide-universe row cap never applies."""
    def fetch():
        from signals import market_today
        today = market_today()
        frm = (today - timedelta(days=PAST_LOOKBACK_DAYS)).isoformat()
        return {
            sym: finnhub_cal.past_earnings_dates(sym, frm, today.isoformat())
            for sym in watch_symbols
        }
    try:
        return CACHE.get_or_fetch("past_earnings", 24 * 3600, fetch)
    except Exception:
        return {}


def _upcoming_earnings(symbols):
    def fetch():
        from signals import market_today
        today = market_today()
        to = (today + timedelta(days=DAYS_AHEAD)).isoformat()
        return finnhub_cal.earnings_calendar(today.isoformat(), to, symbols)
    try:
        return CACHE.get_or_fetch("upcoming_earnings", 6 * 3600, fetch)
    except Exception:
        return []


def build_event_calendar(xyz_universe, tracked_watchlist=()):
    """Full forward calendar: earnings + macro, each with expected move.

    Expected-move estimation is limited to watchlist + near-term names to
    keep upstream calls bounded; other events still list without an estimate.
    """
    sym_map = _equity_symbols(xyz_universe)
    symbols = sorted(sym_map.keys())
    watch = {s.upper() for s in tracked_watchlist}
    past_by_sym = _past_earnings_by_symbol(sorted(watch & set(symbols)))

    events = []
    soon_cutoff = (date.today() + timedelta(days=14)).isoformat()
    for e in _upcoming_earnings(symbols):
        sym = e["symbol"]
        ev = {
            "date": e["date"], "event_type": "earnings", "symbol": sym,
            "hl_coin": sym_map.get(sym),
            "tradeable": sym in sym_map,
            "label": "{} earnings ({})".format(sym, e.get("hour") or "time tbd"),
            "eps_estimate": e.get("eps_estimate"),
        }
        # Bound expensive estimation: watchlist names, or anything imminent.
        if sym in watch or e["date"] <= soon_cutoff:
            est = expected_move.equity_event_move(
                sym, sym_map.get(sym), past_by_sym.get(sym, []))
            if est:
                ev.update(est)
        events.append(ev)

    for m in macro_cal.upcoming_macro_events(DAYS_AHEAD):
        ev = dict(m)
        ev["symbol"] = "MACRO"
        est = expected_move.macro_event_move(m["event_type"])
        if est:
            ev.update(est)
        # Macro moves the whole tape; expose its liquid proxy as the market.
        ev["hl_coin"] = ev.get("proxy") or "BTC"
        ev["tradeable"] = True
        events.append(ev)

    # Estimated IPO lockup expirations (vested/insider stock unlocks).
    try:
        lockup_events = CACHE.get_or_fetch(
            "lockups", 24 * 3600,
            lambda: lockups.estimated_lockup_expiries(DAYS_AHEAD))
    except Exception:
        lockup_events = []
    for l in lockup_events:
        sym = l["symbol"]
        hl_coin = sym_map.get(sym)
        ev = {
            "date": l["date"], "event_type": "lockup", "symbol": sym,
            "hl_coin": hl_coin,
            "tradeable": hl_coin is not None,
            "label": "{} lockup expiry est. (IPO {})".format(sym, l["ipo_date"]),
            "detail": "{} — est. 180d post-IPO; actual terms are set in the "
                      "S-1 and may differ".format(l.get("name") or sym),
        }
        # Only estimate a move when the name actually trades on HL.
        if hl_coin:
            floor = expected_move.realized_vol_floor(hl_coin)
            if floor is not None:
                ev.update({"expected_move_pct": floor, "method": "realized-vol",
                           "detail": ev["detail"] + " · 1-day sigma floor"})
        events.append(ev)

    events.sort(key=lambda e: (e["date"], e.get("symbol", "")))
    return events
