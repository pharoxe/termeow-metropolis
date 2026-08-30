"""Resting orders for an arbitrary address — what is actually protecting a book.

STRICTLY READ-ONLY. This module reads public resting-order state from the HL
info endpoint. It never signs, never places, modifies or cancels an order, and
holds no key material. Everything below describes orders that already exist;
nothing here can create one.

WHY THIS EXISTS. /api/portfolio answers "what do I hold". It cannot answer
"what happens if this goes against me", because that answer lives in the ORDER
book and not in the position list: `clearinghouseState` carries no order key
and no order field on any position row. Until this module existed the terminal
could not tell its owner that he was running a beta-weighted book with ZERO
resting orders. It said nothing at all, which is at least not a lie — but on a
desk where every other pane states its own coverage, a silent stops pane is one
reading away from "there is a stop".

THE PER-DEX TRAP. `frontendOpenOrders` is scoped to ONE perp dex, exactly like
`clearinghouseState`: omitting `dex` returns CORE ONLY, and returns it with a
200 and a well-formed list, so the omission looks like an answer. That trap has
already shipped twice in this codebase. Measured 2026-08-16 on one tracked
wallet: no dex -> 50 orders; dex="xyz" -> 573 orders, same wallet, same second.
92% of the resting book was invisible. `orders()` therefore takes a dex and
`build_all()` walks the venue list the way portfolio.build_all does.

THE INVERSION THIS MODULE EXISTS TO PREVENT. A failed order query and a book
with no orders in it both arrive here as "no rows". Rendered the same they say
opposite things — one is "you are unprotected", the other is "we do not know" —
and the expensive direction is obvious. So a venue that fails is NEVER allowed
to contribute an empty list: it goes into `failed`, its positions are marked
`not_measured` rather than `unprotected`, and when EVERY venue fails `orders`
is None, `n_orders` is None, and `zero_note` is absent entirely. The presence
of `zero_note` is the only thing in this payload that means a measured zero.

REDUCE-ONLY IS READ, NOT INFERRED. `reduceOnly`, `isTrigger`, `triggerPx`,
`triggerCondition`, `isPositionTpsl` and `orderType` are all fields the API
actually returns (verified 2026-08-16 against live orders on two wallets).
Nothing here guesses that an order is an exit: an order is an exit because the
exchange flagged it one. Where a fact is DERIVED rather than read — stop-loss
versus take-profit, which position an order would close — the row names the
input that produced it and reports None when that input is missing.
"""

import json
import time
import urllib.request

INFO = "https://api.hyperliquid.xyz/info"
TIMEOUT = 30

# Same spacing portfolio.build_all uses: sequential venue calls, paced rather
# than burst, because the whale sweep is a noisy neighbour on this host.
PACE_S = 0.1

# A page size, reported as one. Measured 2026-08-16: one tracked wallet rests
# 573 orders on xyz alone. The cap is applied AFTER sorting exits first, so
# what falls off the end is always the least protective part of the book, and
# `orders_total` / `orders_note` state exactly what was dropped. The WHALES
# pane shipped the opposite of this — a cap rendered as a census.
#
# THE CAP WAS NOT THE ONLY THING REMOVING ROWS. `_shape` drops any order with
# no size or no coin, and that filter had no disclosure at all: every count in
# the payload was computed over the survivors while the payload described
# itself as covering the wallet's orders. It is counted now
# (`orders_unshapeable`) and named in `orders_note` — the same treatment the
# cap gets, for the same reason.
ORDER_CAP = 200


def _post(payload):
    req = urllib.request.Request(
        INFO, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read())


def _f(x, default=None):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def orders(address, dex=""):
    """Raw resting orders for an address on ONE perp dex.

    `dex` is the HIP-3 deployment key ("" = core Hyperliquid, "xyz" = the
    equity/commodity DEX). Omitting it does not mean "all orders" — see the
    module docstring. Coins come back already namespaced on a HIP-3 dex
    ("xyz:RIVN"), the same convention clearinghouseState uses, so rows from
    two venues merge into one list with no possibility of a collision.

    Raises on failure. It MUST: a caller that cannot tell an empty book from
    a broken query is the entire defect this module was written against.
    """
    payload = {"type": "frontendOpenOrders", "user": address}
    if dex:
        payload["dex"] = dex
    return _post(payload) or []


