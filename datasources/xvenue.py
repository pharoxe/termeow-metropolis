"""Per-coin cross-venue comparison — one instrument, every venue listing it.

WHY THIS EXISTS: the venue snapshot answers "how big is each venue"; the
cross-listing index answers "does this ticker trade anywhere else". Neither
answers the question the owner actually asks when charting one name: what
does the OTHER book look like — its spread, its depth, its funding — right
now. This module assembles that, on demand, for ONE coin at a time. It is a
comparison view for a strictly read-only terminal: no routing, no execution,
no order path.

WHAT IT FETCHES (bounded fan-out, never a standing sweep):
  - HL-family listings: l2Book at nSigFigs 4+3, stitched exactly the way
    depth_history.snapshot() does it — the band math is IMPORTED from
    depth_history, not re-derived, so ±25/±50bps here means the same thing
    it means everywhere else in this terminal. l2Book works for HIP-3
    markets (measured live: hyna:BTC returned a real multi-level book).
  - Aster: /fapi/v1/depth at limit=1000, the endpoint's hard cap
    (limit=5000 -> 400 -1130). The response carries its OWN exchange
    timestamps (E and T), so unlike the HL REST path below it needs no
    coherence heuristic — it is one book at one instant, as reported.
    Measured reach at that cap: 217-245bps on BTC, 254 on ETH, 1665 on
    SOL, 7842 on 1000PEPE. So +/-25 and +/-50 always resolve on Aster and
    only +/-250 truncates, and only on BTC.
  - Extended: /info/markets/{m}/orderbook, which is served WHOLE — no
    level cap was reachable on any market tested (BTC-USD 3,486 bids /
    3,537 asks, reaching 5,887bps from mid; ETH 8,316bps; SOL and HYPE
    ~9,999bps). Every band this terminal renders resolves there. Its one
    weakness relative to Aster: the payload carries no timestamp of its
    own, so the receive time is stamped locally and labelled as local.
  - Lighter: the keyless REST book (orderBookOrders) is order-level and
    CAPPED at 250 orders/side — measured 2026-08-15, that reaches only
    ~15-28bps from mid on BTC/ETH, so wide bands truncate. A band past the
    served reach is reported as UNRESOLVED with the cap named, never as
    zero depth. OI comes from orderBookDetails (open_interest is in BASE
    units — multiplied by mark_price for USD) and funding from
    funding-rates, whose rates are 8h-normalised (measured: the endpoint's
    'hyperliquid' comparator shows 0.0001 for BTC against HL's native
    hourly 0.0000125 — exactly 8x), so Lighter funding is divided by 8 to
    match the hourly convention every HL-family row already uses.

TWO VENUES HERE ARE CLOSED SOMETIMES. Extended runs CONTINUOUS,
NO_OVERNIGHT and WEEKDAYS schedules and had 51 markets flagged off-hours
when this was built. An equity perp outside its cash session quotes a wide,
thin book on purpose. That is a MEASURED state of the market, and this
module labels it as such: an off-hours row says so on its face, so a
2,000bps spread is not read as a broken venue and, just as importantly, is
not allowed to win or lose a "cheapest venue" ranking on the strength of a
session it is not in.

MATCHING: listings come from cross_venue.classify — grouped by base ticker,
price used only to REFUTE. Refuted same-ticker pairs (core:STX vs para:STX)
are carried in `split`, labelled, never compared. There is deliberately no
alias table (see cross_venue's doctrine), so Lighter's kPEPE vs core
1000PEPE is NOT matched and the response's `note` admits that blind spot.
Aster and Extended reach the index through the base ticker each venue
PUBLISHES for itself (exchangeInfo.baseAsset, assetName), which is the
venue naming its own underlying rather than this codebase guessing — and
which is why Aster's three separate BTC books (BTCUSDT, BTCUSD1, BTCU)
stay three rows here instead of being silently merged into one.

RANKING HONESTY: a "cheapest venue" is claimed only when one venue wins
BOTH the spread and the ±25bps min-side depth among venues whose books were
actually measured, with at least two qualifying. Anything else returns the
reason no ranking was made — a ranking fabricated over missing books would
be exactly the confident-absence failure this codebase guards against.
"""

import json
import time
import urllib.request

from datasources import cross_venue, depth_history, hl
from datasources.venues import PACE_S

LIGHTER_BASE = "https://mainnet.zklighter.elliot.ai/api/v1"
LIGHTER_UA = {"User-Agent": "hl-terminal research", "Accept": "application/json"}
TIMEOUT = 12

# Bands shipped to the client. Indices into depth_history.GRID — reusing that
# grid is the point: a ±25bps figure here must be comparable with the depth
# store's ±25bps, not a near-miss convention of its own.
BANDS = [25, 50]
REF_BPS = depth_history.REF_BPS          # 25 — the ranking band

