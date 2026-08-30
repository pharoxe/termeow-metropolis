"""Token buyback / burn programmes for HL-tradeable assets.

Two different things live here, and the UI keeps them apart:

  MECHANISM  — what the protocol says it does. Sourced from public reporting
               (see `source` per entry). This is a claim, not a measurement.
  REALISED   — what actually happened to supply. For tokens with an HL spot
               listing we snapshot totalSupply daily and derive the burn rate
               from the change. That is measured, not announced.

`maxSupply - totalSupply` alone is NOT proof of burning: for a token still
minting, the gap is simply unminted supply. Only the day-over-day *decline*
in totalSupply is evidence of an active burn, which is why the snapshots
matter more than any single reading.
"""

import json
import os
import tempfile
import threading
import time
from datetime import date

from cache import CACHE
from datasources import hl

STORE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "data", "supply_history.json")

# Mechanism claims, verified against public reporting in July 2026. `share`
# is the stated fraction of protocol revenue directed at the buyback.
PROGRAMS = {
    "HYPE": {
        "coingecko_id": "hyperliquid",
        "kind": "buyback-hold",
        "detail": "97% of protocol fees -> Assistance Fund; accumulates rather "
                  "than burns (~45.7M HYPE held). Separate fee/gas burn is small.",
        "share": 0.97,
        "reported_buyback_usd_day": 1900000,
        "source": "crypto.news / cryptotimes.io, Jul 2026",
    },
    "ASTER": {
        "onchain": {"kind": "evm", "chain": "binance-smart-chain", "contract": "0x000ae314e2a2172a039b26378814c252734f556a"},
        "coingecko_id": "aster-2",
        "kind": "buyback-burn",
        "detail": "CORRECTED 2026-08-08: the 99%-of-fees buyback leg is "
                  "REDISTRIBUTED TO veASTER STAKERS, not burned. Burns to the "
                  "dead address come from a separate RESERVE leg (our chain "
                  "reads: Jul 13 +3.08M, Jul 27 +2.21M). So the measured burn "
                  "series is reserve drawdown, NOT market buying.",
        "share": 0.99,
        "source": "cryptotimes.io, Jun 2026",
    },
    "AAVE": {
        "onchain": {"kind": "evm", "chain": "ethereum", "contract": "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9"},
        "coingecko_id": "aave",
        "kind": "buyback-treasury",
        "detail": "$50M/yr permanent buyback into treasury/ecosystem reserve "
                  "(began $1M/wk early 2025).",
        "source": "DWF Labs research, 2026",
    },
    "DYDX": {
        "onchain": {"kind": "cosmos", "network": "dydx", "denom": "adydx", "exponent": 18},
        "coingecko_id": "dydx-chain",
        "kind": "buyback-stake",
        "detail": "75% of net protocol fees -> buyback and stake (raised from 25% "
                  "by governance Nov 2025).",
        "share": 0.75,
        "source": "DWF Labs research, 2026",
    },
    "JUP": {
        "onchain": {"kind": "solana", "mint": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"},
        "coingecko_id": "jupiter-exchange-solana",
        "kind": "buyback-lock",
        "detail": "50% of protocol fees -> JUP repurchases locked in the Litterbox "
                  "Trust for three years.",
        "share": 0.50,
        "source": "DWF Labs research, 2026",
    },
    "VVV": {
        "onchain": {"kind": "evm", "chain": "base", "contract": "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf"},
        "coingecko_id": "venice-token",
        "kind": "buyback-burn",
        "detail": "5% of Venice AI API subscription revenue ($5 per $100 of API "
                  "credits) buys and burns VVV; burns have removed ~42.8% of total "
                  "supply. Emissions stepping 14M -> 6M -> 5M -> 3M VVV/yr.",
        "share": 0.05,
        "source": "Venice tokenomics overhaul, 18 Jul 2026 (crypto-economy / KuCoin)",
    },
    "WLFI": {"onchain": {"kind": "evm", "chain": "ethereum",
                         "contract": "0xda5e1988097297dcdc1f90d4dfe7909e847cbef6"},
             "coingecko_id": "world-liberty-financial", "kind": "buyback-burn",
             "detail": "100% of protocol fees buy WLFI on-market (Etherscan-"
                       "labelled 'Onchain Purchases' wallet), then destroy it "
                       "via _burn: genesis 100B -> totalSupply 96.74B, so "
                       "3.26B burned (verified). No sink — supply decline is "
                       "the counter.",
             "source": "WLF governance Aug-2025; measured on Ethereum"},
    "ETHFI": {"onchain": {"kind": "evm", "chain": "ethereum",
                          "contract": "0xFe0c30065B384F05761f15d0CC899D4F9F9Cc0eB"},
              "coingecko_id": "ether-fi", "kind": "buyback-treasury",
              "detail": "100% of eETH withdrawal-fee revenue buys ETHFI weekly, "
                        "but proceeds are DISTRIBUTED TO sETHFI STAKERS, not "
                        "burned — lifetime burn is only 1.46M (0.15%). A real "
                        "recurring bid, but float is recycled, and no public "
                        "counter isolates the buyback from staker deposits.",
              "source": "ether.fi gov docs; measured on Ethereum"},
    "UNI": {"onchain": {"kind": "evm", "chain": "ethereum",
                        "contract": "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"},
            "coingecko_id": "uniswap", "kind": "buyback-burn",
            "detail": "UNIfication (live Dec 2025): protocol fee capture funds "
                      "buy-and-burn, plus a 100M retroactive treasury burn. "
                      "Sink-burner: dead address holds 108.1M UNI (verified), "
                      "totalSupply still 1B.",
            "source": "UNIfication governance; measured on Ethereum"},
    "LIT": {"onchain": {"kind": "evm", "chain": "ethereum",
                        "contract": "0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2"},
            "coingecko_id": "lighter", "kind": "buyback-burn",
            "detail": "Trading-fee revenue funds open-market LIT buybacks, "
                      "burned in quarterly batches to 0xdEaD (first burn "
                      "15,638,702 on 2026-07-10 — verified on-chain to the "
                      "token; supply stays 1B, sink balance is the counter). "
                      "$17.9M cumulative buybacks since TGE.",
            "source": "Lighter June-2026 tokenomics overhaul; measured on Ethereum"},
    "SKY": {"onchain": {"kind": "evm", "chain": "ethereum", "contract": "0x56072c95faa701256059aa122697b133aded9279"}, "coingecko_id": "sky", "kind": "buyback-treasury",
            "detail": "Smart Burn Engine buys SKY with protocol surplus. Despite "
                      "the name it does not destroy supply: totalSupply reads "
                      "23,462,665,147.37 identically at 0d, 180d and 365d on "
                      "Ethereum, and only 4.8 SKY sit in the dead address.",
            "source": "measured on-chain (eth.drpc.org archive), 2026-07-29"},
    "PUMP": {"onchain": {"kind": "solana", "mint": "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"}, "coingecko_id": "pump-fun", "kind": "buyback-burn", "detail": "Fee-funded buyback and burn.",
             "source": "public reporting, 2026"},
    "BNB": {"onchain": {"kind": "evm_native", "chain": "binance-smart-chain"},
            "coingecko_id": "binancecoin", "kind": "burn", "detail": "Quarterly auto-burn plus real-time BEP-95 "
            "gas burn.", "source": "public reporting"},
    "CAKE": {"onchain": {"kind": "evm", "chain": "binance-smart-chain", "contract": "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82"}, "coingecko_id": "pancakeswap-token", "kind": "burn", "detail": "Weekly scheduled burn.",
             "source": "public reporting"},
}

# Real programmes that are NOT on Hyperliquid, so they cannot be traded or
# supply-tracked from this terminal. Kept explicit so they are not silently
# dropped if they list later.
OFF_VENUE = {
    "POD": {
        "coingecko_id": "dolphin-2",
        "onchain": {"kind": "evm", "chain": "base",
                    "contract": "0xed664536023d8e4b1640c394777d34abaff1df8f"},
        "kind": "buyback",
        "detail": "Dolphin AI — 100% of network (decentralised inference) revenue "
                  "-> open-market POD buybacks to offset inflation.",
        "chain": "Base 0xed664536023d8e4b1640c394777d34abaff1df8f",
        "source": "CoinGecko / LBank, 2026",
    },
}

SNAPSHOT_TTL = 6 * 3600


# ONE writer at a time for supply_history.json.
#
# There were none, and four threads write it: the server's daily supply
# snapshot, the 15-minute buyback warm loop (poll_intraday), _bid_history off
# the report path, and report() itself. Each does load -> mutate -> save with
# no coordination, so the last save wins and silently discards whatever landed
# between another thread's load and its own. Re-entrant because the report
# path can reach a save through more than one helper in the same thread.
_HIST_LOCK = threading.RLock()


def _load():
    try:
        with open(STORE) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _save(d):
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(STORE), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(d, fh)
        os.replace(tmp, STORE)
    # OSError alone was too narrow. json.dump walks the dict while another
    # thread may be mutating it, which raises RuntimeError (dictionary changed
    # size during iteration) — that escaped this handler entirely and left the
    # mkstemp file behind, unreferenced, forever. There is one such orphan in
    # data/ from 2026-08-14. The lock above makes it rare; this makes it
    # survivable, and never silent about leaving the store untouched.
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _persist_fund_ring(hist, name):
    """Write ONE `_funds` ring back without shipping a cached dict to disk.

    report()'s `hist` comes out of CACHE — up to SNAPSHOT_TTL (6h) old, and in
    the common path the 15-minute intraday entry — so `_save(hist)` wrote a
    photograph of the store as it looked when that cache entry was BUILT,
    rolling back every daily row and intraday point written since. The only
    thing report() actually changes is the fund-accumulation ring for one
    token, so reload under the lock, graft that ring on, and save.
    """
    ring = ((hist.get("_funds") or {}).get(name)) or []
    with _HIST_LOCK:
        disk = _load()
        disk.setdefault("_funds", {})[name] = ring
        _save(disk)


def _hl_spot_tokens():
    """{name: tokenId} for tokens with an HL spot listing (supply is queryable)."""
    meta = hl.spot_meta()
    return {t["name"]: t["tokenId"] for t in (meta.get("tokens") or [])}


def _trim(rec):
    if len(rec) > 400:
        for k in sorted(rec)[:-400]:
            rec.pop(k, None)


def snapshot_supply():
    """Serialised entry point — see _HIST_LOCK. The read-modify-write below
    spans upstream fetches, so two of these interleaving is not a rare race:
    whichever finishes last writes the store it loaded minutes earlier and
    discards the other's rows outright."""
    with _HIST_LOCK:
        return _snapshot_supply_locked()


def _snapshot_supply_locked():
    """Record today's supply for every tracked token. Idempotent per day.

    Two sources, never mixed for one token: Hyperliquid's own token_details
    where the asset has an HL spot listing (authoritative on-chain), else
    CoinGecko. They genuinely disagree — HL reports HYPE totalSupply ~999.08M
    against CoinGecko's ~955.31M — so each series records the `src` it came
    from and a burn rate is only ever computed within one source.
    """
    hist = _load()
    today = date.today().isoformat()

    try:
        hl_ids = _hl_spot_tokens()
    except Exception:
        hl_ids = {}
    # HL is authoritative only for HL-native assets. PUMP is a Solana token
    # that merely has an HL listing, so its mint is the truer source.
    hl_targets = [n for n in hl_ids
                  if (n in PROGRAMS and not PROGRAMS[n].get("onchain"))
                  or n in ("PURR", "TRUMP", "BERA", "MON", "HYPE")]
    for name in hl_targets:
        rec = hist.setdefault(name, {})
        if today in rec:
            continue
        try:
            d = hl.token_details(hl_ids[name])
            rec[today] = {"max": float(d.get("maxSupply") or 0),
                          "total": float(d.get("totalSupply") or 0),
                          "circ": float(d.get("circulatingSupply") or 0),
                          # a rate divided by whole days is wrong when the two
                          # samples are hours apart, so stamp wall-clock time
                          "ts": time.time(), "src": "hl"}
        except Exception:
            pass
        _trim(rec)
        time.sleep(0.2)

    # Prefer the issuer's own contract. `burned_to_sink` is the cumulative
    # burn for teams that send to a dead address instead of calling _burn --
    # a monotonic counter, so cumulative burn is known from ONE reading.
    done = set(hl_targets)
    for name, prog in PROGRAMS.items():
        spec = prog.get("onchain")
        if not spec or name in done:
            continue
        rec = hist.setdefault(name, {})
        if today in rec:
            done.add(name)
            continue
        try:
            from datasources import onchain
            r = onchain.read(spec)
        except Exception:
            continue
        rec[today] = {"max": 0.0,
                      "total": float(r.get("effective", r["total"])),
                      "raw_total": float(r["total"]),
                      "burned_to_sink": float(r.get("burned_to_sink") or 0),
                      "circ": 0.0, "ts": time.time(), "src": r["src"],
                      "contract": r.get("contract")}
        _trim(rec)
        done.add(name)
        time.sleep(0.3)

    # CoinGecko only for anything with no on-chain route at all.
    cg_needed = {n: p["coingecko_id"] for n, p in PROGRAMS.items()
                 if p.get("coingecko_id") and n not in done}
    if cg_needed:
        try:
            from datasources import coingecko
            sup = coingecko.supplies(list(cg_needed.values()))
            for name, cid in cg_needed.items():
                d = sup.get(cid)
                if not d or d.get("total") is None:
                    continue
                rec = hist.setdefault(name, {})
                if today in rec:
                    continue
                rec[today] = {"max": float(d.get("max") or 0),
                              "total": float(d["total"]),
                              "circ": float(d.get("circ") or 0),
                              "ts": time.time(), "src": "cg"}
                _trim(rec)
        except Exception:
            pass

    _record_intraday(hist)
    _save(hist)
    return hist


# Solana/Cosmos public RPCs serve current state only, so a daily-keyed store
# can never produce a rate before tomorrow. Keeping an intraday ring lets a
# real, measured rate appear the same day — always labelled with its span so
# a 6-hour extrapolation is never mistaken for a 7-day average.
INTRADAY_CAP = 240
INTRADAY_MIN_SPAN_H = 1.0
LAG_EPSILON = 0.005     # <0.5%% uptick on a burn-only token = lagging RPC node


def _record_intraday(hist):
    for name, rec in hist.items():
        latest = None
        for day in sorted(rec):
            v = rec[day]
            if isinstance(v, dict) and v.get("total"):
                latest = v
        if not latest:
            continue
        ring = rec.setdefault("_intraday", [])
        if ring and abs(ring[-1][1] - latest["total"]) < 1e-9:
            ring[-1][0] = latest["ts"]      # unchanged: extend the span
        else:
            ring.append([latest["ts"], latest["total"]])
        del ring[:-INTRADAY_CAP]


# EVM programmes get a real 30-day history from archive nodes. Solana's
# public RPCs answer for current state only, so PUMP's burn is invisible to a
# once-a-day store until tomorrow -- poll it separately and keep the ring.
INTRADAY_TOKENS = ("PUMP",)
# Buyback wallets whose balance is cheap to re-read; differencing gives the
# live accumulation rate, which is the actual bid size.
FUND_RING_CAP = 240
FUND_MIN_SPAN_H = 0.2


def poll_intraday():
    """Serialised entry point — see _HIST_LOCK."""
    with _HIST_LOCK:
        return _poll_intraday_locked()


def _poll_intraday_locked():
    """Re-read supply for chains with no historical route, ~every warm cycle."""
    hist = _load()
    changed = False
    for name in INTRADAY_TOKENS:
        prog = PROGRAMS.get(name)
        spec = (prog or {}).get("onchain")
        if not spec:
            continue
        try:
            from datasources import onchain
            r = onchain.read(spec)
        except Exception:
            continue
        total = float(r.get("effective", r["total"]))
        if total <= 0:
            continue
        rec = hist.setdefault(name, {})
        ring = rec.setdefault("_intraday", [])
        # Anchor on today's daily snapshot so the span is hours, not minutes --
        # a 90-second window extrapolated to a day is not a rate.
        if not ring:
            for day in sorted(k for k in rec if not k.startswith("_")):
                v = rec[day]
                if isinstance(v, dict) and v.get("total") and v.get("ts"):
                    ring.append([float(v["ts"]), float(v["total"])])
        now = time.time()
        if ring and abs(ring[-1][1] - total) < 1e-9:
            ring[-1][0] = now
        elif ring and 0 < total - ring[-1][1] < ring[-1][1] * LAG_EPSILON:
            # A public RPC pool occasionally routes to a lagging node, which
            # reports OLDER state — for a burn-only token that reads as supply
            # rising. Audit measured 9 such upticks in 239 reads, max 0.022% of
            # supply. Skip the stale read; a rise past the epsilon is accepted
            # as a real structural change (mint/reclassification), not lag.
            changed = True          # still persist the extended timestamps
        else:
            ring.append([now, total])
        del ring[:-INTRADAY_CAP]
        changed = True
    if changed:
        _save(hist)
    return hist


def fund_rate(hist, name, held):
    """Tokens/day the buyback wallet is accumulating, measured not claimed."""
    rec = hist.setdefault("_funds", {}).setdefault(name, [])
    now = time.time()
    if rec and abs(rec[-1][1] - held) < 1e-9:
        rec[-1][0] = now
    else:
        rec.append([now, held])
    del rec[:-FUND_RING_CAP]
    if len(rec) < 2:
        return None
    span_h = (rec[-1][0] - rec[0][0]) / 3600.0
    if span_h < FUND_MIN_SPAN_H:
        return None
    per_day = (rec[-1][1] - rec[0][1]) / (span_h / 24.0)
    return {"per_day": per_day, "span_hours": round(span_h, 2),
            "accumulating": per_day > 0,
            "basis": "%.1fh fund delta" % span_h}


def intraday_rate(hist, name):
    """Net supply change per day measured over today's readings, if long enough."""
    ring = ((hist.get(name) or {}).get("_intraday")) or []
    if len(ring) < 2:
        return None
    t0, v0 = ring[0]
    t1, v1 = ring[-1]
    span_h = (t1 - t0) / 3600.0
    if span_h < INTRADAY_MIN_SPAN_H or v0 <= 0:
        return None
    per_day = (v1 - v0) / (span_h / 24.0)
    return {"net_per_day": per_day, "deflationary": per_day < 0,
            "span_hours": round(span_h, 1), "from": v0, "to": v1,
            "basis": "intraday"}


def realised(hist, name, trackable=True):
    """Measured supply change — the only honest evidence of active burning."""
    rec = hist.get(name) or {}
    days = sorted(k for k in rec if not k.startswith("_"))
    if not days:
        return {"days_tracked": 0, "trackable": trackable,
                "note": ("not listed on HL spot — supply is not queryable here, "
                         "so burn cannot be measured from this terminal")
                        if not trackable else "supply tracking starting"}
    if len(days) < 2:
        first = rec[days[0]]
        return {"days_tracked": 1, "trackable": trackable,
                "source": first.get("src"),
                "contract": first.get("contract"),
                "burned_vs_max": (first["max"] - first["total"]) if first["max"] else None,
                "burned_to_sink": first.get("burned_to_sink"),
                "note": "one snapshot so far; burn RATE needs a second"}
    # Compare only within one source; a mid-series source change would read
    # as a phantom multi-million-token burn.
    src = rec[days[-1]].get("src")
    same = [d for d in days if rec[d].get("src") == src]
    if len(same) < 2:
        return {"days_tracked": len(days), "trackable": trackable, "source": src,
                "note": "one snapshot on this source; burn RATE needs a second"}
    a, b = rec[same[0]], rec[same[-1]]
    days = same
    delta = b["total"] - a["total"]
    # Prefer real elapsed time; fall back to whole days for legacy points and
    # say so, because a 5-hour gap annualised as a day is off by ~5x.
    exact = "ts" in a and "ts" in b and b["ts"] > a["ts"]
    span_days = ((b["ts"] - a["ts"]) / 86400.0) if exact else \
        float((date.fromisoformat(days[-1]) - date.fromisoformat(days[0])).days or 1)
    span_days = max(span_days, 1e-6)
    per_day = (-delta / span_days) if delta < 0 else 0.0
    return {
        "days_tracked": len(days),
        "span_days": round(span_days, 3),
        "span_exact": exact,
        "supply_change": delta,
        "burn_per_day": per_day,
        "burn_pct_per_year": (per_day * 365 / b["total"] * 100) if b["total"] else 0.0,
        "burned_vs_max": (b["max"] - b["total"]) if b["max"] else None,
        "burned_to_sink": b.get("burned_to_sink"),
        "contract": b.get("contract"),
        "active_burn": delta < 0 or (
            (b.get("burned_to_sink") or 0) > (a.get("burned_to_sink") or 0)),
        "sink_burn_delta": (b.get("burned_to_sink") or 0) - (a.get("burned_to_sink") or 0),
        "source": src,
    }


def burn_series(hist, name):
    """Burn rate (tokens/day) for every consecutive pair of snapshots.

    "Unusual" needs a baseline, and a baseline needs history. With fewer than
    MIN_BASELINE intervals we say so rather than call noise an anomaly.
    """
    rec = hist.get(name) or {}
    days = sorted(k for k in rec if not k.startswith("_"))
    rates = []
    for a_key, b_key in zip(days, days[1:]):
        a, b = rec[a_key], rec[b_key]
        if a.get("src") != b.get("src"):
            continue          # source switch is not a supply change
        delta = b["total"] - a["total"]
        if "ts" in a and "ts" in b and b["ts"] > a["ts"]:
            span = (b["ts"] - a["ts"]) / 86400.0
        else:
            span = float((date.fromisoformat(b_key) - date.fromisoformat(a_key)).days or 1)
        if span <= 0:
            continue
        rates.append({"to": b_key, "per_day": max(0.0, -delta / span),
                      "span_days": round(span, 3)})
    return rates


MIN_BASELINE = 4          # intervals needed before an anomaly call is credible


def burn_anomaly(hist, name):
    rates = burn_series(hist, name)
    if len(rates) < MIN_BASELINE:
        return {"ready": False, "intervals": len(rates), "need": MIN_BASELINE,
                "latest_per_day": rates[-1]["per_day"] if rates else 0.0,
                "note": "baseline building ({}/{} intervals)".format(
                    len(rates), MIN_BASELINE)}
    latest = rates[-1]["per_day"]
    prior = sorted(r["per_day"] for r in rates[:-1])
    mid = prior[len(prior) // 2] if prior else 0.0
    return {"ready": True, "intervals": len(rates),
            "latest_per_day": latest, "baseline_per_day": mid,
            # None, not inf: json.dumps writes float("inf") as the bare token
            # `Infinity`, which Python's json accepts but JSON.parse rejects —
            # one such value made the whole /api/buyback body unparseable in
            # the browser and the BURN tab rendered nothing. "No baseline to
            # compare against" is also the more honest reading than "infinite".
            "ratio": (latest / mid) if mid > 0 else None}


RATE_TTL = 6 * 3600
HIST_STORE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "data", "burn_history.json")


def _load_hist():
    try:
        with open(HIST_STORE) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _save_hist(d):
    os.makedirs(os.path.dirname(HIST_STORE), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(HIST_STORE), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(d, fh)
        os.replace(tmp, HIST_STORE)
    # Same widening as _save above: anything json.dump can raise — not just
    # OSError — must still remove the mkstemp file, or it is orphaned in
    # data/ forever. Single-flight here is already provided by the
    # "burn_hist" cache key, so this store has no writer race of its own.
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def backfill_history(days=30, points=9):
    """Read 30 days of supply history off-chain-archive and persist it.

    Backfilled once so the terminal starts with a trend instead of waiting a
    month for local snapshots to accumulate.
    """
    from datasources import onchain
    store = _load_hist()
    for name, prog in PROGRAMS.items():
        spec = prog.get("onchain") or {}
        if spec.get("kind") != "evm" or store.get(name):
            continue
        try:
            base = onchain.evm_total_supply(spec["chain"], spec["contract"])
            ser = onchain.evm_supply_history(spec["chain"], spec["contract"],
                                             base["decimals"], days=days, points=points)
            if ser:
                store[name] = ser
        except Exception:
            continue
    _save_hist(store)
    return store


def net_supply_stats(series):
    """Net supply change — what actually matters for scarcity.

    Gross burn flatters any token that mints while it burns. Comparing
    like-for-like (the running minimum of effective supply) avoids reading a
    mint/burn sawtooth as runaway deflation.
    """
    if not series or len(series) < 2:
        return None
    span = (series[-1]["ts"] - series[0]["ts"]) / 86400.0
    if span <= 0:
        return None
    first, last = series[0]["effective"], series[-1]["effective"]
    net = last - first
    minted = (series[-1]["total"] - series[0]["total"])
    burned = (series[-1]["sink"] - series[0]["sink"])
    return {
        "span_days": round(span, 1),
        "net_change": net, "net_per_day": net / span,
        "minted": minted, "burned": burned,
        "net_pct_yr": (net / span * 365 / last * 100) if last else None,
        "offset_ratio": (burned / minted) if minted > 0 else None,
        "deflationary": net < 0,
    }


# Tokens that destroy via _burn: nothing accumulates at a sink, so the
# cumulative counter and the rate windows must come from the supply curve
# (genesis - totalSupply) instead of sink balances.
SUPPLY_BURN_GENESIS = {"WLFI": 100_000_000_000.0}


def onchain_rates():
    """Measured burn over real 1d/7d windows, read from chain archives.

    This is what makes "how much per day" answerable immediately instead of
    after days of local snapshots — and it gives the anomaly check a real
    baseline from day one.
    """
    from datasources import onchain
    out = {}
    for name, prog in PROGRAMS.items():
        spec = prog.get("onchain") or {}
        try:
            if spec.get("kind") == "evm":
                base = onchain.evm_total_supply(spec["chain"], spec["contract"])
                # 30d as well as 7d: batch burners (CAKE burns weekly) look
                # "stopped" on a 1d read, so trend needs the longer baseline.
                gen = SUPPLY_BURN_GENESIS.get(name)
                if gen is not None:
                    rr = onchain.evm_supply_burn_rate(
                        spec["chain"], spec["contract"], base["decimals"],
                        gen, windows=(1, 7, 30))
                    supply = base.get("effective") or base.get("total") or 0
                    out[name] = {"cumulative": max(0.0, gen - supply)
                                 if supply else 0.0,
                                 "windows": rr, "src": base["src"],
                                 "supply": supply, "contract": spec["contract"]}
                    continue
                rr = onchain.evm_burn_rate(spec["chain"], spec["contract"],
                                           base["decimals"], windows=(1, 7, 30))
                out[name] = {"cumulative": base.get("burned_to_sink") or 0.0,
                             "windows": rr, "src": base["src"],
                             "supply": base.get("effective") or base.get("total"),
                             "contract": spec["contract"]}
            elif spec.get("kind") == "evm_native":
                b = onchain.evm_native_burned(spec["chain"])
                rr = onchain.evm_native_burn_rate(spec["chain"], windows=(1, 7, 30))
                out[name] = {"cumulative": b["burned"], "windows": rr,
                             "src": b["src"], "contract": "native",
                             "note": "BEP-95 gas burn only; excludes pre-BSC "
                                     "Beacon Chain auto-burns"}
        except Exception:
            continue
    return out


# Mechanisms that deliberately do NOT destroy supply. Showing these as
# "awaiting data" implies a burn that is never coming; they remove float
# instead, which is a different (weaker) scarcity claim.
NO_BURN_KINDS = {"buyback-hold": "accumulates in a fund — float removed, supply intact",
                 "buyback-stake": "bought and staked — float removed, supply intact",
                 "buyback-lock": "bought and locked — float removed, supply intact",
                 "buyback-treasury": "bought into treasury — float removed, supply intact"}


INTRADAY_TTL = 15 * 60


# Wallets where a buyback parks its tokens. Every one is verified on-chain
# before use -- an unverified address would produce a confident wrong number,
# which is worse than no number. Addresses that could not be verified are
# deliberately absent rather than guessed.
HOLDINGS = {
    "JUP": {"chain": "solana",
            "owner": "6tZT9AUcQn4iHMH79YZEXSy55kDLQ4VbA3PMtfLVNsFX",
            "mint": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
            "label": "Litterbox Trust",
            "source": "jupjup.org -> verified via Solana RPC"},
    "DYDX": {"chain": "cosmos-staked", "network": "dydx",
             "owner": "dydx1zc0jd76vfluauk6pc6rsq5dkwyjz9h8uqgppj6",
             "label": "Treasury SubDAO Buyback Account (staked)",
             "source": "dydx.forum DRC -> verified via dYdX LCD"},
    "SKY": {"chain": "ethereum",
            "token": "0x56072c95faa701256059aa122697b133aded9279",
            # Read from the live flapper's own receiver() -- not guessed.
            "holder": "0xbe8e3e3618f7474f8cb1d074a26affef007e98fb",
            "label": "Smart Burn Engine receiver",
            "source": "FlapperUniV2SwapOnly.receiver() -> Ethereum archive"},
    "AAVE": {"chain": "ethereum",
             "token": "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
             "holder": "0x25F2226B597E8F9514B3F68F00f494cF4f286491",
             "label": "DAO Ecosystem Reserve",
             # Measured across a year: this wallet is a net payer (staking
             # rewards, grants), so its balance is NOT a buyback counter.
             "not_a_buyback_counter": True,
             "source": "Aave governance -> verified via Ethereum archive"},
}

# Governance-imposed stops. A programme listed as active when it is not is the
# most expensive kind of wrong on this screen: it implies a bid that is absent.
PAUSED = {
    "AAVE": {"since": "2026-04-19",
             "why": "buybacks paused by governance after the rsETH bridge incident"},
}


# Ethereum archive endpoints that answer historical eth_call without a key.
ETH_ARCHIVE_POOL = ["https://eth.merkle.io", "https://rpc.mevblocker.io",
                    "https://gateway.tenderly.co/public/mainnet"]
RATE_LOOKBACK_D = 7
ETH_BLOCKS_PER_DAY = 7168        # ~12.05s blocks
DYDX_BLOCKS_PER_DAY = 86400      # ~1.0s blocks


def holdings_rate(name, h, now_held):
    """Measured 7-day change in a buyback wallet. Sign matters: SKY's receiver
    is a net payer, so reporting it as a bid would invert the truth."""
    from datasources import onchain
    try:
        if h["chain"] == "ethereum":
            blk = None
            for u in ETH_ARCHIVE_POOL:
                try:
                    blk = hex(onchain.block_at_seconds_ago(
                        u, RATE_LOOKBACK_D * 86400))
                    break
                except Exception:
                    continue
            if blk is None:
                return None
            past = None
            for u in ETH_ARCHIVE_POOL:
                try:
                    past = onchain.evm_balance_of(h["chain"], h["token"],
                                                  h["holder"], blk, url=u) / 1e18
                    break
                except Exception:
                    continue
            if past is None:
                return None
        elif h["chain"] == "solana":
            ta = onchain.solana_token_account(h["owner"], h["mint"])
            if not ta:
                return None
            old = onchain.solana_balance_days_ago(ta, RATE_LOOKBACK_D)
            if not old:
                return None
            span_d = max((time.time() - old["ts"]) / 86400.0, 0.5)
            per_day = (now_held - old["held"]) / span_d
            return {"per_day": per_day, "accumulating": per_day > 0,
                    "span_hours": round(span_d * 24, 1),
                    "basis": "%.1fd wallet delta" % span_d}
        elif h["chain"] == "solana":
            ta = onchain.solana_token_account(h["owner"], h["mint"])
            if not ta:
                return None
            old = onchain.solana_balance_days_ago(ta, RATE_LOOKBACK_D)
            if not old:
                return None
            span_d = max((time.time() - old["ts"]) / 86400.0, 0.5)
            per_day = (now_held - old["held"]) / span_d
            return {"per_day": per_day, "accumulating": per_day > 0,
                    "span_hours": round(span_d * 24, 1),
                    "basis": "%.1fd wallet delta" % span_d}
        elif h["chain"] == "cosmos-staked":
            head = onchain.cosmos_height(h["network"])
            past = onchain.cosmos_staked_at(
                h["network"], h["owner"], head - RATE_LOOKBACK_D * DYDX_BLOCKS_PER_DAY)
            if past is None:
                return None
        else:
            return None
    except Exception:
        return None
    per_day = (now_held - past) / float(RATE_LOOKBACK_D)
    return {"per_day": per_day, "accumulating": per_day > 0,
            "span_hours": RATE_LOOKBACK_D * 24, "basis": "7d wallet delta"}


def holdings():
    """Verified balances of buyback wallets. Missing entries stay missing."""
    from datasources import onchain
    out = {}
    for name, h in HOLDINGS.items():
        try:
            if h["chain"] == "solana":
                v = onchain.solana_token_balance(h["owner"], h["mint"])
            elif h["chain"] == "cosmos-staked":
                st = onchain.cosmos_staked(h["network"], h["owner"])
                v = st["staked"] if st else None
            else:
                raw = onchain.archive_balance_of(h["chain"], h["token"],
                                                 h["holder"])
                v = raw / 1e18
            if v is None:
                continue
            rec = {"held": v, "label": h["label"], "source": h["source"],
                   "not_a_buyback_counter": h.get("not_a_buyback_counter", False)}
            r = holdings_rate(name, h, v)
            if r:
                rec["rate"] = r
            out[name] = rec
        except Exception:
            continue
    return out


EVENTS_STORE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "data", "burn_events.json")


def burn_schedule(name):
    """Next burn predicted from observed cadence -- only when it IS a cadence.

    Reported with the evidence (last gaps, weekday) so a 2-event coincidence is
    never dressed up as a schedule.
    """
    try:
        with open(EVENTS_STORE) as fh:
            ev = (json.load(fh).get(name) or {}).get("events") or []
    except (OSError, ValueError):
        return None
    if len(ev) < 4:
        return None
    ts = sorted(e["ts"] for e in ev)
    gaps = [round((b - a) / 86400.0, 1) for a, b in zip(ts, ts[1:])]
    def tight(g):
        return len(g) >= 2 and max(g) - min(g) <= 0.15 * max(g)

    # Three matching gaps is a schedule; two is a pattern worth watching but
    # not worth trading. Say which one it is rather than blurring them.
    if tight(gaps[-3:]) and len(gaps) >= 3:
        recent, conf = gaps[-3:], "confirmed"
    elif tight(gaps[-2:]):
        recent, conf = gaps[-2:], "provisional"
    else:
        return {"regular": False, "confidence": "none",
                "gaps_days": gaps, "last_ts": ts[-1]}
    period = sum(recent) / len(recent)
    nxt = ts[-1] + period * 86400
    overdue_d = (time.time() - nxt) / 86400.0
    # A predicted date that has sat in the past for more than two days (or
    # half a period) is not a countdown — it is a schedule that did not fire.
    stale = overdue_d > max(2.0, period * 0.5)
    return {"regular": True, "confidence": conf,
            "period_days": round(period, 1), "next_ts": nxt,
            "weekday": time.strftime("%a", time.gmtime(nxt)),
            "hour_utc": time.strftime("%H:%M", time.gmtime(nxt)),
            "gaps_days": gaps, "n_events": len(ev), "last_ts": ts[-1],
            "stale": stale,
            "overdue_days": round(overdue_d, 1) if overdue_d > 0 else None}


# Does the programme BUY on the open market, or destroy tokens it already
# holds? Only the former is buy pressure. BNB's auto-burn and BEP-95 gas burn
# destroy protocol-held/fee tokens without lifting an offer, so counting them
# as a bid would overstate the aggregate by billions.
BUY_FUNDED = {"HYPE": True,
              "UNI": True,     # fee capture -> buy -> burn (UNIfication)
              "WLFI": True,    # fees -> on-market purchases -> _burn
              "LIT": True,     # open-market buybacks, quarterly batch burns    # measured directly from its spot fills
              # Burns are RESERVE-funded (the fee-buyback goes to stakers),
              # so deriving a market bid from the burn series double-lied:
              # wrong source and wrong destination. The staker-buyback leg IS
              # a bid but has no measurable counter yet.
              "ASTER": False,
              "PUMP": True,   # fee revenue buys PUMP on Solana, then burns
              "VVV": True,
              "JUP": True, "DYDX": True, "SKY": True, "AAVE": True,
              # PancakeSwap collects much of what it burns *in CAKE* -- swap
              # fees, lottery, prediction markets, IFO -- rather than buying it.
              # Counting the gross burn as a market bid implied $13.8M/day
              # against $20.1M/day of volume: 69% of all trading, which is not
              # possible. Provenance is mixed and unquantified, so it is not
              # counted as a bid.
              "CAKE": False,
              # Auto-burn and BEP-95 destroy protocol-held / gas tokens.
              "BNB": False}

# A programme cannot buy an implausible share of its own tape. When the implied
# bid crosses this, the provenance assumption is wrong, not the market.
BID_SANITY_MAX_PCT_VOL = 25.0

AF_ADDR = "0xfefefefefefefefefefefefefefefefefefefefe"


def hype_bid_usd_day():
    """HYPE bought in the last 24h, from the fund's own fills. Exact, not modelled."""
    fills = hl.user_fills_by_time(AF_ADDR, (time.time() - 86400) * 1000)
    if not fills:
        return None
    usd = sum(float(f["sz"]) * float(f["px"]) for f in fills
              if str(f.get("dir", "")).lower().startswith("buy"))
    return {"usd_day": usd, "fills": len(fills), "src": "hl:userFillsByTime"}


def onchain_mod():
    from datasources import onchain
    return onchain


EXPLORERS = {"ethereum": "https://etherscan.io/address/{}",
             "binance-smart-chain": "https://bscscan.com/address/{}",
             "base": "https://basescan.org/address/{}",
             "solana": "https://solscan.io/account/{}",
             "dydx": "https://www.mintscan.io/dydx/address/{}"}


def _explorer(spec, hold_spec, name=None):
    """Where a reader can check the number themselves."""
    if name == "HYPE":
        return {"label": "Assistance Fund (hypurrscan)",
                "url": "https://hypurrscan.io/address/" + onchain_mod().HL_ASSISTANCE_FUND,
                "addr": onchain_mod().HL_ASSISTANCE_FUND}
    if hold_spec:
        chain = hold_spec.get("chain")
        if chain == "solana":
            return {"label": hold_spec.get("label"), "url":
                    EXPLORERS["solana"].format(hold_spec["owner"]),
                    "addr": hold_spec["owner"]}
        if chain == "cosmos-staked":
            return {"label": hold_spec.get("label"), "url":
                    EXPLORERS["dydx"].format(hold_spec["owner"]),
                    "addr": hold_spec["owner"]}
        if chain in EXPLORERS and hold_spec.get("holder"):
            return {"label": hold_spec.get("label"),
                    "url": EXPLORERS[chain].format(hold_spec["holder"]),
                    "addr": hold_spec["holder"]}
    net = spec.get("chain") or spec.get("network")
    addr = spec.get("contract") or spec.get("mint")
    if net in EXPLORERS and addr:
        return {"label": "token contract",
                "url": EXPLORERS[net].format(addr), "addr": addr}
    return None


# A buyback is only a bid while it is funded. Fee revenue falls, programmes get
# paused, treasuries run dry — and the level ("holds $2.5B") keeps looking
# healthy long after the flow stops. Track the RATE and flag when it breaks.
BID_RING_CAP = 400
BID_MIN_SAMPLES = 6
BID_DROP_FRAC = 0.40          # >40% below trailing median = sharp


def _bid_history(name, usd_day):
    """Serialised entry point — see _HIST_LOCK."""
    with _HIST_LOCK:
        return _bid_history_locked(name, usd_day)


def _bid_history_locked(name, usd_day):
    """Persist the bid and compare it with its own trailing median."""
    hist = _load()
    ring = hist.setdefault("_bids", {}).setdefault(name, [])
    now = time.time()
    # One sample per hour keeps the median meaningful rather than dominated by
    # whatever cadence the poller happens to run at.
    if ring and now - ring[-1][0] < 3600:
        ring[-1] = [now, usd_day]
    else:
        ring.append([now, usd_day])
    del ring[:-BID_RING_CAP]
    _save(hist)
    vals = [v for _, v in ring[:-1] if v is not None and v > 0]
    if len(vals) < BID_MIN_SAMPLES:
        return {"samples": len(ring), "ready": False}
    srt = sorted(vals)
    med = srt[len(srt) // 2]
    if med <= 0:
        return {"samples": len(ring), "ready": False}
    ratio = usd_day / med
    span_h = (ring[-1][0] - ring[0][0]) / 3600.0
    return {"ready": True, "usd_day": usd_day, "baseline_usd_day": med,
            "ratio": ratio, "drop_pct": (1 - ratio) * 100.0,
            "sharp_drop": ratio < (1 - BID_DROP_FRAC),
            "samples": len(ring), "span_hours": round(span_h, 1)}


def report():
    hist = CACHE.get_or_fetch("supply_hist", SNAPSHOT_TTL, snapshot_supply)
    # Fresher than the daily store, and the only route to a same-day rate for
    # Solana. Returns the merged store, so intraday_rate() reads live points.
    try:
        hist = CACHE.get_or_fetch("intraday", INTRADAY_TTL, poll_intraday) or hist
    except Exception:
        pass
    out = []
    # The burn is a global, on-chain quantity. Dividing it by Hyperliquid-only
    # volume overstates absorption by whatever share of trading happens
    # elsewhere -- for CAKE that was a factor of ~25.
    try:
        from datasources import coingecko
        ids = [p["coingecko_id"] for p in PROGRAMS.values() if p.get("coingecko_id")]
        _cg = CACHE.get_or_fetch("cg_vol", RATE_TTL,
                                 lambda: coingecko.simple_price(ids))
        gvol = {k: v.get("vol24h") for k, v in _cg.items()}
        # Same call already carries price; the bid needs it to be expressed in
        # dollars for tokens whose rate is measured in tokens.
        gpx = {k: v.get("usd") for k, v in _cg.items()}
    except Exception:
        gvol, gpx = {}, {}
    try:
        held = CACHE.get_or_fetch("holdings", RATE_TTL, holdings)
    except Exception:
        held = {}
    try:
        rates = CACHE.get_or_fetch("onchain_rates", RATE_TTL, onchain_rates)
    except Exception:
        rates = {}
    try:
        hist_series = CACHE.get_or_fetch("burn_hist", RATE_TTL, backfill_history)
    except Exception:
        hist_series = {}
    try:
        trackable_set = set(_hl_spot_tokens())
    except Exception:
        trackable_set = set(hist)
    for name, prog in PROGRAMS.items():
        row = dict(prog)
        row["token"] = name
        row["realised"] = realised(hist, name, name in trackable_set)
        row["anomaly"] = burn_anomaly(hist, name)
        row["global_vol24h"] = gvol.get(prog.get("coingecko_id"))
        sched = burn_schedule(name)
        if sched:
            row["schedule"] = sched
        try:
            with open(EVENTS_STORE) as fh:
                evs = (json.load(fh).get(name) or {}).get("events") or []
            if evs:
                row["burn_events"] = sorted(evs, key=lambda e: -e["ts"])[:8]
        except (OSError, ValueError):
            pass
        # Explorer link for whatever wallet or contract the reader may verify.
        spec = prog.get("onchain") or {}
        hold_spec = HOLDINGS.get(name) or {}
        row["explorer"] = _explorer(spec, hold_spec, name)
        if name in PAUSED:
            row["paused"] = PAUSED[name]
        h = held.get(name)
        if h:
            row["holdings"] = h

        if not (row.get("measured") or {}).get("net"):
            ir = intraday_rate(hist, name)
            if ir:
                row.setdefault("measured", {})["net"] = ir
        if prog.get("kind") in NO_BURN_KINDS:
            row["no_burn_by_design"] = NO_BURN_KINDS[prog["kind"]]
        if name == "ETHFI":
            # Weekly buy exists; proceeds go to stakers and no public counter
            # isolates the bid. Blind stays blind — do not invent a number,
            # and do not dress that as "NO BURN".
            row["bid_measurable"] = False
            row["bid_unmeasurable_why"] = (
                "weekly staker distribution has no public counter")
        if name == "HYPE":
            try:
                from datasources import onchain
                af = CACHE.get_or_fetch("hl_af", RATE_TTL,
                                        lambda: onchain.hl_assistance_fund("HYPE"))
                if af:
                    row["fund"] = af
                    row["holdings"] = {"held": af["held"],
                                       "label": "Assistance Fund",
                                       "source": af["src"],
                                       "not_a_buyback_counter": False}
                    fr = fund_rate(hist, "HYPE", af["held"])
                    if fr:
                        row["holdings"]["rate"] = fr
                    # NOT _save(hist): `hist` is a CACHE-obtained dict and
                    # writing it whole rolls disk back to whenever that entry
                    # was built. See _persist_fund_ring.
                    _persist_fund_ring(hist, "HYPE")
            except Exception:
                pass
        if name == "LIT":
            # Same shape as HYPE's fund: Account #0's LIT balance IS the
            # running quarterly accumulation, readable live from the L2 API.
            # It resets to ~0 at each quarterly burn — the rate ring handles
            # that as a large negative day; the level is what matters here.
            try:
                from datasources import lighter
                a0 = CACHE.get_or_fetch("lit_a0", 600, lighter.account0)
                if a0:
                    row["fund"] = a0
                    row["holdings"] = {"held": a0["lit_balance"],
                                       "label": "Protocol Account #0 (L2), burns quarterly",
                                       "source": a0["src"],
                                       "not_a_buyback_counter": False}
                    if a0.get("usdc_locked"):
                        row["holdings"]["working_order_usd"] = a0["usdc_locked"]
                    fr = fund_rate(hist, "LIT", a0["lit_balance"])
                    if fr:
                        row["holdings"]["rate"] = fr
                    # Same as HYPE above: merge one ring, never write a
                    # cache-derived dict over disk.
                    _persist_fund_ring(hist, "LIT")
            except Exception:
                pass
        r = rates.get(name)
        if r:
            w = r.get("windows") or {}
            d7 = (w.get("d7") or {}).get("per_day")
            d30 = (w.get("d30") or {}).get("per_day")
            supply = r.get("supply") or 0
            # Trend from 7d vs 30d — immune to the batch-burn cadence that
            # makes a 1d reading swing between zero and the whole week's burn.
            trend, ratio, ratio_note = "unknown", None, None
            if d7 is not None and d30:
                ratio = d7 / d30 if d30 > 0 else None
                if ratio is not None:
                    trend = ("accelerating" if ratio > 1.2
                             else "slowing" if ratio < 0.8 else "steady")
            elif d7 is not None and d30 == 0 and d7 > 0:
                # NOT float("inf"). _json scrubs non-finite floats to null on
                # the way out, so this never reached a client — but it built a
                # value that only one guard, in one place, stops from becoming
                # invalid JSON, and every other consumer of trend_ratio (any
                # comparison, any format) inherits it. A ratio against a zero
                # denominator is undefined; say so instead of encoding it.
                trend, ratio = "accelerating", None
                ratio_note = ("30d average is zero, so 7d/30d is undefined — "
                              "this is new activity, not a measured "
                              "acceleration")
            row["measured"] = {
                "cumulative_burned": r["cumulative"],
                "burn_1d": (w.get("d1") or {}).get("burned"),
                "burn_7d": (w.get("d7") or {}).get("burned"),
                "avg_per_day_7d": d7,
                "avg_per_day_30d": d30,
                "trend": trend, "trend_ratio": ratio,
                "trend_ratio_note": ratio_note,
                "supply": supply or None,
                # the number a burn thesis actually rests on
                "deflation_pct_yr": ((d7 * 365 / supply * 100)
                                     if d7 and supply else None),
                "cumulative_pct_supply": ((r["cumulative"] / (supply + r["cumulative"]) * 100)
                                          if supply and r["cumulative"] else None),
                "source": r["src"], "contract": r.get("contract"),
                "note": r.get("note"),
            }
            ser = hist_series.get(name) or []
            if ser:
                row["measured"]["net"] = net_supply_stats(ser)
                row["measured"]["series"] = [
                    {"ts": x["ts"], "eff": x["effective"], "sink": x["sink"]}
                    for x in ser]
        # Unified buy-pressure field so the desk can total a bid across tokens
        # that are otherwise measured in incomparable units.
        bid = None
        if BUY_FUNDED.get(name):
            if name == "HYPE":
                try:
                    b = CACHE.get_or_fetch("hype_bid", 600, hype_bid_usd_day)
                    if b:
                        bid = {"usd_day": b["usd_day"], "basis": "AF 24h fills"}
                except Exception:
                    bid = None
            # A hold-programme's bid is its wallet accumulation; without this
            # JUP bought $48k/day and contributed nothing to the total.
            if bid is None:
                hr = (row.get("holdings") or {}).get("rate")
                if hr and hr.get("per_day", 0) > 0:
                    bid = {"tokens_day": hr["per_day"],
                           "basis": hr.get("basis", "fund ring delta")}
            # NEVER the 30d archive net_per_day: that annualises a quarterly
            # batch (LIT's 11 Jul 15.6M) as a live daily bid. 1d/7d only.
            if bid is None:
                d7 = ((row.get("measured") or {}).get("avg_per_day_7d") or 0)
                d1 = ((row.get("measured") or {}).get("burn_1d") or 0)
                if d1 > 0:
                    bid = {"tokens_day": d1, "basis": "1d on-chain"}
                elif d7 > 0:
                    bid = {"tokens_day": d7, "basis": "7d on-chain"}
        h2 = row.get("holdings")
        if h2 and h2.get("held"):
            sup = None
            rec = (hist.get(name) or {})
            for day in sorted(k for k in rec if not k.startswith("_")):
                v = rec[day]
                if isinstance(v, dict) and v.get("total"):
                    sup = v["total"]
            if sup:
                h2["pct_supply"] = h2["held"] / sup * 100.0
        if bid:
            usd_now = bid.get("usd_day")
            cgp = gpx.get(prog.get("coingecko_id"))
            if usd_now is None and bid.get("tokens_day") and cgp:
                usd_now = bid["tokens_day"] * cgp
            if usd_now:
                try:
                    bid["trend"] = _bid_history(name, usd_now)
                except Exception:
                    pass
            # Same guard, applied generically: flag rather than silently total.
            vol = row.get("global_vol24h")
            usd = bid.get("usd_day")
            if usd is None and bid.get("tokens_day") and cgp:
                usd = bid["tokens_day"] * cgp
            if vol and usd and usd / vol * 100 > BID_SANITY_MAX_PCT_VOL:
                bid["implausible"] = round(usd / vol * 100, 1)
            row["bid"] = bid
        # Verification link + daily history, so the panel can be checked and
        # the trend can be seen rather than inferred from one number.
        try:
            from datasources import buyback_history as bhist
            ex = bhist.EXPLORERS.get(name)
            if ex:
                row["explorer"] = {"url": ex[0], "addr": ex[1], "label": ex[2]}
            hs = bhist.get(name)
            if hs:
                row["history"] = hs[-180:]
                row["history_stats"] = bhist.stats(hs)
                row["history_meta"] = bhist.meta(name)
                row["trend"] = bhist.trend(row["history_stats"])
                ev = bhist.last_event(hs)
                if ev:
                    row["last_event"] = ev
                # 7d USD series is live buy-pressure when on-chain 1d/7d
                # missed (UNI). Still not a 30d net smear.
                if BUY_FUNDED.get(name) and not row.get("bid"):
                    d7u = (row.get("history_stats") or {}).get("d7")
                    if d7u and d7u > 0:
                        late = {"usd_day": d7u, "basis": "7d archive"}
                        vol = row.get("global_vol24h")
                        if vol and d7u / vol * 100 > BID_SANITY_MAX_PCT_VOL:
                            late["implausible"] = round(d7u / vol * 100, 1)
                        row["bid"] = late
                try:
                    from datasources import fee_payout
                    pr = fee_payout.get(name)
                    if pr:
                        row["payout"] = pr[-14:]
                        row["payout_summary"] = fee_payout.summary(pr)
                except Exception:
                    pass
        except Exception:
            pass
        out.append(row)
    out.sort(key=lambda r: r["token"])
    off = {k: dict(v) for k, v in OFF_VENUE.items()}
    try:
        from datasources import coingecko
        px = CACHE.get_or_fetch(
            "cg_offvenue", 120,
            lambda: coingecko.simple_price([v.get("coingecko_id") for v in off.values()]))
        for k, v in off.items():
            v["price"] = px.get(v.get("coingecko_id"))
    except Exception as exc:
        for v in off.values():
            v["price"] = None
            v["price_error"] = str(exc)
    return {"programs": out, "off_venue": off, "tracked_tokens": len(hist),
            "note": "mechanism = protocol claim; realised = measured supply change"}