def _trigger_dir(order):
    """'above' / 'below' / None — which way price must move to fire this.

    `triggerCondition` is served as prose ("Price above 64112"). Parsing prose
    is fragile, so the parse is reported rather than assumed: a row that could
    not be read says so instead of defaulting to a direction.
    """
    txt = (order.get("triggerCondition") or "").lower()
    if "above" in txt:
        return "above"
    if "below" in txt:
        return "below"
    return None


def _kind(row, raw, pos):
    """(kind, kind_src) for one order.

    A non-trigger order is named from what the exchange called it. A trigger
    is a stop-loss only when it fires on the LOSING side of an open position —
    below for a long, above for a short — which needs both the trigger
    direction and the position side. With either input missing the row keeps
    `kind: None` and names what was missing. An unclassified trigger must not
    quietly become "take-profit": that is the reading that reports a protected
    book as bare, and the reverse reading costs more.
    """
    if not row["is_trigger"]:
        return (("reduce-only limit" if row["reduce_only"] else "limit"),
                "orderType=%r + reduceOnly=%s" % (raw.get("orderType"),
                                                  row["reduce_only"]))
    direction = _trigger_dir(raw)
    if direction is None:
        return None, ("triggerCondition %r did not parse — direction unknown, "
                      "so this trigger is NOT classified"
                      % (row["trigger_condition"],))
    if pos is None:
        return None, ("no open %s position, so there is no side to measure "
                      "this trigger against" % row["coin"])
    losing = "below" if pos["side"] == "long" else "above"
    return (("stop-loss" if direction == losing else "take-profit"),
            "triggerCondition says %s, against a %s position"
            % (direction, pos["side"]))


def _protects(row, pos):
    """(protects, protects_pct, note) — what this order would actually close.

    Only claimed when the exchange flagged the order reduce-only AND an open
    position exists on the side this order closes. A reduce-only order with no
    position behind it is a live order that protects nothing, and it says so
    rather than being counted as cover.
    """
    if not row["reduce_only"]:
        return None, None, None
    if pos is None:
        return None, None, ("reduce-only but there is no open %s position — "
                            "this order protects nothing right now"
                            % row["coin"])
    if pos["side"] != row["closes_side"]:
        return None, None, ("reduce-only %s on a %s %s position — it does not "
                            "close it" % (row["side"], pos["side"], row["coin"]))
    size = pos.get("size")
    return row["coin"], ((row["sz"] / size * 100.0) if size else None), None


def _shape(raw, dex, positions_by_coin):
    """One API order -> one row that says what it would do.

    `notional` is size times the price this order references. For a Stop
    Market the API's `limitPx` is the exchange's slippage bound and not an
    expected fill, so the reference price actually used is NAMED in
    `notional_px_src` instead of being left for the reader to assume.
    """
    coin = raw.get("coin")
    px = _f(raw.get("limitPx"))
    sz = _f(raw.get("sz"))
    if not coin or not sz:
        return None
    side = "bid" if raw.get("side") == "B" else "ask"
    trig = _f(raw.get("triggerPx")) or None
    is_trigger = bool(raw.get("isTrigger"))
    ref_px = trig if (is_trigger and trig) else px
    row = {
        "coin": coin,
        "dex": dex,
        "venue": dex or "HL core",
        "side": side,
        # A bid CLOSES a short; a long is closed by an ask. Stated once here
        # so no consumer has to re-derive it from B/A.
        "closes_side": "short" if side == "bid" else "long",
        "oid": raw.get("oid"),
        "order_type": raw.get("orderType"),
        "tif": raw.get("tif"),
        "limit_px": px,
        "sz": sz,
        "orig_sz": _f(raw.get("origSz")),
        "notional": (ref_px * sz) if ref_px else None,
        "notional_px_src": ("trigger_px" if (is_trigger and trig)
                            else "limit_px" if px else None),
        "reduce_only": bool(raw.get("reduceOnly")),
        "is_trigger": is_trigger,
        "trigger_px": trig,
        "trigger_condition": raw.get("triggerCondition"),
        "is_position_tpsl": bool(raw.get("isPositionTpsl")),
        # role is READ from reduceOnly, never inferred. A non-reduce-only sell
        # against a long would in fact shrink it, but the exchange makes no
        # such promise about it and it can flip the position instead, so it is
        # not called an exit here.
        "role": "exit" if raw.get("reduceOnly") else "open_or_add",
        "ts": int((raw.get("timestamp") or 0) / 1000) or None,
    }
    pos = (positions_by_coin or {}).get(coin)
    row["kind"], row["kind_src"] = _kind(row, raw, pos)
    row["protects"], row["protects_pct"], row["protects_note"] = _protects(row, pos)
    return row


