"""Does this instrument have a second book anywhere, and how big is it?

WHY THIS EXISTS: at a $5-10k clip, fill cost is noise — measured impact is
0.001% on BTC and 0.046% on JUP, and the xyz top markets quote 0.13-3.24 bps.
What is NOT noise is whether a market has a fallback book at all. Three of the
largest markets this terminal covers — xyz:SKHX, xyz:SP500, xyz:XYZ100 — trade
essentially nowhere else on earth. If that book pulls, there is no second
venue to be filled on at any price, and that is a POSITION-SIZING fact, not an
execution fact.

MATCHING DOCTRINE — the part that is easy to get wrong:

  PRICE IS A VERIFIER, NEVER A MATCHER.

Matching by price agreement was measured and rejected: at a 0.5% tolerance
over markets above $1M/24h it proposes core:AAVE ($85.92) == xyz:BRENTOIL
($85.55) and core:ZEC ($485.22) == xyz:AMD ($484.72). Those are not the same
asset. So grouping is by BASE TICKER only, and price is used solely to REFUTE
a group: core:STX is Stacks at $0.12 while para:STX is a different asset at
$944, and the price check splits them apart with the disagreement stated.

There is deliberately NO alias table here. Real cross-listings under a
different ticker (GOLD/XAU, CL/WTI) are therefore NOT detected, and the module
says so in `note` on every response rather than letting a SOLE verdict imply
a search that was never run. A hand-maintained alias list is exactly the
failure mode this codebase already suffers from in six other collectors; a
verdict that admits its own blind spot is worth more than one that hides it.

WHERE A BASE TICKER COMES FROM, and why that is not an alias table. HL names
its markets `BTC` and `xyz:TSLA`, so a split on ":" is the whole job. Aster
names the same instrument `BTCUSDT` and Extended names it `BTC-USD`, so a
ticker split alone would index them as "BTCUSDT" and "BTC-USD" and they would
never match core "BTC" — every Aster and Extended listing would be invisible
to this index and every coin would read one venue thinner than it is. The fix
is NOT a mapping written here: both venues PUBLISH their own base asset
(Aster's exchangeInfo.baseAsset, Extended's assetName), and a venue adapter
passes that declaration through as `base`. That is the venue naming its own
underlying, which is evidence; a table in this file asserting BTCUSDT==BTC
would be a guess. `base_ticker(sym)` remains the fallback for any row whose
venue declares nothing.

The residual blind spot is real and is stated rather than smoothed over:
Aster's 1000PEPEUSDT declares base 1000PEPE and so DOES match HL core's
1000PEPE, but Extended's TSLA_24_5 declares TSLA_24_5 and will NOT match
HL xyz:TSLA — deciding those are one instrument is precisely the judgement
no code here is permitted to make unilaterally.
"""

# Second-venue share below this is a listing, not a fallback.
THIN_PCT = 5.0
# Above this, the home venue is effectively the only book.
SOLE_PCT = 99.0
# Price agreement that VERIFIES a ticker match.
PRICE_TOL_PCT = 1.0

# Price disagreement that REFUTES one. These used to be the same number, and
# that is the whole of defect C2(b): everything past the verify tolerance was
# asserted to be a different asset. MEASURED 2026-08-17, live, both same-asset
# and both excluded by that rule: Aster TONUSDT (943 bps, status SETTLING) and
# Aster HYUNDAIUSDT (356 bps, status TRADING, home market off-session). The
# genuine different-asset cases this module's own docstring cites are four
# orders of magnitude away — core:STX $0.12 vs para:STX $944 is 7.8e6 bps, and
# Lighter's WON-quoted HYUNDAI mark is ~1.6e6 bps off its home. So a gap is
# evidence about a PRICE until it is large enough to be evidence about
# IDENTITY, and between the two the honest answer is neither.
REFUTE_PCT = 50.0

# How many other listings a board shows beside the home venue.
OTHERS_SHOWN = 3

# ONE VENUE MUST NOT OCCUPY TWO SLOTS WHILE ANOTHER OCCUPIES NONE.
# MEASURED 2026-08-15 on SOL: ranking the other listings by volume alone and
# taking the top 3 produced [Aster SOLUSDT, Lighter SOL, Aster SOLUSD1], and
# Extended's genuine SOL-USD ($7,386,976 of 24h volume, $8,215,499 of open
# interest) was invisible — pushed off the board by the SAME venue's tiny
# alternate-collateral listing. The board answers "where else can I trade
# this"; a second quote-asset variant of a venue already shown answers that
# question far less than the first listing of a venue not shown at all.
# So the pass is breadth-first: every venue's largest listing competes for a
# slot first, and only then do second listings from an already-shown venue.
# Nothing is dropped silently — whatever the cap excludes is returned in
# `others_hidden`, named, with the reason it lost its slot.
OTHERS_RULE = ("one listing per venue — its largest by 24h volume — before "
               "any venue takes a second slot; the rest are named in "
               "others_hidden rather than dropped")

