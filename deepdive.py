"""Deep-dive layer: TradingAgents workups behind the RESEARCH tab.

The scanner pipeline is shallow and wide (48 names every 30 min). This is the
opposite: one name, twelve agents, ~9 minutes. It never runs inline -- the
endpoint queues, a worker drains, the UI polls.

Two hard rules:
  * equity_intel.db is opened query_only, exactly as research.py does. Every
    write from this module lands in its own deepdive.db.
  * No verdict is ever presented as validated. Each one carries UNVALIDATED
    plus the live scored-outcome count, in the same convention the SIGNALS tab
    uses for its edge registry.

Gates before a run is allowed (both learned the hard way):
  * EARNINGS -- a live run shorted MSFT twice into a +12% earnings gap while
    the news feed said "Reports Q2 Results Tomorrow". The framework has no
    earnings awareness; catalyst_calendar does.
  * STALE DATE -- yfinance serves ~7 days of news. Older dates produce a
    confident report written on an empty feed.
"""

import json
import os
import sqlite3
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

EQUITY_DB = os.path.expanduser("~/.hermes/trading_system/equity/equity_intel.db")
DEEPDIVE_DB = os.path.expanduser("~/.hermes/terminal/data/deepdive.db")

NEWS_HORIZON_DAYS = 7      # yfinance news depth, measured
EARNINGS_WINDOW_DAYS = 10  # matches the 10d scoring horizon

# --- LEASES, NOT A FLAG ----------------------------------------------------
# THE OUTAGE THIS BLOCK EXISTS FOR. claim_next() used to set state='running'
# and nothing else. finish() was the only writer that ever cleared it, so any
# worker that died between the two left the row 'running' FOREVER and the
# RESEARCH pane rendered it as a live workup. Measured 2026-08-19 on this very
# table: queue ids 4 and 6 (HYPE-USD) had been 'running' since 2026-08-18
# 20:11:11 and 20:23:35 — 11.6 hours — while id 25 had already completed at
# 07:35:24 the next morning. Both were orphaned by a WORKER RESTART (the code
# files were edited at 20:25-20:26 and the loop was relaunched), which is the
# recurring cause: one orphan per restart or crash, accumulating silently.
#
# A lease fixes what a flag cannot: the worker must keep SAYING it is alive,
# so silence is diagnostic instead of ambiguous. Same shape as the flow
# collector's data-staleness watchdog — bound the wait, then make the wedge
# visible rather than trusting a liveness signal that cannot fail loudly.
#
# RUN_BUDGET_S — how long one workup may take before it is declared hung.
# Sized off the 22 runs this table has actually COMPLETED (started_at ->
# finished_at, measured 2026-08-19):
#     min 271s (4.5m) · median 447s (7.5m) · mean 507s · max 1826s (30.4m)
#   21 of 22 finished inside 558s (9.3m), which is what the UI's "~9 min"
#   claim is built on. The lone 1826s run is queue id 7, the first HYPE-USD
#   technical-only run right after the Hyperliquid vendor was wired in — a
#   real completed run, so the budget must clear it or it would kill honest
#   work. 2700s is 1.48x that slowest real run, 6.0x the median, and 1/15th
#   of the 11.6h wedge it replaces. A false trip costs one re-run (~8 min);
#   a missed one costs a workup that looks live for half a day.
# 2700s (45m) killed the 2026-08-26 equity batch (NVDA/AAPL/TSLA/META/MSFT)
# at the advertised ceiling while ETH/SOL/HYPE finished in 11-16m. Equity
# workups run the fundamentals analyst; 90m clears a slow but live one.
RUN_BUDGET_S = 5400
# LEASE_TTL_S — how long a row stays credible after its last heartbeat. This
# is NOT the run budget: a healthy 45-minute run renews every HEARTBEAT_S and
# never expires. This bounds only "the worker went away", which is the restart
# case above. 300s = 10 consecutive missed heartbeats, and matches the flow
# collector's WATCHDOG_S choice to bound blindness at ~5 minutes.
LEASE_TTL_S = 300
HEARTBEAT_S = 30           # renewal cadence; TTL is 10x this on purpose

# --- THE ROWS A LEASE CAN NEVER JUDGE --------------------------------------
# A lease only bounds workers that ever TOOK one. Measured on this table
# 2026-08-20: 0 of 37 rows carry lease_until, heartbeat_at, deadline_at or
# worker_pid — not just the two known zombies. The worker process draining this
# queue (pid 99905) started 2026-08-18 20:26:23, BEFORE the lease code was
# written, so it holds the pre-lease module in memory and has never stamped a
# lease on anything, including the nine jobs it ran this morning. Lease expiry
# therefore matches nothing on disk today, and rows 4 and 6 have read RUNNING
# for 35 hours for want of a rule that does not depend on being stamped.
#
# So the reaper needs a second, lease-independent test: this claim is older
# than any run this queue has ever COMPLETED, and nothing is renewing it.
#
# ABANDON_SLACK is the margin over the slowest completed run. 1.5x, so a run
# that is merely unusual survives and only one 50% worse than the worst real
# one is declared dead. A false trip costs one re-run (~8 min); a missed one
# costs a workup that reads RUNNING for a day and a half.
ABANDON_SLACK = 1.5
# Below this many completed runs the distribution is not a distribution: fall
# back to the run budget and SAY the basis was a fallback. An unmeasured
# threshold must never be presented as a measured one.
ABANDON_MIN_SAMPLE = 5
# Last-resort basis only: a row marked 'running' with no started_at at all.
# claim_next() cannot produce one, but a half-written row or a future writer
# could, and today such a row is UNJUDGEABLE FOREVER — it renders RUNNING and
# no rule ever touches it. Its age can only be measured from queued_at, which
# includes queue WAIT: measured on this table, the longest wait between
# queued_at and started_at is 3862s (1h 04m, queue id 16 — the daily batch
# queues 9 jobs at once and they drain serially). 7200s is 1.9x that, ADDED to
# the run threshold so the two clocks are never blurred into one.
QUEUE_WAIT_CEILING_S = 7200

