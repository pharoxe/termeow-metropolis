"""Validated-edge verdicts, attached to live signals.

The signals pane ranks setups 0-100. A score is a measure of *confluence*
— how many factors agree right now — and says nothing about whether that
kind of setup has ever made money. Those are different questions, and the
terminal previously answered only the first, which quietly invites the
reader to treat a 100 as an edge.

This module answers the second from the recorded walk-forward research:
which setup families were validated, which were tested and REJECTED, and
which were never tested at all. Most long families here are NO-GO — that
is the single most useful thing the terminal can tell you, because it is
exactly the signal a high score would otherwise talk you into.

PROVENANCE, stated plainly: these are recorded verdicts from research runs
(block-bootstrap + Deflated-Sharpe, Protocol v1), not numbers recomputed
live. The crypto research repo that produced them is no longer on this
machine, so nothing here can refresh itself. Every record carries `as_of`
and the UI shows its age — a verdict is evidence with a date on it, not a
standing fact.
"""

import time

VALIDATED = "validated"
NO_GO = "no-go"
UNTESTED = "untested"

# Beyond this, a verdict is old enough that decay is a live possibility and
# the pane says so. The forward_expectancy_monitor that would have caught
# decay lived in the retired repo.
STALE_DAYS = 90

_D = 86400.0


def _ts(y, m, d):
    return time.mktime((y, m, d, 12, 0, 0, 0, 0, -1))