def _sort_key(row):
    return (row["role"] != "exit", -(row["notional"] or 0.0))


def build(address, dex="", positions_by_coin=None):
    """Every resting order on ONE venue, shaped. Raises if the venue fails.

    Returns a per-venue SUMMARY plus its rows; build_all keeps the summary and
    merges the rows, so an order is never serialised twice.
    """
    rows = []
    # WHAT _shape DROPS IS NOT NOTHING, and until now nothing said so.
    # `if not coin or not sz: return None` silently removed rows and every
    # count below was then computed over the SURVIVORS while the payload
    # claimed to describe all orders — a filter presented as a census, which
    # is the same defect the ORDER_CAP note above exists to prevent. Counted
    # here and disclosed in `orders_note`, per venue and in the total.
    dropped = 0
    for raw in orders(address, dex=dex):
        row = _shape(raw, dex, positions_by_coin)
        if row is not None:
            rows.append(row)
        else:
            dropped += 1
    rows.sort(key=_sort_key)
    return {
        "venue": dex or "HL core",
        "dex": dex,
        "state": "fetched",
        "n_orders": len(rows),
        # Rows the venue returned that carry no size or no coin — fully
        # filled, cancelled mid-flight, or otherwise unusable. They are NOT
        # resting exposure, so they are not counted as orders; they are
        # reported so the count can be reconciled against the venue's own.
        "n_unshapeable": dropped,
        "n_reduce_only": sum(1 for r in rows if r["reduce_only"]),
        "n_stop_loss": sum(1 for r in rows if r["kind"] == "stop-loss"),
        "n_take_profit": sum(1 for r in rows if r["kind"] == "take-profit"),
        "resting_notional": sum(r["notional"] or 0.0 for r in rows),
    }, rows


def _protection(positions, ok_dexs, failed_by_dex, rows_by_coin, positions_note):
    """Per position: is this leg protected, and is that answer even measured?

    Three outcomes, and they are not interchangeable. `unprotected` is a claim
    about the market — this venue answered and no exit is resting. `stop-loss`
    is a claim that a floor exists. `not_measured` is a claim about this
    server: the venue that would have told us failed, and its error rides on
    the row so a missing answer cannot be read as a zero.
    """
    out = []
    for p in positions or []:
        dex = p.get("dex") or ""
        rec = {
            "coin": p["coin"], "venue": p.get("venue") or (dex or "HL core"),
            "dex": dex, "side": p["side"], "size": p.get("size"),
            "notional": p.get("notional"), "liq_px": p.get("liq_px"),
            "liq_dist_pct": p.get("liq_dist_pct"),
        }
        if dex not in ok_dexs:
            fail = failed_by_dex.get(dex) or {}
            rec.update({
                "state": "not_measured",
                "n_exit_orders": None, "n_stop_loss": None,
                "covered_pct": None, "nearest_stop_px": None,
                "venue_error": fail.get("error"),
                "why": ("the resting-order query for %s FAILED (%s) — this "
                        "leg's protection is UNKNOWN. It is not unprotected "
                        "and it is not protected: nothing was measured."
                        % (rec["venue"],
                           fail.get("error") or "venue was not queried")),
            })
            out.append(rec)
            continue
        exits = [r for r in (rows_by_coin.get(p["coin"]) or [])
                 if r["reduce_only"] and r["closes_side"] == p["side"]]
        stops = [r for r in exits if r["kind"] == "stop-loss"]
        tps = [r for r in exits if r["kind"] == "take-profit"]
        size = p.get("size") or 0.0
        covered = sum(r["sz"] for r in exits)
        trigs = [r["trigger_px"] for r in stops if r["trigger_px"]]
        rec.update({
            "state": ("stop-loss" if stops else
                      "exit-orders-only" if exits else "unprotected"),
            "n_exit_orders": len(exits),
            "n_stop_loss": len(stops),
            "n_take_profit": len(tps),
            "exit_size": covered,
            "covered_pct": (covered / size * 100.0) if size else None,
            # The stop that fires FIRST: the highest for a long, the lowest
            # for a short. "Nearest" on the wrong side of the position would
            # quote the furthest floor as the protection in force.
            "nearest_stop_px": ((max(trigs) if p["side"] == "long" else min(trigs))
                                if trigs else None),
            "exit_oids": [r["oid"] for r in exits],
        })
        if not exits:
            rec["why"] = ("%s answered and holds NO reduce-only order that "
                          "would close this %s — measured, not assumed"
                          % (rec["venue"], p["side"]))
        elif not stops:
            rec["why"] = ("%d reduce-only order(s) rest against this leg but "
                          "none of them is a stop-loss — an exit above the "
                          "trade is not a floor under it" % len(exits))
        if positions_note:
            rec["positions_note"] = positions_note
        out.append(rec)
    return out


