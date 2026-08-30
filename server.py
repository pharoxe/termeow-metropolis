#!/usr/bin/env python3
"""Terminal V — Bloomberg-style market terminal on free public data.

Endpoints:
  GET /                     static UI
  GET /api/universe         crypto + equity-perp universes with live contexts
  GET /api/events           forward calendar with expected-move estimates
  GET /api/candles?coin=..&interval=..   candle proxy (avoids browser CORS)
  GET /api/research         intel cards + material news from the pipeline DB
  GET /api/des?coin=        four-line cited DES for the charted name
  GET /api/funding          crowded-funding reads for the crypto watchlist

The browser opens its own WebSocket to Hyperliquid for live mids; this
server only aggregates slower-moving data. Everything degrades gracefully:
a dead upstream yields an empty section plus a `coverage` note, never a 500.
"""

import json
import math
import os
import re
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import events as events_mod
import expected_move
import research
import deepdive
from cache import CACHE
from datasources import hl

# Process start, for /api/health's uptime. A watchdog needs to tell a
# server that has been up for days from one that is crash-looping and
# answering happily between restarts.
_BOOT_AT = time.time()

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

# Default watchlists (crypto-first + tracked equity perps).
CRYPTO_WATCH = ["BTC", "ETH", "SOL", "HYPE", "VVV", "DOGE", "XRP", "AVAX", "LINK"]
EQUITY_WATCH = ["xyz:TSLA", "xyz:NVDA", "xyz:AAPL", "xyz:MSFT", "xyz:AMZN",
                "xyz:META", "xyz:GOOGL", "xyz:AMD", "xyz:ARM", "xyz:COIN",
                "xyz:HOOD", "xyz:PLTR"]

BLIND_SPOTS = [
    "token unlock schedules (no free structured source)",
    "equity lockup dates are IPO+180d estimates (S-1 terms vary)",
    "options flow / dark pools",
    "cash-equity real-time quotes (perp mids shown instead)",
    "FOMC odds are ZQ-futures-implied (FedWatch math, expectation-chained) — prediction markets ISP-blocked",
    # From the 2026-08-15 venue-landscape survey: the honest split between
    # what this host CANNOT reach and what is simply not built yet.
    "perp venues Drift + Vertex/Blitz host-blocked (WAF/DNS, TLS stall) — blocked, not unbuilt; Aster/Extended/ApeX/edgeX coverable but unbuilt (survey 2026-08-15)",
]


def api_universe():
    def fetch():
        main_ctx = hl.asset_ctxs("")
        xyz_ctx = hl.asset_ctxs("xyz")
        return {"crypto": main_ctx, "equity": xyz_ctx}
    data = CACHE.get_or_fetch("universe", 120, fetch)
    # Depth rides along because it is a pure in-memory read of the websocket
    # collector — no upstream call, no cache — and because the WATCH table is
    # where a book that is draining should first be visible. Absent for a coin
    # simply means "not collected", which the pane renders as a blank cell
    # with a reason, never as a balanced book.
    # Assigned as they succeed, not in one all-or-nothing bind: status() is the
    # newer of the two calls and a failure in it must not take the depth
    # metrics down with it. dstat left empty makes depth_slots null — unknown,
    # which is not the same claim as "no slot pressure".
    depth, dstat = {}, {}
    try:
        from datasources import depth_history
        depth = depth_history.metrics()
        dstat = depth_history.status()
    except Exception:
        pass
    # THE COLLECTOR IS FULL AND NOTHING SAID SO. depth_history.status()
    # measures the condition exactly (slots_free 0, slots_pressure true, and a
    # slots_note whose own wording is "has to be visible before it happens,
    # not discovered afterwards") — but the only route carrying it was
    # /api/depth?coin=X, i.e. after the reader has already charted the market
    # whose hour is being lost. Measured 2026-08-16: subscribed 36, max 36,
    # slots_free 0, add-only ratchet, and none of those keys appeared anywhere
    # in the client. It rides on /api/universe because that is the payload
    # every tab already polls, and it is a pure in-memory read.
    slots = {k: dstat.get(k) for k in
             ("subscribed", "pending_subs", "max_coins", "slots_free",
              "slots_pressure", "slots_note")} if dstat else None
    return {
        "crypto_watch": CRYPTO_WATCH,
        "equity_watch": EQUITY_WATCH,
        "crypto": data["crypto"],
        "equity": data["equity"],
        "depth": {c: {"imb": r.get("depth_imb"),
                      "chg_1h": r.get("depth_chg_1h"),
                      "band_bps": r.get("depth_band_bps"),
                      "h": r.get("depth_h"),
                      "stale": r.get("depth_stale")}
                  for c, r in (depth or {}).items()},
        "depth_slots": slots,
    }


def api_events():
    def fetch():
        xyz = list(CACHE.get_or_fetch(
            "universe", 120,
            lambda: {"crypto": hl.asset_ctxs(""), "equity": hl.asset_ctxs("xyz")},
        )["equity"].keys())
        watch_syms = [c.split(":", 1)[1] for c in EQUITY_WATCH]
        return events_mod.build_event_calendar(xyz, watch_syms)
    try:
        evs = CACHE.get_or_fetch("events", 1800, fetch)
        return {"events": evs, "blind_spots": BLIND_SPOTS}
    except Exception as exc:
        # `events: []` here is a FAILED build, not an empty calendar, and the
        # two render identically without an attributed error beside them.
        return dict(_fault_fields("/api/events", exc),
                    events=[], blind_spots=BLIND_SPOTS)


# startTime=0 makes Hyperliquid return its 5000-row cap (~800 KB for 1h) when
# the UI only ever keeps 300 candles. Ask for just over what we render.
_INTERVAL_MS = {"1m": 60000, "5m": 300000, "15m": 900000, "30m": 1800000,
                "1h": 3600000, "4h": 14400000, "1d": 86400000}


def _window_start(interval, bars=400):
    import time
    return max(0, int(time.time() * 1000) - bars * _INTERVAL_MS.get(interval, 3600000))


# --- WHOSE fault was it? ---------------------------------------------------
# The dispatcher used to answer every exception with "this is a SERVER FAULT",
# and measured 2026-08-16 the actual fault behind /api/candles?coin=NOTACOIN
# is an UPSTREAM HTTP 500 from Hyperliquid. Blaming this process for a venue
# error sends whoever reads the line to the wrong logs, and "not a measurement
# of the market" is true in every case while "server fault" is not. urllib
# raises HTTPError when the venue ANSWERED with a status, URLError/timeout
# when it could not be reached at all; anything else really is ours.
def _fault_side(exc):
    import json as _json
    import urllib.error
    if isinstance(exc, urllib.error.HTTPError):
        return "upstream"
    if isinstance(exc, _json.JSONDecodeError):
        return "upstream"          # a body that would not parse is theirs
    # URLError subclasses OSError and socket.timeout IS TimeoutError, but a
    # bare OSError is NOT evidence of an upstream problem — a local file read
    # raises one too, and calling that "the venue could not be reached" is the
    # same misattribution in the other direction.
    if isinstance(exc, (urllib.error.URLError, TimeoutError, ConnectionError)):
        return "unreachable"
    return "server"


_FAULT_TEXT = {
    "upstream": "%s: the UPSTREAM venue API answered with an error (%s) — "
                "this is the venue failing, NOT this server, and not a "
                "measurement of the market",
    "unreachable": "%s: the UPSTREAM venue API could not be reached (%s) — "
                   "a network or venue failure, NOT this server, and not a "
                   "measurement of the market",
    "server": "%s failed inside the server (%s) — this is a SERVER FAULT, "
              "not a measurement of the market",
}


def _fault(route, exc):
    """(sentence, side) — the sentence a pane may paint, and the word to branch on."""
    side = _fault_side(exc)
    return _FAULT_TEXT[side] % (route, type(exc).__name__), side


def _fault_fields(route, exc, key="error"):
    """The standard fault quartet, under `key`, `key`_detail/_kind/_where/_route.

    _fault() and the do_GET catch-all have shipped attributed faults since
    2026-08-16, and roughly fifteen in-route handlers went on shipping a bare
    `str(exc)`. Most of those DO frame themselves as a failure, so the missing
    piece is not honesty — it is ATTRIBUTION: no `error_where` for a pane to
    decide retry-versus-page-a-human with, and raw Python text ("HTTP Error
    429: Too Many Requests", "'NoneType' object has no attribute 'get'")
    standing in as the sentence a human reads. The raw text is kept, under its
    own key, for whoever is debugging.

    `key` exists because this codebase already speaks three dialects for the
    same idea — `error` on route payloads, `err` on the per-section blocks in
    /api/sides, `why` on the whale/you blocks — and renaming those is an
    app.js change. One helper, three key names, one shape underneath.
    """
    msg, side = _fault(route, exc)
    return {key: msg,
            key + "_detail": str(exc)[:200],
            key + "_kind": type(exc).__name__,
            key + "_where": side,
            key + "_route": route}


# --- WHAT A QUERY STRING IS ALLOWED TO REACH -------------------------------
# Two inputs on this server are not merely read: `?coin=` permanently consumes
# an ADD-ONLY websocket subscription slot, and `?addr=` drives a 10-venue REST
# fan-out. Both arrived straight off the query string with no validation at
# all, on GET, from a server that until now checked no Origin — so any page
# the owner happened to visit could burn collector slots with an <img> tag.
# Both collector caps were already measured FULL, and a slot is released only
# by restarting the process.

_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def _valid_addr(addr):
    """A 42-char 0x string of actual hex. The old test was `startswith('0x')`
    and `len == 42`, which "0x" + 40 arbitrary characters passes — and each
    distinct junk string got its own cache key and its own venue fan-out."""
    return bool(_ADDR_RE.match(addr or ""))


def _known_coin(coin):
    """Is `coin` a market some venue in this universe actually lists?

    Checked against the same 120s universe cache every other reader shares, so
    it costs no upstream call. On a total universe failure this returns False
    rather than guessing: admitting an unknown coin is PERMANENT (the slot is
    never released), while refusing a real one lasts until the next poll. The
    asymmetry decides it.
    """
    if not coin:
        return False
    try:
        data = CACHE.get_or_fetch(
            "universe", 120,
            lambda: {"crypto": hl.asset_ctxs(""), "equity": hl.asset_ctxs("xyz")})
    except Exception:
        return False
    return (coin in (data.get("crypto") or {})
            or coin in (data.get("equity") or {}))


def api_candles(query):
    coin = query.get("coin", ["BTC"])[0]
    interval = query.get("interval", ["1h"])[0]
    # The whitelist is the SAME set as _INTERVAL_MS by construction — two
    # hand-written copies of one list is how 30m came to be servable upstream
    # and unreachable here.
    if interval not in _INTERVAL_MS:
        interval = "1h"
    key = "candles:{}:{}".format(coin, interval)
    # 1m is the resolution the flow tape fully covers, so it is the one people
    # will sit on — cache it briefly rather than serving a stale forming bar.
    ttl = 20 if interval == "1m" else 60 if interval in ("5m", "15m", "30m") else 300
    start_ms = _window_start(interval)
    try:
        rows = CACHE.get_or_fetch(
            key, ttl, lambda: hl.candles(coin, interval, start_ms))
    except Exception as exc:
        # Two things go wrong if this is left to the dispatcher. It misnames
        # the fault (see _fault above), and it returns a body with NO `coin`
        # key — which the client's late-response guard reads as "this is for
        # the coin on screen" before coercing d.candles||[] to an empty
        # series. A FAILED fetch then renders identically to a market that
        # genuinely has no history. Keep the success shape so the guard works,
        # and say who broke.
        msg, side = _fault("/api/candles", exc)
        return {"coin": coin, "interval": interval, "candles": [],
                "error": msg, "error_detail": str(exc)[:200],
                "error_kind": type(exc).__name__, "error_where": side,
                "error_route": "/api/candles"}
    slim = [{"t": int(c["t"]), "o": float(c["o"]), "h": float(c["h"]),
             "l": float(c["l"]), "c": float(c["c"]), "v": float(c["v"])}
            for c in (rows or [])[-300:]]
    out = {"coin": coin, "interval": interval, "candles": slim,
           "window_start_ms": start_ms}
    if not slim:
        # A COMPLETED MEASUREMENT OF NOTHING, and it must not be able to wear
        # the clothes of a fetch in flight. Eight markets in this terminal's
        # own universe (AI, AI16Z, ARK, BADGER, BLAST, CANTO, CHILLGUY, FTM —
        # zero-volume delisted names still carried in metaAndAssetCtxs) answer
        # candleSnapshot with []. Verified upstream 2026-08-16: the emptiness
        # is real, not a request that has not landed. Without a key saying so
        # the client cannot distinguish it from pending and draws the word
        # "loading candles…" forever.
        out["empty"] = True
        out["empty_note"] = (
            "the venue served %s's %s candle history and it was EMPTY — 0 "
            "bars over the requested window. This is a completed measurement "
            "of no history, NOT a fetch still in flight and NOT an error."
            % (coin, interval))
    return out


def _true_spread(d, bids, asks):
    """The spread of an AGGREGATED ladder is NOT its top-of-book difference.

    `nSigFigs` is a bucketing parameter: at sig=4 the bucket is exactly 10x
    the real tick and at sig=3 it is 100x, so `asks[0].px - bids[0].px` off an
    aggregated book reports the BUCKET WIDTH and calls it the spread.
    Measured against Hyperliquid's own `spread` field, which it returns at
    every resolution: BTC 1.5953 vs 0.1595 bps, HYPE 1.7805 vs 0.1780,
    xyz:SNDK 6.1786 vs 0.6174 — a clean 10x on every symbol tested.

    The depth store has always read the right field (depth_history._view);
    the two ladder surfaces did not, and the pane printed 1.60 bps for BTC
    while the store beside it held 0.1595. Prefer the exchange figure; fall
    back to the derived one only when the field is absent, and LABEL which
    one it is so a bucket width can never be mistaken for a measurement.
    """
    if not bids or not asks:
        return {"spread_bps": None, "spread_src": "no book"}
    mid = (bids[0]["px"] + asks[0]["px"]) / 2.0
    if mid <= 0:
        return {"spread_bps": None, "spread_src": "no mid"}
    try:
        sp = float(d.get("spread"))
    except (TypeError, ValueError):
        return {"spread_bps": (asks[0]["px"] - bids[0]["px"]) / mid * 1e4,
                "spread_src": "derived from the aggregated ladder — this is "
                              "the nSigFigs BUCKET width, an upper bound on "
                              "the spread, not the spread"}
    return {"spread_bps": sp / mid * 1e4, "spread_src": "exchange"}


def api_book(query):
    """Aggregated depth for the liquidity heatmap. Cached ~1s so a fast client
    poll cannot turn into a fast upstream poll."""
    coin = query.get("coin", ["BTC"])[0]
    # The echo (`sig` in the response) does make the substitution recoverable,
    # but this was the one clamped parameter on the server that did not NAME
    # what it changed — /api/flow, /api/depth and the band selector all do.
    # Measured 2026-08-16: ?sig=99 and ?sig=<CJK> both returned sig:4 silently.
    raw_sig, note = (query.get("sig") or ["4"])[0], None
    try:
        sig = int(raw_sig)
    except (TypeError, ValueError):
        note = "sig=%r is not a number — used 4" % (raw_sig,)
        sig = 4
    if sig not in (3, 4, 5):
        note = ("sig=%s is not one of the aggregation levels [3, 4, 5] — "
                "used 4" % sig)
        sig = 4
    key = "book:{}:{}".format(coin, sig)
    try:
        d = CACHE.get_or_fetch(key, 1, lambda: hl.l2_book(coin, sig))
    except Exception as exc:
        # Same shape as the success path — a differently-shaped error body
        # reads to the client as "empty book" instead of "no data".
        msg, side = _fault("/api/book", exc)
        out = {"coin": coin, "sig": sig, "bids": [], "asks": [],
               "error": msg, "error_detail": str(exc)[:200],
               "error_kind": type(exc).__name__, "error_where": side}
        if note:
            out["request_note"] = note      # present only when it says something
        return out
    # The guard above covered the FETCH and stopped one line short of the
    # dereference. An unknown coin comes back as a non-dict (measured:
    # ?coin=NOTACOIN returned {"error": "'NoneType' object has no attribute
    # 'get'"} under HTTP 200 — a Python traceback fragment presented as a
    # market datum). Not UI-reachable today, but repair 4 paints server error
    # strings verbatim into BOTH SIDES, so that is one code path away.
    if not isinstance(d, dict):
        return {"coin": coin, "sig": sig, "bids": [], "asks": [],
                "error": "no book for %r — the exchange returned no level "
                         "data for this symbol. NOT an empty book." % coin,
                **({"request_note": note} if note else {})}
    bids, asks = (d.get("levels") or [[], []])[:2]
    slim = lambda rows: [{"px": float(r["px"]), "sz": float(r["sz"])}
                         for r in (rows or [])]
    sb, sa = slim(bids), slim(asks)
    out = {"coin": coin, "sig": sig, "bids": sb, "asks": sa}
    out.update(_true_spread(d, sb, sa))
    if note:
        out["request_note"] = note
    return out


_BUYBACK_WARMING = threading.Event()


def _warm_buyback():
    # Self-guarding: both the 15-minute loop and an on-demand request can call
    # this, and the report is the most expensive thing the server builds.
    # Previously only the request path set the flag, so a request arriving
    # mid-loop started a second full rebuild.
    if _BUYBACK_WARMING.is_set():
        return
    _BUYBACK_WARMING.set()
    from datasources import buyback
    try:
        rep = buyback.report()
        CACHE.set("buyback", rep, 20 * 60)
        # A buyback slowing is the one forward-looking signal here — it says
        # protocol revenue fell before the price necessarily reflects it.
        try:
            from datasources import buyback_alerts
            buyback_alerts.check(rep.get("programs") or [], _send_telegram)
        except Exception:
            pass
    except Exception as exc:
        # Cached so the next request does not immediately re-run the most
        # expensive build in the server — but a cached FAILURE is not a
        # cached result, and _buyback_loop must not stamp it fresh. It reads
        # this `error` key back; see the stamp there.
        CACHE.set("buyback", dict(_fault_fields("/api/buyback", exc),
                                  programs=[]), 600)
    finally:
        _BUYBACK_WARMING.clear()


BUYBACK_REFRESH_S = 15 * 60
# `at` is the last SUCCESSFUL rebuild; `failed_at` is the last attempt that
# was not one. Two clocks, because a chip that shows only the second reads as
# freshness and a chip that shows only the first cannot report an outage.
_BUYBACK_FRESH = {"at": 0.0, "err": None, "err_where": None,
                  "failed_at": None, "runs": 0}