SCHEMA = """
CREATE TABLE IF NOT EXISTS deepdive_queue (
    id          INTEGER PRIMARY KEY,
    symbol      TEXT NOT NULL,
    as_of       TEXT NOT NULL,
    -- queued|running|done|failed|blocked|abandoned
    -- 'abandoned' is terminal and means "no worker is on this any more", NOT
    -- "the analysis said nothing". Never recycle it back to 'queued': a silent
    -- requeue is exactly how the 11h wedge stayed invisible.
    state       TEXT NOT NULL DEFAULT 'queued',
    reason      TEXT,
    queued_at   TEXT NOT NULL,
    started_at  TEXT,
    finished_at TEXT,
    UNIQUE (symbol, as_of, queued_at)
);
CREATE TABLE IF NOT EXISTS deepdive_verdict (
    id           INTEGER PRIMARY KEY,
    queue_id     INTEGER REFERENCES deepdive_queue(id),
    symbol       TEXT NOT NULL,
    as_of        TEXT NOT NULL,
    action       TEXT,           -- BUY|SELL|HOLD|UNKNOWN
    rating       TEXT,           -- raw model wording
    entry        REAL,
    stop         REAL,
    target       REAL,
    horizon      TEXT,
    thesis       TEXT,
    reports_dir  TEXT,
    elapsed_s    REAL,
    model_deep   TEXT,
    model_quick  TEXT,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verdict_sym ON deepdive_verdict(symbol, created_at DESC);

-- THE HOLE THIS TABLE FILLS. deepdive_verdict has carried action/entry/stop/
-- target/horizon since the first run and NOTHING ever recorded what happened
-- next: 31 verdicts, 0 outcomes. That is the equity book's failure exactly --
-- 180 decisions, 0 rows in `outcomes`, because its only outcome writer was a
-- manual CLI nothing called. deepdive_score.score_due() runs from the WORKER
-- LOOP so this table fills itself; the CLI is the override, not the only door.
--
-- `status` is four-valued and every boundary is the whole point:
--   scored      TERMINAL. A judgement exists (target|stop|ambiguous|timeout|
--               no_fill). `resolution` says which.
--   open        NOT terminal. The call is still live and was deliberately NOT
--               graded early.
--   deferred    NOT terminal. The price source was unreachable; this says
--               nothing about the call and is retried on the next pass. A
--               rate limit must never be able to condemn a verdict.
--   unscorable  it can never be graded and `reason` says exactly why. This is
--               a MEASUREMENT, not a gap: "we looked and this cannot be
--               judged" must never read the same as "we never looked".
-- `ambiguous` = 1 means target and stop both traded inside the finest bar
-- obtainable and which came first is unknowable. result_pct/result_r stay NULL
-- there on purpose -- an invented winner is worse than an honest unknown.
CREATE TABLE IF NOT EXISTS deepdive_outcome (
    id            INTEGER PRIMARY KEY,
    verdict_id    INTEGER NOT NULL UNIQUE REFERENCES deepdive_verdict(id),
    symbol        TEXT NOT NULL,
    as_of         TEXT NOT NULL,
    action        TEXT,
    status        TEXT NOT NULL,   -- scored|open|unscorable
    resolution    TEXT,            -- target|stop|ambiguous|timeout|no_fill
    reason        TEXT,
    direction     TEXT,            -- long|short
    entry_used    REAL,
    entry_source  TEXT,
    fill_px       REAL,
    fill_at       TEXT,
    stop_used     REAL,
    target_used   REAL,
    ref_px        REAL,
    horizon_days  INTEGER,
    horizon_basis TEXT,
    window_start  TEXT,
    window_end    TEXT,
    horizon_elapsed INTEGER,
    px_source     TEXT,            -- which venue/instrument actually priced it
    px_note       TEXT,            -- e.g. "xyz:NVDA is a PERP, not the cash tape"
    px_interval   TEXT,            -- finest interval the resolution rested on
    bars_n        INTEGER,
    exit_px       REAL,
    exit_at       TEXT,
    result_pct    REAL,
    result_r      REAL,
    mfe_pct       REAL,
    mae_pct       REAL,
    ambiguous     INTEGER DEFAULT 0,
    scored_basis  TEXT,            -- resolution|horizon_elapsed
    scored_at     TEXT,
    scorer_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_outcome_status ON deepdive_outcome(status);

-- Scheduler bookkeeping (last_score_at). A file would have done, but the
-- throttle has to survive next to the rows it throttles.
CREATE TABLE IF NOT EXISTS deepdive_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT
);
"""


