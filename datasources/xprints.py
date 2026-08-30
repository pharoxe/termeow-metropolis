"""Cross-venue PRINT SIZE — how big are the trades in one instrument, per venue.

Sibling of xvenue.py: that module compares BOOKS (resting depth, spread,
bands), this one compares the TAPE (what actually printed, and how big). They
are split because they are different questions with different endpoints,
different caps and different failure modes — and because putting them on one
request would double a fan-out that is already 8 upstream calls at the cap.

WHAT THIS IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT.

It is a DESCRIPTION of how big the prints are in one market on each venue
that lists it. It is NOT an alert, NOT a threshold and NOT a signal, and
that is a measured position rather than caution.

Measured on this terminal's own stored flow: minutes carrying a p95 print
are followed by a 15-minute range 1.63x the baseline on BTC and 1.41x on
HYPE — which looks like an edge and would have shipped as one. Controlling
for hour-of-day collapses it to 1.01x and 1.00x. Big prints cluster at UTC
13-17, which is exactly the block already measured as the hottest three
hours of the day. A large-print alert is a clock with extra steps. (Limits
of that probe, stated: 48h of minute buckets, n=141 at p95, two coins, one
15m horizon — a probe, not a Protocol-v1 validation. But a residual of
1.01x is not a small uncertain effect; it is indistinguishable from the
hour.)

That is also why there is NO flat notional threshold anywhere in here. The
terminal's existing $1M whale floor fires on 93% of a 200-entry alert
buffer and crowds out everything else. And a flat number cannot work:
across 12,460 prints sampled on five venues, ZERO exceeded $1M, and p99
varies 15x WITHIN one venue (Aster HYPEUSDT $1,788 vs CLUSDT $29,852). So
"large" is only definable against a market's OWN distribution, which is
what this computes. Note also that a tape print and a whales.py POSITION
DELTA are different objects with different distributions — one threshold
cannot serve both, and nothing here is a threshold for either.

THE SAMPLE CEILINGS ARE THE HARD PART, and they are wildly asymmetric:
    Aster    /fapi/v1/aggTrades   1,000 prints  (limit honoured)
    Lighter  /api/v1/recentTrades   100 prints  (limit>100 -> HTTP 400)
    Extended /info/.../trades        50 prints  (HARD cap; the limit
                                                 parameter is accepted and
                                                 ignored above it)
    HL       {"type":"recentTrades"}  10 prints (fixed, no limit parameter)
A p99 computed from 50 observations has half an observation above it. So
each row reports the FINEST quantile its own sample can carry, under the
rule that a quantile needs at least MIN_TAIL_OBS observations at or above
it, and rows whose supported quantile differs are explicitly flagged NOT
comparable on that quantile. Printing "p99" on every row and letting four
100x-different sample sizes hide behind one label is the confident-absence
failure in its tail-statistics costume.

WINDOW LENGTH IS PART OF THE MEASUREMENT, not decoration. The same 1,000
prints span 1,843s on Aster's BTCUSDT and 145,112s (40 hours) on its
TSLAUSDT. A median print size means something very different in each, so
`window_s` and `rate_per_s` ride on every row.

These prints are ANONYMOUS on every venue here. Per-wallet attribution
exists on the Hyperliquid family and Lighter but not from this endpoint,
and on Aster it does not exist publicly at all.
"""

import time

from datasources import cross_venue, hl
from datasources.venues import PACE_S
from datasources.xvenue import (ASTER_TAPE_LIMIT, EXTENDED_TAPE_LIMIT,
                                MAX_BOOKS, _lighter_get)

MIN_TAIL_OBS = 5
_TAIL_QUANTILES = (0.999, 0.99, 0.95, 0.90, 0.75)