def _buyback_loop():
    """Keep the burn data fresh on a schedule, not on demand.

    The warm only ran when someone opened the BURN tab, and the alert check
    lives inside it — so with nobody looking, supply never re-read and a
    buyback could decelerate for days without firing anything. The heavy work
    (archive walks, fill pages) sits behind its own longer caches, so a
    re-run every 15 minutes is cheap.
    """
    while True:
        try:
            _warm_buyback()
            # THE STAMP MUST INSPECT WHAT WAS ACTUALLY CACHED. _warm_buyback
            # catches its own exception, caches {programs: [], error: ...} and
            # RETURNS NORMALLY — so this loop used to stamp at=now, err=None
            # over a total build failure, and the BURN pane rendered zero
            # programmes under a "checked just now" chip with a clean tooltip.
            # That inverts the chip's only reason to exist. buyback_alerts.check
            # lives inside the same warm and silently stops running too, which
            # is the same outage seen from the ALERTS tab.
            cached = CACHE.get("buyback") or {}
            err = cached.get("error")
            if err:
                _BUYBACK_FRESH["err"] = err
                _BUYBACK_FRESH["err_where"] = cached.get("error_where")
                # `at` is deliberately NOT advanced: the freshness chip's
                # number must keep counting up from the last time this data
                # was actually rebuilt, not from the last time we tried.
                _BUYBACK_FRESH["failed_at"] = time.time()
            else:
                _BUYBACK_FRESH["at"] = time.time()
                _BUYBACK_FRESH["err"] = None
                _BUYBACK_FRESH["err_where"] = None
                _BUYBACK_FRESH["failed_at"] = None
                try:
                    from datasources import buyback_history as bhist
                    bhist.note_writer(_BUYBACK_FRESH)
                except Exception:
                    pass
        except Exception as exc:
            msg, side = _fault("/api/buyback", exc)
            _BUYBACK_FRESH["err"] = msg
            _BUYBACK_FRESH["err_where"] = side
            _BUYBACK_FRESH["failed_at"] = time.time()
        _BUYBACK_FRESH["runs"] += 1
        time.sleep(BUYBACK_REFRESH_S)


def _overlay_history(payload):
    """Attach the latest built history to a cached report.

    History is built in background threads that finish minutes after the
    20-minute report snapshot is taken, so baking it into that snapshot meant a
    freshly built series stayed invisible for up to 20 minutes — the dossier
    showed no chart, then one appeared for no reason the user could see. The
    store is a small disk read, so read it per request instead.
    """
    wst = {}
    try:
        from datasources import buyback_history as bhist
        for row in payload.get("programs") or []:
            hs = bhist.get(row.get("token"))
            if hs:
                row["history"] = hs[-180:]
                row["history_stats"] = bhist.stats(hs)
                row["history_meta"] = bhist.meta(row.get("token"))
                ev = bhist.last_event(hs)
                if ev:
                    row["last_event"] = ev
        wst = bhist.writer_status() or {}
    except Exception:
        wst = {}
    # Same reasoning as history: the payout store is built by a background
    # thread that finishes after the 20-minute report snapshot was taken, so
    # baking it in leaves it invisible for a whole cache cycle.
    try:
        from datasources import fee_payout
        for row in payload.get("programs") or []:
            pr = fee_payout.get(row.get("token"))
            if pr:
                row["payout"] = pr[-14:]
                row["payout_summary"] = fee_payout.summary(pr)
            rev = fee_payout.expected(row.get("token"))
            if rev:
                row["revenue"] = rev
    except Exception:
        pass
    payload = dict(payload)
    store_at = None
    try:
        from datasources import buyback_history as bhist
        store_at = bhist.store_mtime()
    except Exception:
        pass
    payload["fresh"] = {"at": _BUYBACK_FRESH["at"],
                        "age_s": round(time.time() - _BUYBACK_FRESH["at"], 1)
                        if _BUYBACK_FRESH["at"] else None,
                        "every_s": BUYBACK_REFRESH_S,
                        "runs": _BUYBACK_FRESH["runs"],
                        "err": _BUYBACK_FRESH["err"],
                        # Which side broke, and when the last FAILED attempt
                        # was — so "checked 2m ago" can never be drawn over a
                        # rebuild that has been failing for an hour.
                        "err_where": _BUYBACK_FRESH["err_where"],
                        "failed_at": _BUYBACK_FRESH["failed_at"],
                        "failing_for_s": (
                            round(time.time() - _BUYBACK_FRESH["at"], 1)
                            if _BUYBACK_FRESH["failed_at"] and _BUYBACK_FRESH["at"]
                            else None),
                        "store_at": store_at,
                        "store_age_s": (
                            round(time.time() - store_at, 1)
                            if store_at else None),
                        "series_last_ts": wst.get("series_last_ts"),
                        "build_fails": wst.get("build_fails") or [],
                        "writer": wst.get("writer") or {}}
    return payload


def api_buyback():
    """Token buyback/burn programmes + measured supply change."""
    cached = CACHE.get("buyback")
    if cached is not None:
        return _overlay_history(cached)
    if not _BUYBACK_WARMING.is_set():
        threading.Thread(target=_warm_buyback, daemon=True).start()
    return {"status": "warming", "programs": []}


def api_buyflow():
    """Live Assistance Fund buy tape — deliberately its own short-TTL route.

    Kept off /api/buyback because that payload is on a 15-minute cadence by
    design; this one is only useful if it is seconds old.
    """
    from datasources import buyback_history, buyflow
    base = None
    try:
        st = buyback_history.stats(buyback_history.get("HYPE"))
        base = st.get("d30") or st.get("d7")
    except Exception:
        pass
    return buyflow.cached(base)


def api_research(q=None):
    """Intel cards + material news. Default is CN for ?coin=; ?all=1 is TOP.

    `news` is a LIMIT-25 page by default. `limit=` raises it (capped) so the
    chart can cover a visible window of flags without changing the pane's
    default page. Optional `since=` (ISO or unix) filters published_at.
    CN scopes to the charted name's stored base_symbol (plus GOOG/GOOGL aliases).
    """
    q = q or {}
    all_flag = str((q.get("all") or [None])[0] or "").lower() in ("1", "true", "yes")
    coin = None if all_flag else (q.get("coin") or [None])[0]
    symbols = None if all_flag else research.news_symbols_for(coin)
    raw_limit = (q.get("limit") or [None])[0]
    limit = research.NEWS_LIMIT if raw_limit in (None, "") else raw_limit
    since = (q.get("since") or [None])[0]
    news = research.material_news(limit=limit, symbols=symbols, since=since)
    counts = research.material_counts(symbols=symbols)
    total = counts.get("total")
    meta = dict(counts)
    meta["shown"] = len(news)
    meta["limit"] = research._clamp_limit(limit)
    meta["mode"] = "all" if (all_flag or not symbols) else "cn"
    meta["coin"] = None if meta["mode"] == "all" else coin
    meta["base"] = None if not symbols else symbols[0]
    if meta["mode"] == "cn":
        base = meta["base"] or "?"
        if total:
            meta["note"] = (
                "newest %d of %d material stories for %s — this name, not TOP"
                % (len(news), total, base))
        elif total == 0:
            meta["note"] = (
                "no material headlines for %s in the pipeline DB — this name, "
                "not a quiet tape" % base)
        else:
            meta["note"] = (
                "no total is readable from this host, so the %d shown for %s "
                "cannot be compared against one" % (len(news), base))
    else:
        meta["note"] = (
            "newest %d of %d material stories held — this is a PAGE, not a total"
            % (len(news), total) if total is not None else
            "no total is readable from this host, so the %d shown cannot be "
            "compared against one — unknown, not all there is" % len(news))
    return {
        "cards": research.latest_cards(),
        "news": news,
        "news_meta": meta,
        "pipeline": research.pipeline_status(),
    }


