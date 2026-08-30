"""Continuous trade collector — gives CVD and delta a history.

The browser could already draw CVD, but it accumulated only from the moment you
selected a coin, so switching symbols reset it to zero and there was nothing to
read across time. `recentTrades` cannot fix that: it returns ten trades spanning
about two seconds.

So the server subscribes to the trade stream itself and keeps rolling
per-minute buckets on disk. Open a coin and hours of real, aggressor-signed
flow are already there.

Buckets store USD notional, not token size, so delta is comparable across
coins. Aggressor convention: Hyperliquid's `side == "B"` means the buyer lifted
the ask (verified empirically against the book, 45 of 53 marketable prints).
"""

import asyncio
import json
import math
import os
import tempfile
import threading
import time
from collections import deque

WS_URL = "wss://api.hyperliquid.xyz/ws"
STORE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "data", "flow_buckets.json")

BUCKET_S = 60
RETAIN_H = 48
MAX_BUCKETS = int(RETAIN_H * 3600 / BUCKET_S)
SAVE_EVERY_S = 60

# Tiered retention. Minute buckets for 48h cost ~3 MB; keeping that resolution
# for 90 days would be ~148 MB rewritten every 60s. So a minute bucket about to
# age out is rolled into an hourly bucket first — 18 coins x 90 days of hourly
# is ~2.4 MB, and an hourly chart never needed minute resolution anyway. The
# two tiers are disjoint: hourly covers older than 48h, minutes cover the rest.
HOUR_S = 3600
# Raised from 90d once the hourly tier moved to its own file: at 90d a 300-bar
# daily chart plateaued at 30% CVD coverage forever. 400d covers it fully.
# Cost check: 19 coins x 9600h x ~63B = ~11.5MB, written every 30 min — vs the
# minute store's ~3MB every 60s. Keeping them in one file was the constraint.
RETAIN_HOURLY_D = 400
MAX_HOURLY = int(RETAIN_HOURLY_D * 24)
STORE_HOURLY = os.path.join(os.path.dirname(STORE), "flow_hourly.json")
SAVE_HOURLY_EVERY_S = 1800
_HOURLY = {}           # coin -> {hour_start_ms: {b, s, n}}

# --- FOOTPRINT TIER (per-price levels) -------------------------------------
# A THIRD tier, deliberately separate from the b/s buckets above. Those store
# {b, s, n} per minute and NO PRICE, so the per-price ladder the chart draws
# could only ever be built from the browser's own trade ring: 6,000 prints, a
# median reach of ~46 min on BTC, ~36 on HYPE, and ZERO immediately after a
# reload or a coin switch. Measured on HYPE with the footprint on: 299 hourly
# buckets of real buy/sell present, and levels on ONE of them, because the ring
# held 32 prints. The ladder said so honestly and was useless.
#
# RESOLUTION IS ONE MINUTE and retention is 48h -- strictly shorter than both
# tiers above (minute 48h, hourly 400d), so the ladder dies at 48h while CVD
# lives 400d. Aggregating minute levels up to a chart bar is EXACT, not
# approximate: levels are additive and every minute in a bar sits on the
# identical tick grid, so a 4h bar built from 240 minute maps equals what a
# complete tape would produce, level for level. The cap is TIME, not interval.
#
# SIZING, measured end-to-end (this encoder + json.dump + getsize), built on
# the REAL 177,212-bucket population of flow_buckets.json and a levels-per-
# bucket law fitted on a 150s live capture of 2,820 real prints across 16
# markets (levels = 0.926 * n^0.359, R2 0.54; the fit on complete minutes only
# is 0.919 * n^0.356, so edge truncation in the capture is not a material
# bias): 58.8 B/bucket, 2.66 levels/bucket, 10.4 MB at steady state. The
# design phase predicted 15.4 MB at 4.25 levels/bucket -- this is 32% CHEAPER
# than budgeted, and the direction is knowable: a busier or more volatile
# session raises levels/bucket, so treat 10.4 MB as the current regime, not a
# ceiling. The largest single real minute bucket in the capture held 16
# levels. Total flow store goes 12.5 -> 22.9 MB; for scale the depth collector
# in the same data dir already writes a 29.4 MB minute store on this same 300s
# cadence.
#
# The encoding win is FLOAT -> INTEGER DOLLARS, not the array shape: the b/s
# tier writes "b": 9593.138799999999, eighteen characters for a number the
# pane renders as "9.6K". Top-N was rejected FOR STORAGE (measured 27% LARGER
# than lossless, because at ~3-4 levels/bucket the remainder keys cost more
# than the levels they replace) while also discarding data; it is right at the
# WIRE, where the pane draws 8 rows.
#
# THERE IS EXACTLY ONE LEVEL TIER. No hourly level tier (priced at +402 MB to
# match the 400d b/s retention), so _load_levels() needs no cross-tier
# reconciliation and the boundary-hour hazard documented in _load() does not
# arise here. IF AN HOURLY LEVEL TIER IS EVER ADDED, that guard must be ported
# verbatim, or every restart craters the boundary hour of the archive exactly
# as it did for the b/s tier.
STORE_LEVELS = os.path.join(os.path.dirname(STORE), "flow_levels.json")
# 300s, not 60s. MEASURED at steady state: the whole save is 871 ms, of which
# 5.2 ms (0.6%) is spent holding _LOCK -- so it is 0.29% of the loop at 300s
# and would be 1.5% at 60s. The 871 ms blocks the collector's event loop;
# frames queue (max_queue=None) rather than drop, and 0.9 s is far below
# QUIET_S (60s) and WATCHDOG_S (300s), so it cannot fake a wedge -- but anyone
# tightening either threshold must account for it. _load_levels() costs 391 ms
# once, at start().
#
# The cost of the wider cadence is up to 5 minutes of levels lost on a
# SIGKILL -- and that window is exactly what the browser's own ring covers, so
# the pane degrades to its tape-built ladder for it rather than to nothing.
# The crash path saves alongside _save().
SAVE_LEVELS_EVERY_S = 300
LEVELS_V = 1
# Wire default only, never a storage cut. The pane draws 8 rows; 12 plus an
# explicit remainder gives it headroom without shipping the whole map.
LEVELS_TOP_N = 12

_LOCK = threading.Lock()
_BUCKETS = {}          # coin -> {bucket_start_ms: {b, s, n}}

# coin -> {minute_ms: {(m, k, idx): [buy_usd, sell_usd]}}, under the SAME
# _LOCK as _BUCKETS and trimmed to exactly _BUCKETS' key set -- never on its
# own retention rule. Two dicts keyed by the same minutes drift apart the
# moment they are aged separately, and a level tier claiming coverage the b/s
# tier does not have is the API stating a fact it cannot corroborate.
_LEVELS = {}
_LAST_LEVEL_SAVE = [0.0]
# Level-tier write failures are COUNTED AND REPORTED, never raised into the
# collector loop. _maybe_save() runs inside _run()'s try, so a propagating
# error here is indistinguishable from a socket failure and would reconnect
# all 60 subscriptions; on the crash path it would escape _run() entirely and
# kill the collector thread, whose `except Exception: pass` would hide it.
# This is the optional third tier: a disk error must cost the ladder, never
# the CVD. levels_meta() and status() surface the count, so it is not silent.
_LEVELS_ERR = {"n": 0, "last": "", "at": 0.0}
# Wall clock (ms) at which THIS process began recording levels. Distinct from
# the oldest stored minute, which can predate it by up to the retention window
# -- "collecting since" and "have data since" are different claims.
_LEVELS_BEGAN = [0.0]
_STARTED = threading.Event()
_LAST_MSG = {"ts": 0.0}
_LAST_HOURLY_SAVE = [0.0]
# Coins the socket is subscribed to, plus ones asked for since it connected.
# A fixed startup list meant every token outside the crypto watchlist had no
# tape at all, so CVD and per-bar delta were simply blank for CAKE, JUP, PUMP,
# ASTER and everything else you could chart.
_SUBBED = set()
_PENDING = set()
MAX_SUBS = 60          # HL allows many; this is a courtesy ceiling

# --- SOCKET LIVENESS -------------------------------------------------------
# THIS IS THE OUTAGE THIS BLOCK EXISTS FOR. On 2026-08-14 the venue held this
# socket OPEN with all 60 subscriptions attached and sent nothing for 24
# minutes. `async for raw in ws:` waits on that forever. ping_interval=20 /
# ping_timeout=20 did NOT rescue it: asyncio logged the transport's write
# failures ("socket.send() raised exception." x44 in hl-terminal.log) rather
# than raising into this coroutine, so `except Exception` -> backoff ->
# reconnect NEVER RAN and there was no data-staleness check anywhere.
#
# Measured while it was still wedged, so none of this is inferred: /api/flow
# reported running=false with subs_open=60 and last_msg_age_s climbing exactly
# one second per wall-clock second (1788 -> 1813 -> 1838 over 50s), the sibling
# depth collector on the same host was healthy at last_msg 1.3s, and a `sample`
# of the process showed THIS collector's event loop alive with 1492 of 1504
# samples parked in kevent. The loop was fine. The coroutine was suspended on
# an await that could never complete.
#
# So the recv is BOUNDED, and a DATA-staleness watchdog — not the protocol
# ping — is what forces the reconnect.
RECV_TIMEOUT_S = 15         # bound the wait so a silent socket still ticks
# And bound the SENDS for the same reason — see _subscribe(). A subscribe
# frame is ~90 bytes; if that has not cleared the socket buffer in 15s the
# peer has stopped reading, which is the wedge, not slowness.
SEND_TIMEOUT_S = 15

# Silence across ALL subscriptions before the socket is declared deaf.
#
# DELIBERATELY GLOBAL, AND THAT IS THE WHOLE DESIGN. A per-coin rule would
# reconnect-storm: this socket carries xyz equity markets that legitimately
# sleep for hours outside their session, and BTC — the busiest market on it —
# still recorded ZERO prints in 30 of 2,251 measured minutes. Only TOTAL
# silence is diagnostic of the collector rather than of the market.
#
# Sizing, measured off this store's own minute buckets (3,467 minutes of
# uptime across two contiguous runs, 54 coins, 60 subscriptions):
#   socket-wide prints/minute:  min 1 · p5 274 · median 564 · max 41,661
#   intervals between minutes that recorded ANY print on ANY coin:
#     60s x3,506 · 120s x13 · 180s x1 · then NOTHING until 1,380s
#   and all 14 of those intervals above 60s occurred while exactly ONE coin
#   was subscribed (collector startup). Across the 3,279 intervals measured
#   with the full subscription set, the largest gap is 120s.
# Bucket keys are minute-resolution, so a 120s key gap bounds TRUE silence at
# under 180s rather than at 120s — the honest worst case is ~180s, not the 60s
# typical, and quoting 120s here would be reading the measurement too tightly.
# 300s clears that worst case by 1.67x while sitting far below the 1,380s floor
# of the outage cluster, so a quiet 3am market cannot trip it. It bounds
# blindness at ~5 minutes instead of the 24+ it replaces. A false trigger costs
# one paced resubscribe (~9s of missed tape); a missed wedge costs every
# flow-derived number on the terminal, frozen and looking current.
WATCHDOG_S = 300
# Per-coin REPORTING threshold, never a trigger. One bucket: a coin that has
# not printed inside a full minute contributed nothing to the minute being
# recorded, which is the fact a consumer needs — not a reason to reconnect.
QUIET_S = BUCKET_S

# venues.PACE_S is the in-house spacing for anything fired in a burst at this
# venue ("6 of 10 venues failed when fired back-to-back"). A reconnect sends 60
# subscribe frames; unpaced, that is exactly the shape HL sheds — so a
# reconnect storm made the wedge MORE likely, not less. Pacing costs ~9s ONCE
# per connect, against a subscription set that then runs for hours.
try:
    from datasources.venues import PACE_S as SUB_PACE_S
except Exception:           # importable standalone, e.g. from a test harness
    SUB_PACE_S = 0.15

# coin -> wall clock of the last trade frame recorded FOR THAT COIN. A coin
# absent from this dict has NEVER printed on this process — reported separately
# from "printed, then went quiet", because those are not the same claim and
# neither one of them is "measured zero".
_LAST_COIN = {}
# Reconnects forced by the watchdog, counted apart from ordinary reconnects so
# a consumer can tell a flapping socket from a stable one.
_WEDGE = {"n": 0, "at": 0.0, "silent_s": None}