def build_all(address, dexs, positions=None, positions_error=None):
    """Resting orders across every venue this account might hold on.

    A venue that FAILS is reported in `failed`, never dropped, and never
    contributes an empty list — the same doctrine portfolio.build_all applies
    to positions, for the same reason and with a sharper edge: a partial
    position book understates exposure, a partial ORDER book overstates
    protection.

    `positions` is the already-fetched portfolio position list (venue-tagged,
    coins namespaced). It is an INPUT rather than another fetch, so this costs
    no extra clearinghouseState calls. When it could not be fetched,
    `positions_error` is set and the payload says protection is unmeasured
    instead of quietly describing a book with no legs in it.
    """
    pos_by_coin = {p["coin"]: p for p in (positions or [])}
    venues, failed, all_rows = [], [], []
    for dex in dexs:
        try:
            summary, rows = build(address, dex=dex, positions_by_coin=pos_by_coin)
        except Exception as exc:
            failed.append({
                "venue": dex or "HL core", "dex": dex,
                "error": str(exc)[:160],
                "error_kind": type(exc).__name__,
                "impact": ("resting orders on %s are NOT MEASURED — any "
                           "position on this venue has UNKNOWN protection, "
                           "which is not the same as none"
                           % (dex or "HL core")),
            })
            venues.append({"venue": dex or "HL core", "dex": dex,
                           "state": "failed", "n_orders": None,
                           "error": str(exc)[:160]})
            time.sleep(PACE_S)
            continue
        time.sleep(PACE_S)
        venues.append(summary)
        all_rows.extend(rows)

    ok_dexs = {v["dex"] for v in venues if v["state"] == "fetched"}
    failed_by_dex = {f["dex"]: f for f in failed}
    rows_by_coin = {}
    for r in all_rows:
        rows_by_coin.setdefault(r["coin"], []).append(r)

    all_rows.sort(key=_sort_key)
    total = len(all_rows)
    shown = all_rows[:ORDER_CAP]

    n_ok, n_failed = len(ok_dexs), len(failed)
    state = ("not_measured" if not n_ok else
             "partial" if n_failed else "measured")
    queried = [d or "HL core" for d in dexs]

    positions_note = None
    if positions_error:
        positions_note = ("positions could not be fetched (%s) — which leg an "
                          "order protects is NOT MEASURED" % positions_error)
    elif positions is None:
        positions_note = ("no position list was supplied, so no order in this "
                          "payload is related to a leg")

    out = {
        "address": address,
        "state": state,
        "venues": venues,
        "venues_queried": queried,
        "venues_ok": sorted(v["venue"] for v in venues if v["state"] == "fetched"),
        "venues_failed": [f["venue"] for f in failed],
        "failed": failed,
        # NEVER [] when nothing was measured. A client doing `d.orders || []`
        # on a total failure would print "no stops" over an unmeasured book,
        # so the only honest value here is null — and the only key that ever
        # means a measured zero is `zero_note`.
        "orders": shown if n_ok else None,
        "n_orders": total if n_ok else None,
        "orders_shown": len(shown) if n_ok else None,
        "orders_total": total if n_ok else None,
        "orders_cap": ORDER_CAP,
        # Rows the venues returned that could not be shaped into an order —
        # see build(). Reported so `orders_total` can be reconciled against
        # what the venue actually sent, rather than looking like the whole of
        # it. Null when nothing was measured, for the same reason as the rest.
        "orders_unshapeable": (sum(v.get("n_unshapeable") or 0 for v in venues)
                               if n_ok else None),
        "n_reduce_only": (sum(1 for r in all_rows if r["reduce_only"])
                          if n_ok else None),
        "n_stop_loss": (sum(1 for r in all_rows if r["kind"] == "stop-loss")
                        if n_ok else None),
        "n_take_profit": (sum(1 for r in all_rows if r["kind"] == "take-profit")
                          if n_ok else None),
        "n_open_or_add": (sum(1 for r in all_rows if r["role"] != "exit")
                          if n_ok else None),
        "resting_notional": (sum(r["notional"] or 0.0 for r in all_rows)
                             if n_ok else None),
        "protection": _protection(positions, ok_dexs, failed_by_dex,
                                  rows_by_coin, positions_note),
        "positions_note": positions_note,
        "at": time.time(),
    }
    prot = out["protection"]
    out["n_positions"] = len(prot)
    # NULL, not 0, when nothing was measured. "0 unprotected" over a book
    # whose every order query failed is a green light drawn from no data —
    # the same shape as "measured zero" wearing "not measured"'s clothes, in
    # the direction that costs money. n_protection_not_measured stays a real
    # count because it is the one number that IS measured in that state.
    measured = out["state"] != "not_measured"
    out["n_with_stop"] = (sum(1 for p in prot if p["state"] == "stop-loss")
                          if measured else None)
    out["n_exit_only"] = (sum(1 for p in prot if p["state"] == "exit-orders-only")
                          if measured else None)
    out["n_unprotected"] = (sum(1 for p in prot if p["state"] == "unprotected")
                            if measured else None)
    out["n_protection_not_measured"] = sum(1 for p in prot
                                           if p["state"] == "not_measured")

    if state == "not_measured":
        out["not_measured_note"] = (
            "EVERY venue queried (%s) failed the resting-order query, so this "
            "account's stops are NOT MEASURED. `orders` is null and not an "
            "empty list on purpose: an empty list here reads as 'no stops', "
            "which is the opposite of what happened. The errors are in "
            "`failed`." % ", ".join(queried))
    elif state == "partial":
        out["partial_note"] = (
            "%d of %d venues answered; %s FAILED. Every count in this payload "
            "is a LOWER BOUND — there may be resting orders on the failed "
            "venue(s) that are not in it, and positions there are marked "
            "not_measured rather than unprotected."
            % (n_ok, len(dexs), ", ".join(f["venue"] for f in failed)))
    elif total == 0:
        # The ONLY key in this payload that means a measured zero.
        out["zero_note"] = (
            "NO resting orders on %s. Every venue queried answered, so this "
            "is a MEASURED zero: nothing is waiting to enter and — more to "
            "the point — nothing is waiting to exit." % ", ".join(queried))
    notes = []
    if total > ORDER_CAP:
        notes.append(
            "this is a PAGE: %d of %d resting orders, sorted exits first then "
            "by notional. %d orders are NOT in the list — every count above "
            "(n_orders, n_reduce_only, n_stop_loss) is over ALL %d, and the "
            "protection block is computed over all %d too."
            % (len(shown), total, total - len(shown), total, total))
    unshaped = out["orders_unshapeable"]
    if unshaped:
        # The counts above are over shapeable orders, and saying so is the
        # whole point: this payload used to assert its counts covered every
        # order while a `not sz` filter had already removed some of them.
        notes.append(
            "%d further row(s) came back from the venue(s) with no size or no "
            "coin and are NOT counted anywhere above — they carry no resting "
            "exposure, but `orders_total` is therefore %d of the %d rows the "
            "venue(s) returned, not all of them."
            % (unshaped, total, total + unshaped))
    if notes:
        out["orders_note"] = " ".join(notes)
    return out
