"""Cross-sectional screen over the whole tradeable universe.

MOVERS and FUND are two fixed screens over the same data. This is the
general form: derive a comparable row for every asset, then filter and
sort it on any field. The derived fields are the point — funding as an
annualised rate rather than a per-hour decimal, basis in bps, OI change,
and a liquidity ratio — because those are the units a decision is
actually made in.
"""

from datasources import oi_history

# 8h is how traders quote HL funding; the API gives a per-hour decimal.
FUNDING_PERIODS_YEAR = 24 * 365


def _pct(a, b):
    if a is None or not b:
        return None
    return (a - b) / b * 100.0


def rows(ctxs_by_sleeve, fx=None, depth=None):
    """One comparable row per asset across every sleeve.

    `fx` is the cross-venue funding map (funding_x.fetch()); rows for coins
    with no CEX listing carry None in the venue columns — absence, never a
    fabricated comparison.

    `depth` is depth_history.metrics(): resting book at +/-25bps and — the part
    that needed a store to exist at all — how much of it is still there
    compared with an hour and a day ago. It covers only the coins the depth
    collector is subscribed to, so most of the universe carries None here. That
    is absence, exactly like the CEX columns, and the pane must say which
    universe a depth screen actually screened rather than let an empty result
    read as "no book is thinning anywhere".
    """
    out = []
    fx = fx or {}
    depth = depth or {}
    for sleeve, ctxs in (ctxs_by_sleeve or {}).items():
        for coin, c in (ctxs or {}).items():
            mid = c.get("mid_px") or c.get("mark_px")
            if not mid:
                continue
            oi = c.get("open_interest")
            vol = c.get("day_volume") or 0.0
            oi_usd = (oi * mid) if oi else None
            f_hr = c.get("funding")
            prem = c.get("premium")
            imp = c.get("impact_pxs") or []
            spread_bps = None
            if len(imp) == 2 and imp[0] and imp[1]:
                spread_bps = (imp[1] - imp[0]) / mid * 10000.0
            # Spelled out rather than splatted in: the row schema is the
            # contract the client sorts and formats against, and a **merge
            # would let a new field in the collector silently become a column.
            d = depth.get(coin) or {}
            out.append({
                "coin": coin, "sleeve": sleeve, "mid": mid,
                "chg_pct": _pct(mid, c.get("prev_day_px")),
                "volume": vol,
                "oi_usd": oi_usd,
                # Turnover: how many times the open book trades per day. High
                # ratio = hot potato, low = a parked position.
                "vol_oi": (vol / oi_usd) if oi_usd else None,
                "funding_8h_pct": (f_hr * 8 * 100.0) if f_hr is not None else None,
                "funding_apr_pct": (f_hr * FUNDING_PERIODS_YEAR * 100.0)
                                   if f_hr is not None else None,
                "basis_bps": (prem * 10000.0) if prem is not None else None,
                "spread_bps": spread_bps,
                "oi_chg_1h": oi_history.delta(coin, 1),
                "oi_chg_24h": oi_history.delta(coin, 24),
                "binance_apr": (fx.get(coin) or {}).get("binance_apr"),
                "bybit_apr": (fx.get(coin) or {}).get("bybit_apr"),
                "disloc_apr": (fx.get(coin) or {}).get("disloc_apr"),
                # Resting depth. `spread_bps` above is the venue's own impact
                # quote — a live level, no history behind it; these are the
                # recorded book, and the _chg columns are the only fields in
                # this row that could not exist without the store.
                "depth_usd": d.get("depth_usd"),
                "depth_imb": d.get("depth_imb"),
                "depth_chg_1h": d.get("depth_chg_1h"),
                "depth_chg_24h": d.get("depth_chg_24h"),
                "depth_bid_chg_1h": d.get("depth_bid_chg_1h"),
                "depth_ask_chg_1h": d.get("depth_ask_chg_1h"),
                "depth_imb_chg_1h": d.get("depth_imb_chg_1h"),
                "depth_ord_usd": d.get("depth_ord_usd"),
                "depth_air_pct": d.get("depth_air_pct"),
                "depth_h": d.get("depth_h"),
                "depth_stale": d.get("depth_stale"),
                # The imbalance column's own reliability, travelling with it.
                # Measured per instrument because it cannot be inferred from
                # size: xyz:CL holds an $8.5M book at rho 0.07, VVV $41k
                # at 0.56.
                "depth_imb_rho": d.get("depth_imb_rho"),
                "depth_imb_flip_pct": d.get("depth_imb_flip_pct"),
                "depth_imb_n": d.get("depth_imb_n"),
                "depth_imb_noisy": d.get("depth_imb_noisy"),
            })
    return out


