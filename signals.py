"""Composite setup score + confluence badges across the tradeable universe.

Fuses signals the terminal already collects — no new data sources:

  momentum   24  24h move vs the liquid universe (percentile extremity)
  catalyst   23  nearest scheduled event <=7d, weighted by expected move
  funding    18  crowding vs the per-dex baseline (contrarian read)
  desk       18  research pipeline state (actionable > forming > watch)
  insider    17  EDGAR Form 4 open-market buy cluster (<=35d, recency-decayed)

Every scored row is evaluated on all five, so the ranking is never a function
of which rows happened to get an extra factor. EMA trend posture is attached
to the *returned* rows as an enrichment only — it is deliberately NOT scored,
because candles can only be fetched for a bounded subset (Hyperliquid throttles
wide bursts) and a factor that some rows cannot receive would distort the cut.

Scores are relative rankings of setup *interest*, not predictions, and the
uncalibrated inputs (desk interest level) stay labeled as such downstream.
"""

from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from zoneinfo import ZoneInfo

LIQUID_VOLUME = 1e6           # "price signals are trustworthy" threshold
TECHNICAL_ENRICH_N = 15       # rows that get a (display-only) trend read
FUNDING_BASELINE = 0.01       # HL structural funding, %/8h (see regime strip)
TECHNICAL_WORKERS = 3         # keep the burst narrow: HL throttles wide bursts
MAX_RESULTS = 20
CONFLUENCE_STEP = 0.15        # per extra confirming factor
ACTIVE_FRACTION = 0.25        # a factor "fires" above this share of its weight

W = {"momentum": 24, "catalyst": 23, "funding": 18, "desk": 18, "insider": 17}

# Funding baselines differ by sleeve: crypto perps sit near +0.01%/8h, the xyz
# equity perps near +0.005%. A single constant tilts a whole sleeve's direction.
FUNDING_BASELINES = {"crypto": 0.01, "equity": 0.005}
FUNDING_NOISE = 0.02          # |dev| below this is structural, not positioning
MOMENTUM_VOTE_PCTILE = 15     # only vote direction outside the middle 30%
INSIDER_FRESH_DAYS = 7        # full weight inside this, decayed after


def _pct_rank(sorted_vals, v):
    """Percentile (0-100) of v within an ascending list."""
    if not sorted_vals:
        return 50.0
    lo, hi = 0, len(sorted_vals)
    while lo < hi:
        mid = (lo + hi) // 2
        if sorted_vals[mid] < v:
            lo = mid + 1
        else:
            hi = mid
    return lo / len(sorted_vals) * 100.0


def _ema(vals, period):
    k = 2.0 / (period + 1)
    e = None
    for v in vals:
        e = v if e is None else v * k + e * (1 - k)
    return e


def _base(coin):
    return coin.split(":", 1)[1] if ":" in coin else coin


def _score_momentum(chg_pct, ranks, liq):
    """Extremity of the 24h move — mid-pack names score ~0.

    Scaled by `liq` because a big print on a thin book is noise, not momentum."""
    p = _pct_rank(ranks, chg_pct)
    strength = abs(p - 50) / 50.0
    # Mid-pack moves carry no directional information — stay silent rather than
    # letting a coin-flip percentile decide the row's displayed direction.
    vote = None
    if p >= 50 + MOMENTUM_VOTE_PCTILE:
        vote = "long"
    elif p <= 50 - MOMENTUM_VOTE_PCTILE:
        vote = "short"
    return strength * liq * W["momentum"], vote, round(p)


# Cross-venue dislocation bands, in APR points. 15 pts of HL-vs-CEX spread
# is structural noise; ~100 pts is maximal crowding. Chosen against the live
# distribution: median |disloc| ~2 pts, the crowded tail runs 50-200.
DISLOC_NOISE_APR = 15.0
DISLOC_FULL_APR = 100.0