# One record per setup family that the live signals can actually produce.
# `match` is evaluated against a signal row; first match wins, so order is
# specific-to-general.
REGISTRY = [
    {
        "id": "crypto-short-momentum-breakdown",
        "label": "short momentum breakdown",
        "verdict": VALIDATED,
        "expectancy_r": 0.208,
        "win_rate": 59.4,
        "n": 731,
        "method": "production quality-gated cohort; block-bootstrap + DSR "
                  "(Protocol v1). Raw un-gated +0.0805R/trade agrees in sign.",
        "as_of": _ts(2026, 6, 15),
        "note": "The whole book's return came from this family: +272R over "
                "2.3y, ann. Sharpe 2.47, broad across 56/86 assets. It is a "
                "high-hit-rate +1R machine — 94% of win-R comes from T1 hits, "
                "only 6% from runners, so exits matter more than entries.",
        "caveat": "Derived on 4h bars over a 50-asset universe. A live signal "
                  "here is the same DIRECTION and family, not the same "
                  "instrument or timeframe — treat the number as prior, not "
                  "promise.",
        "match": lambda r: r.get("sleeve") == "crypto" and r.get("direction") == "short"
                 and _momentum_driven(r),
    },
    {
        "id": "crypto-long-momentum",
        "label": "long momentum / breakout",
        "verdict": NO_GO,
        "expectancy_r": -0.0186,       # -63.2R over the same 2.3y book
        "win_rate": None,
        "n": None,
        "method": "same backtest as the short leg; PF 0.97",
        "as_of": _ts(2026, 6, 15),
        "note": "-63.2R over 2.3y — pure drag. Pooled with the short book it "
                "nearly DOUBLED drawdown (352R vs 178R) for negative return. "
                "Short-only beat short+long on every axis.",
        "caveat": "Longs were drag, not diversification. A high long score "
                  "here is confluence, not evidence.",
        "match": lambda r: r.get("sleeve") == "crypto" and r.get("direction") == "long"
                 and _momentum_driven(r),
    },
    {
        "id": "crypto-funding-extreme",
        "label": "funding-extreme / crowded positioning",
        "verdict": NO_GO,
        "expectancy_r": None,
        "win_rate": None,
        "n": None,
        "method": "rejected as a standalone family in the second-short-edge "
                  "sweep; direct test blocked — no funding history retained",
        "as_of": _ts(2026, 6, 15),
        "note": "One of 4 candidate second-short families; all were below "
                "matched-random and every edge-minus-random CI included 0 "
                "(DSR@50 ~ 0). The funding variant could not even be tested "
                "properly for lack of stored funding history.",
        "caveat": "Crowding is real market structure and useful as CONTEXT; "
                  "it has never been shown to stand alone as an entry.",
        "match": lambda r: r.get("sleeve") == "crypto" and _funding_driven(r),
    },
    {
        "id": "crypto-long-reclaim",
        "label": "capitulation / reclaim long",
        "verdict": NO_GO,
        "expectancy_r": None,
        "win_rate": None,
        "n": None,
        "method": "temporal holdout; edge-minus-random CI [-0.24, +0.43]",
        "as_of": _ts(2026, 6, 15),
        "note": "The most promising long thread of ~50 configs across 4 "
                "families. On a temporal holdout its edge-minus-random CI "
                "INCLUDES ZERO — it beats its mirror only because of down-"
                "regime drift. A dedicated leak audit found no leak; the "
                "edge simply is not there.",
        "caveat": "This is the trap the research kept re-finding: bull/bear "
                  "drift reading as alpha.",
        "match": lambda r: r.get("sleeve") == "crypto" and r.get("direction") == "long",
    },
    {
        "id": "flow-divergence",
        "label": "CVD / price divergence",
        "verdict": NO_GO,
        "expectancy_r": None,
        "win_rate": None,
        "n": 44177,
        "method": "direct port of the terminal's own flowDivergence() run over "
                  "60,452 coin-minutes; 90 variants in its family, matched "
                  "control + block bootstrap",
        "as_of": _ts(2026, 8, 13),
        "note": "Tested because the terminal was DRAWING it: gross edge "
                "-0.0045% to +0.0027% per trade, and in the persistent form "
                "actually displayed, negative at 4 of 5 horizons. Divergence "
                "bars are also QUIETER than average (mean forward range "
                "0.96-0.99x baseline), so it is not a volatility trigger "
                "either.",
        "caveat": "The observation is real — flow and price genuinely do "
                  "diverge — it simply carries no forecast. The annotation is "
                  "now rendered neutral and labelled descriptive.",
        "match": lambda r: False,      # not a signal family; registry entry
                                       # exists so the verdict is recorded
    },
    {
        "id": "minute-flow-direction",
        "label": "minute order-flow direction (any horizon 1-15m)",
        "verdict": NO_GO,
        "expectancy_r": None,
        "win_rate": None,
        "n": 60452,
        "method": "534 hypotheses across 6 families; block bootstrap, "
                  "temporal holdout, Bonferroni, look-ahead audit",
        "as_of": _ts(2026, 8, 13),
        "note": "Best gross edge anywhere in the search was +0.0053%/trade "
                "against a 0.09% round trip — the FEE IS 17x THE EDGE. Only "
                "7.8-15.8% of 1-minute bars move more than the round trip at "
                "all, so a perfect oracle loses money on the rest. Zero of "
                "534 hypotheses had a positive net edge.",
        "caveat": "Not a fee-tier problem: at max HL discounts it is still "
                  "negative, and at ZERO fees the edge is smaller than the "
                  "spread you must cross.",
        "match": lambda r: False,
    },
    {
        "id": "horizontal-sr-levels",
        "label": "horizontal support / resistance levels",
        "verdict": NO_GO,
        # 59.2% of fresh touches reject — and so do 60.0% of touches on
        # displaced-random prices. A touch-rejection rate is NOT a trade win
        # rate and must not share the field the pane prints as "% WR"; both
        # numbers live in `note`, where neither can appear without the other.
        "expectancy_r": None,
        "win_rate": None,
        # The units here are pre-registered cells and touches, not trades, so
        # a bare "n=" would claim the wrong thing. Counts are in `method`.
        "n": None,
        "method": "266 pre-registered cells over 9 instruments, every method "
                  "scored against a DISPLACED-RANDOM level control with a 95% "
                  "block-bootstrap CI. The harness had power: a lookahead "
                  "swing-pivot oracle scores +6.22pp [+3.9, +8.7] and "
                  "lookahead window extremes +38.7pp, against honest-method "
                  "CI half-widths of 2.0-2.5pp.",
        "as_of": _ts(2026, 8, 15),
        "note": "NO horizontal S/R method beat its matched control. Real "
                "levels reject 59.20% of fresh touches; displaced-random "
                "levels reject 60.03% — edge minus control -0.83pp, 95% CI "
                "[-2.22, +0.58]. The decisive diagnostic is that real levels "
                "and random nearby prices are touched at an IDENTICAL 2.38 "
                "fresh touches per level per fold: real levels are not even "
                "VISITED more often than arbitrary prices, so the folk "
                "'~60% of touches bounce' number is entirely baseline. Three "
                "sub-hypotheses were tested and also refuted — touch-count "
                "ranking runs BACKWARDS (2 touches 61.48%, 8+ touches "
                "56.10%, -3.52pp vs control); multi-timeframe confluence "
                "shows no trend (3-TF +8.05pp but CI [-8.0, +22.3] on 47 of "
                "3,488 events, 1.3%); and volume-profile-derived levels score "
                "-2.71pp CI [-5.0, -0.4] WITH PERFECT FORESIGHT, because "
                "high-volume nodes are where price churns through rather than "
                "where it turns.",
        "caveat": "The chart still DRAWS horizontal levels and that is not a "
                  "contradiction: the method was chosen on STABILITY, not on "
                  "predictive power. Calendar-anchored prior-period extremes "
                  "score 1.000 on view-to-view stability (Jaccard) where the "
                  "fractal method scores 0.169, and 0.075 across an interval "
                  "change. A stable, named level is a shared reference to "
                  "plan an exit against. It is never a reason to expect one.",
        "match": lambda r: False,      # not a signal family; the record
                                       # exists so the verdict sits on file
                                       # beside the layer that draws it
    },
    {
        "id": "equity-any",
        "label": "equity perp setups",
        "verdict": UNTESTED,
        "expectancy_r": None,
        "win_rate": None,
        "n": None,
        "method": None,
        "as_of": None,
        "note": "All walk-forward validation was done on crypto perps. The "
                "equity sleeve (catalyst/insider/desk driven) has never been "
                "through the same harness.",
        "caveat": "No verdict either way — absence of evidence, not evidence "
                  "of absence. Do not borrow the crypto numbers for these.",
        "match": lambda r: r.get("sleeve") == "equity",
    },
]


