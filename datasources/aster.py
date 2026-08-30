"""Aster (BNB chain) — 547 keyless perp markets, added as a first-class venue.

WHY IT IS HERE: measured 2026-08-15 Aster traded $857M in 24h against HL
core's ~$2.2B, on 547 markets. It was the largest venue this terminal did not
aggregate. Its REST surface is Binance-shaped, which makes three of its four
traps look like conveniences until they are measured.

WHAT IT COSTS: four batch calls (weight 61 of a published 2400/min) plus a
background open-interest census. Keyless throughout. No order path, no
signing, no key material, no routing.

═══ TRAP 1: THE MARKET COUNT IS 547, AND TWO OTHER ENDPOINTS DISAGREE ═════
Three endpoints return three different universes and only one is tradable:

    ticker/24hr    547   <- THE UNIVERSE (every tradable perp)
    premiumIndex   700   = 547 + 153 index-only symbols (AAPLUSD, 500BTCUSD,
                           ADAUSD ...) that are NOT tradable — ticker/24hr and
                           openInterest both answer -1121 "Invalid symbol" for
                           them. Counting them inflates the venue by 28%.
    exchangeInfo   552   = 547 TRADING/SETTLING + 5 PENDING_TRADING

Verified live each snapshot rather than trusted: the universe is built from
ticker/24hr and the other two are joined onto it, never unioned with it.

═══ TRAP 2: FUNDING IS NOT 8h — IT IS FOUR DIFFERENT INTERVALS AT ONCE ════
Aster is not a uniform-interval venue. Measured over its 547 tradable
markets on 2026-08-15: 1h x335, 8h x148, 4h x64 (the 2h markets exist only
among the untradable index-only symbols). Every rate in this terminal is an
HOURLY decimal — HL's native basis, and the reason xvenue divides Lighter's
feed by 8 — so `lastFundingRate` is divided by that market's OWN declared
`fundingIntervalHours` from /fapi/v1/fundingInfo, a batch call covering all
547 with zero missing.

This is not cosmetic. On Aster's own book, comparing the raw fields ranks the
extreme market backwards:

    BTCUSDT    8h   raw +0.006749%  ->  hourly +0.000844%   (APR  +7.4%)
    SUSHIUSDT  1h   raw -0.005907%  ->  hourly -0.005907%   (APR -51.8%)

The declared interval was itself checked rather than believed: for three
symbols at each declared interval, 25 consecutive /fapi/v1/fundingRate rows
were differenced and all 24 gaps matched the declaration in all 12 cases.

═══ TRAP 3: openInterest IS IN CONTRACTS, AND THERE IS NO BATCH ENDPOINT ══
`/fapi/v1/openInterest` returns BASE units, so it is multiplied by price for
USD — the same convention xvenue already applies to Lighter's
orderBookDetails. Measured: BTCUSDT 6,259.2 contracts at $62,900 is $394M,
against the absurd $6,259 a USD reading would claim.

There is NO batch form. Probed and rejected this session: no-symbol (-1102),
comma list (-1121), JSON `symbols` array (-1102), /fapi/v3/openInterest
(-1102, route exists but still per-symbol), and /fapi/v1/allOpenInterest,
/futures/data/openInterest, /futures/data/openInterestHist (404 HTML).

So a venue total is 547 sequential calls. MEASURED, not estimated: a full
paced sweep took 281s standalone and 341s inside the running server
(which is competing with the depth and flow collectors), returning 536 of 547
markets and $968M of open interest.

WHY THIS MODULE SWEEPS ALL 547 RATHER THAN SAMPLING A TOP-N. A top-40-by-
volume subset was measured at 93.99% of volume but only 91.56% of open
interest, and the miss is structural, not random: OI is far more concentrated
than volume and ranks differently. WLFIUSDT holds $10.2M of OI on $0.9M of
volume (volume rank 53), BULLAUSDT $8.8M on $1.1M (rank 45), LITUSDT $6.2M on
$0.9M (rank 52) — all three invisible to a top-40 volume cut. A subset sum
placed beside HL core's complete figure, in a pane that renders both as
"OI $x", is the confident-partial failure this codebase exists to prevent,
and app.js cannot currently distinguish them. So the sweep is complete and
runs in the BACKGROUND on its own cadence; until the first one finishes,
`oi_usd` is None with a stated reason. Not-yet-measured is published as
not-measured, never as a smaller number wearing a total's face.

═══ TRAP 4: THREE SYMBOLS ARE NOT ASCII ═══════════════════════════════════
Found by running the full sweep rather than by reading the docs: 币安人生USDT,
我踏马来了USDT and 龙虾USDT are live TRADING markets whose names are CJK. A
per-symbol URL built by string concatenation raises UnicodeEncodeError on all
three and — if that exception is swallowed per-symbol, which is the natural
shape of a 547-call loop — drops $4.5M of open interest silently. They are
url-quoted here, and the sweep proves they answer: 龙虾USDT alone carries
$3.08M. Any future per-symbol loop against this venue must quote.

═══ A REAL ZERO THAT IS NOT A MISSING VALUE ═══════════════════════════════
11 markets are status=SETTLING (TONUSDT, IPUSDT, ACXUSDT, COSUSDT, DUSDT,
PDDUSDT, BIRDUSDT, 1000SATSUSDT, HIGHUSDT, CARUSDT, VANRYUSDT). They still
report volume — $861,711, 0.10% of the venue — but openInterest answers 400
on every one of them. Their OI is UNKNOWN, not zero, and they are counted in
their own bucket so the venue total can say what it is missing and by how
much rather than quietly excluding eleven books.

═══ VOLUME DENOMINATION — NOT SILENTLY CALLED USD ═════════════════════════
`quoteVolume` is denominated in each market's QUOTE ASSET, and that is not
uniformly USD: measured, 542 of the 547 quote USDT, 3 quote USD1
(BTCUSD1/ETHUSD1/SOLUSD1) and 2 quote "U" (BTCU/ETHU). All three are
USD-pegged — /fapi/v1/assetIndex on 2026-08-15 gave USDTUSD 0.998965,
USD1USD 0.999529, UUSD 0.999400 — so summing them as dollars overstates by
roughly 10bps. The split is recomputed from exchangeInfo on every snapshot
and published in `vol_basis`; no conversion is applied, because a 0.1% peg
drift is far inside the venue's own intraday volume swing (measured -14.9%
in 42 minutes) and a stated basis beats an unstated correction.

WHALE CEILING (relevant to any consumer of this venue): Aster publishes NO
per-account data at all — positionRisk, account, userTrades and adlQuantile
are key-gated, and there is no leaderboard, no insurance fund and none of the
Binance positioning-ratio endpoints. Unlike the Hyperliquid family, per-wallet
identity here is structurally impossible from public data, not merely
unfetched. Nothing in this module implies otherwise.
"""