def _score_funding(f8h, liq, sleeve="crypto", disloc_apr=None):
    """Crowding, contrarian: crowded longs -> short.

    Preferred measure: HL-vs-CEX funding dislocation (APR points). "Longs
    pay 60 points more HERE than on Binance/Bybit" is direct evidence the
    crowd is on this venue, where the hardcoded-baseline deviation only
    says funding is high in a vacuum — high-but-equal-everywhere funding is
    market-wide sentiment, not an HL-side crowd. Falls back to the baseline
    deviation when no CEX lists the coin (equity perps, HL-only alts).
    """
    if f8h is None:
        return 0.0, None, None, None
    dev = f8h - FUNDING_BASELINES.get(sleeve, 0.01)
    if disloc_apr is not None:
        strength = min(1.0, abs(disloc_apr) / DISLOC_FULL_APR)
        direction = None
        if abs(disloc_apr) > DISLOC_NOISE_APR:
            direction = "short" if disloc_apr > 0 else "long"
        return (strength * liq * W["funding"], direction, round(dev, 4),
                round(disloc_apr, 1))
    strength = min(1.0, abs(dev) / 0.05)
    # Only call positioning crowded once it clears the structural noise band.
    direction = None
    if abs(dev) > FUNDING_NOISE:
        direction = "short" if dev > 0 else "long"
    return strength * liq * W["funding"], direction, round(dev, 4), None


def market_today():
    """Event dates come from US calendars, so 'today' must be the ET date —
    a naive local date is a day ahead for most of the IST working day."""
    try:
        return datetime.now(ZoneInfo("America/New_York")).date()
    except Exception:
        return date.today()


def _days_until(dstr, today=None):
    try:
        d = date.fromisoformat(dstr)
    except (TypeError, ValueError):
        return None
    return (d - (today or market_today())).days


def _days_since(dstr, today=None):
    d = _days_until(dstr, today)
    return None if d is None else -d


def _score_catalyst(ev):
    if not ev:
        return 0.0, None
    days = ev.get("_days")
    move = ev.get("expected_move_pct") or 0
    if days is None or days < 0 or days > 7:
        return 0.0, None
    prox = 1.0 if days <= 1 else 0.8 if days <= 3 else 0.5
    mag = min(1.0, move / 6.0)
    score = prox * mag * W["catalyst"]
    if score <= 0:
        return 0.0, None      # no expected move -> nothing to weigh or badge
    return score, {"date": ev["date"], "days": days,
                   "type": ev["event_type"], "move_pct": move}


def _score_insider(cl, today=None):
    if not cl:
        return 0.0, None
    buyers = min(1.0, cl["n_insiders"] / 5.0)
    dollars = min(1.0, (cl["total_buy_usd"] or 0) / 5e6)
    raw = 0.6 * buyers + 0.4 * dollars
    age = _days_since(cl.get("last_buy"), today)
    decay = 1.0
    if age is not None and age > INSIDER_FRESH_DAYS:
        decay = max(0.4, 1.0 - (age - INSIDER_FRESH_DAYS) / 40.0)
    score = raw * decay * W["insider"]
    if score <= 0:
        return 0.0, None
    return score, {"n": cl["n_insiders"], "usd": cl["total_buy_usd"],
                   "last_buy": cl.get("last_buy"), "age_days": age,
                   "recency_factor": round(decay, 2)}


_DESK_W = {"actionable": 1.0, "setup_forming": 0.7, "watch": 0.35, "no_trade": 0.0}


DESK_FRESH_DAYS = 3     # full weight while the desk keeps re-confirming


def _score_desk(card, today=None):
    if not card:
        return 0.0, None, None
    base = _DESK_W.get(card.get("state"), 0.0)
    interest = card.get("llm_interest_level") or 0
    raw = base * (0.7 + 0.3 * (interest / 10.0))
    # Decay by card age, mirroring _score_insider. The pipeline refreshes
    # every 15 minutes, so a card the desk has not re-confirmed for days is
    # weaker evidence, not equal evidence — xyz:LITE was ranking #1 on a
    # 12-day-old card scored as if written this morning. Floor at 0.4 like
    # insider: a hard zero at two weeks would delete the factor for most of
    # the current board.
    age = _days_since(str(card.get("_created_at") or "")[:10], today)
    decay = 1.0
    if age is not None and age > DESK_FRESH_DAYS:
        decay = max(0.4, 1.0 - (age - DESK_FRESH_DAYS) / 20.0)
    return raw * decay * W["desk"], card.get("direction"), {
        "state": card.get("state"), "interest": interest,
        "entry_low": card.get("entry_low"), "entry_high": card.get("entry_high"),
        "invalidation": card.get("invalidation"),
        "age_days": age, "recency_factor": round(decay, 2)}