# Fan-out cap. classify already caps `others` at 3, so home + 3 is the
# organic maximum (2 REST calls per HL venue, 1 per Aster or Extended row,
# 1-2 per Lighter row); this is the defensive ceiling should that ever
# change. Measured worst case with five venues in the index: 8 upstream
# calls, ~5s wall at PACE_S, against a 60s cache.
MAX_BOOKS = 5

# Which fetcher handles a venue, keyed by the `chain` its snapshot record
# carries. Anything absent here gets an explicit "no keyless book fetcher"
# note rather than an empty book — the reader must be able to tell a venue
# nobody wrote a fetcher for from a venue whose book came back empty.
_BOOK_BY_CHAIN = ("hyperliquid", "zklighter", "bnb", "starknet")

# Per-coin endpoint caps, measured. These live HERE rather than in the venue
# modules for the same reason _book_lighter does: those modules answer "how
# big is this venue" once every few minutes, this one answers "what does
# this ONE book look like right now", and the two use different endpoints
# with different limits and different failure modes.
ASTER_DEPTH_LIMIT = 1000     # hard cap; limit=5000 -> 400 -1130
ASTER_TAPE_LIMIT = 1000      # hard cap; limit=1500 -> 400 -1130
EXTENDED_TAPE_LIMIT = 50     # HARD cap, and the limit parameter is accepted
                             # and ignored above it (tested 50/100/500/1000)

# Lighter all-market payloads (orderBookDetails ~315KB, funding-rates ~60KB)
# are cached briefly so comparing two coins back-to-back costs one fetch of
# each, not two. Lighter's unauthenticated REST limit is 60 req/min/IP
# (apidocs.lighter.xyz/docs/rate-limits); a compare spends at most 3
# requests against it.
_LIGHTER_TTL_S = 60
_LCACHE = {}                             # path -> (expiry, payload)


def _lighter_get(path, ttl=_LIGHTER_TTL_S):
    now = time.time()
    ent = _LCACHE.get(path)
    if ent and ent[0] > now:
        return ent[1]
    req = urllib.request.Request(LIGHTER_BASE + path, headers=LIGHTER_UA)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read())
    _LCACHE[path] = (now + ttl, d)
    return d


def _bands_from_view(view, cap_note=None):
    """Stitched band vector -> the shipped bands, each with its own reason
    when unresolved. depth_history._view already refuses a band finer than
    the tick or past the served reach (None, never zero) — this only names
    WHY, because '—' in a table reads as 'nothing there' unless it says
    'not measured' out loud."""
    out = []
    for g in BANDS:
        i = depth_history.GRID.index(g)
        bid = view["b"][i] if i < len(view["b"]) else None
        ask = view["a"][i] if i < len(view["a"]) else None
        why = None
        if bid is None or ask is None:
            tick = view.get("tick_bps")
            reach = view.get("reach_bps")
            if tick is not None and tick > g:
                why = ("tick %.1fbps is coarser than ±%dbps — "
                       "band not resolvable" % (tick, g))
            elif reach is not None and reach < g:
                why = "served book reaches only %.1fbps from mid" % reach
                if cap_note:
                    why += " — " + cap_note
            else:
                why = "band did not resolve"
        out.append({"bps": g, "bid_usd": bid, "ask_usd": ask,
                    "unresolved": why})
    return out


def _book_hl(sym):
    """One HL-family book, both resolutions, stitched. Mirrors
    depth_history.snapshot()'s REST path including its coherence rule: REST
    cannot promise the two books are the same instant, so a pair more than
    one push interval (6s) apart drops the coarse view rather than stitching
    two different moments into one 'book'."""
    views = []
    err = None
    for sig in (depth_history.SIG_NEAR, depth_history.SIG_WIDE):
        try:
            v = depth_history._view(hl.l2_book(sym, sig))
            if v is not None:
                views.append(v)
        except Exception as exc:
            err = str(exc)[:120]
        time.sleep(PACE_S)
    if not views:
        return {"err": err or "book empty or unusable at both resolutions"}
    near, wide = depth_history._rank(views)
    if near and wide and abs(near["t"] - wide["t"]) > 6000:
        wide = None
    s = depth_history._stitch(near, wide)
    if s is None:
        return {"err": "could not stitch the two resolutions"}
    return {"mid": s["mid"], "spread_bps": round(s["spread_bps"], 3),
            "tick_bps": round(s["tick_bps"], 3),
            "reach_bps": round(s["reach_bps"], 1),
            "at_ms": s["t"], "src": "l2Book nSigFigs 4+3, stitched",
            "bands": _bands_from_view(s)}


