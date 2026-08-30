#!/usr/bin/env python3
"""Drains the deep-dive queue. One job at a time, never inside the web server.

Single-flight by lock file: two concurrent runs would need ~200 GB of model
weights on a 128 GB box and put it straight into swap. It also refuses to
start when another large model is already resident in Ollama, rather than
stalling silently -- something else on this machine uses Ollama too.

Every claimed job runs under a LEASE the worker renews (LeaseKeeper). A worker
that dies or wedges stops renewing, and the next poll reaps the row into
'abandoned' instead of leaving it 'running' forever -- the failure that left
two HYPE-USD workups looking live for 11.6 hours.

Run:  python3 deepdive_worker.py          # drain once and exit
      python3 deepdive_worker.py --loop   # stay up, poll every 30s
      python3 -c 'import deepdive; print(deepdive.reap(apply=False))'
                                          # preview the reaper, writes nothing

Every poll also SCORES: score_verdicts() -> deepdive_score.score_due() grades
verdicts whose calls have resolved, throttled to once every 30 min. It lives
here rather than in a cron job or a manual CLI on purpose -- the equity book
has 180 decisions and 0 outcomes precisely because its outcome writer was a
CLI nothing ever called.

      python3 deepdive_score.py score --dry   # judge, print, write nothing
      python3 deepdive_score.py prune         # DRY RUN of report deletion
"""

import argparse
import json
import os
import re
import signal
import sys
import threading
import time
import traceback

# The terminal runs on system python 3.9; TradingAgents lives in its own 3.12
# venv. Re-exec there rather than requiring the caller to know that, so the
# worker behaves the same from a shell, launchd, or the server.
_VENV = os.path.expanduser("~/dev/TradingAgents/.venv/bin/python")
if not os.environ.get("_DEEPDIVE_REEXEC") and os.path.exists(_VENV):
    if os.path.realpath(sys.executable) != os.path.realpath(_VENV):
        os.environ["_DEEPDIVE_REEXEC"] = "1"
        os.execv(_VENV, [_VENV] + sys.argv)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deepdive

REPO = os.path.expanduser("~/dev/TradingAgents")
LOCK = os.path.expanduser("~/.hermes/terminal/data/deepdive.lock")
BIG_MODEL_GB = 40          # anything larger competes for the box
LOG = os.path.expanduser("~/.hermes/logs/deepdive.log")

# --- BOUND THE CALL THE WORKER CAN HANG ON ---------------------------------
# MEASURED, not inferred. This provider chain is langchain_openai ->
# openai SDK -> httpx, and langchain_openai's `request_timeout` defaults to
# None, which it forwards UNCONDITIONALLY as the client's `timeout` (see
# langchain_openai/chat_models/base.py:1266). The SDK only substitutes its own
# 600s default when the argument is NOT GIVEN; an explicit None is honoured as
# "no timeout at all". Reproduced against this venv on 2026-08-19:
#     openai.OpenAI(timeout=None) -> client.timeout = None          (infinite)
#     openai.OpenAI()             -> Timeout(connect=5, read=600, ...)
# So every LLM call in a workup was an UNBOUNDED read against Ollama on
# localhost:11434. That is exactly the fingerprint of a worker parked at 0%
# CPU with no children: suspended on an await that can never complete, the
# same failure the flow collector hit on its websocket.
#
# 600s restores the SDK's OWN default rather than inventing a number, and it
# already clears the slowest COMPLETE workup this queue has recorded outside
# the cold-start outlier (558s end to end, for a run that makes many calls).
LLM_TIMEOUT_S = 600
# One retry, not the SDK's default two: with a 600s ceiling per attempt the
# default budget is 1800s of a 2700s run, leaving no room for the rest of the
# graph. Ollama is local and does not 429, so retries here buy little.
LLM_MAX_RETRIES = 1


# The job this process is inside RIGHT NOW, or None. Read by the signal
# handlers so a worker that is told to stop can leave a sentence behind
# instead of a bare state change nobody can interpret later.
_IN_FLIGHT = {"job": None}