def _trend_read(closes):
    """EMA20/50 posture. DISPLAY ONLY — never enters the score (see module
    docstring): candles are fetchable for a bounded subset, and a factor some
    rows cannot receive would decide the cut by fetch-set membership."""
    if not closes or len(closes) < 120:
        return None
    px = closes[-1]
    e20, e50 = _ema(closes[-120:], 20), _ema(closes[-120:], 50)
    if e20 is None or e50 is None:
        return None
    if px > e20 > e50:
        return "uptrend px>EMA20>EMA50"
    if px < e20 < e50:
        return "downtrend px<EMA20<EMA50"
    if px > e20 and px > e50:
        return "above both EMAs"
    if px < e20 and px < e50:
        return "below both EMAs"
    return "chop"


def _badges(row):
    """High-conviction combinations worth surfacing on their own.

    Gated on the *scored* factors: a payload that contributed zero points is
    not evidence, and badges pin rows into the output."""
    out = []
    f = row["factors"]
    cat = row.get("catalyst") if f["catalyst"] > 0 else None
    ins = row.get("insider") if f["insider"] >= ACTIVE_FRACTION * W["insider"] else None
    desk = row.get("desk") if f["desk"] > 0 else None
    fund_dev = row.get("funding_dev")
    if ins and fund_dev is not None and fund_dev < -0.02:
        out.append({"tag": "SQUEEZE", "why": "insider buying into crowded shorts"})
    if cat and cat["days"] <= 3 and desk and desk["state"] in ("actionable", "setup_forming"):
        out.append({"tag": "EVENT+DESK", "why": "desk setup into a <=3d catalyst"})
    if ins and cat:
        out.append({"tag": "INSIDER+EVENT", "why": "insider cluster before a catalyst"})
    if cat and row.get("momentum_pct") is not None and \
            (row["momentum_pct"] >= 85 or row["momentum_pct"] <= 15):
        out.append({"tag": "TREND+EVENT", "why": "extended trend into a catalyst"})
    return out


def _apply_confluence(row):
    """Reward breadth of confirmation: several factors firing together beats
    one axis maxed out. Multiplier grows with the number of active factors."""
    active = sum(1 for k, v in row["_exact"].items()
                 if v >= ACTIVE_FRACTION * W[k])
    return row["_base_score"] * (1 + CONFLUENCE_STEP * max(0, active - 1))


def _resolve_direction(votes):
    votes = [v for v in votes if v]
    if not votes:
        return None
    longs = votes.count("long")
    shorts = votes.count("short")
    if longs > shorts:
        return "long"
    if shorts > longs:
        return "short"
    return "mixed"