def _conn():
    """Writable handle on our own database. Never the pipeline's."""
    os.makedirs(os.path.dirname(DEEPDIVE_DB), exist_ok=True)
    conn = sqlite3.connect(DEEPDIVE_DB, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    # Added after the first HYPE run: a verdict must record WHICH analysts
    # produced it, so a technical-only read is never mistaken for a full one.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(deepdive_verdict)")}
    if "analysts" not in cols:
        conn.execute("ALTER TABLE deepdive_verdict ADD COLUMN analysts TEXT")
    # Lease columns, added with the reaper. Rows claimed BEFORE this migration
    # carry NULL here and never had a heartbeat at all -- lease_state() reads
    # that as "not measured" and falls back to started_at, rather than treating
    # a missing lease as an expired one.
    qcols = {r[1] for r in conn.execute("PRAGMA table_info(deepdive_queue)")}
    for name, decl in (("lease_until", "TEXT"), ("heartbeat_at", "TEXT"),
                       ("deadline_at", "TEXT"), ("worker_pid", "INTEGER")):
        if name not in qcols:
            conn.execute(f"ALTER TABLE deepdive_queue ADD COLUMN {name} {decl}")
    # Report-deletion bookkeeping. A verdict whose reports have been pruned
    # gets reports_dir=NULL plus a sentence saying they were removed and when.
    # NULL alone would read as "this run never wrote any" -- the same missing/
    # measured-zero collapse the lease columns exist to avoid, in the other
    # direction. The OUTCOME row is never touched by a prune: dropping the
    # bulk while keeping the lesson is the entire point.
    for name, decl in (("reports_deleted_at", "TEXT"), ("reports_note", "TEXT")):
        if name not in cols:
            conn.execute(f"ALTER TABLE deepdive_verdict ADD COLUMN {name} {decl}")
    return conn


def _equity_conn():
    """Read-only handle on the pipeline DB, same approach as research.py."""
    conn = sqlite3.connect(EQUITY_DB, timeout=5)
    conn.execute("PRAGMA query_only=ON")
    conn.row_factory = sqlite3.Row
    return conn


def _utcnow():
    """Aware UTC datetime. The only clock used for comparisons and new stamps."""
    return datetime.now(timezone.utc)


def _as_utc(value):
    """datetime or ISO string -> aware UTC, or None. Never raises.

    Naive values are Asia/Calcutta wall times: rows written before this helper
    (and claim_next/heartbeat until it) stored naive local IST. Treating those
    as UTC would shift every lease and score interval by 5.5h. The TypeError
    "can't subtract offset-naive and offset-aware datetimes" is what this
    exists to make impossible — both sides of every compare go through here.
    """
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value)
        except (TypeError, ValueError):
            return None
    else:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo("Asia/Calcutta"))
    return dt.astimezone(timezone.utc)


def _now(dt=None):
    """ISO-8601 UTC string for storage. Always timezone-aware (+00:00)."""
    stamp = _as_utc(dt) if dt is not None else _utcnow()
    return stamp.isoformat(timespec="seconds")


def _parse(ts):
    """ISO string (or datetime) -> aware UTC datetime, or None. Never raises.

    Rows written before 2026-08-27 were naive local IST wall times.
    """
    return _as_utc(ts)


def _age_s(ts, now=None):
    """Seconds since `ts`, or None when `ts` is absent/unparseable.

    None means NOT MEASURED. It must never be rendered as 0.
    """
    dt = _parse(ts)
    if dt is None:
        return None
    now_dt = _as_utc(now) if now is not None else _utcnow()
    if now_dt is None:
        return None
    return round((now_dt - dt).total_seconds(), 1)


def human_age(secs):
    """'11h 24m' / '7m 30s' / '45s'. Returns None when secs is None."""
    if secs is None:
        return None
    secs = int(max(0, secs))
    if secs < 60:
        return f"{secs}s"
    if secs < 3600:
        return f"{secs // 60}m {secs % 60:02d}s"
    return f"{secs // 3600}h {(secs % 3600) // 60:02d}m"


def _completed_durations(conn):
    """started_at -> finished_at seconds for every run this queue COMPLETED.

    Sorted ascending. Rows with a finished_at that precedes started_at are
    dropped rather than clamped to zero: queue id 4 carries exactly that
    (finished 19:47:56 against started 20:11:11, the old finish(id,'queued')
    deferral bug), and a negative duration is a corrupt measurement, not a
    fast run.
    """
    try:
        rows = conn.execute(
            "SELECT (julianday(finished_at) - julianday(started_at)) * 86400.0 AS d "
            "FROM deepdive_queue WHERE state='done' AND started_at IS NOT NULL "
            "AND finished_at IS NOT NULL AND finished_at > started_at").fetchall()
    except sqlite3.Error:
        return []
    # r[0], not r["d"]: positional indexing works on a bare tuple as well as on
    # the sqlite3.Row this module's own connections hand back, so a caller that
    # passes a plainly-configured connection gets numbers rather than a
    # TypeError from inside the threshold calculation.
    return sorted(round(r[0], 1) for r in rows if r[0] and r[0] > 0)