# --- REPLAY DEDUP ----------------------------------------------------------
# HYPERLIQUID REPLAYS RECENT PRINTS ON EVERY `trades` SUBSCRIBE, and _run()
# resubscribes the ENTIRE set on every reconnect. Measured directly on two
# independent read-only sockets: a fresh subscribe hands back 30 prints per
# coin — BTC spanning 9.5s, ETH 30 / 19.8s, SOL 30 / 52.3s. Without an
# identity check _record() simply adds them a second time.
#
# WHY THIS OUTRANKS THE OTHER DOUBLE-COUNTS HERE: the surplus is written to
# data/flow_buckets.json, served to every client for 48h, folded into the
# 400-day hourly tier at ingest — and CVD is a CUMULATIVE SUM, so a duplicated
# print is a PERMANENT step in every CVD drawn afterwards, not a blip that
# averages out.
#
# One observed event matched the signature exactly: a surplus equal to a
# contiguous run of already-recorded prints ending at a common instant across
# three coins — $404,910.88 of BTC buy notional, +39.8% on one bar, and a
# permanent +$401,186.74 step in CVD. HONEST LIMIT: a second independent
# measurer could NOT reproduce it (33 of 33 minutes exact across 12 minutes).
# So the hole was real and unguarded, but the specific event is n=1 and THE
# RATE IS UNKNOWN. Nothing here claims a frequency — the counters below exist
# so the next person reads a measured number instead of this paragraph.
#
# THE CASE THIS MUST NOT BREAK: when an outage outlasts the replay span the
# replay is not duplication, it is a legitimate BACKFILL repairing a gap. So
# the test is print IDENTITY and never "arrived just after a reconnect" — a
# tid already recorded is rejected, a tid not recorded is kept no matter how
# it reached us.
#
# `tid` is the identity, present on every print measured on this channel.
# `hash` is NOT usable as one: 2 of 5 prints in the same measured sample
# carried the all-zero hash. The composite fallback exists only for a payload
# that stops carrying tid, and it CAN collide for two distinct prints sharing
# time+px+sz+side (the measured sample holds two same-ms same-px same-side BTC
# prints separated only by size), so its use is counted rather than assumed
# to be zero.
#
# Ring size: the measured replay is 30 per coin, so 256 is 8.5x headroom for a
# deeper replay on a busier market, and it can never grow without bound — the
# deque is capped per coin and the coin count is capped by MAX_SUBS. Cost
# measured with tracemalloc over 60 coins x 256 real-magnitude tids: 1.18 MB
# total, ~20.7 kB per coin (64 -> 0.35 MB, 512 -> 3.22 MB). Against a minute
# store whose file is 11.57 MB as measured on 2026-08-19 (the "~3 MB" above is
# a design-time estimate from before the subscription set reached 68 coins;
# it is left as written because the tiering argument it supports turns on the
# 48h-vs-90d ratio, not on the absolute), 256 is cheap and 512 is not.
DEDUP_N = 256
_SEEN = {}             # coin -> {"q": deque of keys, oldest first, "k": set(q),
                       #          "t": ms of the newest print accepted for it}
# `dropped`: prints rejected because that identity was already recorded.
# `no_tid`: prints that arrived without a tid and fell back to the composite.
# Counters, not estimates — `dropped` sitting at 0 is then a MEASUREMENT that
# no replay was duplicated, which is the claim nobody could make before.
# `ring_*` are GAUGES describing the persisted ring (see SEEN_KEY), not
# counters: restored_* is what start() read back from STORE, saved_* and
# unsaved are from the most recent _save().
_DEDUP = {"dropped": 0, "no_tid": 0,
          "ring_restored_coins": 0, "ring_restored_tids": 0,
          "ring_saved_coins": 0, "ring_saved_tids": 0, "ring_unsaved": 0}
# Successful connects AFTER the first. Ordinary reconnects were entirely
# UNLOGGED — status() counted only the watchdog-forced ones — which is exactly
# why the replay rate above is unknown. Counted at connect rather than at
# teardown because the connect is what triggers the resubscribe, and the
# resubscribe is what triggers the replay.
_RECONNECT = {"n": 0, "at": 0.0}

# --- THE RING MUST SURVIVE A RESTART ---------------------------------------
# An IN-MEMORY ring starts empty on boot, and boot is the ONE moment it cannot
# afford to: the dying process has already written its buckets to
# flow_buckets.json, the new one subscribes, HL replays ~30 prints per coin,
# and every one of them is re-added to a bucket that is ALREADY ON DISK.
# Measured across the restart at 16:37: 59 of 60 overlapping HYPE minute bars
# bit-identical and the BOUNDARY BAR inflated -- the reconnect case the ring
# already covers, failing at the one seam it could not see.
#
# WHERE IT IS PERSISTED IS THE WHOLE CORRECTNESS ARGUMENT, not a storage
# detail. The ring and the buckets must be written in ONE atomic act, because
# the two failure directions are not symmetric:
#   ring written AFTER the buckets -> a tid is remembered whose bucket never
#     landed, so the replay that would have repaired it is REJECTED and a real
#     print is silently lost. Strictly worse than the double-count.
#   ring written BEFORE the buckets -> the bug is simply not fixed.
# So it rides inside STORE itself, under `_seen`, snapshotted under the SAME
# _LOCK acquisition and shipped through the SAME os.replace() as the minute
# tier -- see _save(). Whatever buckets are on disk, the tids that produced
# them are on disk with them, at every cadence and on the crash path. A
# separate file with its own save interval cannot make that guarantee, and the
# 60s cadence would put a whole save interval of prints on the wrong side of
# it. Under `_seen` (leading underscore) so the legacy `_v != 2` reader in
# _load() and collected()'s fallback both skip it by their existing key rule,
# and `_v` stays 2: the key is purely additive, so a rollback to the previous
# flow_collector.py reads the same file with no migration.
#
# BACKFILL IS PRESERVED BY CONSTRUCTION, which is the property that must not
# regress: the test is still print IDENTITY. Prints replayed after an outage
# longer than the replay span carry tids that were never recorded, are not in
# the restored ring, and are kept. Confirmed live: tids are NOT monotonic
# (three consecutive BTC prints sampled 2026-08-19: 66269464869157,
# 341272029303134, 536140272178160), so no watermark scheme is even available
# here -- identity is the only sound test, and it is the one that backfills.
#
# INTEGER TIDS ONLY. _dup's composite fallback key CAN collide for two
# distinct prints, and a collision that outlives a restart drops a REAL print
# instead of merely double-counting one -- the wrong direction, and the
# explicit rule for this ring. Dropping them makes the persisted ring a SUBSET
# of the live one, whose worst case is the double-count it already replaces.
# It is counted at every save (`ring_unsaved`), not assumed to be zero.
#
# COST, measured end to end rather than estimated. Real tids are 14-15 digits
# (sampled live), so the full ring at MAX_SUBS x DEDUP_N encodes to 246,375
# bytes against the 11,575,354-byte flow_buckets.json this store holds today
# (68 coins / 177,390 buckets): +2.13% on a file already rewritten every 60s,
# to close a hole whose cost is a PERMANENT step in every CVD drawn
# afterwards. _seen_snapshot() adds 0.51 ms inside _save()'s existing _LOCK
# acquisition and _seen_restore() 1.35 ms once at start(). The FULL ring is
# persisted rather than just the measured 30-print replay depth, so the
# persisted bound and the in-memory bound are the SAME number and there is no
# second truncation rule to reason about.
#
# BOUNDED ACROSS RESTARTS, unlike _SEEN itself. _SEEN accumulates every coin
# that has ever printed, and a restored ring would re-persist coins the seed
# dropped months ago, so the save keeps the MAX_SUBS most recently active
# rings and no more -- MAX_SUBS is also the ceiling on how many coins can
# replay at the next subscribe, so nothing that could duplicate is dropped.
# Recency is the newest print ms accepted for that coin, stamped in _dup: one
# compare-and-store per accepted print, timed over 7 x 3 x 1e6 iterations:
# the ring's accept path goes 0.095 -> 0.108 us, a delta of +0.013 us median
# (+0.011 to +0.017 across runs) against the 1.25 us _record() already spends
# per print. That is 1% of it, or 0.04 s of CPU per DAY at the collector's
# measured 40 prints/s.
#
# BOUNDARY MINUTE vs BOUNDARY HOUR -- the two guards do not fight. _load()'s
# hourly merge protects the boundary HOUR by only setdefault-ing hours older
# than the oldest surviving minute; this protects the boundary MINUTE of the
# b/s tier by never re-adding a print to it. They act on different tiers in
# one direction: hours at or after `oldest` are RECOMPUTED FROM the minute
# rows, so a boundary minute that is no longer inflated makes the recomputed
# boundary hour correct too. Neither guard writes what the other reads.
SEEN_KEY = "_seen"

# --- RETENTION MUST NOT DEPEND ON A COIN STILL PRINTING --------------------
# _trim, _trim_hourly and _trim_levels are reached from _record() and NOWHERE
# ELSE, so a coin only ages while it is printing. The instant it rotates out
# of the subscription set it FREEZES: its minute buckets stop aging, its
# levels stop aging, and it stays in the store forever. Measured on the live
# store 2026-08-20: 68 coins in the minute tier against a MAX_SUBS of 60, and
# five of them -- PURR, xyz:GOOGL, xyz:PLTR, xyz:HYUNDAI, xyz:ARM -- had not
# recorded a bucket in 70 to 92 hours while holding 3,708 minute rows between
# them. Nothing in the process would ever have removed one. The COIN dimension
# of every tier was unbounded, which is the part that grows without limit: the
# per-coin caps bound rows, nothing bounded coins.
#
# THE SWEEP IS PERIODIC AND NEVER ON THE PRINT PATH. _record() holds _LOCK
# across ~60 subscriptions at ~40 prints/s; a full-store scan there would pay
# the whole store's cost once per print. It rides the minute save instead --
# see _maybe_save() -- so the sweep and the write that persists its result are
# ONE act and the file on disk can never hold rows memory has already dropped.
# Nothing it does is IO. Cost is MEASURED, not estimated -- on the real
# 68-coin store (179,879 minute rows, 13,636 hourly rows, 51,202 level
# minutes) it is 4.8-5.5 ms median and 6.2 ms worst over 30 passes, holding
# _LOCK once. Broken down: the level pass 3.3 ms, the minute pass 1.4 ms, the
# hourly pass 0.07 ms -- so it scales with LEVEL MINUTES first, which is the
# number to watch if that tier ever grows. For scale, _save() takes the SAME
# lock immediately afterwards for 23 ms to build its snapshot and 614 ms in
# total. The sweep is a quarter of the lock the save is about to hold anyway,
# 0.9% of the save as a whole, and 0.009% of a 60s cycle. _SWEEP_STAT keeps
# the running figures and status() reports them.
#
# THE RULE IS WHOLE-MAP, NOT PER-BUCKET, AND THAT IS DELIBERATE. The minute
# tier's live rule is a COUNT cap (MAX_BUCKETS), which for a SPARSE coin
# retains more than RETAIN_H of wall clock -- 2,880 buckets span 67h on
# xyz:HOOD, because a bucket only exists for a minute that printed. A
# per-bucket wall-clock cut at RETAIN_H would have deleted 19,217 of 179,879
# buckets on the live store (10.7%), and 15,540 of those belong to coins that
# printed in the last SIX MINUTES: a resolution loss on markets being actively
# charted, which is collateral this defect does not call for. So a coin's
# minute map is dropped WHOLE, and only once its NEWEST bucket is itself older
# than RETAIN_H -- at which point every bucket it holds is out of the window,
# so this removes a strict SUBSET of what a per-bucket cut would remove and
# can never touch a coin that printed inside it. Measured on the real store:
# 3,708 rows across those five coins, zero from anything else. The hourly tier
# takes the identical rule against RETAIN_HOURLY_D, the level tier stays
# pinned to the minute tier's key set exactly as _trim_levels pins it.
#
# The consequence worth stating plainly: a rotated-out coin leaves the minute
# and level tiers at RETAIN_H (48h) and the hourly tier at RETAIN_HOURLY_D
# (400d), because 400d IS the hourly tier's designed retention and shortening
# it here would delete archive to fix a bug about orphans. So the coin
# dimension is bounded by 400 days of churn, not by 48 hours of it.
_SWEEP_STAT = {"n": 0, "last_ms": 0.0, "max_ms": 0.0, "at": 0.0,
               "minute_rows": 0, "hourly_rows": 0, "level_minutes": 0,
               "rings": 0, "retired": 0,
               "coins_minute": 0, "coins_hourly": 0, "coins_levels": 0}

