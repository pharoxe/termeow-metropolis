"""Whale tracking: what the biggest ACTIVE Hyperliquid wallets are doing.

Selection — the vault trap. The obvious roster ("largest accounts by
accountValue") is poisoned: the top accounts by value ($14B, $4.5B...) are
vaults and bridges holding ZERO perp positions. Verified 2026-08-11. So
selection uses the leaderboard's windowPerformances instead: top wallets by
week VOLUME (the flow), by week PNL (hot hands) and by month PNL (consistent
winners), all above an accountValue floor that excludes dust/sub-accounts.
The week-vlm and week-pnl top-200 cohorts overlap by only 40 wallets — they
carry genuinely independent information, so we track the union, ranked by a
blended score, capped at WHALE_MAX_TRACKED.

Sweeps. Every WHALE_SWEEP_INTERVAL_S a small thread pool POSTs
clearinghouseState per tracked wallet (~17s for a full 305-candidate sweep at
5 workers — measured). Consecutive successful snapshots are diffed per
(wallet, coin) into events: opened / closed / flipped / increased / decreased,
surfaced only when the notional delta clears WHALE_EVENT_MIN_NTL. A wallet
whose fetch fails keeps its previous snapshot and is NOT diffed this round —
a fetch error must never fabricate a "closed" event.

Dormancy. ~Half of any leaderboard cohort is flat at a given moment. A wallet
with zero positions for 3 consecutive sweeps is marked dormant and skipped
(halves API cost); dormancy resets on every roster refresh (24h) so returning
wallets are re-picked-up. Never filtered at selection time — a flat whale
about to open is exactly the event we want.

Venues. clearinghouseState is scoped PER DEX: posted with no "dex" key it
returns CORE positions only — it does not return "everything". For its whole
life this sweep posted no dex key, so every HIP-3 deployment was invisible.
Measured 2026-08-14 on the live roster: 16 of the first 40 wallets held on
`xyz` ($366,829,518 notional); across 70 wallets, 362 xyz positions worth
$224.5M, 53.5% of tracked positions by count; and the store held 177 distinct
coins with not one of them from xyz. Querying every dex for every wallet
would take the sweep from 400 upstream calls per 15 minutes to 600+ into an
endpoint that already sheds ~21 of the 400, so the dex phase is TARGETED: a
rotating discovery probe learns which wallets hold where, and only known
holders are re-queried each sweep.

Coverage. A coin on a venue the sweep has not queried reports
state="not_covered" and n_positions=NULL — never 0. The two are the same
number and completely different facts, and the whale chart overlay (default
ON) rendered the first as the second on every xyz market for a year.

Honesty. The API payload says warming=True until two sweeps exist (no diff is
possible before that), and per-coin 24h deltas are null (not 0) until 24h of
hourly aggregates have actually accrued.

STRICTLY READ-ONLY: public endpoints only, no keys, no orders.
"""

import functools
import json
import os
import tempfile
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# ---- selection ----
WHALE_ACCOUNT_FLOOR = 250_000    # excludes dust/sub-accounts
WHALE_TOP_WEEK_VLM = 150         # flow whales
WHALE_TOP_WEEK_PNL = 150         # hot hands
WHALE_TOP_MONTH_PNL = 100        # consistent winners
WHALE_MAX_TRACKED = 200          # cap after ranking
WHALE_ROSTER_TTL_H = 24          # leaderboard refetch cadence (33.8MB payload)
DORMANT_AFTER_SWEEPS = 3         # consecutive flat sweeps before skipping

# ---- HIP-3 venues ----
# Which deployments earn a per-wallet call. Measured 2026-08-14: xyz traded
# $4.18B/24h against core Hyperliquid's $2.77B, while the other seven live
# deployments totalled $14M between them (para $8M, mkts $5M, hyna $1M, the
# rest exactly zero). A volume floor rather than a hardcoded "xyz" so a
# deployment that starts trading is picked up on its own and a dead one never
# costs a call; the cap bounds the worst case if several go live at once.
WHALE_DEX_VOL_FLOOR = 50_000_000     # 24h USD
WHALE_MAX_DEXS = 3
WHALE_DEX_TTL_H = 6                  # how often the dex list is re-measured
# Discovery. Holder status for one (wallet, dex) costs one call and the roster
# is 200 wallets, so probing all of them every sweep would cost more than the
# targeted positions pass it exists to make possible. Each sweep probes the
# BATCH least-recently-probed non-holders: 200 / 16 = a full re-probe every
# ~13 sweeps (~3.2h). Confirmed holders are re-confirmed every sweep for free
# by their own positions call, so the rotation only ever chases new entrants.
WHALE_DISCOVERY_BATCH = 16
# The dex phase runs after the core phase, with fewer workers and a hard floor
# on the gap between calls. whales.py and venues.py are noisy neighbours —
# venues.py was shed at ten simultaneous calls — and this is additive load on
# an endpoint already shedding 21 of the core phase's 400.
WHALE_DEX_WORKERS = 3
# Measured on the first live cold-start pass, run (as boot sweeps always are)
# alongside the prewarm burst: 0.06s spacing shed 56 of 164 probes, 34%. At
# 0.15s the phase arrives at ~6.7 calls/s against the core phase's 17/s, and
# whatever still sheds is picked up by the retry below.
WHALE_DEX_PACE_S = 0.15
# Resting orders are NOT fetched per dex. Measured over 1,230 live xyz orders
# on five holders: median $30,193, p90 $105,963, largest $141,825, and ZERO
# cleared the $250k bar this module surfaces orders at — a second call per
# holder for a list guaranteed to filter to empty. So the xyz order book is
# reported as NOT COVERED rather than as "no resting size". Flip this on only
# together with a per-dex notional bar.
WHALE_DEX_ORDERS = False
# Failures are reported, not dropped (venues.py pattern). Bounded so a total
# upstream outage cannot write a 200-entry list into every payload.
WHALE_FAILED_CAP = 60

# ---- sweep / events ----
WHALE_SWEEP_INTERVAL_S = 900
# Max age of the previous snapshot for a diff to be honest. 3x the sweep
# interval tolerates one missed/failed round; beyond that (restart, laptop
# sleep, dormancy skip) the wallet is RE-BASELINED: snapshot updated, no
# events emitted — otherwise hours-old moves get stamped ts=now, presented
# as 15-minute-granularity events, and can fire Telegram alerts.
# Breather before the retry pass, so it does not simply re-enter the same
# rate-limit window it was shed by.
WHALE_RETRY_PAUSE_S = 3.0
# Fill clock: one userFillsByTime per CHANGED wallet. Window is the
# previous snapshot age plus slack, capped at 60m so a rebaseline gap
# never becomes a 2000-row dump. Pace so N changed wallets cannot 429.
FILL_LOOKBACK_SLACK_S = 60
FILL_LOOKBACK_MAX_S = 3600
FILL_PACE_S = 0.2

WHALE_REBASELINE_GAP_S = 3 * WHALE_SWEEP_INTERVAL_S
WHALE_SWEEP_WORKERS = 5
WHALE_EVENT_MIN_NTL = 250_000    # USD notional of the delta to surface
WHALE_CHANGE_PCT = 0.30          # increased/decreased threshold on |szi|
# Events roll at ~10/hr, so 500 was ~2 days: the feed was eating its own
# history before it was old enough to test anything against.
WHALE_EVENTS_CAP = 20000

# ---- alerts ----
WHALE_ALERT_MIN_NTL = 1_000_000
WHALE_ALERT_COOLDOWN_S = 3600    # per (addr, coin)