def _book_aster(sym):
    """One Aster book. Self-timestamped by the venue, so no coherence rule.

    depth_history._view is fed directly: Aster serves price LEVELS already
    aggregated, so unlike Lighter there is nothing to collapse first. `n` is
    set to 1 per level because the endpoint publishes no resting-order count
    — that is a MISSING count, not a count of one, and it is never surfaced
    as an order count anywhere downstream (only ±25bps notional is, and that
    does not use `n`).
    """
    from datasources import aster
    # aster.usym, not raw interpolation: three live TRADING markets have CJK
    # names and the concatenation raises a codec error, which reached this
    # response as book:{err:"'ascii' codec can't encode..."} for every one of
    # them. Measured 2026-08-15 on 龙虾USDT.
    d = aster._get("/fapi/v1/depth?symbol=%s&limit=%d"
                   % (aster.usym(sym), ASTER_DEPTH_LIMIT), retries=0)

    def side(rows):
        out = []
        for r in rows or []:
            try:
                # `n` is 1 because the endpoint publishes no resting-order
                # count. That is a MISSING count, not a count of one, and it
                # is never surfaced as an order count downstream — only the
                # ±25bps notional is, and that does not read `n`.
                out.append({"px": float(r[0]), "sz": float(r[1]), "n": 1})
            except (TypeError, ValueError, IndexError):
                continue
        return out

    bids, asks = side(d.get("bids")), side(d.get("asks"))
    if len(bids) < 2 or not asks:
        return {"err": "Aster depth returned too few levels (%d bids / %d "
                       "asks)" % (len(bids), len(asks))}
    capped = len(bids) >= ASTER_DEPTH_LIMIT or len(asks) >= ASTER_DEPTH_LIMIT
    # The venue stamps its own book (E = event time, T = transaction time),
    # so this is one book at one instant as the venue reports it.
    v = depth_history._view({"levels": [bids, asks],
                             "time": int(d.get("T") or d.get("E")
                                         or time.time() * 1000)})
    if v is None:
        return {"err": "Aster depth failed the band view (crossed or "
                       "degenerate levels)"}
    cap_note = ("REST cap of %d levels/side reached — deeper resting orders "
                "exist but were not served" % ASTER_DEPTH_LIMIT
                if capped else None)
    return {"mid": v["mid"], "spread_bps": round(v["spread_bps"], 3),
            "tick_bps": round(v["tick_bps"], 3),
            "reach_bps": round(v["reach_bps"], 1),
            "at_ms": v["t"],
            "src": "/fapi/v1/depth limit=%d (venue-timestamped)"
                   % ASTER_DEPTH_LIMIT,
            "cap_note": cap_note,
            "bands": _bands_from_view(v, cap_note=cap_note)}


def _book_extended(native, off_hours=False):
    """One Extended book, fetched by the venue's NATIVE symbol.

    The index carries `extended:BTC` so the cross-listing grouping works;
    the orderbook endpoint only answers to `BTC-USD`. Passing the indexed
    symbol here returns a 404 that would surface as a transport failure and
    read as "Extended is down" when nothing is wrong.

    An off-hours market is fetched anyway and its book is reported as it is
    — a closed equity perp genuinely quotes wide — but the row is stamped
    so the width is attributed to the session and not to the venue.
    """
    from datasources import extended
    if ":" in str(native):
        # The index key reached this function instead of the fetch key —
        # only possible against a cached snapshot built by an older adapter
        # that prefixed its symbols. Fetching it would 404 and the 404 would
        # read as "Extended is down", so the real reason is named instead.
        return {"err": "cannot fetch %r — that is a cross-listing index key, "
                       "not this venue's native symbol; the cached venue "
                       "snapshot predates the sym_native field and will "
                       "carry it on the next refresh" % native}
    d = (extended._get("/info/markets/%s/orderbook" % native) or {}).get("data") or {}

    def side(rows):
        out = []
        for r in rows or []:
            try:
                out.append({"px": float(r["price"]), "sz": float(r["qty"]),
                            "n": 1})
            except (KeyError, TypeError, ValueError):
                continue
        return out

    bids, asks = side(d.get("bid")), side(d.get("ask"))
    if len(bids) < 2 or not asks:
        return {"err": "Extended orderbook returned too few levels "
                       "(%d bids / %d asks)%s"
                       % (len(bids), len(asks),
                          " — this market is OFF HOURS, so an empty book is "
                          "its scheduled state, not a fault" if off_hours
                          else "")}
    # No exchange timestamp on this payload; the receive time is stamped
    # locally and said to be local, rather than presented as the venue's.
    v = depth_history._view({"levels": [bids, asks],
                             "time": int(time.time() * 1000)})
    if v is None:
        return {"err": "Extended book failed the band view (crossed or "
                       "degenerate levels)"}
    out = {"mid": v["mid"], "spread_bps": round(v["spread_bps"], 3),
           "tick_bps": round(v["tick_bps"], 3),
           "reach_bps": round(v["reach_bps"], 1),
           "at_ms": v["t"], "at_is_local": True,
           "src": "/info/markets/%s/orderbook (full book; local timestamp)"
                  % native,
           "bands": _bands_from_view(v)}
    if off_hours:
        out["off_hours"] = ("this market is OUTSIDE its trading session — the "
                            "book is legitimately wide and thin right now, "
                            "which is a fact about the session, not about the "
                            "venue")
    return out


