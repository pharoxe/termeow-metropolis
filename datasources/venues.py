"""On-chain perp venues, aggregated — Hyperliquid core, its HIP-3 builder
DEXs, Lighter, Aster and Extended.

WHY THIS EXISTS: the terminal has always shown one venue. Measured on
2026-08-14 the HIP-3 DEX `xyz` alone traded $4.15B/24h against core
Hyperliquid's $2.96B — the venue the terminal did not aggregate was the
larger of the two. That is not a rounding error, it is half the market.

WHAT IT REFUSES TO DO: sum open interest into one headline number. The
same trader hedged on two venues appears on both sides of the total, so a
cross-venue OI sum double-counts by an unknown amount. Totals here are
labelled GROSS and the per-venue split is always carried alongside,
because the split is the honest object and the total is a convenience.

Volume is additive (a trade happens on exactly one venue); open interest
is not. They are treated differently on purpose.

OPEN INTEREST NOW COMES IN THREE STATES, NOT TWO. It used to be reported
(HL family) or absent (Lighter). Aster adds a third: COMPLETE EXCEPT FOR A
NAMED SET. Aster publishes no batch OI endpoint — proven, eight variants
probed — so a venue total is 547 sequential calls, measured at 305s. Sampling
the top 40 by volume was measured and REJECTED: it captures 93.99% of volume
but only 91.56% of open interest, and the miss is structural rather than
random (WLFIUSDT holds $10.2M of OI on $0.9M of volume, volume rank 53). So
datasources.aster runs the full census on a background cadence and this
snapshot reads whatever complete one exists, with its age. Until the first
lands, Aster's oi_usd is None — not a subset sum wearing a total's face.

Even complete, that census excludes 11 SETTLING markets whose OI endpoint
answers 400. So Aster reports oi_partial=True in steady state, and
`oi_incomplete` names the venue and the reason rather than merely counting
one. A partial figure wearing a complete one's face is the same failure as a
missing one wearing a zero's, and both are avoided by naming, not by hiding.

And ABSENCE ITSELF COMES IN MORE THAN ONE KIND. Lighter publishes no open
interest; Aster publishes it per symbol and simply has not been swept yet.
Both arrive here as oi_usd=None, and for a while both were emitted under the
one word "not published" — which told a reader that a covered venue was
uncovered, the same failure as a zero wearing an unknown's face, pointed the
other way. Each venue adapter now DECLARES `oi_publishes`, and
`_oi_missing_state` reports the declared reason rather than inferring one
from the null.
"""

import json
import time
import urllib.request

HL_INFO = "https://api.hyperliquid.xyz/info"
LIGHTER_STATS = "https://mainnet.zklighter.elliot.ai/api/v1/exchangeStats"
TIMEOUT = 30

# A venue with no volume and no open interest is DEPLOYED, not LIVE.
# Measured: 5 of 9 HIP-3 DEXs (flx, vntl, km, abcd, cash — 72 markets
# between them) are at exactly zero on both. Listing them beside real
# venues would pad the market count with markets nobody can trade.
LIVE_MIN_VOL_USD = 100_000.0

# Ten sequential HL calls in a burst get shed: measured, 6 of 10 venues
# failed when fired back-to-back while the whale sweep was also running.
# A short pace between them costs ~1s total and removes the failures.
PACE_S = 0.15
RETRIES = 2


def _hl(payload):
    req = urllib.request.Request(
        HL_INFO, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read())