# 26 rows meant the whale board's own history was capped at ~26h and could
# NEVER deepen — the panel was permanently unbacktestable by construction,
# and every hour past the cap was discarded irreversibly. This is the one
# store here that cannot be rebuilt from any API: Hyperliquid publishes
# positions as a live snapshot with no archive, so an hour not written is
# an hour gone. 400 days at ~40 coins x 2 floats is a few MB.
AGG_HOURLY_CAP = 400 * 24

LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"
INFO_URL = "https://api.hyperliquid.xyz/info"
INFO_TIMEOUT = 30

_DATA_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
ROSTER_STORE = os.path.join(_DATA_DIR, "whale_roster.json")
# Resting orders below this notional are noise at whale scale; matches the
# event bar so the two feeds describe the same size class.
WHALE_ORDER_MIN_NTL = 250_000
WHALE_TOP_ORDERS = 40
WHALE_EVENTS_PAGE = 100   # a PAGE of the event store, never its size
# Likewise a PAGE. The FRESH CONVICTION board shows the largest N fresh
# opens/flips of the last 24h; the number was buried in a `[:5]` slice with
# nothing shipped beside it, so the pane could not tell 5-of-5 from 5-of-40.
FRESH_CAP = 5

POSITIONS_STORE = os.path.join(_DATA_DIR, "whale_positions.json")
EVENTS_STORE = os.path.join(_DATA_DIR, "whale_events.json")

_LOCK = threading.Lock()
# In-memory alert cooldown: {(addr, coin): last_alert_ts}. Deliberately not
# persisted — a restart re-arming alerts is acceptable; alert_log is the
# durable audit trail.
_ALERT_LAST = {}
# Consecutive flat-sweep counter per addr, reset on roster refresh.
_FLAT_STREAK = {}


def _f(x, default=None):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return v if v == v and abs(v) != float("inf") else default


def _load(path, fallback):
    try:
        with open(path) as fh:
            d = json.load(fh)
        return d if isinstance(d, type(fallback)) else fallback
    except (OSError, ValueError):
        return fallback