import json
import threading
import time
import urllib.parse
import urllib.request

BASE = "https://fapi.asterdex.com"
TIMEOUT = 30

# Same pace venues.py uses on the HL family. Aster's own budget is far
# looser (2400 weight/min; openInterest is weight 1), so this is politeness
# rather than necessity — measured end-to-end at 0.51s/call, which is what
# makes the 547-market census a 281s background job instead of an inline one.
PACE_S = 0.15
RETRIES = 2

# How long a completed open-interest census stays authoritative. Open
# interest is a stock, not a tick; the record carries `oi_age_s` so a reader
# can see exactly how old the number is rather than inferring it from a
# refresh policy written here. Refresh is LAZY — it happens only when
# venue() is called and the store is stale, so an idle terminal makes no
# outbound calls at all.
OI_TTL_S = 900

# Markets in this state answer 400 on openInterest by design. Their OI is
# unknown, and that is a different fact from a fetch that failed.
SETTLING = "SETTLING"

# EVERY symbol interpolated into an Aster path must be percent-encoded first.
# MEASURED 2026-08-15: three live TRADING markets carry CJK names (龙虾USDT
# alone is $696,302 of 24h volume and $3.07M of open interest), and a raw
# concatenation raises "'ascii' codec can't encode characters in position
# 26-27" inside urllib. Every OTHER market works, which is exactly why the
# trap survived one round of fixing: the census here was quoted, while the
# three consumer paths (xvenue's book, xvenue's exact-OI, xprints' tape) were
# not, and those three markets were unreadable for book, OI and prints while
# reporting only a codec error.
_PATH_SAFE = "/?=&%:+,;@$!*'()~-._"