def describe_exc(exc, elapsed=None):
    """One line a human can act on: what broke, where, and how far in.

    Type AND message, because 'HTTPError' alone does not say which host 500ed
    and 'HTTP Error 500: Internal Server Error' alone does not say it came over
    urllib. The innermost frame inside our own code is appended when we can get
    it -- an upstream fault and a bug in this repo are different problems and
    must not read the same.
    """
    where = ""
    try:
        tb = traceback.extract_tb(exc.__traceback__)
        ours = [f for f in tb
                if "/site-packages/" not in f.filename and "/lib/python" not in f.filename]
        frame = (ours or tb or [None])[-1]
        if frame is not None:
            where = f" at {os.path.basename(frame.filename)}:{frame.lineno} in {frame.name}()"
    except Exception:
        where = ""          # never let the explainer become the failure
    head = f"failed after {int(elapsed)}s — " if elapsed is not None else "failed — "
    return f"{head}{type(exc).__name__}: {exc}{where}"[:800]


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def ollama_busy():
    """True when a large model that isn't ours is already loaded."""
    try:
        import urllib.request
        with urllib.request.urlopen("http://localhost:11434/api/ps", timeout=3) as r:
            models = json.load(r).get("models", [])
    except Exception:
        return False        # can't tell; let the run try and fail loudly
    ours = {"nemotron-super-64k", "nemotron-3-super", "gemma4", "nemotron-light-64k"}
    for m in models:
        name = m.get("name", "").split(":")[0]
        if m.get("size", 0) / 1e9 > BIG_MODEL_GB and name not in ours:
            return name
    return False


def bound_llm_calls():
    """Give every LLM client a finite read timeout. Returns True if applied.

    TradingAgentsGraph builds its clients through create_llm_client(), and
    `timeout` is already an accepted passthrough kwarg (openai_client.py
    _PASSTHROUGH_KWARGS) -- nothing here fights the library, it just supplies
    the argument the config layer has no key for. Patched on the name bound
    INSIDE trading_graph, not on the factory module: trading_graph does
    `from ... import create_llm_client` at import time, so rebinding the
    factory alone would leave the graph holding the original. Same lesson as
    hyperliquid_vendor.patch_load_ohlcv() rebinding into market_data_validator.

    Failure is logged, never swallowed: a run with unbounded LLM calls is the
    wedge itself, so the caller must be able to say the guard is absent.
    """
    try:
        from tradingagents.graph import trading_graph as tg
        inner = tg.create_llm_client
        if getattr(inner, "_deepdive_bounded", False):
            return True

        def bounded(*args, **kwargs):
            kwargs.setdefault("timeout", LLM_TIMEOUT_S)
            return inner(*args, **kwargs)

        bounded._deepdive_bounded = True
        tg.create_llm_client = bounded
        return True
    except Exception as exc:
        log(f"WARNING: could not bound LLM timeouts ({type(exc).__name__}: {exc}) "
            f"— this run's LLM calls may block indefinitely; the run deadline "
            f"is the only backstop")
        return False


class LeaseKeeper:
    """Renews a job's lease while it runs, and enforces the run deadline.

    A daemon THREAD, because the thing it guards is a single blocking call:
    graph.propagate() owns the main thread for the whole workup and cannot poll
    anything. When the process dies the thread dies with it, the lease stops
    being renewed, and deepdive.reap() can tell the difference between a slow
    run and a dead one -- which a bare 'running' flag never could.

    On deadline breach it does what flow_collector._abort() does to a wedged
    socket: stop negotiating. The row is written terminal FIRST (so the glass
    is honest even if everything after this fails), then the process re-execs.
    """

    def __init__(self, job):
        self.job = job
        self._stop = threading.Event()
        self.lost = False           # the row stopped being ours mid-run
        self.thread = threading.Thread(target=self._run, daemon=True,
                                       name=f"lease-{job['id']}")

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        return False

    def _run(self):
        t0 = time.time()
        while not self._stop.wait(deepdive.HEARTBEAT_S):
            elapsed = time.time() - t0
            if elapsed > deepdive.RUN_BUDGET_S:
                self._breach(elapsed)
                return
            try:
                if not deepdive.heartbeat(self.job["id"]):
                    # Someone else moved this row -- almost always the reaper.
                    self.lost = True
                    log(f"job {self.job['id']}: lease LOST (row is no longer "
                        f"'running'); this run's verdict will not be recorded")
                    return
            except Exception as exc:
                log(f"job {self.job['id']}: heartbeat failed "
                    f"({type(exc).__name__}: {exc})")

    def _breach(self, elapsed):
        age = deepdive.human_age(elapsed)
        reason = (
            f"run deadline exceeded — {age} on a workup advertised at ~9 min "
            f"(budget {deepdive.human_age(deepdive.RUN_BUDGET_S)}); the worker "
            f"was blocked, not slow"
        )
        self.lost = True
        try:
            # One write, reason included. The old two-step (finish, then a bare
            # UPDATE) left the row terminal-with-NULL-reason for the window in
            # between, and permanently so if the second statement threw.
            deepdive.finish(self.job["id"], "failed", reason=reason)
        except Exception as exc:
            log(f"job {self.job['id']}: could not mark the deadline breach "
                f"({type(exc).__name__}: {exc})")
        log(f"job {self.job['id']} {self.job['symbol']}: {reason} — re-execing")

        # Re-exec rather than exit. The blocked call lives in the main thread's
        # C stack and cannot be interrupted from here, so the process image has
        # to go. execv keeps the PID (the lock file stays valid) and comes back
        # draining, whereas exiting would strand the queue until launchd's next
        # 06:30 run -- com.hermes.deepdive only relaunches once a day.
        # No tight loop: the breached row is terminal, so it is never reclaimed.
        os.environ["_DEEPDIVE_DEADLINE_RESTART"] = str(self.job["id"])
        try:
            sys.stdout.flush()
        except Exception:
            pass
        script = os.path.abspath(__file__)
        os.execv(sys.executable, [sys.executable, script] + sys.argv[1:])