# Each filter is (field, op, value). Ops are deliberately few: a screener
# whose language needs documenting will not be used.
OPS = {
    ">": lambda a, b: a is not None and a > b,
    ">=": lambda a, b: a is not None and a >= b,
    "<": lambda a, b: a is not None and a < b,
    "<=": lambda a, b: a is not None and a <= b,
    "abs>": lambda a, b: a is not None and abs(a) > b,
    "abs<": lambda a, b: a is not None and abs(a) < b,
}

FIELDS = {
    "chg_pct": "24h change %",
    "volume": "24h volume $",
    "oi_usd": "open interest $",
    "vol_oi": "volume / OI",
    "funding_8h_pct": "funding %/8h",
    "funding_apr_pct": "funding APR %",
    "basis_bps": "basis bps (perp vs spot index)",
    "spread_bps": "impact spread bps",
    "oi_chg_1h": "OI change 1h %",
    "oi_chg_24h": "OI change 24h %",
    "binance_apr": "Binance funding APR %",
    "bybit_apr": "Bybit funding APR %",
    "disloc_apr": "HL minus CEX-median funding, APR pts",
    "depth_usd": "resting book +/-25bps $ (both sides)",
    "depth_imb": "book imbalance, +1 all bid / -1 all ask",
    "depth_chg_1h": "book depth change 1h %",
    "depth_chg_24h": "book depth change 24h %",
    "depth_bid_chg_1h": "bid-side depth change 1h %",
    "depth_ask_chg_1h": "ask-side depth change 1h %",
    "depth_ord_usd": "average resting order size $",
    "depth_air_pct": "worst intra-minute depth vs its mean %",
    "depth_imb_rho": "lag-1 persistence of depth_imb (1 = steady, 0 = noise)",
    "depth_imb_flip_pct": "% of minutes depth_imb changes sign",
}


def validate_filters(filters):
    """(applied, rejected) — every rejected filter carries its own reason.

    apply_filters SKIPS a filter whose op it does not recognise (`continue`),
    so the screen FAILS OPEN: every row survives and the response echoes the
    filter back as though it had been applied. Measured 2026-08-16 against
    the live server, seconds apart: ?f=volume:gt:999999999999 returned the
    full 60-row page with filters=[{op:'gt'}] echoed — "60 markets match my
    screen" for a screen whose true answer is 0 — while the symbolic form
    ?f=volume:>:999999999999 correctly returned 0. An unknown FIELD is the
    mirror image: every comparison fails and the result is silently empty.
    The same silence, producing two opposite lies. Nothing may reach
    apply_filters' `continue` without the caller having been told first.
    """
    ok, bad = [], []
    for f in filters or []:
        field, op, val = f.get("field"), f.get("op"), f.get("value")
        if op not in OPS:
            bad.append(dict(f, reason="op=%r is not one of %s — this filter "
                                      "was NOT applied" % (op, sorted(OPS))))
        elif field not in FIELDS:
            bad.append(dict(f, reason="field=%r is not a screener field — "
                                      "this filter was NOT applied" % (field,)))
        else:
            try:
                float(val)
            except (TypeError, ValueError):
                bad.append(dict(f, reason="value=%r is not a number — this "
                                          "filter was NOT applied" % (val,)))
            else:
                ok.append(f)
    return ok, bad