def _win_args(q, collector_bucket_s, dflt_hours=24.0, dflt_bucket=300):
    """Parse and CLAMP ?hours= and ?bucket=, and report what was actually used.

    Both endpoints used to do `int(q["bucket"][0])` and then echo that integer
    back in the response as `bucket_s` — the field the client plots and labels
    against. Measured: ?bucket=0 and ?bucket=-5 both returned a real 60-second
    series (series() floors the group at 1 bucket) while the response asserted
    the series was bucketed at 0s and -5s respectively. A malformed request was
    answered with a confident wrong fact about real data, which is the exact
    inversion this file exists to prevent. A bad value also used to raise
    ValueError, which the dispatcher turned into a bare Python error string.

    So: clamp to what the store can actually serve, and when the clamp bites,
    say so in the response rather than letting the echo pass as a measurement.
    """
    notes = []

    def _num(name, dflt, cast, lo, hi):
        raw = (q.get(name) or [None])[0]
        if raw is None:
            return dflt
        try:
            v = cast(raw)
        except (TypeError, ValueError):
            notes.append("%s=%r is not a number — used %s" % (name, raw, dflt))
            return dflt
        if v < lo or v > hi:
            c = min(max(v, lo), hi)
            notes.append("%s=%s is outside [%s, %s] — used %s"
                         % (name, v, lo, hi, c))
            return c
        return v

    hours = _num("hours", dflt_hours, float, 0.01, 24 * 90.0)
    bucket = _num("bucket", dflt_bucket, int, collector_bucket_s, 86400)
    # The store's own resolution is the floor: asking for finer buckets than
    # were collected cannot produce them, and series() silently rounds up.
    if bucket % collector_bucket_s:
        snapped = max(collector_bucket_s,
                      (bucket // collector_bucket_s) * collector_bucket_s)
        notes.append("bucket=%ds is not a multiple of the %ds collection "
                     "interval — served at %ds" % (bucket, collector_bucket_s,
                                                   snapped))
        bucket = snapped
    return hours, bucket, notes


def api_flow(q):
    """Server-collected order flow: real CVD/delta history, not session-only."""
    from datasources import flow_collector
    coin = (q.get("coin") or [""])[0]
    hours, bucket, notes = _win_args(q, flow_collector.BUCKET_S)
    # OPT-IN, DEFAULT OFF, and that is the point: the two other series()
    # callers on this file and any client with the footprint indicator off
    # must pay exactly zero bytes for the per-price ladder. No new route --
    # a second one would need its own copy of the _win_args clamp, the
    # subscribed/why wording and the status block, and this file already
    # records what duplicating those cost last time.
    want_levels = (q.get("levels") or ["0"])[0] in ("1", "true", "yes")
    if not coin:
        return {"status": flow_collector.status()}
    # Charting a coin is the signal that its tape matters. Subscribing here
    # means the pane fills from now on rather than staying permanently blank.
    # VALIDATED FIRST — see _known_coin. A slot spent on a string no venue
    # lists is spent until this process restarts.
    known = _known_coin(coin)
    if known:
        flow_collector.ensure(coin)
    sub, pend = flow_collector.subscribed()
    st = flow_collector.status()
    out = {"coin": coin, "bucket_s": bucket, "hours": hours,
           "series": flow_collector.series(coin, hours=hours, bucket_s=bucket),
           "status": st}
    # ensure() returns False both for "already covered" and for "refused, the
    # slot set is full", so its return value cannot carry this. Ask the set.
    #
    # AN EMPTY SERIES HAS TWO OPPOSITE MEANINGS and this route shipped only
    # one of them. Measured 2026-08-16: the collector sat at 60/60 subscribed
    # with _rerank_collectors() add-only, so xyz:AAPL / MSFT / AMZN / META /
    # AMD — five of the owner's own 21 watchlist symbols — could never be
    # added before a restart, while /api/flow answered series:[] state:"live"
    # and the chart's CVD pane rendered "collecting tape…": a progress message
    # for a process that is not running. /api/sides already told the truth for
    # the same symbol at the same instant; the wording now lives in one place
    # and both routes carry it.
    out["subscribed"] = coin in sub or coin in pend
    # Reaches PAST the requested window, so "quiet for 3h" can never be
    # reported as "nothing has ever printed". None means genuinely never heard.
    # Same field _sides_flow dates its silence with.
    out["last_bucket_ms"] = flow_collector.newest_bucket_ms(coin)
    out["known_market"] = known
    if not out["subscribed"] and not known:
        # A DIFFERENT FACT from a full collector, and it must not borrow that
        # sentence: the slot-pressure wording would tell the reader to wait
        # for a restart when what is actually wrong is the symbol.
        out["why"] = ("%r is not a market in the current venue universe, so "
                      "it was NOT subscribed and nothing will ever be "
                      "collected for it. An empty series here means an "
                      "unrecognised symbol — not a quiet tape, and not a "
                      "collector that is full." % coin)
    elif not out["subscribed"]:
        base = ("%s is not in the trade-tape collector (%s of %s subscription "
                "slots in use, and the set is ADD-ONLY until this process "
                "restarts) — NO NEW TAPE WILL ARRIVE for it"
                % (coin, st.get("subscribed"), st.get("max_subs")))
        # MEASURED 2026-08-16, and it caught the first draft of this sentence:
        # xyz:PLTR was dropped at the seed cap on a restart yet answered with
        # 175 real buckets recorded while it WAS subscribed. "Nothing is being
        # collected" next to 175 live-looking rows is its own false statement,
        # so the two cases get two sentences.
        if out["last_bucket_ms"]:
            out["why"] = (base + ". Rows below WERE recorded, while it was "
                          "subscribed on an earlier run, and stop at the "
                          "newest bucket — this series is history that has "
                          "ENDED, not a live tape.")
        else:
            out["why"] = (base + ", and nothing has EVER been recorded for "
                          "it. An empty series here means NOT COLLECTED, not "
                          "a market that has not traded.")
    elif coin in pend and coin not in sub:
        out["why"] = ("%s was just subscribed and the socket has not acked it "
                      "yet — an empty series is a pending subscription, not a "
                      "measurement" % coin)
    # --- FOOTPRINT LEVELS --------------------------------------------------
    # A per-price ladder, from the collector's third tier. It answers a
    # DIFFERENT question from `series` above and therefore carries its own
    # coverage, its own reach and its own why: `series` says how much was
    # bought and sold in a bar, `levels` says at which prices. A bar can
    # legitimately have a complete delta from the 400d hourly tier and no
    # ladder at all -- that is every bar older than the level tier's 48h --
    # and the two must never be collapsed into one flag.
    if want_levels:
        # Same window the series was cut to, so the two halves of one canvas
        # cannot come from different spans.
        ms_from = (time.time() - hours * 3600.0) * 1000.0
        lvl_from, lvl_to = flow_collector.levels_span(coin)
        out["levels"] = flow_collector.levels(
            coin, ms_from, None, bucket_s=bucket,
            top_n=flow_collector.LEVELS_TOP_N)
        # Per bar the response carries lc (minutes of that bar with stored
        # levels) and lm (minutes the bar spans), plus rn/rb/rs for whatever
        # the top-N cut left out. A bar ABSENT from this list has no stored
        # ladder -- which is not the same claim as a bar that traded nothing.
        out["levels_top_n"] = flow_collector.LEVELS_TOP_N
        out["lvl_from_ms"] = lvl_from
        out["lvl_to_ms"] = lvl_to
        # Echo the CLAMPED bucket, the same discipline bucket_s follows above.
        # The client refuses the whole series when bucket_s does not match its
        # chart; the ladder must be refused on the SAME condition, never
        # separately, or delta and levels could be drawn at different widths.
        out["levels_bucket_s"] = bucket
        out["levels_resolution_s"] = flow_collector.BUCKET_S
        out["levels_retain_h"] = flow_collector.RETAIN_H
        meta = flow_collector.levels_meta()
        out["levels_since_ms"] = meta.get("since_ms")
        out["levels_began_ms"] = meta.get("began_ms")
        # AN EMPTY LADDER MUST NEVER READ AS A MEASURED-EMPTY BAR, and the
        # three ways it can be empty are three different facts. This does NOT
        # borrow the `why` field above: a missing LEVEL tier and an
        # unsubscribed COIN are different problems with different remedies.
        if lvl_from is None and not meta.get("minutes"):
            out["levels_why"] = (
                "the per-price level tier holds nothing at all yet. It began "
                "collecting on this process at levels_began_ms and keeps %dh "
                "at %ds resolution; an empty ladder here means NOT MEASURED, "
                "not a bar without trades. The buy/sell series above is "
                "unaffected and reaches back further."
                % (flow_collector.RETAIN_H, flow_collector.BUCKET_S))
        elif lvl_from is None:
            out["levels_why"] = (
                "no per-price levels are stored for %s, though the tier "
                "holds %d minute buckets across %d other market%s. Levels are "
                "recorded only while a coin is subscribed and are kept %dh; an "
                "empty ladder here means NOT MEASURED for this market, not a "
                "market that did not trade. The buy/sell series above is "
                "unaffected."
                % (coin, meta.get("minutes") or 0, meta.get("coins") or 0,
                   "" if (meta.get("coins") or 0) == 1 else "s",
                   flow_collector.RETAIN_H))
        elif not out["levels"]:
            out["levels_why"] = (
                "%s has stored levels from lvl_from_ms to lvl_to_ms, but none "
                "inside the requested %.4gh window. Bars outside that span "
                "keep their delta from the buy/sell tiers and have NO ladder "
                "-- that is a gap in this tier's %dh reach, not a measurement."
                % (coin, hours, flow_collector.RETAIN_H))
        elif meta.get("write_errors"):
            # A tier that cannot persist is still serving live memory. Say so
            # rather than letting a silently non-durable ladder look normal.
            out["levels_why"] = (
                "levels are being served from memory but the level store has "
                "failed to write %d time(s) (last: %s). Anything older than "
                "this process's memory may be missing after a restart."
                % (meta.get("write_errors"), meta.get("last_write_error")))
    # bucket_s above is what was SERVED. When it is not what was asked for,
    # the response has to carry the difference or the echo is a quiet lie.
    if notes:
        out["request_note"] = "; ".join(notes)
    return out


def api_depth(q):
    """Server-collected L2 depth: what was RESTING, next to what got taken.

    The mirror of /api/flow, and deliberately the same shape so the client can
    request depth at the chart's own bucket size exactly as loadFlowHist() does
    for CVD. Coverage travels with every response because depth cannot be
    backfilled — Hyperliquid publishes no book archive — so a short series is
    the honest answer "we have only collected Nh", never "the book is empty".
    """
    from datasources import depth_history
    coin = (q.get("coin") or [""])[0]
    hours, bucket, notes = _win_args(q, depth_history.BUCKET_S)
    if not coin:
        return {"status": depth_history.status(),
                "coverage": depth_history.coverage()}
    # Same reasoning as the flow pane: charting a coin is the signal its book
    # matters, and an hour not recorded is gone permanently, so subscribe now.
    # Validated first — depth slots are the scarcer of the two (two l2Book
    # subscriptions per coin) and were measured at 36/36 with zero free.
    known = _known_coin(coin)
    if known:
        depth_history.ensure(coin)
    else:
        notes.append("%r is not a market in the current venue universe — no "
                     "book subscription was opened for it, so an empty series "
                     "here means an unrecognised symbol, not an empty book"
                     % coin)
    # The band must be one the collector actually grids on — depth_history
    # keys its store by these exact widths, so an unlisted band silently
    # returned None deltas next to a real series (not-measured wearing the
    # clothes of measured-zero).
    band, braw = depth_history.REF_BPS, (q.get("band") or [None])[0]
    if braw is not None:
        try:
            b = int(braw)
        except (TypeError, ValueError):
            notes.append("band=%r is not a number — used %d" % (braw, band))
        else:
            if b in depth_history.GRID:
                band = b
            else:
                near = min(depth_history.GRID, key=lambda g: abs(g - b))
                notes.append("band=%d is not one of the collected bands %s — "
                             "used %d" % (b, list(depth_history.GRID), near))
                band = near
    out = {"coin": coin, "bucket_s": bucket, "hours": hours,
           "bands_bps": depth_history.GRID, "ref_bps": depth_history.REF_BPS,
           "series": depth_history.series(coin, hours=hours, bucket_s=bucket),
           "delta_pct": {
               "1h": depth_history.delta(coin, 1, band_bps=band),
               "6h": depth_history.delta(coin, 6, band_bps=band),
               "24h": depth_history.delta(coin, 24, band_bps=band)},
           "delta_band_bps": band,
           # `series` is re-bucketed to whatever the caller asked for;
           # `delta_pct` is always computed on the underlying MINUTE rows.
           # Plotting one beside the other without knowing that reads as a
           # mismatch between the chart and the number next to it.
           "delta_bucket_s": depth_history.BUCKET_S,
           "granularity_note": (
               "series is bucketed at %ds; delta_pct is computed on the %ds "
               "minute rows regardless, so the two are different "
               "granularities of the same store"
               % (bucket, depth_history.BUCKET_S)),
           "coverage": depth_history.coverage(coin),
           "known_market": known,
           "status": depth_history.status()}
    if notes:
        out["request_note"] = "; ".join(notes)
    return out


def api_alerts():
    """What is being watched, and what has fired.

    Alerts used to exist only as outbound Telegram messages — nothing in the
    terminal could answer "what is armed?" or "what did I miss?". This is
    that answer: live monitor state plus the fired log.
    """
    from datasources import alert_log, buyback_alerts
    # THIS PAYLOAD HAD NO KEY A FAILURE COULD TRAVEL IN. It shipped exactly
    # {monitors, fired, server_time}, and both builds below swallowed their
    # exception to []. The pane reads that as "warming…" and "nothing has
    # fired yet" — measured 2026-08-17 by injecting a 200-shaped error — over
    # a channel the UI labels "server-side · runs with the browser closed".
    # Nothing anywhere said the monitors had stopped. So the two failures now
    # have their own keys and go through _fault like every other route.
    out = {"monitors": [], "fired": [], "server_time": time.time()}
    programs = []
    try:
        cached = CACHE.get("buyback")
        # NEVER BUILT is not BUILT-AND-EMPTY. For roughly the first 15 minutes
        # after every restart this key is absent, and the pane's empty branch
        # renders "warming…" — the truth then, and a permanent lie afterwards
        # if the build genuinely yields zero programmes. Neither state could be
        # told from the other: both arrived as n_programs 0 with no error and
        # no flag. Say which one it is, so "warming…" can expire.
        if cached is None:
            out["programs_warming"] = True
            out["programs_warming_note"] = (
                "the buyback snapshot has not been built yet (cold cache after "
                "a restart) — this is NOT zero programmes, it is no measurement")
        # Overlay first: history/history_stats/cadence are attached per
        # request, not baked into the cached snapshot, and every monitor
        # verdict is computed from exactly those fields. Reading the raw
        # cache made every programme report "no data".
        if cached is not None:
            programs = (_overlay_history(cached) or {}).get("programs") or []
            # A cached BUILD FAILURE is not a cached set of zero programmes —
            # see _warm_buyback. Carry it, or "no programmes are armed" is
            # what a total buyback outage looks like on this pane.
            if cached.get("error"):
                out["programs_error"] = cached["error"]
                out["programs_error_where"] = cached.get("error_where")
    except Exception as exc:
        out.update(_fault_fields("/api/alerts:programs", exc,
                                 key="programs_error"))
    out["n_programs"] = len(programs)
    try:
        out["monitors"] = buyback_alerts.monitors(programs)
    except Exception as exc:
        out.update(_fault_fields("/api/alerts:monitors", exc,
                                 key="monitors_error"))
    try:
        out["fired"] = alert_log.recent(40)
    except Exception as exc:
        out.update(_fault_fields("/api/alerts:fired", exc, key="fired_error"))
    return out


# Address is supplied per-request by the browser and cached only in memory:
# the terminal never persists a wallet address to disk server-side.
PORT_TTL = 20


def api_portfolio(q):
    """Read-only position + risk state for a wallet. Never places orders."""
    from datasources import portfolio
    addr = (q.get("addr") or [""])[0].strip()
    if not addr:
        return {"status": "no-address"}
    if not _valid_addr(addr):
        return {"status": "bad-address",
                "error": "expected a 0x address of exactly 40 hex digits"}
    dexs, how = _port_dexs(addr)
    def build():
        data = CACHE.get_or_fetch(
            "universe", 120,
            lambda: {"crypto": hl.asset_ctxs(""), "equity": hl.asset_ctxs("xyz")})
        ctxs = dict(data.get("crypto") or {})
        ctxs.update(data.get("equity") or {})
        # PER VENUE, never summed. clearinghouseState is scoped to one dex, so
        # the old single call answered "core positions" while the pane
        # rendered it as "your positions" — it printed "account is flat" to a
        # wallet holding twenty xyz positions worth $23,598.
        return portfolio.build_all(addr, dexs, ctxs=ctxs)
    try:
        out = CACHE.get_or_fetch("portall:" + addr.lower(), PORT_TTL, build)
    except Exception as exc:
        return dict(_fault_fields("/api/portfolio", exc), status="error")
    if how["mode"] == "full":
        _PORT_SCAN[addr] = {
            "at": time.time(),
            "active": [v["dex"] for v in out.get("venues") or []
                       if v.get("dex") and v.get("n_positions")]}
    return {**out, "status": "ok", "scan": how}


# Resting orders move at the pace positions do, and both routes share the
# "portall:" cache entry — so a client polling PORT and STOPS together costs
# what PORT alone costs, plus one frontendOpenOrders per venue.
# 90s, not 20s. The client polls stops on the same cadence, so a TTL equal to
# the poll interval meant every poll was a cache MISS and re-ran the per-dex
# frontendOpenOrders fan-out (up to 10 venues). Measured during a live 429
# outage: a real 1.0-1.2s fetch on every tick with age_s resetting to 0.0.
# The TTL must be >= the poll interval or the cache absorbs nothing, and with
# several tabs open it is the only thing standing between this desk and its own
# rate limit. Resting orders change on human timescales, not tick timescales.
STOPS_TTL = 90


def api_stops(q):
    """Resting orders for a wallet — the answer /api/portfolio cannot give.

    THIS ROUTE EXISTS BECAUSE NOTHING ELSE SERVED IT. /api/portfolio returns
    no order key and no order field on any position row, and the only
    frontendOpenOrders call in this codebase before now lives inside the whale
    sweep, scoped to tracked whale wallets. A client asked to show "is this leg
    protected" could only fake it or stay silent, and a previous agent
    correctly refused to fake it. Measured on the owner's own wallet
    2026-08-16: four correlated longs, and zero resting orders anywhere — a
    fact the terminal held every ingredient for and could not state.

    STRICTLY READ-ONLY. Nothing on this path places, modifies or cancels an
    order, and no key material is involved: frontendOpenOrders is a public
    per-address read.

    THREE STATES, and a client must be able to render them differently:
      state="measured"     -> `orders` is a list. `zero_note` is present if
                              and only if that list is empty, and it is the
                              ONLY key in the payload that means a measured
                              zero.
      state="partial"      -> `orders` is a list and every count in the
                              payload is a LOWER BOUND; `failed` names the
                              venue and the error.
      state="not_measured" -> `orders` is NULL, every count is null, and no
                              zero is stated anywhere.
    Rendering the third as "no stops" is the same inversion that once printed
    "account is flat" over a four-position book — and it is the worse
    direction of it: that bug understated exposure, this one would overstate
    safety.
    """
    from datasources import portfolio, stops
    addr = (q.get("addr") or [""])[0].strip()
    if not addr:
        return {"status": "no-address", "state": "not_measured",
                "orders": None, "n_orders": None,
                "why": "no address was supplied, so no venue was asked. That "
                       "is not a measurement of this wallet's stops."}
    if not _valid_addr(addr):
        return {"status": "bad-address", "state": "not_measured",
                "orders": None, "n_orders": None,
                "error": "expected a 0x address of exactly 40 hex digits",
                "why": "the address was rejected before any venue was asked, "
                       "so this says nothing about any wallet's stops."}
    dexs, how = _port_dexs(addr)

    def build():
        # Positions are an input, not a second fetch: this reuses the exact
        # cache entry the PORT pane fills. When it fails, protection per leg
        # is reported unmeasured rather than as a book with no legs in it.
        pos, perr, pfailed = None, None, []
        try:
            data = CACHE.get_or_fetch(
                "universe", 120,
                lambda: {"crypto": hl.asset_ctxs(""), "equity": hl.asset_ctxs("xyz")})
            ctxs = dict(data.get("crypto") or {})
            ctxs.update(data.get("equity") or {})
            port = CACHE.get_or_fetch(
                "portall:" + addr.lower(), PORT_TTL,
                lambda: portfolio.build_all(addr, dexs, ctxs=ctxs))
        except Exception as exc:
            perr, _side = _fault("/api/stops (position fetch)", exc)
        else:
            pos = port.get("positions") or []
            pfailed = port.get("failed") or []
            if how["mode"] == "full":
                _PORT_SCAN[addr] = {
                    "at": time.time(),
                    "active": [v["dex"] for v in port.get("venues") or []
                               if v.get("dex") and v.get("n_positions")]}
        out = stops.build_all(addr, dexs, positions=pos, positions_error=perr)
        # A venue whose POSITION fetch failed contributes no legs at all, so
        # its positions are missing from `protection` entirely rather than
        # sitting in it marked not_measured. Absence is the one thing a list
        # cannot say about itself — so it is said here.
        if pfailed:
            out["positions_venues_failed"] = pfailed
            out["positions_missing_note"] = (
                "the POSITION query failed on %s, so any leg held there is "
                "absent from `protection` altogether — not listed and not "
                "counted. n_positions=%d is a LOWER BOUND on legs, "
                "independently of the order query."
                % (", ".join(f.get("venue") or "?" for f in pfailed),
                   out.get("n_positions") or 0))
        return out

    key = "stops:" + addr.lower()
    try:
        out = CACHE.get_or_fetch(key, STOPS_TTL, build)
    except Exception as exc:
        msg, side = _fault("/api/stops", exc)
        return {"address": addr, "status": "error", "state": "not_measured",
                "orders": None, "n_orders": None, "error": msg,
                "error_detail": str(exc)[:200], "error_where": side,
                "why": "the route itself failed, so nothing about this "
                       "wallet's resting orders was measured"}
    built = CACHE.built_at(key)
    # `not_queried` matters more here than it does for positions. The partial
    # sweep picks venues by where positions WERE, and a resting order can sit
    # on a venue holding nothing — a limit entry is exactly that. So venues
    # skipped this cycle are a real blind spot in any zero stated above, and
    # they are named. On a FULL sweep there is no such blind spot, and the
    # note is absent rather than asserting one that does not exist.
    skipped = how.get("not_queried")
    blind = None
    if skipped:
        blind = ("this cycle queried %s. The partial sweep picks venues by "
                 "where a POSITION was last seen, so a resting order on a "
                 "venue holding nothing — a limit entry is exactly that — "
                 "would not be seen until the next full sweep. The %d venue(s) "
                 "in venues_not_queried are unmeasured, not empty."
                 % (", ".join(d or "HL core" for d in dexs), len(skipped)))
    elif skipped is None:
        blind = ("the venue snapshot is not warm, so only %s was queried and "
                 "the HIP-3 venue list is unknown — venues_not_queried is null "
                 "because this server cannot yet say which venues it skipped."
                 % ", ".join(d or "HL core" for d in dexs))
    out = {**out,
           # `status` must not say "ok" over a book nothing was measured on.
           # It reports the route's own result everywhere else in this server,
           # and a client keying on it alone would read a total venue outage
           # as a clean answer.
           "status": "ok" if out["state"] != "not_measured" else "not-measured",
           "scan": how,
           "venues_not_queried": skipped,
           "age_s": round(time.time() - built, 1) if built else None,
           "ttl_s": STOPS_TTL}
    if blind:
        out["scan_blind_spot_note"] = blind
    return out


FUNDING_X_TTL = 300


def _funding_x_map():
    from datasources import funding_x
    return CACHE.get_or_fetch("funding_x", FUNDING_X_TTL, funding_x.fetch)


def api_funding_x():
    """HL vs Binance vs Bybit predicted funding, normalised to APR.

    EVERY OTHER CACHED NUMBER IN THIS TERMINAL DATES ITSELF and this one did
    not. `predictedFundings` is a continuously moving rate behind a 300s
    cache, and the client keeps the last payload on a failed poll ("the
    column degrades to n/a" — it does not: disloc_apr is still a number, so
    the cell still renders and the tooltip still quotes three venues to one
    decimal). Measured 2026-08-16: a ~13-minute-old cached BTC hl_apr of
    1.8081516 against a live recompute of 10.7387964, and 29 coins more than
    50% away from a live recompute, purely from TTL drift. `at` is the CACHE
    BUILD time, so a stale-served payload (get_or_fetch serves stale when a
    fetch raises) reports an age past the TTL rather than pretending to be
    fresh.
    """
    import time as _time
    from datasources import funding_x
    try:
        fx = _funding_x_map()
    except Exception as exc:
        msg, side = _fault("/api/funding_x", exc)
        return {"coins": {}, "summary": None, "at": None, "age_s": None,
                "ttl_s": FUNDING_X_TTL, "error": msg,
                "error_detail": str(exc)[:200], "error_where": side}
    at = CACHE.built_at("funding_x")
    return {"coins": fx, "summary": funding_x.summary(fx),
            "at": at,
            "age_s": round(_time.time() - at, 1) if at else None,
            "ttl_s": FUNDING_X_TTL,
            "age_note": "predicted funding moves continuously; this payload "
                        "was built once and cached for up to %ds, so an age "
                        "must travel with every rate quoted from it"
                        % FUNDING_X_TTL}


def api_funding():
    """Crowded-funding chips for the 9-coin crypto watchlist, not the book.

    `crowded: []` means none of CRYPTO_WATCH cleared |funding| > 0.05%/8h.
    It is not an empty store. The full predicted-funding map is /api/funding_x.
    """
    note = (
        "crowded is the %d-coin crypto watchlist at |funding| > 0.05%%/8h, "
        "not the full Hyperliquid book and not an empty store. Empty crowded "
        "means none of those names cleared the gate. Cross-venue predicted "
        "funding is /api/funding_x." % len(CRYPTO_WATCH)
    )
    try:
        reads = expected_move.crypto_funding_reads(CRYPTO_WATCH)
        return {
            "crowded": reads,
            "watchlist": list(CRYPTO_WATCH),
            "watchlist_n": len(CRYPTO_WATCH),
            "crowded_n": len(reads),
            "threshold_8h_pct": 0.05,
            "note": note,
        }
    except Exception as exc:
        return dict(_fault_fields("/api/funding", exc), crowded=[],
                    watchlist=list(CRYPTO_WATCH), watchlist_n=len(CRYPTO_WATCH),
                    crowded_n=0, threshold_8h_pct=0.05, note=note)


MOVERS_MIN_VOLUME = 1e6  # ignore illiquid names when ranking
MOVERS_TOP = 10          # rows per list — a PAGE SIZE, reported as one


def api_movers():
    """Top gainers/losers and funding extremes across the FULL universe."""
    data = CACHE.get_or_fetch(
        "universe", 120,
        lambda: {"crypto": hl.asset_ctxs(""), "equity": hl.asset_ctxs("xyz")})
    rows = []
    for dex, ctxs in (("crypto", data["crypto"]), ("equity", data["equity"])):
        for coin, c in ctxs.items():
            mid, prev = c.get("mid_px"), c.get("prev_day_px")
            vol = c.get("day_volume") or 0
            if not (mid and prev) or vol < MOVERS_MIN_VOLUME:
                continue
            rows.append({
                "coin": coin, "dex": dex, "mid": mid,
                "chg_pct": round((mid - prev) / prev * 100, 2),
                "funding_8h_pct": (round(c["funding"] * 8 * 100, 4)
                                   if c.get("funding") is not None else None),
                "volume": vol,
            })
    by_chg = sorted(rows, key=lambda r: r["chg_pct"])
    by_funding = sorted((r for r in rows if r["funding_8h_pct"] is not None),
                        key=lambda r: abs(r["funding_8h_pct"]), reverse=True)
    n_up = sum(1 for r in rows if r["chg_pct"] > 0)
    n_dn = sum(1 for r in rows if r["chg_pct"] < 0)
    # THE PANE HEADS THIS "FULL UNIVERSE" and each list is ten rows long.
    # Measured 2026-08-16: 65 markets passed the VOL>1M filter (36 up, 29
    # down), so 26 gainers and 19 losers were dropped with nothing said and
    # nothing in the payload from which the client could have said it. The
    # search space and the result set are different numbers; both travel now.
    return {
        "gainers": list(reversed(by_chg[-MOVERS_TOP:])),
        "losers": by_chg[:MOVERS_TOP],
        "funding_extremes": by_funding[:MOVERS_TOP],
        "limit": MOVERS_TOP,
        "n_qualified": {"markets": len(rows), "gainers": n_up, "losers": n_dn,
                        "funding": len(by_funding)},
        "min_volume": MOVERS_MIN_VOLUME,
        "cap_note": "each list is the top %d only. %d markets pass VOL>$%.0fM "
                    "(%d up, %d down, %d with a funding rate) — the rest are "
                    "NOT SHOWN, not absent."
                    % (MOVERS_TOP, len(rows), MOVERS_MIN_VOLUME / 1e6,
                       n_up, n_dn, len(by_funding)),
    }


_REGIME_WARMING = threading.Event()
REGIME_TTL = 1800
# The last background rebuild that did not land. `except Exception: pass` used
# to be the whole of the error handling here, so a regime.snapshot() that
# failed permanently kept the last good snapshot on screen as CURRENT, with no
# date on it and nothing anywhere recording that the rebuilds had stopped.
_REGIME_FAIL = {"err": None, "where": None, "at": None}


def _build_regime(crypto_ctxs):
    from datasources import regime
    try:
        CACHE.set("regime_ext", regime.snapshot(crypto_ctxs), REGIME_TTL)
        _REGIME_FAIL.update(err=None, where=None, at=None)
    except Exception as exc:
        msg, side = _fault("/api/regime", exc)
        _REGIME_FAIL.update(err=msg, where=side, at=time.time())
    finally:
        _REGIME_WARMING.clear()


def api_regime():
    """Serve the cached snapshot; rebuild in the background when stale.

    This was the one slow route still built on the request thread — six
    upstream fetches, 15-18s cold, paid by whichever poll landed on the
    expired cache. Same background-warm pattern as signals/buyback: a
    stale-but-present snapshot is served instantly while a thread rebuilds.
    """
    from datasources import regime
    data = CACHE.get_or_fetch(
        "universe", 120,
        lambda: {"crypto": hl.asset_ctxs(""), "equity": hl.asset_ctxs("xyz")})
    ext, fresh = CACHE.get_stale("regime_ext")
    if ext is not None and not fresh and not _REGIME_WARMING.is_set():
        # Stale: serve it now, rebuild behind the response.
        _REGIME_WARMING.set()
        threading.Thread(target=_build_regime, args=(data["crypto"],),
                         daemon=True).start()
    if ext is None:
        # First boot only: nothing to serve stale, wait for the build
        # (single-flight in the cache dedupes concurrent cold requests).
        ext = CACHE.get_or_fetch(
            "regime_ext", REGIME_TTL, lambda: regime.snapshot(data["crypto"]))
    # breadth recomputed live from the (2-min) universe cache, not the 30-min ext cache
    ext = dict(ext)
    try:
        ext["hl"] = regime.hl_breadth(data["crypto"])
    except Exception as exc:
        ext.update(_fault_fields("/api/regime:breadth", exc,
                                 key="breadth_error"))
    # DATE IT. This was the last cached route serving an undated snapshot,
    # while funding_x / stops / xvenue all ship at+age_s+ttl_s — the P3 shape
    # again. Age is computed here, on ONE clock: a browser subtracting its own
    # Date.now() from a server `at` is measuring clock skew, not age.
    built = CACHE.built_at("regime_ext")
    ext["at"] = built
    ext["age_s"] = round(time.time() - built, 1) if built else None
    ext["ttl_s"] = REGIME_TTL
    # age_s CAN exceed ttl_s, and that is the fact worth the most here: the
    # background rebuild serves the stale snapshot on every failure, so an age
    # past the TTL is precisely how a frozen regime announces itself.
    ext["age_note"] = ("rebuilt every %ds in the background and served stale "
                       "meanwhile — an age past %ds means the rebuilds are "
                       "not landing, and `rebuild_error` says why"
                       % (REGIME_TTL, REGIME_TTL))
    if _REGIME_FAIL["err"]:
        ext["rebuild_error"] = _REGIME_FAIL["err"]
        ext["rebuild_error_where"] = _REGIME_FAIL["where"]
        ext["rebuild_failed_at"] = _REGIME_FAIL["at"]
        ext["rebuild_failed_age_s"] = round(time.time() - _REGIME_FAIL["at"], 1)
    return ext


_INSIDERS_WARMING = threading.Event()


def _warm_insiders():
    from datasources import insiders
    try:
        data = CACHE.get_or_fetch(
            "universe", 120,
            lambda: {"crypto": hl.asset_ctxs(""), "equity": hl.asset_ctxs("xyz")})
        tickers = sorted({k.split(":", 1)[1] for k in data["equity"]})
        result = insiders.insider_clusters(tickers)
        CACHE.set("insiders", result, 12 * 3600)
    except Exception as exc:
        CACHE.set("insiders", dict(_fault_fields("/api/insiders", exc),
                                  clusters=[]), 600)
    finally:
        _INSIDERS_WARMING.clear()


def api_insiders():
    cached = CACHE.get("insiders")
    if cached is not None:
        return cached
    if not _INSIDERS_WARMING.is_set():
        _INSIDERS_WARMING.set()
        threading.Thread(target=_warm_insiders, daemon=True).start()
    return {"status": "warming", "clusters": []}


# Dedicated 30-min cache for the signals technical pass. EMA20/50 posture does
# not need chart-grade freshness, and a separate key keeps these bulk fetches
# from competing with the UI's own candle requests (Hyperliquid returns HTTP 429
# on wide bursts).
SIGNAL_CANDLE_TTL = 1800


def _closes_for(coin):
    """1h closes for the signals technical pass; own long-lived cache."""
    key = "sigcandles:{}".format(coin)
    cached = CACHE.get(key)
    if cached is not None:
        return cached
    try:
        rows = hl.candles(coin, "1h", _window_start("1h", 200))
        closes = [float(c["c"]) for c in rows[-300:]]
    except Exception:
        # Back off briefly instead of re-hammering a throttled endpoint every
        # rebuild. Trend is display-only, so an empty read costs a label, not
        # a ranking position.
        CACHE.set(key, [], 120)
        return []
    CACHE.set(key, closes, SIGNAL_CANDLE_TTL)
    return closes


_SIGNALS_WARMING = threading.Event()


def _build_signals():
    import signals as signals_mod
    def build():
        universe = CACHE.get_or_fetch(
            "universe", 120,
            lambda: {"crypto": hl.asset_ctxs(""), "equity": hl.asset_ctxs("xyz")})
        ev_payload = api_events()
        events = ev_payload.get("events") or []
        events_ok = not ev_payload.get("error")
        try:
            cards = api_research().get("cards") or []
        except Exception:
            cards = []
        ins = (CACHE.get("insiders") or {}).get("clusters") or []
        try:
            fx = _funding_x_map()
        except Exception:
            fx = None            # factor falls back to the baseline deviation
        return signals_mod.compute(universe, events, cards, ins, _closes_for,
                                   events_ok=events_ok, funding_x=fx)
    try:
        CACHE.set("signals", build(), 300)
        CACHE.set("signals_fresh", 1, 120)   # prime, else a 2nd build fires at once
    except Exception as exc:
        CACHE.set("signals", dict(_fault_fields("/api/signals", exc),
                                 signals=[]), 60)
    finally:
        _SIGNALS_WARMING.clear()


def api_signals():
    """Serve the cached ranking; refresh in the background so no request pays
    the cold two-pass build (~40s when the candle cache is empty)."""
    cached = CACHE.get("signals")
    if cached is None and not _SIGNALS_WARMING.is_set():
        _SIGNALS_WARMING.set()
        threading.Thread(target=_build_signals, daemon=True).start()
        return {"status": "warming", "signals": []}
    if cached is None:
        return {"status": "warming", "signals": []}
    if CACHE.get("signals_fresh") is None and not _SIGNALS_WARMING.is_set():
        CACHE.set("signals_fresh", 1, 120)     # refresh at most every 2 min
        _SIGNALS_WARMING.set()
        threading.Thread(target=_build_signals, daemon=True).start()
    try:
        from datasources import edge_registry
        rows = edge_registry.annotate(cached.get("signals") or [])
        out = dict(cached)
        out["signals"] = rows
        out["edge_summary"] = edge_registry.summary(rows)
        out["edge_provenance"] = {
            "source": "recorded walk-forward research (block-bootstrap + "
                      "Deflated Sharpe, Protocol v1)",
            "live": False,
        }
        return out
    except Exception:
        return cached          # a registry fault must never blank the pane
    return cached


# ── SIDES: both sides of ONE instrument, in one request ───────────────────
# The owner's brief, in his words: "I want it to have all data at one place so
# I can see the buy and sell side to get the whole picture." That is a
# per-instrument question, and answering it used to mean visiting up to five
# panes that share a single slot. This route assembles the whole answer from
# stores that are ALREADY warm — the venue snapshot (5 min), the universe
# ctxs (120s), the whale sweep's own files, and the two websocket collectors
# which cost no REST at all. The only upstream call it can make is one
# 1-second-cached l2Book, which the chart is already fetching anyway.
#
# WHAT IT REFUSES TO DO: rank venues by fill cost, estimate slippage, or imply
# that book imbalance or aggressor flow predicts direction. At a $5-10k clip
# measured impact is 0.001%-0.046%, so execution cost is not the question;
# presence and drain are. Recorded research: 1h flow-to-direction correlation
# is +0.005 and the divergence annotation tested NO-GO.

SIDES_LEVELS = 6          # book levels rendered per side
SIDES_CLIP_DEFAULT = 10000.0
SIDES_DRAIN_FLOOR = 0.02  # ignore sub-2% minute-to-minute depth wobble


def _sides_clip(q):
    try:
        c = float((q.get("clip") or [SIDES_CLIP_DEFAULT])[0])
    except (TypeError, ValueError):
        c = SIDES_CLIP_DEFAULT
    return min(1e6, max(100.0, c))


_VENUES_WARMING = threading.Event()


def _warm_venues():
    """Fetch the venue snapshot in the background, at most one at a time."""
    if _VENUES_WARMING.is_set():
        return
    _VENUES_WARMING.set()

    def run():
        try:
            api_venues()
        except Exception:
            pass
        finally:
            _VENUES_WARMING.clear()
    threading.Thread(target=run, daemon=True).start()


def _sides_ident(coin, ctx):
    """Which venue is this, how big is it, and does it trade anywhere else."""
    from datasources import cross_venue
    out = {"coin": coin, "base": cross_venue.base_ticker(coin)}
    mid = (ctx or {}).get("mid_px") or (ctx or {}).get("mark_px")
    prev = (ctx or {}).get("prev_day_px")
    out["px"] = mid
    out["chg_24h_pct"] = ((mid - prev) / prev * 100.0) if (mid and prev) else None
    out["mkt_vol_24h"] = (ctx or {}).get("day_volume")
    snap = CACHE.get("venues")
    if snap is None:
        # Warm it off the request path rather than making the first viewer of
        # the pane wait ~5s for eleven upstream calls. The next poll has it.
        _warm_venues()
        out["venue"] = coin.split(":")[0] if ":" in coin else "HL core"
        out["venue_note"] = ("venue snapshot not warm yet — venue size and "
                             "cross-listing unknown, not absent (warming now)")
        out["listing"] = cross_venue.classify(None, coin)
        return out
    want = coin.split(":")[0] if ":" in coin else "HL core"
    for v in snap.get("venues") or []:
        if v.get("venue") == want:
            out["venue"] = v["venue"]
            out["venue_kind"] = v.get("kind")
            out["venue_vol_24h"] = v.get("vol_24h")
            out["venue_markets"] = v.get("markets")
            # OI is carried PER VENUE and never summed anywhere in this
            # payload: a trader hedged on two venues is counted on both.
            out["venue_oi_usd"] = v.get("oi_usd")
            break
    else:
        out["venue"] = want
        out["venue_note"] = "venue not in the live set of the last snapshot"
    tot = (snap.get("totals") or {})
    out["venues_total_vol_24h"] = tot.get("vol_24h")
    out["venues_failed"] = tot.get("venues_failed") or 0
    out["venues_failed_names"] = [f.get("venue") for f in (snap.get("failed") or [])]
    out["venue_share_pct"] = (
        round(out.get("venue_vol_24h", 0) / tot["vol_24h"] * 100.0, 1)
        if out.get("venue_vol_24h") and tot.get("vol_24h") else None)
    out["listing"] = cross_venue.classify(snap.get("listings"), coin)
    return out


def _sides_book(coin, sig):
    """Live resting book, top levels a side, in CLIPS as well as dollars.

    Clips, because his size is the denominator that turns a depth figure into
    a presence read: "$1.19M" makes you divide, "119 clips" does not.
    """
    key = "book:{}:{}".format(coin, sig)
    try:
        d = CACHE.get_or_fetch(key, 1, lambda: hl.l2_book(coin, sig))
    except Exception as exc:
        return dict(_fault_fields("/api/sides:book", exc, key="err"),
                    bids=[], asks=[])
    # The try above covers only the FETCH. hl.l2_book returns None for a coin
    # the venue does not list, and the bare d.get("levels") below then raised
    # AttributeError INSIDE the caller's own except, which serialised the
    # string "'NoneType' object has no attribute 'get'" into the `err` field
    # and put a Python traceback fragment on the glass as though it were a
    # market fact. Measured live: /api/sides?coin=NOTACOIN and a CJK symbol
    # both returned exactly that under HTTP 200. Say what is true instead —
    # this venue has no book for this symbol.
    if not isinstance(d, dict):
        return {"err": "no book: %s is not listed on this venue" % coin,
                "bids": [], "asks": []}
    bids, asks = (d.get("levels") or [[], []])[:2]
    f = lambda rows: [{"px": float(r["px"]), "sz": float(r["sz"]),
                       "usd": float(r["px"]) * float(r["sz"])}
                      for r in (rows or [])]
    b, a = f(bids), f(asks)
    if not b or not a:
        return {"err": "book empty at nSigFigs=%d" % sig, "bids": b, "asks": a}
    mid = (b[0]["px"] + a[0]["px"]) / 2.0
    cum = 0.0
    for r in b:
        cum += r["usd"]
        r["cum"] = cum
        r["bps"] = (mid - r["px"]) / mid * 1e4
    cum = 0.0
    for r in a:
        cum += r["usd"]
        r["cum"] = cum
        r["bps"] = (r["px"] - mid) / mid * 1e4
    # How far the book we were served actually REACHES. At nSigFigs=5 an
    # equity perp near $1,600 resolves only ~12bps of book, so every band
    # wider than that is the SAME number three times — which reads as a bug
    # unless the reach is stated and the wider bands are refused.
    reach = min(b[-1]["bps"], a[-1]["bps"])
    tick = None
    if len(b) > 1:
        tick = abs(b[0]["px"] - b[1]["px"]) / mid * 1e4
    sp = _true_spread(d, b, a)
    return {
        "mid": mid, "spread_bps": sp["spread_bps"],
        "spread_src": sp["spread_src"],
        "tick_bps": tick, "reach_bps": reach, "sig": sig,
        "bids": b[:SIDES_LEVELS], "asks": a[:SIDES_LEVELS],
        "bid_usd_total": b[-1]["cum"], "ask_usd_total": a[-1]["cum"],
        "note": "resting size is CANCELLABLE — this is where liquidity is "
                "SHOWN, not a commitment and not a forecast",
    }


def _sides_bands(coin, book):
    """Depth by DISTANCE, with each band carrying its own 1h change.

    The single most useful object here and the one nothing in the terminal
    rendered before: measured on BTC, the book was +50% bid-skewed at +/-5bps
    and -3% at +/-50bps in the same instant. One scalar at the reference band
    cannot say that, and every existing surface reports exactly one scalar.
    """
    from datasources import depth_history
    rows = depth_history.series(coin, hours=1, bucket_s=60)
    grid = list(depth_history.GRID)
    out = {"grid": grid, "ref_bps": depth_history.REF_BPS, "rows": []}
    cur = rows[-1] if rows else None
    if cur is None:
        # Ask the collector; do not assert. ensure() refuses past MAX_COINS
        # and the re-rank is add-only, so the cap fills over days and this
        # sentence would go quietly false. _sides_flow already does this.
        try:
            sub, pend = depth_history.subscribed()
        except Exception:
            sub, pend = [], []
        if coin in sub or coin in pend:
            out["subscribed"] = True
            out["why"] = ("no depth sample recorded for %s yet — it IS "
                          "subscribed and the first minute closes within 60s. "
                          "Earlier hours cannot be backfilled." % coin)
        else:
            st = {}
            try:
                st = depth_history.status()
            except Exception:
                pass
            out["subscribed"] = False
            out["why"] = ("%s is NOT in the depth collector (%s of %s coin "
                          "slots in use) — nothing is being recorded for it, "
                          "and no past hour can ever be backfilled. Blank "
                          "here means NOT COLLECTED, not a balanced book."
                          % (coin, len(sub) + len(pend),
                             st.get("max_coins", "?")))
    # Resolvability is a property of the RECORDED sample, whose stitched
    # near+wide book is a different aggregation from the ladder shown above.
    # Judging the recorded bands by the ladder's reach marked BTC's +/-50bps
    # row unresolved while the record held it out to 310bps.
    tick = (cur or {}).get("tick_bps")
    reach = (cur or {}).get("reach_bps")
    out["age_s"] = (round(time.time() - cur["ms"] / 1000.0, 1)
                    if cur and cur.get("ms") else None)

    def at(key, i):
        """Band i of a sample, or None. A short/absent array is NOT a zero."""
        arr = (cur or {}).get(key)
        return arr[i] if isinstance(arr, list) and i < len(arr) else None

    # Bands removed by the cumulative-containment guard, and per-band sample
    # support. Both are properties of THIS band, not of the row, and without
    # them a band the fold dropped reads as "not resolvable" (wrong reason)
    # and a band carried by 1 sample in 12 reads exactly like one carried by
    # all 12 (no reason at all).
    dropped = {(d[0], d[1]) for d in ((cur or {}).get("containment_dropped") or [])}
    kb_arr = (cur or {}).get("k_bid_band") or []
    ka_arr = (cur or {}).get("k_ask_band") or []
    k_row = (cur or {}).get("k") or 0

    prev_b = prev_a = None
    for i, band in enumerate(grid):
        bid, ask, imb = at("bid", i), at("ask", i), at("imb", i)
        why = repeat = thin = None
        kb = kb_arr[i] if i < len(kb_arr) else None
        ka = ka_arr[i] if i < len(ka_arr) else None
        if cur is None:
            why = "no sample"
        elif bid is None or ask is None:
            if ("bid", band) in dropped or ("ask", band) in dropped:
                why = ("dropped: this band measured SMALLER than a band it "
                       "contains. Its neighbours came from different book "
                       "resolutions, so the number contradicted its own "
                       "definition and was removed rather than clamped")
            elif tick and tick > band:
                why = "tick %.1fbps is wider than the %dbps band" % (tick, band)
            elif reach and band > reach:
                why = "the recorded book ends at %.0fbps" % reach
            else:
                why = "not resolvable in this sample"
        else:
            k_band = min(x for x in (kb, ka) if x is not None) if (
                kb is not None or ka is not None) else None
            if k_band is not None and k_row and k_band < max(2, k_row * 0.5):
                thin = ("median of %d of this minute's %d samples — this band "
                        "resolved intermittently, so it is a thinner "
                        "measurement than the bands around it"
                        % (k_band, k_row))
        if (why is None and bid is not None and ask is not None
                and bid == prev_b and ask == prev_a):
            # THE REACH TRAP, made visible: once the book ends, every wider
            # band is the same dollars again. Repeating one number under three
            # labels reads as a bug; saying it is the same number does not.
            repeat = ("same dollars as +/-%dbps — the book ends before this "
                      "band" % grid[i - 1])
        prev_b, prev_a = bid, ask
        out["rows"].append({
            "band_bps": band, "bid_usd": bid, "ask_usd": ask, "imb": imb,
            "chg_1h_pct": depth_history.delta(coin, 1, band_bps=band),
            "unresolved": why, "repeat": repeat, "thin": thin,
            "k_bid": kb, "k_ask": ka, "k_row": k_row or None,
        })
    if cur:
        out["at_ms"] = cur.get("ms")
        out["tick_bps"] = tick
        out["reach_bps"] = reach
        out["bid_orders"] = cur.get("bid_orders")
        out["ask_orders"] = cur.get("ask_orders")
    # How much of this instrument's imbalance survives one minute. The pane
    # draws its waterline from the reference band, and the persistence of that
    # split is a property of the instrument, not of its size: measured, it
    # spans 0.01 (xyz:BRENTOIL, xyz:CL) to 0.93 (xyz:SP500, HYPE), and xyz:CL
    # carries an $8.5M book at the noisy end while VVV carries $41k at 0.56.
    try:
        m = depth_history.metrics([coin]).get(coin) or {}
        rho, flip = m.get("depth_imb_rho"), m.get("depth_imb_flip_pct")
        out["imb_rho"] = rho
        out["imb_flip_pct"] = flip
        out["imb_n"] = m.get("depth_imb_n")
        if rho is None:
            out["imb_note"] = ("not enough adjacent minutes yet to say how "
                               "steady this imbalance is — unmeasured, not "
                               "stable")
        elif rho < depth_history.IMB_NOISE_RHO:
            out["imb_note"] = ("this book's imbalance barely survives a "
                               "minute (rho %.2f, sign flips in %.0f%% of "
                               "minutes) — read the LEVEL, not the split"
                               % (rho, flip if flip is not None else 0))
        elif flip is not None and flip >= 30:
            # Two different things can be steady. A high rho with a high flip
            # rate means the MAGNITUDE persists while the SIDE does not, and
            # the side is what the waterline draws — so leading with
            # "persists" here would be true of the wrong quantity.
            out["imb_note"] = ("the SIZE of this imbalance persists (rho "
                               "%.2f) but the SIDE does not — it flips in "
                               "%.0f%% of minutes, so which way the waterline "
                               "leans is close to a coin flip"
                               % (rho, flip))
        else:
            out["imb_note"] = ("imbalance persists minute to minute here "
                               "(rho %.2f, sign flips in %.0f%% of minutes)"
                               % (rho, flip if flip is not None else 0))
    except Exception as exc:
        # Not "no persistence measured" — the measurement did not run.
        msg, _side = _fault("/api/sides:imbalance-persistence", exc)
        out["imb_note"] = ("imbalance persistence NOT MEASURED — %s" % msg)
    return out


def _sides_taken_pulled(coin, hours=1.0):
    """Of the depth that LEFT in the last hour, how much was traded away?

    Descriptive decomposition, minute by minute: when resting depth at the
    reference band falls, compare the dollars that left against the dollars
    that actually printed in the same minute. Traded >= drop reads as TAKEN;
    a drop with no matching prints reads as PULLED. This is a statement about
    what already happened, NOT a signal: nothing here forecasts anything, and
    the two series are measured differently (depth spans +/-25bps of the book
    while prints happen at the touch), so the split is a proportion, not an
    identity.
    """
    from datasources import depth_history, flow_collector
    sub, pend = flow_collector.subscribed()
    if coin not in sub and coin not in pend:
        return {"ok": False, "why": "no trade tape for %s — cannot separate a "
                                    "cancelled book from a traded one" % coin}
    d = depth_history.series(coin, hours=hours, bucket_s=60)
    f = flow_collector.series(coin, hours=hours, bucket_s=60)
    if len(d) < 3:
        return {"ok": False, "why": "needs a few minutes of depth history"}
    i = depth_history.GRID.index(depth_history.REF_BPS)
    traded = {int(r["ms"]): (r.get("buy") or 0) + (r.get("sell") or 0) for r in f}
    drop_usd = taken_usd = 0.0
    n_down = n_flat = 0
    prev = None
    def at(row, key):
        arr = row.get(key)
        return arr[i] if isinstance(arr, list) and i < len(arr) else None

    for r in d:
        b, a = at(r, "bid"), at(r, "ask")
        tot = (b + a) if (b is not None and a is not None) else None
        if tot is None:
            prev = None
            continue
        if prev is not None and tot < prev * (1 - SIDES_DRAIN_FLOOR):
            d_usd = prev - tot
            drop_usd += d_usd
            taken_usd += min(d_usd, traded.get(int(r["ms"]), 0.0))
            n_down += 1
        elif prev is not None:
            n_flat += 1
        prev = tot
    if drop_usd <= 0:
        return {"ok": True, "n_down": 0, "n_obs": n_flat,
                "note": "no minute in this window shed more than %.0f%% of the "
                        "+/-%dbps book" % (SIDES_DRAIN_FLOOR * 100,
                                           depth_history.REF_BPS)}
    taken_pct = round(taken_usd / drop_usd * 100.0, 1)
    return {"ok": True, "n_down": n_down, "n_obs": n_down + n_flat,
            "drop_usd": round(drop_usd), "taken_pct": taken_pct,
            "pulled_pct": round(100.0 - taken_pct, 1),
            "note": "descriptive: of the depth that left the +/-%dbps book, "
                    "%.0f%% is matched by prints in the same minute and %.0f%% "
                    "is not. Not a forecast." %
                    (depth_history.REF_BPS, taken_pct, 100.0 - taken_pct)}


def _sides_drain(coin):
    """Is the book thinning, from which side, and do we have the hours to say."""
    from datasources import depth_history, mkt_session
    ref = depth_history.REF_BPS
    out = {
        "band_bps": ref,
        "h1": depth_history.delta(coin, 1, band_bps=ref),
        "h6": depth_history.delta(coin, 6, band_bps=ref),
        "h24": depth_history.delta(coin, 24, band_bps=ref),
        "bid_1h": depth_history.delta(coin, 1, band_bps=ref, side="bid"),
        "ask_1h": depth_history.delta(coin, 1, band_bps=ref, side="ask"),
        "coverage": depth_history.coverage(coin),
        "taken_pulled": _sides_taken_pulled(coin),
    }
    cav = mkt_session.caveat(coin)
    if cav:
        out["session_caveat"] = cav
    return out


def _sides_flow(coin):
    """Aggressor flow, both sides, at 60s and 1h. Descriptive, never predictive."""
    from datasources import flow_collector
    sub, pend = flow_collector.subscribed()
    if coin not in sub and coin not in pend:
        return {"subscribed": False,
                "why": "%s is not in the trade-tape collector — no aggressor "
                       "split available for it" % coin}
    window_h = 1
    rows = flow_collector.series(coin, hours=window_h, bucket_s=60)
    if not rows:
        # THE WINDOW IS NOT AN EPOCH. This branch used to say "subscribed, but
        # no prints recorded yet", which the pane echoed verbatim — reporting a
        # ONE-HOUR miss as "ever". It also stranded the pane's whole dating
        # apparatus (silentMs, the two-feed cross-check, the IST tooltip),
        # because m1.ms is its only clock and there is no m1 here. So the two
        # facts that are actually measurable ship instead: how wide the window
        # was, and when the collector last recorded anything AT ALL — reaching
        # past the window, so "quiet for 3 hours" cannot read as "never".
        last_ms = flow_collector.newest_bucket_ms(coin)
        return {"subscribed": True, "rows": 0, "window_h": window_h,
                "last_bucket_ms": last_ms,
                "why": ("subscribed, and nothing recorded in the last %gh"
                        % window_h) + (
                    " — the collector's newest bucket for this market is older "
                    "than that window" if last_ms else
                    ". No bucket has EVER been recorded for this market, so "
                    "this is the collector never having heard it print, not a "
                    "market that has gone quiet")}
    last = rows[-1]
    agg = lambda rs: {"buy": sum(r.get("buy") or 0 for r in rs),
                      "sell": sum(r.get("sell") or 0 for r in rs),
                      "n": sum(r.get("n") or 0 for r in rs)}
    h1 = agg(rows)
    return {
        "subscribed": True, "rows": len(rows),
        "m1": {"buy": last.get("buy") or 0, "sell": last.get("sell") or 0,
               "n": last.get("n") or 0, "ms": last.get("ms")},
        "h1": h1,
        # CVD is a LEVEL, not a side: it gets a slope, never a rail.
        "cvd": last.get("cvd"),
        "cvd_spark": [round(r.get("cvd") or 0) for r in rows[-40:]],
        "note": "DESCRIPTIVE, NOT PREDICTIVE — recorded research: 1h "
                "flow-to-direction correlation +0.005; the terminal's own "
                "divergence annotation tested NO-GO",
    }


def _sides_whales(coin):
    """Which way tracked wallets are positioned, and where their size rests.

    Coverage travels through untouched. A venue the sweep has not queried
    arrives here as NULL and must leave as NULL — the `or 0` this function
    used to apply to every field is precisely how "never looked" became
    "no whales here" on every xyz market.
    """
    from datasources import whales
    try:
        d = CACHE.get_or_fetch("whale_coin:" + coin, 60,
                               lambda: whales.coin_detail(coin))
    except Exception as exc:
        return dict(_fault_fields("/api/sides:whales", exc, key="why"),
                    ok=False)
    cov = d.get("coverage") or {}
    out = {
        "ok": True,
        "coverage": cov,
        "long_ntl": d.get("long_ntl"), "short_ntl": d.get("short_ntl"),
        "n_positions": d.get("n_positions"),
        "avg_long_entry": d.get("avg_long_entry"),
        "avg_short_entry": d.get("avg_short_entry"),
        "at": d.get("at"),
    }
    orders = d.get("orders")
    if orders is None:
        # This venue's resting book is never fetched, so 0/0 rails would be
        # claiming a measured absence of size. Nulls, and a sentence below.
        out["bid_ntl"] = out["ask_ntl"] = out["orders"] = None
    else:
        out["bid_ntl"] = sum(o["ntl"] for o in orders if o.get("side") == "bid")
        out["ask_ntl"] = sum(o["ntl"] for o in orders if o.get("side") == "ask")
        out["orders"] = orders[:4]
    ages = [p.get("snapshot_age_s") for p in (d.get("positions") or [])
            if p.get("snapshot_age_s") is not None]
    out["snapshot_age_s"] = min(ages) if ages else None
    # A coverage HOLE and a coverage CAVEAT are different claims, and the pane
    # renders them differently on purpose:
    #   gap    — nothing was measured, so there are no numbers; the sentence
    #            REPLACES the rails.
    #   caveat — the numbers are real but incomplete; the sentence RIDES WITH
    #            them.
    # Sending every incomplete coverage as `gap` collapsed the two. Coverage is
    # essentially never complete — one failed wallet fetch out of 200 makes it
    # partial, and 4, 8, 23 and 25 failures were observed inside 20 minutes —
    # so the consumer's "there is nothing to show" branch fired permanently and
    # deleted 58 measured BTC positions to print a footnote. A LOWER BOUND IS
    # STILL A COUNT: it ships with its caveat attached, exactly as the depth
    # block ships "8.9h of 48h collected" next to its number.
    notes = [n for n in (cov.get("why") if not cov.get("complete") else None,
                         cov.get("orders_why")) if n]
    note = " \u00b7 ".join(notes) if notes else None
    # n_positions is None only when whales.coin_detail measured nothing at all
    # (state warming / not_covered). 0 means it asked and nobody was there.
    if out["n_positions"] is None or cov.get("state") in ("warming", "not_covered"):
        out["gap"] = note or ("no whale sweep has reported on %s yet"
                              % (cov.get("venue") or coin))
    elif note:
        out["caveat"] = note
    return out


def _sides_funding(coin, ctx, clip):
    """What each side pays to hold, in dollars a day on HIS clip."""
    fr = (ctx or {}).get("funding")
    out = {"clip_usd": clip}
    if fr is None:
        out["why"] = "no funding rate in the venue context for %s" % coin
        return out
    apr = fr * 24 * 365 * 100.0
    out["hourly"] = fr
    out["apr_pct"] = apr
    out["pct_8h"] = fr * 8 * 100.0
    # Sign convention matches PORT and the whole terminal: positive funding
    # means LONGS PAY.
    out["pays"] = "long" if fr >= 0 else "short"
    out["usd_day_on_clip"] = abs(fr) * 24 * clip
    try:
        fx = _funding_x_map() or {}
    except Exception:
        fx = {}
    row = fx.get(coin) or fx.get(coin.split(":")[-1] if ":" in coin else coin)
    if ":" in coin:
        out["cex"] = None
        out["cex_note"] = ("no centralised venue lists a perp on this "
                           "underlying — the comparison is impossible by "
                           "construction, not missing")
    elif row:
        out["cex"] = {"median_apr": row.get("cex_median_apr"),
                      "n": row.get("n_cex"), "disloc_apr": row.get("disloc_apr")}
    else:
        out["cex_note"] = "no CEX funding row for this coin in the last fetch"
    return out


# Which HIP-3 dexs a wallet is checked on. `clearinghouseState` is PER DEX, so
# a query with no `dex` returns core positions only — which is how the PORT
# pane came to print "account is flat" to an account holding xyz positions.
PORT_DEX_BASE = ["", "xyz"]
PORT_FULL_SCAN_S = 300
_PORT_SCAN = {}


def _port_dexs(addr):
    """Venues to query for this wallet, plus what that choice covered.

    Every live HIP-3 dex is swept every PORT_FULL_SCAN_S; between sweeps only
    core, xyz and the venues that were actually holding something are polled.
    That keeps a 20s refresh at 2-3 calls instead of 6 without ever letting a
    venue drop out silently — `scanned` states which list was used.
    """
    snap = CACHE.get("venues")
    live = []
    for v in (snap or {}).get("venues") or []:
        if v.get("kind") == "hip3" and v.get("venue"):
            live.append(v["venue"])
    # DORMANT venues hold positions too. "Dormant" in venues.py means zero
    # 24h VOLUME, which says nothing about resting exposure — a wallet can sit
    # in size on a venue nobody traded today. They were outside every mode,
    # including the one whose note read "every live HIP-3 dex", so a full
    # sweep silently skipped 5 venues / 72 markets. The full sweep now
    # includes them (5 extra calls once per PORT_FULL_SCAN_S) and the partial
    # sweep states which venues it did not ask.
    dormant = sorted({v.get("venue") for v in (snap or {}).get("dormant") or []
                      if v.get("venue")} - set(live))
    every = sorted(set(live) | set(dormant))
    rec = _PORT_SCAN.get(addr) or {"at": 0, "active": []}
    now = time.time()
    if not every:
        return PORT_DEX_BASE, {"mode": "base", "note": "venue snapshot not "
                               "warm — core + xyz only; other HIP-3 venues "
                               "were NOT queried, which is not the same as "
                               "flat on them",
                               "not_queried": None}
    # The base venues are queried whether or not the snapshot lists them.
    # `every` is built from the venue snapshot, and that snapshot warms
    # incrementally: MEASURED 2026-08-16, seconds after a restart it held
    # {mkts, para, abcd, cash} and not xyz, so `if d in every` filtered xyz
    # out of the keep list while `not_queried` — also derived from `every` —
    # could not name it either. xyz was neither asked nor reported: an
    # unqueried venue wearing the clothes of a venue with nothing on it, on
    # the one HIP-3 dex this desk actually trades. Base venues are unioned in
    # instead, and `not_queried` is computed against the union so a venue can
    # never fall out of BOTH lists.
    base = [d for d in PORT_DEX_BASE if d]
    known = sorted(set(every) | set(base))
    if now - rec["at"] >= PORT_FULL_SCAN_S:
        return [""] + known, {
            "mode": "full",
            "dormant_included": dormant,
            "not_queried": [],
            "note": "full sweep of every HIP-3 dex, including the %d deployed "
                    "with no 24h volume — zero volume is not zero positions"
                    % len(dormant)}
    keep = sorted((set(rec["active"]) & set(every)) | set(base))
    return [""] + keep, {"mode": "partial",
                         "age_s": round(now - rec["at"]),
                         "not_queried": [d for d in known if d not in keep],
                         "note": "core + venues seen holding a position in the "
                                 "last full sweep (%ds ago); the rest are "
                                 "re-checked on the next full sweep and are "
                                 "listed in not_queried"
                                 % (now - rec["at"])}


def _sides_you(addr, coin, ctxs):
    """His own position in THIS instrument, on whichever venue it is on."""
    from datasources import portfolio
    if not addr:
        return {"status": "no-address",
                "why": "paste a Hyperliquid address in the PORT tab to see "
                       "your own side here"}
    if not _valid_addr(addr):
        return {"status": "bad-address",
                "why": "expected a 0x address of exactly 40 hex digits"}
    dexs, how = _port_dexs(addr)
    try:
        data = CACHE.get_or_fetch(
            "portall:" + addr.lower(), PORT_TTL,
            lambda: portfolio.build_all(addr, dexs, ctxs=ctxs))
    except Exception as exc:
        return dict(_fault_fields("/api/sides:you", exc, key="why"),
                    status="error")
    if how["mode"] == "full":
        _PORT_SCAN[addr] = {
            "at": time.time(),
            "active": [v["dex"] for v in data.get("venues") or []
                       if v.get("dex") and v.get("n_positions")]}
    pos = next((p for p in data.get("positions") or [] if p["coin"] == coin), None)
    venue = coin.split(":")[0] if ":" in coin else ""
    vrec = next((v for v in data.get("venues") or [] if v.get("dex") == venue), None)
    return {
        "status": "ok",
        "position": pos,
        "venue_account": vrec and {
            "venue": vrec["venue"], "account_value": vrec["account_value"],
            "gross_leverage": vrec["gross_leverage"],
            "maint_headroom_pct": vrec["maint_headroom_pct"],
            "n_positions": vrec["n_positions"]},
        "venue_queried": venue or "HL core",
        "venues_queried": data.get("venues_queried"),
        "failed": data.get("failed"),
        "n_positions_total": data.get("n_positions"),
        "scan": how,
        "no_sum_note": data.get("no_sum_note"),
    }


def api_sides(q):
    """Everything with a SIDE, for one instrument, in one response."""
    from datasources import depth_history
    coin = (q.get("coin") or ["BTC"])[0]
    addr = (q.get("addr") or [""])[0].strip()
    clip = _sides_clip(q)
    try:
        sig = int((q.get("sig") or ["4"])[0])
    except ValueError:
        sig = 4
    sig = sig if sig in (3, 4, 5) else 4
    # Looking at an instrument is the signal that its book and tape matter.
    # Both collectors ride the websocket, so subscribing costs no REST — and
    # an hour of depth not recorded is permanently unanswerable. But an
    # unvalidated symbol spends an add-only slot forever, and this route is
    # reachable by GET, so the universe is asked first (no upstream cost —
    # same 120s cache this route already reads below).
    known_coin = _known_coin(coin)
    if known_coin:
        try:
            depth_history.ensure(coin)
        except Exception:
            pass
        try:
            from datasources import flow_collector
            flow_collector.ensure(coin)
        except Exception:
            pass

    data = CACHE.get_or_fetch(
        "universe", 120,
        lambda: {"crypto": hl.asset_ctxs(""), "equity": hl.asset_ctxs("xyz")})
    ctxs = dict(data.get("crypto") or {})
    ctxs.update(data.get("equity") or {})
    ctx = ctxs.get(coin) or {}

    out = {"coin": coin, "at": time.time(), "clip_usd": clip,
           # Whether any venue in the current universe lists this at all. An
           # unknown symbol is not subscribed to either collector, so every
           # empty block below means "unrecognised", not "measured empty".
           "known_market": known_coin}
    if not known_coin:
        out["unknown_market_note"] = (
            "%r is not a market in the current venue universe. No book or "
            "tape subscription was opened for it, so anything empty below is "
            "an unrecognised symbol rather than a measurement." % coin)
    # Every section is independently fenced: one dead store must degrade its
    # own block into a stated reason, never blank the pane.
    for key, fn in (
        ("ident", lambda: _sides_ident(coin, ctx)),
        ("book", lambda: _sides_book(coin, sig)),
        ("drain", lambda: _sides_drain(coin)),
        ("flow", lambda: _sides_flow(coin)),
        ("whales", lambda: _sides_whales(coin)),
        ("funding", lambda: _sides_funding(coin, ctx, clip)),
        ("you", lambda: _sides_you(addr, coin, ctxs)),
    ):
        try:
            out[key] = fn()
        except Exception as exc:
            out[key] = _fault_fields("/api/sides:" + key, exc, key="err")
    try:
        out["bands"] = _sides_bands(coin, out.get("book") or {})
    except Exception as exc:
        out["bands"] = dict(_fault_fields("/api/sides:bands", exc, key="err"),
                            rows=[])
    try:
        cov = depth_history.coverage()
        out["coverage"] = {
            "depth": (out.get("drain") or {}).get("coverage"),
            "depth_retain_h": cov.get("retain_h"),
            "backfill_note": cov.get("backfill_note"),
            "sample_note": cov.get("sample_note"),
            "whale_age_s": (out.get("whales") or {}).get("snapshot_age_s"),
            "venues_failed": (out.get("ident") or {}).get("venues_failed"),
            "venues_failed_names": (out.get("ident") or {}).get("venues_failed_names"),
        }
    except Exception as exc:
        out["coverage"] = _fault_fields("/api/sides:coverage", exc, key="err")
    return out


def _deepdive_prune(handler):
    """POST /api/deepdive/prune — delete the reports of SCORED verdicts.

    THE ONLY ROUTE ON THIS SERVER THAT UNLINKS A FILE, and it is deliberately
    the most grudging one here:
      * POST, not GET. A GET is what the pane polls and what a stray <img> or a
        prefetch can fire; a delete must never be reachable that way.
      * `confirm` must be the literal string "DELETE". Nothing infers it.
      * `ids` must be a non-empty list. There is no "prune everything eligible"
        over HTTP -- that shape exists only in the CLI, where a human is
        looking at the dry run he just read.
      * The scorer's own precondition still governs: a verdict with no terminal
        outcome is refused inside prune_apply no matter what arrives here.

    The dry run (GET ?prune=dry) is the thing to read first; this endpoint
    returns the same accounting plus what it actually removed.
    """
    try:
        import deepdive_score
        length = int(handler.headers.get("Content-Length") or 0)
        body = json.loads(handler.rfile.read(length).decode() or "{}")
        if body.get("confirm") != "DELETE":
            return {"ok": False, "error": "confirmation required",
                    "error_where": "client",
                    "why": 'POST {"ids": [8, 12], "confirm": "DELETE"}. Read '
                           'GET /api/deepdive?prune=dry first — it names every '
                           'file and byte count without touching anything.'}
        ids = body.get("ids")
        if not isinstance(ids, list) or not ids:
            return {"ok": False, "error": "ids must be a non-empty list",
                    "error_where": "client",
                    "why": "an unscoped delete is not offered over HTTP; name "
                           "the verdict ids you read in the dry run"}
        ids = [int(i) for i in ids]
        res = deepdive_score.prune_apply(
            only_ids=ids, confirm=True,
            include_unreferenced=bool(body.get("include_unreferenced")))
        return dict(res, ok=True)
    except Exception as exc:
        return dict(_fault_fields("/api/deepdive/prune", exc), ok=False)


def api_deepdive(q=None):
    """Deep-dive workups behind the RESEARCH tab.

    GET  /api/deepdive                    current verdicts + queue
    GET  /api/deepdive?gate=NVDA          would a run be allowed, and why not
    GET  /api/deepdive?run=NVDA           queue one (the worker drains it, ~9 min)
    GET  /api/deepdive?reap=preview       DRY RUN: what the reaper would collect
    GET  /api/deepdive?reap=apply&ids=4,6 collect exactly those rows (writes)
    GET  /api/deepdive?reap=apply&all=1   collect every eligible row (writes)
    GET  /api/deepdive?scores=1           the outcome table + its tally
    GET  /api/deepdive?prune=dry          DRY RUN: which report files would go
    POST /api/deepdive/prune              the only route that deletes a report

    Runs never happen inline -- a workup is twelve agents and ~9 minutes.
    Every payload carries validation="UNVALIDATED" and the live scored-outcome
    count, so the pane can never imply a track record that does not exist.
    Degrades to an empty section with a coverage note, like every other pane.

    THE REAP IS NEVER AUTOMATIC ON READ. A plain GET here is a poll the pane
    makes every few seconds; wiring a state change to it would mean the queue
    mutates because someone left a tab open. `reap` must be typed, and
    `reap=preview` -- which writes nothing and reports the exact rows, ages and
    stored sentences the apply would produce -- is the shape the owner should
    read first. `ids` narrows it further, so picking two rows cannot catch a
    third that happened to go stale in between.
    """
    q = q or {}

    def one(key):
        v = q.get(key)
        return (v or [None])[0] if isinstance(v, list) else v

    try:
        sym, gat, reap = one("run"), one("gate"), one("reap")
        if gat:
            return deepdive.gate(gat)
        if sym:
            return deepdive.enqueue(sym)
        if reap:
            mode = str(reap).strip().lower()
            if mode not in ("preview", "dry", "apply"):
                return {"error": f"reap={reap!r} is not a mode",
                        "error_where": "client",
                        "why": "use reap=preview (writes nothing) or reap=apply"}
            ids = one("ids")
            try:
                ids = ({int(p) for p in str(ids).replace(",", " ").split()}
                       if ids else None)
            except ValueError:
                return {"error": f"ids={ids!r} is not a list of queue ids",
                        "error_where": "client",
                        "why": "ids takes queue row ids, e.g. ids=4,6"}
            wants_all = str(one("all") or "").lower() in ("1", "true", "yes")
            if mode == "apply" and ids is None and not wants_all:
                # AN APPLY MUST NAME ITS SCOPE. parse_qs drops blank values, so
                # `ids=` arrives here indistinguishable from no ids at all --
                # an owner who typed a scope and fumbled it would otherwise get
                # an unscoped write. Refusing costs one extra call; guessing
                # costs rows he never chose. The preview rides along so the
                # refusal is also the answer to "which ones, then?".
                preview = deepdive.reap_report(apply=False)
                return {"error": "reap=apply needs an explicit scope",
                        "error_where": "client",
                        "why": "re-issue as reap=apply&ids=" +
                               (",".join(str(i) for i in preview["affected_ids"])
                                or "<none>") +
                               " to collect exactly the rows below, or "
                               "reap=apply&all=1 to take every eligible row",
                        "would_affect": preview["affected_ids"],
                        "preview": preview}
            return deepdive.reap_report(apply=(mode == "apply"), ids=ids)
        # SCORING AND PRUNING OVER GET ARE READ-ONLY, ALWAYS.
        # `scores=1` dumps the outcome table; `prune=dry` reports exactly which
        # report files a prune would remove and how many bytes. Neither writes.
        # The APPLY lives on POST /api/deepdive/prune, because a delete must
        # not be reachable by a URL a browser can be talked into fetching.
        if str(one("scores") or "").lower() in ("1", "true", "yes"):
            import deepdive_score          # imports hyperliquid lazily
            conn = deepdive._conn()
            try:
                rows = [dict(r) for r in conn.execute(
                    "SELECT * FROM deepdive_outcome ORDER BY verdict_id")]
            finally:
                conn.close()
            return {"outcomes": rows, "tally": deepdive.outcome_tally(),
                    "scorer_version": deepdive_score.SCORER_VERSION,
                    "validation": "UNVALIDATED"}
        prune = str(one("prune") or "").strip().lower()
        if prune:
            import deepdive_score
            if prune not in ("dry", "preview"):
                return {"error": f"prune={prune!r} is not a mode",
                        "error_where": "client",
                        "why": "GET only previews. prune=dry writes nothing; "
                               "the delete is POST /api/deepdive/prune with "
                               "{\"ids\": [...], \"confirm\": \"DELETE\"}"}
            ids = one("ids")
            try:
                ids = ([int(p) for p in str(ids).replace(",", " ").split()]
                       if ids else None)
            except ValueError:
                return {"error": f"ids={ids!r} is not a list of verdict ids",
                        "error_where": "client",
                        "why": "ids takes verdict row ids, e.g. ids=8,12"}
            return deepdive_score.prune_plan(only_ids=ids)
        return deepdive.status()
    except Exception as exc:
        return {"verdicts": [], "queue": [], "scored_n": 0,
                "validation": "UNVALIDATED",
                "coverage": f"deep-dive layer unavailable ({type(exc).__name__})"}


# --------------------------------------------------------------------------- #
# LIVENESS
# --------------------------------------------------------------------------- #
# WHY THIS EXISTS. launchd's KeepAlive only sees process death. Twice now the
# process stayed up and healthy while something under it stopped: the deep-dive
# worker was spawned as a backgrounded child of a launchd job and reaped with
# that job's process group, so after every reboot the queue filled and nothing
# drained — discovered by hand, hours late, because nothing was watching.
#
# THIS ROUTE MAKES NO UPSTREAM CALL, deliberately. A health check that fetched
# Hyperliquid would go red when Hyperliquid was down, which is the one thing
# this must never confuse: "we are broken" and "the internet is broken" call
# for different humans at different hours. Everything below is an in-memory
# read, a stat(), or a local sqlite open — so it answers only "is OUR machinery
# still turning", and answers it in milliseconds.
#
# THRESHOLDS ARE SLACK ON PURPOSE, 3-5x each writer's own cadence. A watchdog
# that pages on a single slow save gets muted by its owner within a week, and a
# muted watchdog is worse than none because it also carries the belief that
# something is watching.
# How long after boot a not-yet-connected collector is 'starting', not dead.
HEALTH_BOOT_GRACE_S = 120

HEALTH_STORES = {
    # file                      max_age_s   cadence it is derived from
    "flow_buckets.json":        (15 * 60,   "flow collector saves every 60s"),
    "depth_minute.json":        (30 * 60,   "depth collector saves every 300s"),
    "whale_positions.json":     (60 * 60,   "whale sweep runs every 900s"),
    "oi_history.json":          (150 * 60,  "OI snapshot runs hourly"),
    "buyback_history.json":     (90 * 60,   "buyback refresh runs every 15m"),
}


def _health_age(path):
    try:
        return time.time() - os.path.getmtime(path)
    except OSError:
        return None


def api_health(q=None):
    """Local liveness. `status` is ok / degraded / down; `failures` is prose.

    A consumer should branch on `status` alone. `failures` exists so the alert
    a human actually reads names the broken thing instead of a status code, and
    every entry is a full sentence for exactly that reason.

    Nothing here raises: a check that cannot run reports state "unknown" and is
    counted as neither pass nor fail. Unknown is not ok — but it is also not a
    failure, and collapsing the two is how a watchdog starts lying.
    """
    checks, failures = [], []

    def add(name, state, detail):
        checks.append({"name": name, "state": state, "detail": detail})
        if state == "fail":
            failures.append(detail)

    data_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

    # --- collectors: the two websocket tapes that cannot be backfilled -------
    for label, mod_name in (("depth_collector", "depth_history"),
                            ("flow_collector", "flow_collector")):
        try:
            mod = __import__("datasources." + mod_name, fromlist=[mod_name])
            st = mod.status() or {}
            subbed = st.get("subscribed")
            running = st.get("running")
            stale = st.get("stale")
            n_stale = len(stale) if isinstance(stale, (list, tuple, set)) else (stale or 0)
            # MEASURED 2026-08-27: both websocket collectors need ~18s from
            # process start to hold subscriptions. Without this window every
            # restart — and launchd restarts on every crash — would publish a
            # `down` that resolves itself before a human could read it, which
            # is precisely how a watchdog trains its owner to ignore it.
            if running is False and time.time() - _BOOT_AT < HEALTH_BOOT_GRACE_S:
                add(label, "starting",
                    "%s has not connected yet, %.0fs into a %ds boot window"
                    % (label, time.time() - _BOOT_AT, HEALTH_BOOT_GRACE_S))
            elif running is False:
                add(label, "fail", "%s is not running; its tape is accruing no "
                                   "history and none of it can be backfilled" % label)
            elif subbed in (0, None):
                add(label, "fail", "%s holds no subscriptions" % label)
            else:
                detail = "%d subscribed" % subbed
                mx = st.get("max_coins") or st.get("max_subs")
                if mx:
                    detail += " of %d" % mx
                if n_stale:
                    detail += ", %d stale" % n_stale
                # Saturation is not a failure — it is the documented ceiling —
                # but it silently drops newly charted markets, so it must be
                # visible here rather than only in the pane that hit it.
                state = "warn" if (n_stale or st.get("slots_free") == 0) else "ok"
                add(label, state, detail)
        except Exception as exc:
            add(label, "unknown", "%s status unreadable: %s" % (label, str(exc)[:80]))

    # --- stores: is anything still being written to disk ---------------------
    for fname, (max_age, why) in sorted(HEALTH_STORES.items()):
        path = os.path.join(data_dir, fname)
        if fname == "buyback_history.json":
            stamp = _BUYBACK_FRESH.get("at") or 0
            if stamp:
                age = time.time() - stamp
            elif time.time() - _BOOT_AT < HEALTH_BOOT_GRACE_S + BUYBACK_REFRESH_S:
                add("store:" + fname, "starting",
                    "buyback refresh has not stamped a success yet, %.0fs into boot"
                    % (time.time() - _BOOT_AT))
                continue
            else:
                age = _health_age(path)
        else:
            age = _health_age(path)
        if age is None:
            add("store:" + fname, "unknown",
                "%s does not exist yet — unknown, not stale" % fname)
        elif age > max_age:
            extra = ""
            if fname == "buyback_history.json" and _BUYBACK_FRESH.get("err"):
                extra = "; last fetch failed: %s" % (
                    str(_BUYBACK_FRESH["err"])[:120],)
            add("store:" + fname, "fail",
                "%s has not been written for %.0f min (%s, so anything over "
                "%.0f min means its writer has stopped)%s"
                % (fname, age / 60, why, max_age / 60, extra))
        else:
            add("store:" + fname, "ok", "%s written %.0f min ago" % (fname, age / 60))

    # --- the deep-dive worker: the thing that actually broke ----------------
    try:
        import deepdive
        conn = deepdive._conn()
        try:
            counts = dict(conn.execute(
                "SELECT state, COUNT(*) FROM deepdive_queue GROUP BY state"))
            oldest = conn.execute(
                "SELECT queued_at FROM deepdive_queue WHERE state='queued' "
                "ORDER BY id LIMIT 1").fetchone()
        finally:
            conn.close()
        queued = counts.get("queued", 0)
        oldest_age_h = None
        if oldest and oldest[0]:
            secs = deepdive._age_s(oldest[0])
            oldest_age_h = (secs or 0) / 3600.0
        # Residency is read from the worker's own lock, and the PID in it is
        # checked for life — a lock left by a killed worker names a PID that is
        # gone, which is precisely the reboot case.
        lock = os.path.join(data_dir, "deepdive.lock")
        alive, pid = False, None
        try:
            pid = int(open(lock).read().strip())
            alive = deepdive._pid_alive(pid)
        except (OSError, ValueError):
            pass
        if not alive and queued:
            add("deepdive_worker", "fail",
                "no deep-dive worker is alive (lock names pid %s) and %d job(s) "
                "are queued, the oldest for %.1fh — they will never drain"
                % (pid, queued, oldest_age_h or 0))
        elif not alive:
            add("deepdive_worker", "warn",
                "no deep-dive worker is alive, but the queue is empty so "
                "nothing is currently stranded")
        elif oldest_age_h is not None and oldest_age_h > 6:
            add("deepdive_worker", "fail",
                "worker pid %d is alive but the oldest queued job has waited "
                "%.1fh — it is running without draining" % (pid, oldest_age_h))
        else:
            add("deepdive_worker", "ok",
                "worker pid %d alive, %d queued" % (pid, queued))
    except Exception as exc:
        add("deepdive_worker", "unknown",
            "deep-dive queue unreadable: %s" % str(exc)[:80])

    # --- housekeeping: the atomic-write temp leak ---------------------------
    try:
        tmps = [f for f in os.listdir(data_dir) if f.endswith(".tmp")]
        mb = sum(os.path.getsize(os.path.join(data_dir, f))
                 for f in tmps) / 1e6 if tmps else 0.0
        if mb > 100:
            add("orphaned_tmp", "fail",
                "%d orphaned .tmp files holding %.0f MB in data/ — the atomic "
                "writers leak these on hard kill and nothing sweeps them" %
                (len(tmps), mb))
        elif tmps:
            add("orphaned_tmp", "warn",
                "%d orphaned .tmp file(s), %.1f MB" % (len(tmps), mb))
        else:
            add("orphaned_tmp", "ok", "no orphaned temp files")
    except Exception as exc:
        add("orphaned_tmp", "unknown", str(exc)[:80])

    n_fail = sum(1 for c in checks if c["state"] == "fail")
    n_warn = sum(1 for c in checks if c["state"] == "warn")
    n_unknown = sum(1 for c in checks if c["state"] == "unknown")
    n_start = sum(1 for c in checks if c["state"] == "starting")
    status = ("down" if n_fail else
              "starting" if n_start else
              "degraded" if (n_warn or n_unknown) else "ok")
    return {
        "status": status,
        "failures": failures,
        "checks": checks,
        "counts": {"fail": n_fail, "warn": n_warn, "unknown": n_unknown,
                   "starting": n_start,
                   "ok": sum(1 for c in checks if c["state"] == "ok")},
        "uptime_s": round(time.time() - _BOOT_AT, 1),
        "server_time": time.time(),
        # Stated so a reader never mistakes a green light here for a claim
        # about the market data being correct or the upstreams being up.
        "scope": "local machinery only — no upstream call is made by this "
                 "route, so it cannot and does not report on Hyperliquid, "
                 "Finnhub or any other source being reachable",
    }



def api_des(q):
    """Four-line cited DES for the charted name. Cites immediately; LLM in bg."""
    import des as des_mod
    return des_mod.api_des(q)


ROUTES = {
    "/api/health": api_health,
    "/api/universe": lambda q: api_universe(),
    "/api/events": lambda q: api_events(),
    "/api/candles": api_candles,
    "/api/book": api_book,
    "/api/buyback": lambda q: api_buyback(),
    "/api/research": lambda q: api_research(q),
    "/api/des": lambda q: api_des(q),
    "/api/deepdive": lambda q: api_deepdive(q),
    "/api/funding": lambda q: api_funding(),
    "/api/buyflow": lambda q: api_buyflow(),
    "/api/flow": lambda q: api_flow(q),
    "/api/depth": lambda q: api_depth(q),
    "/api/venues": lambda q: api_venues(),
    "/api/xvenue": lambda q: api_xvenue(q),
    "/api/xprints": lambda q: api_xprints(q),
    "/api/sides": lambda q: api_sides(q),
    "/api/alerts": lambda q: api_alerts(),
    "/api/portfolio": lambda q: api_portfolio(q),
    "/api/stops": lambda q: api_stops(q),
    "/api/screen": lambda q: api_screen(q),
    "/api/funding_x": lambda q: api_funding_x(),
    "/api/movers": lambda q: api_movers(),
    "/api/regime": lambda q: api_regime(),
    "/api/insiders": lambda q: api_insiders(),
    "/api/signals": lambda q: api_signals(),
    "/api/whales": lambda q: api_whales(q),
}

MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript",
        ".css": "text/css", ".svg": "image/svg+xml"}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        payload = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    # --- CROSS-ORIGIN ------------------------------------------------------
    # NO route checked this. 127.0.0.1:9300 is a guessable address, so any web
    # page the owner happened to visit could drive every endpoint here from
    # its own JavaScript — burning add-only collector slots via ?coin=,
    # spraying 10-venue fan-outs via ?addr=, and POSTing to /api/notify, which
    # FIRES TELEGRAM. No credential is involved, so nothing about this server
    # made it hard.
    #
    # WHAT IS REFUSED is a request whose browser-supplied attribution names a
    # DIFFERENT origin. WHAT IS NOT is a request with no attribution at all:
    # curl sends neither header, and so does every piece of the owner's own
    # tooling, and a read-only local terminal that refuses its owner's shell
    # would be a worse tool than the risk it avoids. Only browsers attach
    # these headers, and only a cross-site request gets a foreign value in
    # them — which is exactly the case worth refusing.
    #
    # Origin covers fetch/XHR (including no-cors POSTs). Referer is the
    # fallback that catches the subresource shapes which send no Origin at
    # all — <img src="http://127.0.0.1:9300/api/flow?coin=JUNK"> being the one
    # that permanently consumes a slot.
    def _origin_ok(self):
        """(allowed, offending_origin)."""
        origin = self.headers.get("Origin")
        if not origin:
            origin = self.headers.get("Referer")
        if not origin:
            return True, None            # no browser attribution: allow
        host = self.headers.get("Host") or ""
        try:
            netloc = urllib.parse.urlsplit(origin).netloc
        except ValueError:
            return False, origin
        if not netloc:
            # "null" — a sandboxed iframe or a file:// page. Not this origin.
            return False, origin
        # Compared against the Host the client itself addressed, so this stays
        # correct whether the page was opened as 127.0.0.1:9300 or
        # localhost:9300, and needs no copy of the bind address.
        return (netloc == host), origin

    def _deny_cross_origin(self, origin):
        self._send(403, json.dumps({
            "error": "cross-origin request refused",
            "error_where": "client",
            "origin": str(origin)[:200],
            "why": "this terminal answers same-origin requests and requests "
                   "with no Origin/Referer at all (curl, local tooling). A "
                   "page on another origin may not drive it."}),
            "application/json")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        route = ROUTES.get(parsed.path)
        if route:
            ok, origin = self._origin_ok()
            if not ok:
                self._deny_cross_origin(origin)
                return
            try:
                query = urllib.parse.parse_qs(parsed.query)
                self._send(200, _json(route(query)), "application/json")
            except (BrokenPipeError, ConnectionResetError):
                return          # client hung up mid-response; nothing to tell it
            except Exception as exc:  # degrade, never 500 the UI
                # A raw `str(exc)` here is an internal Python message wearing
                # the clothes of an API field, and several panes paint `.error`
                # straight onto the glass. The reader gets a sentence that says
                # WHOSE fault it is and WHICH route broke; the raw text stays,
                # under its own key, for whoever is debugging.
                try:
                    msg, side = _fault(parsed.path, exc)
                    self._send(200, json.dumps({
                        "error": msg,
                        "error_detail": str(exc),
                        "error_route": parsed.path,
                        "error_kind": type(exc).__name__,
                        # One word to branch on: "upstream" / "unreachable" /
                        # "server". A pane that retries should retry the first
                        # two and page a human on the third.
                        "error_where": side}),
                               "application/json")
                except (BrokenPipeError, ConnectionResetError):
                    pass        # it hung up while we were reporting the error
            return
        # static
        rel = "index.html" if parsed.path in ("/", "") else parsed.path.lstrip("/")
        target = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not target.startswith(STATIC_DIR) or not os.path.isfile(target):
            self._send(404, "not found", "text/plain")
            return
        ext = os.path.splitext(target)[1]
        with open(target, "rb") as fh:
            self._send(200, fh.read(), MIME.get(ext, "application/octet-stream"))

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/deepdive/prune":
            ok, origin = self._origin_ok()
            if not ok:
                self._deny_cross_origin(origin)
                return
            self._send(200, json.dumps(_deepdive_prune(self)),
                       "application/json")
            return
        if path != "/api/notify":
            self._send(404, "not found", "text/plain")
            return
        # The one route on this server with an off-machine side effect.
        ok, origin = self._origin_ok()
        if not ok:
            self._deny_cross_origin(origin)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length).decode() or "{}")
            text = str(body.get("text") or "").strip()[:400]
            if not text:
                self._send(200, json.dumps({"ok": False, "error": "empty"}),
                           "application/json")
                return
            if not _notify_allow():
                self._send(200, json.dumps({"ok": False, "error": "rate-limited"}),
                           "application/json")
                return
            # Fire-and-forget: never block the UI on Telegram delivery.
            threading.Thread(
                target=_notify_best_effort, args=(text,), daemon=True).start()
            self._send(200, json.dumps({"ok": True}), "application/json")
        except Exception as exc:
            self._send(200, json.dumps(
                dict(_fault_fields("/api/notify", exc), ok=False)),
                "application/json")

    def log_message(self, *args):
        pass