def _aster_exact_oi(row, failed):
    """Aster's per-coin open interest, exact, for the ONE coin compared.

    The venue snapshot can only afford OI on ~26 of Aster's 547 markets
    (there is no batch endpoint — proven — and a full sweep is 299s), so
    most listing rows arrive with oi=None. Here that is worth exactly one
    call and the answer is exact and current — strictly better than waiting
    on the venue module's background census, and it prices the size with the
    price from the same moment rather than with a census-old one.

    A SETTLING market is not called at all: its openInterest endpoint
    answers HTTP 400 by design, and spending a request to rediscover that
    would turn a known venue state into a reported error.
    """
    from datasources import aster
    if row.get("status") == aster.SETTLING:
        row["oi_note"] = ("%s is SETTLING — Aster's openInterest endpoint "
                          "returns HTTP 400 for settling markets by design, "
                          "so its OI is unknown, not zero" % row["sym"])
        return
    try:
        d = aster._get("/fapi/v1/openInterest?symbol=" + aster.usym(row["sym"]),
                       retries=0)
        base_units = aster._f(d.get("openInterest"), None)
        if base_units is None or not row.get("px_snap"):
            row["oi_note"] = ("Aster returned no open interest for %s"
                              % row["sym"])
            return
        row["oi_usd"] = base_units * row["px_snap"]
        row["oi_src"] = "openInterest (exact, fetched for this coin)"
    except Exception as exc:
        failed.append({"venue": row["venue"], "what": "openInterest",
                       "error": str(exc)[:120],
                       "impact": "Aster's open interest for %s is shown as "
                                 "unknown, not zero" % row["sym"]})
    time.sleep(PACE_S)


def _agg_orders(orders, descending):
    """Lighter serves raw ORDERS; depth is a property of price LEVELS.
    Aggregate by price (measured: 250 BTC orders collapse to ~215 levels)
    into the {px, sz, n} shape depth_history._view already understands."""
    lv, cnt = {}, {}
    for o in orders or []:
        try:
            px = float(o.get("price"))
            sz = float(o.get("remaining_base_amount"))
        except (TypeError, ValueError):
            continue
        if px <= 0 or sz <= 0:
            continue
        lv[px] = lv.get(px, 0.0) + sz
        cnt[px] = cnt.get(px, 0) + 1
    rows = [{"px": px, "sz": sz, "n": cnt[px]} for px, sz in lv.items()]
    rows.sort(key=lambda r: -r["px"] if descending else r["px"])
    return rows


def _book_lighter(market_id):
    """Lighter's keyless REST book. limit=250 is the endpoint's hard cap per
    side (251 returns HTTP 400, measured), so on deep majors the served book
    simply ENDS ~15-28bps out. The cap is carried into every band it
    truncates: a wide band on BTC here is 'not served', never 'empty'."""
    with urllib.request.urlopen(urllib.request.Request(
            LIGHTER_BASE + "/orderBookOrders?market_id=%d&limit=250"
            % int(market_id), headers=LIGHTER_UA), timeout=TIMEOUT) as resp:
        d = json.loads(resp.read())
    bids = _agg_orders(d.get("bids"), descending=True)
    asks = _agg_orders(d.get("asks"), descending=False)
    if len(bids) < 2 or not asks:
        return {"err": "orderBookOrders returned too few levels "
                       "(%d bids / %d asks)" % (len(bids), len(asks))}
    capped = len(d.get("bids") or []) >= 250 or len(d.get("asks") or []) >= 250
    cap_note = ("REST cap of 250 orders/side reached — deeper resting "
                "orders exist but were not served" if capped else None)
    v = depth_history._view({"levels": [bids, asks],
                             "time": int(time.time() * 1000)})
    if v is None:
        return {"err": "aggregated Lighter book failed the band view "
                       "(crossed or degenerate levels)"}
    return {"mid": v["mid"], "spread_bps": round(v["spread_bps"], 3),
            "tick_bps": round(v["tick_bps"], 3),
            "reach_bps": round(v["reach_bps"], 1),
            "at_ms": v["t"],
            "src": "orderBookOrders REST (order-level, capped 250/side)",
            "cap_note": cap_note,
            "bands": _bands_from_view(v, cap_note=cap_note)}


# How far Lighter's mark may sit from an independent USD price before this
# module refuses to read it as dollars. A same-currency listing drifts by
# session and staleness — single-digit percent, tens at the very worst for an
# equity perp over a closed weekend. A WRONG-CURRENCY mark is off by a factor,
# never a fraction: the WON-quoted rows measured 2026-08-17 were 1,000x and
# 1,570x. So this tolerance is deliberately loose. It is not trying to catch a
# stale price; it is trying to catch a different unit.
LIGHTER_QUOTE_TOL_PCT = 25.0