def usym(sym):
    """The URL-safe form of a venue symbol — use it for every /fapi path.

    Idempotent against an already-encoded symbol under `_PATH_SAFE`
    (verified), so quoting twice is harmless and forgetting once is not.
    """
    return urllib.parse.quote(str(sym))

_OI_LOCK = threading.Lock()
_OI_BUSY = threading.Event()
# Base-unit open interest from the last COMPLETED census, plus the census's
# own bookkeeping. Base units, not USD: the size is converted with the price
# from the snapshot that reads it, so a 12-minute-old size is never priced
# at a 12-minute-old price.
_OI = {"at": None, "base": {}, "failed": {}, "settling": [],
       "elapsed": None, "sweeps": 0, "universe": 0, "error": None,
       "started_at": None}


def _f(x, d=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return d


def _get(path, retries=RETRIES):
    """One keyless GET, retried like venues.py retries the HL calls."""
    err = None
    for attempt in range(retries + 1):
        try:
            # BELT AND BRACES, not a replacement for usym() at the call
            # site: a path assembled by a future caller that forgets to
            # quote its symbol would otherwise raise UnicodeEncodeError
            # inside urllib and surface as an opaque codec string instead of
            # a fetch. `_PATH_SAFE` keeps '%', so an already-quoted path
            # passes through byte-identical.
            req = urllib.request.Request(
                BASE + urllib.parse.quote(path, safe=_PATH_SAFE),
                headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return json.loads(resp.read().decode())
        except Exception as exc:
            err = exc
            if attempt < retries:
                time.sleep(0.4 * (attempt + 1))
    raise err


def tickers():
    """/fapi/v1/ticker/24hr — THE market universe. 547 rows, weight 40."""
    rows = _get("/fapi/v1/ticker/24hr")
    if not rows:
        # A 200 carrying an empty list would zero the venue downstream while
        # looking like a successful fetch. Fail loudly instead so
        # venues.snapshot() files it in `failed` with a stated impact.
        raise RuntimeError("aster ticker/24hr returned no rows")
    return rows


def _oi_sweep(universe):
    """Full per-symbol open-interest census. Runs on a background thread.

    `universe` is [(symbol, status)]. Every symbol is url-quoted — see TRAP 4;
    three live markets have CJK names and string concatenation raises on them.

    Failures are RECORDED, never dropped, and split by whether they were
    expected: a SETTLING market's 400 is the venue declining to publish, a
    timeout is this process failing to ask. Collapsing the two would let a
    network problem masquerade as a venue property.
    """
    got, failed, settling = {}, {}, []
    t0 = time.time()
    with _OI_LOCK:
        _OI["started_at"] = t0
    for sym, status in universe:
        if status == SETTLING:
            # Known to 400. Recorded as unavailable-by-design without
            # spending a call, and without pretending it is zero.
            settling.append(sym)
            continue
        try:
            d = _get("/fapi/v1/openInterest?symbol=" + usym(sym),
                     retries=1)
            got[sym] = _f(d.get("openInterest"))
        except Exception as exc:
            failed[sym] = str(exc)[:70]
        time.sleep(PACE_S)
    with _OI_LOCK:
        _OI.update({"at": time.time(), "base": got, "failed": failed,
                    "settling": settling, "elapsed": round(time.time() - t0, 1),
                    "sweeps": _OI["sweeps"] + 1, "universe": len(universe),
                    "error": None})


def _oi_refresh_async(universe):
    """Start one census if none is running and the store is stale.

    Self-starting rather than wired into server.py's thread list on purpose:
    this module is also imported by scripts and by venues.snapshot() outside
    the server, and a census that only exists when a particular process
    happens to start a thread is a coverage gap waiting to be discovered as
    a silently empty OI field.
    """
    if _OI_BUSY.is_set():
        return
    _OI_BUSY.set()

    def run():
        try:
            _oi_sweep(universe)
        except Exception as exc:
            # A crashed census leaves the PREVIOUS one in place — stale with
            # a visible age beats nothing. But the crash itself is RECORDED,
            # not swallowed: an earlier version passed here silently, and a
            # census that never runs would then have presented as a venue
            # that simply has no open interest, with nothing anywhere saying
            # why. That is the exact failure this file is built to prevent,
            # reproduced inside the file itself.
            with _OI_LOCK:
                _OI["error"] = str(exc)[:120]
        finally:
            _OI_BUSY.clear()
    try:
        threading.Thread(target=run, daemon=True,
                         name="aster-oi-census").start()
    except Exception as exc:
        # The flag is set BEFORE the thread exists, so a failed start would
        # otherwise latch it forever and no census would ever run again for
        # the life of the process — a permanent silent outage from a
        # transient error.
        _OI_BUSY.clear()
        with _OI_LOCK:
            _OI["error"] = "census thread could not start: " + str(exc)[:90]


_INTERVAL_CENSUS = {}      # {hours: n_markets} from the last completed venue()


def interval_census():
    """{hours: n_markets} as last MEASURED, or {} if no sweep has completed.

    Exists so no consumer has to write Aster's interval list down. Every
    hardcoded copy of it drifted: xvenue described "a mixed 1h/2h/4h/8h
    book" in two places, and the venue's own census over its 547 tradable
    markets enumerates 1h x335, 8h x148 and 4h x64 — no tradable 2h market
    at all (the 2h symbols are index-only and untradable). {} means the
    census has not run, which callers must render as unknown, never as a
    default list.
    """
    return dict(_INTERVAL_CENSUS)


def interval_phrase():
    """The census as prose, e.g. "mixed 1h/4h/8h" — or an honest unknown."""
    c = interval_census()
    if not c:
        return "mixed-interval (census not yet measured this run)"
    hs = sorted(c)
    return "mixed " + "/".join("%dh" % h for h in hs) if len(hs) > 1 \
        else "uniform %dh" % hs[0]


def venue():
    """One venue record in the shape venues.snapshot() consumes.

    Four batch calls, ~2s. The open-interest census does NOT run here — it
    runs on a background thread and this function reads whatever complete
    census currently exists, with its age. Before the first one lands,
    `oi_usd` is None and `oi_note` says why; it is never a subset sum.
    """
    tick = tickers()
    universe = [r.get("symbol") for r in tick]
    live = set(universe)

    # exchangeInfo: status (SETTLING) and the venue's OWN base/quote asset
    # declaration. cross_venue keys the cross-listing index on `base`, and
    # its doctrine is explicit that the venue naming its own underlying is
    # evidence while a mapping table written locally would be a guess.
    status, base_of, quote_of, meta_err = {}, {}, {}, None
    try:
        for s in (_get("/fapi/v1/exchangeInfo") or {}).get("symbols") or []:
            sym = s.get("symbol")
            if sym in live:
                status[sym] = s.get("status")
                base_of[sym] = s.get("baseAsset")
                quote_of[sym] = s.get("quoteAsset")
    except Exception as exc:
        meta_err = str(exc)[:90]

    # premiumIndex (700 rows) + fundingInfo (700 rows), joined BY SYMBOL onto
    # the 547 — never unioned, see TRAP 1.
    rate_of, interval_of, funding_err = {}, {}, None
    try:
        for r in _get("/fapi/v1/premiumIndex") or []:
            if r.get("symbol") in live:
                rate_of[r["symbol"]] = _f(r.get("lastFundingRate"), None)
        for r in _get("/fapi/v1/fundingInfo") or []:
            if r.get("symbol") in live:
                interval_of[r["symbol"]] = _f(r.get("fundingIntervalHours"), None)
    except Exception as exc:
        funding_err = str(exc)[:90]

    with _OI_LOCK:
        oi_at = _OI["at"]
        oi_base = dict(_OI["base"])
        oi_failed = dict(_OI["failed"])
        oi_settling = list(_OI["settling"])
        oi_elapsed, oi_sweeps = _OI["elapsed"], _OI["sweeps"]
        oi_err, oi_started = _OI["error"], _OI["started_at"]
    if oi_at is None or (time.time() - oi_at) > OI_TTL_S:
        _oi_refresh_async([(s, status.get(s)) for s in universe])

    mkts, vol, oi_usd, n_oi = [], 0.0, 0.0, 0
    quotes, intervals = {}, {}
    for r in tick:
        sym = r.get("symbol")
        px = _f(r.get("lastPrice")) or None
        v = _f(r.get("quoteVolume"))
        vol += v
        q = quote_of.get(sym)
        quotes[q] = quotes.get(q, 0) + 1

        hours = interval_of.get(sym)
        raw = rate_of.get(sym)
        if hours:
            intervals[int(hours)] = intervals.get(int(hours), 0) + 1
        # TRAP 2. None when either half is missing — an unnormalised rate
        # must never reach a comparison, and a 0.0 would claim flat funding.
        funding = (raw / hours) if (raw is not None and hours) else None

        # TRAP 3. Base units -> USD with THIS snapshot's price.
        ob = oi_base.get(sym)
        if ob is not None and px:
            o = ob * px
            oi_usd += o
            n_oi += 1
        else:
            o = None

        mkts.append({
            "sym": sym,
            "base": base_of.get(sym),
            "px": px,
            "vol": v,
            "oi": o,
            "funding": funding,
            "funding_interval_h": int(hours) if hours else None,
            "quote": q,
            "status": status.get(sym),
            # Named so a consumer can tell "this market does not publish OI"
            # from "we have not measured it yet" from "it is zero".
            "oi_state": ("measured" if o is not None else
                         "settling — venue does not serve open interest"
                         if status.get(sym) == SETTLING else
                         "not measured" if oi_at is None else
                         "sweep failed" if sym in oi_failed else
                         "listed since the last census"),
        })
    mkts.sort(key=lambda m: -m["vol"])

    # Publish the interval census as soon as it is complete, so no consumer
    # has to write Aster's interval list down (see interval_census()).
    # REASSIGNED, never mutated in place: a reader on another thread sees
    # either the previous complete census or this one, never a half-built one.
    if intervals:
        globals()["_INTERVAL_CENSUS"] = dict(sorted(intervals.items()))

    n_settling = sum(1 for m in mkts if m["status"] == SETTLING)
    settling_vol = sum(m["vol"] for m in mkts if m["status"] == SETTLING)
    unmeasured = len(mkts) - n_oi
    if oi_at is None:
        oi_note = ("open interest not yet measured — Aster publishes no batch "
                   "endpoint, so a venue total is %d sequential calls "
                   "(measured 281-341s) running in the background%s; this is "
                   "NOT zero open interest"
                   % (len(mkts),
                      ", started %ds ago" % (time.time() - oi_started)
                      if oi_started else ""))
    else:
        bits = []
        if n_settling:
            bits.append("%d SETTLING market(s) answer 400 on open interest, so "
                        "their OI is unknown, not zero (they carry $%.0f of "
                        "24h volume, %.2f%% of the venue)"
                        % (n_settling, settling_vol,
                           settling_vol / vol * 100.0 if vol else 0.0))
        if oi_failed:
            bits.append("%d market(s) failed the last census" % len(oi_failed))
        stale = unmeasured - n_settling - len(oi_failed)
        if stale > 0:
            bits.append("%d market(s) listed since the last census" % stale)
        oi_note = ("census of %d of %d markets, %.0fs old"
                   % (n_oi, len(mkts), time.time() - oi_at))
        if bits:
            oi_note += " — " + "; ".join(bits)

    rec = {
        "markets": len(mkts),
        "vol_24h": vol,
        "oi_usd": oi_usd if oi_at is not None and n_oi else None,
        # True while ANY live market is missing from the OI figure — which,
        # because of the 11 SETTLING books, is the normal steady state here.
        # venues.snapshot() surfaces this by name in `oi_incomplete`, so the
        # shortfall is attributable rather than merely counted.
        "oi_partial": bool(oi_at is not None and unmeasured),
        # THE FACT THAT DISTINGUISHES A COLD CENSUS FROM A VENUE THAT
        # WITHHOLDS. Aster publishes open interest per symbol, keylessly and
        # measurably (/fapi/v1/openInterest?symbol=BTCUSDT answered 6261.652
        # on 2026-08-15) — what it does not publish is a BATCH endpoint, so
        # the venue total is absent until the background census lands. Before
        # this field existed, venues.snapshot() filed that pending census
        # under the same "not published" state as Lighter, which genuinely
        # publishes none — a covered venue labelled uncovered, the house
        # invariant inverted. The two are now different states.
        "oi_publishes": True,
        "oi_markets_measured": n_oi,
        "oi_markets_total": len(mkts),
        "oi_markets_settling": n_settling,
        "oi_markets_failed": len(oi_failed),
        "oi_coverage_pct": round(n_oi / len(mkts) * 100.0, 2) if mkts else None,
        "oi_measured_at": oi_at,
        "oi_age_s": round(time.time() - oi_at, 1) if oi_at else None,
        "oi_census_elapsed_s": oi_elapsed,
        "oi_censuses": oi_sweeps,
        "oi_note": oi_note + (" — LAST CENSUS FAILED: %s" % oi_err
                              if oi_err else ""),
        "oi_error": oi_err,
        "oi_method": ("per-symbol sweep — no batch endpoint exists on this "
                      "venue (8 variants probed); base units x last price"),
        "funding_basis": ("hourly — each market's raw rate divided by its OWN "
                          "declared fundingIntervalHours (%s)"
                          % ", ".join("%dh x%d" % (h, n)
                                      for h, n in sorted(intervals.items()))),
        "funding_intervals_h": dict(sorted(intervals.items())),
        "vol_basis": ("quote-asset denominated, USD-pegged to ~0.1%% (%s); "
                      "not converted, and not silently called USD"
                      % ", ".join("%d %s" % (n, q or "unknown")
                                  for q, n in sorted(quotes.items(),
                                                     key=lambda x: -x[1]))),
        "top": mkts[:5],
        "_all": mkts,
    }
    # A failed side-call degrades specific fields, so it says WHICH — a bare
    # error string would leave the reader unable to tell whether the funding
    # column is flat or absent.
    partial = []
    if meta_err:
        partial.append({"what": "exchangeInfo", "error": meta_err,
                        "impact": "base-asset declarations and SETTLING "
                                  "status are missing, so Aster markets fall "
                                  "back to raw-symbol cross-listing keys and "
                                  "may not match core tickers"})
    if funding_err:
        partial.append({"what": "premiumIndex/fundingInfo", "error": funding_err,
                        "impact": "funding is None on every Aster market — "
                                  "unknown, not flat"})
    rec["degraded"] = partial or None
    return rec