_NOTIFY_TIMES = []
_NOTIFY_LOCK = threading.Lock()


def _notify_allow(limit=6, window=60.0):
    """At most `limit` Telegram pushes per `window` seconds."""
    import time
    with _NOTIFY_LOCK:
        now = time.time()
        _NOTIFY_TIMES[:] = [t for t in _NOTIFY_TIMES if now - t < window]
        if len(_NOTIFY_TIMES) >= limit:
            return False
        _NOTIFY_TIMES.append(now)
        return True


def _json(payload):
    """Serialise without ever emitting non-finite tokens.

    `json.dumps` writes float("inf")/nan as the bare words Infinity/NaN.
    Python's own json parser accepts them, so every server-side check passes —
    but JSON.parse rejects them, so the browser silently fails the whole
    response. One `"ratio": Infinity` deep in the buyback payload made the
    entire BURN tab render empty while curl looked perfectly healthy.

    allow_nan=False raises instead of emitting them; on that (rare) path we
    scrub to null and serialise again rather than 500 the request.
    """
    try:
        return json.dumps(payload, allow_nan=False)
    except ValueError:
        return json.dumps(_scrub(payload))


def _scrub(o):
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _scrub(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_scrub(v) for v in o]
    return o


def _notify_best_effort(text):
    delivered = True
    try:
        _send_telegram(text)
    except Exception:
        delivered = False
    try:
        from datasources import alert_log
        kind = ("burn" if text.startswith("\U0001F525")
                else "price" if text.startswith("\U0001F514") else "alert")
        alert_log.record(text, kind=kind, delivered=delivered)
    except Exception:
        pass