def _lighter_enrich(row, base, failed, ref_usd_px=None):
    """Fill the OI/funding a Lighter listing row lacks, and fetch its book.
    Each field degrades independently into a stated note — a failed
    enrichment must not take the row's snapshot price/volume down with it.

    `ref_usd_px` is the HOME venue's price for this same instrument, and it is
    the only evidence available that Lighter's mark is denominated in dollars
    — see the oi_usd block below for why that has to be checked.
    """
    mkt = None
    try:
        obd = _lighter_get("/orderBookDetails")
        for m in obd.get("order_book_details") or []:
            if m.get("symbol") == base:
                mkt = m
                break
        if mkt is None:
            row["oi_note"] = ("%s not present in Lighter orderBookDetails — "
                              "OI and book unknown, not zero" % base)
        else:
            oi_base = float(mkt.get("open_interest") or 0)
            mark = float(mkt.get("mark_price") or 0)
            # The raw size always ships, in named units. It is the one number
            # here that is true regardless of what the quote currency turns
            # out to be, so it must not be hostage to the dollar conversion.
            row["oi_base"] = oi_base
            row["oi_base_units"] = base
            if mark > 0:
                # open_interest is in BASE units (measured: BTC 1889.7 with
                # mark 63109.8 -> $119M, vs the absurd $1889 a USD reading
                # would claim).
                #
                # THE MARK IS NOT NECESSARILY IN DOLLARS, and orderBookDetails
                # does not say which currency it is in. MEASURED 2026-08-17:
                # `quote_asset_id` is 0 for BTC and 0 for HYUNDAI alike, so
                # the field that looks like the answer cannot answer. Lighter
                # lists KRX equity perps quoted in WON — HYUNDAI marks at
                # 515,564 against a $310.19 home price — and base x mark
                # shipped oi_usd $3,674.42 for about $2.34 of real exposure,
                # stamped "(live)" and rendered with a $ sign. SKHYNIX was
                # ~1,000x. There is no FX rate in this payload to divide by,
                # and inventing one would be the same error with more steps.
                # So: convert only when an INDEPENDENT USD price for the same
                # instrument corroborates the unit, and otherwise ship the
                # size with its units openly unverified. Not measured must not
                # wear the clothes of measured.
                off = (abs(mark / float(ref_usd_px) - 1.0) * 100.0
                       if ref_usd_px else None)
                if off is not None and off <= LIGHTER_QUOTE_TOL_PCT:
                    row["oi_usd"] = oi_base * mark
                    row["oi_src"] = ("orderBookDetails (live); mark %.6g is "
                                     "within %.1f%% of the home venue's USD "
                                     "price, so the quote is dollars"
                                     % (mark, off))
                else:
                    row["oi_usd"] = None
                    row["oi_units_unverified"] = True
                    row["oi_mark"] = mark
                    row["oi_note"] = (
                        "%s open interest is %s %s (orderBookDetails, live) — "
                        "NOT converted to dollars. Lighter's mark for it is "
                        "%.6g and %s, so the quote currency is unverified; "
                        "this venue publishes no currency field (measured: "
                        "quote_asset_id is 0 for its USD and its WON markets "
                        "alike). A dollar figure here would be a guess at an "
                        "FX rate, and the last one was 1,570x too large."
                        % (base, ("%.6g" % oi_base), base, mark,
                           ("that is %.0f%% away from the home venue's %.6g "
                            "— far past the %.0f%% a same-currency listing "
                            "drifts" % (off, float(ref_usd_px),
                                        LIGHTER_QUOTE_TOL_PCT))
                           if off is not None else
                           "no home-venue USD price was available to check "
                           "it against"))
    except Exception as exc:
        failed.append({"venue": row["venue"], "what": "orderBookDetails",
                       "error": str(exc)[:120],
                       "impact": "Lighter OI shown as unknown, and its book "
                                 "could not be located by market_id"})
    try:
        fr = _lighter_get("/funding-rates")
        for r in fr.get("funding_rates") or []:
            if r.get("exchange") == "lighter" and r.get("symbol") == base:
                # 8h-normalised at the endpoint; divided to hourly so it is
                # comparable with the HL-family rows beside it.
                row["funding_1h"] = float(r.get("rate")) / 8.0
                row["funding_src"] = "funding-rates 8h rate ÷ 8"
                break
        else:
            row["funding_note"] = ("no lighter row for %s in funding-rates — "
                                   "funding unknown, not zero" % base)
    except Exception as exc:
        failed.append({"venue": row["venue"], "what": "funding-rates",
                       "error": str(exc)[:120],
                       "impact": "Lighter funding shown as unknown"})
    time.sleep(PACE_S)
    if mkt is None:
        return {"err": row.get("oi_note") or "market_id unknown"}
    try:
        return _book_lighter(mkt.get("market_id"))
    except Exception as exc:
        return {"err": str(exc)[:120]}