def apply_filters(rs, filters):
    # An unrecognised op is skipped here (fail-open) and an unknown field
    # fails every row (fail-closed). Callers taking filters from a REQUEST
    # must run validate_filters() first and report what it rejected.
    out = []
    for r in rs:
        ok = True
        for f in filters or []:
            fn = OPS.get(f.get("op"))
            if not fn:
                continue
            try:
                if not fn(r.get(f.get("field")), float(f.get("value"))):
                    ok = False
                    break
            except (TypeError, ValueError):
                ok = False
                break
        if ok:
            out.append(r)
    return out


# The screens worth having pre-built: each encodes a question that the
# fixed MOVERS/FUND panes cannot ask.
PRESETS = {
    "squeeze-risk": {
        "label": "Squeeze risk — price down, OI up, shorts crowded",
        "why": "New shorts piling into a falling price is the setup that "
               "unwinds violently. Needs OI history, so it stays empty until "
               "the store has 24h.",
        "filters": [{"field": "chg_pct", "op": "<", "value": -3},
                    {"field": "oi_chg_24h", "op": ">", "value": 10},
                    {"field": "funding_8h_pct", "op": "<", "value": -0.03},
                    {"field": "volume", "op": ">", "value": 2_000_000}],
        "sort": "oi_chg_24h", "desc": True,
    },
    "carry-long": {
        "label": "Pay-me carry — short the perp, collect funding",
        "why": "Deeply positive funding is longs paying shorts. As a carry "
               "trade it is a short perp against spot, not a directional view.",
        "filters": [{"field": "funding_apr_pct", "op": ">", "value": 20},
                    {"field": "volume", "op": ">", "value": 2_000_000}],
        "sort": "funding_apr_pct", "desc": True,
    },
    "carry-short": {
        "label": "Inverted carry — longs get paid",
        "why": "Negative funding means shorts pay longs; persistent negative "
               "carry usually marks capitulation positioning.",
        "filters": [{"field": "funding_apr_pct", "op": "<", "value": -20},
                    {"field": "volume", "op": ">", "value": 2_000_000}],
        "sort": "funding_apr_pct", "desc": False,
    },
    "basis-stretch": {
        "label": "Basis stretched vs spot index",
        "why": "A perp trading far from its oracle is either a real dislocation "
               "or thin-book noise — check the spread column before believing it.",
        "filters": [{"field": "basis_bps", "op": "abs>", "value": 15},
                    {"field": "volume", "op": ">", "value": 2_000_000}],
        "sort": "basis_bps", "desc": True,
    },
    "crowded-unwind": {
        "label": "Crowded but leaving — OI falling into extreme funding",
        "why": "Extreme funding with FALLING open interest is a position being "
               "closed, not built: the move is being unwound, not fuelled.",
        "filters": [{"field": "funding_8h_pct", "op": "abs>", "value": 0.05},
                    {"field": "oi_chg_24h", "op": "<", "value": -8},
                    {"field": "volume", "op": ">", "value": 2_000_000}],
        "sort": "oi_chg_24h", "desc": False,
    },
    "cex-disloc": {
        "label": "HL crowded vs CEX — funding dislocation",
        "why": "HL funding far above Binance/Bybit for the same exposure "
               "means the crowd is on THIS venue (and the spread is the "
               "carry for whoever arbs it). Coins with no CEX listing "
               "cannot appear here by construction.",
        "filters": [{"field": "disloc_apr", "op": "abs>", "value": 25},
                    {"field": "volume", "op": ">", "value": 2_000_000}],
        "sort": "disloc_apr", "desc": True,
    },
    "book-thinning": {
        "label": "Book thinning — depth draining while price still holds",
        "why": "The question the depth store was built to answer. Resting "
               "size at +/-25bps down sharply on the hour while price has not "
               "yet moved much: the cushion is being removed before the move, "
               "not after it. Covers only the coins the depth collector is "
               "subscribed to — an empty result usually means not subscribed, "
               "so read the coverage line before reading it as calm.",
        "filters": [{"field": "depth_chg_1h", "op": "<", "value": -25},
                    {"field": "chg_pct", "op": "abs<", "value": 3},
                    {"field": "volume", "op": ">", "value": 2_000_000}],
        "sort": "depth_chg_1h", "desc": False,
    },
    "one-sided-book": {
        "label": "One-sided book — resting size lopsided",
        "why": "Imbalance beyond +/-0.35 at +/-25bps. Resting orders are "
               "CANCELLABLE and layering is cheap here, so this is a read on "
               "where liquidity is being SHOWN, not a forecast of direction — "
               "the recorded verdict is that flow and book signals do not "
               "predict direction. Pair it with the average order size: one "
               "whale wall and 5,000 retail bids look identical in the total. "
               "READ THE RHO COLUMN BEFORE THE RANK: measured minute-to-minute "
               "persistence of this very number spans 0.01 to 0.93 across the "
               "collected set (HYPE 0.92, xyz:SP500 0.90; xyz:MU 0.10 flipping "
               "sign in 46% of minutes, xyz:BRENTOIL -0.07). It is not a size "
               "threshold — xyz:CL holds an $8.5M book at rho 0.07 while VVV "
               "holds $41k at 0.56 — so a low-rho row at the top of this sort "
               "is a coin flip that happened to land, not a lopsided book.",
        "filters": [{"field": "depth_imb", "op": "abs>", "value": 0.35},
                    {"field": "volume", "op": ">", "value": 2_000_000}],
        "sort": "depth_imb", "desc": True,
    },
    "liquid-movers": {
        "label": "Real movers only — size-adjusted",
        "why": "MOVERS ranks on percentage alone, which surfaces dust. This "
               "demands the move happened on a book you could actually trade.",
        "filters": [{"field": "chg_pct", "op": "abs>", "value": 5},
                    {"field": "volume", "op": ">", "value": 10_000_000},
                    {"field": "spread_bps", "op": "<", "value": 10}],
        "sort": "chg_pct", "desc": True,
    },
}