def _hermes_bin():
    """Absolute path to the hermes CLI.

    launchd runs this server with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which
    does NOT contain ~/.local/bin — so a bare "hermes" raised FileNotFoundError
    and every alert this terminal produced died on the way out. It looked fine
    from a shell, where PATH is the user's. Resolve explicitly instead.
    """
    global _HERMES_BIN
    if _HERMES_BIN:
        return _HERMES_BIN
    import shutil
    cand = shutil.which("hermes")
    if not cand:
        for path in (os.path.expanduser("~/.local/bin/hermes"),
                     "/usr/local/bin/hermes", "/opt/homebrew/bin/hermes"):
            if os.path.isfile(path) and os.access(path, os.X_OK):
                cand = path
                break
    if not cand:
        raise RuntimeError("hermes CLI not found on PATH or in ~/.local/bin")
    _HERMES_BIN = cand
    return cand


_HERMES_BIN = None


def _send_telegram(text):
    """Raise on failure. Buyback alerts disarm themselves once notify()
    returns, so swallowing a send error consumed the alert and it was never
    seen anywhere — there is no UI surface for these. Price alerts call this
    from a thread and ignore the raise; the alert checker needs the truth."""
    import subprocess
    r = subprocess.run(
        [_hermes_bin(), "send", "-t", "telegram", "-q", text],
        timeout=30, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or b"").decode()[:200] or "telegram send failed")