def _f(x, d=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return d


def hl_dexs():
    """Every perp DEX on Hyperliquid: core plus HIP-3 builder deployments.

    `perpDexs` returns null in slot 0 for core HL — the venue with no name,
    which is easy to drop by accident and is also the reference venue.

    Returns (dexs, error). The error is NOT swallowed: when this one call is
    shed — measured during a boot prewarm burst — every HIP-3 deployment
    disappears at once, and the snapshot then reported 2 live venues, $3.98B,
    and ZERO failures. A complete-looking total missing the largest venue on
    it is the precise failure mode this module exists to prevent; it was just
    happening one level above where the guard was.
    """
    out = [{"key": "", "name": "HL core", "deployer": None}]
    err = None
    for attempt in range(RETRIES + 1):
        try:
            for d in _hl({"type": "perpDexs"}) or []:
                if not d:
                    continue                  # slot 0 = core, already added
                out.append({"key": d.get("name"), "name": d.get("name"),
                            "deployer": d.get("deployer")})
            return out, None
        except Exception as exc:
            err = str(exc)[:90]
            if attempt < RETRIES:
                time.sleep(0.4 * (attempt + 1))
    return out, err


def hl_venue(dex_key):
    """Markets, 24h volume and OI notional for one HL perp DEX."""
    payload = {"type": "metaAndAssetCtxs"}
    if dex_key:
        payload["dex"] = dex_key
    meta, ctxs = _hl(payload)
    names = [a.get("name") for a in (meta.get("universe") or [])]
    vol = oi = 0.0
    mkts = []
    for name, c in zip(names, ctxs or []):
        px = _f(c.get("midPx")) or _f(c.get("markPx"))
        v = _f(c.get("dayNtlVlm"))
        o = _f(c.get("openInterest")) * px
        vol += v
        oi += o
        mkts.append({"sym": name, "px": px or None, "vol": v, "oi": o,
                     "funding": _f(c.get("funding"), None)})
    mkts.sort(key=lambda m: -m["vol"])
    # `_all` is the FULL market list, kept so cross_venue can ask "does this
    # ticker have a second book anywhere" without a second round of calls.
    # snapshot() strips it out of anything that leaves this process.
    return {"markets": len(names), "vol_24h": vol, "oi_usd": oi,
            # See `_oi_missing_state`: a venue must DECLARE whether it
            # publishes open interest, because "we have not measured it yet"
            # and "this venue does not publish it" are different facts and a
            # null figure cannot tell them apart. The HL family publishes it
            # inline with every asset context.
            "oi_publishes": True,
            "top": mkts[:5], "_all": mkts}


def lighter():
    """zkLighter: 235 markets, open API, no auth.

    exchangeStats carries volume and last price but NOT open interest or
    funding — those need a per-market call. So Lighter contributes to the
    volume picture and market count honestly, and reports OI as unknown
    rather than zero, which would read as 'no positions'.
    """
    req = urllib.request.Request(LIGHTER_STATS,
                                 headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read())
    st = d.get("order_book_stats") or []
    mkts = []
    for m in st:
        v = _f(m.get("daily_quote_token_volume"))
        mkts.append({"sym": m.get("symbol"), "px": _f(m.get("last_trade_price")) or None,
                     "vol": v, "oi": None, "funding": None})
    mkts.sort(key=lambda m: -m["vol"])
    return {"markets": len(st),
            "vol_24h": _f(d.get("daily_usd_volume")),
            "oi_usd": None,                   # not published by this endpoint
            # The one venue here for which "not published" is TRUE. Declared
            # rather than inferred from the null, so a cold Aster census can
            # never be filed under the same state — see `_oi_missing_state`.
            "oi_publishes": False,
            # `oi_incomplete` names every venue short of a full OI figure and
            # prints its reason; Lighter had no reason to print, so the pane
            # could name the gap without ever explaining it.
            "oi_note": ("exchangeStats publishes no open interest field at "
                        "all — a per-market orderBookDetails call carries it "
                        "(xvenue fetches that per coin), so this is unknown, "
                        "not zero, and not a venue with no positions"),
            "trades_24h": d.get("daily_trades_count"),
            "top": mkts[:5], "_all": mkts}


def aster():
    """Aster (BNB chain): 547 perp markets, keyless, CEX-style REST.

    Delegated to datasources.aster, which owns the traps this venue carries:
    the 547-vs-700-vs-552 market count, the mixed 1h/4h/8h funding book
    (comparing raw rates ranks Aster's own extremes backwards), open interest
    quoted in contracts with no batch endpoint, three live markets with CJK
    names that a concatenated URL cannot fetch, the 11 SETTLING markets whose
    OI endpoint 400s, and quote assets that are USD-PEGGED rather than USD.

    Its OI arrives from a background census and is therefore None on a cold
    process for the first ~5 minutes. That is deliberate: see the module
    header on why a top-N sample was rejected.
    """
    from datasources import aster as _aster
    return _aster.venue()


def extended():
    """Extended (StarkNet L2): every market, volume, OI and funding in ONE
    call — the cheapest venue here to cover completely, and the only one
    whose open interest is a true census. Delegated to datasources.extended,
    which owns the 281-live-of-344-rows count (58 delisted, 2 reduce-only and
    3 SPOT rows are excluded from the venue but keep their residual open
    interest on the record), the openInterest-vs-openInterestBase units proof,
    the measured-hourly funding, and the markets that are legitimately shut
    for the night rather than illiquid.
    """
    from datasources import extended as _extended
    return _extended.venue()


# The reason a venue's open interest is missing, from the venue's OWN
# declaration — never inferred from the null, because a null cannot tell the
# two apart. MEASURED 2026-08-15: on a cold process both Aster and Lighter
# arrived here with oi_usd=None and were emitted with the identical state
# string "not published", while Aster publishes open interest per symbol
# keylessly (/fapi/v1/openInterest?symbol=BTCUSDT -> 6261.652 in the same
# minute) and Lighter's exchangeStats publishes none at all. Opposite
# realities under one word: a covered venue labelled uncovered, which is the
# house invariant inverted. The `why` string was already correct; only the
# state lied, and a consumer keying on the state — as the API contract
# invites — read Aster as a venue with no open-interest coverage.
#
# A venue whose adapter declares nothing gets neither claim.
def _oi_missing_state(v):
    """One of: not published / not yet measured / measurement failed /
    coverage undeclared. Never guessed."""
    pub = v.get("oi_publishes")
    if pub is False:
        return "not published"
    if pub is True:
        # It publishes; the figure is absent because THIS process has not
        # completed a measurement of it. That is a state you can wait out,
        # which is precisely what "not published" told the reader they could
        # not do.
        return "measurement failed" if v.get("oi_error") else "not yet measured"
    return "coverage undeclared"


def snapshot():
    """Every reachable on-chain perp venue, with the dead ones separated.

    A venue that FAILED to fetch is reported in `failed`, never silently
    dropped. The first version excluded error records from `live` without
    adding them anywhere, so 6 of 10 venues simply vanished from the
    response and the totals looked complete — absence reading as
    non-existence, which is the failure mode this whole codebase guards
    against everywhere else.
    """
    venues, dormant, failed = [], [], []
    dexs, dex_err = hl_dexs()
    if dex_err:
        # One failed discovery call hides EVERY HIP-3 venue, so it is reported
        # as a failure in its own right rather than as an empty result.
        failed.append({"venue": "HIP-3 dex discovery", "chain": "hyperliquid",
                       "error": dex_err,
                       "impact": "every HIP-3 venue (including xyz, the "
                                 "largest by volume) is missing from these "
                                 "totals"})
    for d in dexs:
        v = None
        for attempt in range(RETRIES + 1):
            try:
                v = hl_venue(d["key"])
                break
            except Exception as exc:
                err = str(exc)[:90]
                if attempt < RETRIES:
                    time.sleep(0.4 * (attempt + 1))
        if v is None:
            # An `error` string says something broke; it does not say what the
            # reader is now missing. The discovery failure above states its
            # impact and these did not, so a per-venue drop was the one
            # failure on this endpoint a reader could not size.
            failed.append({"venue": d["name"], "chain": "hyperliquid",
                           "error": err,
                           "impact": "%s contributes no volume, open interest "
                                     "or market count to these totals, and "
                                     "its markets are absent from the "
                                     "cross-listing index" % d["name"]})
            continue
        time.sleep(PACE_S)
        rec = {"venue": d["name"], "chain": "hyperliquid",
               "kind": "core" if not d["key"] else "hip3",
               "deployer": d.get("deployer"), **v}
        (venues if v["vol_24h"] >= LIVE_MIN_VOL_USD else dormant).append(rec)
    try:
        venues.append({"venue": "Lighter", "chain": "zklighter", "kind": "l2",
                       **lighter()})
    except Exception as exc:
        failed.append({"venue": "Lighter", "chain": "zklighter",
                       "error": str(exc)[:90],
                       "impact": "Lighter's 235 markets and ~$1.1B/24h are "
                                 "missing from the volume total and from the "
                                 "cross-listing index (it publishes no OI, so "
                                 "the OI total is unaffected)"})
    time.sleep(PACE_S)
    try:
        venues.append({"venue": "Aster", "chain": "bnb",
                       "kind": "perp-dex", **aster()})
    except Exception as exc:
        failed.append({"venue": "Aster", "chain": "bnb",
                       "error": str(exc)[:90],
                       "impact": "Aster's 547 markets and ~$0.86B/24h are "
                                 "missing from the volume total, from the OI "
                                 "total and from the cross-listing index — so "
                                 "any coin whose only second book is on Aster "
                                 "will read as SOLE when it is not"})
    time.sleep(PACE_S)
    try:
        venues.append({"venue": "Extended", "chain": "starknet", "kind": "l2",
                       **extended()})
    except Exception as exc:
        failed.append({"venue": "Extended", "chain": "starknet",
                       "error": str(exc)[:90],
                       "impact": "Extended's ~281 markets, ~$0.49B/24h and "
                                 "~$0.19B of open interest are missing from "
                                 "these totals and from the cross-listing "
                                 "index; roughly half of them are RWA "
                                 "(equity/metal/FX) perps that few other "
                                 "venues here list at all"})

    live = [v for v in venues if not v.get("error")]
    live.sort(key=lambda v: -(v.get("vol_24h") or 0))
    # Cross-listing index first — it is the only consumer of `_all`, and the
    # full market lists are dropped immediately after so the cached snapshot
    # does not carry 880 rows of markets nobody asked for.
    try:
        from datasources import cross_venue
        listings = cross_venue.build_index(live)
    except Exception:
        listings = {}
    for v in live:
        v.pop("_all", None)
    for v in dormant:
        v.pop("_all", None)
    vol = sum(v.get("vol_24h") or 0 for v in live)
    # Only venues that actually publish OI contribute to the gross figure,
    # and we say how many did — an OI total silently missing Lighter's
    # 235 markets would understate without ever admitting it.
    #
    # Three states, not two. Aster's oi_usd is real but it is a MEASURED
    # SUBSET of its 547 markets (no batch endpoint exists; a full sweep is
    # 299s), so it is counted apart from the venues whose OI arrives whole.
    # Summing them is still the right thing to do — a partial figure is a
    # better lower bound than a dropped one — but the reader has to be able
    # to see that the total is built from two different kinds of number.
    oi_venues = [v for v in live if v.get("oi_usd") is not None]
    oi_partial = [v for v in oi_venues if v.get("oi_partial")]
    oi_missing = [v for v in live if v.get("oi_usd") is None]
    oi = sum(v["oi_usd"] for v in oi_venues)
    return {
        "at": time.time(),
        "venues": live,
        # base ticker -> every venue listing it. Consumed by cross_venue and
        # stripped by api_venues, which is a market-structure view, not this.
        "listings": listings,
        "dormant": [{"venue": v["venue"], "markets": v.get("markets", 0)}
                    for v in dormant],
        "failed": failed,
        "totals": {
            "venues_live": len(live),
            "venues_dormant": len(dormant),
            # Non-zero means the figures below are INCOMPLETE, and by how many.
            "venues_failed": len(failed),
            "markets_live": sum(v.get("markets") or 0 for v in live),
            "markets_dormant": sum(v.get("markets") or 0 for v in dormant),
            "vol_24h": vol,
            "oi_usd_gross": oi,
            "oi_venues_reporting": len(oi_venues),
            "oi_venues_complete": len(oi_venues) - len(oi_partial),
            "oi_venues_partial": len(oi_partial),
            "oi_venues_missing": len(oi_missing),
            "oi_venues_total": len(live),
        },
        # Named, not just counted: "1 partial" tells a reader the total is
        # short without telling them by whom, and the by-whom is the part
        # that decides whether the shortfall matters to what they are
        # looking at.
        # `state` is now the venue's own declared reason, not a single word
        # covering every null — see _oi_missing_state. `publishes` carries
        # the raw declaration so a consumer can branch on the fact instead of
        # matching a string.
        "oi_incomplete": ([{"venue": v["venue"], "state": "partial",
                            "publishes": v.get("oi_publishes"),
                            "why": v.get("oi_note")} for v in oi_partial]
                          + [{"venue": v["venue"],
                              "state": _oi_missing_state(v),
                              "publishes": v.get("oi_publishes"),
                              "why": v.get("oi_note") or
                              ("this venue's adapter does not declare whether "
                               "it publishes open interest, so why the figure "
                               "is missing is UNKNOWN — it is not a measured "
                               "zero and it is not a venue known to withhold "
                               "it")} for v in oi_missing])
                         or None,
        "caveats": [
            "Volume is additive across venues; OPEN INTEREST IS NOT — a "
            "trader hedged on two venues is counted on both, so oi_usd_gross "
            "double-counts hedges by an unknown amount.",
            "Lighter's exchangeStats publishes no open interest, so it is "
            "absent from the OI total (see oi_venues_reporting).",
            "Aster publishes no batch OI endpoint, so its figure is a "
            "background per-symbol census — complete except for 11 SETTLING "
            "markets whose OI endpoint 400s, and absent entirely until the "
            "first census lands — which is reported as NOT YET MEASURED, a "
            "different state from Lighter's NOT PUBLISHED. oi_usd_gross is a "
            "LOWER BOUND either way (see oi_incomplete, which names who is "
            "short and why).",
            "Funding is an HOURLY decimal on every venue here: HL and "
            "Extended publish it natively hourly (Extended's interval was "
            "measured, not assumed), and Aster's is divided by each market's "
            "own declared interval — its book mixes 1h, 4h and 8h.",
            "Dormant venues are deployed but untraded, not broken.",
            "Any venue in `failed` is missing from every total here.",
        ],
    }