def parse_verdict(state):
    """Pull the structured trade out of the state the graph returns.

    Originally this read ~/.tradingagents/logs/<SYM>/<DATE>/reports/*.md -- but
    that tree is written by the CLI, NOT by TradingAgentsGraph.propagate().
    A programmatic run leaves only TradingAgentsStrategy_logs/*.json, so the
    parser was silently reading a PREVIOUS CLI run's files when they happened
    to exist and returning UNKNOWN when they did not. Reading the returned
    state removes the file dependency entirely.
    """
    final = state.get("final_trade_decision") or ""
    trader = state.get("trader_investment_decision") or ""
    both = final + "\n" + trader

    def grab(pattern, text=both, cast=str):
        m = re.search(pattern, text, re.I)
        if not m:
            return None
        try:
            return cast(m.group(1).replace(",", "").strip())
        except (ValueError, TypeError):
            return None

    rating = grab(r"\*\*Rating\*\*:\s*([A-Za-z ]+)")
    action = grab(r"FINAL TRANSACTION PROPOSAL:\s*\*\*([A-Z]+)\*\*") \
        or grab(r"\*\*Action\*\*:\s*([A-Za-z]+)")
    return {
        "rating": (rating or "").strip() or None,
        "action": (action or "").strip().upper() or "UNKNOWN",
        "entry": grab(r"\*\*Entry Price\*\*:\s*\$?([\d.]+)", cast=float),
        "stop": grab(r"\*\*Stop Loss\*\*:\s*\$?([\d.]+)", cast=float),
        "target": grab(r"\*\*Price Target\*\*:\s*\$?([\d.]+)", cast=float),
        "horizon": grab(r"\*\*Time Horizon\*\*:\s*([^\n*]+)"),
        "thesis": (grab(r"\*\*Executive Summary\*\*:\s*([^\n]+)") or "")[:600] or None,
    }


def _load_env_file(path):
    """Load KEY=VAL lines without requiring python-dotenv.

    Aug 24 2026: every job in that batch died in 0s with
    ModuleNotFoundError: No module named 'dotenv' at the first line of
    run_job. The venv TradingAgents uses does not ship dotenv. A missing
    helper library must not take the queue down.
    """
    try:
        from dotenv import load_dotenv
        load_dotenv(path)
        return
    except ImportError:
        pass
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                os.environ.setdefault(
                    key.strip(), val.strip().strip('"').strip("'"))
    except OSError:
        pass