def _daily_supply_snapshot():
    """Take the buyback supply snapshot on a timer, not on demand.

    The burn RATE is a day-over-day delta, so a missed day is a permanent hole
    in the series. Tying the snapshot to an incoming request would mean no
    browser open == no data point, which is exactly when nobody would notice.
    """
    from datasources import buyback
    while True:
        try:
            buyback.snapshot_supply()
            CACHE.set("buyback", buyback.report(), 20 * 60)
        except Exception:
            pass
        time.sleep(6 * 3600)


def _hourly_oi_snapshot():
    """Record OI on a timer for the same reason as the supply snapshot:
    a delta series with holes in it is worse than no series, and the holes
    would appear exactly when nobody had a browser open."""
    from datasources import oi_history
    while True:
        try:
            data = CACHE.get_or_fetch(
                "universe", 120,
                lambda: {"crypto": hl.asset_ctxs(""), "equity": hl.asset_ctxs("xyz")})
            merged = dict(data.get("crypto") or {})
            merged.update(data.get("equity") or {})
            oi_history.snapshot(merged)
        except Exception:
            pass
        try:
            # Same reasoning as the OI snapshot: predictedFundings is a live
            # endpoint with no archive, so an unrecorded hour is gone.
            from datasources import funding_x
            funding_x.snapshot(_funding_x_map())
        except Exception:
            pass
        try:
            # Same cadence, same cached universe: keep the socket collectors'
            # coin selection following live volume instead of ossifying into
            # the literal list it was born with.
            if _rank_universe():
                _rerank_collectors()
        except Exception:
            pass
        # Slightly under an hour so clock drift cannot skip an hour bucket.
        time.sleep(55 * 60)