def abandon_threshold_s(conn=None):
    """(seconds, basis) past which an UNLEASED claim is abandoned on any reading.

    Derived from this queue's own completed runs rather than picked, and it
    returns the basis alongside the number so every caller — reaper, API,
    log line — can state WHY it is that long instead of asserting it.
    """
    own = conn is None
    conn = conn or _conn()
    try:
        durations = _completed_durations(conn)
    finally:
        if own:
            conn.close()

    if len(durations) < ABANDON_MIN_SAMPLE:
        return RUN_BUDGET_S, (
            f"FALLBACK, not a measurement: only {len(durations)} completed "
            f"run{'s' if len(durations) != 1 else ''} on record, fewer than the "
            f"{ABANDON_MIN_SAMPLE} needed to read a distribution — using the "
            f"{human_age(RUN_BUDGET_S)} run budget")

    slowest = durations[-1]
    median = durations[len(durations) // 2]
    thr = max(RUN_BUDGET_S, int(round(slowest * ABANDON_SLACK)))
    floored = thr == RUN_BUDGET_S and slowest * ABANDON_SLACK < RUN_BUDGET_S
    return thr, (
        f"{len(durations)} completed runs on this queue: median "
        f"{human_age(median)}, slowest {human_age(slowest)}; "
        f"{ABANDON_SLACK}x the slowest"
        + (f", floored at the {human_age(RUN_BUDGET_S)} run budget"
           if floored else "")
        + f" = {human_age(thr)}")


def _pid_alive(pid):
    """True / False / None for a recorded worker pid. None means NOT MEASURED.

    Reported as EVIDENCE, never used as the reap trigger. Pids are recycled, so
    True here means "a process with that id exists", not "our worker is alive";
    and a row whose pid is gone is already caught by its clock. A row is judged
    on time, and this only tells the reader what the process table said.
    """
    if pid in (None, ""):
        return None
    try:
        os.kill(int(pid), 0)
        return True
    except (ProcessLookupError, ValueError, TypeError):
        return False
    except PermissionError:
        return True         # exists, owned by another user
    except OSError:
        return None


def lease_state(row, now=None, threshold_s=None):
    """Derive the TRUTH about a 'running' row. Pure read -- writes nothing.

    Returned separately from the stored `state` on purpose: /api/deepdive is a
    GET and must not mutate the queue, but the pane still has to stop drawing a
    dead run as RUNNING. The reaper (worker-side) persists the same verdict.

    `expired` is None -- not False -- for any row this cannot judge, so "no
    lease measurement" never reads as "lease is fine".

    Three bases, in falling order of directness. Every one of them is named in
    `lease_basis`, because "expired" derived from a heartbeat and "expired"
    derived from a claim timestamp are not the same claim about the world.
      heartbeat   the worker stopped renewing            (leased rows)
      started_at  the claim outlived any run ever seen   (never-leased rows)
      queued_at   'running' with no claim time at all    (last resort)
    """
    now = _as_utc(now) if now is not None else _utcnow()
    out = {"age_s": None, "heartbeat_age_s": None, "expired": None,
           "over_budget": None, "lease_basis": None,
           "worker_alive": None, "abandon_threshold_s": None}
    if (row.get("state") if isinstance(row, dict) else row["state"]) != "running":
        return out

    get = row.get if isinstance(row, dict) else (lambda k, d=None: row[k])
    started, lease_until = get("started_at"), get("lease_until")
    out["age_s"] = _age_s(started, now)
    out["heartbeat_age_s"] = _age_s(get("heartbeat_at"), now)
    out["worker_alive"] = _pid_alive(get("worker_pid"))
    if threshold_s is None:
        threshold_s = abandon_threshold_s()[0]
    out["abandon_threshold_s"] = threshold_s

    lease_dt = _parse(lease_until)
    if lease_dt is not None:
        out["lease_basis"] = "heartbeat"
        out["expired"] = now > lease_dt
    elif _parse(started) is not None:
        # Claimed before leases existed (or by an older worker binary). There is
        # NO heartbeat measurement for this row -- say so -- but a claim older
        # than any run this queue has ever completed is abandoned on any reading.
        out["lease_basis"] = ("started_at (never leased — no heartbeat was ever "
                              "recorded on this row)")
        out["expired"] = out["age_s"] > threshold_s
    else:
        # 'running' with no started_at: neither a lease nor a claim time. The
        # only clock left is queued_at, which NOT NULL guarantees. Without this
        # branch such a row is unjudgeable forever and renders RUNNING forever
        # -- the exact failure this whole module exists to end.
        q_age = _age_s(get("queued_at"), now)
        if q_age is not None:
            out["lease_basis"] = ("queued_at (row says running with no claim "
                                  "time; age includes queue wait)")
            out["expired"] = q_age > threshold_s + QUEUE_WAIT_CEILING_S
        # else: not one usable timestamp -> expired stays None, unknowable.

    if out["age_s"] is not None:
        out["over_budget"] = out["age_s"] > RUN_BUDGET_S
    return out


def upcoming_catalyst(symbol, as_of, window=EARNINGS_WINDOW_DAYS):
    """Nearest catalyst inside the scoring horizon, or None."""
    if not os.path.exists(EQUITY_DB):
        return None
    base = symbol.split(":")[-1].upper()
    end = (date.fromisoformat(as_of) + timedelta(days=window)).isoformat()
    conn = _equity_conn()
    try:
        row = conn.execute(
            "SELECT event_type, event_date FROM catalyst_calendar "
            "WHERE base_symbol = ? AND date(event_date) BETWEEN date(?) AND date(?) "
            "ORDER BY event_date LIMIT 1",
            (base, as_of, end),
        ).fetchone()
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    if not row:
        return None
    days = (date.fromisoformat(row["event_date"]) - date.fromisoformat(as_of)).days
    return {"type": row["event_type"], "date": row["event_date"], "days_away": days}


def gate(symbol, as_of=None):
    """Decide whether a deep dive is worth running. Returns a dict the UI renders.

    `allowed` False means refuse. `warnings` means run, but stamp the card.
    """
    as_of = as_of or date.today().isoformat()
    blocks, warns = [], []

    age = (date.today() - date.fromisoformat(as_of)).days
    if age > NEWS_HORIZON_DAYS:
        blocks.append(
            f"news feed serves ~{NEWS_HORIZON_DAYS}d; {as_of} is {age}d old, so the "
            f"news analyst would run on an empty feed"
        )

    cat = upcoming_catalyst(symbol, as_of)
    if cat:
        warns.append(
            f"{cat['type']} on {cat['date']} ({cat['days_away']}d away) — the "
            f"framework has no earnings awareness; treat any short with suspicion"
        )

    return {
        "symbol": symbol.split(":")[-1].upper(),
        "as_of": as_of,
        "allowed": not blocks,
        "blocks": blocks,
        "warnings": warns,
        "catalyst": cat,
    }


def enqueue(symbol, as_of=None):
    """Queue a run if the gates allow. Returns the queue row as a dict."""
    g = gate(symbol, as_of)
    conn = _conn()
    try:
        cur = conn.execute(
            "INSERT INTO deepdive_queue (symbol, as_of, state, reason, queued_at) "
            "VALUES (?,?,?,?,?)",
            (g["symbol"], g["as_of"],
             "queued" if g["allowed"] else "blocked",
             "; ".join(g["blocks"]) or None, _now()),
        )
        conn.commit()
        g["queue_id"] = cur.lastrowid
        g["state"] = "queued" if g["allowed"] else "blocked"
        return g
    finally:
        conn.close()


def claim_next():
    """Worker: take the oldest queued job, under a LEASE. Returns dict or None.

    The lease -- not the 'running' flag -- is what makes an abandoned row
    recognisable. heartbeat() renews it; reap() collects what stops renewing.
    """
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT * FROM deepdive_queue WHERE state='queued' ORDER BY id LIMIT 1"
        ).fetchone()
        if not row:
            return None
        now = _utcnow()
        conn.execute(
            "UPDATE deepdive_queue SET state='running', started_at=?, "
            "heartbeat_at=?, lease_until=?, deadline_at=?, worker_pid=?, "
            "finished_at=NULL WHERE id=?",
            (_now(now), _now(now),
             _now(now + timedelta(seconds=LEASE_TTL_S)),
             _now(now + timedelta(seconds=RUN_BUDGET_S)),
             os.getpid(), row["id"]),
        )
        conn.commit()
        return dict(row)
    finally:
        conn.close()