NOTE = ("matched by base ticker. Price is a three-state verifier, never a "
        "matcher: agreement within %.0f%% VERIFIES, a gap past %.0f%% REFUTES "
        "(excluded, see `split`), and everything between — plus any listing "
        "whose price is missing — is kept as UNVERIFIED and named in "
        "`px_unverified`. A second listing under a DIFFERENT ticker (e.g. "
        "GOLD/XAU, CL/WTI) is not detected — no alias table is maintained, "
        "because price cannot safely discover one."
        % (PRICE_TOL_PCT, REFUTE_PCT))


def base_ticker(sym):
    """`xyz:SNDK` -> `SNDK`; `SNDK` -> `SNDK`."""
    return str(sym or "").split(":")[-1].strip().upper()


def index_key(coin, idx):
    """The key `coin` lives under in a built index.

    `base_ticker` answers for HL-style names. It does not answer for
    BTCUSDT or BTC-USD, whose key came from the venue's own declaration and
    cannot be recovered from the string — so when the ticker split misses,
    the index itself is asked which key holds this exact symbol. That is a
    lookup of a fact already recorded, not an inference.
    """
    b = base_ticker(coin)
    if not idx or b in idx:
        return b
    for key, rows in idx.items():
        for r in rows:
            if r.get("sym") == coin:
                return key
    return b


def build_index(venues):
    """{base ticker: [listing, ...]} over every market of every live venue.

    `venues` is the list of per-venue records produced by venues.snapshot(),
    each carrying its FULL market list under `_all`. Built once per venue
    snapshot (5-minute cache), so this costs no upstream call of its own.
    """
    idx = {}
    for v in venues or []:
        name = v.get("venue")
        for m in v.get("_all") or []:
            sym = m.get("sym")
            if not sym:
                continue
            # The venue's OWN base-asset declaration wins over a ticker
            # split; see the module docstring on why that is evidence and a
            # table here would not be. HL rows carry no `base` and fall
            # through to base_ticker, which is exactly right for them.
            key = str(m.get("base") or base_ticker(sym)).strip().upper()
            idx.setdefault(key, []).append({
                "venue": name, "sym": sym,
                "vol": float(m.get("vol") or 0.0),
                "px": m.get("px"),
                # Retained for the per-coin cross-venue view (xvenue): OI and
                # funding are already FETCHED for every HL-family market by
                # hl_venue() and were dropped right here, which forced any
                # cross-venue comparison to refetch what this process had
                # already paid for. Lighter rows carry None for both — its
                # exchangeStats endpoint does not publish them — and None
                # must survive: "not published" is not "measured zero".
                "oi": m.get("oi"),
                "funding": m.get("funding"),
                # `listings` is the ONLY per-market data that survives into
                # the cached snapshot — venues.snapshot() pops `_all` right
                # after building this index — so anything the per-coin
                # compare needs has to be carried here or it is gone. Three
                # fields earn that, each for a stated reason:
                #
                #   sym_native  the symbol the venue's own REST endpoints
                #               answer to. Today every venue's `sym` IS its
                #               native name (Aster BTCUSDT, Extended
                #               BTC-USD) and this falls through to it. It
                #               exists because the INDEX key and the FETCH
                #               key are different questions — the moment a
                #               venue adapter prefixes its symbols to
                #               disambiguate the index, its book endpoint
                #               still answers only to the raw name, and the
                #               compare silently 404s. Carrying the fetch
                #               key explicitly costs one field and removes
                #               that whole class of failure.
                #   off_hours   an Extended equity perp outside its cash
                #               session has a legitimately thin book. That
                #               is a MEASURED state of the market, and it
                #               must not be rendered as a failed fetch or as
                #               an illiquid venue.
                #   status      the venue's own lifecycle string. An Aster
                #               SETTLING market answers HTTP 400 on
                #               openInterest BY DESIGN; knowing that here is
                #               what stops the per-coin compare spending a
                #               call to rediscover it and then reporting the
                #               400 as a fault.
                "sym_native": m.get("sym_native") or sym,
                "off_hours": m.get("off_hours"),
                "status": m.get("status"),
            })
    return idx


def _px_diff_bps(a, b):
    if not a or not b:
        return None
    try:
        return abs(a / float(b) - 1.0) * 1e4
    except ZeroDivisionError:
        return None