def run(ctxs_by_sleeve, filters=None, sort="volume", desc=True, limit=60,
        fx=None, depth=None):
    """Sort with missing values ALWAYS last, in both directions.

    The previous one-pass sort put `r.get(sort) is None` in the key tuple and
    then passed reverse=desc, which inverted the null flag too — so every
    descending sort led with the rows that had no value. Since a header click
    starts descending, the first click on any nullable column (OI change,
    basis, spread, funding) returned a full page of dashes.
    """
    return screen(ctxs_by_sleeve, filters, sort, desc, limit, fx, depth)["rows"]


def screen(ctxs_by_sleeve, filters=None, sort="volume", desc=True, limit=60,
           fx=None, depth=None):
    """run() plus the two counts run() throws away.

    run() slices to `limit` and returns only the page, so /api/screen answered
    `n: len(page)` — a PAGE SIZE rendered as the number of markets that
    matched. Measured 2026-08-16: an unfiltered screen answered n=60 over a
    340-row universe. The page, the match count and the search space are
    three different numbers and a pane cannot recover the last two from the
    first.
    """
    universe = rows(ctxs_by_sleeve, fx=fx, depth=depth)
    rs = apply_filters(universe, filters)
    have = [r for r in rs if r.get(sort) is not None]
    missing = [r for r in rs if r.get(sort) is None]
    have.sort(key=lambda r: r.get(sort), reverse=desc)
    page = (have + missing)[:limit]
    return {"rows": page, "n_shown": len(page), "n_matched": len(rs),
            "n_universe": len(universe), "limit": limit,
            "sort_missing": len(missing),
            # Asked against the ROW SCHEMA, not against FIELDS: `coin`,
            # `sleeve`, `mid` and `venue` are real sortable columns that are
            # deliberately absent from the FIELDS filter vocabulary, and
            # calling a working sort "unknown" would be its own false claim.
            "sort_unknown": bool(universe) and sort not in universe[0]}