def _save(path, obj):
    """Atomic tmp+rename, same discipline as oi_history._save."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(obj, fh, separators=(",", ":"))
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _post_info(payload):
    req = urllib.request.Request(
        INFO_URL, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=INFO_TIMEOUT) as resp:
        return json.loads(resp.read())


def dex_of(coin):
    """`xyz:TSLA` -> "xyz"; `BTC` -> "" (core HL).

    The dex prefix travels with the coin name everywhere in this codebase
    because it travels with it in the API — clearinghouseState on dex=xyz
    returns coins already namespaced, so snapshots from two venues merge into
    one position list with no possibility of a collision.
    """
    c = coin or ""
    return c.split(":")[0] if ":" in c else ""


def venue_name(dex):
    return dex or "HL core"


class _Pacer:
    """A floor on the gap between upstream calls, shared by a worker pool.

    ThreadPoolExecutor.map fires as fast as the workers drain, which is how a
    3-worker pass still arrives as a burst; this spaces the arrivals instead.
    """

    def __init__(self, gap_s):
        self._gap = gap_s
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self):
        now = time.time()
        with self._lock:
            at = max(now, self._next)
            self._next = at + self._gap
        if at > now:
            time.sleep(at - now)


# --------------------------------------------------------------------------
# Roster
# --------------------------------------------------------------------------

def _short(addr):
    return addr[:6] + "…" + addr[-4:]


def _fetch_leaderboard():
    req = urllib.request.Request(LEADERBOARD_URL)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())


def _windows(row):
    """{window_name: {pnl, vlm}} with floats, from windowPerformances."""
    out = {}
    for item in row.get("windowPerformances") or []:
        try:
            name, perf = item[0], item[1]
        except (IndexError, TypeError):
            continue
        out[name] = {"pnl": _f(perf.get("pnl"), 0.0) or 0.0,
                     "vlm": _f(perf.get("vlm"), 0.0) or 0.0}
    return out


def build_roster(rows):
    """Rank leaderboard rows into the tracked roster. Pure, testable."""
    cands = {}
    for row in rows:
        addr = row.get("ethAddress")
        av = _f(row.get("accountValue"), 0.0) or 0.0
        if not addr or av < WHALE_ACCOUNT_FLOOR:
            continue
        w = _windows(row)
        cands[addr] = {
            "addr": addr,
            "label": (row.get("displayName") or "").strip() or _short(addr),
            "account_value": av,
            "week_vlm": (w.get("week") or {}).get("vlm", 0.0),
            "week_pnl": (w.get("week") or {}).get("pnl", 0.0),
            "month_pnl": (w.get("month") or {}).get("pnl", 0.0),
        }
    rows_by = lambda key, n: sorted(
        cands.values(), key=lambda r: r[key], reverse=True)[:n]
    union = {}
    for r in (rows_by("week_vlm", WHALE_TOP_WEEK_VLM)
              + rows_by("week_pnl", WHALE_TOP_WEEK_PNL)
              + rows_by("month_pnl", WHALE_TOP_MONTH_PNL)):
        union[r["addr"]] = r
    # rank_norm within the union: best = 1.0, worst = 0.0
    members = list(union.values())
    n = len(members)
    for key in ("week_vlm", "week_pnl", "month_pnl"):
        order = sorted(members, key=lambda r: r[key], reverse=True)
        for i, r in enumerate(order):
            r["_rn_" + key] = 1.0 - (i / (n - 1) if n > 1 else 0.0)
    for r in members:
        r["score"] = round(0.5 * r.pop("_rn_week_vlm")
                           + 0.3 * r.pop("_rn_week_pnl")
                           + 0.2 * r.pop("_rn_month_pnl"), 4)
        r["dormant"] = False
    members.sort(key=lambda r: r["score"], reverse=True)
    return members[:WHALE_MAX_TRACKED]


def refresh_roster(force=False):
    """Fetch the leaderboard and rebuild the roster if it is stale.

    Returns (roster_list, fetched_at, stale). On fetch failure the previous
    roster is kept and stale=True — a dead upstream must never blank the
    tracked set.
    """
    disk = _load(ROSTER_STORE, {})
    roster = disk.get("roster") or []
    fetched_at = disk.get("fetched_at") or 0
    age_h = (time.time() - fetched_at) / 3600.0 if fetched_at else 1e9
    if roster and age_h < WHALE_ROSTER_TTL_H and not force:
        return roster, fetched_at, bool(disk.get("stale"))
    try:
        rows = _fetch_leaderboard()
        if isinstance(rows, dict):  # payload wraps rows under a key
            for v in rows.values():
                if isinstance(v, list):
                    rows = v
                    break
        roster_new = build_roster(rows)
        if not roster_new:
            raise ValueError("leaderboard parsed to empty roster")
        fetched_at = time.time()
        _save(ROSTER_STORE, {"roster": roster_new, "fetched_at": fetched_at,
                             "stale": False})
        _FLAT_STREAK.clear()   # dormancy resets on roster refresh (by design)
        return roster_new, fetched_at, False
    except Exception:
        if roster:
            _save(ROSTER_STORE, {"roster": roster, "fetched_at": fetched_at,
                                 "stale": True})
            return roster, fetched_at, True
        return [], 0, True


# --------------------------------------------------------------------------
# HIP-3 venues
# --------------------------------------------------------------------------

def refresh_dexs(prev=None, now=None):
    """Which HIP-3 deployments are worth a per-wallet call, by 24h volume.

    Returns the stored shape {"list", "at", "stale", "measured"}. Volume is
    read through venues.py rather than re-implemented here so there is one
    definition of "this deployment is actually traded" in the codebase.

    On failure the PREVIOUS list is kept and stale=True. A shed discovery
    call must never quietly narrow the sweep back to core-only: that is the
    same one-level-up failure venues.hl_dexs() documents, where a single lost
    call made every HIP-3 venue vanish from a total that still looked whole.
    A dex already on the list whose volume call is shed is carried forward on
    its previous measurement for the same reason.
    """
    now = now or time.time()
    prev = prev or {}
    age_h = (now - (prev.get("at") or 0)) / 3600.0
    if prev.get("list") is not None and age_h < WHALE_DEX_TTL_H:
        return prev
    kept_prev = list(prev.get("list") or [])
    try:
        from datasources import venues
        dexs, err = venues.hl_dexs()
        if err:
            raise ValueError("perpDexs: " + err)
        measured, unmeasured = [], []
        for d in dexs:
            key = d.get("key") or ""
            if not key:
                continue                      # core is always swept
            try:
                v = venues.hl_venue(key)
            except Exception:
                unmeasured.append(key)
                continue
            measured.append({"dex": key, "vol_24h": round(v.get("vol_24h") or 0.0)})
            time.sleep(WHALE_DEX_PACE_S)
        measured.sort(key=lambda m: -m["vol_24h"])
        keep = [m["dex"] for m in measured if m["vol_24h"] >= WHALE_DEX_VOL_FLOOR]
        keep += [k for k in kept_prev if k in unmeasured and k not in keep]
        return {"list": keep[:WHALE_MAX_DEXS], "at": now, "stale": False,
                "unmeasured": unmeasured, "measured": measured[:10]}
    except Exception as exc:
        return {"list": kept_prev, "at": prev.get("at") or 0, "stale": True,
                "error": str(exc)[:120],
                "unmeasured": prev.get("unmeasured") or [],
                "measured": prev.get("measured") or []}


def dex_targets(dex, candidates, dex_seen, batch=WHALE_DISCOVERY_BATCH):
    """Who to query on ONE dex this sweep: (known holders, discovery probes).

    Pure, so the rotation is testable without touching the network.
    ``dex_seen`` is {addr: {dex: {"at": ts, "holds": bool}}}. A wallet never
    probed sorts first (at=0), so the rotation front-loads genuinely unknown
    wallets before re-checking ones already measured as not holding.
    """
    holders, others = [], []
    for addr in candidates:
        rec = ((dex_seen.get(addr) or {}).get(dex)) or {}
        if rec.get("holds"):
            holders.append(addr)
        else:
            others.append((_f(rec.get("at"), 0.0) or 0.0, addr))
    others.sort()
    return holders, [a for _, a in others[:batch]]


# --------------------------------------------------------------------------
# Per-wallet fetch + diff
# --------------------------------------------------------------------------

def _fetch_wallet(addr, dex="", want_orders=True, pacer=None):
    """Open perp positions for one wallet on ONE dex, or None on failure.

    `dex` is the HIP-3 deployment key ("" = core Hyperliquid). Hyperliquid
    scopes clearinghouseState per dex, so this is called once per venue the
    wallet is known to trade; see portfolio.state(), which fixed the identical
    omission on the PORT pane. `marginSummary` is per-dex too and account
    values from two venues are NOT additive, so only the core call's account
    value is kept (portfolio.build_all documents why there is no cross-venue
    total).
    """
    if pacer:
        pacer.wait()
    payload_in = {"type": "clearinghouseState", "user": addr}
    if dex:
        payload_in["dex"] = dex
    try:
        raw = _post_info(payload_in)
    except Exception:
        return None
    positions = []
    for ap in raw.get("assetPositions") or []:
        p = ap.get("position") or {}
        coin = p.get("coin")
        szi = _f(p.get("szi"), 0.0) or 0.0
        if not coin or szi == 0:
            continue
        positions.append({
            "coin": coin,
            "szi": szi,
            "entry_px": _f(p.get("entryPx")),
            "position_ntl": abs(_f(p.get("positionValue"), 0.0) or 0.0),
            "upnl": _f(p.get("unrealizedPnl"), 0.0) or 0.0,
            "lev": _f((p.get("leverage") or {}).get("value")),
            "liq_px": _f(p.get("liquidationPx")),
        })
    ms = raw.get("marginSummary") or {}
    # Resting limit orders answer the question positions cannot: where is
    # this wallet WAITING to trade. reduce_only separates a planned exit
    # from a planned entry; trigger orders are stops/TPs, kept but tagged.
    orders = []
    if want_orders:
        try:
            ord_in = {"type": "frontendOpenOrders", "user": addr}
            if dex:
                ord_in["dex"] = dex
            if pacer:
                pacer.wait()
            for o in _post_info(ord_in) or []:
                px = _f(o.get("limitPx"))
                sz = _f(o.get("sz"))
                if not px or not sz:
                    continue
                ntl = px * sz
                if ntl < WHALE_ORDER_MIN_NTL:
                    continue
                orders.append({
                    "coin": o.get("coin"),
                    "side": "bid" if o.get("side") == "B" else "ask",
                    "limit_px": px,
                    "ntl": round(ntl),
                    "reduce_only": bool(o.get("reduceOnly")),
                    "is_trigger": bool(o.get("isTrigger")),
                    "trigger_px": _f(o.get("triggerPx")) or None,
                    "ts": int((o.get("timestamp") or 0) / 1000) or None,
                })
        except Exception:
            pass      # orders are enrichment; their failure must not drop the wallet
    orders.sort(key=lambda o: o["ntl"], reverse=True)
    return {"positions": positions,
            "orders": orders[:20],
            "account_value": _f(ms.get("accountValue"), 0.0) or 0.0}


def diff_wallet(prev_positions, curr_positions, addr, label, now=None):
    """Events between two SUCCESSFUL snapshots of one wallet.

    Never called when either side failed to fetch — the caller guarantees
    both snapshots are real, so an absent coin genuinely means flat.
    """
    now = now or time.time()
    prev = {p["coin"]: p for p in (prev_positions or [])}
    curr = {p["coin"]: p for p in (curr_positions or [])}
    events = []
    for coin in set(prev) | set(curr):
        p, c = prev.get(coin), curr.get(coin)
        p_szi = p["szi"] if p else 0.0
        c_szi = c["szi"] if c else 0.0
        if p_szi == 0.0 and c_szi == 0.0:
            continue
        # mark price from whichever snapshot has size (ntl / |szi|)
        ref = c if c and c_szi else p
        mark = (ref["position_ntl"] / abs(ref["szi"])) if ref and ref["szi"] else 0.0
        etype = None
        if p_szi == 0.0:
            etype = "opened"
        elif c_szi == 0.0:
            etype = "closed"
        elif (p_szi > 0) != (c_szi > 0):
            etype = "flipped"
        elif abs(c_szi - p_szi) / abs(p_szi) >= WHALE_CHANGE_PCT:
            etype = "increased" if abs(c_szi) > abs(p_szi) else "decreased"
        if not etype:
            continue
        if etype == "closed":
            delta_ntl = p["position_ntl"]
        else:
            delta_ntl = abs(c_szi - p_szi) * mark
        if delta_ntl < WHALE_EVENT_MIN_NTL:
            continue
        side_szi = p_szi if etype == "closed" else c_szi
        events.append({
            "ts": int(now),
            "ts_src": "detect",
            "type": etype,
            "addr": addr,
            "label": label,
            "coin": coin,
            "side": "long" if side_szi > 0 else "short",
            "delta_ntl": round(delta_ntl),
            "position_ntl": round(c["position_ntl"]) if c else 0,
            "entry_px": (c or p).get("entry_px"),
            "lev": (c or p).get("lev"),
            "prev_szi": p_szi,
            "szi": c_szi,
        })
    return events


# --------------------------------------------------------------------------
# On-chain fill clock (userFillsByTime). Detect ts is a fallback.
# --------------------------------------------------------------------------

def _fetch_user_fills(addr, start_ms, end_ms=None):
    """One address, one window. None on error so callers keep detect ts."""
    _pace_fills()
    req = {"type": "userFillsByTime", "user": addr, "startTime": int(start_ms)}
    if end_ms is not None:
        req["endTime"] = int(end_ms)
    try:
        rows = _post_info(req)
    except Exception:
        return None
    return rows if isinstance(rows, list) else []


_fill_pacer = None


def _pace_fills():
    global _fill_pacer
    if _fill_pacer is None:
        _fill_pacer = _Pacer(FILL_PACE_S)
    _fill_pacer.wait()


def _signed_fill_sz(f):
    sz = abs(_f(f.get("sz"), 0.0) or 0.0)
    if f.get("side") == "B":
        return sz
    if f.get("side") == "A":
        return -sz
    return 0.0


def _start_pos(f):
    return _f(f.get("startPosition"), 0.0) or 0.0


def _coin_fills(fills, coin):
    rows = [f for f in (fills or []) if f.get("coin") == coin]
    if not rows and coin and ":" in coin:
        base = coin.split(":", 1)[1]
        rows = [f for f in (fills or []) if f.get("coin") == base]
    rows.sort(key=lambda f: (int(f.get("time") or 0), str(f.get("tid") or "")))
    return rows


def _match_fill(fills, coin, prev_szi, szi, delta_ntl=None):
    """Fill that completes prev_szi -> szi. None if nothing honest matches."""
    rows = _coin_fills(fills, coin)
    if not rows:
        return None
    prev_szi = _f(prev_szi, 0.0) or 0.0
    szi = _f(szi, 0.0) or 0.0
    delta = szi - prev_szi
    if delta == 0.0:
        return None
    end_pad = max(abs(delta) * 0.05, 1e-4)
    start_pad = max(abs(prev_szi) * 1e-6, 1e-4, abs(delta) * 0.01)

    found_start = False
    best = None
    for f in rows:
        sp = _start_pos(f)
        if not found_start:
            if abs(sp - prev_szi) <= start_pad:
                found_start = True
            else:
                continue
        end = sp + _signed_fill_sz(f)
        if abs(end - szi) <= end_pad:
            best = f
    if best is not None:
        return best

    want = "B" if delta > 0 else "A"
    matching = [f for f in rows if f.get("side") == want]
    tot = sum(abs(_f(f.get("sz"), 0.0) or 0.0) for f in matching)
    if matching and abs(tot - abs(delta)) <= max(abs(delta) * 0.10, 1e-4):
        return matching[-1]

    if delta_ntl and matching:
        ntl = 0.0
        target = abs(_f(delta_ntl, 0.0) or 0.0)
        for f in matching:
            ntl += abs((_f(f.get("px"), 0.0) or 0.0) * (_f(f.get("sz"), 0.0) or 0.0))
        if target and abs(ntl - target) <= max(target * 0.10, 1.0):
            return matching[-1]
    return None


def _apply_fill_times(events, fills):
    """Stamp ts/hash/ts_src from fills. Never invents a hash. No match = detect."""
    for ev in events or []:
        if ev.get("ts_src") is None:
            ev["ts_src"] = "detect"
        f = _match_fill(fills, ev.get("coin"), ev.get("prev_szi"), ev.get("szi"),
                        ev.get("delta_ntl"))
        if not f:
            continue
        tms = int(f.get("time") or 0)
        if tms <= 0:
            continue
        ev["ts"] = int(tms / 1000)
        ev["ts_src"] = "fill"
        h = f.get("hash")
        if isinstance(h, str) and h.startswith("0x") and len(h) >= 8:
            ev["hash"] = h
    return events


def _stamp_wallet_events(events, addr, prev_at, now):
    """One userFillsByTime per changed wallet. Window = last snapshot + slack."""
    if not events:
        return events
    start_s = max((_f(prev_at, 0.0) or 0.0) - FILL_LOOKBACK_SLACK_S,
                  now - FILL_LOOKBACK_MAX_S)
    fills = _fetch_user_fills(addr, int(start_s * 1000), int((now + 5) * 1000))
    if fills:
        _apply_fill_times(events, fills)
    return events


def backfill_recent_fill_times(max_age_s=10800, max_addrs=80):
    """Optional: stamp last few hours of stored detect-only events. Not all 10k."""
    now = time.time()
    cut = now - max_age_s
    with _LOCK:
        ev_store = _load(EVENTS_STORE, {})
        events = list(ev_store.get("events") or [])
        pending = [e for e in events
                   if (e.get("ts") or 0) >= cut and e.get("ts_src") != "fill"]
        by_addr = {}
        for e in pending:
            by_addr.setdefault(e.get("addr"), []).append(e)
        addrs = list(by_addr.keys())[:max_addrs]
    fetched = {}
    for addr in addrs:
        rows = by_addr[addr]
        lo = min(e.get("ts") or now for e in rows) - FILL_LOOKBACK_SLACK_S
        hi = max(e.get("ts") or now for e in rows) + 5
        fetched[addr] = _fetch_user_fills(addr, int(lo * 1000), int(hi * 1000))
    with _LOCK:
        ev_store = _load(EVENTS_STORE, {})
        events = ev_store.get("events") or []
        n_fill = 0
        for addr, fills in fetched.items():
            if not fills:
                continue
            rows = [e for e in events
                    if e.get("addr") == addr
                    and (e.get("ts") or 0) >= cut
                    and e.get("ts_src") != "fill"]
            _apply_fill_times(rows, fills)
            n_fill += sum(1 for e in rows if e.get("ts_src") == "fill")
        _save(EVENTS_STORE, {"events": events[:WHALE_EVENTS_CAP]})
    return {"addrs": len(addrs), "pending": len(pending), "stamped": n_fill}

# --------------------------------------------------------------------------
# Aggregates
# --------------------------------------------------------------------------

def _aggregate(wallets):
    """Per-coin and global long/short notionals across current snapshots."""
    per = {}
    top_orders = []
    for w in wallets.values():
        for p in w.get("positions") or []:
            d = per.setdefault(p["coin"], {"long_ntl": 0.0, "short_ntl": 0.0,
                                           "n_long": 0, "n_short": 0,
                                           "l_wpx": 0.0, "l_wsz": 0.0,
                                           "s_wpx": 0.0, "s_wsz": 0.0})
            if p["szi"] > 0:
                d["long_ntl"] += p["position_ntl"]
                d["n_long"] += 1
            else:
                d["short_ntl"] += p["position_ntl"]
                d["n_short"] += 1
            # Token-weighted entry VWAP — "the price point they entered at".
            # Weight by |szi| (tokens), not notional: notional embeds the
            # CURRENT price and would drag the average toward the mark.
            if p.get("entry_px"):
                sz = abs(p["szi"])
                side = ("l" if p["szi"] > 0 else "s")
                d[side + "_wpx"] += p["entry_px"] * sz
                d[side + "_wsz"] += sz
        for o in w.get("orders") or []:
            top_orders.append({**o, "label": w.get("label")})
    rows = []
    total_l = total_s = 0.0
    for coin, d in per.items():
        total_l += d["long_ntl"]
        total_s += d["short_ntl"]
        rows.append({"coin": coin,
                     # The venue travels with every row: a client grouping by
                     # coin alone cannot tell xyz:GOLD from a core market.
                     "dex": dex_of(coin),
                     "venue": venue_name(dex_of(coin)),
                     "long_ntl": round(d["long_ntl"]),
                     "short_ntl": round(d["short_ntl"]),
                     "net_ntl": round(d["long_ntl"] - d["short_ntl"]),
                     "n_long": d["n_long"], "n_short": d["n_short"],
                     "avg_long_entry": (d["l_wpx"] / d["l_wsz"])
                                       if d["l_wsz"] else None,
                     "avg_short_entry": (d["s_wpx"] / d["s_wsz"])
                                        if d["s_wsz"] else None})
    rows.sort(key=lambda r: abs(r["net_ntl"]), reverse=True)
    top_orders.sort(key=lambda o: o["ntl"], reverse=True)
    gross = total_l + total_s
    return {
        "per_coin": rows,
        "top_orders": top_orders[:WHALE_TOP_ORDERS],
        # The ladder is sliced to the largest N. Without these two the client
        # renders `ords.length` — i.e. the cap — as "RESTING ORDERS 40".
        "top_orders_total": len(top_orders),
        "top_orders_cap": WHALE_TOP_ORDERS,
        "total_long_ntl": round(total_l),
        "total_short_ntl": round(total_s),
        "skew_pct": round((total_l - total_s) / gross * 100.0, 2) if gross else None,
    }


def _delta_24h(agg_hourly, per_coin_rows, now):
    """Attach delta_24h_ntl per coin, or null (honesty) without 24h of tape.

    A coin missing from the anchor snapshot is a zero only if the anchor
    actually covered that coin's VENUE. Every hourly written before the sweep
    queried HIP-3 holds no xyz coins at all, so differencing against one would
    report the entire xyz book as a 24h inflow — $28.9M of brand-new whale
    longs in xyz:SKHY that had merely become visible. Those read null until
    24h of dex-covered hourlies have accrued, which is the same rule the rest
    of this module applies to its own warm-up.
    """
    target = now - 24 * 3600
    # candidates old enough to anchor a 24h delta (>= ~23h old)
    old = [a for a in agg_hourly if a["ts"] <= now - 23 * 3600]
    anchor = min(old, key=lambda a: abs(a["ts"] - target)) if old else None
    # Entries written before per-venue coverage existed were core-only.
    anchor_dexs = set(anchor.get("dexs") or [""]) if anchor else set()
    for r in per_coin_rows:
        if anchor is None or dex_of(r["coin"]) not in anchor_dexs:
            r["delta_24h_ntl"] = None
            continue
        prev = anchor["per_coin"].get(r["coin"]) or {}
        prev_net = (prev.get("long_ntl", 0.0) or 0.0) - (prev.get("short_ntl", 0.0) or 0.0)
        r["delta_24h_ntl"] = round(r["net_ntl"] - prev_net)


# --------------------------------------------------------------------------
# Sweep
# --------------------------------------------------------------------------

def sweep(notify=None, max_wallets=None):
    """One full pass: roster -> parallel wallet fetches -> diff -> stores.

    ``notify(text)`` is the server's Telegram path (injected so this module
    never imports server.py). ``max_wallets`` exists for offline testing.
    Returns a small summary dict for logging/tests. Never raises on a
    per-wallet failure — failed wallets keep their previous snapshot and are
    excluded from diffing this round, and every one of them is named in
    `failed` rather than dropped (the discipline venues.py sets).

    Two phases. The CORE phase queries every non-dormant wallet as it always
    has. The HIP-3 phase then queries, on each swept dex, the wallets known to
    hold there plus a rotating discovery slice of the rest — paced, because it
    is additive load on an endpoint already shedding ~21 of the core phase's
    400 calls. Measured cost of the dex phase at 200 tracked wallets: ~40% of
    the roster holds on xyz, so ~80 positions calls + 16 probes ≈ 480 calls
    per sweep in total, not the 600 a blind third call per wallet would cost.
    The exception is the first sweep on a venue nobody has been probed on,
    which probes the roster once so coverage starts whole rather than
    creeping up over three hours of lower bounds.
    """
    t0 = time.time()
    roster, roster_fetched_at, roster_stale = refresh_roster()
    if max_wallets:
        roster = roster[:max_wallets]

    with _LOCK:
        store = _load(POSITIONS_STORE, {})
    wallets = store.get("wallets") or {}
    sweeps_done = int(store.get("sweeps_done") or 0)
    dex_seen = dict(store.get("dex_seen") or {})

    labels = {r["addr"]: r["label"] for r in roster}
    active = [r["addr"] for r in roster
              if _FLAT_STREAK.get(r["addr"], 0) < DORMANT_AFTER_SWEEPS]

    results = {}
    with ThreadPoolExecutor(max_workers=WHALE_SWEEP_WORKERS) as pool:
        for addr, res in zip(active, pool.map(_fetch_wallet, active)):
            results[addr] = res

    # Retry pass. A full 200-wallet sweep is 400 upstream calls in ~23s
    # (~17/s) and Hyperliquid sheds a slice of them: measured 0 failures at
    # 40 wallets, 24-60 at 200. A shed request is transient, but a wallet
    # that misses a sweep keeps a stale snapshot and drops out of the
    # aggregates — so the board silently narrows while claiming 200 names.
    # One slower, half-width pass recovers nearly all of them; whatever
    # still fails is reported honestly by the degraded banner.
    retry = [a for a, r in results.items() if r is None]
    if retry:
        time.sleep(WHALE_RETRY_PAUSE_S)
        workers = max(1, WHALE_SWEEP_WORKERS // 2)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for addr, res in zip(retry, pool.map(_fetch_wallet, retry)):
                if res is not None:
                    results[addr] = res

    # ---- HIP-3 phase ----
    # Only wallets whose CORE call just succeeded are candidates: one we could
    # not reach at all is not going to be reached on a second venue, and
    # pairing a fresh dex snapshot with a stale core one would diff two
    # different moments of the same wallet.
    dex_meta = refresh_dexs(store.get("dexs"), now=t0)
    dex_list = list(dex_meta.get("list") or [])
    reachable = [a for a, r in results.items() if r is not None]
    dex_res, dex_stats = {}, {}
    pacer = _Pacer(WHALE_DEX_PACE_S)
    for dex in dex_list:
        # Cold start: on a venue where NOTHING is known yet, probe the whole
        # roster once rather than creeping to coverage 16 wallets at a time
        # while the overlay shows a lower bound for three hours. That is one
        # ~200-call pass, once per venue ever (and again only if a new
        # deployment crosses the volume floor); the rotation is the steady
        # state, and a probe that gets shed is retried by it.
        known = any(((dex_seen.get(a) or {}).get(dex) or {}).get("at")
                    for a in reachable)
        holders, probes = dex_targets(
            dex, reachable, dex_seen,
            batch=WHALE_DISCOVERY_BATCH if known else len(reachable))
        held = set(holders)
        targets = holders + [a for a in probes if a not in held]
        dex_stats[dex] = {"holders": len(holders),
                          "probes": len(targets) - len(holders),
                          "queried": len(targets), "fails": 0}
        if not targets:
            continue
        fetch = functools.partial(_fetch_wallet, dex=dex,
                                  want_orders=WHALE_DEX_ORDERS, pacer=pacer)
        with ThreadPoolExecutor(max_workers=WHALE_DEX_WORKERS) as pool:
            for addr, res in zip(targets, pool.map(fetch, targets)):
                dex_res[(addr, dex)] = res
        # Retry, same discipline as the core phase. A shed call on a known
        # HOLDER freezes that wallet's entire snapshot for the round (its dex
        # half cannot be written without deleting the other half), so one
        # slower attempt is worth far more than it costs — the failures are a
        # small slice, and the alternative is a board that quietly narrows.
        again = [a for a in targets if dex_res.get((a, dex)) is None]
        if again:
            time.sleep(WHALE_RETRY_PAUSE_S)
            slow = functools.partial(_fetch_wallet, dex=dex,
                                     want_orders=WHALE_DEX_ORDERS,
                                     pacer=_Pacer(WHALE_DEX_PACE_S * 2))
            with ThreadPoolExecutor(max_workers=max(1, WHALE_DEX_WORKERS // 2)) as pool:
                for addr, res in zip(again, pool.map(slow, again)):
                    if res is not None:
                        dex_res[(addr, dex)] = res
        dex_stats[dex]["fails"] = sum(
            1 for a in targets if dex_res.get((a, dex)) is None)

    now = time.time()
    new_events = []
    failed = []
    fetch_fails = 0
    dex_fails = 0
    rebaselined = 0
    for addr, res in results.items():
        label = labels.get(addr, _short(addr))
        if res is None:
            fetch_fails += 1
            failed.append({
                "addr": addr, "label": label, "dex": "", "venue": venue_name(""),
                "error": "clearinghouseState failed (shed or timed out) on both "
                         "the sweep and the retry pass",
                "impact": "this wallet contributes its PREVIOUS snapshot to the "
                          "aggregates and is not diffed this round"})
            continue          # keep previous snapshot; do NOT diff
        positions = list(res["positions"])
        venues_ok = {"": now}
        seen = dict(dex_seen.get(addr) or {})
        stale_dex = []
        for dex in dex_list:
            if (addr, dex) not in dex_res:
                continue                      # not queried, and not claimed
            dres = dex_res[(addr, dex)]
            if dres is None:
                dex_fails += 1
                was_holder = bool((seen.get(dex) or {}).get("holds"))
                if was_holder:
                    stale_dex.append(dex)
                failed.append({
                    "addr": addr, "label": label, "dex": dex,
                    "venue": venue_name(dex),
                    "error": "clearinghouseState(dex=%s) failed" % dex,
                    "impact": ("this wallet's %s positions are STALE in the "
                               "aggregates and it is not diffed this round"
                               % dex) if was_holder else
                              ("whether this wallet holds on %s is still "
                               "UNKNOWN; the rotation will re-probe it" % dex)})
                continue
            positions.extend(dres["positions"])
            venues_ok[dex] = now
            seen[dex] = {"at": now, "holds": bool(dres["positions"])}
        dex_seen[addr] = seen
        if stale_dex:
            # A wallet KNOWN to hold on this dex whose dex call was shed.
            # Writing the fresh core half alone would delete its dex positions
            # from the store, and the next sweep would diff them back as
            # "opened" — a fetch error fabricating an event, which is the one
            # thing this sweep must never do. Whole wallet keeps its previous
            # snapshot, exactly as a core failure does.
            continue
        prev_w = wallets.get(addr)
        if prev_w is not None and prev_w.get("positions") is not None:
            prev_age = now - (_f(prev_w.get("fetched_at"), 0.0) or 0.0)
            if prev_age > WHALE_REBASELINE_GAP_S:
                # Snapshot predates a gap (restart/sleep/dormancy): diffing
                # would fabricate "fresh 15m moves" out of hours of drift.
                rebaselined += 1
            else:
                # Diff only over venues BOTH snapshots covered. A position on
                # a venue queried this round but not last — the discovery
                # rotation reaching a wallet for the first time — is not a new
                # position, it is a newly VISIBLE one, and stamping it
                # "opened" would alert on a trade that may be months old.
                # Snapshots written before this module knew about dexs carry
                # no `venues` key and were core-only, which is what they
                # default to here.
                shared = set(venues_ok) & set(prev_w.get("venues") or {"": 0})
                evs = diff_wallet(
                    [p for p in prev_w["positions"] if dex_of(p["coin"]) in shared],
                    [p for p in positions if dex_of(p["coin"]) in shared],
                    addr, label, now=now)
                if evs:
                    prev_at = _f(prev_w.get("fetched_at"), 0.0) or now
                    _stamp_wallet_events(evs, addr, prev_at, now)
                new_events.extend(evs)
        wallets[addr] = {
            "label": label,
            "fetched_at": now,
            "positions": positions,
            "orders": res.get("orders") or [],
            # Which venues this snapshot actually covers. Coverage is computed
            # from these, so "flat on xyz" can never be read off a wallet that
            # was only ever asked about core.
            "venues": venues_ok,
            "account_value": res["account_value"],
            "prev": {"fetched_at": (prev_w or {}).get("fetched_at"),
                     "positions": (prev_w or {}).get("positions")},
        }
        streak = _FLAT_STREAK.get(addr, 0)
        # Dormancy is judged on the MERGED book: a wallet flat on core while
        # running 45 positions on xyz was being marked dormant and skipped,
        # which is how the sweep saved calls by not looking where the trading
        # was happening.
        _FLAT_STREAK[addr] = 0 if positions else streak + 1

    # prune wallets that fell off the roster (keeps the store bounded)
    roster_addrs = {r["addr"] for r in roster}
    wallets = {a: w for a, w in wallets.items() if a in roster_addrs}
    dex_seen = {a: d for a, d in dex_seen.items() if a in roster_addrs}

    sweeps_done += 1

    # hourly aggregate ring for 24h deltas
    agg = _aggregate(wallets)
    agg_hourly = store.get("agg_hourly") or []
    hour = int(now // 3600)
    if not agg_hourly or int(agg_hourly[-1]["ts"] // 3600) != hour:
        agg_hourly.append({
            "ts": int(now),
            # Which venues this row could see, so a later delta can tell a
            # coin that was flat from one that was off-camera.
            "dexs": [""] + dex_list,
            "per_coin": {r["coin"]: {"long_ntl": r["long_ntl"],
                                     "short_ntl": r["short_ntl"]}
                         for r in agg["per_coin"]}})
        agg_hourly = agg_hourly[-AGG_HOURLY_CAP:]

    dormant = [r["addr"] for r in roster
               if _FLAT_STREAK.get(r["addr"], 0) >= DORMANT_AFTER_SWEEPS]
    for r in roster:
        r["dormant"] = r["addr"] in dormant

    with _LOCK:
        _save(POSITIONS_STORE, {
            "tracking_since": store.get("tracking_since") or now,
            "roster": roster,
            "roster_fetched_at": roster_fetched_at,
            "roster_stale": roster_stale,
            "sweeps_done": sweeps_done,
            "last_sweep_at": now,
            "last_sweep_secs": round(time.time() - t0, 1),
            "fetch_fails": fetch_fails,
            "dex_fails": dex_fails,
            "rebaselined": rebaselined,
            "dexs": dex_meta,
            "dex_seen": dex_seen,
            "dex_stats": dex_stats,
            "failed": failed[:WHALE_FAILED_CAP],
            "failed_total": len(failed),
            "wallets": wallets,
            "agg_hourly": agg_hourly,
        })
        ev_store = _load(EVENTS_STORE, {})
        all_events = new_events + (ev_store.get("events") or [])
        _save(EVENTS_STORE, {"events": all_events[:WHALE_EVENTS_CAP]})

    # Alerts: only once diffing is real (sweeps_done >= 2 == not warming),
    # only above the $1M bar, per-(addr,coin) cooldown.
    alerts_sent = 0
    if notify and sweeps_done >= 2:
        for ev in new_events:
            if ev["delta_ntl"] < WHALE_ALERT_MIN_NTL:
                continue
            key = (ev["addr"], ev["coin"])
            if now - _ALERT_LAST.get(key, 0) < WHALE_ALERT_COOLDOWN_S:
                continue
            _ALERT_LAST[key] = now
            text = ("\U0001F40B {label} {typ} {coin} {side} ${m:.1f}M"
                    " @ {px} {lev}").format(
                label=ev["label"], typ=ev["type"].upper(), coin=ev["coin"],
                side=ev["side"].upper(), m=ev["delta_ntl"] / 1e6,
                px=ev["entry_px"] if ev["entry_px"] is not None else "?",
                lev="{}x".format(int(ev["lev"])) if ev.get("lev") else "")
            try:
                notify(text.strip())
                alerts_sent += 1
            except Exception:
                pass

    return {"sweeps_done": sweeps_done, "wallets_swept": len(results),
            "fetch_fails": fetch_fails, "dex_fails": dex_fails,
            "rebaselined": rebaselined,
            "dexs_swept": dex_list, "dex_stats": dex_stats,
            "events": len(new_events),
            "alerts_sent": alerts_sent, "secs": round(time.time() - t0, 1),
            "dormant": len(dormant)}


# --------------------------------------------------------------------------
# Coverage — has the sweep actually LOOKED here?
# --------------------------------------------------------------------------

def _venue_stats(store, dex):
    """How much of the roster this sweep actually covers on ONE venue."""
    roster = store.get("roster") or []
    wallets = store.get("wallets") or {}
    seen = store.get("dex_seen") or {}
    last = _f(store.get("last_sweep_at"), 0.0) or 0.0
    queried = holding = probed = 0
    for r in roster:
        addr = r.get("addr")
        w = wallets.get(addr) or {}
        # 1s of slack: every wallet in a sweep shares one `now` stamp.
        at = _f((w.get("venues") or {}).get(dex), 0.0) or 0.0
        if at and at >= last - 1:
            queried += 1
        if dex == "" or ((seen.get(addr) or {}).get(dex) or {}).get("at"):
            probed += 1          # core is queried for every non-dormant wallet
        if any(dex_of(p.get("coin")) == dex for p in (w.get("positions") or [])):
            holding += 1
    fails = sum(1 for f in (store.get("failed") or []) if f.get("dex") == dex)
    return {"wallets_tracked": len(roster), "wallets_queried": queried,
            "wallets_probed": probed, "wallets_holding": holding,
            "wallets_failed": fails}


def coverage(coin, store=None):
    """Whether whale data for ONE coin is a measurement or a blank.

    n_positions=0 and "this venue was never queried" are the same number and
    completely different facts. Every consumer has to be able to tell them
    apart, so the state is stated here rather than inferred from an empty
    list — the whale overlay is default-ON, and for a year an empty overlay
    on `xyz:TSLA` read to the user as "no whales in this market".

    States: warming (no sweep yet), not_covered (this venue is not swept, or
    no roster wallet has been probed on it), partial (swept, but part of the
    roster is unprobed or was shed — counts are a LOWER BOUND), covered.
    """
    if store is None:
        with _LOCK:
            store = _load(POSITIONS_STORE, {})
    dex = dex_of(coin)
    swept = [""] + list((store.get("dexs") or {}).get("list") or [])
    st = dict(_venue_stats(store, dex))
    out = {"coin": coin, "dex": dex, "venue": venue_name(dex),
           "dexs_swept": [venue_name(d) for d in swept],
           "last_sweep_at": store.get("last_sweep_at"),
           # Resting orders are fetched on core only — see WHALE_DEX_ORDERS.
           "orders_covered": (dex == "" or WHALE_DEX_ORDERS),
           **st}
    sweeps_done = int(store.get("sweeps_done") or 0)
    if not sweeps_done:
        out.update(state="warming", complete=False,
                   why="no sweep has completed yet, so nothing here has been "
                       "measured")
    elif dex not in swept:
        why = ("the whale sweep queries %s; %s is NOT swept, so a zero here "
               "would mean NOT LOOKED, not none"
               % (", ".join(venue_name(d) for d in swept), venue_name(dex)))
        if (store.get("dexs") or {}).get("stale"):
            # "not traded enough to sweep" and "we failed to measure whether
            # it is" are different claims and only one of them is a fact.
            why += (" — and the venue list is STALE (its last measurement "
                    "failed), so this may be a discovery failure rather than "
                    "a venue nobody trades")
        out.update(state="not_covered", complete=False, why=why)
    elif not st["wallets_probed"]:
        out.update(state="not_covered", complete=False,
                   why="%s is swept but no tracked wallet has been probed on "
                       "it yet — discovery rotates %d wallets per sweep"
                       % (venue_name(dex), WHALE_DISCOVERY_BATCH))
    elif st["wallets_probed"] < st["wallets_tracked"] or st["wallets_failed"]:
        out.update(state="partial", complete=False,
                   why="%d of %d tracked wallets known on %s%s — the counts "
                       "here are a LOWER BOUND"
                       % (st["wallets_probed"], st["wallets_tracked"],
                          venue_name(dex),
                          (", %d fetch(es) failed last sweep"
                           % st["wallets_failed"]) if st["wallets_failed"] else ""))
    else:
        out.update(state="covered", complete=True,
                   why="all %d tracked wallets have been probed on %s; %d were "
                       "queried in the last sweep (the rest are measured as "
                       "not holding there)"
                       % (st["wallets_tracked"], venue_name(dex),
                          st["wallets_queried"]))
    if not out["orders_covered"]:
        # The measurement below is from xyz specifically; it is quoted as an
        # xyz measurement rather than restated about whichever venue is being
        # asked about, which would be inventing a number for that venue.
        out["orders_why"] = (
            "resting orders are fetched on core Hyperliquid only, so the %s "
            "order book here is NOT COVERED rather than empty. Measured on "
            "xyz: of 1,230 live orders across five holders the median was "
            "$30,193 and the largest $141,825, none of them clearing the $%s "
            "bar this board surfaces orders at"
            % (venue_name(dex), format(WHALE_ORDER_MIN_NTL, ",")))
    return out


# --------------------------------------------------------------------------
# API payload
# --------------------------------------------------------------------------

def coin_detail(coin):
    """Everything known about whale activity in ONE coin, for the chart.

    Positions come from the latest snapshots (entry price is exact — the
    venue reports it). Entry TIME is only known for positions we watched
    being opened: clearinghouseState has no timestamp, so a position that
    predates tracking carries seen_at=None rather than a fabricated time.
    Events for the coin ARE timestamped and drawable on the x-axis.
    ts is L1 fill time (ts_src=fill, hash if the fill carried one) when
    userFillsByTime matches the size delta; otherwise sweep-detect
    (ts_src=detect, no hash) — funding/transfers/snapshot noise.

    A coin whose VENUE the sweep has not queried returns n_positions=None and
    coverage.state="not_covered". It does not return zero. The overlay is on
    by default, so a fully-formed {"positions": [], "n_positions": 0} was the
    terminal stating, on every xyz market, that it had looked and found no
    whales — while the sweep had never asked the venue a question.
    """
    with _LOCK:
        store = _load(POSITIONS_STORE, {})
        ev_store = _load(EVENTS_STORE, {})
    now = time.time()
    cov = coverage(coin, store=store)
    if cov["state"] in ("not_covered", "warming"):
        return {
            "coin": coin,
            "coverage": cov,
            # Every quantity a client might print is NULL, not 0: there is no
            # measurement behind any of them.
            "positions": [], "n_positions": None,
            "long_ntl": None, "short_ntl": None,
            "avg_long_entry": None, "avg_short_entry": None,
            "orders": None, "events": [],
            "tracking_since": store.get("tracking_since"),
            "at": now,
        }
    positions = []
    opened_at = {}
    coin_events = [e for e in (ev_store.get("events") or [])
                   if e.get("coin") == coin]
    for e in reversed(coin_events):          # oldest first: keep earliest open
        if e.get("type") in ("opened", "flipped") and e.get("addr") not in opened_at:
            opened_at[e["addr"]] = e.get("ts")
    l_wpx = l_wsz = s_wpx = s_wsz = 0.0
    for addr, w in (store.get("wallets") or {}).items():
        for p in w.get("positions") or []:
            if p.get("coin") != coin:
                continue
            szi = p.get("szi") or 0.0
            positions.append({
                "addr": addr, "label": w.get("label"),
                "side": "long" if szi > 0 else "short",
                "ntl": round(p.get("position_ntl") or 0.0),
                "entry_px": p.get("entry_px"),
                "lev": p.get("lev"),
                "upnl": round(p.get("upnl") or 0.0),
                "liq_px": p.get("liq_px"),
                # When we SAW it open — None means it predates tracking,
                # i.e. "held since before <tracking started>", not "unknown
                # in a spooky way".
                "seen_open_at": opened_at.get(addr),
                "snapshot_age_s": round(now - (w.get("fetched_at") or now)),
            })
            if p.get("entry_px"):
                sz = abs(szi)
                if szi > 0:
                    l_wpx += p["entry_px"] * sz
                    l_wsz += sz
                else:
                    s_wpx += p["entry_px"] * sz
                    s_wsz += sz
        for o in w.get("orders") or []:
            pass                              # orders already in aggregates
    positions.sort(key=lambda r: r["ntl"], reverse=True)
    orders = [dict(o, label=w.get("label"))
              for a, w in (store.get("wallets") or {}).items()
              for o in (w.get("orders") or []) if o.get("coin") == coin]
    orders.sort(key=lambda o: o["ntl"], reverse=True)
    return {
        "coin": coin,
        "coverage": cov,
        "positions": positions[:40],
        "n_positions": len(positions),
        "long_ntl": round(sum(p["ntl"] for p in positions if p["side"] == "long")),
        "short_ntl": round(sum(p["ntl"] for p in positions if p["side"] == "short")),
        "avg_long_entry": (l_wpx / l_wsz) if l_wsz else None,
        "avg_short_entry": (s_wpx / s_wsz) if s_wsz else None,
        # None, not [], on a venue whose order book is never fetched — an
        # empty list would read as "no whale is resting size here".
        "orders": orders[:15] if cov["orders_covered"] else None,
        "events": coin_events[:40],
        "tracking_since": store.get("tracking_since"),
        "at": now,
    }


def payload():
    """Shape served by GET /api/whales. Reads the stores; cheap per request."""
    with _LOCK:
        store = _load(POSITIONS_STORE, {})
        ev_store = _load(EVENTS_STORE, {})
    sweeps_done = int(store.get("sweeps_done") or 0)
    now = time.time()
    # THE SLICE IS NOT THE COUNT. The client renders `evs.length` as the
    # header number, and this array arrives pre-capped: measured 2026-08-16,
    # data/whale_events.json held 1,051 events and the pane read "EVENTS
    # 100". Nothing in the payload carried the total, so the client could not
    # have said otherwise even if it wanted to. Same for the order ladder,
    # capped at WHALE_TOP_ORDERS in _aggregate. This file already gets this
    # right for wallets (`failed[:40]` next to `wallets_failed`) with the
    # reason written down: a total that silently lost its contributors still
    # looks complete.
    all_events = ev_store.get("events") or []
    events = all_events[:WHALE_EVENTS_PAGE]

    warming = sweeps_done < 2
    warming_note = None
    if sweeps_done == 0:
        warming_note = "first sweep in progress"
    elif sweeps_done == 1:
        warming_note = "1 sweep done — need 2 to diff"

    roster = store.get("roster") or []
    dormant = sum(1 for r in roster if r.get("dormant"))
    fetched_at = store.get("roster_fetched_at") or 0
    last_sweep_at = store.get("last_sweep_at") or 0
    # A snapshot is "fresh" if refetched by the latest sweep (1s slack for
    # the shared `now` stamp); the rest feed aggregates from stale data.
    wallets_fresh = sum(
        1 for w in (store.get("wallets") or {}).values()
        if (_f(w.get("fetched_at"), 0.0) or 0.0) >= last_sweep_at - 1)
    cov = {
        "wallets_tracked": len(roster),
        "wallets_active": len(roster) - dormant,
        "wallets_dormant": dormant,
        "wallets_fresh": wallets_fresh,
        "fetch_fails": int(store.get("fetch_fails") or 0),
        "rebaselined": int(store.get("rebaselined") or 0),
        "last_sweep_at": store.get("last_sweep_at"),
        "sweeps_done": sweeps_done,
        "roster_age_h": round((now - fetched_at) / 3600.0, 1) if fetched_at else None,
        "roster_stale": bool(store.get("roster_stale")),
    }

    # Which venues were actually queried, and how completely. A client can
    # render NOT COVERED from this alone: any coin whose dex prefix is absent
    # from `venues` has never been asked about. Per-coin detail (and the
    # sentence to print) comes from /api/whales?coin=X -> coverage.
    dex_meta = store.get("dexs") or {}
    swept = [""] + list(dex_meta.get("list") or [])
    stats = store.get("dex_stats") or {}
    venue_blocks = [
        dict(_venue_stats(store, d), dex=d, venue=venue_name(d),
             orders_covered=(d == "" or WHALE_DEX_ORDERS),
             last_sweep_queried=(stats.get(d) or {}).get("queried"),
             last_sweep_fails=(stats.get(d) or {}).get("fails"))
        for d in swept]
    cov.update({
        "venues": venue_blocks,
        "dexs_swept": [venue_name(d) for d in swept],
        "dex_list_at": dex_meta.get("at"),
        "dex_list_stale": bool(dex_meta.get("stale")),
        "dex_volumes": dex_meta.get("measured") or [],
        "dex_fails": int(store.get("dex_fails") or 0),
        # Every wallet that failed or was rate-shed, named — never dropped.
        # Same contract as venues.snapshot(): `failed` plus a count, because a
        # total that silently lost its contributors still looks complete.
        "failed": (store.get("failed") or [])[:40],
        "wallets_failed": int(store.get("failed_total")
                              or store.get("fetch_fails") or 0),
        "events_total": len(all_events),
        "events_shown": len(events),
        "events_cap": WHALE_EVENTS_PAGE,
        "orders_cap": WHALE_TOP_ORDERS,
        "note": "positions are fetched PER DEX. A coin whose venue is absent "
                "from `venues` has NOT been queried; ask /api/whales?coin=X "
                "for its coverage state rather than reading an empty list.",
    })

    agg = _aggregate(store.get("wallets") or {})
    _delta_24h(store.get("agg_hourly") or [], agg["per_coin"], now)
    day_ago = now - 24 * 3600
    fresh = [e for e in (ev_store.get("events") or [])
             if e["ts"] >= day_ago and e["type"] in ("opened", "flipped")]
    # A PAGE, reported as one — the last section in this payload that was not.
    # Every neighbouring block here already ships shown-vs-total (events_total
    # / events_shown / events_cap, orders_cap), and this one shipped a bare
    # top-5 slice that the pane rendered under "FRESH CONVICTION · 24H" as
    # though it were the whole of the last 24 hours. `fresh_total` is over
    # every opened/flipped event in the window, so 5-of-5 and 5-of-40 stop
    # looking identical.
    agg["fresh_cap"] = FRESH_CAP
    agg["fresh_total"] = len(fresh)
    agg["fresh_top5"] = sorted(fresh, key=lambda e: e["delta_ntl"],
                               reverse=True)[:FRESH_CAP]
    agg["fresh_note"] = (
        "the %d LARGEST of %d fresh opens/flips in the last 24h — the other "
        "%d are NOT SHOWN, not absent"
        % (len(agg["fresh_top5"]), len(fresh), len(fresh) - len(agg["fresh_top5"]))
    ) if len(fresh) > len(agg["fresh_top5"]) else None
    return {"warming": warming, "warming_note": warming_note,
            "coverage": cov, "aggregates": agg, "events": events,
            "events_total": len(all_events),
            "events_shown": len(events),
            "events_cap": WHALE_EVENTS_PAGE,
            "events_note": ("newest %d of %d events held — the rest are NOT "
                            "SHOWN, not absent" % (len(events),
                                                   len(all_events)))
                           if len(all_events) > len(events) else None}