# Per-sleeve quotas for the socket collectors. Not one global top-N: crypto is
# a barbell (top 6 = 92.2% of core volume) while xyz is flat (top 12 = 79.8%),
# so a global ranking hands almost every slot to BTC/ETH's neighbourhood and
# covers the venue traded with real size not at all.
#
# Depth costs two l2Book subscriptions per coin against MAX_COINS=36, so its
# quotas are sized to leave ~11 slots free for the on-demand ensure() path.
# Flow costs one `trades` subscription per coin against MAX_SUBS=60 and can
# afford to be wider.
DEPTH_QUOTA = {"crypto": 10, "equity": 12}
FLOW_QUOTA = {"crypto": 14, "equity": 14}


def _universe_ctxs():
    """The merged asset contexts, from the same 120s cache every other reader
    uses. Sharing the key is the point: the collector seed adds ZERO upstream
    requests to a budget the whale sweep already strains."""
    return CACHE.get_or_fetch(
        "universe", 120,
        lambda: {"crypto": hl.asset_ctxs(""), "equity": hl.asset_ctxs("xyz")})


def _rank_universe():
    """Refresh the shared volume ranking. Returns False (loudly) on failure —
    a collector seeded from a stale or missing ranking must be able to say so
    rather than quietly seeding the pinned list and looking complete."""
    from datasources import universe
    try:
        counts = universe.refresh(_universe_ctxs())
        print("universe ranked: %s" % counts, flush=True)
        return True
    except Exception as exc:
        print("universe ranking FAILED (collectors fall back to pinned "
              "lists): %s" % str(exc)[:120], flush=True)
        return False


def _rerank_collectors():
    """Hourly ratchet: subscribe anything that has climbed into the quota.

    ADD-ONLY, deliberately. Unsubscribing a market would destroy accrued
    history that cannot be refetched — Hyperliquid publishes no book archive
    and the trade tape only accrues forward — so a market that falls out of
    the top N keeps its stream until the next restart, when the seed rebuilds
    from scratch. The cost is that the caps fill over days; ensure() returns
    False at the cap and status() reports how many slots are open.
    """
    from datasources import universe
    added = {"depth": [], "flow": []}
    try:
        from datasources import depth_history
        for c in universe.select(DEPTH_QUOTA)["coins"]:
            if depth_history.ensure(c):
                added["depth"].append(c)
    except Exception as exc:
        print("depth re-rank failed: %s" % str(exc)[:100], flush=True)
    try:
        from datasources import flow_collector
        for c in universe.select(FLOW_QUOTA)["coins"]:
            if flow_collector.ensure(c):
                added["flow"].append(c)
    except Exception as exc:
        print("flow re-rank failed: %s" % str(exc)[:100], flush=True)
    if added["depth"] or added["flow"]:
        print("collector re-rank added depth=%s flow=%s"
              % (added["depth"], added["flow"]), flush=True)
    return added


DEPTH_TICK_S = 60          # watchdog cadence; the collector itself is push-driven


def _depth_watchdog():
    """Keep the depth store advancing, on a timer like _hourly_oi_snapshot.

    The collector is a websocket, so in STEADY STATE this thread issues no
    upstream requests at all — it only closes finished minute buckets and
    writes the tiers on their own cadences. Its real job is the degraded case:
    if the socket goes quiet, `snapshot()` takes a paced REST sample per coin
    so a socket outage costs resolution rather than a hole. That matters more
    here than anywhere else in the terminal, because depth is the one signal
    with no backfill — an hour missed is unanswerable forever.

    Deliberately NOT a whales.py-style retry pass: a shed depth fetch leaves a
    lower sample count for that minute, which is self-describing, whereas a
    stale whale snapshot fabricates a wrong diff. Retrying would be pure added
    load for no correctness gain.
    """
    from datasources import depth_history
    backoff_s = 0          # 0 = healthy; grows while the socket stays down
    next_rest = 0.0
    while True:
        time.sleep(DEPTH_TICK_S)
        try:
            depth_history.flush()          # close finished minute buckets
            if not depth_history.status().get("ws_stale"):
                backoff_s = 0
                continue
            now = time.monotonic()
            if now < next_rest:
                continue
            # One paced pass: 2 calls per coin at ~0.15s spacing, single
            # threaded, one request in flight. At the 9 seeded coins that is
            # 18 calls over ~3s — never a fan-out, because the burst SHAPE is
            # what gets shed, not the volume.
            depth_history.snapshot()
            backoff_s = 60 if not backoff_s else min(backoff_s * 2, 900)
            next_rest = now + backoff_s
        except Exception:
            pass


WHALE_SWEEP_INTERVAL_S = 900   # 15 min; a full sweep measures ~17s at 5 workers


def _whale_sweep():
    """Diff whale wallets on a timer, like _hourly_oi_snapshot: an event
    stream with holes in it is worse than none, and the holes would appear
    exactly when nobody had a browser open. First sweep runs at boot so
    warming ends ~15 min after start, not on first tab click."""
    from datasources import whales
    while True:
        try:
            whales.sweep(notify=_notify_best_effort)
        except Exception as exc:
            print("whale sweep failed: %s" % str(exc)[:120], flush=True)
        time.sleep(WHALE_SWEEP_INTERVAL_S)


def api_whales(q=None):
    """Whale board: roster coverage, per-coin positioning, event feed.
    With ?coin=X: everything known about whale activity in that one coin
    (positions with entries, resting orders, timestamped events) for the
    chart overlay. Reads the sweep thread's stores; never fetches upstream
    on-request."""
    from datasources import whales
    coin = ((q or {}).get("coin") or [""])[0]
    if coin:
        return CACHE.get_or_fetch(
            "whale_coin:" + coin, 60, lambda: whales.coin_detail(coin))
    return whales.payload()


VENUES_TTL = 300
# A snapshot that lost venues to rate-limiting must not sit in the cache for
# a full five minutes: it would keep the SIDES pane's amber "N VENUE FETCH
# FAILED" warning up long after a retry would have cleared it, and the
# cross-listing verdicts computed from a partial index would stay wrong.
# Measured: an on-demand warm fired during a busy window came back with 5 of
# 11 venues shed. Report it, and retry it a minute later.
VENUES_FAIL_TTL = 60