def heartbeat(queue_id):
    """Worker: renew the lease on a job in flight.

    Returns False when the row is no longer ours -- reaped, or finished by
    something else. The caller must treat that as "you lost this job", not as a
    transient blip: continuing to write a verdict for a reaped row would put a
    result under a row that already told the glass it was abandoned.
    """
    conn = _conn()
    try:
        now = _utcnow()
        cur = conn.execute(
            "UPDATE deepdive_queue SET heartbeat_at=?, lease_until=? "
            "WHERE id=? AND state='running'",
            (_now(now),
             _now(now + timedelta(seconds=LEASE_TTL_S)),
             queue_id),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def defer(queue_id, reason=None):
    """Worker: hand a claimed job back to the queue without pretending it ran.

    finish(id, 'queued') used to do this, which stamped finished_at on a job
    that had not finished -- queue id 4 still carries finished_at
    2026-08-18T19:47:56 against started_at 2026-08-18T20:11:11, a row that
    reads as having finished 23 minutes before it started. A deferral clears
    the claim instead of recording a false one.
    """
    conn = _conn()
    try:
        conn.execute(
            "UPDATE deepdive_queue SET state='queued', reason=?, started_at=NULL, "
            "finished_at=NULL, heartbeat_at=NULL, lease_until=NULL, "
            "deadline_at=NULL, worker_pid=NULL WHERE id=?",
            (reason, queue_id))
        conn.commit()
    finally:
        conn.close()


def _reap_reason(ls, row, threshold, basis):
    """The sentence stored on an abandoned row. Says which clock judged it.

    The VERB tracks the clock. "claimed 35h ago" is a statement about
    started_at; a row that has no started_at has not been shown to have been
    claimed at all, and borrowing the word for its queued_at age would be a
    precision the measurement does not have.
    """
    if ls["age_s"] is not None:
        age = f"claimed {human_age(ls['age_s'])} ago"
    else:
        q_age = human_age(_age_s(row.get("queued_at")))
        age = (f"marked running with no claim time, queued {q_age} ago"
               if q_age else "running for an unmeasured time")
    hb = human_age(ls["heartbeat_age_s"])
    pid = row.get("worker_pid")
    if ls["worker_alive"] is None:
        pid_note = "; no worker pid was ever recorded on it"
    elif ls["worker_alive"] is False:
        pid_note = f"; worker pid {pid} is gone from the process table"
    else:
        pid_note = (f"; pid {pid} still exists, which pid reuse means is not "
                    f"proof of life")
    # No "abandoned —" prefix: the state column already carries that word, and
    # both the pane and the log print state + reason, so a prefix here rendered
    # as "ABANDONED — abandoned — ...".
    return (
        f"worker died or hung; {age}, past the "
        f"{human_age(threshold)} abandonment threshold "
        f"[{ls['lease_basis']}; threshold from {basis}], "
        + (f"last heartbeat {hb} ago" if hb else
           "and no heartbeat was ever recorded on it")
        + pid_note
    )


def reap(apply=True, now=None, ids=None):
    """Collect rows whose claim has gone dead into a terminal 'abandoned' state.

    Returns the list of rows it acted on (or WOULD act on when apply=False), so
    a caller can preview against live data before writing. Each carries the
    reason that will be stored, age included. `ids` scopes the action to an
    explicit set — the owner picking two rows must not be able to catch a third
    by accident.

    Catches BOTH failure shapes: a lease that stopped being renewed, and a claim
    that was never leased at all (see lease_state). The second is the one that
    matters on this table today, where nothing has ever been leased.

    Terminal on purpose. An abandoned run is NOT requeued: the last thing this
    queue needs is a job that silently retries into the same wedge while the
    pane shows nothing wrong. Re-queueing is the owner's call, from the UI.
    """
    now = _as_utc(now) if now is not None else _utcnow()
    conn = _conn()
    try:
        threshold, basis = abandon_threshold_s(conn)
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM deepdive_queue WHERE state='running' ORDER BY id")]
        reaped = []
        for row in rows:
            if ids is not None and row["id"] not in ids:
                continue
            ls = lease_state(row, now, threshold)
            if not ls["expired"]:
                continue        # False (healthy) and None (unknowable) both stay
            reason = _reap_reason(ls, row, threshold, basis)
            row["_reap_reason"] = reason
            row["_reap_age_s"] = ls["age_s"]
            row["_reap_basis"] = ls["lease_basis"]
            row["_reap_threshold_s"] = threshold
            reaped.append(row)
            if apply:
                # started_at is left ALONE. It is the only record of when the
                # run began, and status() reports abandoned age as
                # finished-minus-started; overwriting it would turn a 35-hour
                # wedge into a 0s one -- "not measured" wearing the clothes of
                # "measured zero", in the direction that flatters us.
                conn.execute(
                    "UPDATE deepdive_queue SET state='abandoned', reason=?, "
                    "finished_at=?, lease_until=NULL WHERE id=? AND state='running'",
                    (reason, _now(now), row["id"]))
        if apply and reaped:
            conn.commit()
        return reaped
    finally:
        conn.close()


def reap_report(apply=False, ids=None, now=None):
    """What the reaper WOULD change (apply=False) or DID change (apply=True).

    Enumerates every row currently marked 'running', not just the doomed ones,
    each with its verdict and the clock that produced it. A destructive action
    has to be able to say what it will touch before it touches it, and what it
    is LEAVING ALONE is half of that answer: an owner who cannot see the live
    run being spared has no reason to trust the two rows being collected.

    Writes nothing unless apply=True.
    """
    now = _as_utc(now) if now is not None else _utcnow()
    conn = _conn()
    try:
        threshold, basis = abandon_threshold_s(conn)
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM deepdive_queue WHERE state='running' ORDER BY id")]
    finally:
        conn.close()

    entries, doomed = [], []
    for row in rows:
        ls = lease_state(row, now, threshold)
        in_scope = ids is None or row["id"] in ids
        if not in_scope:
            code, verdict = "skipped", "out of scope — not in the requested ids"
        elif ls["expired"] is True:
            code = "abandon"
            verdict = "would be marked abandoned"
            doomed.append(row["id"])
        elif ls["expired"] is False:
            code, verdict = "keep", "left running — its claim is still credible"
        else:
            code = "unjudgeable"
            verdict = ("left running — NOT MEASURABLE: this row carries no "
                       "usable timestamp, so nothing can be said about it")
        entries.append({
            "id": row["id"], "symbol": row["symbol"], "as_of": row["as_of"],
            "state": row["state"], "queued_at": row.get("queued_at"),
            "started_at": row.get("started_at"),
            "age_s": ls["age_s"], "age_h": human_age(ls["age_s"]),
            "heartbeat_age_s": ls["heartbeat_age_s"],
            "heartbeat_age_h": human_age(ls["heartbeat_age_s"]),
            "lease_basis": ls["lease_basis"], "lease_expired": ls["expired"],
            "over_budget": ls["over_budget"],
            "worker_pid": row.get("worker_pid"), "worker_alive": ls["worker_alive"],
            "verdict_code": code, "verdict": verdict,
            "reason_to_store": (_reap_reason(ls, row, threshold, basis)
                                if code == "abandon" else None),
        })

    applied_ids = []
    if apply and doomed:
        applied_ids = [r["id"] for r in reap(apply=True, now=now, ids=set(doomed))]
        for e in entries:
            if e["id"] in applied_ids:
                e["verdict_code"], e["verdict"] = "abandoned", "marked abandoned"

    return {
        "applied": bool(apply),
        "now": _now(now),
        "scope": "every running row" if ids is None
                 else f"ids {sorted(ids)}",
        "threshold_s": threshold, "threshold_h": human_age(threshold),
        "threshold_basis": basis,
        "run_budget_s": RUN_BUDGET_S, "lease_ttl_s": LEASE_TTL_S,
        "queue_wait_ceiling_s": QUEUE_WAIT_CEILING_S,
        "n_running": len(rows),
        "n_affected": len(applied_ids) if apply else len(doomed),
        "affected_ids": applied_ids if apply else doomed,
        "rows": entries,
        "note": ("wrote the rows listed as 'marked abandoned'" if apply else
                 "DRY RUN — nothing was written. Re-issue with reap=apply to "
                 "commit exactly the rows listed as 'would be marked abandoned'."),
    }


def finish(queue_id, state, verdict=None, reason=None):
    """Worker: close a job and, on success, record its verdict.

    `reason` is what a failure OWES the reader. finish(id, 'failed') with no
    reason is how queue id 32 (META, 2026-08-20) came to sit in the pane as a
    45-second failure with a NULL explanation while the worker log held the
    actual cause the whole time -- a failed run that cannot say why is
    indistinguishable from one that failed for a reason the owner could act on.

    A 'done' run with no reason CLEARS the column. Without that, a job deferred
    earlier ("deferred — 'qwen3' holds the GPU") keeps that sentence after it
    has since run to completion, and the pane prints a stale excuse beside a
    finished verdict.
    """
    conn = _conn()
    try:
        if reason is not None:
            conn.execute("UPDATE deepdive_queue SET state=?, finished_at=?, "
                         "lease_until=NULL, reason=? WHERE id=?",
                         (state, _now(), str(reason)[:800], queue_id))
        elif state == "done":
            conn.execute("UPDATE deepdive_queue SET state=?, finished_at=?, "
                         "lease_until=NULL, reason=NULL WHERE id=?",
                         (state, _now(), queue_id))
        else:
            conn.execute("UPDATE deepdive_queue SET state=?, finished_at=?, "
                         "lease_until=NULL WHERE id=?",
                         (state, _now(), queue_id))
        if verdict:
            cols = ["queue_id"] + list(verdict) + ["created_at"]
            vals = [queue_id] + list(verdict.values()) + [_now()]
            conn.execute(
                f"INSERT INTO deepdive_verdict ({','.join(cols)}) "
                f"VALUES ({','.join('?' * len(cols))})", vals)
        conn.commit()
    finally:
        conn.close()


def outcome_tally(conn=None):
    """Census of deepdive_outcome. Pure read; never scores anything itself.

    Returns counts that a reader can act on, and they are NOT interchangeable:
      scored      a terminal judgement exists
      graded      of those, the ones carrying a realised number (result_pct).
                  'ambiguous' and 'no_fill' are scored but ungraded -- an
                  outcome with no P&L is still an outcome, and folding it into
                  a track record would invent one.
      open        still live, deliberately ungraded
      unscorable  examined and found unjudgeable, with a stored reason
      deferred    we tried and the price source was unreachable; NOT a
                  statement about the call, and retried next pass
      unexamined  verdicts with no outcome row at all -- the only honest
                  reading of "we never looked"

    All five are different facts. Summing any of them into `scored` would
    manufacture a track record out of rows nobody has graded.
    """
    own = conn is None
    conn = conn or _conn()
    try:
        try:
            rows = list(conn.execute(
                "SELECT status, resolution, result_pct FROM deepdive_outcome"))
        except sqlite3.Error:
            rows = []
        total_v = conn.execute("SELECT COUNT(*) FROM deepdive_verdict").fetchone()[0]
        last = conn.execute(
            "SELECT value FROM deepdive_meta WHERE key='last_score_at'").fetchone()
    finally:
        if own:
            conn.close()
    scored = [r for r in rows if r[0] == "scored"]
    return {
        "verdicts": int(total_v),
        "scored": len(scored),
        "graded": sum(1 for r in scored if r[2] is not None),
        "ambiguous": sum(1 for r in scored if r[1] == "ambiguous"),
        "open": sum(1 for r in rows if r[0] == "open"),
        "unscorable": sum(1 for r in rows if r[0] == "unscorable"),
        "deferred": sum(1 for r in rows if r[0] == "deferred"),
        "unexamined": max(0, int(total_v) - len(rows)),
        "last_score_at": last[0] if last else None,
    }


def scored_count():
    """How many deep-dive calls have a realised, graded outcome yet.

    Drives the honesty line in the UI. It used to count rows in
    ~/.tradingagents/shadow.db::shadow_outcomes -- a table belonging to a
    DIFFERENT experiment, which returned 0 whether or not any deep dive had
    ever been graded. A number that is right for the wrong reason is still a
    number nobody can act on. This counts THIS layer's graded outcomes.
    """
    try:
        return outcome_tally()["graded"]
    except sqlite3.Error:
        return 0


def status(limit=12):
    """Everything the RESEARCH panel needs in one payload."""
    if not os.path.exists(DEEPDIVE_DB):
        return {"verdicts": [], "queue": [], "scored_n": 0,
                "validation": "UNVALIDATED", "coverage": "no deep dives run yet"}
    conn = _conn()
    try:
        verdicts = [dict(r) for r in conn.execute(
            "SELECT * FROM deepdive_verdict ORDER BY created_at DESC LIMIT ?", (limit,))]
        try:
            scores = {r["verdict_id"]: dict(r) for r in conn.execute(
                "SELECT * FROM deepdive_outcome")}
        except sqlite3.Error:
            scores = {}
        for v in verdicts:
            o = scores.get(v["id"])
            # 'unexamined' rather than a missing key or a null-that-looks-like-
            # a-verdict: the pane must be able to say "not scored yet" without
            # that reading as "scored, flat".
            v["outcome"] = o
            v["outcome_status"] = (o or {}).get("status") or "unexamined"
            v["outcome_resolution"] = (o or {}).get("resolution")
            v["result_pct"] = (o or {}).get("result_pct")
            v["result_r"] = (o or {}).get("result_r")
            # And the inverse invariant: a reports_dir that no longer exists
            # must not keep claiming it does. None = nothing was claimed.
            rd = v.get("reports_dir")
            v["reports_present"] = os.path.isdir(rd) if rd else None
            v["report_file"] = (os.path.join(
                rd, f"full_states_log_{v['as_of']}.json") if rd else None)
            v["report_file_present"] = (os.path.exists(v["report_file"])
                                        if v["report_file"] else None)
        # Live states always; terminal FAILURES only while they are still news.
        # A run that died has to be visible somewhere -- 'abandoned' rows used
        # to be invisible as a category and merely mislabelled as RUNNING.
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM deepdive_queue WHERE state IN "
            "('queued','running','blocked','abandoned','failed') "
            "ORDER BY id DESC LIMIT 20")]
        threshold, threshold_basis = abandon_threshold_s(conn)
    finally:
        conn.close()

    now = _utcnow()
    queue = []
    for r in rows:
        fin_age = _age_s(r.get("finished_at"), now)
        if r["state"] in ("abandoned", "failed") and (fin_age or 0) > 86400:
            continue            # older than a day: history, not a live fault
        ls = lease_state(r, now, threshold)
        # Each state gets the age that is actually diagnostic for it, and says
        # WHICH one it is (age_of) so the number is never read as the wrong
        # clock. For a dead run that is HOW LONG IT RAN -- reporting "0s ago"
        # the instant the reaper fires would bury the 12-hour fact that is the
        # whole point. A queued row has no run clock at all, so it reports its
        # wait rather than an invented zero.
        if r["state"] == "running":
            age_s, age_of = ls["age_s"], "running"
            if age_s is None:
                # 'running' with no started_at: there IS no run clock. Fall back
                # to the queue clock and SAY it is a different one, rather than
                # handing the pane a bare null it would draw as an empty cell
                # next to the word RUNNING.
                age_s = _age_s(r.get("queued_at"), now)
                age_of = "since queued — no claim time was ever recorded"
        elif r["state"] in ("abandoned", "failed"):
            started = _parse(r.get("started_at"))
            ended = _parse(r.get("finished_at"))
            if started and ended:
                age_s, age_of = round((ended - started).total_seconds(), 1), "ran"
            else:
                age_s, age_of = fin_age, "since it ended"
        else:
            age_s, age_of = _age_s(r.get("queued_at"), now), "waiting"
        queue.append({
            "id": r["id"], "symbol": r["symbol"], "as_of": r["as_of"],
            "state": r["state"], "reason": r.get("reason"),
            "queued_at": r.get("queued_at"), "started_at": r.get("started_at"),
            "age_s": age_s, "age_h": human_age(age_s), "age_of": age_of,
            # `lease_expired` True means the worker stopped renewing: the row
            # says 'running' but nothing is running it. None means this row
            # cannot be judged -- NOT that the lease is healthy.
            "lease_expired": ls["expired"],
            "lease_basis": ls["lease_basis"],
            "heartbeat_age_s": ls["heartbeat_age_s"],
            "heartbeat_age_h": human_age(ls["heartbeat_age_s"]),
            "over_budget": ls["over_budget"],
            "worker_pid": r.get("worker_pid"),
            # True/False/None — None is "no pid was recorded", NOT "dead".
            "worker_alive": ls["worker_alive"],
        })
    queue = queue[:10]

    # Rows the glass must not draw as live and a reap would collect. Reported
    # so the pane can offer the action instead of the owner having to notice
    # a stuck row himself -- but the count is all this GET does. It never reaps.
    unreaped = [q["id"] for q in queue
                if q["state"] == "running" and q["lease_expired"] is True]

    try:
        tally = outcome_tally()
    except sqlite3.Error:
        tally = None
    n = (tally or {}).get("graded", 0)
    return {
        "verdicts": verdicts,
        "queue": queue,
        "scored_n": n,
        "scoring": tally,
        "run_budget_s": RUN_BUDGET_S,
        "lease_ttl_s": LEASE_TTL_S,
        "abandon_threshold_s": threshold,
        "abandon_threshold_h": human_age(threshold),
        "abandon_basis": threshold_basis,
        "unreaped_ids": unreaped,
        "unreaped_n": len(unreaped),
        "validation": "UNVALIDATED",
        # Every clause here is a separate measurement and none of them may
        # stand in for another: graded is a track record, open is "still
        # running", unscorable is "examined and unjudgeable", and unexamined is
        # "nobody has looked". Collapsing the last three into the first is how
        # 31 verdicts came to imply a record that did not exist.
        "coverage": (
            (f"{n} graded outcome{'s' if n != 1 else ''} on record"
             + (f" ({tally['open']} still open, {tally['unscorable']} unscorable, "
                f"{tally['deferred']} deferred, {tally['unexamined']} not yet "
                f"examined)" if tally else "")
             + " — far below the ~85 trades needed to detect even a 3% edge. "
               "These are analyses, not graded signals.")
            if tally is not None else
            "outcome table unavailable — no scoring claim can be made"
        ),
    }