def run_job(job):
    _load_env_file(os.path.join(REPO, ".env"))
    sys.path.insert(0, REPO)
    from tradingagents.default_config import DEFAULT_CONFIG
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    # Crypto has no balance sheet, so the CLI drops the fundamentals analyst for
    # it (filter_analysts_for_asset_type). The worker did not, and on HYPE-USD
    # that analyst -- handed a ticker yfinance cannot identify -- invented an
    # issuer ("Supreme Finance USD") and produced 5.7k chars of fundamentals for
    # a company that does not exist. Apply the same filter the CLI does.
    from cli.models import AnalystType
    from cli.utils import detect_asset_type, filter_analysts_for_asset_type

    every = [AnalystType.MARKET, AnalystType.SOCIAL,
             AnalystType.NEWS, AnalystType.FUNDAMENTALS]
    asset = detect_asset_type(job["symbol"])
    analysts = [a.value for a in filter_analysts_for_asset_type(every, asset)]

    # HL-only tickers: market analyst ONLY. Everything else keys off a yfinance
    # listing that does not exist, so identity resolves wrong and the news
    # analyst fills the vacuum with unrelated macro. The market analyst is the
    # one agent grounded in the verified price snapshot, which HL does serve.
    technical_only = False
    try:
        import hyperliquid_vendor as _hv
        if _hv.is_hl_only(job["symbol"], job["as_of"]):
            analysts = ["market"]
            technical_only = True
    except Exception as exc:
        log(f"job {job['id']}: HL-only check failed ({type(exc).__name__}); "
            f"keeping {analysts}")

    cfg = DEFAULT_CONFIG.copy()
    # Bound the SDK retry budget through the supported config key, and the
    # per-call read through the factory patch. Both are needed: retries
    # multiply the timeout, so a ceiling on one without the other is not a
    # ceiling at all.
    cfg["llm_max_retries"] = LLM_MAX_RETRIES
    bounded = bound_llm_calls()

    # yfinance does not list HYPE, PUMP, or most of the HL tail. Register the
    # Hyperliquid vendor and route price/indicator lookups there for anything
    # yfinance cannot serve; news/social stay on the default vendors because HL
    # has none. Falls back to yfinance so majors (BTC, ETH, SOL) keep the
    # richer feed.
    try:
        import hyperliquid_vendor
        hyperliquid_vendor.register()
        cfg["data_vendors"] = {
            **cfg.get("data_vendors", {}),
            # HL FIRST, yfinance second. yfinance does not miss cleanly on
            # HL-only tickers -- it returned 2024 rows for HYPE-USD, which
            # "succeeded" and stopped the chain, then failed a staleness check
            # downstream. HL raises NoMarketDataError on a miss, so equities
            # fall through to yfinance correctly.
            "core_stock_apis": "hyperliquid,yfinance",
            "technical_indicators": "hyperliquid,yfinance",
        }
    except Exception as exc:
        log(f"hyperliquid vendor unavailable ({type(exc).__name__}: {exc}); "
            f"falling back to yfinance only")

    t0 = time.time()
    log(f"job {job['id']} {job['symbol']}: {asset.value} -> analysts {analysts}"
        + ("  [TECHNICAL ONLY — not listed on yfinance]" if technical_only else "")
        + (f"  [llm timeout {LLM_TIMEOUT_S}s x{LLM_MAX_RETRIES + 1}]" if bounded
           else "  [LLM TIMEOUT NOT BOUND — deadline is the only backstop]"))
    graph = TradingAgentsGraph(debug=False, config=cfg,
                               selected_analysts=analysts)
    if technical_only:
        # yfinance's listing for an HL-only ticker is a squatter: HYPE-USD
        # resolves to "Supreme Finance USD", and resolve_instrument_context
        # would pin that wrong name as ground truth ("do not substitute a
        # different company") for every agent. Ticker-only context is the
        # resolver's own designed fallback; force it. Instance attribute, so
        # propagate()'s self.resolve_instrument_context(...) finds this first.
        from tradingagents.agents.utils.agent_utils import build_instrument_context
        graph.resolve_instrument_context = (
            lambda ticker, asset_type="crypto":
                build_instrument_context(ticker, asset_type))
    state, _decision = graph.propagate(job["symbol"], job["as_of"])
    elapsed = round(time.time() - t0, 1)

    reports = os.path.expanduser(
        f"~/.tradingagents/logs/{job['symbol']}/TradingAgentsStrategy_logs")
    # Parse the state the graph SERIALISES, not the object it returns: the
    # in-memory value came back without the decision fields populated (measured
    # -- the same run's saved JSON parses as BUY/stop 190 while the returned
    # object parsed as UNKNOWN). Fall back to the object if the file is absent.
    v = None
    snap = os.path.join(reports, f"full_states_log_{job['as_of']}.json")
    if os.path.exists(snap):
        try:
            with open(snap) as f:
                v = parse_verdict(json.load(f))
        except (ValueError, OSError):
            v = None
    if not v or v.get("action") == "UNKNOWN":
        alt = parse_verdict(state)
        if alt.get("action") != "UNKNOWN":
            v = alt
        v = v or alt
    v.update({
        "symbol": job["symbol"], "as_of": job["as_of"], "reports_dir": reports,
        "elapsed_s": elapsed, "model_deep": cfg.get("deep_think_llm"),
        "model_quick": cfg.get("quick_think_llm"),
        "analysts": ("technical-only" if technical_only else ",".join(analysts)),
    })
    return v