def _disagree_cause(r, home):
    """Why two prices for one asset can legitimately differ — read off the
    `status` / `off_hours` fields build_index ALREADY carries, so this costs
    no call. Naming the cause is the difference between a reader who sizes
    around a closed session and one who is told the venue trades something
    else entirely."""
    bits = []
    for who, row in (("this listing", r), ("the home listing", home)):
        st = row.get("status")
        if st and str(st).upper() not in ("TRADING", "ACTIVE", "OPEN"):
            bits.append("%s reports status %s" % (who, st))
        if row.get("off_hours"):
            bits.append("%s is outside its cash session" % who)
    if bits:
        return ("%s, and a mark that is stale or scheduled-thin drifts"
                % "; ".join(bits))
    return ("both venues report a live session, so the gap is unexplained — "
            "worth checking before sizing against this book")


def _px_verdict(d, r, home):
    """(status, sentence) — 'verified' / 'unchecked' / 'disagrees' / 'refuted'.

    THE VERIFIER HAD TWO STATES AND BOTH WERE WRONG AT AN EDGE.

    A missing price returned None and fell straight through to the ACCEPT
    path, so an unchecked row was indistinguishable from a checked one.
    MEASURED 2026-08-17: Lighter's WON-quoted HYUNDAI publishes no
    last_trade_price at all, so it joined as a verified comparable — and was
    then enriched with a dollar OI 1,570x too large. A control that can
    silently skip while still reporting success is not a control, so "we did
    not look" now has its own state and says so on the row.

    At the other edge, refuting at the SAME tolerance it verifies at turned
    every price gap into an identity claim — see REFUTE_PCT for the two live
    same-asset listings that were excluded that way, after which the verdict
    told the reader no second book existed.

    Only 'refuted' removes a listing. 'disagrees' and 'unchecked' both keep
    it, carrying the reason, because an unrefuted listing is a book that
    exists and SOLE must never be computed as though it did not.
    """
    if d is None:
        miss = "this venue" if not r.get("px") else "the home venue"
        return ("unchecked",
                "price NOT verified — %s publishes no price in the venue "
                "snapshot, so the identity check never ran on this row. This "
                "listing is neither confirmed nor refuted." % miss)
    if d <= PRICE_TOL_PCT * 100:
        return ("verified", None)
    if d > REFUTE_PCT * 100:
        return ("refuted",
                "same ticker, DIFFERENT asset — %.0f bps apart, far past any "
                "session, staleness or quote-currency explanation; excluded"
                % d)
    return ("disagrees",
            "price DISAGREES by %.0f bps, past the %.0f%% verify tolerance: "
            "%s. NOT refuted — a gap this size is a fact about a price, not "
            "about identity, so this listing still counts as a second book."
            % (d, PRICE_TOL_PCT, _disagree_cause(r, home)))


def _rank_others(others):
    """(shown, hidden) — breadth-first over venues, see OTHERS_RULE.

    `others` must already be sorted by volume, descending. Returns the rows
    the board shows and a compact record of every row it does not, each
    carrying WHY it lost its slot: a venue's second listing that lost to
    another venue's first is a different fact from a listing that was simply
    smaller than everything shown, and the reader can act on the first.
    """
    first, extra, seen = [], [], set()
    for o in others:
        (extra if o["venue"] in seen else first).append(o)
        seen.add(o["venue"])
    ordered = first + extra
    # WHICH rows get a slot is breadth-first; the ORDER they are presented in
    # is plain size, because a board ranked by anything else invites the
    # reader to infer a ranking rule that does not exist. The two sublists
    # are each volume-sorted but their concatenation is not, so re-sort.
    shown = sorted(ordered[:OTHERS_SHOWN], key=lambda o: -(o.get("vol") or 0))
    shown_sym = {}
    for o in shown:
        shown_sym.setdefault(o["venue"], o["sym"])
    hidden = []
    # Largest omission first: on SOL the reader needs to meet Aster's
    # $14.9M SOLUSD1 before a $4k hyna listing, or the sentence buries the
    # only omission that could change a decision.
    for o in sorted(ordered[OTHERS_SHOWN:], key=lambda o: -(o.get("vol") or 0)):
        sib = shown_sym.get(o["venue"])
        hidden.append({
            "venue": o["venue"], "sym": o["sym"], "vol": o.get("vol"),
            "share_pct": o.get("share_pct"),
            "why": ("%s already holds a slot with its larger %s listing, and "
                    "one venue takes a second slot only after every other "
                    "venue has one" % (o["venue"], sib)) if sib else
                   ("smaller than the %d listing(s) shown" % len(shown)),
        })
    return shown, hidden