def compute(universe, events, cards, insider_clusters, candle_fn,
            events_ok=True, funding_x=None):
    """Rank the universe. `candle_fn(coin) -> [closes]` is called for the
    top TECHNICAL_TOP_N only (two-pass), so cost stays bounded."""
    ctxs = {}
    ctxs.update(universe.get("crypto") or {})
    ctxs.update(universe.get("equity") or {})

    # --- lookups -------------------------------------------------------
    today = market_today()
    ev_by_coin = {}
    for e in events:
        coin = e.get("hl_coin")
        if not coin or not e.get("tradeable"):
            continue
        days = _days_until(e.get("date"), today)
        if days is None or days < 0 or days > 7:
            continue
        e = dict(e, _days=days)          # annotate a copy; never mutate the cache
        cur = ev_by_coin.get(coin)
        if cur is None or days < cur["_days"]:
            ev_by_coin[coin] = e

    card_by_coin = {}
    for c in cards:
        a = c.get("asset")
        if a:
            card_by_coin[a] = c

    ins_by_base = {c["ticker"]: c for c in (insider_clusters or [])}

    # --- candidate rows -------------------------------------------------
    # A name qualifies on liquidity OR on a hard scheduled/filed signal:
    # the most interesting setups (earnings tomorrow, insider cluster) are
    # often on thin equity perps that a pure volume floor would discard.
    rows = []
    chg_liquid = []
    equity_coins = set(universe.get("equity") or {})
    for coin, c in ctxs.items():
        mid, prev = c.get("mid_px"), c.get("prev_day_px")
        if not (mid and prev):
            continue
        vol = c.get("day_volume") or 0
        base = _base(coin)
        has_hard = (coin in ev_by_coin or coin in card_by_coin or
                    base in ins_by_base)
        if vol < LIQUID_VOLUME and not has_hard:
            continue
        chg = (mid - prev) / prev * 100.0
        if vol >= LIQUID_VOLUME:
            chg_liquid.append(chg)      # ranks computed over liquid names only
        rows.append({"coin": coin, "base": base, "mid": mid,
                     "sleeve": "equity" if coin in equity_coins else "crypto",
                     "chg_pct": round(chg, 2), "volume": vol,
                     "thin": vol < LIQUID_VOLUME,
                     "liq": round(min(1.0, vol / LIQUID_VOLUME), 2),
                     "funding_8h_pct": (c["funding"] * 8 * 100
                                        if c.get("funding") is not None else None)})
    chg_liquid.sort()

    # --- pass 1: the five universally-available factors -----------------
    for r in rows:
        votes = []
        liq = r["liq"]
        s_mom, d_mom, p_mom = _score_momentum(r["chg_pct"], chg_liquid, liq)
        r["momentum_pct"] = p_mom
        votes.append(d_mom)

        fx = (funding_x or {}).get(r["coin"]) or {}
        s_fund, d_fund, dev, disloc = _score_funding(
            r["funding_8h_pct"], liq, r["sleeve"], fx.get("disloc_apr"))
        r["funding_dev"] = dev
        r["funding_disloc_apr"] = disloc
        votes.append(d_fund)

        ev = ev_by_coin.get(r["coin"])
        s_cat, cat = _score_catalyst(ev)
        r["catalyst"] = cat

        s_ins, ins = _score_insider(ins_by_base.get(r["base"]), today)
        r["insider"] = ins

        s_desk, d_desk, desk = _score_desk(card_by_coin.get(r["coin"]))
        r["desk"] = desk
        votes.append(d_desk)

        # unrounded values drive the confluence test; rounding is display only
        r["factors"] = {"momentum": round(s_mom, 1), "funding": round(s_fund, 1),
                        "catalyst": round(s_cat, 1), "insider": round(s_ins, 1),
                        "desk": round(s_desk, 1)}
        r["_exact"] = {"momentum": s_mom, "funding": s_fund, "catalyst": s_cat,
                       "insider": s_ins, "desk": s_desk}
        r["_votes"] = votes
        r["_base_score"] = s_mom + s_fund + s_cat + s_ins + s_desk
        r["score"] = _apply_confluence(r)

    rows.sort(key=lambda r: r["score"], reverse=True)

    # --- finalize -------------------------------------------------------
    for r in rows:
        r["badges"] = _badges(r)
    # Confluence rows are the whole point of the tab — never let one fall off
    # the cut just because it trades thin.
    chosen = rows[:MAX_RESULTS]
    chosen_ids = {id(r) for r in chosen}
    pinned = [r for r in rows[MAX_RESULTS:] if r["badges"] and id(r) not in chosen_ids]
    chosen = sorted(chosen + pinned[:5], key=lambda r: r["score"], reverse=True)

    # Trend posture: enrichment for the rows actually shown, after ranking is
    # settled, so a throttled fetch can never reorder anything.
    if candle_fn:
        targets = chosen[:TECHNICAL_ENRICH_N]
        with ThreadPoolExecutor(max_workers=TECHNICAL_WORKERS) as pool:
            reads = list(pool.map(lambda r: _trend_read(candle_fn(r["coin"])), targets))
        for r, note in zip(targets, reads):
            r["trend"] = note

    out = []
    for r in chosen:
        r["direction"] = _resolve_direction(r.pop("_votes"))
        r.pop("_base_score", None)
        r.pop("_exact", None)
        r["score"] = round(r["score"], 1)
        top = sorted(r["factors"].items(), key=lambda kv: kv[1], reverse=True)
        r["top_factors"] = [k for k, v in top if v > 0][:2]
        out.append(r)
    return {"signals": out, "weights": W,
            "universe_scored": len(rows),
            "trend_enriched": sum(1 for r in out if r.get("trend")),
            "events_ok": events_ok}