def reap_abandoned():
    """Collect rows whose lease expired. Runs before every claim.

    Deliberately worker-side. /api/deepdive is a GET and must not write, so the
    pane DERIVES the same verdict read-only (deepdive.lease_state) and this is
    what makes it durable.
    """
    try:
        for row in deepdive.reap():
            log(f"job {row['id']} {row['symbol']}: REAPED — {row['_reap_reason']}")
    except AttributeError:
        # An older deepdive module with no reaper. Say so rather than looking
        # like a clean sweep: this is precisely the state the live worker has
        # been in since 2026-08-18 -- it imported the pre-lease module at start
        # and no edit on disk can reach it without a restart.
        log("reaper UNAVAILABLE in the deepdive module this process imported; "
            "abandoned rows will stay 'running' until the worker restarts")
    except Exception as exc:
        log(f"reaper failed ({type(exc).__name__}: {exc}); abandoned rows will "
            f"still render as abandoned but stay 'running' on disk")


def score_verdicts():
    """Grade verdicts whose calls have resolved. Runs on every poll, throttled.

    THIS IS THE POINT OF THE HOST. The equity book has 180 decisions and 0
    outcomes because its only outcome writer is a manual CLI nothing ever
    calls; a scorer that nobody runs is the same bug wearing new code. The
    worker already wakes every 30s and is idle between workups, so it is the
    obvious owner. deepdive_score.score_due() carries its own 30-minute
    throttle and never raises -- a scorer fault must not be able to stall the
    queue that drains the workups.

    Deliberately BEFORE claim_next(): scoring is cheap when not due (one SELECT)
    and must not be starved by a busy queue, which is exactly how a "we'll get
    to it" scorer never gets to it.
    """
    try:
        import deepdive_score
    except Exception as exc:
        log(f"scorer unavailable ({type(exc).__name__}: {exc}); verdicts stay "
            f"unscored and the pane will keep saying so")
        return
    deepdive_score.score_due(log=log)


def drain_once():
    reap_abandoned()
    score_verdicts()
    job = deepdive.claim_next()
    if not job:
        return False
    busy = ollama_busy()
    if busy:
        # Back to QUEUED, not failed: a deferral means "not now", and marking it
        # failed stranded the job permanently once the GPU freed up. defer()
        # rather than finish(...,'queued') so the row does not keep a
        # finished_at from a run that never happened.
        deepdive.defer(job["id"], f"deferred — '{busy}' holds the GPU")
        log(f"job {job['id']} {job['symbol']}: deferred — '{busy}' holds the GPU; requeued")
        return False        # don't spin; wait a full poll interval
    log(f"job {job['id']} {job['symbol']}@{job['as_of']}: running "
        f"(budget {deepdive.human_age(deepdive.RUN_BUDGET_S)}, "
        f"lease {deepdive.human_age(deepdive.LEASE_TTL_S)})")
    _IN_FLIGHT["job"] = job
    t_job = time.time()
    with LeaseKeeper(job) as keeper:
        try:
            v = run_job(job)
            if keeper.lost:
                # The reaper already called this row abandoned. Recording a
                # verdict now would attach a result to a row the glass has
                # declared dead -- two contradictory claims about one run.
                log(f"job {job['id']} {job['symbol']}: completed in "
                    f"{v['elapsed_s']}s but the lease was already lost; "
                    f"verdict DISCARDED")
                return True
            deepdive.finish(job["id"], "done", v)
            log(f"job {job['id']} {job['symbol']}: {v['action']} "
                f"(entry {v['entry']} stop {v['stop']}) in {v['elapsed_s']}s")
        except Exception as exc:
            # THE REASON GOES WITH THE STATE, ALWAYS. queue id 32 (META,
            # 2026-08-20) is what the old bare finish(...,'failed') produced: a
            # 45-second failure with reason NULL in the pane, while this very
            # log line held "HTTPError: HTTP Error 500: Internal Server Error"
            # the whole time. The glass and the log must not disagree about
            # whether a cause is known.
            reason = describe_exc(exc, time.time() - t_job)
            if not keeper.lost:
                deepdive.finish(job["id"], "failed", reason=reason)
            log(f"job {job['id']} {job['symbol']}: FAILED {reason}")
        finally:
            _IN_FLIGHT["job"] = None
    return True