def classify(idx, coin):
    """Where else does `coin` trade, and is that second book a real fallback?

    Returns a verdict even when the index is missing or the ticker is absent —
    the caller must be able to print SOMETHING that distinguishes "no second
    venue" from "we did not look".
    """
    base = index_key(coin, idx)
    if not idx:
        return {"base": base, "state": "UNKNOWN", "others": [], "split": [],
                "note": "venue snapshot unavailable — cross-listing not checked"}
    rows = idx.get(base) or []
    home = None
    for r in rows:
        if r["sym"] == coin:
            home = r
            break
    if home is None:
        # The coin is not in the venue snapshot at all (dormant venue, or a
        # market listed since the last refresh). Say that, do not say SOLE.
        return {"base": base, "state": "UNKNOWN", "others": [], "split": [],
                "note": "%s not present in the last venue snapshot — "
                        "cross-listing not checked" % coin}

    others, split = [], []
    for r in rows:
        if r is home:
            continue
        d = _px_diff_bps(r.get("px"), home.get("px"))
        status, why_px = _px_verdict(d, r, home)
        if status == "refuted":
            # Same ticker, different asset. Refuted, and the refutation is
            # reported — a silent drop would read as "there is no other book".
            split.append({**r, "px_diff_bps": round(d),
                          "px_verified": status, "px_note": why_px})
            continue
        others.append({**r, "px_diff_bps": None if d is None else round(d, 1),
                       "px_verified": status, "px_note": why_px})

    total = (home["vol"] or 0.0) + sum(o["vol"] for o in others)
    for o in others:
        o["share_pct"] = round(o["vol"] / total * 100.0, 1) if total else None
    others.sort(key=lambda o: -(o["vol"] or 0))
    home_share = round(home["vol"] / total * 100.0, 1) if total else None

    best = others[0]["share_pct"] if others else 0.0
    if not others:
        state = "SOLE"
    elif home_share is not None and home_share >= SOLE_PCT:
        state = "SOLE"
    elif (best or 0) >= THIN_PCT:
        state = "TWIN"
    else:
        state = "THIN-2ND"

    # `best` and `state` above are decided on the FULL sorted list — the
    # display cap must never change a verdict, only what is drawn.
    shown, hidden = _rank_others(others)
    # Every kept row whose price the verifier could not confirm, named. The
    # cap must not hide this either: a reader deciding whether a fallback
    # exists needs the unverified ones as much as the shown ones.
    unver = [{"venue": o["venue"], "sym": o["sym"],
              "px_verified": o.get("px_verified"),
              "px_diff_bps": o.get("px_diff_bps"),
              "why": o.get("px_note")}
             for o in others if o.get("px_verified") != "verified"]
    return {
        "base": base, "home": home, "state": state,
        "home_share_pct": home_share,
        "others": shown, "n_others": len(others),
        "others_hidden": hidden or None,
        "others_rule": OTHERS_RULE,
        "split": split,
        "total_vol_24h": total,
        "note": NOTE,
        "px_unverified": unver or None,
        "px_unverified_note": (
            "%d of the %d other listing(s) kept here did NOT pass the price "
            "check — see px_unverified. They are counted because nothing "
            "refuted them, not because anything confirmed them."
            % (len(unver), len(others))) if unver else None,
        "why": _why(state, home_share, others, split),
    }


def _why(state, home_share, others, split):
    """The sentence under the verdict. SOLE HAS TWO MEANINGS AND ONLY ONE OF
    THEM IS "there is no other book".

    MEASURED 2026-08-17 on xyz:HYUNDAI: the home venue held 99.6% of 24h
    volume, so the verdict was SOLE — and the why-string said "if this book
    pulls there is no other book to be filled on" while Aster's HYUNDAIUSDT
    was TRADING at that instant. That sentence is the one a reader sizes a
    position against, so SOLE-by-share and SOLE-by-absence cannot share it,
    and a SOLE reached by REFUTING every other listing has to say which
    listings it threw away.
    """
    if state == "TWIN":
        return "a second venue carries >=%.0f%% — a real fallback" % THIN_PCT
    if state == "THIN-2ND":
        return ("a second listing exists but carries <%.0f%% — it is a "
                "listing, not a fallback" % THIN_PCT)
    if state == "UNKNOWN":
        return "not checked"
    if others:
        return ("one venue carries %s%% of the 24h volume, so nothing else "
                "is a fallback AT SIZE — but %d other listing(s) DO exist "
                "(largest: %s %s at %s%%). This is not 'no second book'."
                % (home_share, len(others), others[0]["venue"],
                   others[0]["sym"], others[0].get("share_pct")))
    if split:
        return ("no other listing of this ticker survived the price check — "
                "%d refuted as a different asset (see `split`). Of what "
                "remains, this is the only book: if it pulls there is "
                "nothing to be filled on." % len(split))
    return ("one venue carries essentially all of it — if this book pulls "
            "there is no other book to be filled on")