def _usd_short(v):
    """$41.7M, not $41673k — the why-strings land in tooltips verbatim."""
    if v is None:
        return "?"
    if abs(v) >= 1e9:
        return "$%.2fB" % (v / 1e9)
    if abs(v) >= 1e6:
        return "$%.1fM" % (v / 1e6)
    return "$%.0fk" % (v / 1e3)


def _cheapest(rows):
    """One venue, or the stated reason there is none. Qualification is a
    MEASURED book (mid + spread) with the ±25bps band resolved on both
    sides; the winner must take spread AND min-side depth outright."""
    q, unranked, closed, broken = [], [], [], []
    for r in rows:
        bk = r.get("book") or {}
        if bk.get("err") or bk.get("note"):
            # No book at all — shed, unreachable, or no fetcher written. This
            # is named for the same reason an unresolved band is: on the very
            # first live call of this comparison HL core's book was shed with
            # a 429 and the ranking crowned Aster "cheapest" over the two
            # venues left standing, with the largest book on the instrument
            # silently absent from the field. Discoverable in `failed` is not
            # the same as stated where the verdict is read.
            broken.append({"venue": r["venue"],
                           "why": bk.get("err") or bk.get("note")})
            continue
        d25 = None
        for b in bk.get("bands") or []:
            if (b["bps"] == REF_BPS and b["bid_usd"] is not None
                    and b["ask_usd"] is not None):
                d25 = min(b["bid_usd"], b["ask_usd"])
        if r.get("off_hours"):
            # A market outside its trading session quotes wide and thin BY
            # SCHEDULE. Ranking it would be a category error in both
            # directions: it would lose a comparison it is not competing in,
            # and — because a closed book can also be one stale order at a
            # silly price — it could win one. It is excluded and named.
            closed.append({"venue": r["venue"],
                           "spread_bps": bk.get("spread_bps")})
            continue
        if bk.get("mid") and bk.get("spread_bps") is not None and d25:
            q.append({"venue": r["venue"], "spread_bps": bk["spread_bps"],
                      "depth25_min_usd": d25})
        elif bk.get("spread_bps") is not None:
            # Measured spread, unresolved band. These are NOT rankable on
            # depth, but their spread is on screen — and on BTC, Lighter's
            # 0.111bps sits visibly tighter than the winner's 0.159bps while
            # its ±25bps band is capped out by a 250-order REST limit. Saying
            # "tightest among the venues whose books were measured" while a
            # tighter measured spread is displayed one row above is the same
            # self-contradiction this codebase keeps producing, so the
            # excluded venues are named and the qualifying set is described
            # by what actually qualifies: a resolved band.
            unranked.append({"venue": r["venue"],
                             "spread_bps": bk["spread_bps"]})
    closed_note = ("; %s excluded as OFF HOURS — a closed book is wide by "
                   "schedule and is not competing"
                   % ", ".join(c["venue"] for c in closed)) if closed else ""
    broken_note = ("; %s could not be ranked because %s book did not come "
                   "back at all — that venue's spread and depth are UNKNOWN "
                   "here, not worse"
                   % (", ".join(b["venue"] for b in broken),
                      "their" if len(broken) > 1 else "its")) if broken else ""
    if len(q) < 2:
        return {"venue": None,
                "off_hours_excluded": [c["venue"] for c in closed] or None,
                "no_book": [b["venue"] for b in broken] or None,
                "why": "ranking needs at least two venues with a measured "
                       "book and a resolved ±%dbps band — %d qualified%s%s%s"
                       % (REF_BPS, len(q),
                          (" (%s measured a spread but its band is "
                           "unresolved)" % ", ".join(u["venue"] for u in unranked))
                          if unranked else "", closed_note, broken_note)}
    tight = min(q, key=lambda x: x["spread_bps"])
    deep = max(q, key=lambda x: x["depth25_min_usd"])
    if (sum(1 for x in q if x["spread_bps"] == tight["spread_bps"]) > 1
            or sum(1 for x in q
                   if x["depth25_min_usd"] == deep["depth25_min_usd"]) > 1):
        return {"venue": None, "why": "tied on spread or depth — no venue "
                                      "wins outright"}
    if tight["venue"] != deep["venue"]:
        return {"venue": None,
                "off_hours_excluded": [c["venue"] for c in closed] or None,
                "no_book": [b["venue"] for b in broken] or None,
                "why": "no single cheapest venue: %s has the tighter spread "
                       "(%.2f vs %.2fbps) but %s has the deeper ±%dbps book "
                       "(%s vs %s min-side)"
                       % (tight["venue"], tight["spread_bps"],
                          deep["spread_bps"], deep["venue"], REF_BPS,
                          _usd_short(deep["depth25_min_usd"]),
                          _usd_short(tight["depth25_min_usd"]))
                       + closed_note + broken_note}
    tighter_unranked = [u for u in unranked
                        if u["spread_bps"] < tight["spread_bps"]]
    why = ("tightest spread (%.2fbps) AND deepest ±%dbps min-side (%s) "
           "among the %d venues with a resolved ±%dbps band"
           % (tight["spread_bps"], REF_BPS,
              _usd_short(tight["depth25_min_usd"]), len(q), REF_BPS))
    if tighter_unranked:
        why += (" — note %s quotes a TIGHTER spread (%s) but its ±%dbps "
                "band is unresolved, so it cannot be ranked on depth"
                % (", ".join(u["venue"] for u in tighter_unranked),
                   ", ".join("%.2fbps" % u["spread_bps"]
                             for u in tighter_unranked), REF_BPS))
    why += closed_note + broken_note
    return {"venue": tight["venue"],
            "spread_bps": tight["spread_bps"],
            "depth25_min_usd": tight["depth25_min_usd"],
            "unranked_tighter": [u["venue"] for u in tighter_unranked] or None,
            "off_hours_excluded": [c["venue"] for c in closed] or None,
            "no_book": [b["venue"] for b in broken] or None,
            "why": why}