def _release_lock():
    """Drop the single-flight lock, but only if it is OURS.

    An unconditional remove would let a process that exited *because* another
    worker held the lock delete that worker's lock on its way out, and the next
    poll would start a second 12-agent run on a box that cannot hold two.
    """
    try:
        if int(open(LOCK).read().strip()) != os.getpid():
            return
    except (OSError, ValueError):
        return
    try:
        os.remove(LOCK)
    except OSError:
        pass


def _stop_signal(signum, _frame):
    """Leave a readable row behind when this worker is told to stop mid-run.

    A killed worker used to leave the row 'running' and the reaper had to infer
    it minutes later from a stale clock; the row said a live workup was in
    progress in the meantime. Here the process KNOWS why it is dying, so it
    says so, in the same terminal shape the reaper would have written.

    'abandoned', not 'failed': nothing was wrong with the analysis, a human or
    the OS stopped it. SIGKILL cannot be caught at all -- that path is still the
    reaper's, which is why the reaper is not optional.
    """
    name = signal.Signals(signum).name if hasattr(signal, "Signals") else signum
    job = _IN_FLIGHT.get("job")
    if job:
        reason = (f"worker (pid {os.getpid()}) received {name} while this run "
                  f"was in flight; the run was stopped, not completed")
        try:
            deepdive.finish(job["id"], "abandoned", reason=reason)
            log(f"job {job['id']} {job['symbol']}: {reason}")
        except Exception as exc:
            log(f"job {job['id']}: could not record the {name} stop "
                f"({type(exc).__name__}: {exc}); the reaper will collect it")
    else:
        log(f"worker (pid {os.getpid()}) received {name} while idle; exiting")
    _release_lock()
    # 128+signum is the shell's own convention for "died by signal N", so the
    # exit status keeps saying which one even after this handler intervened.
    os._exit(128 + int(signum))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--loop", action="store_true")
    args = ap.parse_args()

    breached = os.environ.pop("_DEEPDIVE_DEADLINE_RESTART", None)
    if breached:
        log(f"restarted after job {breached} blew its run deadline; that row is "
            f"terminal ('failed') and will not be reclaimed")

    if os.path.exists(LOCK):
        try:
            pid = int(open(LOCK).read().strip())
            # execv keeps our PID, so after a deadline re-exec the lock holds
            # our OWN pid and os.kill(pid, 0) succeeds. Without this check the
            # restarted worker would read that as "someone else is running" and
            # exit, turning the deadline escape into a silent shutdown.
            if pid != os.getpid():
                os.kill(pid, 0)
                log(f"worker already running (pid {pid}); exiting")
                return
        except (ValueError, ProcessLookupError, PermissionError):
            pass        # stale lock
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    open(LOCK, "w").write(str(os.getpid()))
    # Registered only AFTER the lock is ours, so a duplicate worker exiting at
    # the check above can never run the handler and speak for a job it does not
    # own. SIGKILL is deliberately absent: it cannot be caught, which is the
    # whole reason the reaper exists as a second line.
    for _sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        try:
            signal.signal(_sig, _stop_signal)
        except (ValueError, OSError, AttributeError):
            pass        # not the main thread, or not this platform
    try:
        while True:
            worked = drain_once()
            if not args.loop:
                if not worked:
                    log("queue empty")
                break
            # A poll that finds nothing still has to reap: a row orphaned by a
            # crash must go terminal even when no new work ever arrives.
            time.sleep(5 if worked else 30)
    finally:
        _release_lock()


if __name__ == "__main__":
    main()