# The 2026-08-15 landscape survey (external on-chain perp venues) lives in a
# static JSON the research pass wrote. It is point-in-time SURVEY data, not
# live — the client must date it and must never mix it into live totals — so
# serving it is a disk read behind a long cache and must NEVER trigger an
# external fetch at request time.
LANDSCAPE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "venue_landscape.json")


def _venue_landscape():
    """Survey JSON verbatim from disk; None when absent/unreadable.

    None makes the client omit the LANDSCAPE section entirely — better no
    section than an empty table that reads as "no external market exists"."""
    def load():
        with open(LANDSCAPE_PATH, "r") as fh:
            return json.load(fh)
    try:
        # 1h TTL only bounds the disk re-read; the file changes only when a
        # new survey is written (rare, deliberate).
        return CACHE.get_or_fetch("venue_landscape", 3600, load)
    except Exception:
        return None


def api_venues():
    """Every reachable on-chain perp venue: HL core, its HIP-3 DEXs, Lighter.

    Five seconds of upstream work behind a 5-minute cache — this is a
    market-structure read, not a tick.
    """
    from datasources import venues
    # SINGLE-FLIGHT, like every other cached route. This was the ONE route
    # doing get-then-build by hand, so an expired entry let every concurrent
    # request thread run the 11-call fan-out at once — the exact burst shape
    # cache.py's per-key locks were added for, and the client's 300s poll sits
    # exactly on the 300s TTL while the 12s SIDES poll warms the same key.
    # get_or_fetch also serves the stale snapshot when a rebuild raises, which
    # is strictly better than the empty payload this used to return.
    built = {}

    def build():
        snap = venues.snapshot()
        # Signals "THIS call did the build", so the shorter failure TTL is
        # applied by the builder only and never by a request that was merely
        # served from cache — re-stamping on every read would push the expiry
        # forward forever and freeze the snapshot in place.
        built["failed"] = (snap.get("totals") or {}).get("venues_failed") or 0
        return snap

    # A failed snapshot is not cached (nothing to cache), so without this an
    # outage is retried by every poll with no backoff at all. The marker is a
    # SEPARATE key on purpose: writing an error payload under "venues" would
    # poison CACHE.get("venues"), which _sides_ident and the cross-venue index
    # read directly and expect to be a real snapshot or nothing.
    if CACHE.get("venues") is None:
        cool = CACHE.get("venues_fail")
        if cool is not None:
            return dict(cool, venues=[], landscape=_venue_landscape())
    try:
        snap = CACHE.get_or_fetch("venues", VENUES_TTL, build)
    except Exception as exc:
        fault = _fault_fields("/api/venues", exc)
        CACHE.set("venues_fail", dict(fault, retry_after_s=VENUES_FAIL_TTL),
                  VENUES_FAIL_TTL)
        return dict(fault, venues=[], retry_after_s=VENUES_FAIL_TTL,
                    landscape=_venue_landscape())
    if built.get("failed"):
        CACHE.set("venues", snap, VENUES_FAIL_TTL)
    # `listings` is the base-ticker index /api/sides uses to answer "does this
    # instrument have a second book". ~880 rows, useless here, and it would
    # triple this payload — the cache keeps it, the wire does not.
    out = {k: v for k, v in snap.items() if k != "listings"}
    # Survey data rides alongside, never inside: a separate key so the live
    # totals above stay purely live. Disk-only read, see _venue_landscape.
    out["landscape"] = _venue_landscape()
    return out


# The compare is 4-8 paced upstream calls for ONE coin; a minute of cache
# means flipping between two dossiers costs one fan-out each, not one per
# repaint. Books age in seconds, so anything much longer would ship a
# photograph wearing a live face — the payload carries its own `at` and the
# client dates it.
def _dated(out, ttl_s, moves):
    """Attach a SERVER-MEASURED age to a cached cross-venue payload.

    Both cross-venue endpoints already carried `at` — the moment the payload
    was BUILT, stamped inside the datasource — and the client still could not
    date them, because the only age it could compute from `at` alone is
    `Date.now() - at`, which subtracts a server clock from a browser clock and
    calls the skew an age. sdNow()'s comment one file over forbids exactly
    that, which is why the DISLOC column could be dated (funding_x ships
    `age_s`) and these two could not. So the subtraction is done here, on one
    clock, and shipped as a number.

    `age_s` can legitimately exceed `ttl_s`: get_or_fetch serves the stale
    entry when a rebuild raises, and an age past the TTL is precisely the fact
    a reader cannot afford to guess at.
    """
    at = out.get("at") if isinstance(out, dict) else None
    if not at:
        return out
    return {**out, "age_s": round(time.time() - at, 1), "ttl_s": ttl_s,
            "age_note": "built once and cached for up to %ds; %s, so an age "
                        "must travel with every number quoted from it"
                        % (ttl_s, moves)}


XVENUE_TTL = 60


# How long a caller should wait before asking again while the venue snapshot
# warms. Stated as a NUMBER on the payload rather than implied by the words
# "retry shortly", because a consumer cannot act on prose: the client cached
# this exact payload for its full 120s success TTL and showed a cold-start
# state for two minutes after every restart.
VENUE_WARM_RETRY_S = 5


def _venue_warming(coin, impact):
    """The ONE shape both cross-venue endpoints return before the snapshot
    exists — warm it off the request path, and say precisely what is not
    measured yet.

    MEASURED 2026-08-15: api_xprints returned {coin, warming, note} with NO
    `rows` key at all. The client had a `warming` branch for the xvenue twin
    and none for this one, so it fell through to a PER-VENUE line reading
    "no tape row returned for this venue — not measured, not empty", printed
    once per venue, while the block header still showed a fresh tape age. A
    transient, global, whole-endpoint state was rendered as a per-venue
    coverage property, and the server's own "retry shortly" was discarded.

    So the shape is fixed here, identically for both endpoints:
      rows          present and NULL — `[]` would mean measured-and-empty,
                    which is the exact confusion this codebase refuses
      measured      False, so a consumer never has to infer it from a null
      retry_after_s a number a refresh gate can honour
      note          what is missing, in the endpoint's own terms
    A consumer written against one endpoint now renders the other.
    """
    _warm_venues()
    return {"coin": coin, "warming": True,
            "rows": None,
            "measured": False,
            "retry_after_s": VENUE_WARM_RETRY_S,
            "note": "venue snapshot not warm yet — %s (warming now; retry in "
                    "~%ds). Nothing here is a measurement of zero."
                    % (impact, VENUE_WARM_RETRY_S)}


def api_xvenue(q):
    """Per-coin cross-venue comparison: the same instrument on every venue
    that lists it — mid, spread, band depth, volume, OI, funding — assembled
    on demand from the venues snapshot plus a bounded, paced book fan-out.
    Read-only decision support; nothing here routes anywhere."""
    from datasources import xvenue
    coin = (q.get("coin") or ["BTC"])[0].strip()
    if not coin:
        return {"error": "coin required"}
    snap = CACHE.get("venues")
    if snap is None:
        # Same doctrine as _sides_ident: warm off the request path and SAY
        # the comparison is unknown-not-absent, rather than blocking this
        # request ~5s on eleven upstream calls.
        return _venue_warming(
            coin, "cross-venue listings are unknown, not absent")
    return _dated(
        CACHE.get_or_fetch("xvenue:" + coin, XVENUE_TTL,
                           lambda: xvenue.compare(coin, snap)),
        XVENUE_TTL, "mids, spreads and band depth all move continuously")


# Prints age faster than books but the DISTRIBUTION of print sizes does not
# — it is a shape, not a tick, and the served samples span 8s to 5 hours
# depending on the venue. A longer TTL than the book compare's also keeps the
# two fan-outs from ever landing on the same second.
XPRINTS_TTL = 120


def api_xprints(q):
    """Per-coin cross-venue PRINT-SIZE distribution: how big the trades are
    in this instrument on each venue that lists it, each row carrying the
    finest tail quantile its own sample size can support.

    Deliberately separate from /api/xvenue: that endpoint already spends up
    to 8 upstream calls on books, and this spends one more per venue. Read
    the caveats it returns — the forward-range lift after a large print
    measured 1.01x once hour-of-day was controlled for, so this describes
    where size is trading, it does not predict anything."""
    from datasources import xprints
    coin = (q.get("coin") or ["BTC"])[0].strip()
    if not coin:
        return {"error": "coin required"}
    snap = CACHE.get("venues")
    if snap is None:
        return _venue_warming(
            coin, "no venue's print tape has been sampled yet, so print "
                  "sizes here are UNMEASURED, not small and not absent")
    return _dated(
        CACHE.get_or_fetch("xprints:" + coin, XPRINTS_TTL,
                           lambda: xprints.prints(coin, snap)),
        XPRINTS_TTL, "the print tape advances continuously")


def api_screen(q):
    """Cross-sectional screen. `preset=<name>` or `f=field:op:value` (repeatable)."""
    from datasources import oi_history, screener
    data = CACHE.get_or_fetch(
        "universe", 120,
        lambda: {"crypto": hl.asset_ctxs(""), "equity": hl.asset_ctxs("xyz")})
    preset = (q.get("preset") or [""])[0]
    sort = (q.get("sort") or [""])[0]
    desc = (q.get("desc") or ["1"])[0] != "0"
    filters = []
    if preset:
        p = screener.PRESETS.get(preset)
        if not p:
            return {"error": "unknown preset", "presets": list(screener.PRESETS)}
        # COPY. `p["filters"]` is the list living inside screener.PRESETS;
        # the `f=` loop below appends to `filters`, so sharing the object let
        # one request with ?preset=X&f=... permanently add that filter to the
        # preset for every later request on this process.
        filters = list(p["filters"])
        sort = sort or p["sort"]
        desc = p["desc"] if (q.get("desc") is None) else desc
    # `f=field:op:value`, repeatable. A triple that does not split into three
    # is not a filter at all and used to vanish without a word; malformed ops
    # and fields were worse (see screener.validate_filters). Everything that
    # does not survive validation is named in the response.
    rejected = []
    for raw in (q.get("f") or []):
        parts = raw.split(":")
        if len(parts) == 3:
            filters.append({"field": parts[0], "op": parts[1],
                            "value": parts[2]})
        else:
            rejected.append({"raw": raw,
                             "reason": "f=%r is not field:op:value (split "
                                       "into %d parts) — NOT applied"
                                       % (raw, len(parts))})
    filters, bad = screener.validate_filters(filters)
    rejected.extend(bad)
    try:
        fx = _funding_x_map()
    except Exception:
        fx = None
    # Depth is read from the collector's IN-MEMORY state, which only exists in
    # the process running the websocket. That is why this is fetched here and
    # not by the screener itself: screener.py must stay importable from a
    # scratch process (every research script does) without silently returning
    # a depth-less universe that looks like "no book is thinning anywhere".
    try:
        from datasources import depth_history
        depth = depth_history.metrics()
    except Exception:
        depth = None
    res = screener.screen(data, filters, sort or "volume", desc,
                          fx=fx, depth=depth)
    rows = res["rows"]
    cov = oi_history.coverage()
    try:
        dcov = depth_history.coverage()
    except Exception:
        dcov = None
    out = {
        # `n` stays len(rows) for compatibility with what the client reads
        # today, but it is a PAGE SIZE and the page is capped — so the two
        # numbers it was being mistaken for now travel beside it.
        "rows": rows, "n": len(rows), "preset": preset or None,
        "n_shown": res["n_shown"], "n_matched": res["n_matched"],
        "n_universe": res["n_universe"], "limit": res["limit"],
        "count_note": "%d of %d matching rows shown (page cap %d); %d markets "
                      "in the screened universe"
                      % (res["n_shown"], res["n_matched"], res["limit"],
                         res["n_universe"]),
        # ECHOED FILTERS ARE APPLIED FILTERS. Anything dropped is listed
        # separately with its reason, so the echo can never be read as
        # "this screen ran" for a filter that did not.
        "filters": filters, "filters_rejected": rejected,
        "sort": sort or "volume", "desc": desc,
        "fields": screener.FIELDS,
        "presets": {k: {"label": v["label"], "why": v["why"]}
                    for k, v in screener.PRESETS.items()},
        # Which universe a depth screen actually screened. The collector
        # covers a handful of coins, not the 340-row universe, so an empty
        # depth result means "not subscribed" far more often than it means
        # "nothing is thinning" — the pane has to be able to say which.
        "depth_coverage": dcov,
        "depth_coins": sorted((depth or {}).keys()),
        # Any screen using OI change is only as good as the store behind it,
        # so the pane can warn instead of showing a silently empty result.
        "oi_coverage": cov,
        "oi_ready": cov.get("hours", 0) >= 24,
    }
    if rejected:
        out["request_note"] = "; ".join(
            r.get("reason", "filter dropped") for r in rejected)
    if res.get("sort_unknown"):
        out["request_note"] = "; ".join(filter(None, [
            out.get("request_note"),
            "sort=%r is not a screener field — every row sorts as MISSING and "
            "the order below is the unsorted order" % (sort or "volume")]))
    return out


def _prewarm():
    """Warm slow caches off the request path."""
    # api_venues LAST. It is eleven sequential HL calls, and putting it early
    # made it compete with the universe ranking the depth and flow collectors
    # seed themselves from — measured, that burst drew a 429 and both
    # collectors fell back to their pinned lists. The SIDES pane does not
    # need it here anyway: _warm_venues() fetches it off the first request
    # that finds the cache cold, which is one 12s poll behind at worst.
    for fn in (api_universe, api_events, api_insiders, api_buyback, api_venues):
        try:
            fn()
        except Exception:
            pass
    # Insider scanning is asynchronous; wait briefly so the first ranking is
    # not built insider-blind, then build signals.
    _INSIDERS_WARMING.wait(timeout=180)
    try:
        api_signals()
    except Exception:
        pass


def main():
    import argparse
    ap = argparse.ArgumentParser(description="HL market terminal")
    ap.add_argument("--port", type=int, default=9300)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    threading.Thread(target=_prewarm, daemon=True).start()

    threading.Thread(target=_daily_supply_snapshot, daemon=True).start()
    threading.Thread(target=_hourly_oi_snapshot, daemon=True).start()
    threading.Thread(target=_whale_sweep, daemon=True,
                     name="whale-sweep").start()
    # Collect trades continuously so CVD/delta have history the moment a coin
    # is opened, instead of accumulating only from the click.
    # Rank the universe BEFORE the collectors start, so their first seed is
    # volume-ranked rather than a literal list. If this fails the collectors
    # still start on their pinned lists and say so in status().
    ranked_ok = _rank_universe()
    try:
        from datasources import flow_collector, universe
        try:
            from datasources.buyback import PROGRAMS
            pinned = list(dict.fromkeys(CRYPTO_WATCH + sorted(PROGRAMS)))
        except Exception:
            pinned = list(CRYPTO_WATCH)
        # PROGRAMS stays PINNED rather than seeding the universe: the BURN tab
        # reads those tapes and each already holds 48h of buckets, so dropping
        # them to make room would be a visible regression. What changed is
        # that they are no longer the whole universe.
        sel = universe.select(FLOW_QUOTA, pinned=pinned,
                              keep=flow_collector.collected(),
                              cap=flow_collector.MAX_SUBS)
        flow_collector.start(sel["coins"])
        print("flow seed: %d coins (%d crypto, %d xyz)%s"
              % (sel["n"],
                 sum(1 for c in sel["coins"] if ":" not in c),
                 sum(1 for c in sel["coins"] if ":" in c),
                 "" if ranked_ok else "  [UNRANKED — pinned list only]"),
              flush=True)
        if sel["dropped"]:
            print("flow seed dropped at cap %d: %s"
                  % (flow_collector.MAX_SUBS, sel["dropped"]), flush=True)
    except Exception as exc:
        print("flow collector not started:", exc)
    # Depth is the one input here that was never persisted: the book was
    # fetched, drawn and thrown away. It also cannot be backfilled, so every
    # hour the collector is not running is permanently unanswerable. Its own
    # socket, not the flow collector's — coupling them would put the working
    # CVD store at risk of a depth-side bug.
    try:
        from datasources import depth_history, universe
        # `keep` matters more here than anywhere: a coin already in the store
        # holds hours of book that no request can refetch, so it is kept ahead
        # of the cap rather than silently unsubscribed on restart.
        sel = universe.select(DEPTH_QUOTA, pinned=CRYPTO_WATCH,
                              keep=depth_history.collected(),
                              cap=depth_history.MAX_COINS)
        depth_history.start(sel["coins"])
        print("depth seed: %d coins (%d crypto, %d xyz), %d l2Book subs, "
              "%d slots free%s"
              % (sel["n"],
                 sum(1 for c in sel["coins"] if ":" not in c),
                 sum(1 for c in sel["coins"] if ":" in c),
                 sel["n"] * 2, depth_history.MAX_COINS - sel["n"],
                 "" if ranked_ok else "  [UNRANKED — pinned list only]"),
              flush=True)
        if sel["dropped"]:
            print("depth seed dropped at cap %d: %s"
                  % (depth_history.MAX_COINS, sel["dropped"]), flush=True)
    except Exception as exc:
        print("depth collector not started:", exc)
    threading.Thread(target=_depth_watchdog, daemon=True,
                     name="depth-watchdog").start()
    threading.Thread(target=_buyback_loop, daemon=True,
                     name="buyback-refresh").start()

    def _warm_slow_caches():
        """Pay the cold-cache cost at boot, not on the first user request.

        After a restart the first hit on events took ~30s and regime ~14s —
        cache misses on external sources. The data is no fresher for having
        been fetched lazily; only the person waiting changes."""
        # universe/events are _prewarm's job — warming them here too made
        # every boot fetch them twice ("warmed universe" logged 2x).
        for name, fn in (("regime", api_regime), ("research", api_research)):
            try:
                t0 = time.time()
                fn()
                print("warmed %s in %.1fs" % (name, time.time() - t0), flush=True)
            except Exception as exc:
                print("warm %s failed: %s" % (name, str(exc)[:80]), flush=True)

    threading.Thread(target=_warm_slow_caches, daemon=True,
                     name="cache-warm").start()
    class QuietServer(ThreadingHTTPServer):
        """One log line for client disconnects instead of a 10-line traceback.

        Every traceback in weeks of logs was BrokenPipe/ConnectionReset from a
        curl timeout or a browser navigating away — routine, but each one
        printed a full stack twice and buried anything worth reading."""

        def handle_error(self, request, client_address):
            import sys as _sys
            exc = _sys.exc_info()[1]
            if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
                print("client disconnect: %s" % (client_address,), flush=True)
                return
            super().handle_error(request, client_address)

    srv = QuietServer((args.host, args.port), Handler)
    print("terminal -> http://{}:{}/".format(args.host, args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