# A COIN THAT AGED OUT IS NOT A COIN THAT WAS NEVER COLLECTED, and /api/flow
# states both out loud -- "nothing has EVER been recorded for it" against
# "history that has ENDED" -- branching on newest_bucket_ms(). Deleting a
# coin's last row would have turned the first of those into a false statement
# the first time this sweep ran, so the newest bucket key it held is kept as a
# TOMBSTONE: the one fact that has to outlive the rows. newest_bucket_ms()
# answers from it when no rows remain, so the distinction survives, and
# coin_history() says which of the two it answered from.
#
# Persisted under `_gone` in STORE by the same rules `_seen` follows: an
# additive TOP-LEVEL key with a leading underscore, so _load()'s legacy `_v`
# branch skips it by its existing startswith("_") rule, collected() skips it
# by the same rule, the `_v == 2` branch reads only "minute"/"hourly" and
# ignores it, and a rollback to the previous flow_collector.py reads this
# store with no migration. `_v` stays 2.
#
# Bounded at GONE_MAX, oldest retirement evicted first. Past that bound a coin
# becomes indistinguishable from never-collected again -- which is the
# behaviour that exists today for every coin, so the bound costs nothing that
# was ever available; it is stated here rather than left silent.
GONE_KEY = "_gone"
GONE_MAX = 4 * MAX_SUBS
_GONE = {}             # coin -> {"ms": newest bucket key held, "at": epoch s}


def _dup(coin, t, ms):
    """True if this exact print has already been recorded.

    Caller holds _LOCK. The ring is NEVER cleared on reconnect — outliving the
    reconnect is the whole point of it — and since it is restored from STORE
    at start() it outlives a restart as well, which is the seam that matters
    most (see the block above).
    """
    key = t.get("tid")
    if key is None:
        key = (ms, t.get("px"), t.get("sz"), t.get("side"))
        _DEDUP["no_tid"] += 1
    s = _SEEN.get(coin)
    if s is None:
        s = _SEEN[coin] = {"q": deque(), "k": set(), "t": 0}
    if key in s["k"]:
        _DEDUP["dropped"] += 1
        return True
    s["q"].append(key)
    s["k"].add(key)
    # Newest print ms accepted for this coin. Used ONLY to rank rings when the
    # save caps them at MAX_SUBS; it is never a dedup input, so a wrong or
    # missing stamp can cost a ring its slot but can never reject a print.
    if ms > s["t"]:
        s["t"] = ms
    while len(s["q"]) > DEDUP_N:
        s["k"].discard(s["q"].popleft())
    return False


def _seen_snapshot():
    """{coin: {"t": ms, "q": [tid, ...]}} for the store. CALLER HOLDS _LOCK.

    Integer tids only, MAX_SUBS most recently active coins only — both rules
    and their measurements are argued in the block above. Records how many
    keys were left behind so `ring_unsaved` is a count, not an assumption.
    """
    rows = []
    unsaved = 0
    for c, s in _SEEN.items():
        tids = [k for k in s["q"] if type(k) is int]
        unsaved += len(s["q"]) - len(tids)
        if tids:
            rows.append((s.get("t") or 0, c, tids))
    rows.sort(key=lambda r: -r[0])
    out = {c: {"t": t, "q": tids} for t, c, tids in rows[:MAX_SUBS]}
    _DEDUP["ring_unsaved"] = unsaved
    _DEDUP["ring_saved_coins"] = len(out)
    _DEDUP["ring_saved_tids"] = sum(len(v["q"]) for v in out.values())
    return out


def _seen_restore(raw):
    """Rebuild _SEEN from a store's `_seen` map. NEVER raises.

    Same contract as _load_levels: a corrupt or hand-edited store degrades to
    an empty ring — which is exactly the pre-existing behaviour, one restart's
    worth of replay duplication — rather than taking the collector down with
    it. Every container is checked before it is used as one, and duplicates
    inside `q` are collapsed because _dup's ring invariant is that `k` holds
    each key exactly once (a repeated key would be discarded from the set
    while a second copy still sat in the deque).
    """
    _SEEN.clear()
    _DEDUP["ring_restored_coins"] = 0
    _DEDUP["ring_restored_tids"] = 0
    if not isinstance(raw, dict):
        return 0, 0
    n_c = n_t = 0
    for c, rec in list(raw.items())[:MAX_SUBS]:
        if not isinstance(c, str) or not isinstance(rec, dict):
            continue
        q = rec.get("q")
        if not isinstance(q, list):
            continue
        k = set()
        tids = []
        for v in q[-DEDUP_N:]:
            if type(v) is int and v not in k:
                k.add(v)
                tids.append(v)
        if not tids:
            continue
        try:
            t = int(rec.get("t") or 0)
        except (TypeError, ValueError):
            t = 0
        _SEEN[c] = {"q": deque(tids), "k": k, "t": t}
        n_c += 1
        n_t += len(tids)
    _DEDUP["ring_restored_coins"] = n_c
    _DEDUP["ring_restored_tids"] = n_t
    return n_c, n_t


def _retire(coin, newest_ms, now):
    """Remember that retention removed a coin's LAST row. CALLER HOLDS _LOCK.

    Keeps the LARGER of the key being retired and whatever an earlier
    retirement recorded, so a coin that collected again briefly and aged out
    again can never move its own tombstone backwards.

    The key can be an HOUR start rather than a minute start: the minute tier
    empties at RETAIN_H and the hourly tier 400 days later, so by the time the
    LAST row goes the finest thing left to name is the hour that contained the
    coin's final print. It is still a bucket that was really recorded -- the
    claim is "a bucket started here", not "the last print landed here" -- and
    it is at most one hour early on a fact that is 400 days old.
    """
    prev = _GONE.get(coin) or {}
    ms = newest_ms
    if (prev.get("ms") or 0) > (ms or 0):
        ms = prev.get("ms")
    _GONE[coin] = {"ms": int(ms) if ms else None, "at": round(now, 3)}
    if len(_GONE) > GONE_MAX:
        stale = sorted(_GONE, key=lambda c: _GONE[c].get("at") or 0)
        for c in stale[:len(_GONE) - GONE_MAX]:
            _GONE.pop(c, None)


def _gone_restore(raw):
    """Rebuild _GONE from a store's `_gone` map. NEVER raises.

    Same degrade-to-empty contract as _seen_restore and _load_levels: every
    container is checked before it is used as one, and a corrupt entry is
    skipped rather than taking the collector down.

    Restored INSIDE _load() rather than handed back the way `_seen` is, and
    the asymmetry is deliberate. The ring MUST travel with the buckets it was
    saved beside, because remembering a tid whose bucket never landed drops a
    real print (see SEEN_KEY). A tombstone is only ever read when every tier
    is empty for that coin, so there is no ordering hazard to route through
    start().
    """
    _GONE.clear()
    if not isinstance(raw, dict):
        return 0
    for c, rec in list(raw.items())[:GONE_MAX]:
        if not isinstance(c, str) or not isinstance(rec, dict):
            continue
        ms = rec.get("ms")
        try:
            ms = int(ms) if ms is not None else None
            at = float(rec.get("at") or 0.0)
        except (TypeError, ValueError):
            continue
        _GONE[c] = {"ms": ms, "at": at}
    return len(_GONE)


def coin_history(coin):
    """Three-way state for `coin`: held now, retired by retention, or unknown.

    THE THREE ARE DIFFERENT CLAIMS and collapsing any two of them is the
    failure this exists to prevent:
      live     -- rows are held right now; `newest_ms` comes from them.
      retired  -- retention removed the last of them. `newest_ms` is the
                  tombstone: a bucket that WAS recorded. `retired_at` is when
                  the sweep dropped it.
      unknown  -- nothing held and no retirement remembered. That is "never
                  collected on this store" OR a retirement evicted past
                  GONE_MAX. Those two are NOT separable here, so a caller must
                  not render this as "never".
    """
    with _LOCK:
        mins = len(_BUCKETS.get(coin) or {})
        hrs = len(_HOURLY.get(coin) or {})
        lvl = len(_LEVELS.get(coin) or {})
        keys = list(_BUCKETS.get(coin) or {}) + list(_HOURLY.get(coin) or {})
        rec = dict(_GONE.get(coin) or {})
    if keys:
        return {"coin": coin, "state": "live", "newest_ms": max(keys),
                "minute": mins, "hourly": hrs, "levels": lvl,
                "retired_at": None}
    if rec:
        return {"coin": coin, "state": "retired", "newest_ms": rec.get("ms"),
                "minute": 0, "hourly": 0, "levels": 0,
                "retired_at": rec.get("at") or None}
    return {"coin": coin, "state": "unknown", "newest_ms": None,
            "minute": 0, "hourly": 0, "levels": 0, "retired_at": None,
            "note": "nothing is held for %r and no retirement is remembered "
                    "(the tombstone map keeps the %d most recent). This is "
                    "NOT a measurement that it never traded, and it is not "
                    "proof it was never collected either." % (coin, GONE_MAX)}


def ensure(coin):
    """Subscribe to `coin` on the live socket if we are not already.

    This ACCEPTS dex-qualified equity perps. It used to reject anything with a
    colon on the stated premise that "equity perps have no trade stream here",
    and that premise was simply false — measured 2026-08-14, one socket, 14
    `xyz:` markets subscribed to `trades`: 14 subscription acks, zero error
    frames, and every one of the 14 printed inside 75 seconds (xyz:GOLD 396
    prints, xyz:SILVER 352, xyz:MU 293, xyz:SNDK 259). The coin name goes over
    the wire verbatim; there is no separate dex parameter on this channel.

    The guard sat inside ensure(), so it blocked the seed path AND the
    on-demand path: charting an xyz market could never start collection, and
    CVD and per-bar delta were structurally blank across the 109-market sleeve
    carrying $4.22B/24h — more than core Hyperliquid's $2.90B.
    """
    if not coin:
        return False
    with _LOCK:
        if coin in _SUBBED or coin in _PENDING:
            return False
        if len(_SUBBED) + len(_PENDING) >= MAX_SUBS:
            return False
        _PENDING.add(coin)
    return True


def subscribed():
    with _LOCK:
        return sorted(_SUBBED), sorted(_PENDING)


def collected(limit=None):
    """Coins that already have persisted history, most rows first.

    Read straight off the store file, because start() has not loaded it yet
    when the seed is being built. It exists so a restart cannot silently
    unsubscribe a market that already holds hours nobody can refetch — the trade tape only accrues forward:
    the seed passes this as `keep`, ranked below the fresh volume picks, so
    what gets lost first when slots run short is what has fallen out of the
    top N — not what has the deepest record.
    """
    try:
        with open(STORE) as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return []
    rows = d.get("minute") if isinstance(d, dict) and "minute" in d else d
    if not isinstance(rows, dict):
        return []
    counts = {}
    for c, v in rows.items():
        if not c.startswith("_") and isinstance(v, dict):
            counts[c] = len(v)
    out = sorted(counts, key=lambda c: -counts[c])
    return out[:limit] if limit else out


def _mapping(v):
    """`v` if the store really put a mapping there, else {}.

    EVERY container that comes back out of json.load is a claim, not a
    guarantee — the writer's own shape says nothing about what is on disk now.
    `(d.get("x") or {}).items()` guards the MISSING case and not the WRONG-TYPE
    one: a truthy non-mapping (a list, a string) raises AttributeError right
    through the (OSError, ValueError) handler these loaders use, and takes the
    whole collector down instead of degrading to empty. Cheap, total, and
    applied at every level: the outer coin map, the inner row map, and the
    ring — see _rows() and _seen_restore().
    """
    return v if isinstance(v, dict) else {}


def _rows(v):
    """{"1755..": {b, s, n}} off disk -> {1755...: {b, s, n}}, garbage dropped.

    Guards what _mapping() cannot: an unparseable bucket key (int() raises
    ValueError) and a bucket that is not a mapping at all — the reconciliation
    below and series() both call .get() on these values, so a bare list there
    is the same crash one step later.
    """
    if not isinstance(v, dict):
        return {}
    out = {}
    for k, b in v.items():
        if not isinstance(b, dict):
            continue
        try:
            out[int(k)] = b
        except (TypeError, ValueError):
            continue
    return out