def _factor(r, key):
    return ((r.get("factors") or {}).get(key)) or 0


def _momentum_driven(r):
    """Momentum is the largest contributing factor for this row."""
    f = r.get("factors") or {}
    if not f:
        return False
    top = max(f, key=lambda k: f.get(k) or 0)
    return top == "momentum" and (f.get("momentum") or 0) > 0


def _funding_driven(r):
    f = r.get("factors") or {}
    if not f:
        return False
    top = max(f, key=lambda k: f.get(k) or 0)
    return top == "funding" and (f.get("funding") or 0) > 0


def classify(row):
    """Attach the validated-edge verdict for one signal row."""
    for rec in REGISTRY:
        try:
            if rec["match"](row):
                break
        except Exception:
            continue
    else:
        return {"verdict": UNTESTED, "label": "unmapped setup",
                "note": "This combination does not correspond to any family "
                        "that was put through the validation harness.",
                "stale": False}

    out = {k: v for k, v in rec.items() if k != "match"}
    if rec.get("as_of"):
        age_d = (time.time() - rec["as_of"]) / _D
        out["age_days"] = int(age_d)
        out["stale"] = age_d > STALE_DAYS
    else:
        out["stale"] = False
    return out


def annotate(rows):
    """Add `edge` to every signal row, in place-safe fashion."""
    out = []
    for r in rows or []:
        r = dict(r)
        r["edge"] = classify(r)
        out.append(r)
    return out


def summary(rows):
    """Counts for the pane header — how much of this list is actually backed."""
    c = {VALIDATED: 0, NO_GO: 0, UNTESTED: 0}
    for r in rows or []:
        v = ((r.get("edge") or {}).get("verdict")) or UNTESTED
        c[v] = c.get(v, 0) + 1
    return c