def _tape_stats(prints):
    """Distribution of one market's own trailing prints, with its own limits.

    Returns None when there is nothing to describe. Never invents a
    quantile the sample cannot carry.
    """
    usd = sorted(p["usd"] for p in prints if p.get("usd") and p["usd"] > 0)
    n = len(usd)
    if not n:
        return None
    ts = [p["ts"] for p in prints if p.get("ts")]
    span = (max(ts) - min(ts)) / 1000.0 if len(ts) > 1 else None
    out = {"n": n, "window_s": round(span, 1) if span else None,
           "rate_per_s": round(n / span, 2) if span and span > 0 else None,
           "median_usd": usd[n // 2], "max_usd": usd[-1],
           "total_usd": sum(usd)}
    # Support is decided by COUNTING the observations that would sit at or
    # above the quantile's own index — the same integer the note reports —
    # rather than by n*(1-q) >= MIN_TAIL_OBS. That float form silently
    # downgrades exact cases: at n=50 and q=0.90, 1-0.90 evaluates to
    # 0.09999999999999998 and the product to 4.999999999999999, so a sample
    # with exactly 5 observations in its tail was rejected and the row
    # reported p75 instead of the p90 it could support.
    q = idx = None
    for cand in _TAIL_QUANTILES:
        i = min(n - 1, int(cand * n))
        if n - i >= MIN_TAIL_OBS:
            q, idx = cand, i
            break
    if q is None:
        out["tail_q"] = None
        out["tail_note"] = (
            "%d prints is too few for any tail quantile — at least %d "
            "observations must sit above one for it to be a measurement "
            "rather than an artefact of the last %d trades. Median and max "
            "are raw order statistics and stand on their own."
            % (n, MIN_TAIL_OBS, n))
    else:
        out["tail_q"] = q
        out["tail_usd"] = usd[idx]
        out["tail_note"] = ("p%s of this market's own last %d prints (%d "
                            "observations above it)"
                            % (("%g" % (q * 100)), n, n - idx))
    return out


def _tape_hl(sym):
    """HL/HIP-3 tape. Exactly 10 prints per call, and that is the whole
    endpoint — there is no limit parameter to raise. HIP-3 coins arrive
    ALREADY prefixed (`xyz:SNDK`); re-prefixing them returns HTTP 500."""
    d = hl._post({"type": "recentTrades", "coin": sym}) or []
    out = []
    for t in d:
        try:
            out.append({"usd": float(t["px"]) * float(t["sz"]),
                        "ts": int(t["time"])})
        except (KeyError, TypeError, ValueError):
            continue
    return out, "{'type':'recentTrades'} — fixed 10 prints, no limit parameter"


def _tape_lighter(base):
    """Lighter tape. limit>100 is HTTP 400. Needs the market_id, which comes
    from the orderBookDetails payload the compare already caches."""
    mid = None
    for m in (_lighter_get("/orderBookDetails").get("order_book_details")
              or []):
        if m.get("symbol") == base:
            mid = m.get("market_id")
            break
    if mid is None:
        return [], "%s not present in Lighter orderBookDetails" % base
    d = _lighter_get("/recentTrades?market_id=%d&limit=100" % int(mid), ttl=20)
    out = []
    for t in d.get("trades") or []:
        try:
            out.append({"usd": float(t["usd_amount"]),
                        "ts": int(t["timestamp"])})
        except (KeyError, TypeError, ValueError):
            continue
    return out, "/api/v1/recentTrades — capped at 100 prints (limit>100 -> 400)"


def prints(coin, snap):
    """How big are the prints in this instrument, on each venue that lists it.

    Deliberately a SEPARATE call from compare(): it spends one tape request
    per venue, and bolting that onto the depth compare would nearly double a
    fan-out that is already 8 calls at the cap. Read the module comment above
    before building anything on this — the honest use is describing where
    size is trading right now, not predicting what happens next.
    """
    now = time.time()
    out = {"at": now, "coin": coin,
           "snap_age_s": round(now - (snap.get("at") or now), 1)}
    cls = cross_venue.classify(snap.get("listings"), coin)
    out["state"] = cls.get("state")
    if cls.get("state") == "UNKNOWN" or not cls.get("home"):
        out["rows"] = []
        out["failed"] = []
        out["note"] = cls.get("note")
        return out
    base = cls.get("base")
    vmeta = {v.get("venue"): v for v in snap.get("venues") or []}
    listings = [dict(cls["home"], home=True)]
    listings += [dict(o) for o in cls.get("others") or []]
    rows, failed = [], []
    for src in listings[:MAX_BOOKS]:
        meta = vmeta.get(src.get("venue")) or {}
        chain = meta.get("chain")
        native = src.get("sym_native") or src.get("sym")
        row = {"venue": src.get("venue"), "sym": src.get("sym"),
               "home": bool(src.get("home")), "chain": chain,
               "off_hours": bool(src.get("off_hours"))}
        tape, src_note, err = [], None, None
        try:
            if chain == "hyperliquid":
                tape, src_note = _tape_hl(src.get("sym"))
            elif chain == "zklighter":
                tape, src_note = _tape_lighter(base)
            elif chain == "bnb":
                from datasources import aster
                # aster.usym, not raw interpolation: the three CJK-named
                # TRADING markets raise a codec error on concatenation, and
                # this path reported it as failed:[{what:"tape"}] rather than
                # serving their prints. Measured 2026-08-15.
                for t in aster._get("/fapi/v1/aggTrades?symbol=%s&limit=%d"
                                    % (aster.usym(native), ASTER_TAPE_LIMIT),
                                    retries=0) or []:
                    try:
                        tape.append({"usd": float(t["p"]) * float(t["q"]),
                                     "ts": int(t["T"])})
                    except (KeyError, TypeError, ValueError):
                        continue
                src_note = ("/fapi/v1/aggTrades limit=%d — the endpoint's cap "
                            "(1500 -> 400). Aggregation merges 1.02 fills per "
                            "print on average, measured against raw "
                            "/fapi/v1/trades, so these are prints not sweeps"
                            % ASTER_TAPE_LIMIT)
            elif chain == "starknet":
                from datasources import extended
                d = (extended._get("/info/markets/%s/trades?limit=%d"
                                   % (native, EXTENDED_TAPE_LIMIT))
                     or {}).get("data") or []
                for t in d:
                    try:
                        tape.append({"usd": float(t["p"]) * float(t["q"]),
                                     "ts": int(t["T"]), "kind": t.get("tT")})
                    except (KeyError, TypeError, ValueError):
                        continue
                src_note = ("/info/markets/%s/trades — HARD cap of 50 prints; "
                            "the limit parameter is accepted and ignored above "
                            "it (tested 50/100/500/1000)" % native)
            else:
                err = ("no keyless tape fetcher for venue kind %r"
                       % (meta.get("kind") or "unknown"))
        except Exception as exc:
            err = str(exc)[:140]
        if err:
            row["err"] = err
            failed.append({"venue": row["venue"], "what": "tape",
                           "error": err,
                           "impact": "%s contributes no print distribution to "
                                     "this comparison — its prints are "
                                     "UNMEASURED, not small" % row["venue"]})
        else:
            row["src"] = src_note
            row["stats"] = _tape_stats(tape)
            if row["stats"] is None:
                row["note"] = ("the venue served this market's tape and it "
                               "was EMPTY — no prints in the served window"
                               + (", which is this market's scheduled state: "
                                  "it is off hours" if row["off_hours"]
                                  else ""))
        rows.append(row)
        time.sleep(PACE_S)
    out["rows"] = rows
    out["failed"] = failed
    qs = {r["stats"]["tail_q"] for r in rows
          if r.get("stats") and r["stats"].get("tail_q")}
    n_tails = sum(1 for r in rows
                  if r.get("stats") and r["stats"].get("tail_q"))
    # None, not True, when fewer than two rows carry a tail at all: with
    # nothing to compare, "comparable" is vacuously true and would read as a
    # green light. Three states, because there are three situations.
    out["tail_comparable"] = (len(qs) == 1) if n_tails >= 2 else None
    out["caveats"] = [
        "THIS IS NOT A SIGNAL. Measured on this terminal's own stored flow: "
        "the forward-15m range after a p95 print is 1.63x baseline on BTC "
        "raw, and 1.01x after controlling for hour-of-day. Large prints "
        "cluster in the same UTC 13-17 block already known to be the "
        "hottest hours — the alert would be a clock.",
        "\"large\" is defined per MARKET, never per venue and never as a flat "
        "notional: p99 varies 15x inside Aster alone, and across 12,460 "
        "prints on five venues not one exceeded $1M.",
        "sample sizes are set by each venue's own cap and differ by 100x "
        "(Aster 1,000 / Lighter 100 / Extended 50 / HL 10), so each row "
        "states the finest quantile ITS sample supports"
        + ("" if out["tail_comparable"] is not False else
           " — and these rows do NOT all support the same one, so their tail "
           "figures are not comparable with each other")
        + (" — fewer than two rows here support a tail quantile at all, so "
           "there is no tail comparison to make"
           if out["tail_comparable"] is None else ""),
        "these are ANONYMOUS prints. Size here is not attributable to an "
        "account on any of these venues from public data.",
    ]
    return out