def _load():
    """Returns (minute_buckets, hourly_buckets, seen_ring_raw).

    Minute tier from STORE; hourly from its own STORE_HOURLY (falling back to
    the hourly embedded in a legacy combined file). Then the minute tier is
    re-aggregated over the hourly tier: minute data is ground truth wherever it
    exists (the same rule series() applies), which also makes the 30-minute
    hourly save cadence lossless — anything unsaved at a crash is rebuilt from
    the minute buckets here.

    The third value is STORE's raw `_seen` ring, returned rather than restored
    here so the ring travels with the buckets it was saved beside — one parse,
    no second read of an 11.6 MB file. start() hands it to _seen_restore().
    A corrupt store degrades to empty tiers and an empty ring; nothing in this
    function raises on shape."""
    try:
        with open(STORE) as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        d = {}
    if isinstance(d, dict) and d.get("_v") == 2:
        mins = {c: _rows(rows) for c, rows in _mapping(d.get("minute")).items()}
        hrs = {c: _rows(rows) for c, rows in _mapping(d.get("hourly")).items()}
    else:
        mins = {c: _rows(rows) for c, rows in _mapping(d).items()
                if not str(c).startswith("_")}
        hrs = {}
    seen = _mapping(d).get(SEEN_KEY)
    # Restored here rather than returned: unlike the ring there is no ordering
    # hazard to carry through start() -- see _gone_restore().
    _gone_restore(_mapping(d).get(GONE_KEY))
    try:
        with open(STORE_HOURLY) as fh:
            hd = json.load(fh)
    except (OSError, ValueError):
        hd = {}
    # Outside the try on purpose: a shape fault here must skip the merge, not
    # abandon it half-applied, and open()/json.load() are the only things in
    # this block that can raise once the containers are guarded.
    for c, rows in _mapping(_mapping(hd).get("hourly")).items():
        merged = hrs.setdefault(c, {})
        for k, v in _rows(rows).items():
            merged.setdefault(k, v)
    # Reconcile: recompute every hour the minute tier FULLY covers, so a crash
    # between hourly saves costs nothing.
    #
    # THE BOUNDARY HOUR IS ONLY PARTLY COVERED and overwriting it corrupts the
    # 400-day archive permanently, once per restart. The minute tier is capped
    # at MAX_BUCKETS and the oldest surviving minute lands mid-hour, so the sum
    # over what survives is a FRACTION of that hour's real volume. The size of
    # the crater is whatever the clock happens to be doing at restart —
    # measured at the cap on BTC: 33 of 60 minutes left on 2026-08-17, and on
    # 2026-08-18 the boundary hour would have been rewritten from 2,153,809 to
    # 1,342,048 (62%), ETH to 85%, SOL to 48%.
    #
    # The damage is already visible in the archive: 18 hours in flow_hourly
    # where five or more of the 21 well-covered coins ALL crater below 10% of
    # both their neighbours at the same instant. A whole-collector event is
    # the only thing that hits every coin's boundary hour together, and this
    # bug is one such event per restart (a socket wedge is the other).
    # An unconditional .update() cannot tell the two cases apart; the guard is
    # ported verbatim from depth_history._load, whose comment names this exact
    # failure. Existing craters are NOT repaired by this — nothing can rebuild
    # a tape that has aged out — they only leave as retention ages them off.
    for c, rows in mins.items():
        if not rows:
            continue
        oldest = min(rows)
        agg = {}
        for k, v in rows.items():
            hk = (k // (HOUR_S * 1000)) * (HOUR_S * 1000)
            a = agg.setdefault(hk, {"b": 0.0, "s": 0.0, "n": 0})
            a["b"] += v.get("b", 0.0)
            a["s"] += v.get("s", 0.0)
            a["n"] += v.get("n", 0)
        dst = hrs.setdefault(c, {})
        for hk, a in agg.items():
            if hk >= oldest:
                dst[hk] = a
            else:
                dst.setdefault(hk, a)
    return mins, hrs, seen


def _save_hourly():
    with _LOCK:
        snap = {"_v": 1,
                "hourly": {c: {str(k): v for k, v in b.items()}
                           for c, b in _HOURLY.items()}}
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(STORE_HOURLY), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(snap, fh)
        os.replace(tmp, STORE_HOURLY)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _save():
    # Minute tier only — the hourly tier lives in its own, rarely-written file
    # so its retention is not bounded by what we can rewrite every 60 seconds.
    #
    # THE DEDUP RING RIDES ALONG, and it must ride HERE rather than in a file
    # of its own: it is snapshotted inside this same `with _LOCK` and shipped
    # by this same os.replace(), so the tids and the buckets they produced can
    # never land on disk at different moments. See SEEN_KEY for why either
    # ordering of two separate writes is unsound.
    with _LOCK:
        snap = {"_v": 2,
                "minute": {c: {str(k): v for k, v in b.items()}
                           for c, b in _BUCKETS.items()},
                "hourly": {},
                SEEN_KEY: _seen_snapshot(),
                # Same atomic write as the buckets, for a plainer reason than
                # the ring's: a tombstone that did not survive a restart would
                # let /api/flow answer "nothing has EVER been recorded" about
                # a coin this very process aged out. Deep-copied because it is
                # tiny and json.dump runs outside the lock.
                GONE_KEY: {c: dict(v) for c, v in _GONE.items()}}
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(STORE), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(snap, fh)
        os.replace(tmp, STORE)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _atomic_json(path, payload):
    """tmp + rename, compact separators, and NEVER an orphaned tmp file.

    OSError alone is too narrow: json.dump walking a structure another thread
    is mutating raises RuntimeError, which escapes that handler and leaves the
    mkstemp file behind, unreferenced, forever -- there is one such orphan in
    data/ from 2026-08-14. Widened and re-raised, exactly as buyback._save
    does; the caller decides whether the failure is fatal to it.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(payload, fh, separators=(",", ":"))
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _save_levels():
    """Snapshot under the lock; encode and write OUTSIDE it. Never raises.

    NOTHING UNDER _LOCK DOES IO -- this collector serves ~60 live
    subscriptions and the lock is on the per-print path. The snapshot is an
    OUTER copy only: the inner per-minute maps travel by reference, which is
    safe because _record() and this function both run on the collector thread
    and cannot interleave, and _runs() reads each map through
    list(cells.items()), atomic under the GIL. A deep copy of ~800k cells
    under the lock would be the expensive mistake here.

    See _LEVELS_ERR for why a write failure is recorded instead of raised.
    """
    with _LOCK:
        snap = {c: dict(b) for c, b in _LEVELS.items() if b}
    try:
        enc = {c: {str(k): _runs(cells) for k, cells in b.items() if cells}
               for c, b in snap.items()}
        _atomic_json(STORE_LEVELS, {"_v": LEVELS_V, "levels": enc})
    except Exception as exc:
        _LEVELS_ERR["n"] += 1
        _LEVELS_ERR["last"] = "%s: %s" % (type(exc).__name__, str(exc)[:160])
        _LEVELS_ERR["at"] = time.time()


def _load_levels(buckets=None):
    """Rebuild {coin: {minute_ms: {(m,k,idx): [b, s]}}} from STORE_LEVELS.

    A missing, truncated or version-mismatched level file returns {} and NEVER
    takes the b/s tiers down with it: the ladder is a convenience, CVD is the
    record. Pass `buckets` (the loaded minute tier) and any minute the b/s tier
    does not hold is dropped on the way in -- the same invariant
    _trim_levels() maintains at runtime, so `lc` can never claim coverage the
    buckets cannot corroborate. A coin absent from `buckets` keeps NO levels.
    """
    try:
        with open(STORE_LEVELS) as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return {}
    if not isinstance(d, dict) or d.get("_v") != LEVELS_V:
        return {}
    out = {}
    # _mapping(), not `or {}`: the per-coin `rows` below was already checked
    # and the version and the outer object were already checked, but the
    # `levels` CONTAINER itself was not -- and a truthy non-mapping there (a
    # list, a string) raises AttributeError out of this function, past the
    # (OSError, ValueError) handler above, past start()'s call site, and kills
    # the ENTIRE collector: no b/s buckets either, exactly the outcome the
    # docstring promises cannot happen. The ladder is allowed to cost the
    # ladder and nothing else.
    for c, rows in _mapping(d.get("levels")).items():
        if not isinstance(rows, dict):
            continue
        keep = None if buckets is None else (buckets.get(c) or {})
        dst = {}
        for ms, runs in rows.items():
            try:
                ms_i = int(ms)
            except (TypeError, ValueError):
                continue
            if keep is not None and ms_i not in keep:
                continue
            cells = {}
            for run in (runs or []):
                if not isinstance(run, list) or len(run) < 6:
                    continue
                m, k, i0 = run[0], run[1], run[2]
                for j in range(3, len(run) - 2, 3):
                    try:
                        cells[(m, k, i0 + run[j])] = [float(run[j + 1]),
                                                      float(run[j + 2])]
                    except (TypeError, ValueError):
                        continue
            if cells:
                dst[ms_i] = cells
        if dst:
            out[c] = dst
    return out


def _trim_hourly(coin):
    hrs = _HOURLY.get(coin) or {}
    if len(hrs) > MAX_HOURLY:
        for k in sorted(hrs)[:len(hrs) - MAX_HOURLY]:
            hrs.pop(k, None)


def _trim(coin, rows):
    """Drop expired minute buckets. Nothing is rolled here: the hourly tier is
    written at ingest instead.

    Rolling on expiry meant hourly depth only grew as minute buckets aged out
    past 48h — one hour of history per hour of uptime, so a 90-day hourly tier
    needed 90 days of uptime and a 1h chart showed 19% coverage. Writing both
    tiers at ingest makes hourly depth equal total uptime immediately.
    `series()` already prefers minute rows wherever they exist, so the overlap
    is never double counted."""
    if len(rows) <= MAX_BUCKETS:
        return rows
    for k in sorted(rows)[:len(rows) - MAX_BUCKETS]:
        rows.pop(k, None)
    return rows


def _trim_levels(coin, rows):
    """Age level minutes against _BUCKETS' key set, never against a clock.

    Caller holds _LOCK and has ALREADY trimmed `rows`. Levels are only ever
    written for a minute that also created a b/s bucket, so the level keys are
    a subset of the bucket keys -- which makes len(lmap) <= len(rows) an exact
    O(1) test for "nothing has aged out yet" and keeps this off the hot path.
    Any code path that trims _LEVELS on its own retention constant is a bug:
    the two tiers must never disagree about which minutes exist.
    """
    lmap = _LEVELS.get(coin)
    if not lmap or len(lmap) <= len(rows):
        return
    for k in [k for k in lmap if k not in rows]:
        lmap.pop(k, None)


def _sweep(now=None):
    """Retention for EVERY coin in the store, not just the ones printing.

    This is the only place any tier ages while a coin is silent. The argument
    for the whole-map rule, the cadence and the measured cost are in the
    RETENTION block near SEEN_KEY; what follows is what this function does.

    NOTHING HERE DOES IO. One _LOCK acquisition, pure dict work, and it is
    called from _maybe_save() immediately before _save() -- the write that
    persists the result -- and once from start() so a store that is already in
    violation is corrected before the first save and before status() reports a
    single number off it.

    ORDER MATTERS IN ONE PLACE: levels are pruned AFTER the minute tier and
    against its surviving key set, exactly as _record() does it via
    _trim_levels. That is also why this pass takes the EXACT set difference
    instead of reusing _trim_levels' O(1) `len(lmap) <= len(rows)` shortcut.
    The shortcut is sound at ingest only while the two key sets are EQUAL; a
    crash between the 300s level save and the 60s bucket save leaves levels a
    strict SUBSET of buckets, and from then on the shortcut can return early
    while a level minute whose bucket has already aged out survives. Measured
    on the live store the leak is currently zero (0 orphan level minutes
    across 51,202), so this pass is a repair path that has not yet had to
    repair anything -- and at 3.3 ms it is the most expensive third of the
    sweep, which is why the hot path keeps the shortcut and this does not.

    Returns the counts for this pass; also folded into _SWEEP_STAT for
    status().
    """
    now = time.time() if now is None else now
    cut_min = (now - RETAIN_H * 3600.0) * 1000.0
    cut_hr = (now - RETAIN_HOURLY_D * 86400.0) * 1000.0
    t0 = time.perf_counter()
    n_min = n_hr = n_lvl = n_ring = n_ret = 0
    c_min = c_hr = c_lvl = 0
    # coin -> newest key it held at the moment a tier was emptied. Feeds the
    # tombstone, so the fact outlives the rows.
    emptied = {}
    with _LOCK:
        for coin in list(_BUCKETS):
            rows = _BUCKETS[coin]
            before = len(rows)
            if rows and max(rows) < cut_min:
                # EVERY bucket this coin holds is outside the window, because
                # its newest one is. Dropping the map whole therefore removes
                # a subset of what a per-bucket cut would remove.
                emptied[coin] = max(rows)
                rows.clear()
                c_min += 1
            else:
                # Belt and braces: _record() already trims a printing coin, so
                # this is a no-op for it. It repairs a store written by an
                # older build, or one hand-edited past the cap.
                _trim(coin, rows)
            n_min += before - len(rows)
            if not rows:
                _BUCKETS.pop(coin, None)
        for coin in list(_HOURLY):
            hrs = _HOURLY[coin]
            before = len(hrs)
            if hrs and max(hrs) < cut_hr:
                mx = max(hrs)
                if mx > (emptied.get(coin) or 0):
                    emptied[coin] = mx
                hrs.clear()
                c_hr += 1
            else:
                _trim_hourly(coin)
            n_hr += before - len(hrs)
            if not hrs:
                _HOURLY.pop(coin, None)
        for coin in list(_LEVELS):
            lmap = _LEVELS[coin]
            rows = _BUCKETS.get(coin) or {}
            dead = [k for k in lmap if k not in rows]
            if dead:
                c_lvl += 1
                for k in dead:
                    lmap.pop(k, None)
                n_lvl += len(dead)
            if not lmap:
                _LEVELS.pop(coin, None)
        for coin, mx in emptied.items():
            if coin in _BUCKETS or coin in _HOURLY or coin in _LEVELS:
                continue
            _retire(coin, mx, now)
            n_ret += 1
        # A tombstone describes a coin with NO rows. One that has started
        # collecting again is described by its rows, and leaving both would
        # let coin_history() answer "retired" about a live market.
        for coin in list(_GONE):
            if coin in _BUCKETS or coin in _HOURLY or coin in _LEVELS:
                _GONE.pop(coin, None)
        # THE RING OUTLIVES THE DATA IT PROTECTS, and dropping it early is the
        # one thing in this function that could COST a print rather than free
        # a row. HL replays ~30 prints on every subscribe; without a ring
        # those land a second time, and for a coin whose minute buckets have
        # aged out they would land in the 400-day HOURLY tier as a permanent
        # step. So a ring is dropped only when the coin can no longer be
        # replayed to AND has nothing left to protect: not subscribed, not
        # pending, and absent from all three tiers.
        #
        # Gated on the subscription set being KNOWN. Before the first connect
        # -- which includes start(), where _seen_restore() has just rebuilt
        # the ring from disk -- _SUBBED and _PENDING are both empty, and that
        # is ignorance of what is subscribed, not evidence that nothing is.
        # Treating it as evidence would delete the restored ring at every boot
        # and hand back the boundary-bar inflation that persisting it fixed.
        if _SUBBED or _PENDING:
            for coin in list(_SEEN):
                if (coin in _SUBBED or coin in _PENDING or coin in _BUCKETS
                        or coin in _HOURLY or coin in _LEVELS):
                    continue
                _SEEN.pop(coin, None)
                n_ring += 1
        ms = (time.perf_counter() - t0) * 1000.0
        _SWEEP_STAT["n"] += 1
        _SWEEP_STAT["last_ms"] = round(ms, 3)
        _SWEEP_STAT["max_ms"] = round(max(_SWEEP_STAT["max_ms"], ms), 3)
        _SWEEP_STAT["at"] = now
        _SWEEP_STAT["minute_rows"] += n_min
        _SWEEP_STAT["hourly_rows"] += n_hr
        _SWEEP_STAT["level_minutes"] += n_lvl
        _SWEEP_STAT["rings"] += n_ring
        _SWEEP_STAT["retired"] += n_ret
        _SWEEP_STAT["coins_minute"] += c_min
        _SWEEP_STAT["coins_hourly"] += c_hr
        _SWEEP_STAT["coins_levels"] += c_lvl
    return {"ms": round(ms, 3), "minute_rows": n_min, "hourly_rows": n_hr,
            "level_minutes": n_lvl, "rings": n_ring, "retired": n_ret,
            "coins_minute": c_min, "coins_hourly": c_hr, "coins_levels": c_lvl}


def _level_key(px):
    """(m, k, idx) -- the SAME price level app.js tickFor() would choose.

    Returns None for a price that cannot be bucketed (non-positive, inf, nan,
    or underflowed to zero); the caller drops the LEVEL and keeps the b/s
    accumulation, because an unbucketable price is still real volume.

    THIS IS THE SEAM AND IT IS THE HIGHEST-RISK FUNCTION IN THE FILE. app.js
    (tickFor, ~line 11434) computes

        raw  = px * 0.0002
        mag  = 10 ** floor(log10(raw))
        tick = max(mag, round(raw / mag) * mag)
        level = round(px / tick)

    and there are exactly two ways to port that wrong, both measured:

    1. round(). JS Math.round is half-UP; Python round() is banker's. Over the
       135,000-price sweep in levels_selftest() they disagree on 10,354 prices
       (7.67%) -- including BTC at 64,385, where px/tick is exactly 6438.5 and
       the browser says 6439 while round() says 6438, and 12,500, where the
       whole TICK changes (3 vs 2). math.floor(x + 0.5) is the half-up form
       and is not negotiable.

    2. Rebuilding the tick from the CANONICALISED (m, k). When raw/mag rounds
       to 10 the browser's tick is the float 10*mag, which is NOT bit-identical
       to 10.0**(k+1) at k=-11 and k=-6 (measured: 500 of the 3,750 m==10 cases
       in the sweep carry that 1-ulp gap). Across the sweep the gap moves no
       index, but a dense probe of those two decade edges found 1 disagreement
       in 400,000 prices -- a server ladder and a ring ladder that both look
       plausible and quietly disagree, which is the worst failure this pane
       has. So idx is computed against the BROWSER'S tick float and the (m, k)
       canonicalisation applies to the STORAGE KEY ONLY: the key is an identity
       for grouping, the tick float is the arithmetic.

    levels_selftest() pins the exact FNV-1a checksum the live browser returned
    for that sweep. If app.js ever changes tickFor, the checksum breaks
    immediately -- which is the point of pinning it rather than re-deriving it.
    """
    if not (px > 0.0) or not math.isfinite(px):
        return None
    raw = px * 0.0002
    if raw <= 0.0:                      # underflow on an absurdly small price
        return None
    k = math.floor(math.log10(raw))
    mag = 10.0 ** k
    if mag <= 0.0:
        # MEASURED, not hypothetical: 10.0**k underflows to 0.0 at k <= -324
        # while `raw` is still a nonzero subnormal, so `raw / mag` raises
        # ZeroDivisionError -- 270 of 300,009 fuzzed prices, all near 1e-320.
        # _record() only wraps the px/sz/ms parse in a try, so that exception
        # would leave _record(), reach _run()'s `except Exception`, and be
        # handled as a SOCKET FAILURE: a reconnect and a resubscribe of all 60
        # markets, triggered by one malformed print. No such price exists on a
        # perp venue; this is wire data and the cost of the check is one
        # comparison.
        return None
    m = math.floor(raw / mag + 0.5)     # JS Math.round -> 1..10
    if m < 1:
        # Unreachable for any real price (raw/mag is in [1,10) by
        # construction, and the 135,000-price sweep never leaves 1..10), but
        # 10.0**k loses its footing among subnormals and this is wire data.
        # An m of 0 would key a level at tick 0, which the client cannot turn
        # back into a price -- refuse it rather than ship an unreconstructable
        # level. The b/s accumulation above is unaffected.
        return None
    tick = m * mag
    if tick < mag:                      # mirrors Math.max(mag, ...) exactly
        tick = mag
    idx = math.floor(px / tick + 0.5)
    if m >= 10:                         # 10 * 10**k is the same tick as 1 * 10**(k+1)
        m, k = 1, k + 1
    return m, k, idx


def _dollars(v):
    """Whole USD, half-up, with a floor of $1 on anything that actually traded.

    A level holding $0.40 of buying must not read as $0: "traded but reads
    zero" is precisely the failure this terminal exists to prevent, and it is
    indistinguishable from "no trade at this price" once written. The cost is
    an overstatement of at most $1 on the very smallest levels -- bounded at
    <= $12 on a 12-row bar rendering millions, and stated rather than hidden.
    """
    if v <= 0.0:
        return 0
    n = math.floor(v + 0.5)
    return n if n else 1


def _runs(cells):
    """{(m,k,idx): [b,s]} -> [[m, k, i0, d0,b0,s0, d1,b1,s1, ...], ...].

    One run per DISTINCT TICK in the bucket. 99.81% of minute buckets have
    exactly one; the list form exists for the measured 0.188% that straddle a
    tick step (0.711% at 5m, 3.4% at 1h, 21% at 1d). The client buckets PER
    PRINT, so a single per-bucket tick would silently mis-key ~333 of 177,000
    minute buckets -- and an "optimisation" that collapses the runs later
    reintroduces that bug in a form no test catches unless the tick assertions
    in levels_selftest() are kept.

    list(cells.items()) rather than a bare iteration: that call is atomic under
    the GIL, so it cannot trip "dictionary changed size during iteration"
    against the collector thread appending a level to the minute in flight.
    """
    by = {}
    for lk, v in list(cells.items()):
        by.setdefault((lk[0], lk[1]), []).append((lk[2], v[0], v[1]))
    out = []
    for mk in sorted(by):
        lv = sorted(by[mk])
        i0 = lv[0][0]
        run = [mk[0], mk[1], i0]
        for idx, bv, sv in lv:
            run.append(idx - i0)
            run.append(_dollars(bv))
            run.append(_dollars(sv))
        out.append(run)
    return out


def _wire_runs(items):
    """[((m,k,idx), [b,s]), ...] -> [{m, k, i0, L:[d, b, s, ...]}] by tick.

    Same encoding as _runs(), named rather than positional, because the wire
    form is read by a human debugging the pane far more often than the store is.
    """
    by = {}
    for lk, v in items:
        by.setdefault((lk[0], lk[1]), []).append((lk[2], v[0], v[1]))
    out = []
    for mk in sorted(by):
        lv = sorted(by[mk])
        i0 = lv[0][0]
        row = []
        for idx, bv, sv in lv:
            row.append(idx - i0)
            row.append(_dollars(bv))
            row.append(_dollars(sv))
        out.append({"m": mk[0], "k": mk[1], "i0": i0, "L": row})
    return out


def _record(coin, trades):
    with _LOCK:
        rows = _BUCKETS.setdefault(coin, {})
        n_dup = 0
        for t in trades:
            try:
                px = float(t["px"])
                sz = float(t["sz"])
                ms = int(t["time"])
            except (KeyError, TypeError, ValueError):
                continue
            if _dup(coin, t, ms):
                n_dup += 1
                continue
            usd = px * sz
            k = (ms // (BUCKET_S * 1000)) * BUCKET_S * 1000
            b = rows.get(k)
            if b is None:
                b = rows[k] = {"b": 0.0, "s": 0.0, "n": 0}
            hk = (ms // (HOUR_S * 1000)) * HOUR_S * 1000
            hrs = _HOURLY.setdefault(coin, {})
            h = hrs.get(hk)
            if h is None:
                h = hrs[hk] = {"b": 0.0, "s": 0.0, "n": 0}
            # Hoisted: this used to be re-evaluated inline and is now read
            # twice, by the b/s tiers and by the level tier below.
            buy = str(t.get("side", "")).upper().startswith("B")
            if buy:
                b["b"] += usd
                h["b"] += usd
            else:
                b["s"] += usd
                h["s"] += usd
            b["n"] += 1
            h["n"] += 1
            # --- FOOTPRINT TIER --------------------------------------------
            # Inside the dedup guard above, so the tid ring covers levels for
            # free: a replayed print cannot reach this line, which matters
            # more here than for the b/s tiers because a per-price level is
            # what the eye reads as "size stacked here".
            #
            # O(1) per print, no IO, and no allocation beyond one dict entry
            # the first time a price level is touched in a minute.
            #
            # MEASURED HERE, on this interpreter (3.9.6), against the
            # unmodified _record and with prices drawn from a live capture:
            # +0.40 to +0.46 us/print, i.e. 0.83 -> 1.25 us/print. On the
            # largest minute bucket this store has ever recorded (5,279
            # prints, and that is the real max across 177k buckets) the inner
            # loop goes 4.5 ms -> 6.7 ms, +2.1 to +2.3 ms. The design phase
            # predicted +0.257 us and "under 2 ms"; the real cost is ~1.6x
            # that and the bound is missed, so the number here is the
            # measurement, not the estimate. It is still immaterial: the
            # collector averages 40 prints/s across all 67 subscriptions, so
            # this is ~3 s of CPU per DAY, against _save_levels() spending
            # 0.87 s every 300 s.
            #
            # The cost is _level_key's arithmetic, not the dict inserts --
            # measured flat (2.08/2.30/2.17/2.21 ms) as the distinct levels in
            # the minute go 2 -> 4 -> 14 -> 52. So caching the tick across
            # prints is the only lever, it buys well under a millisecond on
            # the worst minute in history, and it puts the identity rule in
            # _level_key at risk. Deliberately NOT done.
            lk = _level_key(px)
            if lk is not None:
                lmap = _LEVELS.get(coin)
                if lmap is None:
                    lmap = _LEVELS[coin] = {}
                lb = lmap.get(k)
                if lb is None:
                    lb = lmap[k] = {}
                cell = lb.get(lk)
                if cell is None:
                    cell = lb[lk] = [0.0, 0.0]
                if buy:
                    cell[0] += usd
                else:
                    cell[1] += usd
        # Stamped at the FRAME, not at a successfully parsed print: a trade
        # that arrives and then fails the float() above still proves this
        # subscription is alive. "this stream is dead" and "this payload is
        # unusable" are different faults and must not share a symptom.
        #
        # THE ONE FRAME THAT IS NOT EVIDENCE is the all-duplicate one, and the
        # subscribe replay is exactly that shape. A reconnect hands back ~30
        # prints for EVERY coin at once, including markets that last traded
        # hours ago — the xyz equity sleeve sleeps outside its session — so
        # stamping on it would report all 60 subscriptions as having printed
        # within QUIET_S of any reconnect. Prints we already hold, re-sent, are
        # not new market activity, and _liveness() would have been reading a
        # reconnect as a trading market. An empty frame and a parse failure are
        # unchanged: neither is a duplicate, so both still stamp.
        if not (n_dup and n_dup == len(trades)):
            _LAST_COIN[coin] = time.time()
        _trim(coin, rows)
        _trim_hourly(coin)
        # AFTER _trim, and against ITS key set -- see _trim_levels.
        _trim_levels(coin, rows)


def series(coin, hours=24, bucket_s=BUCKET_S):
    """[{ms, buy, sell, delta, cvd, n}] oldest first, CVD cumulative in-window."""
    with _LOCK:
        rows = dict(_BUCKETS.get(coin) or {})
        hrs = dict(_HOURLY.get(coin) or {})
    cutoff = (time.time() - hours * 3600) * 1000

    # Compose the tiers. They are disjoint by construction — a minute bucket is
    # only rolled into its hour when it is dropped — so the older hourly rows
    # can simply be added without double counting. Hourly rows can only serve a
    # request whose own bucket is at least an hour; asking for 5m buckets from
    # 60 days ago would silently pile an hour of flow onto one 5m bar.
    if hrs and bucket_s >= HOUR_S:
        # Skip any hour the minute tier already covers, by exact hour key.
        # The old test (`hk >= oldest_min`) missed the BOUNDARY hour: the hour
        # containing the oldest minute bucket starts before it, so that hour
        # passed the test and its rows were added on top of the minute rows for
        # the same hour — double counting. Now hourly is written at ingest, so
        # the two tiers overlap fully and this has to be exact.
        covered = {(k // (HOUR_S * 1000)) * (HOUR_S * 1000) for k in rows}
        for hk, hv in hrs.items():
            if hk < cutoff or hk in covered:
                continue
            rows[hk] = hv
    if not rows:
        return []
    group = max(1, int(bucket_s // BUCKET_S))
    merged = {}
    for k in sorted(rows):
        if k < cutoff:
            continue
        gk = (k // (group * BUCKET_S * 1000)) * (group * BUCKET_S * 1000)
        m = merged.get(gk)
        if m is None:
            m = merged[gk] = {"ms": gk, "buy": 0.0, "sell": 0.0, "n": 0}
        m["buy"] += rows[k]["b"]
        m["sell"] += rows[k]["s"]
        m["n"] += rows[k]["n"]
    out, cvd = [], 0.0
    for gk in sorted(merged):
        m = merged[gk]
        m["delta"] = m["buy"] - m["sell"]
        cvd += m["delta"]
        m["cvd"] = cvd
        out.append(m)
    return out


def newest_bucket_ms(coin):
    """Epoch-ms start of the newest bucket held for `coin`, at ANY age.

    series() is window-scoped, so when a coin has prints but none inside the
    requested window it returns [] — which is indistinguishable from "this
    coin has never printed". That collapse is what let /api/flow answer a
    one-hour miss with the word "yet", i.e. report a WINDOW as an EPOCH.
    This reaches past the window so the caller can date the silence instead
    of guessing at it.

    IT ALSO REACHES PAST RETENTION, which it has to now that one exists for
    coins that stopped printing. When the sweep removes a coin's last row the
    rows are gone but the FACT that a bucket started at that ms is not, and it
    is carried by the tombstone (see GONE_KEY). Answering None there would
    have made /api/flow say "nothing has EVER been recorded for it" about a
    market this process itself collected and then aged out -- a missing value
    rendered as a confident fact, in the exact direction that matters.

    None now means: no rows are held, AND no retirement is remembered. That is
    "never collected" OR "retired longer than GONE_MAX retirements ago", and
    the two are not separable -- coin_history() names which case this answered
    from, and is the call to make when the difference matters.
    """
    with _LOCK:
        mins = _BUCKETS.get(coin) or {}
        hrs = _HOURLY.get(coin) or {}
        keys = list(mins) + list(hrs)
        if keys:
            return max(keys)
        rec = _GONE.get(coin) or {}
    return rec.get("ms")


def levels(coin, ms_from=None, ms_to=None, bucket_s=BUCKET_S,
           top_n=LEVELS_TOP_N):
    """[{ms, runs, lc, lm, rn, rb, rs}] oldest first -- the footprint ladder.

    lm = minute buckets the bar SPANS; lc = how many of them have stored
    levels. lc < lm is partial coverage and the pane must say so. lc == 0
    never happens here (a bar with no stored minute is simply absent from the
    list), and an ABSENT bar is not a bar that traded nothing -- the b/s
    series still carries its delta. That distinction is the whole point of
    shipping lc/lm rather than a bare list.

    rn/rb/rs describe the levels beyond top_n: how many, and their buy/sell
    notional. Omitted when nothing was cut. THEY ARE LOAD-BEARING: without
    them a truncated ladder claims that top_n levels are ALL the levels, which
    on a 1h chart would be a false statement on most bars.

    Aggregating minutes into a bar is EXACT, not approximate -- every minute
    sits on the identical tick grid and levels are additive, so this equals
    what a complete tape would produce for the bar, level for level.

    MEASURED on a 48h BTC-shaped store (2,880 minutes, 15,351 levels): 0.99 ms
    for the 300 1m bars a chart actually asks for, 3.1 ms at 5m/25h, 4.4 ms at
    15m/48h, 10.1 ms for the whole store at 1m (2,880 bars, 511 kB). Only
    0.031 ms of any of that is spent holding _LOCK -- the dict copy. It could
    hold the lock for the whole run and deliberately does not.
    """
    with _LOCK:
        src = _LEVELS.get(coin)
        snap = dict(src) if src else None
    if not snap:
        return []
    step = max(1, int(bucket_s // BUCKET_S)) * BUCKET_S * 1000
    bars, seen = {}, {}
    for ms, cells in snap.items():
        if ms_from is not None and ms < ms_from:
            continue
        if ms_to is not None and ms > ms_to:
            continue
        gk = (ms // step) * step
        agg = bars.get(gk)
        if agg is None:
            agg = bars[gk] = {}
            seen[gk] = 0
        seen[gk] += 1
        # Atomic under the GIL -- see _runs(). The minute in flight is being
        # written by the collector thread while this runs on an HTTP thread.
        for lk, v in list(cells.items()):
            cell = agg.get(lk)
            if cell is None:
                agg[lk] = [v[0], v[1]]
            else:
                cell[0] += v[0]
                cell[1] += v[1]
    lm = max(1, step // (BUCKET_S * 1000))
    out = []
    for gk in sorted(bars):
        agg = bars[gk]
        items = sorted(agg.items(), key=lambda kv: -(kv[1][0] + kv[1][1]))
        keep = items[:top_n] if (top_n and top_n > 0) else items
        row = {"ms": gk, "runs": _wire_runs(keep),
               "lc": seen.get(gk, 0), "lm": lm}
        rest = items[len(keep):]
        if rest:
            row["rn"] = len(rest)
            row["rb"] = _dollars(sum(v[0] for _, v in rest))
            row["rs"] = _dollars(sum(v[1] for _, v in rest))
        out.append(row)
    return out


def levels_span(coin):
    """(oldest_minute_ms, newest_minute_ms) of STORED levels for `coin`.

    (None, None) means no level is stored for it NOW -- either none was ever
    stored, or every one has aged out (this tier keeps RETAIN_H and, since the
    sweep, keeps it for coins that stopped printing too). Both cases must be
    rendered as "not measured", never as an empty ladder that looks like a
    measured absence of trading. The b/s series is unaffected and reaches
    further back; newest_bucket_ms()/coin_history() date the coin itself.
    """
    with _LOCK:
        lmap = _LEVELS.get(coin)
        keys = list(lmap) if lmap else []
    if not keys:
        return None, None
    return min(keys), max(keys)


def levels_meta():
    """Coverage of the footprint tier as a whole: what, from when, how coarse.

    `since_ms` is the oldest minute STORED (it can predate this process by up
    to the retention window); `began_ms` is when THIS process started
    recording. They are different claims and both are reported.
    """
    with _LOCK:
        vals = [b for b in _LEVELS.values() if b]
        coins = len(vals)
        minutes = sum(len(b) for b in vals)
        oldest = min((min(b) for b in vals), default=None)
        newest = max((max(b) for b in vals), default=None)
        err = dict(_LEVELS_ERR)
    return {"coins": coins, "minutes": minutes,
            "since_ms": oldest, "newest_ms": newest,
            "began_ms": int(_LEVELS_BEGAN[0]) or None,
            "bucket_s": BUCKET_S, "retain_h": RETAIN_H,
            "top_n": LEVELS_TOP_N, "save_every_s": SAVE_LEVELS_EVERY_S,
            "store": os.path.basename(STORE_LEVELS),
            "write_errors": err["n"],
            "last_write_error": err["last"] or None,
            "note": "per-price levels, %ds resolution, kept %dh. The buy/sell "
                    "buckets above go back further (%dd hourly) and are "
                    "unaffected by this tier."
                    % (BUCKET_S, RETAIN_H, RETAIN_HOURLY_D)}


def levels_selftest():
    """Pin the browser's own level identity. Returns a dict; no side effects.

    The sweep is 135,000 prices built as float("%de%d") so the doubles are
    bit-identical to the ones a JS parser produces, in the exponent-outer order
    the live browser used. THE THREE NUMBERS BELOW WERE READ OFF THE LIVE
    BROWSER, not derived here, which is what makes this a cross-language pin
    rather than a restatement of this file's own arithmetic: if app.js changes
    tickFor, or if anyone swaps math.floor(x + 0.5) for round(), fnv breaks.
    Python's banker's round() gives fnv 3773059233 / sumIdx 700291514.

    Also asserts the tick canonicalisation: m stays in 1..9, (m, k) maps to
    exactly 136 distinct ticks, and no two (m, k) collide on one tick float.
    """
    n = 0
    h = 2166136261
    tot = 0
    ticks = {}
    bad_m = 0
    for e in range(-8, 7):
        for i in range(1000, 10000):
            px = float("%de%d" % (i, e - 3))
            m, k, idx = _level_key(px)
            if not (1 <= m <= 9):
                bad_m += 1
            ticks.setdefault((m, k), set()).add(m * (10.0 ** k))
            h ^= idx
            h = (h * 16777619) & 0xffffffff
            tot += idx
            n += 1
    ok = (n == 135000 and h == 3477049142 and tot == 700245719
          and bad_m == 0 and len(ticks) == 136
          and not any(len(v) > 1 for v in ticks.values()))
    return {"ok": ok, "n": n, "fnv": h, "sum_idx": tot,
            "expect": {"n": 135000, "fnv": 3477049142,
                       "sum_idx": 700245719, "ticks": 136},
            "ticks": len(ticks), "m_out_of_range": bad_m,
            "tick_collisions": sum(1 for v in ticks.values() if len(v) > 1)}


def _liveness(subbed, last_coin, age, now):
    """Split subscription silence into DEAF vs NOT-TRADING. Returns a dict.

    This exists because the two look identical from the outside and are
    opposite facts. A deaf collector leaves every CVD, delta and aggressor-flow
    number on the terminal frozen at its last value while looking current; a
    quiet market IS current and simply is not trading. The 2026-08-14 wedge was
    invisible for 24 minutes precisely because nothing here distinguished them
    — `running` and a coin list were all a consumer had.

    The split is three-way, not two, because "never printed" is not "went
    quiet": a coin subscribed twenty seconds ago that has not printed yet has
    NOT been measured silent, and reporting it as quiet would be inventing an
    observation. Absent from `last_coin` means exactly that, and it is named.
    """
    if not subbed:
        return {"subs_live": None, "subs_quiet": None, "subs_never": None,
                "quiet_coins": None, "never_coins": None, "wedged": None,
                "wedge_note": "no trade subscriptions are open — subscription "
                              "liveness is NOT MEASURED, which is not the same "
                              "claim as measured silence"}
    if age is None:
        return {"subs_live": None, "subs_quiet": None, "subs_never": None,
                "quiet_coins": None, "never_coins": sorted(subbed),
                "wedged": None,
                "wedge_note": "no trade frame has arrived on this socket yet "
                              "(%d subscriptions open) — liveness is NOT "
                              "MEASURED, not measured silence" % len(subbed)}
    never = sorted(c for c in subbed if c not in last_coin)
    quiet = sorted(c for c in subbed
                   if c in last_coin and now - last_coin[c] > QUIET_S)
    live = len(subbed) - len(never) - len(quiet)
    wedged = age > WATCHDOG_S
    if wedged:
        note = ("DEAF: nothing has arrived on ANY of the %d open subscriptions "
                "for %.0fs. This is a collector fault, not a quiet market — "
                "every number derived from this tape is a stale reading, not a "
                "current one. The watchdog forces a reconnect at %ds."
                % (len(subbed), age, WATCHDOG_S))
    elif quiet or never:
        note = ("socket is ALIVE (last frame %.1fs ago); %d of %d coins "
                "printed within %ds, %d quiet, %d not yet heard from. A quiet "
                "coin here is a market that is not trading, NOT a dead "
                "collector — xyz equity markets sleep outside their session, "
                "and BTC itself recorded zero prints in 30 of 2,251 measured "
                "minutes." % (age, live, len(subbed), QUIET_S, len(quiet),
                              len(never)))
    else:
        note = ("socket is ALIVE and all %d subscribed coins printed within "
                "%ds (last frame %.1fs ago)" % (len(subbed), QUIET_S, age))
    return {"subs_live": live, "subs_quiet": len(quiet),
            "subs_never": len(never), "quiet_coins": quiet,
            "never_coins": never, "wedged": wedged, "wedge_note": note}


def status():
    with _LOCK:
        coins = {c: len(b) for c, b in _BUCKETS.items()}
        hourly = {c: len(b) for c, b in _HOURLY.items()}
        last_coin = dict(_LAST_COIN)
        wedge = dict(_WEDGE)
        rc = dict(_RECONNECT)
        dedup = dict(_DEDUP)
        sw = dict(_SWEEP_STAT)
        gone = {c: dict(v) for c, v in _GONE.items()}
        levels_coins = len(_LEVELS)
    subbed, pending = subscribed()
    now = time.time()
    age = round(now - _LAST_MSG["ts"], 1) if _LAST_MSG["ts"] else None
    running = _STARTED.is_set()
    live = _liveness(set(subbed), last_coin, age, now)
    # ONE WORD A CONSUMER CAN BRANCH ON. "running" alone could not distinguish
    # the three states that matter, and during the wedge it said false while
    # the pane went on drawing 60 subscriptions worth of frozen numbers.
    if running and live.get("wedged"):
        state = "deaf"          # transient: the watchdog is tearing it down
    elif running:
        state = "live"
    elif age is not None or wedge["at"]:
        state = "reconnecting"
    else:
        state = "starting"      # never connected on this process
    # Coverage is reported PER SLEEVE and never as one number. Core HL and xyz
    # have different shapes and different subscription histories, and a single
    # "26 coins" headline hid the fact that xyz was at zero of 109.
    try:
        from datasources import universe
        cov = universe.coverage(subbed, label="flow")
    except Exception as exc:
        cov = {"stale": True, "sleeves": {},
               "note": "sleeve coverage unavailable: %s" % str(exc)[:80]}
    # Most recently retired first, and capped for the wire -- retired_coins
    # above is the full count, this is a window onto it.
    retired_rows = {}
    for c in sorted(gone, key=lambda c: -(gone[c].get("at") or 0))[:20]:
        v = gone[c]
        retired_rows[c] = {
            "newest_ms": v.get("ms"),
            "retired_ago_s": round(max(0.0, now - v["at"]), 1)
            if v.get("at") else None}
    if isinstance(cov, dict):
        # Coverage describes which markets are SUBSCRIBED. That is not the same
        # claim as which markets are being COLLECTED, and while the socket is
        # down or deaf these shares describe an intent, not a measurement —
        # "96% of core HL 24h volume" read as a live fact throughout an outage
        # in which nothing at all was being recorded.
        cov = dict(cov)
        cov["collecting"] = bool(running and not live.get("wedged"))
        if not cov["collecting"]:
            cov["note"] = ("NOT COLLECTING (state=%s): these shares describe "
                           "the subscription set this collector will restore "
                           "on reconnect, not flow being recorded now. %s"
                           % (state, cov.get("note", "")))
    return {"running": running, "state": state, "coins": coins,
            "hourly_coins": len(hourly),
            "hourly_max_h": max(hourly.values()) if hourly else 0,
            "subscribed": len(subbed), "pending": pending,
            "max_subs": MAX_SUBS,
            # WHAT IS OPEN ON THE WIRE RIGHT NOW, so it is 0 when the socket is
            # not up. It used to be len(_SUBBED) unconditionally — but _SUBBED
            # is the RECOVERY set, which deliberately outlives a disconnect so
            # the next connect can restore it. Reported raw, that rendered the
            # wedge as `running: false, subs_open: 60`: sixty subscriptions
            # that existed nowhere but in this process's memory, shown as sixty
            # live ones. The intent is still reported, under a name that says
            # it is an intent.
            "subs_open": len(subbed) if running else 0,
            "subs_recover": len(subbed),
            "sub_note": "one `trades` subscription per coin on one socket; "
                        "the cap is a courtesy ceiling, HL allows 1000",
            "added_rest_req_s": 0.0,
            "coverage": cov,
            "last_msg_age_s": age,
            "stale_after_s": WATCHDOG_S,
            "recv_timeout_s": RECV_TIMEOUT_S,
            "wedge_reconnects": wedge["n"],
            "last_wedge_ago_s": round(now - wedge["at"], 1) if wedge["at"]
            else None,
            "last_wedge_silent_s": wedge["silent_s"],
            # EVERY reconnect, not just the watchdog's. The watchdog's are a
            # SUBSET; the remainder are the ordinary kind — dropped TCP, venue
            # restart, our own bounded-send timeout — and they were counted
            # nowhere at all, which is precisely why the replay-duplication
            # rate below has never been measurable. Clamped at 0 because the
            # watchdog increments _WEDGE at the raise while _RECONNECT only
            # moves once the NEXT connect succeeds, so across a reconnect the
            # two are briefly out of step by one.
            "reconnects": rc["n"],
            "reconnects_ordinary": max(0, rc["n"] - wedge["n"]),
            "last_reconnect_ago_s": round(now - rc["at"], 1) if rc["at"]
            else None,
            "dupes_dropped": dedup["dropped"],
            "dupes_no_tid": dedup["no_tid"],
            "dedup_ring": DEDUP_N,
            # The ring is PERSISTED now, so these say how much of it survived
            # the last restart and how much is currently on disk. restored_*
            # at 0 with a store present means the first connect's replay was
            # NOT deduped — the old behaviour — and must not be read as "no
            # duplication"; dupes_dropped is the number that says that.
            "dedup_persisted": True,
            "dedup_ring_restored_coins": dedup["ring_restored_coins"],
            "dedup_ring_restored_tids": dedup["ring_restored_tids"],
            "dedup_ring_saved_coins": dedup["ring_saved_coins"],
            "dedup_ring_saved_tids": dedup["ring_saved_tids"],
            "dedup_ring_unsaved": dedup["ring_unsaved"],
            "dupe_note": "HL replays ~30 prints per coin on every `trades` "
                         "subscribe (measured: BTC 30/9.5s, ETH 30/19.8s, "
                         "SOL 30/52.3s) and a reconnect resubscribes all of "
                         "them, so those prints reach _record() a second "
                         "time. dupes_dropped counts prints rejected because "
                         "that tid was already recorded: 0 here is measured "
                         "zero duplication since this process started, not an "
                         "unchecked path. The reject is on print identity, so "
                         "a replay that outlasts an outage still backfills "
                         "the gap instead of being discarded. The ring holds "
                         "the last %d keys per coin and is SAVED INSIDE "
                         "flow_buckets.json, in the same atomic write as the "
                         "buckets, so it now spans a restart too: the replay "
                         "on a process's FIRST connect is deduped against "
                         "what that store actually holds. Only integer tids "
                         "are persisted — the composite fallback key can "
                         "collide, and a collision surviving a restart would "
                         "drop a REAL print — so dedup_ring_unsaved is the "
                         "count left behind, not an assumed zero." % DEDUP_N,
            # The footprint tier reports its own coverage rather than
            # borrowing the b/s numbers above: it is shorter-lived (48h, no
            # hourly tier) and a consumer must be able to tell "no ladder
            # stored" from "no volume".
            "levels": levels_meta(),
            # RETENTION IS NOW A MEASURED THING, not an assumption. Before the
            # sweep existed, _trim/_trim_hourly/_trim_levels ran only from
            # _record(), so `retain_h` below described what happened to a coin
            # that kept printing and nothing at all about one that stopped --
            # the store held 68 coins against a MAX_SUBS of 60 and nothing
            # reported it. These are counters since process start; sweeps at 0
            # with a nonzero uptime means the sweep is not running, which is
            # not the same claim as "nothing needed dropping".
            "retention": {
                "sweeps": sw["n"],
                "sweep_every_s": SAVE_EVERY_S,
                "last_sweep_ms": sw["last_ms"],
                "max_sweep_ms": sw["max_ms"],
                # Clamped: a backwards clock step (NTP) must not render as a
                # sweep that happens in the future.
                "last_sweep_ago_s": round(max(0.0, now - sw["at"]), 1)
                if sw["at"] else None,
                "minute_rows_dropped": sw["minute_rows"],
                "hourly_rows_dropped": sw["hourly_rows"],
                "level_minutes_dropped": sw["level_minutes"],
                "dedup_rings_dropped": sw["rings"],
                "coins_minute_emptied": sw["coins_minute"],
                "coins_hourly_emptied": sw["coins_hourly"],
                "coins_levels_trimmed": sw["coins_levels"],
                "coins_minute": len(coins),
                "coins_hourly": len(hourly),
                "coins_levels": levels_coins,
                # Coins whose LAST row retention removed. They are not "never
                # collected" and must never be reported as such: the newest
                # bucket each one held is kept here and newest_bucket_ms()
                # answers from it. Capped at GONE_MAX, oldest evicted first.
                "retired_coins": len(gone),
                "retired_cap": GONE_MAX,
                "retired": retired_rows,
                "note": "minute and level tiers are dropped for a coin once "
                        "its NEWEST bucket is itself older than %dh (every "
                        "bucket it holds is then outside the window, so this "
                        "removes a strict subset of what a per-bucket cut "
                        "would); the hourly tier the same way at %dd, which "
                        "is its designed retention. A printing coin is "
                        "untouched by the sweep -- _record() still trims it "
                        "at ingest, by COUNT (%d buckets), which for a sparse "
                        "market legitimately spans more than %dh."
                        % (RETAIN_H, RETAIN_HOURLY_D, MAX_BUCKETS, RETAIN_H)},
            "bucket_s": BUCKET_S, "retain_h": RETAIN_H, **live}


def _abort(ws):
    """Drop the socket without a closing handshake. Never raises.

    A polite ws.close() is NOT safe here. websockets routes close() through
    send_context() -> drain() (asyncio/connection.py:915), and drain() parks on
    a future released only by resume_writing() or connection_lost(). Against a
    peer that has stopped reading, neither ever comes — so close() can hang
    exactly as hard as the wedge we are escaping, swallowing the watchdog's
    exception on the way out of the `try`. abort() forces connection_lost,
    which also releases every drain waiter. The cost is that the venue sees a
    TCP reset instead of a close frame, which is what close() falls back to
    after its own timeout anyway.
    """
    if ws is None:
        return
    try:
        ws.transport.abort()
    except Exception:
        pass


async def _subscribe(ws, want):
    """Subscribe to each coin in `want`. The caller leaves them in _PENDING;
    each moves to _SUBBED only once its frame is actually on the wire.

    DURABILITY IS THE POINT, and the old shape did not have it. It computed
    `want = set(coins) | _SUBBED | _PENDING`, CLEARED both sets, then sent in a
    loop. A send that raised part-way left every not-yet-sent coin in NEITHER
    set — and the next reconnect rebuilds its want-list from exactly those two
    sets, so a coin lost that way was never resubscribed and silently stopped
    collecting forever. That is precisely the failure the comment at that spot
    claimed to prevent. Ownership is transferred only on confirmation, so a
    raise anywhere leaves EVERY unconfirmed coin still owed, not just the one
    that failed. The running total `_SUBBED | _PENDING` never changes size
    across the handover, so ensure()'s MAX_SUBS accounting stays exact.

    Paced at venues.PACE_S — see SUB_PACE_S.
    """
    done = []
    try:
        for c in want:
            # BOUNDED send, for the same reason recv is bounded. This is the
            # 2026-08-14 wedge with the await moved one call down: a peer that
            # holds the socket open but stops READING parks ws.send() on a
            # drain waiter with no timeout, and the watchdog that exists to
            # escape that lives further down THIS coroutine — below the hung
            # await, so it can never run. A send is reached from two places
            # (the reconnect resubscribe and the per-tick pending drain), and
            # both are inside the recv loop's own coroutine. Time it out into
            # the same ConnectionError the watchdog raises, so it takes the
            # one abort -> save -> backoff -> resubscribe path.
            try:
                await asyncio.wait_for(
                    ws.send(json.dumps({
                        "method": "subscribe",
                        "subscription": {"type": "trades", "coin": c}})),
                    timeout=SEND_TIMEOUT_S)
            except asyncio.TimeoutError:
                raise ConnectionError(
                    "flow ws subscribe(%s) did not complete in %.0fs — the "
                    "peer has stopped reading" % (c, SEND_TIMEOUT_S))
            done.append(c)
            await asyncio.sleep(SUB_PACE_S)
    finally:
        # Runs on the raise path too: confirmed coins graduate, the rest stay
        # in _PENDING exactly as they were.
        with _LOCK:
            _SUBBED.update(done)
            _PENDING.difference_update(done)
    return len(done)


def _maybe_save(last_save):
    """Both tiers on their own cadences. Returns the new minute-save stamp.

    Called on EVERY tick, including the silent ones — under the old `async for`
    the saves could only run when a message arrived, so a socket that went
    quiet also stopped persisting the buckets it had already collected.
    """
    now = time.time()
    if now - last_save > SAVE_EVERY_S:
        # RETENTION FOR COINS THAT ARE NOT PRINTING RUNS HERE, immediately
        # before the write, and this pairing is the point rather than a
        # convenience: the sweep and the os.replace() that persists its result
        # are one act, so the store on disk can never hold rows this process
        # has already dropped, and no second cadence has to be reasoned about.
        # It is also the cheapest place it could sit: _save() is about to
        # take the same lock for a measured 23 ms to build its snapshot (614
        # ms for the whole write), against the sweep's measured 4.8-6.2 ms.
        # Never on the print path; see _sweep().
        _sweep(now)
        _save()
        last_save = now
    if now - _LAST_HOURLY_SAVE[0] > SAVE_HOURLY_EVERY_S:
        _save_hourly()
        _LAST_HOURLY_SAVE[0] = now
    # Third tier, its own cadence, and it cannot raise -- see _save_levels().
    if now - _LAST_LEVEL_SAVE[0] > SAVE_LEVELS_EVERY_S:
        _save_levels()
        _LAST_LEVEL_SAVE[0] = now
    return last_save


async def _run(coins):
    import websockets
    backoff = 1
    connects = 0
    while True:
        ws = None
        try:
            ws = await websockets.connect(WS_URL, ping_interval=20,
                                          ping_timeout=20, max_queue=None)
            connects += 1
            if connects > 1:
                # See _RECONNECT. This is the instant the whole subscription
                # set is about to go back on the wire, and therefore the
                # instant ~30 prints per coin are about to be replayed into
                # _record(). Counting it here is what makes the replay rate a
                # measurable number rather than an argument.
                with _LOCK:
                    _RECONNECT["n"] += 1
                    _RECONNECT["at"] = time.time()
            try:
                # Re-subscribing on reconnect must include everything asked
                # for while the previous socket was up, or a coin silently
                # stops collecting after any network blip. Everything starts
                # OWED (in _PENDING) and is promoted by _subscribe as each
                # frame goes out, so a failure part-way through leaves the
                # remainder recoverable instead of stranded between the sets.
                with _LOCK:
                    want = sorted(set(coins) | _SUBBED | _PENDING)
                    _SUBBED.clear()
                    _PENDING.clear()
                    _PENDING.update(want)
                await _subscribe(ws, want)
                # BACKOFF IS RESET BY DATA, NOT BY AN ACK — see below. This
                # used to be `backoff = 1` and a subscribe ack is not evidence
                # the peer will ever speak: a socket that connects, accepts
                # every subscribe frame and then says nothing takes the
                # watchdog path, sleeps 1s, reconnects, subscribes, resets to
                # 1 and repeats forever. min(backoff*2, 60) could therefore
                # never exceed 2, so a PERMANENTLY dead peer was reconnect-
                # hammered at ~1Hz and looked exactly like a flapping one in
                # every log and in status(). The reset now happens where the
                # first frame is handled.
                _STARTED.set()
                last_save = time.time()
                # The watchdog clock starts when the subscription set is fully
                # on the wire, never at connect: the paced subscribe alone
                # takes ~9s at 60 coins, and no print can arrive for a coin
                # that has not been asked for yet. Starting it at connect would
                # let the watchdog fire on its own subscribe phase.
                last_rx = time.time()
                while True:
                    # BOUNDED recv, not `async for`. The unbounded form IS the
                    # wedge: a peer that holds the socket open and sends
                    # nothing parks this coroutine forever with no exception to
                    # catch. The timeout is not an error path — it is the tick
                    # that lets the watchdog, the pending drain and the
                    # periodic saves keep running while the socket is silent.
                    # Cancelling recv() this way is safe by design: websockets'
                    # Assembler.get() resets get_in_progress in a finally and
                    # pushes any partial frames back onto its queue.
                    try:
                        raw = await asyncio.wait_for(ws.recv(),
                                                     timeout=RECV_TIMEOUT_S)
                    except asyncio.TimeoutError:
                        raw = None
                    now = time.time()
                    if raw is None:
                        silent = now - last_rx
                        if silent > WATCHDOG_S:
                            with _LOCK:
                                n_subs = len(_SUBBED)
                                _WEDGE["n"] += 1
                                _WEDGE["at"] = now
                                _WEDGE["silent_s"] = round(silent, 1)
                            # Raise into the reconnect path rather than
                            # reconnecting here, so a wedge takes exactly the
                            # same save-then-backoff-then-resubscribe route as
                            # a dropped connection. One recovery path, not two.
                            raise ConnectionError(
                                "flow ws silent across all %d subscriptions "
                                "for %.0fs" % (n_subs, silent))
                    else:
                        last_rx = now
                        _LAST_MSG["ts"] = now
                        # The backoff reset used to live here, on ANY frame.
                        # That included the subscriptionResponse acks this
                        # coroutine itself provoked, which is exactly the ack
                        # the comment 40 lines up forbids resetting on: a peer
                        # that accepts every subscribe and then says nothing
                        # gets connect -> N acks -> reset to 1 -> silence ->
                        # watchdog -> sleep(1) -> reconnect, forever, so
                        # min(backoff*2, 60) can never exceed 2. Moved below,
                        # where the frame has been parsed and an ack can be
                        # told apart from evidence the peer will actually
                        # speak. last_rx still moves on any frame — that is
                        # the WATCHDOG's clock, and it must not fire during
                        # our own paced subscribe.
                    # Drain on-demand subscribes on EVERY tick, message or not.
                    # Under `async for` this ran only when a frame arrived, so
                    # ensure() on a quiet socket took effect only if some OTHER
                    # market happened to trade first — the case where charting
                    # a new market matters most is exactly the case it did not
                    # work.
                    with _LOCK:
                        newly = sorted(_PENDING)
                    if newly:
                        await _subscribe(ws, newly)
                    if raw is not None:
                        try:
                            msg = json.loads(raw)
                        except ValueError:
                            msg = None
                        # THE EVIDENCE THE PEER IS ALIVE, and it is everything
                        # EXCEPT the ack for a subscribe we just sent. Trades,
                        # pongs, an unparseable frame — all of them are the
                        # endpoint volunteering something, which is the claim
                        # being tested ("this endpoint talks"), and a quiet
                        # market must never read as a dead peer.
                        if msg is None or msg.get("channel") != "subscriptionResponse":
                            backoff = 1
                        if msg is not None and msg.get("channel") == "trades":
                            by_coin = {}
                            for t in (msg.get("data") or []):
                                by_coin.setdefault(t.get("coin"), []).append(t)
                            for c, ts in by_coin.items():
                                if c:
                                    _record(c, ts)
                    last_save = _maybe_save(last_save)
            finally:
                # Before ANY exception leaves this block — including the
                # watchdog's. See _abort(): a polite close on a wedged socket
                # can block forever and would re-create the outage one level up.
                _abort(ws)
        except Exception:
            _STARTED.clear()
            _save()
            # Bounds the level tier's exposure to the 300s save cadence: only
            # a SIGKILL or a power loss can now cost more than one save
            # interval of levels. Cannot raise -- see _save_levels().
            _save_levels()
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)


def start(coins):
    """Launch the collector on its own loop in a daemon thread."""
    global _BUCKETS, _HOURLY, _LEVELS
    _BUCKETS, _HOURLY, seen_raw = _load()
    # BEFORE the socket can deliver its first replay. The ring was written
    # inside the same atomic store write as _BUCKETS, so restoring it here
    # makes the two consistent again at exactly the instant they were saved --
    # see SEEN_KEY. Never raises; a corrupt ring costs one restart's worth of
    # replay dedup and nothing else.
    _seen_restore(seen_raw)
    # Levels load AFTER the buckets and are filtered to their key set, so a
    # stale or partial level file can never claim a minute the b/s tier does
    # not hold. A corrupt one returns {} and costs the ladder only.
    _LEVELS = _load_levels(_BUCKETS)
    # AFTER both loads and before anything is written or reported. _load()'s
    # boundary-hour guard keys off `oldest = min(rows)` of the minute tier as
    # it came off disk, so sweeping earlier would move that anchor forward and
    # hand the recompute exactly the partly-covered hours the guard exists to
    # protect. Sweeping here also means _save_hourly() below writes the pruned
    # tier, and status() never reports a coin the store should not be holding.
    # The ring is deliberately untouched at this point -- _sweep() skips ring
    # pruning while the subscription set is still unknown.
    _sweep()
    _save_hourly()
    _LAST_HOURLY_SAVE[0] = time.time()
    _LAST_LEVEL_SAVE[0] = time.time()
    _LEVELS_BEGAN[0] = time.time() * 1000.0

    def _thread():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(_run(list(coins)))
        except Exception:
            pass

    threading.Thread(target=_thread, daemon=True, name="flow-collector").start()