def compare(coin, snap):
    """The full comparison for one coin against a venues snapshot.

    `snap` is venues.snapshot() as cached by the server — including the
    `listings` index the wire endpoint strips. Book fetches happen here, on
    demand, paced; everything else is read from data already paid for.
    """
    # Function-local like every other aster use in this file (the module does
    # a live network probe at import in some paths, so it stays off the
    # top-level import list). Needed here for interval_phrase(), which is what
    # keeps this file from writing Aster's funding-interval list down.
    from datasources import aster
    now = time.time()
    out = {"at": now, "coin": coin, "bands_bps": list(BANDS),
           "snap_age_s": round(now - (snap.get("at") or now), 1)}
    cls = cross_venue.classify(snap.get("listings"), coin)
    # The index KEY, not a ticker split of the query. Those diverged the
    # moment Aster and Extended joined: charting `BTCUSDT` splits to
    # "BTCUSDT", which is not the key its listing sits under and is not the
    # symbol Lighter lists it as, so a base taken from the string would send
    # _lighter_enrich looking for a market that does not exist and report the
    # miss as "Lighter does not list this" — a fabricated absence.
    base = cls.get("base") or cross_venue.base_ticker(coin)
    out["base"] = base
    out["state"] = cls.get("state")
    out["note"] = cls.get("note")
    if cls.get("state") == "UNKNOWN" or not cls.get("home"):
        out["rows"] = []
        out["failed"] = []
        out["cheapest"] = {"venue": None, "why": "no listings to compare"}
        return out

    vmeta = {v.get("venue"): v for v in snap.get("venues") or []}
    failed = []
    rows = []
    listings = [dict(cls["home"], share_pct=cls.get("home_share_pct"),
                     home=True)]
    listings += [dict(o) for o in cls.get("others") or []]
    # The home venue's price, in dollars, is the ONLY independent evidence
    # this compare holds about what currency another venue's mark is quoted
    # in — see _lighter_enrich. Read once, before the loop mutates anything.
    home_usd_px = (cls.get("home") or {}).get("px")
    for src in listings[:MAX_BOOKS]:
        meta = vmeta.get(src.get("venue")) or {}
        row = {"venue": src.get("venue"), "sym": src.get("sym"),
               "sym_native": src.get("sym_native") or src.get("sym"),
               "kind": meta.get("kind"), "chain": meta.get("chain"),
               "home": bool(src.get("home")),
               "px_snap": src.get("px"), "vol_24h": src.get("vol"),
               "share_pct": src.get("share_pct"),
               "px_diff_bps": src.get("px_diff_bps"),
               # Three-state now, and the row has to carry which state it is
               # in: "verified" / "disagrees" / "unchecked". A row that was
               # never price-checked used to be indistinguishable here from
               # one that passed, which is how a WON-quoted listing arrived
               # at _lighter_enrich wearing a verified face.
               "px_verified": src.get("px_verified"),
               "px_note": src.get("px_note"),
               "oi_usd": src.get("oi"),
               "oi_src": "venue snapshot" if src.get("oi") is not None else None,
               "funding_1h": src.get("funding"),
               "funding_src": ("venue native hourly"
                               if src.get("funding") is not None else None),
               # Carried from the index so the row can explain itself: an
               # off-hours book is wide by schedule, and a settling market's
               # OI is unavailable by design.
               "off_hours": bool(src.get("off_hours")),
               "status": src.get("status")}
        chain = meta.get("chain")
        try:
            if chain == "hyperliquid":
                row["book"] = _book_hl(row["sym"])
            elif chain == "zklighter":
                row["book"] = _lighter_enrich(row, base, failed,
                                              ref_usd_px=home_usd_px)
            elif chain == "bnb":
                # Aster funding already arrives HOURLY — datasources.aster
                # divides each market's raw rate by its own declared
                # fundingIntervalHours at the source, because that venue's
                # book is mixed-interval and its raw rates are not even
                # comparable with each other, let alone with HL's.
                #
                # THE INTERVAL LIST COMES FROM THE CENSUS, NOT FROM HERE. Both
                # of this file's copies said "1h/2h/4h/8h" and the venue's own
                # sweep of its 547 tradable markets says 1h x335, 8h x148,
                # 4h x64 — there is no tradable 2h market at all (the 2h
                # symbols are index-only). A written-down list cannot track a
                # venue that relists; aster.interval_phrase() reads the last
                # completed sweep and says "not yet measured" when there is
                # none, which is the one thing the old string could not say.
                if row["funding_1h"] is not None:
                    row["funding_src"] = ("Aster raw rate / its own declared "
                                          "funding interval (%s book)"
                                          % aster.interval_phrase())
                if row["oi_usd"] is None:
                    _aster_exact_oi(row, failed)
                row["book"] = _book_aster(row["sym_native"])
            elif chain == "starknet":
                if row["funding_1h"] is not None:
                    row["funding_src"] = ("Extended native hourly, unscaled "
                                          "(interval measured, not assumed)")
                row["book"] = _book_extended(row["sym_native"],
                                             off_hours=row["off_hours"])
            else:
                row["book"] = {"note": "book not available — no keyless book "
                                       "fetcher for venue kind %r"
                                       % (meta.get("kind") or "unknown")}
        except Exception as exc:
            row["book"] = {"err": str(exc)[:140]}
        time.sleep(PACE_S)
        bk = row["book"]
        if bk.get("err"):
            failed.append({"venue": row["venue"], "what": "book",
                           "error": bk["err"],
                           "impact": "%s shows snapshot price/volume only — "
                                     "its depth and spread are missing from "
                                     "this comparison, not zero"
                                     % row["venue"]})
        rows.append(row)
    dropped = len(listings) - len(rows)
    if dropped > 0:
        out["fanout_note"] = ("%d further listing(s) not fetched — book "
                              "fan-out is capped at %d venues per compare"
                              % (dropped, MAX_BOOKS))
    # classify caps `others`; whatever the cap excluded is NAMED here, not
    # merely counted. MEASURED 2026-08-15 on SOL: the old string read
    # "2 smaller listing(s) beyond the top 3 are not shown" while what it was
    # actually hiding was an entire venue — Extended's genuine SOL-USD at
    # $7,386,976/24h and $8,215,499 of OI, displaced by Aster's own tiny
    # SOLUSD1 on a board that already showed Aster. A count cannot carry that;
    # a reader asking "where else can I trade this" was told a number and
    # learned nothing. "Smaller" was not reliably true either, and is less
    # true now: the breadth-first rule demotes a venue's SECOND listing
    # whatever its size, which is a different fact and says so per row.
    hid = cls.get("others_hidden") or []
    if hid:
        named = "; ".join(
            "%s %s (%s/24h — %s)"
            % (h["venue"], h["sym"], _usd_short(h.get("vol")), h["why"])
            for h in hid[:3])
        out["others_note"] = (
            "%d further listing(s) exist and are not shown: %s%s — %s"
            % (len(hid), named,
               "; and %d more" % (len(hid) - 3) if len(hid) > 3 else "",
               cls.get("others_rule") or ""))
        # The structured half, so a consumer can render the roster rather
        # than parse the sentence.
        out["others_hidden"] = hid
    out["rows"] = rows
    # Refuted same-ticker matches stay visible AS refutations: dropping them
    # silently would read as "no other book", and comparing them would be
    # comparing two different assets.
    out["split"] = cls.get("split") or []
    out["failed"] = failed
    if len(rows) == 1 and not failed and not out["split"]:
        out["only"] = ("only listed on %s — there is no second venue to "
                       "compare (%s)" % (rows[0]["venue"], cls.get("why") or ""))
    out["cheapest"] = _cheapest(rows)
    out["caveats"] = [
        "resting depth is CANCELLABLE — where liquidity is shown, not a "
        "commitment; this table describes books, it does not route to them",
        "OI is per-venue and never summed here: a hedge held on two venues "
        "sits on both sides of any sum",
        "funding is shown as an HOURLY decimal on every row, but it gets "
        "there three different ways: HL and Extended publish hourly "
        "natively, Lighter's 8h-normalised feed is divided by 8, and each "
        "Aster market is divided by its OWN declared interval (that book is "
        "%s, so its raw rates are not comparable even with "
        "each other — BTCUSDT at 8h and SUSHIUSDT at 1h differ by 8x before "
        "any cross-venue question is asked)" % aster.interval_phrase(),
        "per-wallet identity behind these books exists only on the "
        "Hyperliquid family and Lighter. Aster publishes no per-account "
        "data at any price and Extended's is auth-gated, so size on those "
        "two rows is ANONYMOUS — their absence from any whale view is a "
        "coverage boundary, not an absence of whales",
    ]
    return out
