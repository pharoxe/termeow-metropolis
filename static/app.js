/* Terminal V frontend.
 * Live mids stream straight from Hyperliquid's public WebSocket (crypto dex);
 * equity-perp (xyz) mids refresh by polling /api/universe. Slower aggregates
 * (events, research, news, funding) come from the local server.
 */
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
  (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

/* A URL THIS ORIGIN IS WILLING TO FOLLOW — allowlist, never a blocklist.
   esc() makes a feed string safe to PRINT; it does nothing about what the
   string means once the browser follows it, and four render sites put
   feed-supplied urls straight into href= (news twice, the intel stack, the
   buyback explorer link). A `javascript:` url arriving through the news
   pipeline would execute in the origin that holds hlterm_alerts — which
   fires to Telegram — and the configured wallet address, on a click that
   looks like reading a headline. Nothing observed has ever shipped one; the
   check costs a regex and closes the class.

   Returns null for anything that is not http(s), and every caller renders
   the text WITHOUT a link in that case rather than dropping the row: an
   unfollowable link is not an absent headline. */
const safeHref = (u) => {
  const s = String(u == null ? "" : u).trim();
  return /^https?:\/\//i.test(s) ? s : null;
};
const IST = { timeZone: "Asia/Kolkata", hour12: false };

const state = {
  universe: { crypto: {}, equity: {} },
  watchCrypto: [], watchEquity: [],
  mids: {},              // live mids by coin
  prevDay: {},           // prev day px by coin for 24h%
  sel: "BTC",            // selected chart coin
  newsAll: false,        // false = CN (follow sel); true = TOP / ALL
  interval: "1h",
  candles: [],
  /* WHY the candle series carries a note beside it.

     An empty array had exactly one rendering — the word "loading" — and it
     was reached three different ways: a fetch genuinely in flight, a market
     whose history the venue served as EMPTY (8 delisted-but-listed names in
     this terminal's own universe: AI, AI16Z, ARK, BADGER, BLAST, CANTO,
     CHILLGUY, FTM), and an upstream failure whose payload the client threw
     away with `d.candles || []`. Three facts, one sentence, and the sentence
     was false for two of them: "loading" is a promise that bars are coming.
     {coin, interval, kind: "empty"|"error", text, at} — null means the last
     completed fetch produced bars. */
  candlesNote: null,
  lastTickAt: 0,
  wtab: "watch",         // watch | movers | funding | signals
  signals: null,
  venues: null,          // last GOOD /api/venues snapshot (kept through a failed refresh)
  venuesErr: null,
  cards: [], insiders: [], news: [],
  /* Charted-name headlines for FLAGS (and DES cites). Always follows state.sel,
     even when the NEWS pane is on ALL. Never refilled from TOP/ALL rows. */
  newsChart: null,
  /* DES chip. Independent of inds.news and of CN/ALL. Absent key = ON. */
  desOn: (() => { try { const v = localStorage.getItem("hlterm_des");
                         return v == null ? true : v !== "0"; }
                  catch (e) { return true; } })(),
  des: null,             // last /api/des payload for the charted coin
  desWait: { coin: null, at: 0 },
  insiderNote: "", pipelineNote: "", pipelineAt: null, newsMeta: null,
  /* Resting orders for the owner's own wallet (/api/stops). Kept SEPARATE
     from state.port because the two answer different questions and fail
     independently: positions can load while the order query dies, and that
     combination is exactly the one that must not render as "no stops". null
     here means "never fetched", which is itself not a measured zero. */
  stops: null,
  fundingXAt: 0, fundingXErr: null,
  depthSlots: null,   // collector capacity (see loadUniverse) — not per-coin
  buyback: {},   // token -> {kind, detail, realised}
  buybackOffVenue: {},
  burnFired: (() => { try { return JSON.parse(localStorage.getItem("hlterm_burnfired") || "{}"); }
                      catch (e) { return {}; } })(),
  burnEvents: [],
  dossierCoin: null, dossierTimer: null,
  // Per-coin cross-venue comparison (/api/xvenue): coin -> {coin, d, at,
  // err, loading}. Kept out of the dossier's "no extra fetches" doctrine
  // deliberately — the venue books are the one thing the already-loaded
  // stores cannot answer, and the fetch is one bounded server-cached call
  // for the ONE coin being examined.
  // KEYED BY COIN, not a single slot. Two consumers now read it — the
  // dossier (whatever symbol was opened) and the VENUES aggregator (the
  // CHARTED symbol) — and those are routinely different coins. On one slot
  // the second consumer to fetch evicted the first, and the loser rendered
  // the other coin's venues under its own name.
  xv: {},
  // Per-coin print-size distribution (/api/xprints) and per-SYMBOL whale
  // detail (/api/whales?coin=), same keying for the same reason.
  xp: {},
  whByCoin: {},
  // armedAt records the levels ENTER actually armed alerts at. A target
  // dragged afterwards must be able to say that the standing alert did NOT
  // move with the line — an alert follows nothing.
  ruler: { armed: false, coin: null, entry: null, stop: null, target: null,
           armedAt: null },
  // A plan read back from hlterm_ruler whose coin is not the one charted.
  // Held, never drawn: another instrument's levels on this chart would be a
  // confident lie about where this instrument's risk sits.
  rulerPending: null,
  heatWalls: [],
  // Order flow. side "B" = buy aggressor (verified against the live book:
  // B lifted the ask 45x vs 8 bid-hits; A hit the bid 17x and never lifted).
  flow: { coin: null, cvd: 0, since: 0, points: [], recent: [], tape: [] },
  flowHist: null,
  // Server-persisted L2 depth history (datasources/depth_history.py). The
  // heatmap's own `snaps` buffer is a five-minute session ring; this is the
  // record that survives a reload and reaches back hours.
  depthHist: null,
  /* The DAILY candle series for the charted symbol, fetched on its own and
     used for exactly one thing: the prior-period S/R levels. Kept apart from
     state.candles deliberately — the whole point of that method is that a
     level is a property of the INSTRUMENT, never of the interval or the
     viewport the reader happens to be on, so it must not be derived from the
     series the chart is drawing (not even when the chart IS on 1d).
     {coin, candles, at, err, calc}; `calc` memoises the level set, keyed by
     the series' last timestamp AND the current UTC day, because the periods
     themselves roll over at midnight even when the series has not moved. */
  srDaily: null,
  scale: null, preset: "trade",
  evfilter: "tradeable", // tradeable | all
  // Chart viewport: count = visible bars (null = auto default), offEnd =
  // bars panned back from the newest. Zoom changes count, drag changes
  // offEnd; the fetch always keeps the full series underneath.
  view: { count: null, offEnd: 0 },
  /* THE QUIET DEFAULT. Measured at 1728x1000 (three forced drawChart calls):
     this literal gives the price pane 554 x 332.8 = 52.8% of the canvas;
     all thirteen on gives it 450.8 x 180.4 = 23.3%. See toggleQuiet for the
     rest of the arithmetic and for the q key that reaches 66.2%.

     Every `false` below is a cut with a number behind it, not a taste:
       ema/boll/vwap  three overlapping smoothed-price curves whose head tags
                      lose 3 of 3 lane claims — the layer is unnamed on glass
       cvd            1.39% cover for 15.7% of the all-on view's attention
                      mass, and it draws flow-divergence, recorded NO_GO at
                      n=44,177 (sibling minute-flow-direction NO_GO at
                      n=60,452, fee 17x the edge). Decoration with a cost.
       rsi/macd       with cvd they take priceB 128 -> 290px = 59% of height
       fp             duplicates the delta strip; its box is the one plate
                      outside the lane allocator and overlaps an S/R label on
                      32 of 140 bars
       heat           the single largest ink contributor in the all-on view
       vp             its own oracle is NEGATIVE with perfect foresight
                      (-2.71pp, CI [-5.0,-0.4]); costs 64.9px of left gutter
     None of them is deleted — every one is a button and a palette entry
     away, and the NO_GO verdicts are recorded elsewhere in the terminal.

     `sr` is now TRUE — the pending promotion recorded here has landed. It
     is no longer the fractal method (which retained 7.5% of its levels
     across an interval change and dropped 1 of 3 of its own price labels);
     it is calendar-anchored prior-period extremes, whose levels are the same
     prices at every interval and every scroll position by construction
     (Jaccard 1.000). It is on by default because it costs a measured median
     of 4 full-width lines in a 150-bar 4h view (2 on 1h, max 6 anywhere,
     CTX_MAX_WIDE), each one NAMED, against the 6 moving unnamed ones it
     replaces. It is not on because it predicts: it does not, and the legend
     says so on the glass. See priorPeriodLevels. */
  inds: { ema: false, boll: false, vwap: false, sr: true, vp: false, wh: true, news: true,
          /* vp and book are the RIGHT COLUMN's two tenants and are mutually
             exclusive (see the layout block and the #indbtns handler). Both
             default off, so the column reserves nothing and the price plot
             keeps the 84px: the in-canvas raw book was on by default and was
             measured drawing 40 levels into a 6.0px band, 3px from a legible
             copy of the same book in #sidebook. `vol` is the volume/delta
             overlay, on by default — it costs no reserved height, and before
             this it had no toggle at all. */
          book: false, vol: true,
          /* CVD IS ON BY DEFAULT (2026-08-19). The owner asked for it back,
             and it was never broken — this is the volume profile's failure a
             SECOND time: a working layer, default off, with nothing on the
             glass saying it existed. The server holds 299 hourly buckets /
             139h of BTC tape and the pane draws it correctly.

             WHAT IT COSTS, measured at this desk (1728x1000, DEFAULT preset,
             the sr+whale+volume set, frames FORCED because rAF does not fire
             in the verification pane): the price plot goes 638 x 420.0 =
             267,960 px2 -> 638 x 340.4 = 217,175 px2. WIDTH IS UNCHANGED — a
             sub-pane costs height only — height -79.6px, area -19.0%. That
             is the same order as the SCAN desk preset (-19.0%), which this
             terminal already ships as a one-key choice, and it is one press
             of C or one click on the CVD button from being given back. Set
             against it: this is the tape that produced every candle above
             it, and the alternative on offer was leaving it invisible.

             ONE LITERAL IS ENOUGH HERE, and that was CHECKED rather than
             assumed — promoteSrLevels and retireCanvasBook exist precisely
             because loadInds spreads a saved blob OVER these defaults, and
             both of their comments warn that flipping the literal alone
             would ship a silent no-op. Measured in this profile:
             `hlterm_inds` is ABSENT (localStorage holds hlterm_screen,
             hlterm_rightcol_v1, hlterm_preset, hlterm_inds_quiet_v1,
             hlterm_sr_prior_v1, hlterm_alerts_seen and hlterm_burnfired,
             and nothing else), and state.inds read back equal to this
             literal field for field. So the flip lands.

             NO ONE-SHOT MIGRATION IS ADDED, and the consequence is stated
             rather than hidden: every one of those helpers writes
             hlterm_inds, and this pass is not permitted to write
             localStorage. A profile that HAS saved a layer set therefore
             keeps its own choice — which is the correct default behaviour
             anyway — and for that reader the affordance is the coverage
             badge on the CVD button (see indCoverage), which says how many
             hours of tape are waiting whether the layer is on or off. */
          heat: false, cvd: true, fp: true, rsi: false, macd: false,
          // The expected-move band used to be the ONE layer on the canvas
          // with no toggle at all — gated only on the event feed returning a
          // row. Measured, it was 86% of the ink in the default view: a
          // ±1.19% ONE-DAY estimate for an OPEX 8 days out, painted as a
          // solid wash across all 140 PAST bars. Default off: a calendar
          // entry is not a chart mark until you ask for it.
          ev: false },
  heat: { coin: null, sig: null, snaps: [], live: null, at: 0, bucketW: 0, err: null },
  alerts: [],
  // The owner's OWN fires (price, burn, buyback monitors), kept in this
  // browser. The server's log is a 200-row ring the whale sweep overruns in
  // ~56h, so it is not a record of what HE was told. See MYFIRES_KEY.
  myFires: [],
  alertFilter: "all",     // all | mine | whales — applies to the telegram log
  movers: null,
  /* Why an ERROR string and not just an overwritten `movers`: the server
     answers a failed route with HTTP 200 + {error} (do_GET's catch-all), so
     `r.ok` is no evidence of a movers payload. Assigning the error object
     straight into state.movers threw inside renderMovers/renderFundTab on
     m.gainers.length and left the PREVIOUS tab's rows sitting under the new
     tab's header — measured data for a market it never described. Last good
     survives; this says the refresh is failing. */
  moversErr: null,
  whales: null,          // /api/whales payload
  whalesError: null,
  // dex -> the SERVER's sentence for "resting orders are not fetched on this
  // venue", fetched once per uncovered dex from /api/whales?coin=<a coin
  // there>. The sweep-wide payload carries orders_covered but not the
  // sentence, and an empty order list on a venue nobody fetched must never
  // be printed as "nothing is resting".
  whOrdersWhy: {},
  sides: null,           // /api/sides payload for the selected instrument
  sidesAt: 0,            // WHEN that payload landed. A pane that keeps drawing
                         // the last good payload while the server is down has
                         // to be able to say how old it is.
  sidesError: null,
  sidesBook: null,       // aggregated ladder book, own 3s refresh
  sidesBookErr: null,    // {coin, msg, at} — a failed ladder poll is a fact
  depth: {},             // coin -> {imb, chg_1h, band_bps, h, stale}
  events: [],            // cached for chart event-band lookup
  /* THE SLOW PANELS' OWN BOOKKEEPING — see loadSlow().
     EVENT RADAR / NEWS / RESEARCH refresh every 120s from three local routes
     that used to share one Promise.all and one silent catch, with no record
     anywhere of when each last SUCCEEDED. A local-server-down or restart
     window therefore left all three presenting hours-old content with a
     current face. Per route: {at: ms of the last good read or null, err: the
     last failure or null}. `at: null` means NEVER — the state a boot-time
     failure leaves a panel in, and the one thing an age chip must not print
     as a number.

     TWO ROUTES, not three: the `funding` slot went with renderFunding() and
     its vanished #funding-strip (2026-08-18). An empty slot for a route
     nothing fetches is a freshness record for a panel that does not exist,
     which is the same lie in miniature. */
  slow: { events: {}, research: {} },
  trades: [],            // time & sales for selected coin
  /* NEWEST PRINT STAMP this page's own websocket has seen for tradeSeenCoin —
     the exchange's t.time, the very field the server's flow_collector buckets
     on (flow_collector.py:235 `ms = int(t["time"])`), so a stamp here and a
     bucket boundary from the payload are the SAME clock and may be compared.
     It exists so the AGGRESSOR FLOW block can tell "the server's collector
     recorded nothing" apart from "this market did not trade" — two different
     claims, answerable because the pane has two independent feeds.
     Deliberately NOT the arrival time: subscribing to a coin backfills recent
     prints, so arrival says only when we asked. Measured live on xyz:ARM at
     23:32:45 IST — a print that ARRIVED 30s earlier was STAMPED 23:25:10, and
     dating it by arrival made the pane announce a trading market whose last
     print was seven minutes old. Cleared on coin switch: a stamp from before
     we subscribed to this coin is not a measurement of it. */
  tradeSeenMs: 0,
  tradeSeenCoin: null,
  hover: null,           // crosshair candle index
};

/* Product renamed to "Terminal V" (2026-08-15). Every localStorage key
 * deliberately KEEPS its historical "hlterm_" prefix (hlterm_watch,
 * hlterm_alerts, hlterm_ruler, hlterm_layouts, ...): the keys are
 * persisted user state, not branding — renaming them would silently
 * wipe the owner's saved watchlists, alerts, rulers and layouts. */
/* user watchlist edits persist locally; merged over server defaults */
function loadCustomWatch() {
  try { return JSON.parse(localStorage.getItem("hlterm_watch") || "null"); }
  catch (e) { return null; }
}
function saveCustomWatch() {
  localStorage.setItem("hlterm_watch",
    JSON.stringify({ crypto: state.watchCrypto, equity: state.watchEquity }));
}

/* ---------------- clock + connection ---------------- */
setInterval(() => {
  $("clock").textContent =
    new Date().toLocaleTimeString("en-IN", IST) + " IST";
  const age = (Date.now() - state.lastTickAt) / 1000;
  const dot = $("cdot"), txt = $("conntxt");
  if (state.lastTickAt && age < 15) { dot.className = "cdot live"; txt.textContent = "LIVE"; }
  else if (state.lastTickAt) { dot.className = "cdot"; txt.textContent = "STALE " + Math.floor(age) + "S"; }
}, 1000);

/* ---------------- number formatting ---------------- */
function fmtPx(x) {
  if (x == null || isNaN(x)) return "–";
  const v = +x;
  if (v >= 10000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (v >= 100) return v.toFixed(2);
  if (v >= 1) return v.toFixed(3);
  return v.toPrecision(4);
}
/* ONE funding colour convention. Six sites used to disagree: four painted
   positive funding green (price-up styling), two red — the FUND badge and
   its own rows contradicted each other 30px apart. Semantic now everywhere:
   positive = longs PAY (crowded long) = .pay; negative = shorts pay =
   .earn. Same cashflow reading the PORT pane already used. */
function fundingClass(v) {
  if (v == null) return "fl";
  return v >= 0 ? "pay" : "earn";
}

/* Dollar-denominated big numbers. OI arrives as a TOKEN count and was
   rendered identically to dollar volume ("OI 37.4K · VOL 1.41B") — 37K BTC
   is $2.4B. Everything user-facing shows notional with a $ prefix. */
function fmtUsd(x) {
  return x == null || isNaN(x) ? "–" : "$" + fmtBig(x);
}

function oiUsd(ctx) {
  if (!ctx || ctx.open_interest == null) return null;
  const px = ctx.mark_px != null ? ctx.mark_px : ctx.mid_px;
  return px ? ctx.open_interest * px : null;
}

/* US-calendar "today". Event dates are US calendar dates; bucketing them
   against the IST date made every after-close US event unrenderable from
   00:00-09:30 IST — precisely while it was happening. Mirrors
   signals.market_today() server-side. */
function etDate(offsetDays) {
  return new Date(Date.now() + (offsetDays || 0) * 86400000)
    .toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/* Basis points, at the precision the number can actually support. A book
   that reaches 3.09 bps and one that reaches 308 bps are the same statement
   at different scales, and rounding the first to "3" throws away the digit
   that says the ladder is a sliver. So: 2dp under 10, 1dp under 100, integer
   above — never more digits than the reach justifies, never fewer. */
function fmtBps(x) {
  const v = Math.abs(+x || 0);
  return v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : String(Math.round(v));
}

function fmtBig(x) {
  if (x == null || isNaN(x)) return "–";
  const v = +x;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return v.toFixed(0);
}
function pct(cur, prev) {
  if (!cur || !prev) return null;
  return (cur - prev) / prev * 100;
}

/* The chart's palette lives in CC (see "canvas palette" below). A THEME
   object used to cache --grn/--red/--amber2/--dim off the document element
   for the canvas to read; CC replaced every one of its call sites and the
   definition was left behind reading four CSS variables nothing consumed.
   Deleted. The CSS variables themselves still drive the DOM side of the
   terminal, and --grn/--red hold the SAME pair as CC.up/CC.down so a bid in
   the sidebar book and a bid in the chart gutter are one colour. */
/* #rrggbb + alpha, with a pass-through for any non-hex token form. */
function alpha(c, aa) {
  return (c && c[0] === "#" && c.length === 7) ? c + aa : c;
}

/* ---------------- watchlist ---------------- */
function baseSym(coin) { return coin.includes(":") ? coin.split(":")[1] : coin; }

function ctxFor(coin) {
  return state.universe.crypto[coin] || state.universe.equity[coin];
}

const HEAD_WATCH =
  "<tr><th></th><th>SYM</th><th class='r'>LAST</th><th class='r'>24H%</th>" +
  "<th class='r'>FUND/8H</th><th class='r'>OI</th>" +
  "<th class='r' title='resting book at the reference band: bar is the BID " +
  "share (left = bids, right = asks), number is the 1h change in total " +
  "resting size. Blank means the depth collector does not cover this market " +
  "— not that the book is balanced. Resting size is cancellable.'>SIDE</th></tr>";

/* The 32px SIDE cell. Same three-channel encoding as the BOTH SIDES pane and
   the whale rail: direction from the waterline first, texture second, hue
   last. depth_imb is +1 all bid / -1 all ask. */
function watchSideCell(coin) {
  const d = (state.depth || {})[coin];
  if (!d || d.stale || d.imb == null) {
    /* THREE different facts wore one sentence. "not in the depth collector"
       is permanent until the process restarts (36/36 slots, add-only ratchet);
       "its last sample is stale" is transient and may clear on the next tick;
       "in the collector but no reading at this band" is a third thing again.
       The owner would act differently on each, and the payload can tell them
       apart — a coin absent from state.depth is not subscribed, a coin present
       with stale:true is subscribed and behind. The safe half of the old
       string (blank ≠ balanced) is kept in all three. */
    const ds = state.depthSlots;
    const why = !d
      ? `${coin} is NOT in the depth collector` +
        (ds && ds.slots_pressure
          ? ` — all ${ds.subscribed} of ${ds.max_coins} slots are in use and the set is ADD-ONLY until the server restarts, so this will not fill in on its own`
          : ` — nothing is being recorded for it`) +
        `. No past hour can ever be backfilled.`
      : d.stale
      ? `${coin} IS in the depth collector but its last sample is STALE — this is a transient gap that may clear on the next tick, not a market with no book`
      : `${coin} is collected (${d.h}h) but has no reading at the ±${d.band_bps}bps band right now`;
    return `<td class="r fl wt-side" title="${esc(why)} Blank here means NOT ` +
      `MEASURED, not balanced and not zero.">–</td>`;
  }
  const bid = (1 + d.imb) / 2, ask = 1 - bid;
  const chg = d.chg_1h;
  return `<td class="r wt-side" title="±${d.band_bps}bps: bids ` +
    `${Math.round(bid * 100)}% / asks ${Math.round(ask * 100)}%` +
    (chg == null ? " · 1h change needs an hour of history and cannot be backfilled"
                 : " · total resting size " + (chg >= 0 ? "+" : "") + chg.toFixed(0) + "% in 1h") +
    ` · ${d.h}h collected · resting size is cancellable">` +
    `<span class="sd-rail wt-rail">` +
    `<span class="sd-b l" style="width:${(bid * 50).toFixed(1)}%"></span>` +
    `<span class="sd-b r" style="width:${(ask * 50).toFixed(1)}%"></span></span>` +
    `<i class="${chg == null || Math.abs(chg) < 0.5 ? "fl" : sdCls(chg)}">` +
    // "-0" is not a reading. Anything inside half a point is flat.
    `${chg == null ? "–" : Math.abs(chg) < 0.5 ? "0"
      : (chg >= 0 ? "+" : "") + chg.toFixed(0)}</i></td>`;
}
const HEAD_MOVERS =
  "<tr><th>SYM</th><th class='r'>LAST</th><th class='r'>24H%</th><th class='r'>VOL 24H</th></tr>";
const HEAD_FUND =
  "<tr><th>SYM</th><th class='r'>LAST</th><th class='r'>FUND/8H</th>" +
  "<th class='r' title='HL minus CEX-median funding, APR points'>DISLOC</th>" +
  "<th class='r'>VOL 24H</th></tr>";

const FACTOR_LABEL = {
  momentum: "momentum", funding: "funding", catalyst: "catalyst",
  insider: "insider", desk: "desk", technical: "trend",
};

/* The score says how many factors agree RIGHT NOW. This says whether that
   kind of setup ever made money in the walk-forward record — the question a
   score silently invites you to assume it answered. NO-GO is the important
   case: it means the family was tested and rejected, not merely unproven. */
function edgeBadge(e) {
  if (!e) return "";
  const v = e.verdict;
  const bits = [];
  if (e.expectancy_r != null)
    bits.push((e.expectancy_r >= 0 ? "+" : "") + e.expectancy_r.toFixed(3) + "R/trade");
  if (e.win_rate != null) bits.push(e.win_rate.toFixed(0) + "% WR");
  if (e.n) bits.push("n=" + e.n);
  const tip = (e.label || "") + " — " + (v === "validated" ? "VALIDATED" :
      v === "no-go" ? "TESTED AND REJECTED" : "NEVER TESTED") +
    (bits.length ? "\n" + bits.join(" · ") : "") +
    (e.method ? "\nmethod: " + e.method : "") +
    (e.note ? "\n\n" + e.note : "") +
    (e.caveat ? "\n\ncaveat: " + e.caveat : "") +
    (e.age_days != null ? "\n\nverdict is " + e.age_days + " days old" +
      (e.stale ? " — STALE, decay is plausible and nothing re-checks it" : "") : "") +
    "\n\nrecorded research, not recomputed live";
  const txt = v === "validated"
    ? "EDGE " + (e.expectancy_r != null ? (e.expectancy_r >= 0 ? "+" : "") +
        e.expectancy_r.toFixed(2) + "R" : "")
    : v === "no-go" ? "NO-GO" : "UNTESTED";
  return `<span class="sg-edge ev-${esc(v)}${e.stale ? " stale" : ""}" ` +
    `title="${esc(tip)}">${esc(txt)}</span>`;
}

function renderSignals() {
  $("whead").innerHTML = "";
  $("watch-meta").textContent = "COMPOSITE SETUP SCORE";
  const d = state.signals;
  if (!d) { $("wbody").innerHTML = '<tr><td class="empty">loading…</td></tr>'; return; }
  if (d.status === "warming") {
    $("wbody").innerHTML = '<tr><td class="empty">scoring universe…</td></tr>';
    return;
  }
  const rows = d.signals || [];
  if (d.error) {
    $("wbody").innerHTML = `<tr><td class="empty">signals error: ${esc(d.error)}</td></tr>`;
    return;
  }
  if (!rows.length) { $("wbody").innerHTML = '<tr><td class="empty">no signals</td></tr>'; return; }
  const max = rows[0].score || 1;
  const es = d.edge_summary || {};
  const edgeLine = (es.validated || es["no-go"] || es.untested)
    ? `<div class="sig-edge-sum">` +
      `<b class="ev-validated">${es.validated || 0}</b> validated · ` +
      `<b class="ev-nogo">${es["no-go"] || 0}</b> tested NO-GO · ` +
      `<b class="ev-untested">${es.untested || 0}</b> untested` +
      `<i>score = confluence now; verdict = did this family ever work</i></div>`
    : "";
  const meta = `${d.universe_scored} scored on 5 factors` +
    (d.trend_enriched ? ` · trend read on ${d.trend_enriched}` : "") +
    (d.events_ok === false ? " · CALENDAR DOWN" : "");
  const html = rows.map((r) => {
    const dir = r.direction || "";
    const why = (r.top_factors || []).map((f) => FACTOR_LABEL[f] || f).join(" + ");
    const badges = (r.badges || []).map((b) =>
      `<span class="badge ${b.tag.replace(/[^A-Z]/g, "")}" title="${esc(b.why)}">${esc(b.tag)}</span>`).join("")
      + buybackBadge(r.coin);
    const tip = Object.entries(r.factors).filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${FACTOR_LABEL[k] || k} ${v}`).join(" · ") +
      (r.catalyst ? `\n${r.catalyst.type} in ${r.catalyst.days}d ±${r.catalyst.move_pct}%` : "") +
      (r.insider ? `\ninsider: ${r.insider.n}x $${fmtBig(r.insider.usd)}` : "") +
      (r.desk ? `\ndesk: ${r.desk.state} (interest ${r.desk.interest}/10, uncalibrated)` +
        (r.desk.age_days != null ? ` · card ${r.desk.age_days}d old` +
          (r.desk.recency_factor < 1 ? ` (weight x${r.desk.recency_factor})` : "") : "") : "") +
      (r.trend ? `\ntrend: ${r.trend} (context only, not scored)` : "") +
      `\nvol $${fmtBig(r.volume)}${r.thin ? " (thin)" : ""}`;
    const sel = r.coin === state.sel ? " sel" : "";
    return `<div class="sig-row${sel}" data-coin="${esc(r.coin)}" title="${esc(tip)}">` +
      `<span class="sg-sym">${esc(baseSym(r.coin))}</span>` +
      `<span class="sg-bar"><span class="sg-fill" style="width:${Math.round(r.score / max * 100)}%"></span></span>` +
      `<span class="sg-score">${Math.round(r.score)}</span>` +
      `<span class="sg-dir ${esc(dir)}">${esc(dir.toUpperCase())}</span>` +
      edgeBadge(r.edge) +
      (badges ? `<span class="sg-badges">${badges}</span>` : "") +
      `<span class="sg-why">${esc(why)}</span>` +
      (r.thin ? '<span class="sg-thin" title="thin book — check liquidity before sizing">THIN</span>' : "") +
      `<span class="i-dossier" title="open dossier">⋯</span>` +
      `</div>`;
  }).join("");
  $("wbody").innerHTML =
    `<tr><td style="white-space:normal;overflow:visible">` +
    `<div class="sig-meta">${esc(meta)}</div>${edgeLine}${html}</td></tr>`;
  document.querySelectorAll(".sig-row").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.classList.contains("i-dossier")) openDossier(el.dataset.coin);
      else selectCoin(el.dataset.coin);
    };
  });
}

/* Retries on failure and SAYS so when it cannot recover.

   This used to be `catch (e) { /* keep last *\/ }` with a 1-hour poll: one
   failed load left the BURN tab on its loading placeholder until the next
   hourly tick, and a failed FIRST load left it there forever with nothing to
   "keep". A single malformed response (a bare `Infinity`, which JSON.parse
   rejects) bricked the panel until a manual reload, with no console error and
   no visible reason. Silent give-up is the bug, not the parse error. */
const BUYBACK_RETRY_MS = [5000, 15000, 60000, 300000];

/* Live AF buy tape. Polls fast and separately from loadBuyback, whose payload
   is a 15-minute snapshot by design — merging them would make one of the two
   wrong. */
async function loadBuyflow() {
  try {
    const r = await fetch("/api/buyflow");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    // A failed route answers HTTP 200 + {error} here, so r.ok proves only that
    // the socket worked. Routed into the catch, the bar says the tape failed;
    // assigned as a payload it would have read as a quiet tape.
    if (d && d.error) throw new Error(d.error);
    state.buyflow = d;
    if (state.wtab === "burn") renderBurnTab();
  } catch (e) {
    state.buyflow = { ok: false, error: (e && e.message) || String(e) };
  }
}

async function loadBuyback(attempt) {
  attempt = attempt || 0;
  try {
    const r = await fetch("/api/buyback");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    if (d.status === "warming") { setTimeout(() => loadBuyback(0), 10000); return; }
    /* A TOTAL BUILD FAILURE ARRIVES AS HTTP 200 + {error} AND AN EMPTY
       `programs` LIST. Unread, it rendered as zero programmes under a
       "checked just now" freshness chip — the chip's stated reason for
       existing, inverted: the one control on this pane that is supposed to
       catch a burn tab that silently stopped updating was reporting success
       while producing nothing. Routed into the catch it becomes the failure
       sentence renderBurnTab already knows how to draw, the retry ladder
       already knows how to schedule, and the chip below reads. */
    if (d.error) throw new Error(d.error);
    const m = {};
    for (const p of d.programs || []) m[p.token] = p;
    state.buyback = m;
    state.buybackOffVenue = d.off_venue || {};
    state.buybackFresh = d.fresh || {};
    state.buybackError = null;
    if (state.wtab === "signals") renderSignals();
    if (state.wtab === "burn") renderBurnTab();
    checkBurnAlerts();
    renderIntel();
  } catch (e) {
    state.buybackError = (e && e.message) || String(e);
    // Show the failure rather than an eternal "loading…", then back off and
    // keep trying — the next hourly tick is far too long to wait.
    if (state.wtab === "burn") renderBurnTab();
    const wait = BUYBACK_RETRY_MS[Math.min(attempt, BUYBACK_RETRY_MS.length - 1)];
    setTimeout(() => loadBuyback(attempt + 1), wait);
  }
}

/* Burn / buyback pressure measured against actual sell flow.

   Supply removal only matters relative to what is being sold into. The burn
   figure is measured (supply delta x price); the buyback figure is the
   protocol's reported spend and is labelled as such. Sell flow uses the live
   tape's sell share when we have it for this symbol, else a 50% assumption
   that is stated rather than hidden. */
/* WHICH PROGRAMMES ARE ACTUALLY BEING WATCHED — the owner's own question,
   and the BURN tab had no answer anywhere on it.

   /api/alerts ships `monitors` (6 rows) AND `n_programs` (14). The client
   rendered the rows and never read the count, so the eight programmes with no
   server-side monitor drew EXACTLY like the six with one, and their silence
   read as "nothing happened" rather than "nobody looked". Measured
   2026-08-19: monitored = HYPE JUP PUMP CAKE ASTER VVV; unmonitored = AAVE
   BNB DYDX ETHFI LIT SKY UNI WLFI — and BNB was on screen burning $59.3K/day
   with nobody watching it.

   The split is THREE-way, not two, because "unmonitored" covers two different
   facts. AAVE / DYDX / ETHFI / SKY are unmonitored AND no-burn-by-design:
   there is nothing for a burn-slowdown rule to watch. BNB / LIT / UNI / WLFI
   burn and are unmonitored — those are the genuinely unlooked-at ones, and
   they are the only rows that should be loud.

   `null` means the monitor feed itself has not answered. A missing feed must
   NOT render as "not monitored" in either direction — an unknown watch state
   is not a measured absence of one. */
function burnMonitors() {
  if (state.alertFeedError || !state.alertFeed) return null;
  const mons = state.alertFeed.monitors;
  if (!Array.isArray(mons)) return null;
  const by = {};
  for (const m of mons) if (m && m.token) by[String(m.token).toUpperCase()] = m;
  return { by, n: mons.length,
           // n_programs is the server's own count of programmes it holds, and
           // is what makes "6 of 14" sayable at all. Falls back to the number
           // of programme cards this client actually has, never to a guess.
           total: state.alertFeed.n_programs != null
             ? state.alertFeed.n_programs
             : Object.keys(state.buyback || {}).length,
           err: state.alertFeed.monitors_error ||
                state.alertFeed.programs_error || null,
           // `server_time` is /api/alerts' own stamp; the age counts it plus
           // this page's hold, so a monitor feed that quietly stopped
           // answering ages on screen instead of standing still.
           ageS: state.alertFeed.server_time != null
             ? Math.max(0, Date.now() / 1000 - state.alertFeed.server_time)
             : null };
}

/* Per-row chip. Silence is only meaningful once you know whether anyone was
   listening, so every programme row states its watch status or states that
   the status is unknown — never nothing. */
function burnWatchChip(tok, p) {
  const mm = burnMonitors();
  if (!mm) return '<span class="brn-watch unk" title="the monitor feed ' +
    '(/api/alerts) has not answered, so whether this programme is watched ' +
    'server-side is UNKNOWN here — not a measured no">WATCH?</span>';
  const m = mm.by[String(tok).toUpperCase()];
  if (m)
    return '<span class="brn-watch on" title="' +
      esc("watched server-side, with the browser closed — " +
        (m.detail || m.rule || "buyback slowdown rule") +
        (m.state_ ? " · currently " + m.state_.toUpperCase() : "")) +
      '">WATCHED</span>';
  const design = p && p.no_burn_by_design;
  return '<span class="brn-watch ' + (design ? "off" : "hot") + '" title="' +
    esc("NO server-side monitor for " + tok + " (" + mm.n + " of " + mm.total +
      " programmes are watched). " + (design
        ? "This programme does not burn by design — " + design +
          " — so a burn-slowdown rule has nothing to watch here, and a quiet " +
          "row is expected."
        : "This programme DOES remove supply, and nothing is watching it. A " +
          "quiet row here means nobody looked, not that nothing happened.") +
      (mm.err ? " Part of the monitor set also failed to build: " + mm.err : "")) +
    '">NOT WATCHED</span>';
}

function burnMeter(coin) {
  const p = buybackFor(coin);
  if (!p) return null;
  const r = p.realised || {};
  const ctx = ctxFor(coin) || {};
  const px = state.mids[coin] != null ? +state.mids[coin] : ctx.mid_px;
  // Global 24h volume, because the burn itself is global. Falling back to
  // Hyperliquid-only volume would inflate the ratio for any token that mostly
  // trades elsewhere, so the fallback is labelled rather than silent.
  const gVol = p.global_vol24h || 0;
  const dayVol = gVol || ctx.day_volume || 0;
  const volSrc = gVol ? "global 24h vol" : "HL 24h vol only";
  if (!px || !dayVol) return null;

  let sellShare = 0.5, shareSrc = "assumed 50/50";
  if (state.flow.coin === coin && state.flow.recent.length > 20) {
    const b = flowBalance();
    if (b.tot > 0) { sellShare = b.sell / b.tot; shareSrc = "live tape"; }
  }
  const sellUsdDay = dayVol * sellShare;
  const meas = p.measured || {};
  // One inventory, one flow. A live fund (HYPE fills / LIT Account #0) is
  // the buy-pressure number; do not add a 30d sink smear or a small
  // fee/gas burn on top of it. Never annualise a quarterly batch as /d.
  const fundLive = !!(p.holdings && p.holdings.rate)
    || !!(p.bid && /fill|fund delta|wallet delta/i.test(p.bid.basis || ""));
  const burnTokDay = fundLive ? 0
    : (meas.burn_1d > 0 ? meas.burn_1d
       : (meas.avg_per_day_7d > 0 ? meas.avg_per_day_7d : 0));
  const burnUsdDay = burnTokDay * px;
  // Prefer what the fund actually spent over what the team said it spends.
  // HYPE's press figure is $1.9M/day; its own fills say $1.3M/day.
  const measuredBuy = p.bid && p.bid.usd_day != null ? p.bid.usd_day
    : (p.bid && p.bid.tokens_day != null && px ? p.bid.tokens_day * px : null);
  // For a burn programme the bid IS the burn — they buy, then destroy. Adding
  // both counted one flow twice and doubled the absorption bar.
  const bidIsBurn = !!(p.bid && /burn/i.test(p.bid.basis || ""));
  const buyUsdDay = bidIsBurn ? 0
    : (measuredBuy != null ? measuredBuy : (p.reported_buyback_usd_day || 0));
  const buySrc = bidIsBurn ? "counted as burn"
    : (measuredBuy != null ? (p.bid.basis || "measured") : "reported");
  return {
    burnUsdDay, buyUsdDay, sellUsdDay, sellShare, shareSrc, volSrc, gVol,
    burnPct: sellUsdDay ? burnUsdDay / sellUsdDay * 100 : 0,
    buyPct: sellUsdDay ? buyUsdDay / sellUsdDay * 100 : 0,
    totalPct: sellUsdDay ? (burnUsdDay + buyUsdDay) / sellUsdDay * 100 : 0,
    burnTokDay, buySrc,
    measured: !!r.active_burn || burnTokDay > 0, spanExact: r.span_exact,
  };
}

function burnMeterHtml(coin) {
  const m = burnMeter(coin);
  if (!m) return "";
  const w = (pct) => Math.max(0, Math.min(100, pct));
  const verdict = m.totalPct >= 25 ? ["ABSORBING", "up"]
    : m.totalPct >= 5 ? ["MATERIAL", "rg-neutral"]
    : ["MARGINAL", "dn"];
  return `<div class="bm">` +
    `<div class="bm-head"><span>BURN + BUYBACK vs SELL FLOW</span>` +
    `<b class="${verdict[1]}">${verdict[0]} ${m.totalPct.toFixed(2)}%</b></div>` +
    `<div class="bm-track" title="green = measured burn, second bar = buyback ` +
    `(${esc(m.buySrc)}), bar length is share of daily sell flow">` +
    `<span class="bm-burn" style="width:${w(m.burnPct)}%"></span>` +
    `<span class="bm-buy" style="width:${w(m.buyPct)}%"></span></div>` +
    `<div class="bm-legend">` +
    `<span class="up">burn $${fmtBig(m.burnUsdDay)}/d${m.measured ? "" : " (none measured)"}</span>` +
    (m.buyUsdDay ? `<span class="${m.buySrc === "reported" ? "rg-neutral" : "up"}">` +
      `buyback $${fmtBig(m.buyUsdDay)}/d ${esc(m.buySrc)}</span>` : "") +
    `<span class="fl">sell flow $${fmtBig(m.sellUsdDay)}/d · ${esc(m.shareSrc)}</span>` +
    `</div></div>`;
}

/* Burn alerts. Two independent triggers, both of which the user asked for:
     ABSORBING — burn+buyback outruns live sell flow (supply removal wins)
     UNUSUAL   — burn rate well above this token's own trailing baseline
   The anomaly leg stays silent until there is enough history to have a
   baseline; calling noise an anomaly on day two would be worse than quiet. */
const BURN_ABSORB_TRIGGER = 100;   // % of daily sell flow
const BURN_UNUSUAL_RATIO = 2.0;    // x its own trailing median
/* Hysteresis re-arms as soon as the ratio dips under 80% of the trigger,
   which on a THIN-FLOW token is every few minutes: LIT fired 11 times in
   four hours (130%-604%) because its sell flow is small enough that the
   ratio crosses the band constantly. Absorption is a slow fact about
   supply, so rate-limit it the way the server-side alerts already are. */
const BURN_ALERT_COOLDOWN_MS = 6 * 3600 * 1000;
// A buyback that stops is a bid that vanishes. The holding level keeps looking
// healthy long after the flow dies, so alert on the RATE breaking down.
const BID_DROP_TRIGGER = 40;       // % below its own trailing median

function checkBurnAlerts() {
  for (const [tok, p] of Object.entries(state.buyback || {})) {
    const m = burnMeter(tok);
    const a = p.anomaly || {};
    const fired = state.burnFired[tok] || {};

    const coolOk = (k) => !(fired[k + "_at"] &&
      Date.now() - fired[k + "_at"] < BURN_ALERT_COOLDOWN_MS);
    if (m && m.totalPct >= BURN_ABSORB_TRIGGER && !fired.absorb && coolOk("absorb")) {
      fireBurnAlert(tok, "ABSORBING",
        `burn+buyback ${m.totalPct.toFixed(0)}% of sell flow ` +
        `($${fmtBig(m.burnUsdDay + m.buyUsdDay)}/d vs $${fmtBig(m.sellUsdDay)}/d sell)`);
      fired.absorb = Date.now();
      fired.absorb_at = Date.now();
    } else if (m && m.totalPct < BURN_ABSORB_TRIGGER * 0.8) {
      delete fired.absorb;                       // hysteresis: re-arm below 80%
    }

    const tr = p.bid && p.bid.trend;
    if (tr && tr.ready && tr.sharp_drop && !fired.biddrop) {
      fireBurnAlert(tok, "BUYBACK SLOWING",
        `buying $${fmtBig(tr.usd_day)}/d — down ${tr.drop_pct.toFixed(0)}% from ` +
        `its $${fmtBig(tr.baseline_usd_day)}/d baseline (${tr.samples} samples, ` +
        `${tr.span_hours}h)`);
      fired.biddrop = Date.now();
    } else if (tr && tr.ready && tr.ratio > (1 - BID_DROP_TRIGGER / 100) * 1.2) {
      delete fired.biddrop;                      // re-arm once it recovers
    }

    if (a.ready && a.ratio >= BURN_UNUSUAL_RATIO && !fired.unusual && coolOk("unusual")) {
      fireBurnAlert(tok, "UNUSUAL BURN",
        `${a.ratio.toFixed(1)}x its trailing baseline ` +
        `(${fmtBig(a.latest_per_day)}/d vs ${fmtBig(a.baseline_per_day)}/d normal)`);
      fired.unusual = Date.now();
      fired.unusual_at = Date.now();
    } else if (a.ready && a.ratio < BURN_UNUSUAL_RATIO * 0.8) {
      delete fired.unusual;
    }
    state.burnFired[tok] = fired;
  }
  localStorage.setItem("hlterm_burnfired", JSON.stringify(state.burnFired));
}

function fireBurnAlert(tok, kind, detail) {
  const msg = `🔥 ${tok} ${kind} — ${detail}`;
  showToast(`${tok}: ${kind}`);
  beep();
  if (window.Notification && Notification.permission === "granted")
    new Notification("TERMINAL V · BURN", { body: msg });
  notifyAndSettle(msg, recordMyFire("burn", msg));
  state.burnEvents.unshift({ tok, kind, detail, at: Date.now() });
  state.burnEvents.length = Math.min(state.burnEvents.length, 20);
  if (state.wtab === "burn") renderBurnTab();
}

/* Short tag for the badge; the full mechanism lives in the tooltip/dossier. */
const BB_TAG = { "buyback-burn": "BUYBACK+BURN", "buyback-hold": "BUYBACK",
                 "buyback-treasury": "BUYBACK", "buyback-stake": "BUYBACK",
                 "buyback-lock": "BUYBACK", "burn": "BURN" };

function buybackFor(coin) { return state.buyback[baseSym(coin)] || null; }

function buybackBadge(coin) {
  const p = buybackFor(coin);
  if (!p) return "";
  const r = p.realised || {};
  const tip = `${p.detail}\nsource: ${p.source || "n/a"}` +
    (r.active_burn ? `\nMEASURED: supply falling ~${fmtBig(r.burn_per_day)}/day` :
     r.burned_vs_max ? `\nMEASURED: ${fmtBig(r.burned_vs_max)} below max supply` :
     r.note ? `\n${r.note}` : "");
  return `<span class="badge BUYBACK" title="${esc(tip)}">${esc(BB_TAG[p.kind] || "BUYBACK")}</span>`;
}

async function loadSignals() {
  try {
    const d = await fetch("/api/signals").then((r) => r.json());
    if (d.status === "warming") {
      if (!state.signals) state.signals = d;      // never overwrite real data
      setTimeout(loadSignals, 8000);              // poll in while the build runs
    } else {
      state.signals = d;
    }
    if (state.wtab === "signals") renderSignals();
    if (state.wtab === "burn") renderBurnTab();
    checkBurnAlerts();
    renderIntel();
  } catch (e) { /* keep last */ }
}

/* BURN tab — every buyback/burn programme side by side, so the meter is
   something you can scan rather than something buried in a dossier. */
/* Inline sparkline of effective (net) supply — the line that actually shows
   scarcity, as opposed to gross burn which flatters anything that mints. */
function supplySpark(series, w, h) {
  if (!series || series.length < 2) return "";
  const v = series.map((p) => p.eff);
  const lo = Math.min(...v), hi = Math.max(...v), span = (hi - lo) || 1;
  const x = (i) => (i / (series.length - 1)) * (w - 2) + 1;
  const y = (val) => h - 1 - ((val - lo) / span) * (h - 2);
  const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.eff).toFixed(1)}`).join(" ");
  const down = v[v.length - 1] < v[0];
  // One green in this terminal. CC.up / --grn moved to #4df09b so that an
  // up/bid/long mark is the BRIGHTER of the polarity pair under both
  // simulated dichromacies; a sparkline left on the old #20d67b would be a
  // second, near-identical green meaning the same thing 200px away.
  const col = down ? "#4df09b" : "#ff4d5e";     // falling supply = green
  return `<svg class="brn-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.2"/>` +
    `<circle cx="${x(series.length - 1).toFixed(1)}" cy="${y(v[v.length - 1]).toFixed(1)}" r="1.7" fill="${col}"/>` +
    `</svg>`;
}

/* Built separately from the programme rows because it polls on a 30s cadence
   while they refresh every 15 minutes. It used to sit after the early return
   for an empty programme list, which hid the one panel with actual urgency for
   the several minutes the report takes to warm. */
function buyflowBar() {
  const bf = state.buyflow;
  if (!bf || !bf.ok || !bf.windows) return "";
  const m60 = bf.windows.m60 || {}, m5 = bf.windows.m5 || {};
  const st = bf.state || "";
  const cls = st === "stepping in" ? "hot" : st === "quiet" ? "cold" : "";
  const recents = bf.recent || [];
  const lastMs = recents.length ? recents[0].ms : (bf.at ? bf.at * 1000 : null);
  const lastPrint = lastMs
    ? new Date(lastMs).toLocaleTimeString("en-GB", {
        timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false })
    : null;
  // Same fund as the row's "AF 24h fills". Two clocks. Do not voice this as NOW.
  return `<div class="bf-bar ${cls}">` +
    `<span class="bf-h">AF last 60m pace</span>` +
    `<b>$${fmtBig(m60.pace_usd_day || 0)}/d</b>` +
    `<span class="fl">` +
    (lastPrint ? `last print ${lastPrint} IST` : `no print in window`) +
    `</span>` +
    (bf.ratio_60m ? `<span class="bf-x">${bf.ratio_60m.toFixed(2)}x 30d</span>` : "") +
    (st ? `<span class="bf-state ${cls}">${esc(st.toUpperCase())}</span>` : "") +
    `<span class="fl">${bf.hour_fills || 0} fills/1h · $${fmtBig(bf.hour_usd || 0)}` +
    ` · last 5m $${fmtBig(m5.usd || 0)}</span></div>`;
}

/* ── SCREEN: cross-sectional screener + carry/basis ──────────────────────
   MOVERS and FUND are two hard-coded screens over the same table. This is
   the general form, in the units a decision is made in: funding as an
   annualised rate (a 0.01%/hr decimal means nothing until it is 88%/yr),
   basis in bps against the venue's own spot index, and OI change — which
   is what separates "new shorts piling in" from "shorts covering". */
const SCREEN_KEY = "hlterm_screen";

function screenState() {
  try {
    return JSON.parse(localStorage.getItem(SCREEN_KEY) || "null") ||
      { preset: "carry-long" };
  } catch (e) { return { preset: "carry-long" }; }
}

async function loadScreen(opts) {
  const cur = { ...screenState(), ...(opts || {}) };
  try { localStorage.setItem(SCREEN_KEY, JSON.stringify(cur)); } catch (e) { /* quota */ }
  const qs = new URLSearchParams();
  if (cur.preset) qs.set("preset", cur.preset);
  if (cur.sort) qs.set("sort", cur.sort);
  if (cur.desc === false) qs.set("desc", "0");
  for (const f of cur.filters || []) qs.append("f", `${f.field}:${f.op}:${f.value}`);
  try {
    const r = await fetch("/api/screen?" + qs.toString());
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    // 200 + {error} is a screen that did not RUN, not a screen that matched
    // nothing — and this pane's empty sentence ("no assets match this screen
    // right now") is a claim about the market.
    if (d && d.error) throw new Error(d.error);
    state.screen = d;
    state.screenError = null;
  } catch (e) {
    state.screenError = (e && e.message) || String(e);
  }
  if (state.wtab === "screen") renderScreenTab();
  if (state.wtab === "deep") { renderDeepTab(); const a = $("watch-add"); if (a) a.placeholder = "+ deep dive symbol"; }
}

const SCREEN_COLS = [
  ["chg_pct", "24H", (v) => (v == null ? "–" : (v >= 0 ? "+" : "") + v.toFixed(1) + "%"),
   (v) => (v == null ? "fl" : v >= 0 ? "up" : "dn")],
  ["funding_apr_pct", "APR", (v) => (v == null ? "–" : (v >= 0 ? "+" : "") +
    (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toFixed(0)) + "%"),
   fundingClass],
  ["disloc_apr", "DSLC", (v) => (v == null ? "–" : (v >= 0 ? "+" : "") + v.toFixed(0)),
   (v) => (v == null ? "fl" : Math.abs(v) < 15 ? "fl" : fundingClass(v))],
  ["basis_bps", "BASIS", (v) => (v == null ? "–" : (v >= 0 ? "+" : "") + v.toFixed(0) + "bp"),
   (v) => (v == null ? "fl" : Math.abs(v) > 15 ? "am" : "fl")],
  ["oi_chg_24h", "ΔOI", (v) => (v == null ? "–" : (v >= 0 ? "+" : "") + v.toFixed(0) + "%"),
   (v) => (v == null ? "fl" : v >= 0 ? "up" : "dn")],
  ["volume", "VOL", (v) => "$" + fmtBig(v), () => "fl"],
  /* BOOK and ORD ARE THE TWO COLUMNS A CLIP IS SIZED AGAINST, and neither
     had ever been on screen anywhere in this terminal. The screener computes
     fifteen depth figures per row from the persisted L2 store; three of them
     had a column, and only when a depth field happened to be the sort key —
     so under the owner's saved preset (carry-long, sorts on funding) not one
     of them was visible. depth_usd measured $109.65M for BTC and was
     0-reference in 823KB of client.

     depth_usd is the dollar size of the resting book; depth_ord_usd is the
     MEDIAN resting order inside it, which is what says whether a $5-10k clip
     meets one order or twenty. Unconditional because they are execution
     facts, not a screen: this is where a stop slips and how big a clip the
     book takes, and the edge registry has no entry that makes book depth
     directional. A blank cell is "this market is not in the depth collector",
     never "no depth" — the footer says so, and a stale row is amber rather
     than being dropped. */
  /* ONE column, not two, and the width is why. MEASURED at the pane's real
     369px: two extra columns pulled every cell to 35px and clipped VOL's own
     "$686.8M" to 40>35 — a truncated dollar figure is worse than an absent
     one, and breaking an existing column to add a new one is not a trade this
     desk makes. depth_ord_usd rides in the tooltip instead, where it costs
     nothing; the depth PRESETS still add their three columns on top, which
     was already tight before this pass and is unchanged by it.

     fmtBig gives "$123.3M" (40px). This drops to three significant figures —
     "$123M" — because the question this column answers is "does the book take
     my clip", and nobody sizes a $5-10k clip off the third digit of $123M. */
  ["depth_usd", "BOOK", (v) => (v == null ? "–" : "$" + fmtDepth3(v)),
   // Amber covers BOTH stale cases: a stale row can carry a value or, as
   // measured on xyz:GOOGL and xyz:CXMT, carry null while still holding
   // hours of history. Either way it is not a live book.
   (v, r) => (r && r.depth_stale ? "am" : "fl"),
   (v, r) => v == null
     /* TWO DIFFERENT ABSENCES, and the collector distinguishes them. A market
        that was DROPPED from the depth set has real recorded history that
        simply ended; a market never subscribed has none and never will
        before a restart. Telling a reader "not in the collector" about a
        market with 22.7h of recorded book is false in the same way the rest
        of this pass is about. */
     ? (r && r.depth_stale
        ? "resting book NOT CURRENT for this market — it was DROPPED from the " +
          "depth collector" + (r.depth_h != null ? ", after recording " +
            r.depth_h.toFixed(1) + "h" : "") + ". History exists and has " +
          "ENDED; no past hour can ever be backfilled, and nothing new is " +
          "being recorded before a server restart."
        : "resting book NOT MEASURED for this market — it is not in the depth " +
          "collector (the set is capped and add-only until the server " +
          "restarts), so this cell is blank, not zero")
     : "$" + fmtBig(v) + " of resting book" +
       (r && r.depth_ord_usd != null
         ? " · median resting ORDER $" + fmtBig(r.depth_ord_usd) +
           " — a clip larger than that crosses more than one order" : "") +
       (r && r.depth_h != null ? " · " + r.depth_h.toFixed(1) +
         "h of history behind it" : "") +
       (r && r.depth_stale ? " · STALE: this market was DROPPED from the " +
         "depth collector, so the newest sample is old and no past hour can " +
         "ever be backfilled" : "") +
       " · resting size is CANCELLABLE — shown, not committed"],
];

/* Three significant figures with the unit suffix, for cells with ~35px of
   room. fmtBig is the desk's general formatter and keeps a decimal into the
   hundreds ("$123.3M", 40px) — correct everywhere it is not width-bound. */
function fmtDepth3(v) {
  const a = Math.abs(v);
  const u = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : [1, ""];
  const n = v / u[0];
  return (Math.abs(n) >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, "")) + u[1];
}

/* `one-sided-book` sorts on depth_imb and `book-thinning` on depth_chg_1h,
   and neither field had a column — the screener was ranking rows by a key
   the pane never rendered. These are appended only when a depth field is
   the sort or a filter, so the other presets keep their six columns. */
const SCREEN_DEPTH_COLS = [
  ["depth_imb", "BID%", (v) => (v == null ? "–" : Math.round((1 + v) / 2 * 100) + "%"),
   (v) => (v == null ? "fl" : v > 0.15 ? "up" : v < -0.15 ? "dn" : "fl")],
  ["depth_chg_1h", "Δ1H", (v) => (v == null ? "–" : (v >= 0 ? "+" : "") + v.toFixed(0) + "%"),
   (v) => (v == null ? "fl" : v >= 0 ? "up" : "dn")],
  /* RHO is the BID% column's own reliability, and it belongs beside it: the
     `one-sided-book` preset SORTS on depth_imb, and the most extreme values
     come from the books whose split is closest to a coin flip. Measured, it
     spans 0.01 to 0.93 and is not a function of size. "–" is "not enough
     adjacent minutes yet", never "unstable". */
  ["depth_imb_rho", "RHO", (v) => (v == null ? "–" : v.toFixed(2)),
   (v) => (v == null ? "fl" : v < 0.3 ? "dn" : "fl")],
];

function screenCols(d) {
  const keys = [String((d && d.sort) || "")]
    .concat(((d && d.filters) || []).map((f) => String(f.field)));
  return keys.some((k) => k.startsWith("depth_"))
    ? SCREEN_COLS.concat(SCREEN_DEPTH_COLS) : SCREEN_COLS;
}

/* ---------------- DEEP: TradingAgents workups ----------------
   The scanner is wide and shallow; this is one name, twelve agents, ~9 min.
   Runs are queued server-side and drained by a worker — never inline.

   Rows used to be stamped a literal UNVALIDATED — every row, forever, even
   after the scorer graded one — because the cell was a constant and the meta
   line read d.validation, which the server hardcodes. Each row now renders its
   OWN outcome: GRADED (with %/R and which level resolved it), OPEN, AMBIGUOUS,
   UNSCORABLE, or NOT SCORED, each carrying its reason in the title.

   The caution the old stamp was reaching for still stands and is now carried by
   the numbers instead of by a word: measured 2026-08-20, 31 verdicts produced
   1 graded, 19 open and 11 UNSCORABLE. A single graded outcome is nowhere near
   the ~85 needed to detect even a 3% edge, so nothing here is a validated edge
   and the meta line says so by showing the tally rather than a verdict on it.

   UNSCORABLE is the number worth watching, and it indicts the WORKUP, not the
   scorer: stops recorded on the wrong side of entry (HYPE, ETH), an entry off
   the market by more than 10x because the parser mixes thousands with absolute
   units (BTC 28.09 against a 69,323 close), and calls with no stop, target or
   horizon at all (TSLA). Those are upstream defects that were invisible while
   every row said the same word. */
function loadDeep(q) {
  const url = q ? "/api/deepdive?" + q : "/api/deepdive";
  fetch(url).then((r) => r.json()).then((d) => {
    state.deep = d; state.deepError = null;
    if (state.wtab === "deep") renderDeepTab();
  }).catch((e) => {
    state.deepError = String(e);
    if (state.wtab === "deep") renderDeepTab();
  });
}

function deepAct(sym) {
  if (!sym) return;
  loadDeep("run=" + encodeURIComponent(sym.trim().toUpperCase()));
}

/* One cell, five honest states. A graded call shows its result; an open one
   says it is not settled yet and when it would be; an unscorable one says the
   VERDICT is ungradable and why; ambiguous means the bar touched both levels
   and the order is genuinely unknowable at this resolution — recorded, never
   guessed. A missing outcome reads as not-yet-examined, not as a zero. */
function ddOutcomeCell(v) {
  const o = v.outcome || null;
  const st = v.outcome_status || (o && o.status) || null;
  const why = esc((o && o.reason) || "");
  if (!st) return '<td class="k-news" title="the scorer has not examined this ' +
    'verdict yet — this is not a result">NOT SCORED</td>';
  if (st === "graded" || v.result_r != null || v.result_pct != null) {
    const r = v.result_r != null ? v.result_r : (o && o.result_r);
    const pct = v.result_pct != null ? v.result_pct : (o && o.result_pct);
    const win = (r != null ? r : pct) >= 0;
    const res = esc((v.outcome_resolution || (o && o.resolution) || "").toUpperCase());
    return '<td class="' + (win ? "up" : "dn") + '" title="' + why + '">' +
      (pct != null ? (pct >= 0 ? "+" : "") + Number(pct).toFixed(1) + "%" : "") +
      (r != null ? ' <i>' + (r >= 0 ? "+" : "") + Number(r).toFixed(2) + 'R</i>' : "") +
      (res ? ' ' + res : "") + '</td>';
  }
  if (st === "ambiguous")
    return '<td class="k-news" title="' + why + '">AMBIGUOUS</td>';
  if (st === "open")
    return '<td class="fl" title="' + why + '">OPEN</td>';
  if (st === "unscorable")
    return '<td class="dn" title="' + why + '">UNSCORABLE</td>';
  return '<td class="k-news" title="' + why + '">' + esc(String(st).toUpperCase()) + '</td>';
}

function renderDeepTab() {
  const d = state.deep;
  const meta = $("watch-meta");
  if (state.deepError) {
    meta.textContent = "DEEP DIVE · FEED FAILING";
    $("whead").innerHTML = "";
    $("wbody").innerHTML = '<tr><td class="empty">deep-dive feed failing (' +
      state.deepError + ')</td></tr>';
    return;
  }
  if (!d) {
    $("whead").innerHTML = "";
    $("wbody").innerHTML = '<tr><td class="empty">loading…</td></tr>';
    loadDeep();
    return;
  }
  /* The tally, not a constant. This line printed the server's literal
     "UNVALIDATED" for every payload — including after the scorer had graded a
     call — because it read d.validation, which server.py hardcodes. The real
     state lives in d.scoring {verdicts, scored, graded, ambiguous, open,
     unscorable, deferred}. UNSCORABLE is the number worth surfacing: 11 of 31
     here, and the reasons are upstream defects in the verdicts themselves
     (a stop on the wrong side of entry, an entry off by 10x, no horizon at
     all) — not scorer failures, and invisible while this said UNVALIDATED. */
  const sc = d.scoring || {};
  const nG = sc.graded != null ? sc.graded : (d.scored_n || 0);
  const bits = [];
  if (nG) bits.push(nG + " GRADED");
  if (sc.open) bits.push(sc.open + " OPEN");
  if (sc.unscorable) bits.push(sc.unscorable + " UNSCORABLE");
  if (sc.ambiguous) bits.push(sc.ambiguous + " AMBIGUOUS");
  if (sc.deferred) bits.push(sc.deferred + " DEFERRED");
  meta.textContent = "DEEP DIVE · " +
    (sc.verdicts != null ? sc.verdicts + " VERDICTS" : "") +
    (bits.length ? " · " + bits.join(" · ") : " · NOT SCORED YET");
  meta.title = (d.coverage || "") +
    (sc.last_score_at ? "\nlast scored " + sc.last_score_at : "") +
    (sc.unscorable ? "\nUNSCORABLE means the verdict itself carries no gradable " +
      "plan (missing horizon, stop on the wrong side of entry, levels off by " +
      "orders of magnitude) — hover a row for the exact reason." : "");

  $("whead").innerHTML =
    "<tr><th>SYM</th><th>AS OF</th><th>CALL</th><th>ENTRY</th><th>STOP</th>" +
    "<th>TARGET</th><th>RAN</th><th>STATE</th></tr>";

  const rows = [];
  /* A DEAD RUN MUST NOT READ AS A LIVE ONE. This loop used to print
     q.state.toUpperCase() straight through, so two HYPE-USD workups orphaned
     by a worker restart on 2026-08-18 still said "RUNNING — a workup takes ~9
     min" 11.6 hours later. The server now ships the lease verdict per row;
     this draws it, with the AGE, so 9 minutes and 11 hours cannot look alike.
     lease_expired === null means liveness is NOT MEASURED — rendered as an
     open question, never as a healthy run and never as a dead one. */
  for (const q of d.queue || []) {
    const age = q.age_h;
    let label, detail, cls;
    if (q.state === "blocked") {
      label = "BLOCKED"; cls = "fl";
      detail = "BLOCKED — " + esc(q.reason || "no reason recorded");
    } else if (q.state === "abandoned" || q.state === "failed") {
      label = q.state.toUpperCase(); cls = "dn";
      detail = label + " after " + (age || "an unmeasured time") + " — " +
        esc(q.reason || "no reason recorded");
    } else if (q.state === "running" && q.lease_expired === true) {
      label = "ABANDONED"; cls = "dn";
      detail = "ABANDONED after " + (age || "an unmeasured time") +
        " — nothing has renewed this run's lease" +
        (q.heartbeat_age_h ? " for " + q.heartbeat_age_h : "") +
        ", against a ~9 min workup. The worker died or hung; this is not a " +
        "live run.";
    } else if (q.state === "running" && q.lease_expired === false) {
      label = "RUNNING"; cls = q.over_budget ? "dn" : "";
      detail = "RUNNING " + (age || "for an unmeasured time") +
        (q.over_budget ? " — PAST ITS RUN BUDGET, still heartbeating"
                       : " — a workup takes ~9 min");
    } else if (q.state === "running") {
      label = "RUNNING?"; cls = "fl";
      detail = "RUNNING? — no lease reading on this row, so whether a worker " +
        "is still on it is NOT MEASURED (which is not the same as healthy)";
    } else {
      label = q.state.toUpperCase(); cls = "fl";
      detail = label + (age ? " — waiting " + age : " — waiting, age not measured");
    }
    /* The STATE column is narrow enough to clip, so the age leads the DETAIL
       cell too -- "11h 51m" has to survive the truncation, not hide behind a
       hover. The tooltip carries the whole sentence either way.
       `detail` is ALREADY escaped (every interpolated value went through esc),
       so it goes into title= as-is; running it through esc twice would render
       &quot; literally in the tooltip. */
    rows.push('<tr><td>' + esc(q.symbol) + '</td><td>' + esc(q.as_of) +
      '</td><td colspan="5" class="' + cls + '" title="' + detail + '">' +
      detail + '</td><td class="' + cls + '" title="' + detail + '">' +
      label + (age ? ' · ' + age : "") + '</td></tr>');
  }
  for (const v of d.verdicts || []) {
    const act = (v.action || "UNKNOWN").toUpperCase();
    const cls = act === "BUY" ? "k-signal" : act === "SELL" ? "k-insider" : "k-news";
    const num = (x) => (x == null ? "—" : Number(x).toFixed(2));
    rows.push('<tr><td>' + v.symbol + '</td><td>' + v.as_of +
      '</td><td class="' + cls + '" title="' + (v.rating || "") + '">' + act +
      '</td><td>' + num(v.entry) + '</td><td>' + num(v.stop) + '</td><td>' +
      num(v.target) + '</td><td>' + (v.elapsed_s ? Math.round(v.elapsed_s) + "s" : "—") +
      '</td>' + ddOutcomeCell(v) + '</tr>');
  }
  if (!rows.length) {
    rows.push('<tr><td class="empty" colspan="8">no workups yet — type a symbol ' +
      'in the box above and press enter to queue one</td></tr>');
  }
  rows.push('<tr><td class="empty" colspan="8">' + (d.coverage || "") + '</td></tr>');
  $("wbody").innerHTML = rows.join("");
}

function renderScreenTab() {
  $("whead").innerHTML = "";
  const d = state.screen;
  /* The meta line named the pane and nothing about the result, so a capped
     page and a complete one looked identical up here. MOVERS/FUND already
     carry their count in this slot; this is the same treatment. */
  const scMeta = $("watch-meta");
  const scN = d && d.n_matched;
  scMeta.textContent = scN != null
    ? "SCREENER · " + ((d.rows || []).length) +
      (scN > (d.rows || []).length ? " OF " + scN + " MATCHES" : " MATCHING") +
      " · OF " + (d.n_universe != null ? d.n_universe + " MKTS" : "UNIVERSE")
    : "SCREENER · CARRY · BASIS";
  scMeta.title = (d && d.count_note) || "";
  const cur = screenState();
  if (!d && !state.screenError) {
    $("wbody").innerHTML = '<tr><td class="empty">screening universe…</td></tr>';
    loadScreen();
    return;
  }
  const out = [];
  const presets = (d && d.presets) || {};
  out.push('<div class="sc-presets">' + Object.keys(presets).map((k) =>
    `<button class="sc-p${k === cur.preset ? " on" : ""}" data-p="${esc(k)}" ` +
    `title="${esc(presets[k].why)}">${esc(presets[k].label.split(" — ")[0])}</button>`
  ).join("") + '</div>');

  if (d && presets[cur.preset])
    out.push('<div class="sc-why">' + esc(presets[cur.preset].why) + '</div>');

  // A screen that silently returns nothing because its data is missing is a
  // lie by omission — say which it is.
  const usesOI = (d && (d.filters || []).some((f) => String(f.field).startsWith("oi_chg")));
  if (d && usesOI && !d.oi_ready) {
    const h = (d.oi_coverage || {}).hours || 0;
    out.push('<div class="sc-warn">this screen needs open-interest history — ' +
      '<b>' + h + 'h of 24h</b> collected so far. HL publishes OI as a level ' +
      'with no history, so it can only accrue from when the terminal started ' +
      'recording; results will be empty until then.</div>');
  }
  const usesDepth = d && ([String(d.sort || "")]
    .concat((d.filters || []).map((f) => String(f.field)))
    .some((k) => k.startsWith("depth_")));
  if (usesDepth) {
    const dc = (d.depth_coverage || {});
    const sl = ((dc.by_sleeve || {}).sleeves) || {};
    const parts = Object.keys(sl).map((k) => sl[k].label).filter(Boolean);
    out.push('<div class="sc-warn">this screen ranks on RESTING BOOK depth, ' +
      'which is collected per market and cannot be backfilled — ' +
      '<b>' + esc(parts.join(" · ") || ((d.depth_coins || []).length +
      " markets collected")) + '</b>. Markets outside that set are absent ' +
      'from the result, not balanced.</div>');
  }
  if (state.screenError) {
    out.push('<div class="sc-warn">could not run screen — <b>' +
      esc(state.screenError) + '</b></div>');
  }

  const rows = (d && d.rows) || [];
  if (!rows.length && !state.screenError) {
    out.push('<div class="sc-empty">no assets match this screen right now</div>');
  } else if (rows.length) {
    const cols = screenCols(d);
    out.push('<div class="sc-row sc-head">' +
      '<span class="sc-sym">SYM</span>' +
      cols.map(([f, label]) =>
        `<span class="sc-c${f === (d.sort) ? " on" : ""}" data-sort="${esc(f)}" ` +
        `title="${esc((d.fields || {})[f] || label)} — click to sort">${esc(label)}</span>`
      ).join("") + '</div>');
    /* `fields` is the server's own human label per column and was only ever
       read for the HEADER. The measured-vs-blank distinction lives on the
       CELL, so a column may now supply a per-cell title, and fmt/cls see the
       whole row — depth_stale is a fact about the row, not about the value,
       and without it an old number and a current one render identically. */
    for (const r of rows) {
      out.push(`<div class="sc-row" data-coin="${esc(r.coin)}">` +
        `<span class="sc-sym">${esc(baseSym(r.coin))}</span>` +
        cols.map(([f, , fmt, cls, tip]) => {
          const t = tip ? tip(r[f], r) : null;
          return `<span class="sc-c ${cls(r[f], r)}"` +
            (t ? ` title="${esc(t)}"` : "") + `>${fmt(r[f], r)}</span>`;
        }).join("") +
        `</div>`);
    }
    /* "N shown" was true and still incomplete: it named the page and not the
       cap that made it a page. The server ships n_matched (rows that passed
       the screen), limit (the page cap) and a finished count_note, so the
       distinction between "4 markets match" and "60 of 412 matches shown" is
       measured rather than inferred from whether rows.length happens to sit
       on the limit. count_note is the server's own sentence and is preferred
       over anything rebuilt here, so this pane cannot drift from the query
       that actually ran — the same rule MOVERS and VENUES follow. */
    const nMatch = d && d.n_matched;
    const scLim = d && d.limit;
    const scTrunc = nMatch != null && nMatch > rows.length;
    out.push('<div class="sc-foot"' +
      (d && d.count_note ? ' title="' + esc(d.count_note) + '"' : "") + '>' +
      (scTrunc ? rows.length + ' of ' + nMatch + ' matches shown' +
                 (scLim != null ? ' (page cap ' + scLim + ')' : "") +
                 ' — the rest are NOT SHOWN, not absent'
               : rows.length + ' shown' +
                 (nMatch != null ? ' of ' + nMatch + ' matching' : "")) +
      ' · funding APR is the ' +
      'per-hour rate annualised · basis is perp vs the venue spot index · ' +
      'click a row to chart</div>');
    /* THE DEPTH COLUMNS' OWN COVERAGE, stated as a fraction of the rows the
       reader can see. Rule of this desk: a number arrives with what share of
       the intended set it covers. A blank BOOK cell is the absence of a
       collector subscription, and without this line it reads as a market
       with no book. */
    const nDep = rows.filter((r) => r.depth_usd != null && !r.depth_stale).length;
    const nOld = rows.filter((r) => r.depth_stale).length;
    const nNone = rows.length - nDep - nOld;
    if (nDep < rows.length)
      out.push('<div class="sc-foot dim">BOOK measured live for <b>' + nDep +
        ' of ' + rows.length + '</b> rows shown' +
        (nOld ? ' · <b>' + nOld + '</b> amber = DROPPED from the depth ' +
          'collector: that history has ended and no past hour can ever be ' +
          'backfilled' : '') +
        (nNone > 0 ? ' · <b>' + nNone + '</b> blank = never subscribed (the ' +
          'depth set is capped and add-only until the server restarts) — a ' +
          'blank cell is an unrecorded book, NOT a book with no size' : '') +
        '</div>');
    /* A filter the server REFUSED must not sit silently under a row count:
       the screener applies what is valid and returns the rest in
       filters_rejected, so a caller ignoring it reads an unfiltered page as a
       filtered one. Not reachable from this UI today (every call site passes
       filters:null) — rendered anyway, because the day a filter box is added
       is not the day anyone will remember to add this. */
    if (d && (d.filters_rejected || []).length)
      out.push('<div class="sc-warn">' + (d.filters_rejected || []).map((f) =>
        esc(typeof f === "string" ? f
          : (f.note || ((f.field || "?") + ":" + (f.op || "?") + " was NOT applied")))
        ).join('<br>') + '</div>');
  }

  const nCols = screenCols(d).length;
  $("wbody").innerHTML = '<tr><td colspan="7" style="white-space:normal;' +
    'overflow:visible"><div class="screen-pane" style="--sc-n:' + nCols +
    '">' + out.join("") + '</div></td></tr>';

  document.querySelectorAll(".sc-p").forEach((b) => {
    b.onclick = () => loadScreen({ preset: b.dataset.p, sort: null, filters: null });
  });
  document.querySelectorAll(".sc-head .sc-c").forEach((c) => {
    c.onclick = () => loadScreen({ sort: c.dataset.sort,
      desc: !(d.sort === c.dataset.sort && d.desc) });
  });
  document.querySelectorAll(".sc-row[data-coin]").forEach((el) => {
    el.onclick = () => selectCoin(el.dataset.coin);
  });
}

/* ── WHALES: what the biggest wallets are doing ──────────────────────────
   Roster comes from the public leaderboard (top by week volume / week pnl /
   month pnl — NOT by account value, which is poisoned by vaults and bridges
   holding zero perps). The server sweeps clearinghouseState every 15 min and
   diffs signed position size per (wallet, coin); this pane renders the
   resulting flow. Everything here is public data — no keys, read-only. */
/* Sort cycle for the per-coin board. Default is LEAN — deviation from the
   board's own long share — NOT |net_ntl|. Net-dollar order is a market-cap
   ranking wearing a positioning ranking's clothes: BTC sits at 27.5% long
   against a 27.2% book (a +0.3pt deviation, i.e. no information) and still
   takes row 1 with the biggest glyphs on the pane, burying the rows that
   actually lean. NET is still one click away — see whCycleSort(). */
let whalesSortKey = "dev";  // dev | share | net | gross
let whalesShowAll = false;  // sub-$1M rows are hidden by default, see WH_FLOOR

async function loadWhales() {
  try {
    const r = await fetch("/api/whales");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    // Only r.ok was checked here, so a server-side sweep failure — which
    // arrives as HTTP 200 + {error} — landed as a payload with no aggregates
    // and drew a calm, measured-looking board reading "no whale positions
    // recorded yet", with the error string nowhere on the page. Routed into
    // the catch, it becomes the warn banner this pane already draws.
    if (d && d.error) throw new Error(d.error);
    state.whales = d;
    state.whalesError = null;
  } catch (e) {
    state.whalesError = (e && e.message) || String(e);
  }
  if (state.wtab === "whales") renderWhalesTab();
  // The overlay is a second consumer of this payload. Without this it filled
  // in only on a re-open: opened before the first sweep landed it stayed on
  // "loading" forever, and left open across the 60s poll it went stale
  // silently while the pane 200px away updated.
  const dz = $("dossier");
  if (dz && dz.dataset.mode === "whales" && dz.style.display === "flex")
    renderWhaleBook();
  updateTabBadges();
}

/* signed dollar notional: -$4.2M / +$4.2M */
function whUsd(v) {
  if (v == null || isNaN(v)) return "–";
  return (v < 0 ? "-" : "+") + "$" + fmtBig(Math.abs(v));
}

/* ── magnitude: why this is TEXT and not a bar ──────────────────────────
   Whale notionals span four orders of magnitude ($100K → $500M). Neither
   available bar geometry is honest across that range. Normalised per row,
   every coin draws a full bar and the encoding says nothing. Normalised to
   the board maximum, a $100K coin gets 0.03px of a 70px track — 39 of 40
   rows become invisible, and a 1px floor to "fix" that would read as a
   real measurement when it is not one. A log-scaled bar is worse than
   both: readers demonstrably do not decode log bars logarithmically, they
   read the scale word (K/M/B) and reason linearly inside that band.
   So length is spent entirely on the BOUNDED quantity (long share, 0–100%,
   which renders truthfully at every magnitude) and magnitude is carried as
   mantissa+exponent text, which is what the eye actually decodes anyway.
   fmtBig() already emits mantissa+exponent, but at variable width (4–6
   chars), so the K/M/B letter never lands at a fixed x and the column
   stops reading as a column. whMag pads to exactly 4 glyph cells using
   U+2007 FIGURE SPACE (digit-width in a mono face) so that it does. */
const FIGSP = " ";
function whMag(v) {
  if (v == null || isNaN(v)) return FIGSP + FIGSP + FIGSP + "–";
  const a = Math.abs(+v);
  const [d, u] = a >= 1e9 ? [a / 1e9, "B"]
    : a >= 1e6 ? [a / 1e6, "M"]
    : a >= 1e3 ? [a / 1e3, "K"] : [a, FIGSP];
  return (d >= 10 ? d.toFixed(0) : d.toFixed(1)).padStart(3, FIGSP) + u;
}

/* Rows below this much gross are hidden by default: at $500K one ticket
   swings long share by 30 points, so a lean bar drawn there would assert a
   precision the data does not have. Hidden, counted, and one click away. */
const WH_FLOOR = 1e6;
/* RENDER caps for the two whale feeds — how many rows this PANE draws, which
   is a different number from how many the server sends. Named constants
   because both headers and both footers now quote them: they were inline
   literals (14 and 60) sitting under headers that quoted the SERVER's page
   size, so the pane said "TOP 40 OF 106" above 14 rows and "NEWEST 100 OF
   1053" above 60. Every count on this pane must be derivable from these. */
const WH_ORD_ROWS = 14;
const WH_EV_ROWS = 60;
/* Below this many points of deviation a coin is not leaning, it is the
   book. BTC at +0.3 must LOOK like nothing, because it is nothing. */
const WH_DEADBAND = 3;

function whGross(r) { return (r.long_ntl || 0) + (r.short_ntl || 0); }

/* Long share of a coin's whale book, 0–100. Bounded, therefore comparable
   across magnitudes: ZRO's $7.8M book and BTC's $663M book can be read
   against each other, which raw notional can never do. */
function whShare(r) {
  const g = whGross(r);
  return g > 0 ? (r.long_ntl || 0) / g * 100 : null;
}

/* Deviation from the BOARD's own long share. Raw share alone is dominated
   by the roster's structural bias — the leaderboard book is ~73% short, so
   ~40 consecutive rows would all read "short" and say nothing about any
   individual coin. What varies coin to coin is the lean relative to the
   book, and that is the quantity the rail draws and the sort ranks. */
function whDev(r, base) {
  const s = whShare(r);
  return (s == null || base == null) ? null : s - base;
}

/* Concentration: is this lean a crowd or one ticket? A 40-wallet crowded
   short is squeeze fuel — it has to buy back. A single-whale short can
   vanish quietly with no squeeze at all. The two are identical in every
   dollar column, so this is flagged sparsely rather than printed. */
function whConc(r) {
  const al = r.n_long ? (r.long_ntl || 0) / r.n_long : 0;
  const as = r.n_short ? (r.short_ntl || 0) / r.n_short : 0;
  return (al && as) ? as / al : null;
}
/* 4x, not 3x. Measured on the live board (42 rows above the $1M floor) the
   ratios run 34.3, 32.0, 22.1, 8.8, 6.0, 5.4, 4.2 | 3.6, 3.3, 3.2, 3.0,
   2.8, 2.7, 2.3 … — there is a real gap after 4.2 and a dense band below
   3.6. A 3x cut fires on 15 of 42 rows, slicing through the middle of the
   distribution, and an amber flag on a third of the board stops being a
   flag. 4x fires on 9 and sits in the gap. */
const WH_CONC_HOT = 4;
function whConcHot(c) {
  return c != null && (c >= WH_CONC_HOT || c <= 1 / WH_CONC_HOT);
}

/* ── venue identity ─────────────────────────────────────────────────────
   The sweep is dex-aware: measured live, 94 of its 271 per-coin rows are on
   xyz. baseSym() strips the namespace, so xyz:GOLD, xyz:AAPL and
   xyz:BRENTOIL rendered as "GOLD", "AAPL", "BRENTOIL" in a table whose
   other rows are core crypto — a different market, a different book and in
   most cases a different asset class, printed as if it were BTC's neighbour.
   Rows from the dex-aware sweep carry `dex`/`venue` outright; events and
   resting orders carry only the namespaced coin, so the prefix is the
   FALLBACK and never a re-parse of a field that is already there. */
function whDex(r) {
  if (r && r.dex != null) return r.dex;
  const c = (r && r.coin) || "";
  return c.includes(":") ? c.split(":")[0] : "";
}
function whVenue(r) { return (r && r.venue) || whDex(r) || "HL core"; }

/* Same convention the movers table already uses (moverRow / .wt-dex): the
   ticker stays the thing you scan and the sleeve is a qualifier on it. */
function whDexTag(r) {
  const dex = whDex(r);
  if (!dex) return "";
  return '<span class="wh-dex" title="' + esc(whVenue(r)) + ' — a HIP-3 perp ' +
    'on its own dex. Separate market, separate book and separate wallets ' +
    'from core Hyperliquid, which may not list this underlying at all.">' +
    esc(dex) + '</span>';
}

/* The symbol cell, venue included. `cls` picks the track it sits in —
   .wh-sym in the two tables, .wh-coin in the event feed, .wh-osym in the
   order rows — and all three are flex containers whose BASE ellipsizes and
   whose venue tag does not. That priority is deliberate: a truncated ticker
   is visibly truncated (and the full id is in the row title and in
   data-coin), while a dropped venue is silently WRONG. */
function whSymCell(r, cls, attrs) {
  return '<span class="' + cls + '"' + (attrs || "") + '>' +
    '<span class="wh-base">' + esc(baseSym(r.coin)) + '</span>' +
    whDexTag(r) + '</span>';
}

/* ── venue decomposition ────────────────────────────────────────────────
   The served aggregate is BLENDED over every venue the sweep queried. For a
   trader with size on both that is the right headline — one book, one
   number — but only if it is labelled blended and can be taken apart,
   because the halves can point OPPOSITE ways. Measured live: core is 38.6%
   long (skew -22.87) and xyz is 62.0% long (skew +23.90), blending to 47.4%
   (-5.26). Reading the blended figure as the core book understates the
   tracked core short book by ~$183M of net notional.
   Built from cov.venues — the authoritative list of what was QUERIED — and
   filled from per_coin, so a venue that was swept and holds nothing reads
   "none held" (a measurement) instead of vanishing (not a measurement). */
function whVenueSplit(rows, cov) {
  const by = new Map();
  const put = (dex, venue) => {
    if (!by.has(dex)) by.set(dex, { dex: dex, venue: venue, L: 0, S: 0, n: 0 });
    return by.get(dex);
  };
  for (const v of ((cov || {}).venues || []))
    put(v.dex || "", v.venue || v.dex || "HL core").cov = v;
  for (const r of (rows || [])) {
    const g = put(whDex(r), whVenue(r));
    g.L += r.long_ntl || 0; g.S += r.short_ntl || 0; g.n++;
  }
  const out = [...by.values()];
  for (const g of out) {
    g.gross = g.L + g.S;
    g.share = g.gross > 0 ? g.L / g.gross * 100 : null;
    g.net = g.L - g.S;
  }
  return out.sort((a, b) => b.gross - a.gross);
}

/* Every failed wallet fetch, across every venue. cov.fetch_fails counts the
   CORE phase only and was printed here as though it were the sweep's total:
   an xyz-only degradation could not raise the banner even with xyz rows in
   every number above it. cov.venues[].wallets_failed is the per-venue count
   and cov.wallets_failed the named-and-counted total (the venues.py
   contract — failures are reported, never dropped); fetch_fails survives
   only as the last resort for an older payload. */
function whFails(cov) {
  const vs = ((cov || {}).venues || []).filter((v) => v.wallets_failed);
  const summed = vs.reduce((a, v) => a + (v.wallets_failed || 0), 0);
  const total = Math.max(summed, (cov || {}).wallets_failed || 0) ||
                ((cov || {}).fetch_fails || 0);
  return { total: total,
           parts: vs.map((v) => v.wallets_failed + " " + (v.venue || v.dex || "core")),
           impact: (((cov || {}).failed || [])[0] || {}).impact ||
             "those wallets contribute their PREVIOUS snapshot to the numbers " +
             "above and are not diffed this round" };
}

/* Venues that TRADE but are not swept. The invariant runs in BOTH
   directions: xyz IS covered and must not be called absent, and para/mkts/
   hyna are NOT covered and must not be implied present. */
function whUnswept(cov) {
  const swept = new Set((((cov || {}).venues) || []).map((v) => v.dex || ""));
  return (((cov || {}).dex_volumes) || [])
    .filter((v) => !swept.has(v.dex) && (v.vol_24h || 0) > 0)
    .sort((a, b) => (b.vol_24h || 0) - (a.vol_24h || 0));
}

/* Venues swept for POSITIONS but not for resting ORDERS (WHALE_DEX_ORDERS
   is off). An empty order book there is not-fetched, not nobody-resting. */
function whNoOrderVenues(cov) {
  return (((cov || {}).venues) || []).filter((v) => v.orders_covered === false);
}

/* One fetch per uncovered dex for the server's own orders_why sentence, so
   this pane cannot drift from the wording the chart legend and BOTH SIDES
   already print. Keyed by dex and written BEFORE the await, so a render
   loop cannot re-issue it; a failure leaves null and the caller falls back
   to a sentence that states the same fact without inventing a measurement. */
async function whLoadOrdersWhy(dex, rows) {
  if (state.whOrdersWhy[dex] !== undefined) return;
  const row = (rows || []).find((r) => whDex(r) === dex);
  if (!row) return;
  state.whOrdersWhy[dex] = null;
  try {
    const r = await fetch("/api/whales?coin=" + encodeURIComponent(row.coin));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    const why = ((d || {}).coverage || {}).orders_why || "";
    if (why) {
      state.whOrdersWhy[dex] = why;
      if (state.wtab === "whales") renderWhalesTab();
    }
  } catch (e) { /* the fallback sentence already states the fact */ }
}

/* Fixed 4-cell side token: 99%S / 79%L
   Side is carried by the LETTER — a text channel that survives greyscale,
   deuteranopia and a 3px bar alike. Hue is second and never load-bearing,
   which matters because red already means four other things here (price
   down, funding paid, book ask, negative PnL). The letter sits in the last
   glyph cell so the column reads as a vertical S/L stripe down the pane.

   The token prints what the coin IS, not how far it sits from a reference
   printed elsewhere.
   
   The first version showed the deviation ("S−28"), which is the quantity
   the bar already draws and the rows are already sorted by — so the one
   number on the row needed a second number (the board's 28.8%) held in
   the reader's head to mean anything, and it read as an absolute figure
   because nothing marked it as relative. "S−28" on a coin that is 99%
   short is simply not what a trader would say about it.
   
   Now: the NUMBER is absolute and self-contained (99%S = 99 cents of every
   whale dollar in this coin is short), and the BAR carries the deviation
   against the waterline. Each channel does the thing it is good at, and
   neither needs the other to be readable. BTC reading 70%S with a bar at
   the waterline is exactly right: heavily short, but no more so than the
   board — which is a fact two separate encodings should be allowed to
   state together. */
function whLeanTok(share, extra) {
  const cl = (c) => '<span class="wh-lean ' + c + (extra || "") + '">';
  if (share == null) return cl("z") + "&nbsp;&nbsp;&ndash;" + '</span>';
  // Dominant side and its share of this coin's whale notional.
  const longSide = share >= 50;
  const pct = Math.round(longSide ? share : 100 - share);
  const n = String(Math.min(99, pct)).padStart(2, FIGSP);
  return cl(longSide ? "l" : "s") + n + "%" + (longSide ? "L" : "S") + '</span>';
}

/* The rail's axis legend, printed once per table. 12 glyphs, not 14: the
   old "◂SHORT · LONG▸" measures 67.4px at 8px mono (the advance here is
   0.602em — "SF Mono" is not installed, so the stack falls through to the
   system mono) and the rail it labels is 67.4px on the p-trade preset at
   this viewport and 66px at the widths where #p-watch is pinned to its
   240px minimum. It was therefore already ellipsizing, silently, into the
   word LONG — .wh-axis is overflow:hidden, so nothing overflowed the row
   and the scrollWidth check that certified "0 clipped" rounded it away.
   Dropping the two spaces around the separator costs nothing and buys
   9.6px, clearing the 66px worst case with room. The full sentence lives
   in the title attribute, which is where it was always going to be read. */
const WH_AXIS_LBL = "◂SHORT·LONG▸";

/* ── the rail ───────────────────────────────────────────────────────────
   The bar ORIGIN is the board's long share (the "waterline", a 1px rule at
   the same x in every row because --wl is set once on the pane), so the
   drawn LENGTH is the deviation — the same quantity the rows are sorted by
   and the same one the trader is actually asking about. Nothing has to be
   differenced by eye, which is the whole failure of two adjacent dollar
   columns. Direction (left of the line = more short than the book, right =
   more long) is a position encoding: the strongest perceptual channel and
   the one that survives every colour vision deficiency.
   Height is the magnitude tier — 2/4/6/9px on the same decade ladder the
   chart's whale entry ticks use (1e6/1e7/1e8) — so heavyweight rows read
   as heavier while scanning, at zero cost to the horizontal budget. */
function whRail(r, base, wide) {
  const s = whShare(r);
  const cls = 'class="wh-rail' + (wide ? " wide" : "") + '"';
  if (s == null || base == null) return '<span ' + cls + '></span>';
  const dev = s - base, g = whGross(r);
  const h = g >= 1e8 ? 9 : g >= 1e7 ? 6 : g >= 1e6 ? 4 : 2;
  const hot = whConcHot(whConc(r)) ? " conc" : "";
  let bar;
  if (Math.abs(dev) < WH_DEADBAND) {
    // Deadband: a 2px dim block ON the waterline. Not a short bar, not a
    // long one — visibly "this coin is the book".
    // Clamped inside the track: .wh-rail is overflow:hidden, so at an
    // all-short board (base 0) the block was placed at left:-1px and lost
    // half its pixels, and at an all-long board (base 100) it overflowed
    // the box entirely. Those extremes are not reachable with 180 wallets,
    // but the geometry degrades continuously toward them and nothing else
    // clamps it. The waterline itself is clamped in CSS, same reason.
    bar = '<i class="wh-dev z" style="left:calc(min(max(' + base.toFixed(2) +
      '%, 1px), 100% - 1px) - 1px);width:2px;height:2px"></i>';
  } else if (dev > 0) {
    bar = '<i class="wh-dev l' + hot + '" style="left:' + base.toFixed(2) +
      '%;width:' + dev.toFixed(2) + '%;height:' + h + 'px"></i>';
  } else {
    bar = '<i class="wh-dev s' + hot + '" style="left:' + s.toFixed(2) +
      '%;width:' + (-dev).toFixed(2) + '%;height:' + h + 'px"></i>';
  }
  return '<span ' + cls + '>' + bar + '</span>';
}

/* The rail encodes a RELATIVE quantity, which is its one real cognitive
   cost. One spelled-out sentence in the tooltip retires that cost, and
   carries every figure the 204px row had to give up. */
function whRowTitle(r, base) {
  const s = whShare(r), dev = whDev(r, base), t = [];
  // Venue first. The 52px cell has room for the tag but not for what it
  // means, and "GOLD" beside BTC is a different claim from "xyz:GOLD".
  t.push(r.coin + " · " + whVenue(r) +
    (whDex(r) ? " (HIP-3 dex — its own market, book and wallets)"
              : " (core Hyperliquid)"));
  if (s != null && dev != null)
    t.push(Math.abs(dev) < WH_DEADBAND
      ? "in line with the book: " + s.toFixed(0) + "% long vs book " +
        base.toFixed(0) + "%"
      : Math.abs(dev).toFixed(0) + " pts more " + (dev > 0 ? "long" : "short") +
        " than the book: " + s.toFixed(0) + "% long vs book " +
        base.toFixed(0) + "%");
  t.push("long $" + fmtBig(r.long_ntl || 0) + " (" + (r.n_long || 0) +
    " wallets) · short $" + fmtBig(r.short_ntl || 0) + " (" + (r.n_short || 0) +
    " wallets)");
  t.push("net " + whUsd(r.net_ntl) + " · gross $" + fmtBig(whGross(r)));
  const c = whConc(r);
  if (whConcHot(c))
    t.push(c >= 1
      ? "concentrated SHORT side — avg short ticket " + c.toFixed(1) + "x the avg long"
      : "concentrated LONG side — avg long ticket " + (1 / c).toFixed(1) + "x the avg short");
  // Never imply a 24h number that does not exist: only speak when it does.
  if (r.delta_24h_ntl != null) t.push("Δ24h net " + whUsd(r.delta_24h_ntl));
  const mid = state.mids[r.coin] != null ? +state.mids[r.coin]
    : ((ctxFor(r.coin) || {}).mid_px);
  if (r.avg_long_entry) t.push("longs avg entry " + fmtPx(r.avg_long_entry) +
    (mid ? " (" + ((mid / r.avg_long_entry - 1) * 100).toFixed(1) + "% from mid)" : ""));
  if (r.avg_short_entry) t.push("shorts avg entry " + fmtPx(r.avg_short_entry) +
    (mid ? " (" + ((mid / r.avg_short_entry - 1) * 100).toFixed(1) + "% from mid)" : ""));
  return t.join("\n");
}

/* Short verbs, ≤5 chars. INCREASED/DECREASED measured 53px into a 50px
   badge and spilled OUT of their own coloured border — the box and the
   word disagreed on every event row. Fixed at the content layer, not by
   widening a track there is no room to widen. */
const WH_VERB = { opened: "OPEN", closed: "CLOSE", increased: "ADD",
                  decreased: "CUT", flipped: "FLIP" };

/* Two lines, because six facts do not fit on one at 192px — the same
   shape the PORT pane uses, which is the only surface in this app that
   was already legible at this width. Line 1 scans, line 2 identifies. */
function whEventLine(e) {
  const long = e.side === "long";
  const verb = WH_VERB[e.type] || (e.type || "").slice(0, 5).toUpperCase();
  return '<div class="wh-ev">' +
    '<div class="wh-e1">' +
    '<span class="wh-when">' + alertAgo(e.ts) + '</span>' +
    '<span class="wh-t ' + esc(e.type) + '">' + esc(verb) + '</span>' +
    whSymCell(e, "wh-coin", ' data-coin="' + esc(e.coin) + '"') +
    '<span class="wh-side ' + (long ? "l" : "s") + '" title="' +
    (long ? "long" : "short") + ' side">' + (long ? "L" : "S") + '</span>' +
    '<span class="wh-emag">$' + fmtBig(e.delta_ntl) + '</span>' +
    '</div>' +
    '<div class="wh-e2">' + esc(e.label || "unlabelled wallet") +
    (e.entry_px != null ? ' · @' + fmtPx(e.entry_px) : "") +
    (e.lev ? ' · ' + Math.round(e.lev) + 'x' : "") + '</div></div>';
}

/* Sort keys, all applied to the cached payload — a click must never cost
   200 wallet polls. NET stays reachable in one click so the pane does not
   need the full-book overlay just to rank by unwind scale. */
const WH_SORTS = [["dev", "LEAN"], ["share", "LONG %"], ["net", "NET $"],
                  ["gross", "GROSS"]];
function whCycleSort() {
  const i = WH_SORTS.findIndex(([k]) => k === whalesSortKey);
  whalesSortKey = WH_SORTS[(i + 1) % WH_SORTS.length][0];
}
function whSortLabel() {
  return (WH_SORTS.find(([k]) => k === whalesSortKey) || WH_SORTS[0])[1];
}
/* LEAN ranks on deviation normalised to the headroom available on the
   coin's OWN side, not on raw points. Raw |dev| is bounded asymmetrically:
   with the board at 27.5% long a coin can be at most 27.5 points more short
   than the book but 72.5 points more long, so no short-leaning coin can
   ever outrank a long-leaning one above +27.5 — a hard ceiling, not a bias.
   Measured on the live payload the raw key put rows 0–32 all long-leaning,
   with the first short lean at rank 33: PEOPLE, COMP and GMT at -27.53,
   i.e. 100% short with zero long dollars — the most extreme short
   positioning that can exist, and on a 72% short book the squeeze-fuel
   case this pane exists to surface. Normalised, ±1.0 means "maximally
   leaned" on either side and those three tie for rank 1.
   The printed token stays in RAW POINTS: the ranking is a question of
   which rows deserve the top of the pane, the number is a measurement.
   That does mean the printed values are not monotonic down the column,
   which is why the sort chip's tooltip says what it ranked by. */
function whLeanRank(r, base) {
  const d = whDev(r, base);
  if (d == null || base == null) return -1;
  return Math.abs(d > 0 ? d / Math.max(1e-9, 100 - base) : d / Math.max(1e-9, base));
}
function whSortRows(rows, base) {
  const k = whalesSortKey;
  const key = (r) =>
    k === "share" ? (whShare(r) == null ? -1 : whShare(r)) :
    k === "net"   ? Math.abs(r.net_ntl || 0) :
    k === "gross" ? whGross(r) :
                    whLeanRank(r, base);
  return rows.slice().sort((a, b) => key(b) - key(a));
}

/* One per-coin row, shared verbatim by the pane and the full-book overlay
   so the encoding is learned once. */
function whCoinRow(r, base, tiny) {
  return '<div class="wh-row' + (tiny ? " tiny" : "") + '" data-coin="' +
    esc(r.coin) + '" title="' + esc(whRowTitle(r, base)) + '">' +
    whSymCell(r, "wh-sym") +
    whRail(r, base) +
    whLeanTok(whShare(r)) +
    '<span class="wh-mag">' + whMag(whGross(r)) + '</span></div>';
}

function renderWhalesTab() {
  $("whead").innerHTML = "";
  $("watch-meta").textContent = "WHALE FLOW · LEADERBOARD · 15M SWEEP";
  const d = state.whales;
  const out = [];

  if (!d && !state.whalesError) {
    $("wbody").innerHTML = '<tr><td class="empty">loading whale flow…</td></tr>';
    loadWhales();
    return;
  }
  if (state.whalesError) {
    out.push('<div class="wh-warn">could not load whale data — <b>' +
      esc(state.whalesError) + '</b><br>retrying automatically…</div>');
  }

  const cov = (d && d.coverage) || {};
  const agg = (d && d.aggregates) || {};
  // Every headline on this pane is a sum over the venues the sweep queried,
  // so the decomposition is computed once, up here, and the blocks below
  // are written against it rather than against an assumed venue.
  const split = whVenueSplit(agg.per_coin || [], cov);
  const fails = whFails(cov);

  // Honesty first: the diff engine needs two sweeps before any event can
  // exist, and Δ24h needs a day of hourly aggregates. Say so explicitly.
  if (d && d.warming) {
    out.push('<div class="wh-warn">warming — <b>' +
      esc(d.warming_note || "collecting first sweeps") + '</b>. Positions below ' +
      'are live; opens/closes/flips can only appear once two sweeps exist to diff.</div>');
  }

  // Degraded coverage: if a material share of last sweep's fetches failed,
  // the skew/book below silently includes stale snapshots — say so.
  // cov.fetch_fails is the CORE phase's count. Gating on it meant an
  // xyz-only degradation could never raise this banner, while xyz rows sat
  // in every number above it. whFails() totals across venues and names them.
  if (d && fails.total && cov.wallets_active &&
      fails.total / cov.wallets_active > 0.1) {
    out.push('<div class="wh-warn">degraded sweep — <b>' + fails.total +
      ' of ' + cov.wallets_active + '</b> wallet fetches failed last sweep' +
      (fails.parts.length ? ' (' + esc(fails.parts.join(" · ")) + ')' : "") +
      '; skew and per-coin book include stale snapshots for those wallets.</div>');
  }

  // Header strip: the board's own long share. This is not decoration — it
  // is the waterline every row below is measured against, so it is stated
  // once, in words, directly above the column that uses it.
  // Only ONE percentage is printed: "SHORT 73%" is fully determined by
  // "LONG 27%", and rendering both cost ~60px and was what forced this
  // strip to wrap onto three lines.
  let base = null;
  if (d && agg.total_long_ntl != null && (agg.total_long_ntl + agg.total_short_ntl) > 0) {
    const L = agg.total_long_ntl, S = agg.total_short_ntl;
    base = L / (L + S) * 100;
    const held = split.filter((g) => g.gross > 0);
    // This number is BLENDED across every venue the sweep queried — which is
    // what a trader with size on both wants, and is only legitimate because
    // the line below prints the halves. It used to read "CORE BOOK", which
    // was false in every clause: the sweep IS dex-aware, xyz IS queried, and
    // the total already contained it. Live, core alone is 38.6% long and xyz
    // alone 62.0%; the two disagree by 23 points, so a mislabelled blend is
    // not a rounding matter.
    out.push('<div class="wh-top">' +
      '<span class="wh-skew" title="skew ' + (agg.skew_pct >= 0 ? "+" : "") +
      (agg.skew_pct || 0).toFixed(1) + '% · every row below is drawn relative ' +
      'to this. BLENDED over every venue this sweep queried (' +
      esc(split.map((g) => g.venue).join(" + ")) + '), which is why the ' +
      'split is printed under it: ' +
      esc(held.map((g) => g.venue + " alone " + g.share.toFixed(1) + "% long, net " +
        whUsd(g.net)).join(" · ")) + '.">' +
      'BOOK <b>' + base.toFixed(0) + '%</b> LONG</span>' +
      '<span class="wh-net ' + ((L - S) >= 0 ? "up" : "dn") + '">net ' +
      whUsd(L - S) + '</span></div>');
    // The decomposition. One line per queried venue, on the same left/right
    // geometry as the headline it decomposes, so the eye reads them as one
    // block: the top line is the sum of the lines under it and nothing else.
    if (split.length > 1)
      out.push('<div class="wh-vsp">' + split.map((g) => {
        const c = g.cov || {};
        const t = g.venue + (g.dex ? " (HIP-3 dex)" : " (core Hyperliquid)") +
          " · " + g.n + " coin" + (g.n === 1 ? "" : "s") +
          " · long $" + fmtBig(g.L) + " / short $" + fmtBig(g.S) +
          (c.wallets_holding != null
            ? "\n" + c.wallets_holding + " of " + (c.wallets_tracked || "?") +
              " tracked wallets hold here" +
              (c.wallets_queried != null
                ? "; " + c.wallets_queried + " queried in the last sweep" : "")
            : "") +
          (c.orders_covered === false
            ? "\nresting orders are NOT fetched on this venue" : "");
        return '<div class="wh-vg" title="' + esc(t) + '">' +
          '<span class="wh-vn">' + esc((g.venue || "core").toUpperCase()) + '</span>' +
          '<span class="wh-vs">' + (g.gross > 0
            ? '<b>' + g.share.toFixed(0) + '%</b> long'
            : 'none held') + '</span>' +
          (g.gross > 0
            ? '<span class="wh-vnet ' + (g.net >= 0 ? "up" : "dn") + '">net ' +
              whUsd(g.net) + '</span>'
            : '<span class="wh-vnet fl">swept, empty</span>') + '</div>';
      }).join("") + '</div>');
  }
  if (d) {
    /* The venue scope belongs on the tab dedicated to whales, not only in
       BOTH SIDES — and it has to run in BOTH directions. This badge used to
       read "core HL only · no xyz" directly above 94 rows of xyz data; now
       it names the venues that WERE queried, and separately names the HIP-3
       dexs that trade but are NOT swept, because a coin from those is absent
       here for the old reason: NOT LOOKED, not none. */
    const unswept = whUnswept(cov);
    const swept = (cov.dexs_swept || []).join(" + ") || "HL core";
    out.push('<div class="wh-cov"><b class="wh-ok" title="positions are ' +
      'fetched PER DEX, and this sweep queries each of: ' + esc(swept) +
      '. Every number on this tab is the sum over those venues — see the ' +
      'per-venue split under the headline. A coin on a venue that is NOT in ' +
      'that list is absent here because nothing asked about it.">' +
      esc(swept) + '</b>' +
      (unswept.length ? ' · <b class="wh-stale" title="' +
        esc(unswept.map((v) => v.dex + " $" + fmtBig(v.vol_24h) + "/24h").join(" · ")) +
        ' — these HIP-3 dexs trade but are NOT swept. They contribute nothing ' +
        'to any number here, and a coin of theirs missing from the book below ' +
        'is NOT LOOKED, not none.">' + unswept.length + ' dex' +
        (unswept.length > 1 ? "s" : "") + ' unswept</b>' : "") +
      (cov.dex_list_stale ? ' · <b class="wh-stale" title="the venue list ' +
        'itself is stale — its last measurement failed, so a dex missing from ' +
        'the swept list may be a discovery failure rather than a venue nobody ' +
        'trades">VENUE LIST STALE</b>' : "") + ' · ' +
      (cov.wallets_active != null ?
      cov.wallets_active + "/" + (cov.wallets_tracked || "?") + " wallets" : "roster warming") +
      (cov.wallets_dormant ? ' <span title="no positions for 3 sweeps — skipped until roster refresh">(' +
        cov.wallets_dormant + ' dormant)</span>' : "") +
      (cov.wallets_fresh != null && cov.last_sweep_at ?
        ' · ' + cov.wallets_fresh + ' fresh' : "") +
      // Across every venue, not just the core phase — and broken down, so a
      // clean core sweep cannot hide a shed HIP-3 pass.
      (fails.total ? ' · <b class="wh-stale" title="' +
        esc(fails.total + " wallet fetch(es) failed last sweep" +
          (fails.parts.length ? " (" + fails.parts.join(" · ") + ")" : "") +
          " — " + fails.impact) + '">' + fails.total + ' failed</b>' : "") +
      (cov.rebaselined ? ' · <span title="snapshot gap too old to diff honestly — re-baselined, no events emitted">' +
        cov.rebaselined + ' re-baselined</span>' : "") +
      (cov.last_sweep_at ? ' · swept ' + alertAgo(cov.last_sweep_at) : "") +
      (cov.roster_age_h != null ? ' · roster ' + cov.roster_age_h.toFixed(1) + 'h old' : "") +
      (cov.roster_stale ? ' · <b class="wh-stale">STALE ROSTER</b>' : "") + '</div>');
  }

  /* Fresh conviction: the largest opened/flipped positions of the day.

     A PAGE, and it was the one section on this pane that did not say so —
     sitting between RESTING ORDERS and EVENTS, which both print shown-of-held
     and carry the "this is a PAGE, not a census" tooltip. Five rows under a
     bare "· 24H" read as the whole 24 hours, so 5-of-5 and 5-of-40 looked
     identical. Same three terms as its neighbours: the count on screen, the
     server's total, and the server's own sentence (fresh_note) as the
     tooltip so this pane cannot drift from what the payload says.

     A BARE COUNT IS A CENSUS CLAIM, so it is printed only when the payload
     carries the total that backs it (5 of 5). An older server that ships
     fresh_top5 with no fresh_total gets "TOP 5" with no "OF N" when its cap
     still says the slice is a page, and no number at all when even that is
     unknown — never a bare 5 nobody measured. */
  const fresh = agg.fresh_top5 || [];
  if (fresh.length) {
    const frTot = agg.fresh_total;
    const frTrunc = frTot != null ? frTot > fresh.length
                                  : (agg.fresh_cap != null && fresh.length >= agg.fresh_cap);
    const frWhy = agg.fresh_note ||
      ('this pane draws the largest ' + fresh.length +
       (frTot != null ? ' of ' + frTot + ' fresh opens/flips in the last 24h'
                      : ' fresh opens/flips the server sends, and it sends no ' +
                        'total — how many more there are is NOT KNOWN here') +
       ' — this is a PAGE, not a census');
    const frLbl = frTrunc
      ? 'TOP ' + fresh.length + (frTot != null ? ' OF ' + frTot : '')
      : frTot != null ? String(fresh.length) : '';
    out.push('<div class="wh-h">FRESH CONVICTION · 24H' +
      (frLbl ? ' <span class="wh-n"' + (frTrunc ? ' title="' + esc(frWhy) + '"' : '') +
        '>' + frLbl + '</span>' : '') +
      ' <span class="wh-sub">largest new/flipped positions</span></div>');
    for (const e of fresh) out.push(whEventLine(e));
    if (frTrunc)
      out.push('<div class="wh-foot">' + fresh.length + ' shown' +
        (frTot != null ? ' of ' + frTot + ' fresh opens/flips in the window'
                       : ' · the server sends no total, so the rest are ' +
                         'UNCOUNTED here') +
        ' · largest by size — the rest are NOT SHOWN, not absent</div>');
  }

  // ── per-coin lean board ────────────────────────────────────────────
  // Five of the six old columns are gone from this 192px row. NET, LONG $,
  // SHORT $ and the L/S wallet counts are not deleted — they are re-sited
  // to the row tooltip and to the FULL BOOK overlay, which has 1040px to
  // print them properly. Δ24H is deleted outright: it is null for every
  // coin, and 177 chips reading "warming" is a column of zero bits. The
  // state is declared once, below, instead.
  const all = (agg.per_coin || []);
  const sorted = whSortRows(all, base);
  const shown = whalesShowAll ? sorted : sorted.filter((r) => whGross(r) >= WH_FLOOR);
  const hidden = sorted.length - shown.length;

  out.push('<div class="wh-h">PER-COIN LEAN' +
    '<span class="wh-sort" data-wcycle title="cycle sort: lean · long % · net $ · gross' +
    ' — LEAN ranks each row against the most its own side could lean, so a coin that is' +
    ' 100% short (the maximum a short lean can reach on this book) ranks with a coin far' +
    ' out on the long side. The printed number stays in raw points.">' +
    '▸ ' + whSortLabel() + '</span>' +
    '<span class="wh-sub"><span class="wh-exp" data-wbook>⤢ FULL BOOK</span></span></div>');

  // Δ24H honesty, stated once at pane level rather than 177 times in a
  // column. The sweep stores net notional per hour, not the long/short
  // split, so even when the anchor matures a lean-Δ is NOT derivable from
  // this payload — say exactly that instead of implying a bar could move.
  const anyDelta = all.some((r) => r.delta_24h_ntl != null);
  // Δ24h is per VENUE, not pane-wide: the hourly anchors written before the
  // sweep queried HIP-3 hold no xyz coins, so the server returns null there
  // rather than reporting the whole xyz book as a day of inflow. "in each
  // row tooltip" was therefore true of core rows and false of xyz rows.
  const dHave = new Set(all.filter((r) => r.delta_24h_ntl != null).map(whDex));
  const dMiss = split.filter((g) => g.n && !dHave.has(g.dex));
  /* Sibling of the empty-board branch below, found by injecting the error
     payload and reading the pane: with no sweep in hand at all, "warming, no
     24h anchor yet" is a statement about the ANCHOR STORE — it says the
     sweep ran and the anchors are still filling. Over a payload that never
     arrived it is a measurement of a thing nobody looked at. */
  if (state.whalesError && !d)
    out.push('<div class="wh-note">Δ24H — not read, along with the rest of ' +
      'this sweep</div>');
  else out.push('<div class="wh-note">Δ24H — ' + (anyDelta
    ? 'net-notional change only, in the row tooltip; a lean Δ needs a share anchor the sweep does not store'
    : 'warming, no 24h anchor yet') +
    (anyDelta && dMiss.length
      ? ' · <b class="wh-stale">none on ' +
        esc(dMiss.map((g) => g.venue).join(", ")) + '</b> — that venue entered ' +
        'the sweep less than 24h ago, so its rows have no anchor to difference ' +
        'against and read blank rather than "all new"'
      : "") + '</div>');

  if (!shown.length) {
    /* THE ERROR BRANCH COMES FIRST, and it comes first because the three
       sentences below are all MEASUREMENTS. "no whale positions recorded yet"
       says the sweep ran and found an empty book; with the load failing and
       no payload ever held, nothing was measured at all. The warn banner at
       the top of this pane names the failure — this line stops the board
       under it from quietly contradicting it. */
    out.push('<div class="wh-empty">' + (state.whalesError && !d
      ? "NOT MEASURED — the sweep could not be read (see above). This is a " +
        "question that got no answer, not a book with no whales in it."
      : d && d.warming ? "first sweep still running" :
      hidden ? "every coin is below $" + fmtBig(WH_FLOOR) + " gross" :
      "no whale positions recorded yet") + '</div>');
  } else {
    // Row zero is the BOOK ruler, drawn on the IDENTICAL grid, so the
    // waterline in the header and the waterline in every data row are the
    // same pixel column and the reference sits one row above the data
    // instead of 200px above it.
    out.push('<div class="wh-row wh-head">' +
      '<span class="wh-sym">COIN</span>' +
      '<span class="wh-axis" title="bar runs from the book\'s long share: left = more short than the book, right = more long">' +
      WH_AXIS_LBL + '</span>' +
      '<span class="wh-lean" title="the dominant side and its share of ' +
      'this coin\'s whale notional — 99%S means 99 cents of every whale ' +
      'dollar here is short. The BAR shows how that compares with the ' +
      'board as a whole.">SIDE</span>' +
      '<span class="wh-mag">GROSS</span></div>');
    if (base != null) {
      // The ruler's marker comes from whLeanTok so it CANNOT drift out of
      // the column it is the reference for: the literal it used to inline
      // put the dot in glyph cell 3 while every data row put its marker in
      // cell 1, offsetting the reference ~9.6px from the markers below it.
      out.push('<div class="wh-row wh-ref" title="the whole tracked book — ' +
        esc(split.map((g) => g.venue).join(" + ")) + ' combined: ' +
        base.toFixed(1) + '% long. Every bar below starts here, so a row\'s ' +
        'bar is its lean against the BLENDED book, not against its own venue.">' +
        '<span class="wh-sym">BOOK</span>' +
        '<span class="wh-rail ruler"></span>' +
        whLeanTok(base) +
        '<span class="wh-mag">' + whMag(
          (agg.total_long_ntl || 0) + (agg.total_short_ntl || 0)) + '</span></div>');
    }
    for (const r of shown) out.push(whCoinRow(r, base, whGross(r) < WH_FLOOR));
  }
  if (hidden > 0 || whalesShowAll) {
    out.push('<div class="wh-foot"><span class="wh-tog" data-wtoggle>' +
      (whalesShowAll ? "hide" : "show all") + '</span> · ' +
      (whalesShowAll
        ? sorted.length + " coins · rows under $1M gross are dimmed: one ticket " +
          "moves their lean 30 points, so the bar is not trustworthy there"
        : hidden + " coins under $1M gross hidden — lean is unstable at that size") +
      '</div>');
  }

  // Resting orders: where whales are WAITING. reduce-only = a planned exit
  // for an existing position; everything else is a planned entry. Distance
  // from the live mid is the actionable part — a $19M ask 1% above spot is
  // a very different fact from one 40% away.
  const ords = ((d && d.aggregates) || {}).top_orders || [];
  // Positions are swept on every venue in the strip above; ORDERS are
  // fetched on core only. Those two facts live 15px apart on this pane and
  // the section stated neither, so an empty list read as "nobody is resting
  // anywhere" for venues nothing had asked about.
  const noOrd = whNoOrderVenues(cov);
  const noOrdNames = noOrd.map((v) => v.venue || v.dex).join(", ");
  /* THE CAP IS NOT THE COUNT. ords is aggregates.top_orders, which the server
     truncates (top_orders_cap, 40 today), so printing ords.length said
     "RESTING ORDERS 40" while sitting exactly ON the cap with no "of N". This
     file already gets this right in four other places — "newest 40 the server
     hands over", "173 coins under $1M gross hidden", "4 shown", "NOT SHOWN —
     3 further listing(s)" — so this is applying a house rule, not inventing
     one. When the server sends no total the label says only what it is (the
     top N by size), never a bare number that reads as a census. */
  /* THE HEADER MUST COUNT THE ROWS ON SCREEN, NOT THE ROWS IN THE PAYLOAD.
     Fixing the server's cap in this header left a SECOND cap underneath it:
     the loop below draws ords.slice(0, WH_ORD_ROWS). Measured 2026-08-16, the
     header read "TOP 40 OF 106" over 14 rendered rows — a page size presented
     as the page, one layer down from the bug that was just fixed. There are
     two narrowings here and they are different facts, so both are named: the
     headline number is what the reader can actually count, and the tooltip
     carries the middle term (the server's 40) that explains which 14 these
     are — the largest of the largest, not the largest 14 of 106. */
  const ordTot = agg.top_orders_total;
  const ordCap = agg.top_orders_cap;
  const ordDrawn = Math.min(ords.length, WH_ORD_ROWS);
  const ordSrvTrunc = ordTot != null ? ordTot > ords.length
                                     : (ordCap != null && ords.length >= ordCap);
  const ordTrunc = ordSrvTrunc || ordDrawn < ords.length;
  out.push('<div class="wh-h">RESTING ORDERS <span class="wh-n"' +
    (ordTrunc ? ' title="' + esc('this pane draws the largest ' + ordDrawn +
      (ordDrawn < ords.length
        ? ' of the ' + ords.length + ' the server sends' : '') +
      (ordTot != null ? ', and the server itself sends only the largest ' +
        ords.length + ' of ' + ordTot + ' resting orders it holds' : '') +
      ' — this is a PAGE, not a census') + '"' : '') + '>' +
    (ordTrunc ? 'TOP ' + ordDrawn + (ordTot != null ? ' OF ' + ordTot : '')
              : ords.length) +
    '</span><span class="wh-sub">' + (noOrd.length ? "core HL only · " : "") +
    (ordTrunc ? 'largest by size · ' : '') +
    'open limit orders ≥$250K · EXIT = reduce-only</span></div>');
  if (noOrd.length) {
    // The sentence is the SERVER's own (coverage.orders_why from
    // /api/whales?coin=<a coin on that venue>), fetched once per venue, so
    // this pane cannot drift from what the chart legend and BOTH SIDES say.
    for (const v of noOrd) whLoadOrdersWhy(v.dex, all);
    const why = noOrd.map((v) => state.whOrdersWhy[v.dex]).find((x) => x);
    out.push('<div class="wh-note">core Hyperliquid only — <b class="wh-stale">' +
      esc(noOrdNames) + ' NOT FETCHED</b>. ' + esc(why ||
        ("resting orders are fetched on core Hyperliquid only, so the " +
         noOrdNames + " order book is NOT COVERED here rather than empty")) +
      '</div>');
  }
  if (!ords.length) {
    out.push('<div class="wh-empty">' + (d && d.warming ? "warming" :
      noOrd.length
        ? esc("no CORE whale limit orders ≥$250K resting right now — this is " +
              "not a statement about " + noOrdNames + ", which is not fetched")
        : "no whale limit orders ≥$250K resting right now") + '</div>');
  } else {
    // Two lines, same as the event feed. Before this the price+distance cell
    // got 34px for a ~70px string and wrapped to three lines, and the wallet
    // label was flex-squeezed to 17px rendering "0x0…" — which communicates
    // nothing, and the wallet identity is the entire reason the row exists.
    // BID/ASK is a B/A letter in --dim, deliberately NOT green/red: inside
    // this pane green/red is reserved for position side, so a green token
    // here would mean "long" 40px above and "resting buy" here.
    for (const o of ords.slice(0, WH_ORD_ROWS)) {
      const mid = state.mids[o.coin] != null ? +state.mids[o.coin]
        : ((ctxFor(o.coin) || {}).mid_px);
      /* THE PRICE THAT MATTERS, AND ITS NAME. A trigger order rests at
         limit_px and fires at trigger_px, and on the live book those are
         nowhere near each other: the same $41.5M reduce-only stop showed
         69,240 here and 64,112 on the chart — one screen, one instant, 9.7%
         apart, against spot 63,105. The chart already states the rule at
         the whOrders map ("the trigger is the price that matters, so that
         is where it is filtered and where it is drawn"); it was simply
         never carried across to this row or to the SIDES line.
         Both prices ship, each named, because they are two different facts:
         where the size sits and where it goes off. The distance-from-mid is
         computed against the FIRING price for the same reason the chart
         filters on it — that is the price the market has to reach. */
      const oIsTrig = !!(o.is_trigger && o.trigger_px != null);
      const oFire = oIsTrig ? o.trigger_px : o.limit_px;
      const away = mid ? (oFire - mid) / mid * 100 : null;
      out.push('<div class="wh-ord' + (o.reduce_only ? " exit" : "") + '">' +
        '<div class="wh-o1">' +
        whSymCell(o, "wh-osym", ' data-coin="' + esc(o.coin) + '"') +
        '<span class="wh-obs" title="resting ' +
        (o.side === "bid" ? "bid (buy)" : "ask (sell)") + '">' +
        (o.side === "bid" ? "B" : "A") + '</span>' +
        '<span class="wh-ontl">$' + fmtBig(o.ntl) + '</span>' +
        '<span class="wh-opx"></span>' +
        (o.reduce_only ? '<span class="wh-tag">EXIT</span>' : "") +
        (o.is_trigger ? '<span class="wh-tag trig">TRIG</span>' : "") +
        '</div>' +
        // Line 2 carries the two things the old row destroyed: the whole
        // wallet label and the price with its distance from mid (a $19M ask
        // 1% above spot is a very different fact from one 40% away).
        // LABEL FIRST, matching .wh-e2 in the event feed. .wh-o2 is
        // nowrap+ellipsis, so whatever sits last is what truncation eats:
        // with the price first, a long label ("beatmaker1@proton.me" is 20
        // chars against the 12 of a hex stub) pushes the line past the
        // ~37-glyph budget and the ellipsis destroys the wallet identity —
        // the one fact this row exists to carry. Ordered this way it
        // degrades the distance-from-mid instead, which is recoverable
        // from the chart. The two sibling feeds also stop disagreeing.
        '<div class="wh-o2">' + esc(o.label || "unlabelled wallet") +
        (oIsTrig ? ' · fires @' + fmtPx(o.trigger_px) +
                   ' <i title="a trigger order rests at its limit price and ' +
                   'fires at its trigger price — the chart plots the trigger">' +
                   'rests @' + fmtPx(o.limit_px) + '</i>'
                 : ' · @' + fmtPx(o.limit_px)) +
        (away != null ? ' <i>' + (away >= 0 ? "+" : "") + away.toFixed(1) +
          '% from mid</i>' : "") + '</div></div>');
    }
    // The event feed below has always closed with a "N shown" footer; this
    // list had none, so the rows simply stopped. A list that ends without
    // saying it was cut reads as one that ran out.
    if (ordTrunc)
      out.push('<div class="wh-foot">' + ordDrawn + ' shown' +
        (ordDrawn < ords.length ? ' of ' + ords.length + ' sent' : "") +
        (ordTot != null ? ' of ' + ordTot + ' held' : "") +
        ' · largest by resting size — the rest are NOT SHOWN, not absent</div>');
  }

  // Event feed: the actual tape of whale actions, newest first.
  const evs = (d && d.events) || [];
  // Same rule as RESTING ORDERS above, and the same second cap: the loop
  // draws evs.slice(0, WH_EV_ROWS), so the header read "NEWEST 100 OF 1053"
  // over 60 rendered rows. The headline counts what is on screen; the tooltip
  // carries the server's page size, which is the term that explains WHICH 60.
  const evTot = d && d.events_total;
  const evDrawn = Math.min(evs.length, WH_EV_ROWS);
  const evTrunc = (evTot != null && evTot > evs.length) || evDrawn < evs.length;
  out.push('<div class="wh-h" id="wh-feed">EVENTS <span class="wh-n"' +
    (evTrunc ? ' title="' + esc('this pane draws the newest ' + evDrawn +
      (evDrawn < evs.length ? ' of the ' + evs.length + ' the server hands over' : '') +
      (evTot != null ? ', and the server itself hands over only the newest ' +
        evs.length + ' of ' + evTot + ' whale events it holds' : '') +
      ' — this is a PAGE, not the tape') + '"' : '') +
    '>' + (evTrunc ? 'NEWEST ' + evDrawn + (evTot != null ? ' OF ' + evTot : '')
                   : evs.length) +
    '</span><span class="wh-sub">≥$250K position deltas · 15m granularity</span></div>');
  if (!evs.length) {
    out.push('<div class="wh-empty">' + (d && d.warming ?
      "none yet — the diff needs two completed sweeps" :
      "no qualifying whale moves since tracking began") + '</div>');
  } else {
    for (const e of evs.slice(0, WH_EV_ROWS)) out.push(whEventLine(e));
    out.push('<div class="wh-foot">' + evDrawn + ' shown' +
      (evDrawn < evs.length ? ' of ' + evs.length + ' sent' : "") +
      (evTot != null ? ' of ' + evTot + ' held' : "") +
      ' · a move is an open/close/flip or a ±30% size change worth ≥$250K, ' +
      'seen between two 15-minute sweeps · ≥$1M moves also go to telegram</div>');
  }

  // The host td must reset white-space AND overflow AND max-width. The watch
  // table sets td{white-space:nowrap; overflow:hidden} and max-width:90px on
  // every cell; a pane rendered inside #wbody inherits all three and gets
  // silently clipped. This is the recurring bug class in this file — the
  // inline reset here and the .whales-pane / td:has() rules in style.css are
  // two halves of one fix. Do not remove either.
  // --wl is the waterline x, set ONCE on the pane so every row's rail and the
  // BOOK ruler share the same pixel column and read as a vertical reference.
  $("wbody").innerHTML = '<tr><td colspan="7" style="white-space:normal;' +
    'overflow:visible;max-width:none"><div class="whales-pane"' +
    (base != null ? ' style="--wl:' + base.toFixed(2) + '%"' : "") + '>' +
    out.join("") + '</div></td></tr>';

  const cyc = document.querySelector("[data-wcycle]");
  if (cyc) cyc.onclick = () => { whCycleSort(); renderWhalesTab(); };
  const tog = document.querySelector("[data-wtoggle]");
  if (tog) tog.onclick = () => { whalesShowAll = !whalesShowAll; renderWhalesTab(); };
  const exp = document.querySelector("[data-wbook]");
  if (exp) exp.onclick = () => openWhaleBook();
  document.querySelectorAll(".wh-row[data-coin], .wh-coin[data-coin], " +
    ".wh-osym[data-coin]").forEach((el) => {
    el.onclick = () => { if (exactCoin(el.dataset.coin)) selectCoin(el.dataset.coin); };
  });
}

/* ── FULL BOOK overlay ──────────────────────────────────────────────────
   A 177-row x 10-column table has no home in a 204px pane, and no amount of
   typography changes that — so it is re-sited, not deleted. Everything the
   scanner row gave up (net, long $, short $, wallet counts, concentration)
   is printed here in full, at 1040px, with the SAME rail geometry and the
   SAME waterline, so the encoding learned in the pane transfers unchanged.
   Reuses the existing #dossier modal via dataset.mode, like the help panel. */
function openWhaleBook() {
  const el = $("dossier");
  clearInterval(state.dossierTimer);      // stop the symbol dossier repaint
  state.dossierCoin = null;
  el.dataset.mode = "whales";
  renderWhaleBook();
  el.style.display = "flex";
}

const WB_COLS = [["dev", "LEAN"], ["share", "LONG %"], ["net", "NET $"],
                 ["gross", "GROSS"]];

function renderWhaleBook() {
  const agg = ((state.whales || {}).aggregates) || {};
  const cov = ((state.whales || {}).coverage) || {};
  const L = agg.total_long_ntl || 0, S = agg.total_short_ntl || 0;
  const base = (L + S) > 0 ? L / (L + S) * 100 : null;
  const rows = whSortRows(agg.per_coin || [], base);
  const hd = (sub, extra) => '<div class="dh"><span class="dh-sym">WHALE BOOK</span>' +
    '<span class="dh-px">' + sub + '</span>' + (extra || "") +
    '<span class="spacer"></span><span class="dh-x" id="dz-close">✕</span></div>';

  // The overlay is reachable by W and by ⌘K, i.e. before the WHALES tab has
  // ever been opened and therefore before loadWhales() has necessarily
  // resolved — and loadWhales leaves state.whales null on a failed fetch.
  // Rendering the normal table there printed "WHALE BOOK / 0 coins" plus the
  // full legend: a positive assertion that the tracked book is empty, with
  // no loading state, no error and no retry. The tab guards this correctly;
  // the overlay did not. Mirror the tab.
  if (!state.whales) {
    $("dossier").innerHTML = '<div class="dbox">' +
      hd(state.whalesError ? "unavailable" : "loading") +
      '<div class="dbody"><div class="whales-pane wb-pane">' +
      (state.whalesError
        ? '<div class="wh-warn">could not load whale data — <b>' +
          esc(state.whalesError) + '</b><br>retrying automatically…</div>'
        : '<div class="wh-empty">loading whale flow…</div>') +
      '</div></div></div>';
    $("dz-close").onclick = closeDossier;
    if (!state.whalesError) loadWhales();
    return;
  }

  // The overlay prints the SAME blended aggregate as the pane, and it has
  // 1040px, so the decomposition goes inline rather than into a tooltip.
  const split = whVenueSplit(agg.per_coin || [], cov);
  const held = split.filter((g) => g.gross > 0);
  const head = hd(rows.length + ' coins',
    base != null ? '<span class="fl">book ' + base.toFixed(1) + '% long · net ' +
      whUsd(L - S) + (held.length > 1 ? ' · blended: ' + esc(held.map((g) =>
        g.venue + " " + g.share.toFixed(1) + "% long (" + g.n + " coins, net " +
        whUsd(g.net) + ")").join(" · ")) : "") + '</span>' : "");

  const cell = (r) => {
    const s = whShare(r), c = whConc(r);
    return '<div class="wb-row" data-coin="' + esc(r.coin) + '"' +
      (whGross(r) < WH_FLOOR ? ' data-tiny="1"' : "") +
      ' title="' + esc(whRowTitle(r, base)) + '">' +
      whSymCell(r, "wh-sym") +
      whRail(r, base, true) +
      whLeanTok(whShare(r)) +
      '<span class="wb-c">' + (s == null ? "–" : s.toFixed(0) + "%") + '</span>' +
      '<span class="wb-c">$' + fmtBig(r.long_ntl || 0) + '</span>' +
      '<span class="wb-c">$' + fmtBig(r.short_ntl || 0) + '</span>' +
      // NET carries no hue. whUsd() already prints the sign, so the colour
      // added no bit — and it collided: LEAN is measured against the book's
      // 27.5% long share while NET is measured against zero, so every coin
      // between ~30% and ~50% long leans long (green L+) while still being
      // net short in dollars (red). Measured live that is 11 of the 42 rows
      // above the floor; ETH is the worst, "L+8" green beside "-$143.2M"
      // red on one line with nothing saying they are different frames.
      // Same two-adjacent-dollar-columns failure the pane was rebuilt to
      // remove, reappearing inside the overlay.
      '<span class="wb-c' + (r.net_ntl == null ? " fl" : "") + '">' +
      whUsd(r.net_ntl) + '</span>' +
      '<span class="wb-c fl">' + (r.n_long || 0) + " / " + (r.n_short || 0) + '</span>' +
      '<span class="wb-c' + (whConcHot(c) ? " hot" : " fl") + '">' +
      (c == null ? "–" : (c >= 1 ? c.toFixed(1) + "×S" : (1 / c).toFixed(1) + "×L")) +
      '</span>' +
      '<span class="wh-mag">' + whMag(whGross(r)) + '</span></div>';
  };

  $("dossier").innerHTML = '<div class="dbox">' + head +
    '<div class="dbody"><div class="whales-pane wb-pane"' +
    (base != null ? ' style="--wl:' + base.toFixed(2) + '%"' : "") + '>' +
    '<div class="wh-note">sort: ' +
    WB_COLS.map(([k, lbl]) => '<span class="wb-s' + (k === whalesSortKey ? " on" : "") +
      '" data-wbsort="' + k + '">' + lbl + '</span>').join(" · ") +
    ' · bar runs from the book\'s long share — left of it = more short than the ' +
    'book, right = more long · × column is the concentration ratio (avg ticket, ' +
    'S = short side heavier)</div>' +
    '<div class="wb-row wb-head"><span class="wh-sym">COIN</span>' +
    '<span class="wh-axis">' + WH_AXIS_LBL + '</span>' +
    '<span class="wh-lean">SIDE</span><span class="wb-c">LONG%</span>' +
    '<span class="wb-c">LONG $</span><span class="wb-c">SHORT $</span>' +
    '<span class="wb-c">NET</span><span class="wb-c">L / S</span>' +
    '<span class="wb-c">CONC</span><span class="wh-mag">GROSS</span></div>' +
    (base != null ? '<div class="wb-row wh-ref"><span class="wh-sym">BOOK</span>' +
      '<span class="wh-rail wide ruler"></span>' +
      whLeanTok(base) +
      '<span class="wb-c">' + base.toFixed(0) + '%</span>' +
      '<span class="wb-c">$' + fmtBig(L) + '</span>' +
      '<span class="wb-c">$' + fmtBig(S) + '</span>' +
      '<span class="wb-c">' + whUsd(L - S) + '</span>' +   // uncoloured, as the rows
      '<span class="wb-c fl">–</span><span class="wb-c fl">–</span>' +
      '<span class="wh-mag">' + whMag(L + S) + '</span></div>' : "") +
    rows.map(cell).join("") +
    '</div></div></div>';

  $("dz-close").onclick = closeDossier;
  document.querySelectorAll("[data-wbsort]").forEach((b) => {
    b.onclick = () => { whalesSortKey = b.dataset.wbsort; renderWhaleBook();
      if (state.wtab === "whales") renderWhalesTab(); };
  });
  document.querySelectorAll(".wb-row[data-coin]").forEach((el) => {
    el.onclick = () => {
      if (exactCoin(el.dataset.coin)) { selectCoin(el.dataset.coin); closeDossier(); }
    };
  });
}

/* ── PORT: positions and risk ────────────────────────────────────────────
   The terminal could say what the market was doing but never what YOU were
   exposed to. This is that pane: read-only account state from Hyperliquid,
   with the three numbers a risk decision actually turns on — distance to
   liquidation, concentration, and the funding you pay per day to keep the
   book on. It is deliberately incapable of trading: no key ever reaches
   this terminal, and there is no order path in the codebase. */
const PORT_KEY = "hlterm_port_addr";

function portAddr() {
  try { return localStorage.getItem(PORT_KEY) || ""; } catch (e) { return ""; }
}

/* ── Account-level liquidation, for CROSS-margined books ──────────────────
   Hyperliquid returns liquidationPx = null for EVERY cross position. There is
   no per-position liquidation price to return, because the venue account is a
   single collateral pool: any leg can be closed to save the rest. That null
   is a MISSING FIELD, not a safe position, and this pane used to render it as
   "no liquidation price (unlevered)" over a 6.5x book.

   The number that actually ends a cross account is how far the book can move
   against it before equity falls to maintenance margin:

       (account_value - maint_margin) / total_notional

   MEASURED 2026-08-14 on the owner's core account — $1,006 equity, $513
   maint, $6,629 notional -> 7.44% adverse move. That back-solves to a ~7.7%
   blended maintenance rate, ABOVE every published per-asset rate (xyz 10x ->
   5.00%, BTC 40x -> 1.25%), so it can never be assumed or hardcoded: it comes
   off the live marginSummary and moves on every tick.

   PER VENUE, never summed. marginSummary is per HIP-3 dex, so a winning xyz
   leg cannot pay maintenance on a losing core leg — two accounts, two
   liquidations. portfolio.py build_all() refuses to sum these fields for the
   same reason; there is deliberately no cross-venue headline here either.

   mm > 0 is the gate: crossMaintenanceMarginUsed is zero when nothing is
   cross-margined, and an isolated-only venue has real per-position liq prices
   instead. On a MIXED book total_notional still counts the isolated legs, so
   the denominator runs large and the figure understates the cushion — it errs
   toward warning, which is the side to err on. */
const ACCT_DANGER_PCT = 10.0;   // mirrors portfolio.py LIQ_DANGER_PCT
const ACCT_WARN_PCT = 25.0;     // mirrors portfolio.py LIQ_WARN_PCT

/* The ratio above is only a DISTANCE inside a window, and outside that window
   it stops being a quantity at all. Two edges, both reachable off live
   marginSummary shapes:

     equity <= maintenance  ->  the numerator goes negative and the old code
       printed "-6.2% adverse move" as a forward-looking distance. MEASURED on
       {account_value:100, maint_margin:515, total_notional:6668}. There is no
       distance left to travel: the account is ALREADY below maintenance and
       eligible for liquidation now. A negative distance is not a small
       distance, and this is exactly the state the figure exists to warn about.

     cushion >> notional  ->  {account_value:1000, maint_margin:1,
       total_notional:1e-7} gave "999000000000.0% adverse move" with the green
       "ok" bar. The inputs are real; the ratio is arithmetic noise off a dust
       denominator, and a reassuring band on noise is the same lie as a
       confident number on a missing field.

   So the state is what callers get, and the raw percent only survives inside
   the window where it means what the sentence around it claims. Frozen: these
   records are read by four panes and must never be edited in place. */
const ACCT_REMOTE_PCT = 100.0;  // above this the whole book must move >100%
const ACCT_UNKNOWN = Object.freeze({ state: "unknown", pct: null, shortfall: null });

function acctLiqState(v) {
  if (!v) return ACCT_UNKNOWN;
  const eq = +v.account_value, mm = +v.maint_margin, ntl = +v.total_notional;
  if (!isFinite(eq) || !isFinite(mm) || !isFinite(ntl)) return ACCT_UNKNOWN;
  if (!(mm > 0) || !(ntl > 0)) return ACCT_UNKNOWN;
  const cushion = eq - mm;
  if (!(cushion > 0))
    return Object.freeze({ state: "breached", pct: null, shortfall: mm - eq });
  const pct = cushion / ntl * 100;
  // A ratio that overflows to Infinity is the dust case taken to its limit —
  // the fields ARE present, so calling it "unknown" would misreport why. It is
  // remote, with no number: nothing here should ever print Infinity.
  if (!isFinite(pct) || pct > ACCT_REMOTE_PCT)
    return Object.freeze({ state: "remote", pct: isFinite(pct) ? pct : null, shortfall: null });
  return Object.freeze({ state: "ok", pct, shortfall: null });
}

/* $ for the maintenance shortfall. fmtBig floors anything under $1000 to whole
   dollars, and "$0 short" on a breached account would read as "not short". */
function acctShortfallUsd(x) {
  const v = Math.abs(+x || 0);
  return v >= 1000 ? fmtBig(v) : v.toFixed(2);
}

/* A number ONLY when it is a real forward distance. Every other state is null
   here so no caller can print it as one; callers that have room to say more
   read acctLiqState() directly. */
function acctAdverseMovePct(v) {
  const s = acctLiqState(v);
  return s.state === "ok" ? s.pct : null;
}

function acctBand(p) {
  return p == null ? ""
    : p <= ACCT_DANGER_PCT ? "danger"
    : p <= ACCT_WARN_PCT ? "warn" : "ok";
}

/* The venue account a position sits in. Positions carry `dex`; venue records
   are keyed by the same field. null means the record is ABSENT — the caller
   must say "unknown", never assume the leg is unlevered. */
function portVenueRec(dex) {
  const d = state.port || {};
  const want = portAddr().toLowerCase();
  // Guard the address: state.port is shared with the SIDES pane, and a figure
  // from a previously-pasted wallet next to this one's positions would be a
  // confident wrong number.
  if (!d.address || !want || d.address.toLowerCase() !== want) return null;
  return (d.venues || []).find((v) => (v.dex || "") === (dex || "")) || null;
}

/* The liquidation line for one position — two shapes, because Hyperliquid has
   two margin modes and only one of them has a per-position price. Absence of
   liq_px is reported as absence of a NUMBER, never as absence of RISK. */
function portLiqLineHtml(p) {
  const mode = esc(p.lev_type || "cross");
  const lev = p.leverage ? p.leverage + "x " : "";
  const isolated = (p.lev_type || "") === "isolated";
  // Keyed on liq_px, NOT liq_dist_pct. portfolio.py computes liq_dist only
  // `if liq and mark`, so a position that HAS a liquidation price but no
  // usable mark used to fall through to the cross branch and print two false
  // statements at once: "no per-position liq price" (there is one, in this
  // very payload, unprinted) and a cross account-level move that does not
  // govern an isolated leg at all — isolated margin is walled off from the
  // cross pool. Branch on the field that means what the sentence claims.
  const lq = +p.liq_px;
  const hasLiq = isFinite(lq) && lq > 0;   // portfolio.py treats 0 as absent too
  if (hasLiq) {
    const liq = p.liq_dist_pct;
    if (liq != null) {
      const band = p.liq_band || "";
      return '<div class="po-liq ' + band + '"><span class="po-liqbar"><i style="width:' +
        Math.max(2, Math.min(100, 100 - liq)).toFixed(0) + '%"></i></span>' +
        '<span>liq ' + fmtPx(p.liq_px) + ' — <b>' + liq.toFixed(1) +
        '% away</b>' + (band === "danger" ? " · TIGHT" : "") + '</span></div>';
    }
    // Price known, distance not: no mark for this market, so the % away
    // cannot be computed. Print the price that DOES exist and say which half
    // is missing — never silently promote this to the account-level story.
    return '<div class="po-liq warn"><span>' + lev + mode + ' — liq <b>' +
      fmtPx(p.liq_px) + '</b>, but no mark price for this market, so the ' +
      'distance to it is <b>UNKNOWN</b>, not safe.</span></div>';
  }
  const v = portVenueRec(p.dex);
  // An isolated leg with no liquidation price: the cross figure is the wrong
  // account. Say unknown rather than borrow a number that cannot liquidate it.
  if (isolated)
    return '<div class="po-liq warn"><span>' + lev + mode + ' — this leg is ' +
      'isolated-margined, and no liquidation price came back for it. The ' +
      (v ? esc(v.venue) + ' ' : '') + 'cross account-level figure does NOT ' +
      'govern an isolated leg. Distance to liquidation: <b>UNKNOWN</b>, not ' +
      'safe.</span></div>';
  const st = acctLiqState(v);
  if (st.state === "unknown")
    return '<div class="po-liq warn"><span>' + lev + mode + ' — no per-position ' +
      'liquidation price exists in this margin mode, and the ' +
      (v ? esc(v.venue) + ' account' : 'venue account') + ' figures needed for the ' +
      'account-level distance are not in this payload. Distance to liquidation: ' +
      '<b>UNKNOWN</b>, not safe.</span></div>';
  if (st.state === "breached")
    return '<div class="po-liq danger"><span>' + lev + mode + ' — no per-position ' +
      'liq price; equity on ' + esc(v.venue) + ' is <b>already AT or BELOW ' +
      'maintenance margin</b> (short by $' + acctShortfallUsd(st.shortfall) + '). There is ' +
      'no adverse move left to measure — the account is liquidatable ' +
      'NOW.</span></div>';
  if (st.state === "remote")
    return '<div class="po-liq"><span>' + lev + mode + ' — no per-position liq ' +
      'price; liquidation is ACCOUNT-level on ' + esc(v.venue) + ' and needs a ' +
      '<b>&gt;100% adverse move</b> on the whole book: the notional is tiny ' +
      'against equity, so the exact figure is arithmetic noise, not a ' +
      'measurement.</span></div>';
  const am = st.pct;
  const b = acctBand(am);
  return '<div class="po-liq ' + b + '"><span class="po-liqbar"><i style="width:' +
    Math.max(2, Math.min(100, 100 - am)).toFixed(0) + '%"></i></span>' +
    '<span>' + lev + mode + ' — no per-position liq price; liquidation is ' +
    'ACCOUNT-level on ' + esc(v.venue) + ': <b>' + am.toFixed(1) +
    '% adverse move</b> on the whole book' +
    (b === "danger" ? " · TIGHT" : "") + '</span></div>';
}

async function loadPort() {
  const addr = portAddr();
  if (!addr) { state.port = { status: "no-address" }; return; }
  try {
    const r = await fetch("/api/portfolio?addr=" + encodeURIComponent(addr));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    // 200 + {error} carries no `status`, so without this it fell through
    // renderPortTab's status checks to `!d.address` and drew CONNECT A WALLET
    // over a wallet that IS connected — a failed read wearing the clothes of
    // an unconfigured desk. The catch below shapes it as status:"error".
    if (d && d.error && !d.status) throw new Error(d.error);
    /* THE STALE-ADDRESS GUARD, the same one loadStops and portVenueRec carry
       and the same one this function shipped without. The port-addr input can
       change mid-flight and the poll is 20s: a late reply for the PREVIOUSLY
       pasted wallet used to be assigned unconditionally, so another man's
       positions, exposure and liquidation distances rendered as this wallet's
       for up to a full poll cycle, with nothing on screen marking them. Drop
       the response instead — the next poll answers for the current address. */
    if (d.address && d.address.toLowerCase() !== portAddr().toLowerCase()) return;
    state.port = d;
  } catch (e) {
    state.port = { status: "error", error: (e && e.message) || String(e) };
  }
  if (state.wtab === "port") renderPortTab();
  updateTabBadges();
}

/* ── RESTING ORDERS / STOPS ───────────────────────────────────────────────
   /api/stops is the route that did not exist when this pane first shipped.
   Until 2026-08-16 nothing in this terminal fetched frontendOpenOrders for
   the owner's wallet, so the only honest thing the PORT and SIDES panes
   could say about protection was "NOT MEASURED" — and they said it. That
   sentence is now replaced by a real measurement, in three states, and the
   third one still says NOT MEASURED.

   THE FAILURE MODE THIS CODE EXISTS TO AVOID. A failed order query and a
   wallet with no stops produce the same empty list, and rendering the first
   as the second tells a man carrying 9.1x beta-weighted equity that his book
   is unprotected when in fact nothing was checked — or, far worse in the
   other direction, prints a reassuring green line over a venue that never
   answered. So `state` is read from the server and never inferred from
   whether `orders` happens to be empty: the server sets `zero_note` if and
   only if it measured a zero, and that is the only key that means one.

   STRICTLY READ-ONLY, like everything else on this desk: this reads public
   per-address order state and cannot place, modify or cancel anything. */
async function loadStops() {
  const addr = portAddr();
  if (!addr) { state.stops = null; return; }   // null = never asked, not zero
  try {
    const r = await fetch("/api/stops?addr=" + encodeURIComponent(addr));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    // SIBLING OF THE GUARD BELOW, and of the same shape. Every failure this
    // route raises itself carries `status`+`state`; the do_GET catch-all's
    // 200 + {error} carries neither, so it landed here as a payload whose
    // `state` was undefined — which is not "not_measured", so portStopsHtml
    // fell straight through to the measured-zero branch and printed a count
    // of unprotected legs over a query that never ran. The catch below is
    // where a failure belongs: it shapes one as the not_measured contract.
    if (d && d.error && !d.state) throw new Error(d.error);
    // A response for a wallet that is no longer the configured one must not
    // land: the address can change mid-flight from the port-addr input.
    if (d.address && d.address.toLowerCase() !== portAddr().toLowerCase()) return;
    state.stops = d;
  } catch (e) {
    /* A transport failure is NOT MEASURED, and it is shaped like the
       server's own not_measured payload so every consumer has one contract
       to read. `orders` is null rather than [] on purpose — an empty array
       here would be indistinguishable from a measured empty book. */
    state.stops = {
      status: "error", state: "not_measured", orders: null, n_orders: null,
      error: (e && e.message) || String(e),
      why: "the request for your resting orders failed in this browser, so " +
           "nothing about them was measured — this is not a book with no " +
           "stops in it, it is a question that got no answer",
    };
  }
  if (state.wtab === "port") renderPortTab();
  if (state.sides) renderSides();
}

/* The block the PORT pane leads with. Returns "" only when there is no
   wallet configured at all — every other state, including total failure,
   produces a visible sentence. */
function portStopsHtml() {
  const s = state.stops;
  if (!portAddr()) return "";
  if (!s) {
    return '<div class="po-stops unk"><div class="po-sh">STOPS — NOT MEASURED</div>' +
      '<div class="po-sw">the resting-order query has not run yet this ' +
      'session. This is the absence of a measurement, not a measurement of ' +
      'an absence: it is not evidence that a stop exists and not evidence ' +
      'that one does not.</div></div>';
  }
  if (s.state === "not_measured") {
    // Name the venue and the error, per the brief's third state. `failed`
    // carries both when the route got far enough to ask; `error`/`why` carry
    // them when it did not.
    const named = (s.failed || []).map((f) =>
      esc((f.venue || "?") + " — " + (f.error || f.error_kind || "no reason given")));
    return '<div class="po-stops unk"><div class="po-sh">STOPS — NOT MEASURED</div>' +
      '<div class="po-sw">' + esc(s.why || s.not_measured_note || s.error ||
        "the resting-order query did not complete") +
      (named.length ? '<br><b>failed:</b> ' + named.join(' · ') : "") +
      (s.error && !named.length ? '<br><b>error:</b> ' + esc(s.error) : "") +
      '<br>Nothing here is a zero. A silent pane is not evidence either way.' +
      '</div></div>';
  }
  const nUnp = s.n_unprotected || 0;
  const nPos = s.n_positions || 0;
  const nUnk = s.n_protection_not_measured || 0;
  const partial = s.state === "partial";
  // A measured zero is loud, because on this book it is the finding. It is
  // stated as a count of UNPROTECTED LEGS rather than of orders: "0 orders"
  // is a fact about the order book, "4 of 4 positions have no stop" is the
  // fact about the risk, and only the second one is actionable.
  const danger = nPos > 0 && nUnp > 0;
  const cls = danger ? "danger" : nUnk ? "unk" : "ok";
  const head = nPos === 0
    ? (s.n_orders ? s.n_orders + " RESTING ORDER" + (s.n_orders === 1 ? "" : "S") +
        " · NO OPEN POSITION" : "NO RESTING ORDERS · NO OPEN POSITION")
    : danger
      ? nUnp + " OF " + nPos + " POSITION" + (nPos === 1 ? "" : "S") +
        (nUnp === 1 ? " HAS NO STOP" : " HAVE NO STOP") +
        // A partial sweep can hold BOTH kinds of leg at once, and the
        // unmeasured ones must not hide behind the unprotected count: "3 of 4
        // have no stop" over a 4th nobody asked about is a total that reads
        // as complete. Named in the headline, not only in the note below it.
        (nUnk ? " · " + nUnk + " NOT MEASURED" : "")
      : nUnk
        ? nUnk + " OF " + nPos + " POSITIONS — PROTECTION NOT MEASURED"
        : "EVERY POSITION HAS A STOP";
  const bits = [];
  bits.push((s.n_orders || 0) + " resting order" + (s.n_orders === 1 ? "" : "s"));
  if (s.n_stop_loss != null) bits.push(s.n_stop_loss + " stop-loss");
  if (s.n_take_profit != null) bits.push(s.n_take_profit + " take-profit");
  if (s.n_open_or_add) bits.push(s.n_open_or_add + " entry/add");
  let why = "";
  if (s.zero_note) why = s.zero_note;                    // the ONLY measured zero
  else if (s.n_orders) why = "resting on " + esc((s.venues_ok || []).join(", "));
  return '<div class="po-stops ' + cls + '">' +
    '<div class="po-sh">' + esc(head) + '</div>' +
    '<div class="po-schips">' + bits.map((b) =>
      '<span class="po-chip">' + esc(b) + '</span>').join("") + '</div>' +
    (why ? '<div class="po-sw">' + esc(why) + '</div>' : "") +
    (partial ? '<div class="po-sw"><b>LOWER BOUND</b> — ' +
      esc(s.partial_note || "some venue failed the order query") + '</div>' : "") +
    (s.positions_missing_note ? '<div class="po-sw">' +
      esc(s.positions_missing_note) + '</div>' : "") +
    (s.scan_blind_spot_note ? '<div class="po-sw dimmer">' +
      esc(s.scan_blind_spot_note) + '</div>' : "") +
    '<div class="po-sw dimmer">read-only — this terminal cannot place, ' +
    'modify or cancel an order' +
    /* Was `s.age_s` — the age the payload had when this client FETCHED it,
       standing unchanged for up to the 90s poll. Same class as the buyback
       chip, one pane over, with a smaller ceiling: /api/stops ships `at`, so
       the age counts the server's build plus this page's hold. */
    (srvAgeS(s) != null ? ' · measured ' + Math.round(srvAgeS(s)) + 's ago' : "") +
    '</div></div>';
}

/* THE RISK BLOCK THE SERVER HAS ALWAYS SHIPPED AND NOTHING EVER READ.

   /api/portfolio computes, per venue, seven figures that answer "how much
   room is left" rather than "how much is on": withdrawable, margin_ratio_pct,
   net_exposure / net_exposure_pct, concentration_pct + concentration_coin,
   funding_pct_equity_day. All seven were 0-reference in this file. The PORT
   tab showed SIZE — account value, gross leverage, unrealized, the position
   table — and never HEADROOM, which is the half that decides whether the
   next clip is placeable at all.

   Measured on the owner's own book 2026-08-19 12:5x IST: withdrawable $0.00,
   margin_ratio_pct 108.4%, net_exposure_pct +1084%, concentration_pct 521.2%
   (NEAR), funding_pct_equity_day -0.163%/day. Free collateral is exhausted
   and margin used exceeds equity — neither fact appeared anywhere on the
   pane.

   EVERY FIGURE CARRIES ITS OWN AGE AND ITS OWN DENOMINATOR, per this desk's
   standard: the age is the venue's own build stamp plus this client's hold
   time (`v.at`, not the page's), and each percentage names what it is a
   percentage OF in its tooltip, because "108%" and "1084%" are meaningless
   without it. A field the payload does not carry is DROPPED, never rendered
   as a zero — an older server that predates one of these must not be made to
   assert that free collateral is $0. */
function portRiskHtml(v) {
  if (!v) return "";
  /* HEADROOM IS ONLY A QUESTION IF THERE IS SOMETHING TO HAVE ROOM FOR.
     Measured on the owner's own book: this pane lists ten venues and nine of
     them are empty HIP-3 accounts, so an ungated strip drew nine red "$0 free
     collateral" chips — the alarm hue, nine times, for accounts holding
     nothing. A zero withdrawable on a $0 account is arithmetic, not a
     finding, and a warning that fires on nine empty rows is how the real one
     on HL core stops being read. */
  if (!v.n_positions && !(v.account_value > 0)) return "";
  const bits = [];
  const has = (x) => x != null && isFinite(x);
  // Free collateral: the only figure here denominated in dollars, and the one
  // that answers "can I place anything at all". Zero is a real, loud finding.
  if (has(v.withdrawable))
    bits.push('<span class="po-rk' + (v.withdrawable <= 0 ? " hot" : "") +
      '" title="withdrawable balance on ' + esc(v.venue || "this venue") +
      ' — collateral not already posted against a position. ' +
      (v.withdrawable <= 0
        ? 'AT ZERO: every dollar of equity here is spoken for, so a new leg ' +
          'or an add can only come from closing something else.'
        : 'This is what a new position or an add can draw on.') +
      ' Per venue — Hyperliquid keeps a separate margin account per dex.">' +
      '<b>$' + fmtBig(v.withdrawable) + '</b><i>free collateral</i></span>');
  if (has(v.margin_ratio_pct))
    bits.push('<span class="po-rk' + (v.margin_ratio_pct >= 100 ? " hot"
        : v.margin_ratio_pct >= 60 ? " warn" : "") +
      '" title="initial margin posted, as a percentage of account EQUITY' +
      (has(v.margin_used) ? ' ($' + fmtBig(v.margin_used) + ' of $' +
        fmtBig(v.account_value) + ')' : '') + '. ' +
      (v.margin_ratio_pct >= 100
        ? 'Over 100% means the margin posted against these positions now ' +
          'exceeds what the account is worth — unrealised losses have eaten ' +
          'the difference. This is not the maintenance test (see equity ' +
          'above maint), it is how fully the account is committed.'
        : 'The maintenance test is the separate chip above; this is ' +
          'commitment, not proximity to liquidation.') + '">' +
      '<b>' + v.margin_ratio_pct.toFixed(0) + '%</b><i>margin of equity</i></span>');
  if (has(v.net_exposure_pct))
    bits.push('<span class="po-rk ' + (v.net_exposure_pct >= 0 ? "up" : "dn") +
      '" title="DIRECTIONAL net (longs minus shorts' +
      (has(v.net_exposure) ? ' = ' + (v.net_exposure >= 0 ? "+" : "") + '$' +
        fmtBig(Math.abs(v.net_exposure)) : '') +
      ') as a percentage of account equity. Gross leverage counts both sides ' +
      'and so cannot tell a hedged book from a one-way one; this can. ' +
      Math.abs(v.net_exposure_pct / 100).toFixed(1) + 'x equity ' +
      (v.net_exposure_pct >= 0 ? 'net LONG' : 'net SHORT') + '.">' +
      '<b>' + (v.net_exposure_pct >= 0 ? "+" : "") +
      v.net_exposure_pct.toFixed(0) + '%</b><i>net exposure</i></span>');
  if (has(v.concentration_pct))
    bits.push('<span class="po-rk' + (v.concentration_pct >= 200 ? " warn" : "") +
      '" title="the single LARGEST leg on this venue' +
      (v.concentration_coin ? ' (' + esc(v.concentration_coin) + ')' : '') +
      ', as a percentage of account equity. On a cross-margined book every ' +
      'leg is paid for out of the same collateral, so this is the share of ' +
      'the account riding on one symbol.">' +
      '<b>' + v.concentration_pct.toFixed(0) + '%</b><i>biggest leg' +
      (v.concentration_coin ? ' · ' + esc(v.concentration_coin) : '') +
      '</i></span>');
  if (has(v.funding_pct_equity_day))
    bits.push('<span class="po-rk ' + (v.funding_pct_equity_day >= 0 ? "up" : "dn") +
      '" title="funding at the CURRENT hourly rate, annualised to a day, as a ' +
      'percentage of account equity' +
      (has(v.funding_usd_day) ? ' (' + (v.funding_usd_day >= 0 ? "+" : "") +
        '$' + Math.abs(v.funding_usd_day).toFixed(2) + '/day)' : '') +
      '. A rate, not a measurement of what has been paid: it holds only for ' +
      'as long as the rate does.">' +
      '<b>' + (v.funding_pct_equity_day >= 0 ? "+" : "") +
      v.funding_pct_equity_day.toFixed(3) + '%</b><i>funding / day</i></span>');
  if (!bits.length) return "";
  // The age of THIS venue's read, not the page's — a partial sweep refreshes
  // venues independently, so a page-level stamp would date the wrong thing.
  const ageS = v.at != null ? Math.max(0, Date.now() / 1000 - v.at) : null;
  return '<div class="po-risk">' + bits.join("") +
    '<span class="po-rknote">headroom, per venue' +
    (ageS != null ? ' · measured ' + (ageS < 90 ? Math.round(ageS) + 's'
      : Math.round(ageS / 60) + 'm') + ' ago' : '') +
    ' · every % is of THIS venue’s equity, and no two venues share one' +
    '</span></div>';
}

/* THE PER-LEG PROTECTION TABLE. /api/stops has always shipped `protection[]`
   — one row per position carrying state, covered_pct, nearest_stop_px,
   n_exit_orders, liq_dist_pct and a written `why` naming the venue that
   answered — and portStopsHtml rendered only the aggregate counts. The
   per-leg detail existed in exactly one place: the SIDES pane, for the ONE
   coin currently charted. So the owner could learn that 3 of 3 legs are
   unprotected but had to chart each symbol in turn to learn WHICH leg sits
   closest to liquidation.

   THE THREE STATES ARE KEPT APART, and that is the point of the table rather
   than a longer sentence. 'unprotected' is a MEASURED zero — the venue
   answered and holds no closing order. 'not_measured' is the absence of an
   answer. They must never share a block, because a table that sorts them
   together turns "nobody asked" into "there is no stop", which is this
   desk's founding invariant inverted.

   Sorted by liq_dist_pct ascending so the leg nearest liquidation leads;
   rows with no distance (an all-cross book returns liquidationPx null, which
   is HL's own null and not a missing read) sort last and say so rather than
   being given a fabricated position in the order. */
function portProtectionHtml() {
  const s = state.stops;
  const rows = s && Array.isArray(s.protection) ? s.protection : null;
  if (!rows || !rows.length) return "";
  const rank = (p) => (p.liq_dist_pct != null ? p.liq_dist_pct : Infinity);
  const meas = rows.filter((p) => p.state !== "not_measured")
                   .slice().sort((a, b) => rank(a) - rank(b));
  const unk = rows.filter((p) => p.state === "not_measured");
  const line = (p) => {
    const unp = p.state === "unprotected";
    const nm = p.state === "not_measured";
    return '<div class="po-pr' + (unp ? " bad" : nm ? " unk" : " ok") + '" ' +
      'title="' + esc(p.why || "") + '">' +
      '<span class="po-prs">' + esc(p.coin || "?") + '</span>' +
      '<span class="po-prd ' + (p.side === "long" ? "up" : "dn") + '">' +
      esc(String(p.side || "").toUpperCase()) + '</span>' +
      '<span class="po-prn">' + (p.notional != null ? '$' + fmtBig(p.notional) : '—') +
      '</span>' +
      // Distance to liquidation, or the reason there is none. A cross book
      // has no per-leg liq price at all, and an em-dash with no explanation
      // would read as "not measured".
      '<span class="po-prl">' + (p.liq_dist_pct != null
        ? '<span title="adverse move from mark to this leg’s liquidation ' +
          'price">' + p.liq_dist_pct.toFixed(1) + '% to liq</span>'
        : '<span class="dimmer" title="Hyperliquid returns no liquidation ' +
          'price for a cross-margined leg — the account liquidates as a ' +
          'whole, so the adverse-move figure in the venue header above is ' +
          'the one that applies. This is HL’s own null, not a failed ' +
          'read.">no per-leg liq (cross)</span>') + '</span>' +
      '<span class="po-prc">' + (nm
        ? '<b>NOT MEASURED</b>'
        : unp
          ? '<b>NO STOP</b>'
          : (p.nearest_stop_px != null ? 'stop ' + fmtPx(p.nearest_stop_px) : 'exit order') +
            (p.covered_pct != null ? ' · ' + p.covered_pct.toFixed(0) + '% covered' : '') +
            (p.n_exit_orders ? ' · ' + p.n_exit_orders + ' order' +
              (p.n_exit_orders === 1 ? '' : 's') : '')) +
      '</span></div>';
  };
  let h = '<div class="po-prh">EVERY LEG, NEAREST LIQUIDATION FIRST</div>' +
    meas.map(line).join("");
  if (unk.length)
    h += '<div class="po-prh unk">NOT MEASURED — these venues were not ' +
      'asked or did not answer. Nothing below is a zero.</div>' +
      unk.map(line).join("");
  // What the protection counts are made OF, stated once under the table.
  // n_with_stop / n_reduce_only / n_exit_only / resting_notional were all
  // 0-reference; on a book with no stops they are all zero, and a zero is
  // only readable next to the thing it is a count of.
  const cnt = [];
  if (s.n_with_stop != null) cnt.push(s.n_with_stop + ' leg' +
    (s.n_with_stop === 1 ? '' : 's') + ' with a closing order');
  if (s.n_reduce_only != null) cnt.push(s.n_reduce_only + ' reduce-only');
  if (s.n_exit_only != null) cnt.push(s.n_exit_only + ' exit-only');
  if (s.resting_notional != null) cnt.push('$' + fmtBig(s.resting_notional) +
    ' resting notional');
  if (cnt.length)
    h += '<div class="po-prf">' + esc(cnt.join(' · ')) + '</div>';
  /* orders_note is the honesty field for a PAGE. /api/stops caps the order
     list at 200 while the COUNTS above are computed over all of them, and the
     note says exactly that. It was 0-reference, so a capped list looked
     complete. Rendered verbatim, and only when the cap actually bit. */
  if (s.orders_note && s.orders_shown != null && s.orders_total != null &&
      s.orders_shown < s.orders_total)
    h += '<div class="po-prf warn">' + esc(s.orders_note) + '</div>';
  if (s.venues_not_queried && s.venues_not_queried.length)
    h += '<div class="po-prf dimmer">not queried this sweep: ' +
      esc(s.venues_not_queried.join(", ")) + ' — a position held there is ' +
      'absent from this table, and its protection is UNKNOWN rather than ' +
      'missing</div>';
  return '<div class="po-prot">' + h + '</div>';
}

function renderPortTab() {
  const ae = document.activeElement;
  if (ae && ae.id === "port-addr") return;   // same guard for loadPort's direct call
  $("whead").innerHTML = "";
  $("watch-meta").textContent = "POSITIONS · RISK · READ-ONLY";
  const d = state.port || {};
  const out = [];

  /* ORDER MATTERS HERE, and it used to be the wrong way round. The
     no-address branch below tests `!d.address`, and NO failure payload
     carries an address — not the route's own {status:"error"}, not the
     transport catch's, not the 200-error envelope. So every failed read fell
     into it and drew CONNECT A WALLET (READ-ONLY) over a wallet that IS
     connected: the pane told a man with an open book that he had never
     configured one, and offered him the input he had already filled in.
     Found by injecting a 200-error payload and reading the pane. The failure
     branch is a statement about the REQUEST and is tested first; the
     no-address branch is a statement about the DESK and only reachable once
     no failure is outstanding. */
  if (d.status === "bad-address" || d.status === "error") {
    out.push('<div class="po-setup"><div class="po-h">COULD NOT LOAD</div>' +
      '<div class="po-note"><b>' + esc(d.error || d.status) + '</b>' +
      (portAddr() ? '<br>Your address is still configured — this is a failed ' +
        'read of it, not an empty book and not a disconnected wallet.' : '') +
      '</div>' +
      '<input id="port-addr" placeholder="0x…" spellcheck="false" autocomplete="off">' +
      '</div>');
    $("wbody").innerHTML = '<tr><td colspan="7" style="white-space:normal;' +
      'overflow:visible"><div class="port-pane">' + out.join("") + '</div></td></tr>';
    bindPortAddr(false);   // never steal focus on a failed read — see bindPortAddr
    return;
  }
  if (d.status === "no-address" || !d.address) {
    out.push('<div class="po-setup"><div class="po-h">CONNECT A WALLET (READ-ONLY)</div>' +
      '<div class="po-note">Paste a Hyperliquid address to see positions, ' +
      'liquidation distance and your daily funding bill. Public data only — ' +
      'this terminal holds no keys and <b>cannot place or cancel orders</b>. ' +
      'The address is stored in this browser, never sent anywhere but the HL API.</div>' +
      '<input id="port-addr" placeholder="0x…" spellcheck="false" autocomplete="off">' +
      '</div>');
    $("wbody").innerHTML = '<tr><td colspan="7" style="white-space:normal;' +
      'overflow:visible"><div class="port-pane">' + out.join("") + '</div></td></tr>';
    bindPortAddr(true);    // no wallet configured: the caret belongs here
    return;
  }

  const sgn = (v, dp) => (v >= 0 ? "+" : "") + (dp != null ? v.toFixed(dp) : fmtBig(v));
  const cls = (v) => (v > 0 ? "up" : v < 0 ? "dn" : "fl");

  // ── Account header, PER VENUE. Hyperliquid keeps a separate marginSummary
  //    for every HIP-3 dex, so there is no cross-venue account value to
  //    state and no cross-venue leverage: those denominators are different
  //    accounts. Exposure, unrealized PnL and the funding bill ARE dollars
  //    and do add up, so those are the only aggregates shown.
  const venues = d.venues || [];
  /* NOTHING MEASURED MUST NOT RENDER AS ZERO — and it must not render as zero
     HERE, at the top, in the largest type on the pane.

     The empty-position branch further down already says NOT MEASURED when
     every venue query fails. That was not enough: this headline is computed
     from the same payload and printed 308px ABOVE the warning, so during the
     post-restart 429 window the owner's real wallet showed "$0 gross exposure
     / +0 unrealized / 0 positions" in the biggest number on the pane while
     holding four leveraged legs. Measured live: 10 consecutive /api/portfolio
     samples over ~21s returned total_notional 0, n_positions 0, unrealized 0
     with every venue in failed[]. A zero in this position is a claim about
     money, and the eye reaches it long before it reaches the caveat. */
  const noneMeasured = (d.failed || []).length > 0 && venues.length === 0;
  const dash = '<b class="po-nm">—</b>';
  out.push('<div class="po-top">' +
    '<div class="po-eq">' +
    (noneMeasured ? dash : '<b>$' + fmtBig(d.total_notional) + '</b>') +
    '<span>' + (noneMeasured ? 'gross exposure NOT MEASURED' : 'gross exposure') +
    '</span></div>' +
    '<div class="po-pnl ' + (noneMeasured ? "" : cls(d.unrealized)) + '">' +
    (noneMeasured ? dash : '<b>' + sgn(d.unrealized) + '</b>') +
    '<span>' + (noneMeasured ? 'unrealized NOT MEASURED' : 'unrealized') +
    '</span></div></div>');

  const chips = [];
  if (noneMeasured) {
    // One honest chip instead of three confident zeros. It names the venues
    // that did not answer, because "which" is the actionable half.
    chips.push('<span class="po-chip hot">NOT MEASURED<i>' +
      esc(d.failed.map((x) => x.venue).join(", ")) + ' did not answer</i></span>');
  } else {
    const netExp = (d.long_notional || 0) - (d.short_notional || 0);
    chips.push('<span class="po-chip ' + cls(netExp) + '">' + sgn(netExp) +
      '<i>net exposure</i></span>');
    if (d.funding_usd_day != null)
      chips.push('<span class="po-chip ' + cls(d.funding_usd_day) + '">' +
        sgn(d.funding_usd_day) + '<i>funding / day</i></span>');
    chips.push('<span class="po-chip">' + (d.n_positions || 0) +
      '<i>positions</i></span>');
  }
  out.push('<div class="po-chips">' + chips.join("") + '</div>');
  /* STOPS SIT DIRECTLY UNDER THE EXPOSURE NUMBER, above the per-venue
     breakdown, because "is any of this protected" is the second question
     after "how much of it is there" — and because the answer measured on
     this wallet is that none of it is. Placed lower it would be scrolled
     past on a pane that already runs several screens deep. */
  out.push(portStopsHtml());
  /* The per-leg table sits directly under the headline it itemises: the
     headline says HOW MANY legs have no stop, this says WHICH, and on a
     cross-margined book with no stops the second question is the actionable
     one. */
  out.push(portProtectionHtml());

  for (const v of venues) {
    const vchips = [
      '<span class="po-chip">$' + fmtBig(v.account_value) + '<i>account value</i></span>',
      '<span class="po-chip">' + (v.gross_leverage || 0).toFixed(2) + 'x<i>gross lev</i></span>',
    ];
    // Relabelled: this is equity above maintenance as a share of EQUITY, not a
    // price move. Sitting next to the adverse-move chip below, "headroom" read
    // as the distance to liquidation — 49% vs the real 7.4%.
    if (v.maint_headroom_pct != null)
      vchips.push('<span class="po-chip ' + (v.maint_headroom_pct < 20 ? "hot" : "") + '">' +
        v.maint_headroom_pct.toFixed(0) + '%<i>equity above maint</i></span>');
    const vst = acctLiqState(v);
    const vam = acctAdverseMovePct(v);   // number only when it is a real distance
    // Cross legs are the ones with no per-position liq PRICE. Keyed off
    // liq_px, not liq_dist_pct: a position with a price but no mark is not a
    // cross position and must not make this chip claim to speak for it.
    const vcross = (v.positions || []).some((p) => !(+p.liq_px > 0));
    if (vam != null)
      vchips.push('<span class="po-chip ' + (acctBand(vam) === "danger" ? "hot" : "") + '">' +
        vam.toFixed(1) + '%<i>adverse move to liq</i></span>');
    else if (vst.state === "breached")
      vchips.push('<span class="po-chip hot">BELOW<i>equity under maint margin</i></span>');
    else if (vst.state === "remote")
      vchips.push('<span class="po-chip">&gt;100%<i>adverse move to liq</i></span>');
    else if (vcross)
      vchips.push('<span class="po-chip hot">?<i>adverse move to liq — UNKNOWN</i></span>');
    out.push('<div class="po-vh">' + esc(v.venue) + ' — ' +
      (v.n_positions ? v.n_positions + ' position' + (v.n_positions === 1 ? "" : "s")
                     : 'flat') + '</div>' +
      '<div class="po-chips">' + vchips.join("") + '</div>' +
      portRiskHtml(v));
    // Stated once, loudly, per venue: on a cross book no single row carries
    // this number, so a per-position warning can never say it.
    if (vst.state === "breached")
      out.push('<div class="po-warn">' + esc(v.venue) + ' equity is <b>AT or BELOW ' +
        'maintenance margin</b> — short by $' + acctShortfallUsd(vst.shortfall) +
        '. This is not a distance to liquidation, it is past it: the account is ' +
        'liquidatable now, and no other venue can pay for it — Hyperliquid keeps a ' +
        'separate marginSummary per dex</div>');
    else if (acctBand(vam) === "danger")
      out.push('<div class="po-warn">' + esc(v.venue) + ' is cross-margined: ' +
        'a <b>' + vam.toFixed(1) + '% adverse move</b> liquidates the whole ' +
        'account. No single position shows this, and no other venue can pay ' +
        'for it — Hyperliquid keeps a separate marginSummary per dex</div>');
  }
  if (d.failed && d.failed.length)
    out.push('<div class="po-warn">could not query ' +
      esc(d.failed.map((x) => x.venue).join(", ")) +
      ' — anything held there is MISSING from everything above</div>');
  out.push('<div class="po-note2">' + esc(d.no_sum_note || "") +
    (d.scan && d.scan.note ? ' Venues checked: ' + esc(d.scan.note) + '.' : "") +
    '</div>');
  // "Not queried" and "flat there" must never look alike. A partial sweep is
  // cheap precisely because it skips venues, so it has to say which.
  if (d.scan && d.scan.not_queried && d.scan.not_queried.length)
    out.push('<div class="po-warn">not queried this refresh: ' +
      esc(d.scan.not_queried.join(", ")) + ' — these are re-checked on the ' +
      'next full sweep; until then they are UNKNOWN here, not flat</div>');

  if (!d.n_positions) {
    // A zero here has TWO causes and they are not the same fact. If every
    // venue answered, the account really is flat. If some venue ERRORED, zero
    // is the absence of an answer — and saying "flat" then is the house
    // invariant inverted at the most expensive possible place: this pane
    // reported a wallet holding four live positions as $0 during the 429
    // window that follows every restart. `failed` is already surfaced as a
    // warning above, but the headline sentence contradicted it.
    const allFailed = (d.failed || []).length && !(d.venues || []).length;
    if (allFailed) {
      out.push('<div class="po-warn">NOT MEASURED — every venue query failed (' +
        esc(d.failed.map((x) => x.venue).join(", ")) + '). This is not a flat ' +
        'account: nothing was read. Positions may be open and unshown.</div>');
    } else if ((d.failed || []).length) {
      out.push('<div class="po-empty">no position on the venues that ANSWERED (' +
        esc((d.venues || []).map((v) => v.venue).join(", ")) + ') — ' +
        esc(d.failed.map((x) => x.venue).join(", ")) + ' did not answer, so ' +
        'anything held there is unknown, not flat</div>');
    } else {
      out.push('<div class="po-empty">flat on every venue queried (' +
        esc((d.venues_queried || []).join(", ")) + ') — a venue that was not ' +
        'queried cannot report a position</div>');
    }
  } else {
    for (const p of d.positions) {
      out.push('<div class="po-row">' +
        '<span class="po-sym">' + esc(p.coin) + '</span>' +
        '<span class="po-venue">' + esc(p.venue || "") + '</span>' +
        '<span class="po-side ' + (p.side === "long" ? "up" : "dn") + '">' +
        p.side.toUpperCase() + '</span>' +
        '<span class="po-ntl">$' + fmtBig(p.notional) + '</span>' +
        '<span class="po-upnl ' + cls(p.upnl) + '">' + sgn(p.upnl) +
        (p.upnl_pct != null ? ' <i>' + sgn(p.upnl_pct, 1) + '%</i>' : "") + '</span>' +
        '</div>' +
        '<div class="po-sub">' +
        (p.entry_px != null ? 'entry ' + fmtPx(p.entry_px) + ' · ' : "") +
        (p.mark_px != null ? 'mark ' + fmtPx(p.mark_px) + ' · ' : "") +
        (p.leverage ? p.leverage + 'x ' + esc(p.lev_type || "") : "") +
        /* THREE PER-LEG FIELDS THAT SHIPPED AND WERE NEVER DRAWN.

           margin_used is the collateral this leg is consuming — the number
           that says which leg to cut to free the most room. pct_of_equity
           turns "four correlated longs" from a list into a concentration
           picture. roe_pct is return on the margin ACTUALLY POSTED, i.e. the
           leveraged number; the row already showed upnl_pct, the UNLEVERAGED
           one, which understates the pain by exactly the leverage multiple
           (measured: NEAR -11.9% unlevered against -106.1% on margin). Both
           are shown, each labelled, because only naming which is which stops
           the smaller one being read as the whole story. */
        (p.margin_used != null
          ? ' · <span title="collateral posted against this leg — cutting it ' +
            'frees this much, and nothing else on a cross book does">margin $' +
            fmtBig(p.margin_used) + '</span>' : "") +
        (p.pct_of_equity != null
          ? ' · <span title="this leg as a share of the VENUE account\u2019s ' +
            'equity — on a cross book every leg is paid for out of the same ' +
            'collateral">' + p.pct_of_equity.toFixed(0) + '% of equity</span>'
          : "") +
        (p.roe_pct != null
          ? ' · <span class="' + cls(p.roe_pct) + '" title="return on the ' +
            'MARGIN POSTED (leveraged). The percentage on the row above is ' +
            'return on notional (unleveraged) — the same dollars, two ' +
            'denominators, and this is the one the account actually feels.">' +
            sgn(p.roe_pct, 1) + '% on margin</span>' : "") +
        '</div>' +
        portLiqLineHtml(p) +
        (p.funding_usd_day != null
          ? '<div class="po-fund ' + cls(p.funding_usd_day) + '">funding ' +
            sgn(p.funding_usd_day) + '/day at current rate' +
            (p.funding_paid_since_open != null
              ? ' · ' + sgn(-p.funding_paid_since_open) + ' since open' : "") +
            '</div>'
          : ""));
    }
  }
  out.push('<div class="po-foot">read-only · no keys held · cannot trade · ' +
    'refreshed ' + alertAgo(d.at) + ' <a href="#" id="port-forget">forget wallet</a></div>');

  $("wbody").innerHTML = '<tr><td colspan="7" style="white-space:normal;' +
    'overflow:visible"><div class="port-pane">' + out.join("") + '</div></td></tr>';
  const f = document.getElementById("port-forget");
  if (f) f.onclick = (e) => {
    e.preventDefault();
    try { localStorage.removeItem(PORT_KEY); } catch (err) { /* ignore */ }
    state.port = { status: "no-address" };
    // The previous wallet's stops must go with it. Left in place they would
    // be read as this (now absent) wallet's protection.
    state.stops = null;
    renderPortTab();
  };
}

function bindPortAddr(focus) {
  const el = document.getElementById("port-addr");
  if (!el) return;
  el.value = portAddr();
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const v = el.value.trim();
    if (!v) return;
    try { localStorage.setItem(PORT_KEY, v); } catch (err) { /* ignore */ }
    state.port = { status: "loading" };
    // Drop the old wallet's answer before the new one is asked, so the pane
    // cannot show wallet A's stops beside wallet B's positions.
    state.stops = null;
    $("wbody").innerHTML = '<tr><td class="empty">loading positions…</td></tr>';
    loadPort();
    loadStops();
  });
  /* FOCUS IS OPT-IN, and only the no-address branch asks for it.

     Focusing unconditionally wedged the pane permanently. renderPortTab()
     opens with `if (ae && ae.id === "port-addr") return;` — a deliberate
     guard so a repaint cannot yank the field out from under someone mid-type.
     But the FAILURE branch also called this function, so a single failed read
     focused the input, and every subsequent SUCCESSFUL poll then hit that
     guard and returned: the pane sat on COULD NOT LOAD forever while the data
     behind it was fine. Reproduced live.

     A failed read of an address the owner already configured is not an
     invitation to retype it, so that branch binds without taking focus and
     the pane heals on the next poll. The no-address branch genuinely wants
     the caret — there is nothing to heal and typing is the whole point. */
  if (focus) el.focus();
}

/* ── ALERTS tab ──────────────────────────────────────────────────────────
   Every alert this terminal fires goes out over Telegram, which meant the
   terminal itself could never answer the two questions that matter: what is
   armed right now, and what did I already miss? This tab is that answer.
   Server monitors (buyback slowing) come from /api/alerts; the browser-side
   triggers (burn absorb/unusual, price crossings) are described from the
   same constants that actually fire them, so the list cannot drift from the
   behaviour. */
function alertAgo(sec) {
  if (!sec) return "";
  const d = Date.now() / 1000 - sec;
  if (d < 90) return Math.max(0, Math.round(d)) + "s ago";
  if (d < 5400) return Math.round(d / 60) + "m ago";
  if (d < 172800) return Math.round(d / 3600) + "h ago";
  return Math.round(d / 86400) + "d ago";
}

/* ── the owner's own fires ──────────────────────────────────────
   MEASURED 2026-08-14 from data/alert_log.json: 200 rows spanning 56.5h =
   85 fires/day, of which 196 are whale prints, 3 burn, 1 price. The server
   hands over the newest 40 (an 8.9h window at that rate) and this tab drew 25
   of them (6.1h) — so a price alert the owner armed on his own position was
   off the surface inside one session and off disk inside 56.5h, evicted by
   prints he never asked for. Scoping the whale sweep is a backend job; this
   is the half the browser owns: price and burn alerts FIRE HERE, so this tab
   is present at the moment they fire by construction and can keep its own
   copy that no amount of whale noise can push out. */
const MYFIRES_KEY = "hlterm_myfires";
const MYFIRES_KEEP = 200;

/* An unsettled send outlives the page that owned it. `sent:null` renders as
   SENDING — a claim that a POST is in flight RIGHT NOW — but the promise that
   would have settled it died with the tab, so nothing will ever clear it and
   the row says SENDING forever. That is exactly backwards for a ledger whose
   whole reason to exist is surviving the tab dying mid-flight: the honest
   answer past this age is that the outcome was never learned.
   120s is deliberately generous — a localhost POST settles in milliseconds,
   so the only thing this window protects is a send genuinely still pending in
   a SECOND open tab, which would be misreported as dead if the age were 0. */
const MYFIRES_INFLIGHT_MAX_S = 120;

/* Not in flight, not sent, not refused: never learned. Kept out of `sent`'s
   boolean vocabulary on purpose so no existing truthiness test can read it as
   a success. */
function myFireOrphaned(r, now) {
  return r && r.sent == null &&
         (now == null ? Date.now() / 1000 : now) - (r.at || 0) > MYFIRES_INFLIGHT_MAX_S;
}

function loadMyFires() {
  try {
    const rows = JSON.parse(localStorage.getItem(MYFIRES_KEY) || "[]");
    state.myFires = Array.isArray(rows) ? rows : [];
  } catch (e) { state.myFires = []; }
  // Reconcile BEFORE anything renders or the badge counts. Whatever was
  // mid-flight when this tab last closed is not mid-flight now.
  const now = Date.now() / 1000;
  const fixed = state.myFires.map((r) =>
    myFireOrphaned(r, now) ? { ...r, sent: "unknown" } : r);
  if (fixed.some((r, i) => r !== state.myFires[i])) {
    state.myFires = fixed;
    saveMyFires();
  }
}

function saveMyFires() {
  try { localStorage.setItem(MYFIRES_KEY, JSON.stringify(state.myFires)); }
  catch (e) { /* quota / private mode: the in-memory copy still renders */ }
}

/* Record a fire the moment it happens, before the network is involved.
   `sent` is deliberately tri-state: null = still in flight, false = the
   terminal refused it or could not be reached, true = the terminal accepted
   it for Telegram. Accepted is NOT delivered — only the server's own log row
   knows that, and it is merged in separately rather than assumed. */
function recordMyFire(kind, text) {
  const row = { id: Date.now() + Math.random(), at: Date.now() / 1000, kind,
                text: String(text).slice(0, 400), sent: null, why: "" };
  state.myFires = [row, ...(state.myFires || [])].slice(0, MYFIRES_KEEP);
  saveMyFires();
  if (state.wtab === "alerts") renderAlertsTab();
  updateTabBadges();
  return row;
}

function settleMyFire(row, sent, why) {
  if (!row) return;
  state.myFires = (state.myFires || []).map((r) =>
    r.id === row.id ? { ...r, sent, why: why || "" } : r);
  saveMyFires();
  if (state.wtab === "alerts") renderAlertsTab();
}

/* POST /api/notify answers {ok:false,error:"rate-limited"} with HTTP 200 — a
   silently dropped alert. Both callers used to `.catch(() => {})` the whole
   thing, so a refused send looked exactly like a delivered one. */
function notifyAndSettle(text, row) {
  fetch("/api/notify", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).then((r) => r.json().catch(() => ({ ok: r.ok })))
    .then((j) => settleMyFire(row, !!(j && j.ok),
      (j && j.error) ? "terminal refused it: " + j.error : ""))
    .catch((e) => settleMyFire(row, false,
      "could not reach the terminal — " + ((e && e.message) || "no reply")));
}

/* Whale prints are the only unscoped source here (roster wallets x every coin
   at a flat $1M). They are identified by their own prefix rather than by
   kind, because the server-side BUYBACK SLOWING monitor also logs kind
   "alert" and that one is the owner's monitor, not noise. */
function isWhaleFire(f) {
  return String((f && f.text) || "").startsWith("\uD83D\uDC0B");
}

/* Everything that is HIS: the browser ledger, plus any non-whale row still
   inside the server's short window. Merged, not chosen — the local row is the
   only proof the alert fired, the server row is the only thing that knows
   whether Telegram took it. */
function mineFires() {
  const feed = ((state.alertFeed || {}).fired || []).filter((f) => !isWhaleFire(f));
  const same = (a, b) => a.text === b.text && Math.abs((a.at || 0) - (b.at || 0)) < 300;
  const merged = (state.myFires || []).map((r) => {
    const srv = feed.find((f) => same(r, f));
    return srv ? { ...r, delivered: srv.delivered } : r;
  });
  const serverOnly = feed
    .filter((f) => !(state.myFires || []).some((r) => same(r, f)))
    .map((f) => ({ id: "srv" + f.at, at: f.at, kind: f.kind || "alert",
                   text: f.text, sent: true, delivered: f.delivered }));
  return merged.concat(serverOnly).sort((a, b) => (b.at || 0) - (a.at || 0));
}

/* Five distinct facts, five distinct badges. "not confirmed" must never wear
   the same badge as "delivered", and "never found out" must never wear the
   badge of either — nor the badge of a failure, which would be the same lie
   pointing the other way. */
function myFireStatus(r) {
  if (r.delivered === false)
    return { cls: "bad", txt: "SEND FAILED", note: "telegram did not take it" };
  if (r.delivered === true) return { cls: "on", txt: "TELEGRAM", note: "" };
  // Written by loadMyFires; the age test repeats it so a row that goes stale
  // while this tab stays open stops claiming to be in flight without a reload.
  if (r.sent === "unknown" || myFireOrphaned(r, null))
    return { cls: "off", txt: "UNKNOWN",
             note: "the send never came back — the tab closed or the request " +
                   "died before the terminal answered, so whether this reached " +
                   "telegram was never learned here" };
  if (r.sent == null) return { cls: "off", txt: "SENDING", note: "" };
  if (r.sent === false)
    return { cls: "bad", txt: "NOT SENT", note: r.why || "the terminal refused it" };
  return { cls: "off", txt: "UNCONFIRMED",
           note: "the terminal accepted it; telegram delivery is not confirmed here" };
}

async function loadAlertsFeed() {
  try {
    const r = await fetch("/api/alerts");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    // ONLY r.ok WAS CHECKED, on the one channel this desk advertises as
    // "server-side · runs with the browser closed". A route failure arrives
    // as HTTP 200 + {error}, so it assigned cleanly as a feed with no
    // monitors and no fires, and the pane below reported "warming…" and
    // "nothing has fired yet" — two measurements, over a question that got
    // no answer. Last good is kept by the catch; this makes it a failure.
    if (d && d.error) throw new Error(d.error);
    state.alertFeed = d;
    state.alertFeedError = null;
  } catch (e) {
    state.alertFeedError = (e && e.message) || String(e);
  }
  if (state.wtab === "alerts") renderAlertsTab();
}

function renderAlertsTab() {
  $("whead").innerHTML = "";
  $("watch-meta").textContent = "WHAT IS ARMED · WHAT FIRED";
  const feed = state.alertFeed || {};
  const out = [];

  // Said first and said loudly, because it is a property of the alerts and
  // not a footnote. This used to be 8px grey text at the end of a header row,
  // directly above a monitor section boasting "runs with the browser closed"
  // — the polarity exactly backwards from what a leveraged position needs.
  // What actually happens when the tab is shut: checkAlerts() never runs, and
  // because it compares the LIVE mid to the level (no history), a level that
  // crosses and comes back while the tab is closed is never reported at all.
  // Kept to ~6 lines on purpose: measured at 12 lines it was 177px of a
  // 310px visible pane and pushed the armed list itself below the fold.
  out.push('<div class="al-warn"><b>PRICE ALERTS RUN IN THIS TAB ONLY.</b> ' +
    'Close it, sleep the machine or drop the mid feed and nothing is watching ' +
    'your levels — and a cross that retraces while it is shut is never ' +
    'reported at all. Only the BUYBACK MONITORS below run server-side.</div>');

  /* SAID ONCE, AT THE TOP, rather than implied by silence in three sections.
     When the feed request is failing, everything the server contributes to
     this pane — the monitor states and the fired log — is the LAST payload
     that arrived, and every section below would otherwise wear a current
     face. If none ever arrived there is nothing to be stale about, and the
     honest word is that nothing has been read, not that nothing has fired. */
  if (state.alertFeedError)
    out.push('<div class="al-warn">SERVER ALERT FEED IS NOT ANSWERING — <b>' +
      esc(state.alertFeedError) + '</b>. ' + (state.alertFeed
        ? 'The monitor states and fired log below are the last payload that ' +
          'arrived, not the current ones.'
        : 'Nothing has been read from it this session, so nothing below is a ' +
          'measurement of what is armed or what has fired.') + '</div>');

  // 1. Price alerts — the user's own, armed from the command bar or by
  //    clicking a liquidity wall. Live distance to the level is the useful
  //    number, not the level alone.
  const px = (state.alerts || []).filter((a) => !a.fired);
  out.push('<div class="al-h">PRICE ALERTS <span class="al-n">' + px.length +
           '</span><span class="al-sub">armed here · watched only while this tab is open</span></div>');
  if (!px.length) {
    out.push('<div class="al-empty">none armed · type <b>BTC&gt;65000=alert</b> ' +
             'or click a liquidity wall to arm one</div>');
  } else {
    for (const a of px) {
      const now = state.mids[a.coin] != null ? +state.mids[a.coin] : null;
      const away = now != null ? (a.level - now) / now * 100 : null;
      out.push('<div class="al-row"><span class="al-sym">' + esc(baseSym(a.coin)) + '</span>' +
        '<span></span>' +
        '<span class="al-now">' + (now == null ? "—" :
          "now " + fmtPx(now) + " · " + (away >= 0 ? "+" : "") + away.toFixed(1) + "%") +
        '</span><span class="al-st on">ARMED</span>' +
        '<span class="al-rule">crosses ' + (a.op === ">" ? "above" : "below") +
        ' <b>' + fmtPx(a.level) + '</b></span></div>');
    }
  }

  // 1b. MY FIRES — pinned, and kept in this browser so the whale sweep
  //     cannot evict them. MEASURED: 195 of the last 200 server rows were
  //     whale prints, so his own fire left the 25-row list in ~6h and the
  //     40-row payload in ~9h. This list is not sliced by any of that.
  const mine = mineFires();
  out.push('<div class="al-h">MY FIRES <span class="al-n">' + mine.length +
    '</span><span class="al-sub">price · burn · buyback monitors</span></div>');
  out.push('<div class="al-note">kept in this browser (last ' + MYFIRES_KEEP +
    ' of yours) — whale prints cannot push these out. Fires from before this ' +
    'browser began keeping the ledger appear only while the server log still ' +
    'reaches them.</div>');
  if (!mine.length) {
    // "none yet" and "we cannot see them" are different facts.
    out.push('<div class="al-empty">nothing of yours has fired since this ' +
      'browser started keeping the ledger' +
      (state.alertFeedError
        ? ' — and the server log is unreachable (<b>' + esc(state.alertFeedError) +
          '</b>), so anything older cannot be checked from here'
        : '') + '</div>');
  } else {
    for (const f of mine.slice(0, 40)) {
      const st = myFireStatus(f);
      const head = (f.text || "").split("\n")[0];
      out.push('<div class="al-fired mine' + (st.cls === "bad" ? " undelivered" : "") +
        '"><span class="al-when">' + alertAgo(f.at) + '</span>' +
        '<span class="al-msg">' + esc(head) + '</span>' +
        '<span class="al-st ' + st.cls + '">' + st.txt + '</span></div>' +
        (st.note ? '<div class="al-note">' + esc(st.note) + '</div>' : ""));
    }
  }

  // 2. Server monitors — run every 15 min whether or not a browser is open.
  const mons = feed.monitors || [];
  /* THE DENOMINATOR. `n_programs` is the server's count of buyback programmes
     it holds and was 0-reference: this header said "1 live" over six rows
     with no statement that fourteen programmes exist, so the eight with no
     monitor at all were invisible from the one tab that lists monitors. The
     BURN tab now names them; this states the fraction. */
  const nProg = feed.n_programs;
  out.push('<div class="al-h">BUYBACK MONITORS <span class="al-n">' +
           mons.filter((m) => m.state_ === "watching").length + ' live</span>' +
           '<span class="al-sub">server-side · runs with the browser closed' +
           (nProg != null
             ? ' · watching ' + mons.length + ' of ' + nProg + ' programme' +
               (nProg === 1 ? '' : 's') +
               (nProg > mons.length
                 ? ' — the other ' + (nProg - mons.length) +
                   ' have NO monitor (named on BURN)' : '')
             : '') +
           '</span></div>');
  /* THE PARTIAL FAILURES, READ BEFORE THE EMPTY SENTENCE. api_alerts builds
     this section from two independently-failing pieces — the buyback cache
     overlay (`programs`) and buyback_alerts.monitors() — and either can fail
     while the route as a whole answers 200. The server records each in its
     own key; an unread key here reappears as "warming…", which is a claim
     that the monitors are STARTING UP. A monitor that died is not warming. */
  const monErr = feed.monitors_error || feed.programs_error;
  if (state.alertFeedError) {
    out.push('<div class="al-empty">could not load monitor state — <b>' +
             esc(state.alertFeedError) + '</b></div>');
  } else if (monErr && !mons.length) {
    out.push('<div class="al-empty">MONITORS NOT RUNNING — <b>' + esc(monErr) +
             '</b>. This is not a warm-up: nothing is watching these ' +
             'programmes server-side until it clears.</div>');
  } else if (!mons.length && feed.programs_warming) {
    // The server now distinguishes never-built from built-and-empty, so this
    // sentence expires instead of standing forever over a genuine zero.
    out.push('<div class="al-empty">warming… <i>' +
             esc(feed.programs_warming_note || "snapshot not built yet") +
             '</i></div>');
  } else if (!mons.length) {
    out.push('<div class="al-empty">no buyback programmes are armed — the ' +
             'snapshot BUILT and contains none. This is a measured zero, not ' +
             'a warm-up.</div>');
  } else {
    // A monitor list that built anyway, over programmes that partly failed,
    // is a list with holes in it — and the holes look exactly like tokens
    // whose rules are quiet. Say so above the rows rather than beside none.
    if (monErr)
      out.push('<div class="al-note">part of this monitor set could not be ' +
        'built — <b>' + esc(monErr) + '</b>. A programme missing from the ' +
        'rows below is NOT LOOKED, not un-triggered.</div>');
    for (const m of mons) {
      const st = m.state_ || "";
      const cls = st === "watching" ? "on" : st === "fired" ? "hot" : "off";
      // How close it is, as a bar — a monitor at 30/35% deserves a look.
      let meter = "";
      if (m.drop_pct != null && m.threshold) {
        const f = Math.max(0, Math.min(1, m.drop_pct / m.threshold));
        meter = '<span class="al-meter" title="' + m.drop_pct.toFixed(0) + '% of a ' +
          m.threshold.toFixed(0) + '% trigger"><i style="width:' +
          (f * 100).toFixed(0) + '%"></i></span>';
      }
      out.push('<div class="al-row"><span class="al-sym">' + esc(m.token) + '</span>' +
        '<span></span>' + meter +
        '<span class="al-st ' + cls + '">' + esc(st.toUpperCase()) + '</span>' +
        '<span class="al-rule">' + esc(m.detail || m.rule) + '</span></div>' +
        (m.last_fire ? '<div class="al-note">last fired ' + alertAgo(m.last_fire) +
          ' — re-arms once the rate recovers</div>' : ""));
    }
  }

  // 3. Browser-side burn triggers — described from the live constants.
  out.push('<div class="al-h">BURN TRIGGERS<span class="al-sub">needs this tab open in a browser</span></div>');
  out.push('<div class="al-row"><span class="al-sym">ABSORB</span>' +
    '<span></span><span></span><span class="al-st on">ARMED</span>' +
    '<span class="al-rule">buyback + burn covers <b>' + BURN_ABSORB_TRIGGER +
    '%</b> of that token\u2019s daily sell flow</span></div>');
  out.push('<div class="al-row"><span class="al-sym">UNUSUAL</span>' +
    '<span></span><span></span><span class="al-st on">ARMED</span>' +
    '<span class="al-rule">burn runs <b>' + BURN_UNUSUAL_RATIO +
    'x</b> its own trailing baseline</span></div>');

  // 4. What actually fired — every source, whale prints included. This list
  //    is the noisy one by construction, so it says how far back it actually
  //    reaches and lets the whales be filtered out of it. The reach is
  //    computed from the payload in hand, never assumed: it is a function of
  //    how hard the sweep is firing right now.
  const fired = feed.fired || [];
  const whaleN = fired.filter(isWhaleFire).length;
  const ats = fired.map((f) => f.at || 0).filter(Boolean);
  const spanH = ats.length > 1 ? (Math.max(...ats) - Math.min(...ats)) / 3600 : null;
  out.push('<div class="al-h">FIRED <span class="al-n">' + fired.length + '</span>' +
           '<span class="al-sub">' + (spanH != null
             ? 'newest ' + fired.length + ' the server hands over \u00b7 reaches back ~' +
               (spanH < 1 ? Math.round(spanH * 60) + 'm' : spanH.toFixed(1) + 'h')
             : 'server-side log') + '</span></div>');
  if (spanH != null && spanH > 0)
    out.push('<div class="al-note">' + whaleN + ' of ' + fired.length +
      ' are whale prints (~' + Math.round(fired.length / (spanH / 24)) +
      ' fires/day at this rate). Older fires of yours are in MY FIRES above, ' +
      'not here — this window cannot reach them.</div>');
  const filt = state.alertFilter || "all";
  out.push('<div class="al-filter">' + [
      ["all", "ALL", fired.length],
      ["mine", "MINE", fired.length - whaleN],
      ["whales", "WHALES", whaleN],
    ].map(([k, label, n]) => '<button class="al-fb' + (k === filt ? " on" : "") +
      '" data-f="' + k + '">' + label + ' <i>' + n + '</i></button>').join("") +
    '</div>');
  const shown = fired.filter((f) => filt === "all" ? true
    : filt === "whales" ? isWhaleFire(f) : !isWhaleFire(f));
  if (!fired.length) {
    /* "nothing has fired yet" is a MEASUREMENT of the server's log. With the
       feed failing and no payload ever held, the log was never read, and the
       two states are indistinguishable on screen — the reader concludes his
       levels were quiet when in fact nobody asked. */
    const fErr = state.alertFeedError || feed.fired_error;
    out.push('<div class="al-empty">' + (fErr
      ? 'THE FIRED LOG COULD NOT BE READ — <b>' + esc(fErr) + '</b>. This is ' +
        'not a quiet window; it is an unanswered question. Your own fires are ' +
        'in MY FIRES above, which is kept in this browser and does not depend ' +
        'on the server.'
      : 'nothing has fired yet') + '</div>');
  } else if (!shown.length) {
    // Filtered to nothing is not the same as nothing having fired.
    out.push('<div class="al-empty">' + (filt === "whales"
        ? 'no whale prints in this window'
        : 'none of your own fires are in this window \u2014 look in MY FIRES ' +
          'above, which reaches further back') +
      ' \u00b7 ' + fired.length + ' row' + (fired.length === 1 ? "" : "s") +
      ' hidden by the filter</div>');
  } else {
    for (const f of shown.slice(0, 25)) {
      const head = (f.text || "").split("\n")[0];
      out.push('<div class="al-fired' + (f.delivered ? "" : " undelivered") + '">' +
        '<span class="al-when">' + alertAgo(f.at) + '</span>' +
        '<span class="al-msg">' + esc(head) + '</span>' +
        (f.delivered ? "" : '<span class="al-st off">SEND FAILED</span>') + '</div>');
    }
    if (shown.length > 25)
      out.push('<div class="al-note">' + (shown.length - 25) + ' older rows in ' +
        'this window are not drawn</div>');
  }

  $("wbody").innerHTML = '<tr><td colspan="7" style="white-space:normal;' +
    'overflow:visible"><div class="alerts-pane">' + out.join("") +
    '</div></td></tr>';
  document.querySelectorAll("#wbody .al-fb").forEach((b) => {
    b.onclick = () => { state.alertFilter = b.dataset.f; renderAlertsTab(); };
  });
}

/* THE COVERAGE SENTENCE, above the rows it qualifies.

   Rule of this desk: a number arrives with how old it is and what fraction of
   the intended set it covers. The BURN tab listed 14 programmes and covered
   6 of them with a monitor, and said neither number anywhere. `rows` is the
   list this tab is about to draw, so the three-way split is computed over
   what the reader can actually see rather than over the server's list. */
function burnCoverageHtml(rows) {
  const mm = burnMonitors();
  const toks = (rows || []).map((r) => r.t);
  if (!mm)
    return `<div class="brn-cov unk">MONITOR COVERAGE UNKNOWN — the monitor ` +
      `feed did not answer` + (state.alertFeedError
        ? ` (<b>${esc(state.alertFeedError)}</b>)` : ``) +
      `, so whether any of these ${toks.length} programmes is watched ` +
      `server-side cannot be stated here. Not one of them is known to be ` +
      `unwatched — nothing was read.</div>`;
  const watched = [], quietByDesign = [], unwatched = [];
  for (const r of rows || []) {
    if (mm.by[String(r.t).toUpperCase()]) watched.push(r.t);
    else if (r.p && r.p.no_burn_by_design) quietByDesign.push(r.t);
    else unwatched.push(r.t);
  }
  const nm = (a) => esc(a.join(" "));
  return `<div class="brn-cov${unwatched.length ? " hot" : ""}">` +
    `<b>MONITORS ${mm.n} OF ${mm.total}</b> programme` +
    (mm.total === 1 ? "" : "s") + ` watched server-side` +
    (watched.length ? ` — <span class="on">${nm(watched)}</span>` : ``) +
    (unwatched.length
      ? `<br><b class="hot">NOT WATCHED, and removing supply: ` +
        `${nm(unwatched)}</b> — a quiet row for these means nobody looked, ` +
        `not that nothing happened`
      : ``) +
    (quietByDesign.length
      ? `<br><span class="dimmer">no monitor and none applicable: ` +
        `${nm(quietByDesign)} — these do not burn by design, so a ` +
        `burn-slowdown rule has nothing to watch</span>`
      : ``) +
    (mm.err ? `<br><b class="hot">part of the monitor set failed to build — ` +
      `${esc(mm.err)}</b>` : ``) +
    // The watch state is itself a reading, and it has an age like everything
    // else on this desk. Without it a monitor feed that died an hour ago
    // still reports "6 of 14 watched" in the present tense.
    (mm.ageS != null
      ? `<br><span class="dimmer">monitor state read ` +
        `${mm.ageS < 90 ? Math.round(mm.ageS) + "s" : Math.round(mm.ageS / 60) + "m"}` +
        ` ago (re-read every 60s)</span>`
      : ``) +
    `</div>`;
}

/* SHIPPED AGE + CLIENT HOLD, for any dated payload. THE BURN FRESHNESS CHIP
   WAS FROZEN, and it was frozen in both directions.

   It rendered `fr.age_s` — the age the payload had AT THE MOMENT THIS CLIENT
   FETCHED IT — while loadBuyback polls once an HOUR (setInterval 3600000)
   against a server loop of every 900s. So the number stopped moving the
   instant it arrived and stood for up to sixty minutes. Measured on screen at
   "checked 11m ago" against a true server age of 4.6m; the mirror case is
   worse — a fetch landing just after a rebuild reads "checked just now" over
   a payload that goes on to age a full hour.

   The staleness guard could not fire either: `age_s > every_s * 2.5` needs
   2250s and age_s is pinned at whatever the server reported, which in healthy
   operation is at most ~900s. A control that reports success while producing
   nothing is the same failure as no control.

   `fresh.at` is the server's build stamp, was 0-reference, and is what makes
   this computable: server build age plus client hold time, recomputed on
   every render. This is the same semantics venueAgeS() and fxAgeS() already
   use one pane over — the buyback chip was the one that did not. Falls back
   to the shipped age_s when `at` is absent, which is still better than
   nothing and is never MORE wrong than what it replaces. */
function srvAgeS(o) {
  if (!o) return null;
  if (o.at != null) return Math.max(0, Date.now() / 1000 - o.at);
  return o.age_s != null ? o.age_s : null;
}

/* DID THE MONEY ACTUALLY GET SPENT — measured per month, and never drawn.

   datasources/fee_payout.py builds a monthly reconciliation of protocol FEE
   REVENUE against BUYBACK SPEND per token and /api/buyback ships it on every
   programme as `payout[]` (month, fees, buyback, payout_pct, partial) plus a
   `payout_summary`. The string "payout" occurred ZERO times in 823KB of this
   file. The BURN tab renders the `revenue` block instead, which is a RATE
   MODEL — fees x an assumed passthrough — and the two are not substitutes:
   the model says what SHOULD be spent, this says what WAS.

   Three things this must not do. It must not print a part-month beside whole
   months as though they were comparable — `partial` becomes MTD. It must not
   render `implausible` as a payout ratio: CAKE measures 11,024%, which is not
   a programme paying out 110x its fees but a programme that is not
   fee-funded at all, and the server ships the sentence saying so. And it must
   not render an absent measurement as 0% — a programme with no fee series
   gets no strip rather than an empty one. */
function burnPayoutHtml(p) {
  const rows = p && Array.isArray(p.payout) ? p.payout : null;
  if (!rows || !rows.length) return "";
  const s = p.payout_summary || {};
  const mo = (m) => String(m || "").slice(5);      // "2026-07" -> "07"
  if (s.implausible)
    return `<span class="brn-pay bad" title="${esc((s.note ||
      "measured spend exceeds measured fee revenue by a margin that no " +
      "fee-funded programme can produce") + " — so the ratio is not printed: " +
      "a number that cannot mean what its label says is worse than no number. " +
      "Months measured: " + rows.map((r) => r.month).join(", "))}">` +
      `PAYOUT N/A <i>not fee-funded</i></span>`;
  const last = rows.slice(-3);
  const cells = last.map((r) =>
    `${mo(r.month)} ${r.payout_pct != null ? Math.round(r.payout_pct) + "%" : "—"}` +
    (r.partial ? " MTD" : "")).join(" · ");
  const full = rows.filter((r) => !r.partial).length;
  /* NO COMPLETE MONTH means there is nothing this ratio can be compared
     against — the server itself declines to build a payout_summary in that
     case (LIT and WLFI each have exactly one part-month, measuring 1482% and
     3251%). The measurement is kept, because a measured part-month beats a
     guess, and it is marked rather than dressed as a settled figure. */
  const noFull = full === 0;
  return `<span class="brn-pay${s.funded === false || noFull ? " bad" : ""}" ` +
    `title="${esc(
    "REALISED payout: buyback spend as a share of protocol fee revenue, " +
    "measured month by month — not the passthrough model beside it. " +
    rows.map((r) => r.month + ": $" + fmtBig(r.buyback) + " spent of $" +
      fmtBig(r.fees) + " fees = " + (r.payout_pct != null
        ? r.payout_pct.toFixed(1) + "%" : "?") +
      (r.partial ? " (MONTH IN PROGRESS — a part-month is not comparable " +
        "with a whole one)" : "")).join(" · ") +
    " · " + full + " complete month" + (full === 1 ? "" : "s") + " of " +
    rows.length + " measured" +
    (s.payout_pct != null ? " · " + s.payout_pct.toFixed(0) +
      "% across the complete months" : "") +
    (noFull ? " · NO COMPLETE MONTH has been measured yet, so this ratio " +
      "has nothing to be compared against — a part-month's spend against a " +
      "part-month's fees is not the programme's payout rate" : "") +
    (s.note ? " · " + s.note : ""))}">PAYOUT ${esc(cells)}` +
    (noFull ? ` <i>no full month</i>` : ``) + `</span>`;
}

function burnIstDate(ms) {
  if (ms == null) return "";
  return new Date(ms).toLocaleDateString("en-GB", {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
}

function burnLastEvent(p) {
  if (p && p.last_event) return p.last_event;
  const hs = (p && p.history) || [];
  for (let i = hs.length - 1; i >= 0; i--) {
    if ((hs[i].usd || 0) > 0 || (hs[i].tokens || 0) > 0) return hs[i];
  }
  return null;
}

function burnHistRecent(p) {
  const hs = (p && p.history) || [];
  if (!hs.length) return false;
  return (Date.now() - hs[hs.length - 1].ms) < 2.5 * 86400000;
}

/* Row headline is buy-pressure NOW, not a 30d archive mean.
   1d/7d on-chain if live, else last event $X on DATE, else idle since DATE.
   Never net_per_day over a 30d sink series (LIT's 11 Jul 15.6M). */
function burnRowVerdict(t, p, px) {
  const meas = p.measured || {};
  const net = meas.net;
  const usd = (tok) => (px != null && tok != null ? tok * px : null);
  const trBadge = p.trend
    ? `<span class="bb-trend ${esc(p.trend.state)}" title="7d vs 30d mean ` +
      `(${p.trend.chg_pct >= 0 ? "+" : ""}${p.trend.chg_pct.toFixed(0)}%)` +
      `${p.trend.confirmed ? " · confirmed on 90d" : ""}">` +
      `${p.trend.state.toUpperCase()}</span>`
    : "";
  const FLOW_FLOOR_USD = 100;

  const liveUsd = () => {
    if (meas.burn_1d > 0) {
      const u = usd(meas.burn_1d);
      if (u != null) return { usd: u, label: "1d on-chain", perDay: false };
    }
    if (meas.avg_per_day_7d > 0) {
      const u = usd(meas.avg_per_day_7d);
      if (u != null) return { usd: u, label: "7d on-chain", perDay: true };
    }
    const d7 = (p.history_stats || {}).d7;
    if (d7 > 0 && burnHistRecent(p))
      return { usd: d7, label: "7d archive", perDay: true };
    return null;
  };

  const lastEvt = () => {
    const ev = burnLastEvent(p);
    if (!ev) return "";
    const when = burnIstDate(ev.ms);
    const shown = ev.usd != null ? "$" + fmtBig(ev.usd)
      : (usd(ev.tokens) != null ? "$" + fmtBig(usd(ev.tokens)) : fmtBig(ev.tokens));
    return `<span class="fl" title="last non-zero day in the archive, not a live rate">` +
      `last event ${shown} on ${esc(when)}</span>` + trBadge;
  };
  const idleTag = () => {
    const ev = burnLastEvent(p);
    const hs = p.history || [];
    const ms = ev ? ev.ms : (hs.length ? hs[hs.length - 1].ms : null);
    if (ms == null) return `<span class="fl">no data</span>`;
    return `<span class="fl">idle since ${esc(burnIstDate(ms))}</span>`;
  };

  // ETHFI (and any treasury with no counter): bid not measurable, not "NO BURN".
  if (p.bid_measurable === false) {
    return `<span class="fl" title="${esc(p.bid_unmeasurable_why ||
      "no public counter isolates the buyback")}">bid not measurable</span>`;
  }

  if (p.no_burn_by_design) {
    const hr = p.holdings && p.holdings.rate;
    const bidUsd = p.bid && p.bid.usd_day != null ? p.bid.usd_day
      : (hr && px != null ? hr.per_day * px : null);
    const basis = (p.bid && p.bid.basis) || (hr && hr.basis) || "wallet delta";
    const isHype = t === "HYPE" || /AF 24h fills|spot fills/i.test(basis);
    let smallBurn = "";
    // Show the small realised burn as a labeled side fact; it is NOT added
    // to the meter (one flow: the fund). Do not say "NO BURN" over ~$260k/d.
    if (net && net.deflationary && net.basis === "intraday") {
      const su = usd(Math.abs(net.net_per_day));
      if (su != null && su >= FLOW_FLOOR_USD)
        smallBurn = `<span class="fl" title="separate fee/gas burn, not the fund">` +
          `fee/gas burn $${fmtBig(su)}/d</span>`;
    }
    if (bidUsd == null) {
      return `<span class="fl" title="${esc(p.no_burn_by_design)}">bid not measurable</span>`;
    } else if (Math.abs(bidUsd) < FLOW_FLOOR_USD) {
      return `<span class="fl" title="${esc(basis)}">NO BUYING (7d)</span>` +
        (smallBurn || `<span class="brn-nb">float only</span>`);
    } else if (bidUsd > 0) {
      const lead = isHype
        ? `<span class="up" title="${esc(basis)}">AF 24h fills $${fmtBig(bidUsd)}</span>`
        : `<span class="up" title="${esc(basis)}">BUYING $${fmtBig(bidUsd)}/d</span>`;
      return lead + trBadge + (smallBurn || `<span class="brn-nb">float only</span>`);
    } else {
      return `<span class="dn" title="${esc(basis)}">RELEASING $${fmtBig(-bidUsd)}/d</span>` +
        `<span class="brn-nb">wallet draining</span>`;
    }
  }

  const live = liveUsd();
  if (live) {
    const cls = p.bid ? "up" : "rg-neutral";
    const verb = p.bid ? "BUYING" : "7d burn";
    const shown = live.perDay
      ? `${p.bid ? verb + " $" + fmtBig(live.usd) + "/d" : "7d $" + fmtBig(live.usd) + "/d"}`
      : `1d $${fmtBig(live.usd)}`;
    const word = live.perDay
      ? (p.bid ? `BUYING $${fmtBig(live.usd)}/d` : `7d $${fmtBig(live.usd)}/d`)
      : `1d $${fmtBig(live.usd)}`;
    return `<span class="${cls}" title="${esc(live.label)}">${word}</span>` + trBadge;
  }
  const ev = lastEvt();
  if (ev) return ev;
  return idleTag();
}

function renderBurnTab() {
  $("whead").innerHTML = "";
  $("watch-meta").textContent = "BUYBACK / BURN vs SELL FLOW";
  const toks = Object.keys(state.buyback || {});
  if (!toks.length) {
    // "loading…" forever is indistinguishable from a dead panel. If the fetch
    // is failing, say what failed — the retry is already running behind this.
    $("wbody").innerHTML = '<tr><td>' + buyflowBar() + (state.buybackError
      ? '<div class="empty">could not load programmes — <b>' +
        esc(state.buybackError) + '</b><br>retrying automatically…</div>'
      : '<div class="empty">loading programmes…</div>') + '</td></tr>';
    return;
  }
  const rows = toks.map((t) => ({ t, m: burnMeter(t), p: state.buyback[t] }))
    .sort((a, b) => {
      // measured burn first, then absorption — a token actually burning is
      // more interesting than one whose programme is merely announced
      const am = (a.p.measured || {}).avg_per_day_7d || 0;
      const bm = (b.p.measured || {}).avg_per_day_7d || 0;
      if ((am > 0) !== (bm > 0)) return bm > 0 ? 1 : -1;
      return (b.m ? b.m.totalPct : -1) - (a.m ? a.m.totalPct : -1);
    });
  // Total programmatic bid across the universe. Only buy-funded programmes
  // carry a `bid`, so BNB's fee burn is excluded rather than inflating this.
  let bidTotal = 0;
  const bidRows = [];
  for (const row of rows) {
    const bp = row.p;
    if (!bp || !bp.bid) continue;
    const c2 = ctxFor(row.t) || {};
    const px2 = state.mids[row.t] != null ? +state.mids[row.t] : c2.mid_px;
    const usd = bp.bid.usd_day != null ? bp.bid.usd_day
      : (px2 != null && bp.bid.tokens_day != null ? bp.bid.tokens_day * px2 : null);
    if (usd == null || !(usd > 0)) continue;
    if (bp.bid.implausible) continue;   // provenance wrong, not a real bid
    bidTotal += usd;
    bidRows.push({ t: row.t, usd, basis: bp.bid.basis,
                   pctVol: bp.global_vol24h ? usd / bp.global_vol24h * 100 : null });
  }
  bidRows.sort((a, b) => b.usd - a.usd);
  const liveBar = buyflowBar();

  const bidBar = bidRows.length
    ? `<div class="brn-agg"><span class="brn-agg-h">PROGRAMMATIC BID</span>` +
      `<b>$${fmtBig(bidTotal)}/d</b>` +
      `<span class="fl">across ${bidRows.length} buy-funded programmes</span>` +
      bidRows.map((r) =>
        `<span class="brn-agg-i" data-coin="${esc(r.t)}" title="${esc(r.basis)}` +
        (r.pctVol != null ? ` · ${r.pctVol.toFixed(2)}% of its 24h volume` : "") + `">` +
        `${esc(r.t)} <b>$${fmtBig(r.usd)}</b>` +
        (r.pctVol != null ? `<i>${r.pctVol.toFixed(1)}%</i>` : "") + `</span>`).join("") +
      `</div>`
    : "";

  const html = rows.map(({ t, m, p }) => {
    const r = p.realised || {};
    const meas = p.measured || {};
    const net = meas.net;
    const ctx = ctxFor(t) || {};
    const px = state.mids[t] != null ? +state.mids[t] : ctx.mid_px;
    const chg = pct(px, ctx.prev_day_px);
    const perDay = meas.avg_per_day_7d;

    // Headline verdict: net supply direction is the signal; gross burn is not.
    // Some programmes remove float without destroying supply — say so plainly
    // rather than implying a burn number is merely late.
    // Dollars are the unit that compares across tokens -- "2.0M CAKE/day" and
    // "326M PUMP/day" are not comparable quantities, $2.8M/day and $0.6M/day
    // are. Token counts stay in the tooltip.
    const usd = (tok) => (px != null && tok != null ? tok * px : null);
    const perDayUsd = usd(perDay);

    // Direction badge from the DAILY history (7d vs 30d). Built once so every
    // verdict branch shows it — it was previously only on the no-burn branch,
    // so CAKE, PUMP and VVV had trend data that never reached the screen.
    const trBadge = p.trend
      ? `<span class="bb-trend ${esc(p.trend.state)}" title="7d vs 30d mean ` +
        `(${p.trend.chg_pct >= 0 ? "+" : ""}${p.trend.chg_pct.toFixed(0)}%)` +
        `${p.trend.confirmed ? " · confirmed on 90d" : ""}">` +
        `${p.trend.state.toUpperCase()}</span>`
      : "";

    const verdict = burnRowVerdict(t, p, px);

    const priceCell = px != null
      ? `<span class="brn-px">${fmtPx(px)}</span>` +
        (chg != null ? `<span class="${chg >= 0 ? "up" : "dn"}">${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%</span>` : "")
      : `<span class="fl">off-venue</span>`;

    // What the programme has actually accumulated or destroyed, in tokens and
    // USD. For burn programmes the buyback IS the burn, so cumulative burned
    // is the realised buyback; for hold/lock programmes it is a wallet balance.
    const hold = p.holdings;
    const boughtTok = hold ? hold.held
      : (meas.cumulative_burned != null && meas.cumulative_pct_supply >= 0.05
         ? meas.cumulative_burned : null);
    const boughtUsd = boughtTok != null && px != null ? boughtTok * px : null;
    const boughtTag = boughtTok == null ? "" :
      `<span class="brn-buy" title="${fmtBig(boughtTok)} ${esc(t)} · ${esc(hold
         ? hold.label + " · " + hold.source + (hold.not_a_buyback_counter
             ? " · net payer: balance is not a pure buyback counter" : "")
         : "bought and destroyed — cumulative burn is the realised buyback")}">` +
      (hold ? "FLOAT REMOVED " : "BOUGHT+BURNED ") +
      // A current balance is genuinely worth this now. A lifetime burn was
      // accumulated at years of different prices, so its dollar figure is
      // marked "at today's px" rather than passed off as the amount spent.
      (boughtUsd != null ? `<b>$${fmtBig(boughtUsd)}</b>` + (hold ? "" : " at today's px")
                         : `<b>${fmtBig(boughtTok)}</b>`) +
      (hold && hold.pct_supply ? ` (${hold.pct_supply.toFixed(1)}% of supply)` : "") +
      // The level is history; the rate is the live bid.
      // Prefer the exact fills-derived bid; the balance-diff ring is a noisy
      // estimate off short spans and disagreed by ~2x.
      ((p.bid && p.bid.usd_day)
        ? ` · <b class="up">+$${fmtBig(p.bid.usd_day)}/d bid</b>` +
          `<span class="fl"> (${esc(p.bid.basis)})</span>`
        : (hold && hold.rate && px != null && Math.abs(hold.rate.per_day * px) >= 100
            ? ` · <b class="${hold.rate.per_day > 0 ? "up" : "dn"}">` +
              `${hold.rate.per_day > 0 ? "+" : "−"}$${fmtBig(Math.abs(hold.rate.per_day * px))}/d` +
              `</b><span class="fl"> (${esc(hold.rate.basis)})</span>` : "")) +
      `</span>`;

    // Predicted next burn. "provisional" is shown differently from "confirmed"
    // because a 2-interval pattern is a thing to watch, not a thing to trade.
    const sch = p.schedule;
    let schedTag = "";
    if (sch && sch.regular && sch.next_ts) {
      const dd = (sch.next_ts * 1000 - Date.now()) / 86400000;
      const overdue = sch.stale || dd < -2 ||
        (sch.period_days && dd < -sch.period_days * 0.5);
      if (overdue) {
        schedTag = `<span class="brn-sched stale" title="predicted ` +
          `${esc(sch.weekday)} ${esc(sch.hour_utc)}Z, ${Math.abs(dd).toFixed(0)}d overdue` +
          ` · last event ${sch.last_ts ? burnIstDate(sch.last_ts * 1000) : "?"} · ` +
          `schedule did not fire — not a live countdown">BURN sched stale</span>`;
      } else {
        schedTag = `<span class="brn-sched ${esc(sch.confidence)}" ` +
          `title="every ~${sch.period_days}d · observed gaps ${sch.gaps_days.join(", ")}d · ` +
          `${esc(sch.weekday)} ${esc(sch.hour_utc)}Z · ` +
          `${esc(sch.confidence)} (${sch.confidence === "provisional" ? "only 2 matching intervals" : "3 matching intervals"})">` +
          `BURN ${dd < 0 ? "due" : "~" + dd.toFixed(0) + "d"}</span>`;
      }
    }

    const pausedTag = p.paused
      ? `<span class="brn-paused" title="${esc(p.paused.why)}">PAUSED ${esc(p.paused.since)}</span>` : "";

    const trendTag = meas.trend && meas.trend !== "unknown" && !p.trend
      ? `<span class="brn-trend ${esc(meas.trend)}">${esc(meas.trend)}</span>` : "";

    const fund = p.fund;
    const detail = p.no_burn_by_design
      ? `<span class="fl">${esc(p.no_burn_by_design)}` +
        `</span>`
      : net && net.basis === "intraday"
      ? `<span class="fl" title="${fmtBig(net.from)} → ${fmtBig(net.to)} ${esc(t)}">` +
        `measured live off-chain over ${net.span_hours}h · ` +
        `supply ${((net.to / net.from - 1) * 100).toFixed(3)}%</span>`
      : net
      ? `<span class="fl" title="mint ${fmtBig(net.minted)} / burn ${fmtBig(net.burned)} ${esc(t)}">` +
        `mint ${usd(net.minted) != null ? "$" + fmtBig(usd(net.minted)) : fmtBig(net.minted)}` +
        ` · burn ${usd(net.burned) != null ? "$" + fmtBig(usd(net.burned)) : fmtBig(net.burned)}` +
        ` · ${net.span_days}d` +
        (net.offset_ratio ? ` · burn covers ${(net.offset_ratio * 100).toFixed(0)}% of mint` : "") + `</span>`
      // The "needs a second snapshot" note is about the daily-supply route.
      // When an on-chain rate already exists it is simply false, so prefer it.
      : perDay > 0
      ? `<span class="fl" title="${meas.cumulative_burned != null
             ? fmtBig(meas.cumulative_burned) + " " + esc(t) : ""}">` +
        `measured on ${esc(meas.source || "chain")}` +
        (meas.cumulative_burned != null
          ? ` · ${usd(meas.cumulative_burned) != null
                ? "$" + fmtBig(usd(meas.cumulative_burned)) + " at today's px"
                : fmtBig(meas.cumulative_burned)} burned lifetime` : "") + `</span>`
      : `<span class="fl">${esc(r.note || (meas.cumulative_burned != null
          ? fmtBig(meas.cumulative_burned) + " burned lifetime" : "awaiting data"))}</span>`;

    return `<div class="brn-row2" data-coin="${esc(t)}" ` +
      `title="${esc(p.detail)}\nsource: ${esc(p.source || "n/a")}` +
      (meas.source ? `\nmeasured on ${esc(meas.source)}` : "") + `">` +
      `<div class="brn-l1"><span class="brn-sym">${esc(t)}</span>` +
      burnWatchChip(t, p) +
      priceCell +
      supplySpark(meas.series, 54, 15) +
      verdict + trendTag + schedTag + pausedTag +
      `<span class="i-dossier" title="dossier">⋯</span></div>` +
      `<div class="brn-l2">` + boughtTag +
      (hold && meas.cumulative_burned != null && meas.cumulative_pct_supply >= 0.05
        ? `<span class="brn-cum" title="${fmtBig(meas.cumulative_burned)} ${esc(t)}">` +
          `${usd(meas.cumulative_burned) != null
             ? "$" + fmtBig(usd(meas.cumulative_burned)) : fmtBig(meas.cumulative_burned)} burned` +
          (meas.cumulative_pct_supply ? ` (${meas.cumulative_pct_supply.toFixed(1)}% of supply)` : "") + `</span>` : "") +
      // "Absorbs sell flow" only holds if the tokens were bought on the market.
      // A burn of fees collected in-kind removes supply without lifting a bid,
      // so it gets the weaker, accurate wording instead.
      (m && m.totalPct >= 0.005
        ? `<span class="fl" title="${esc(m.volSrc)} · sell share ${esc(m.shareSrc)}` +
          (p.bid ? "" : " · not market-bought: supply effect only") + `">` +
          (p.bid ? "absorbs " : "removes ") +
          `${m.totalPct >= 100 ? ">100" : m.totalPct.toFixed(2)}% of ` +
          (p.bid ? "sell flow" : "daily volume from supply") +
          (m.gVol ? "" : " (HL vol only)") + `</span>` : "") +
      burnPayoutHtml(p) +
      detail + `</div></div>`;
  }).join("");

  const ev = (state.burnEvents || []).slice(0, 3).map((e) =>
    `<div class="brn-ev"><b>${esc(e.tok)}</b> ${esc(e.kind)} · ${esc(e.detail)}</div>`).join("");
  const off = state.buybackOffVenue || {};
  const offHtml = Object.keys(off).length
    ? `<div class="brn-off">OFF-VENUE — price only, not tradeable or supply-tracked here:<br>` +
      Object.entries(off).map(([k, v]) => {
        const px = v.price || {};
        const line = px.usd != null
          ? `<span class="brn-offpx">$${px.usd < 1 ? px.usd.toFixed(4) : fmtPx(px.usd)} ` +
            `<span class="${px.chg24h >= 0 ? "up" : "dn"}">${px.chg24h >= 0 ? "+" : ""}` +
            `${(px.chg24h || 0).toFixed(2)}%</span> · mcap $${fmtBig(px.mcap)} ` +
            `· vol $${fmtBig(px.vol24h)} <i>CoinGecko</i></span>` : "";
        return `<b>${esc(k)}</b> ${esc(v.detail || "")} ${line}`;
      }).join("<br>") + `</div>` : "";
  // Freshness must be visible, not assumed. A burn tab that silently stopped
  // updating looks identical to one that is up to date.
  const fr = state.buybackFresh || {};
  let freshTag = "";
  const rowFails = Object.values(state.buyback || {})
    .filter((x) => x && x.history_meta && x.history_meta.build_err)
    .map((x) => (x.token || "") + ": " + x.history_meta.build_err);
  const buildFails = (fr.build_fails || []).map((f) =>
    (f.token || "") + ": " + (f.err || "build failed"));
  const writerFail = rowFails.concat(buildFails);
  const wr = fr.writer || {};
  if (wr.err || wr.failed_at) {
    writerFail.push(wr.err || "history writer failed");
  }
  // Honest age: the older of in-memory fresh.at and history-file mtime.
  // series_last_ts is last DATA (batch tokens go quiet for weeks) — tooltip
  // only, not the chip number.
  const nowS = Date.now() / 1000;
  const liveClocks = [];
  if (fr.at) liveClocks.push(fr.at);
  if (fr.store_at) liveClocks.push(fr.store_at);
  if (wr.at) liveClocks.push(wr.at);
  const liveAt = liveClocks.length ? Math.min.apply(null, liveClocks) : null;
  const ageS = liveAt != null ? Math.max(0, nowS - liveAt)
    : (srvAgeS(fr) != null ? srvAgeS(fr) : null);
  if (state.buybackError || fr.err || fr.failed_at || writerFail.length) {
    const why = state.buybackError || fr.err || writerFail[0] || "buyback refresh failed";
    const lm = ageS != null ? ageS / 60 : null;
    freshTag = `<span class="brn-fresh stale" title="${esc(why +
      (writerFail.length ? " · writer: " + writerFail.join("; ") : "") +
      (fr.series_last_ts ? " · series through " +
        burnIstDate(fr.series_last_ts * 1000) : ""))}">` +
      (writerFail.length && !fr.err && !state.buybackError
        ? `WRITER FAIL`
        : `REFRESH FAILING`) + (lm != null
        ? ` · last good read ${lm < 1 ? "under a minute" : Math.round(lm) + "m"} ago`
        : ` · nothing has been read yet`) + `</span>`;
  } else if (ageS != null) {
    const m = ageS / 60;
    const late = fr.every_s && ageS > fr.every_s * 2.5;
    const seriesNote = fr.series_last_ts
      ? ` · series through ${burnIstDate(fr.series_last_ts * 1000)}`
      : "";
    freshTag = `<span class="brn-fresh ${late ? "stale" : ""}" ` +
      `title="auto-refresh every ${Math.round((fr.every_s || 0) / 60)} min · ` +
      `${fr.runs || 0} runs as of this client's last fetch` +
      ` · clocks: loop ${fr.at ? Math.round((nowS - fr.at) / 60) + "m" : "—"}` +
      `, file ${fr.store_at ? Math.round((nowS - fr.store_at) / 60) + "m" : "—"}` +
      seriesNote +
      ` · this client re-reads /api/buyback hourly, so the age below counts ` +
      `the older of loop stamp and history mtime PLUS page hold">` +
      `checked ${m < 1 ? "just now" : Math.round(m) + "m ago"}` +
      (late ? " · STALE" : "") + `</span>`;
  }

  // Same clipping trap as ALERTS/PORT/SCREEN: the host td inherits
  // nowrap+hidden from the watch table and silently amputates anything
  // wider than the pane (the off-venue lines lost 600px+ of numbers).
  $("wbody").innerHTML = `<tr><td colspan="7" style="white-space:normal;overflow:visible"><div class="brn-head">` + freshTag +
    burnCoverageHtml(rows) +
    `buy-pressure: 1d/7d on-chain if live, else last event, else idle — not a 30d net smear<br>` +
    `not net of token unlocks / vesting (no structured source)<br>` +
    `alerts at <b>${BURN_ABSORB_TRIGGER}%</b> of sell flow or <b>${BURN_UNUSUAL_RATIO}x</b> normal burn` +
    `</div>${liveBar}${bidBar}${ev}${html}${offHtml}</td></tr>`;
  document.querySelectorAll(".brn-agg-i").forEach((el) => {
    el.onclick = () => { if (exactCoin(el.dataset.coin)) selectCoin(el.dataset.coin); };
  });
  document.querySelectorAll(".brn-row2").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.classList.contains("i-dossier")) openDossier(el.dataset.coin);
      else if (exactCoin(el.dataset.coin)) selectCoin(el.dataset.coin);
    };
  });
}

function renderWatch() {
  /* The 20s universe poll ends here unconditionally; with PORT open it was
     rebuilding (and re-focusing, and blanking) the wallet input mid-keystroke,
     making a 42-character address untypeable. A pane being typed into is
     never rebuilt — the next poll repaints it 20s later.

     SCOPED TO PORT. Unscoped, this guard sat above the dispatch below and so
     swallowed explicit tab clicks too: #wtabs sets state.wtab and moves the
     .on class BEFORE calling renderWatch, so clicking SCREEN with the cursor
     still in the address box left the header saying SCREEN and the pane
     frozen on PORT's "CONNECT A WALLET" — measured, 280 chars of PORT still
     in #wtable after the click. That is exactly the sequence the terminal is
     waiting on him to perform. state.wtab has already moved by the time we
     get here, so testing it protects the paste and nothing else. */
  const ae = document.activeElement;
  if (ae && ae.id === "port-addr" && state.wtab === "port") return;
  /* #watch-meta is SHARED by all ten tabs and each renderer sets only its
     textContent. Three of them (WATCH, MOVERS, FUND) now also set a title, so
     without this the tooltip of whichever tab set one last would follow the
     reader onto every tab that does not — a tooltip describing the wrong
     pane's coverage, which is the same class of failure as a stale age. One
     line, cleared before the dispatch, so the default is "no tooltip". */
  const wmEl = $("watch-meta");
  if (wmEl) wmEl.title = "";
  if (state.wtab === "screen") return renderScreenTab();
  if (state.wtab === "deep") return renderDeepTab();
  if (state.wtab === "whales") return renderWhalesTab();
  if (state.wtab === "venues") return renderVenuesTab();
  if (state.wtab === "port") return renderPortTab();
  if (state.wtab === "alerts") return renderAlertsTab();
  if (state.wtab === "burn") return renderBurnTab();
  if (state.wtab === "movers") return renderMovers();
  if (state.wtab === "funding") return renderFundTab();
  if (state.wtab === "signals") return renderSignals();
  $("whead").innerHTML = HEAD_WATCH;
  // The SIDE column is the one that goes blank when the collector is full, so
  // the collector's capacity is stated in the header of the table that owns it.
  const ds = state.depthSlots;
  const wmw = $("watch-meta");
  wmw.textContent = "LIVE · HL WS" + (ds && ds.slots_pressure
    ? " · DEPTH " + ds.subscribed + "/" + ds.max_coins + " FULL" : "");
  wmw.title = ds
    ? (ds.slots_note || (ds.subscribed + " of " + ds.max_coins +
       " depth-collector slots in use")) +
      " A blank SIDE cell on a market outside those slots means NOT COLLECTED, not a balanced book."
    : "depth-collector capacity has not been reported by the server yet";
  const rows = [];
  const mkRow = (coin, ctx) => {
    const mid = state.mids[coin] != null ? state.mids[coin] : (ctx && ctx.mid_px);
    const prev = ctx && ctx.prev_day_px;
    const chg = pct(mid, prev);
    const f8h = ctx && ctx.funding != null ? ctx.funding * 8 * 100 : null;
    const cls = chg == null ? "fl" : chg >= 0 ? "up" : "dn";
    const sel = coin === state.sel ? " sel" : "";
    return `<tr class="wr${sel}" data-coin="${esc(coin)}">
      <td class="rm" data-rm="${esc(coin)}" title="remove">✕</td>
      <td class="sym">${esc(baseSym(coin))}</td>
      <td class="r" id="px-${esc(coin)}">${fmtPx(mid)}</td>
      <td class="r ${cls}">${chg == null ? "–" : (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%"}</td>
      <td class="r ${fundingClass(f8h)}">${f8h == null ? "–" : f8h.toFixed(4) + "%"}</td>
      <td class="r fl">${fmtUsd(oiUsd(ctx))}</td>
      ${watchSideCell(coin)}</tr>`;
  };
  rows.push('<tr class="grp"><td colspan="7">CRYPTO — HYPERLIQUID PERPS</td></tr>');
  for (const c of state.watchCrypto) rows.push(mkRow(c, state.universe.crypto[c]));
  rows.push('<tr class="grp"><td colspan="7">EQUITY PERPS — XYZ DEX · +SYM TO ADD</td></tr>');
  for (const c of state.watchEquity) rows.push(mkRow(c, state.universe.equity[c]));
  $("wbody").innerHTML = rows.join("");
  bindWatchRows();
}

function bindWatchRows() {
  document.querySelectorAll("tr.wr").forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.dataset.rm) return removeWatch(e.target.dataset.rm);
      selectCoin(tr.dataset.coin);
    };
  });
}

function removeWatch(coin) {
  state.watchCrypto = state.watchCrypto.filter((c) => c !== coin);
  state.watchEquity = state.watchEquity.filter((c) => c !== coin);
  saveCustomWatch(); renderWatch(); renderTape();
}
function addWatch(coin) {
  if (coin.includes(":")) {
    if (!state.watchEquity.includes(coin)) state.watchEquity.push(coin);
  } else if (!state.watchCrypto.includes(coin)) state.watchCrypto.push(coin);
  saveCustomWatch(); renderWatch(); renderTape();
}

function moverRow(r, valHtml) {
  const sel = r.coin === state.sel ? " sel" : "";
  /* baseSym strips the sleeve, so SMSN and SKHX sat beside BCH with nothing
     saying they are equity perps on a different venue — and the DISLOC column
     reads n/a for all of them for a structural reason (no CEX lists a perp on
     that underlying) that the table never gave. The tag carries the venue. */
  const dex = r.coin.includes(":") ? r.coin.split(":")[0] : "";
  return `<tr class="wr${sel}" data-coin="${esc(r.coin)}">
    <td class="sym">${esc(baseSym(r.coin))}${dex ?
      `<span class="wt-dex" title="${esc(dex)} HIP-3 perp — an equity/` +
      `commodity underlying. No centralised venue lists a perp on it, so ` +
      `DISLOC is n/a by construction, not missing.">${esc(dex)}</span>` : ""}</td>
    <td class="r">${fmtPx(state.mids[r.coin] != null ? state.mids[r.coin] : r.mid)}</td>
    ${valHtml}<td class="r fl">${fmtBig(r.volume)}</td></tr>`;
}

/* "FULL UNIVERSE" describes the SEARCH SPACE and was read as the RESULT SET.

   /api/movers returns by_chg[-10:] and by_chg[:10] with no count of what
   qualified; 63 markets pass the VOL>$1M filter (34 up, 29 down), so 24
   gainers and 19 losers were dropped under a banner reading FULL UNIVERSE and
   headers reading "TOP GAINERS 24H" with no N. The server now sends
   n_qualified and cap_note; both are read here rather than re-counted, so the
   pane cannot drift from the filter that actually ran. SCREEN says "4 shown"
   and VENUES says "NOT SHOWN — 3 further listing(s) exist" — same house rule. */
function moversGrp(label, shown, qualified) {
  return `<tr class="grp"><td colspan="4">${label}` +
    (qualified != null && qualified > shown
      ? ` <i style="opacity:.7">— top ${shown} of ${qualified}, ` +
        `the rest are NOT SHOWN, not absent</i>` : "") +
    `</td></tr>`;
}

/* The sentence a MOVERS/FUND pane paints when its one payload is missing.
   Kept in one place because the two tabs must not drift into disagreeing
   about the same failure, and because the distinction it draws — a scan that
   FAILED versus a scan that found nothing — is the whole point of the
   branch. `held` is the last good payload, if there is one. */
function moversErrHtml(held) {
  // colspan 5 = the FUND head's width; MOVERS is 4 and the browser clamps.
  return '<tr><td class="empty" colspan="5" style="white-space:normal">' +
    'SCAN FAILED — <b>' + esc(state.moversErr) + '</b>. ' + (held
      ? 'The rows below this line are from the last scan that completed, not ' +
        'from the current market.'
      : 'No scan has completed this session, so nothing here is a reading of ' +
        'the market — this is not a universe with no movers in it.') +
    '</td></tr>';
}

function renderMovers() {
  const m = state.movers;
  const nq = (m && m.n_qualified) || {};
  // ROWS FIRST, HEADER LAST. Building into a local and assigning at the end
  // means a throw in here cannot leave the MOVERS header standing over the
  // previous tab's rows — the shape of the bug this branch exists for.
  const rows = [];
  if (state.moversErr) rows.push(moversErrHtml(m));
  if (m) {
    rows.push(moversGrp("TOP GAINERS 24H", (m.gainers || []).length, nq.gainers));
    for (const r of m.gainers || []) rows.push(moverRow(r,
      `<td class="r up">+${r.chg_pct.toFixed(2)}%</td>`));
    rows.push(moversGrp("TOP LOSERS 24H", (m.losers || []).length, nq.losers));
    for (const r of m.losers || []) rows.push(moverRow(r,
      `<td class="r dn">${r.chg_pct.toFixed(2)}%</td>`));
  } else if (!state.moversErr) {
    rows.push('<tr><td class="empty">loading…</td></tr>');
  }
  $("whead").innerHTML = HEAD_MOVERS;
  $("watch-meta").textContent = state.moversErr && !m ? "MOVERS — SCAN FAILED"
    : nq.markets != null
    ? `TOP ${(m.limit || 10)} EACH WAY · ${nq.markets} MKTS PASS VOL>1M`
      + (state.moversErr ? " · REFRESH FAILING" : "")
    : "SCANNED: FULL UNIVERSE · VOL>1M";
  const wm = $("watch-meta");
  if (wm) wm.title = state.moversErr ? state.moversErr : (m && m.cap_note) ||
    "each list is a top-N page of the markets that pass the volume filter, not the whole set";
  $("wbody").innerHTML = rows.join("");
  bindWatchRows();
}

/* Per-coin whale detail for the chart overlay: who is positioned in the
   charted pair, at what entry, and — when we watched it happen — since
   when. Entry prices are exact (the venue reports them); entry TIMES only
   exist for positions opened while tracking was running, so older ones
   say "before tracking" rather than inventing a timestamp. */
async function loadWhaleCoin() {
  const coin = state.sel;
  if (!coin) return;
  try {
    const r = await fetch("/api/whales?coin=" + encodeURIComponent(coin));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    // The 200-error envelope carries no `coin`, so the identity check below
    // already drops it — but silently, and this overlay is also read by
    // whFor(). Made explicit so a future payload that DOES carry a coin
    // alongside an error cannot slip past on the identity check alone.
    if (d && d.error) throw new Error(d.error);
    if (d.coin === state.sel) {           // user may have moved on mid-fetch
      state.whaleCoin = d;
      drawChart();
      renderNewsCtx();
      loadDes();
    }
  } catch (e) { /* overlay simply absent */ }
}

/* Cross-venue funding: HL vs Binance vs Bybit, all as APR. The FUND tab
   was HL-only, so "crowded" could not distinguish an HL-side crowd from
   market-wide sentiment (funding high but equal on every venue). The
   DISLOC column is HL minus the CEX median — the venue-specific part. */
async function loadFundingX() {
  try {
    const r = await fetch("/api/funding_x");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    // 200 + {error} has no `rows`, so dislocCell would have found nothing for
    // every coin and printed the "not measured" dash across the column while
    // fundingXErr stayed null — an unmeasured dislocation dressed as a
    // measured one. The catch keeps the last real payload and dates it.
    if (d && d.error) throw new Error(d.error);
    state.fundingX = d;
    // When this payload landed HERE. The server's own `at` dates the CACHE
    // build (TTL 300s), and the comment below used to promise the column
    // "degrades to n/a" on failure — it does not: disloc_apr stays a number
    // and keeps rendering. So the carried-forward case is dated instead.
    state.fundingXAt = Date.now();
    state.fundingXErr = null;          // a good read clears the last failure
  } catch (e) {
    /* KEEP LAST — but the DISLOC column does NOT degrade to n/a, it keeps
       printing the last number to one decimal with no age. predictedFundings
       moves continuously: a 13-minute-old payload measured BTC hl_apr at 1.81
       against a live recompute of 10.74, a 6x gap, and 29 coins differed by
       >50% from a live recompute on TTL drift alone. The number stays (it was
       real when it was read); the age now travels with it. */
    state.fundingXErr = (e && e.message) || String(e);
  }
  if (state.wtab === "funding") renderFundTab();
}

/* Age of the funding-dislocation numbers, in the two hops that actually
   happened: the server's cache had already been standing for `age_s` when it
   was served, and it has been held in this tab since. Both are server-vs-self
   or client-vs-self differences — no clock is ever compared across machines,
   the same discipline sdNow() uses. */
function fxAgeS() {
  const fx = state.fundingX;
  if (!fx) return null;
  const held = state.fundingXAt ? (Date.now() - state.fundingXAt) / 1000 : 0;
  const serverAge = fx.age_s != null ? fx.age_s : 0;
  return Math.max(0, Math.round(serverAge + held));
}

function fxFor(coin) {
  return ((state.fundingX || {}).coins || {})[baseSym(coin)] ||
         ((state.fundingX || {}).coins || {})[coin] || null;
}

function dislocCell(coin) {
  const fx = fxFor(coin);
  if (!fx || fx.disloc_apr == null)
    return '<td class="r fl" title="' + (coin.includes(":")
      ? esc(baseSym(coin)) + ' is a HIP-3 equity/commodity perp: no ' +
        'centralised venue lists a perp on this underlying, so the ' +
        'comparison is impossible BY CONSTRUCTION, not missing data'
      : 'no CEX listing — HL-only, no comparison possible') + '">n/a</td>';
  const d = fx.disloc_apr;
  const aS = fxAgeS();
  const tip = "HL " + fx.hl_apr.toFixed(1) + "% APR" +
    (fx.binance_apr != null ? " · Binance " + fx.binance_apr.toFixed(1) + "%" : "") +
    (fx.bybit_apr != null ? " · Bybit " + fx.bybit_apr.toFixed(1) + "%" : "") +
    " — positive = longs pay more on HL than on the CEXes (crowd is here)" +
    // Every other cached number in this terminal dates itself; this one is a
    // PREDICTED rate behind a 300s cache and was the only one that did not.
    (aS == null ? " · age unknown"
     : " · measured " + (aS < 90 ? aS + "s" : (aS / 60).toFixed(1) + "m") +
       " ago (predicted rates move continuously between reads)") +
    (state.fundingXErr ? " · REFRESH FAILING (" + state.fundingXErr + ") — " +
      "this is the last payload that arrived, not the current rate" : "");
  return '<td class="r ' + (Math.abs(d) < 15 ? "fl" : fundingClass(d)) +
    '" title="' + esc(tip) + '">' + (d >= 0 ? "+" : "") + d.toFixed(0) + '</td>';
}

function renderFundTab() {
  const m = state.movers;
  const nqf = ((m && m.n_qualified) || {}).funding;
  // Rows first, header last — the same ordering as renderMovers, and for the
  // same reason: these two tabs share one payload and one failure mode.
  const rows = [];
  if (state.moversErr) rows.push(moversErrHtml(m));
  if (m) {
    rows.push('<tr class="grp"><td colspan="5">CROWDED FUNDING — LONGS PAY (+) / SHORTS PAY (−) · DISLOC = HL vs CEX MEDIAN (APR PTS)' +
      (nqf != null && nqf > (m.funding_extremes || []).length
        ? ` <i style="opacity:.7">— top ${(m.funding_extremes || []).length} of ${nqf}</i>` : "") +
      '</td></tr>');
    for (const r of m.funding_extremes || []) rows.push(moverRow(r,
      `<td class="r ${fundingClass(r.funding_8h_pct)}">${r.funding_8h_pct.toFixed(4)}%</td>` +
      dislocCell(r.coin)));
  } else if (!state.moversErr) {
    rows.push('<tr><td class="empty">loading…</td></tr>');
  }
  $("whead").innerHTML = HEAD_FUND;
  // Same correction as MOVERS: this list is the |funding| top 10 of every
  // market carrying a rate, and the header named neither the 10 nor the N.
  $("watch-meta").textContent = state.moversErr && !m ? "FUNDING — SCAN FAILED"
    : nqf != null
    ? `TOP ${(m.limit || 10)} BY |8H| · OF ${nqf} RATED MKTS`
      + (state.moversErr ? " · REFRESH FAILING" : "")
    : "FUNDING EXTREMES · |8H|";
  const wmf = $("watch-meta");
  if (wmf) wmf.title = state.moversErr ? state.moversErr : (m && m.cap_note) ||
    "the largest absolute funding rates only — the rest are NOT SHOWN, not absent";
  $("wbody").innerHTML = rows.join("");
  bindWatchRows();
}

$("wtabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll("#wtabs button").forEach((x) => x.classList.remove("on"));
  b.classList.add("on");
  state.wtab = b.dataset.t;
  if (state.wtab === "alerts") {
    const fired = ((state.alertFeed || {}).fired) || [];
    // Own fires live in the browser ledger and can be NEWER than anything the
    // server window still carries; stamping only the server rows left the
    // badge hot forever.
    const ats = fired.concat(mineFires()).map((f) => f.at || 0);
    const newest = ats.length ? Math.max(...ats) : 0;
    if (newest) localStorage.setItem("hlterm_alerts_seen", String(newest));
    loadAlertsFeed();
    updateTabBadges();
  }
  renderWatch();
  renderHints();
});

/* THE HINT BAR, SCOPED TO WHAT IS ACTUALLY ON SCREEN.

   Audited 2026-08-16: #hints read "⋯ dossier · ⏰ alert · ↗ market · ✕ remove ·
   click wall = alert · ? keys · ⌘K commands" on every tab, always. A DOM glyph
   census on the default WATCH desk found ⋯ ZERO times and ⏰ ZERO times
   anywhere on screen (⋯ lives on SIGNALS, 20 of them, and BURN, 14; ⏰ exists
   only inside the dossier). "click wall = alert" needs the heat layer, which is
   off by default, so it was inert until H is pressed.

   A permanent bar advertising two glyphs that are not there is the same class
   of error as a lit button that draws nothing: the reader hunts for an
   affordance the screen does not have, and concludes he has misread the screen.
   So each rung is now conditional on the thing it names existing right now. */
/* Every rung is CENSUSED from the live DOM, never asserted from a table.

   First attempt at this fix used a hand-written {tab -> glyph} map, and the
   measurement caught it making the exact error it was written to remove:
   whales and venues advertised "↗ market" while a glyph count of #p-watch on
   those tabs returned 0, and burn advertised "⋯" on a frame that had none. A
   lookup table is a CLAIM about the DOM that drifts the moment a renderer
   changes; counting the nodes is the DOM itself. So each rung below asks the
   page whether its affordance is on screen right now.

   Selectors, not innerText scanning: .i-dossier is the ⋯ affordance (signals,
   burn, intel rows), a.mkt is the ↗ (an unlisted event renders a "·" span
   instead, so a.mkt matches the glyph rather than the row), .rm is the ✕ on a
   watch row, .ac-x is the ✕ on an alert chip. state.heatWalls is written by
   drawChart from the frame it just drew, so the wall rung reads the glass. */
function renderHints() {
  const el = $("hints");
  if (!el) return;
  const any = (sel) => !!document.querySelector(sel);
  const bits = [];
  if (any("#p-watch .i-dossier, #p-events .i-dossier")) bits.push("⋯ dossier");
  if (any("#p-watch a.mkt, #p-events a.mkt")) bits.push("↗ market");
  if (any("#p-watch .rm")) bits.push("✕ remove");
  if (any("#alertbar .ac-x")) bits.push("✕ clears an alert");
  if ((state.heatWalls || []).length) bits.push("click wall = alert");
  bits.push("<b>D</b> dossier", "<b>?</b> keys", "<b>⌘K</b> commands");
  const next = bits.join(" · ");
  if (el.innerHTML !== next) el.innerHTML = next;      // no churn per tick
}

/* MOVERS AND FUND ARE TWO VIEWS OF ONE PAYLOAD, and both used to assume it.
   `state.movers = await fetch(...).then(r => r.json())` accepted whatever
   came back, and what comes back from a failed route is HTTP 200 + {error}
   (do_GET's catch-all) — realistically an HL 429 on the universe fetch after
   a restart. That object has no `gainers`, so renderMovers threw on
   `m.gainers.length` AFTER it had already written the MOVERS header, leaving
   the previous tab's watchlist rows underneath it with no error sentence
   anywhere; renderFundTab threw the same way on `m.funding_extremes`. The
   60s repaint then re-threw forever.

   So: the last good scan survives (loadVenues' rule — a dated old board beats
   a blank one), the failure is carried out under its own key, and the two
   renderers below build their rows BEFORE touching the header, so no throw
   between the two can leave one tab's header over another tab's data. */
async function loadMovers() {
  try {
    const d = await fetch("/api/movers").then((r) => r.json());
    if (d && !d.error && d.gainers) { state.movers = d; state.moversErr = null; }
    else state.moversErr = String((d && d.error) || "the movers payload carried no rows");
  } catch (e) {
    state.moversErr = (e && e.message) || String(e);
  }
  if (state.wtab !== "watch") renderWatch();
}

/* live px update without full re-render */
function updatePx(coin, mid) {
  const el = document.getElementById("px-" + coin);
  if (!el) return;
  const old = parseFloat(el.textContent.replace(/,/g, ""));
  el.textContent = fmtPx(mid);
  if (!isNaN(old) && old !== +mid) {
    el.classList.remove("px-flash-up", "px-flash-dn");
    void el.offsetWidth;
    el.classList.add(+mid > old ? "px-flash-up" : "px-flash-dn");
  }
}

/* ── VENUES: cross-venue aggregate ──────────────────────────────────────
   /api/venues was served and prewarmed for months with ZERO client
   fetches — venue data reached the UI only through /api/sides' ident
   block and the whales pane's own coverage rows. This board is the one
   place every venue is visible together: HL core, its HIP-3 DEXs,
   Lighter.

   Cadence: the server rebuilds the snapshot at most every 5 minutes
   (VENUES_TTL=300, dropping to 60s only after a partial snapshot), so
   polling faster than 5m re-reads the same cache. The AGE chip carries
   the honest staleness, and a 60s repaint keeps that age moving between
   polls.

   Honesty rules (house invariant):
   - OI is never summed into one bare number: gross OI double-counts
     hedges, and only some venues publish OI at all — both facts render
     WITH the figure, everywhere it appears.
   - A venue that publishes no OI (Lighter) reads NOT PUBLISHED, never 0.
   - Dormant venues are "deployed but untraded, not broken"; failed venue
     fetches render loudly with the impact line the server states. */
const VENUES_POLL_MS = 300000;  // = server VENUES_TTL — see cadence note

async function loadVenues() {
  try {
    const d = await fetch("/api/venues").then((r) => r.json());
    if (d && (d.venues || []).length) { state.venues = d; state.venuesErr = null; }
    else state.venuesErr = (d && d.error) ? String(d.error) : "empty snapshot";
  } catch (e) {
    // Keep the last good snapshot through a failed refresh: the AGE chip
    // says how stale it is, which beats a blank board.
    state.venuesErr = String((e && e.message) || e);
  }
  renderVenueStrip();
  if (state.wtab === "venues") renderVenuesTab();
}

function venueAgeS() {
  const d = state.venues;
  return d && d.at ? Math.max(0, Date.now() / 1000 - d.at) : null;
}
function fmtAge(s) {
  if (s == null) return "–";
  if (s < 90) return Math.round(s) + "S";
  if (s < 5400) return Math.round(s / 60) + "M";
  return (s / 3600).toFixed(1) + "H";
}
/* hyna's measured share is 0.008% — toFixed(1) prints that as "0.0%",
   which renders measured-tiny as zero. Floor the display instead. */
function fmtShare(p) {
  if (p == null) return "–";
  return p < 0.1 ? "<0.1%" : p.toFixed(1) + "%";
}

const OI_CAVEAT = "gross open interest is NOT additive — a trader hedged " +
  "on two venues is counted on both, so the sum double-counts hedges by " +
  "an unknown amount";

function renderVenueStrip() {
  const el = $("venue-chips");
  if (!el) return;
  const d = state.venues;
  if (!d) {
    el.innerHTML = '<span class="rchip dim">' + (state.venuesErr
      ? 'venue snapshot failed — ' + esc(state.venuesErr) : 'loading…') +
      '</span>';
    return;
  }
  const t = d.totals || {};
  const vol = t.vol_24h || 0;
  const chips = [];
  chips.push('<span class="rchip"><span class="rl">24H VOL</span><b>$' +
    fmtBig(vol) + '</b></span>');
  chips.push('<span class="rchip" title="' + esc(OI_CAVEAT) + '">' +
    '<span class="rl">OI</span><b>$' + fmtBig(t.oi_usd_gross) + '</b>' +
    '<span class="rl">GROSS ' + (t.oi_venues_reporting || 0) + '/' +
    (t.oi_venues_total || 0) + ' · NOT ADDITIVE</span></span>');
  chips.push('<span class="rchip"><span class="rl">MKTS</span><b>' +
    (t.markets_live != null ? t.markets_live : "–") + '</b></span>');
  const vAll = d.venues || [];
  const SHOWN = 3;
  for (const v of vAll.slice(0, SHOWN)) {
    const sh = vol ? (v.vol_24h || 0) / vol * 100 : null;
    chips.push('<span class="rchip"><span class="rl">' +
      esc(v.venue.toUpperCase()) + '</span><b>' + fmtShare(sh) + '</b></span>');
  }
  /* The strip showed the top 3 shares and stopped, with no marker that two
     more venues existed — xyz at 14.2% ($258.5M) and Extended at 6.8%
     ($124.4M) simply were not there. Partly self-correcting (the OI chip says
     GROSS 7/8, so the reader can infer eight venues) but a share list that
     ends without saying it ended reads as the whole list. The omitted venues
     ride in the chip's title so the fact is one hover away, not one tab away. */
  const rest = vAll.slice(SHOWN);
  if (rest.length) {
    const names = rest.map((v) => v.venue.toUpperCase() + " " +
      fmtShare(vol ? (v.vol_24h || 0) / vol * 100 : null)).join(" · ");
    chips.push('<span class="rchip dim" title="NOT SHOWN in this strip: ' +
      esc(names) + ' — click for the full VENUES board"><b>+' + rest.length +
      '</b><span class="rl">MORE</span></span>');
  }
  if (t.venues_failed)
    chips.push('<span class="rchip st-r"><b>' + t.venues_failed +
      ' VENUE FETCH FAILED</b></span>');
  chips.push('<span class="rchip dim" title="age of the venue snapshot — ' +
    'the server rebuilds it at most every 5 minutes">' + fmtAge(venueAgeS()) +
    ' OLD</span>');
  el.innerHTML = chips.join('<span class="sep">·</span>');
}

/* ── LANDSCAPE: where this stack sits in the wider on-chain perp market ──
   Point-in-time SURVEY data (data/venue_landscape.json, served as the
   `landscape` key of /api/venues) — NOT live. Rendering rules, all house
   invariant:
   - every row is dated (source + as-of) and the section header says
     "surveyed <date> · NOT LIVE"; nothing here is summed into the live
     totals above, which stay purely live;
   - a venue the survey could not measure renders its note (NOT MEASURED /
     CONFLICT / host-blocked) in amber, never "–" and never $0 — unreachable
     is not zero, and an unresolved 66x conflict (edgeX) is not a number;
   - wash/incentive caveats travel WITH the row: an incentive-inflated
     volume must never render as a clean fact.
   Statuses: COVERED (on the live board above), COVERABLE (free API
   measured, not built), BLOCKED (host-level block), NO BOOK (pool-based —
   no depth to aggregate), NO FREE API. */
function landscapeHtml(ls) {
  if (!ls || !(ls.rows || []).length) return "";
  const out = [];
  out.push('<div class="vnl-head">LANDSCAPE — the wider on-chain perp ' +
    'market<span class="vnl-date">surveyed ' + esc(ls.as_of || "?") +
    ' · NOT LIVE</span></div>');
  if (ls.headline)
    out.push('<div class="vnl-fact">' + esc(ls.headline) + '</div>');
  out.push('<div class="vnl-grid">' +
    '<div class="vnl-r vnl-th"><span>VENUE</span><span>24H VOL</span>' +
    '<span>OI</span><span>STATUS</span><span>SOURCE · AS-OF</span></div>');
  for (const r of ls.rows || []) {
    const st = String(r.status || "?");
    const stCls = st === "COVERED" ? "vnl-ok"
      : st === "BLOCKED" ? "vnl-bad"
      : st === "COVERABLE" ? "vnl-mid" : "vnl-dim";
    // null + note = "the survey could not put a number here"; the note IS
    // the value. Bare "–" would read as measured-nothing.
    const vol = r.vol_24h != null ? '$' + fmtBig(r.vol_24h)
      : '<span class="vnl-nm">' + esc(r.vol_note || "NOT MEASURED") +
        '</span>';
    const oi = r.oi_usd != null ? '$' + fmtBig(r.oi_usd)
      : '<span class="vnl-nm">' + esc(r.oi_note || "NOT MEASURED") +
        '</span>';
    out.push('<div class="vnl-r">' +
      '<span class="vnl-v">' + esc(r.venue) +
      (r.kind ? ' <i>' + esc(r.kind) + '</i>' : '') + '</span>' +
      '<span class="vnl-n">' + vol + '</span>' +
      '<span class="vnl-n">' + oi + '</span>' +
      '<span class="vnl-st ' + stCls + '">' + esc(st) + '</span>' +
      '<span class="vnl-src">' + esc(r.source || "source not recorded") +
      (r.as_of ? ' · ' + esc(r.as_of) : '') + '</span></div>');
    if (r.caveat)
      out.push('<div class="vnl-cv"><b>caveat</b> — ' + esc(r.caveat) +
        '</div>');
  }
  out.push('</div>');
  if (ls.method) out.push('<div class="vnl-meth">' + esc(ls.method) + '</div>');
  return out.join("");
}

/* ══ AGGREGATOR — blocks 2 and 3 of the VENUES tab ════════════════════════
   The VENUES tab is the one surface where the whole on-chain perp market is
   visible at once. Three blocks, stacked, each carrying its OWN age because
   they refresh on three different clocks (5m / 60s / 120s) and a single
   header age would date two of them wrongly:

     1 MARKET      — every covered venue's volume, markets, OI and funding
                     basis, with per-venue share. Volume is additive; OI is
                     not. Both rules come from the server and are rendered,
                     not re-derived here.
     2 INSTRUMENT  — the CHARTED coin on every venue that lists it: book mid,
                     spread, ±25bps resting depth, volume, OI, funding.
                     DEPTH IS PER-COIN, never per-venue. There is no such
                     thing as "a venue's depth" — only the depth of one book
                     at one instant — which is why this block is keyed to the
                     chart and the block above it is not.
     3 WHO         — who is behind those books, with the coverage asymmetry
                     stated on every row rather than implied by a gap.

   Width: the pane measures 357px at the owner's own 1728x1000 layout, so
   these are compact two-line rows in the .vn-row idiom, NOT the 7-column
   grid the dossier's cross-venue box uses (that box lives in a full-width
   overlay). Same numbers, same server payload, different width budget. */

/* Client refresh floors. Each equals the server's own cache TTL for that
   endpoint — polling faster only re-reads the same cached object. */
const AGG_XV_TTL_MS = 60000;    // server XVENUE_TTL  = 60
const AGG_XP_TTL_MS = 120000;   // server XPRINTS_TTL = 120
const AGG_WH_TTL_MS = 60000;    // server whale_coin cache = 60
const AGG_KEEP = 8;             // coins kept per store; oldest evicted

/* Wording of last resort for the instrument board's slot rule. The SERVER
   states this rule (cross_venue.OTHERS_RULE, carried as `others_rule`) and
   the renderers print the server's copy whenever it is present — this exists
   only so an older payload without the field does not render a roster with
   no rule attached. ONE definition, both renderers, so the two cannot drift
   into describing different rules for the same board. */
const OTHERS_RULE_FALLBACK = "one listing per venue — its largest by 24h " +
  "volume — before any venue takes a second slot";

function aggPut(store, key, val) {
  store[key] = val;
  const ks = Object.keys(store);
  if (ks.length <= AGG_KEEP) return;
  ks.sort((a, b) => (store[a].at || 0) - (store[b].at || 0));
  for (const k of ks.slice(0, ks.length - AGG_KEEP)) delete store[k];
}

/* When a payload was MEASURED, from the payload's own stamp — not when it
   happened to arrive in this tab.

   MEASURED 2026-08-16 against the live server. /api/xvenue and /api/xprints
   stamp `at` when their fan-out STARTS and then re-serve that identical
   payload, with that identical `at`, for the whole ≤60s cache hold: three
   spaced calls to /api/xvenue?coin=SOL all returned at=1786871979.710 while
   the last landed 10.2s later, and a cached /api/xvenue?coin=AVAX answered in
   3ms carrying an `at` 12.8s old. Dating from RECEIPT therefore reset the age
   to zero on every cache hit — SOL's book table was 18.4s old and the box
   said "Fetched 0s ago", the header said "BOOKS 0S". The hold was real and
   invisible, which is the one combination this desk does not allow.

   Reading a SERVER stamp with a CLIENT clock is normally a skew measurement
   wearing an age's clothes, and sdNow() one file over refuses to do it. That
   objection is about two machines. It does not hold here and that is
   measured, not assumed: this server is a launchd process on this same Mac
   behind 127.0.0.1, so both stamps come off ONE system clock. Three COLD
   calls (rtt 3.5s / 4.3s / 4.4s, so the server built each payload during the
   call) gave client_t0 − server_at = −2ms, −2ms, −2ms.

   The guard is what makes that safe to DEPEND on rather than to promise. A
   stamp ahead of us, or older than a window far wider than any hold these two
   routes take, is not one clock — it is refused and receipt time is used, and
   the caller is told which basis it got so the glass can say so too. An age
   that would be a skew reading is never printed as an age. */
const SRV_STAMP_LEAD_MS = 2000;      // ahead of our clock by more than this: not one clock
const SRV_STAMP_LAG_MS = 900000;     // 15m — a decade beyond a ≤60s cache hold

function srvStamp(d, recvMs) {
  const at = d && typeof d.at === "number" && isFinite(d.at) ? d.at * 1000 : null;
  // A warming payload carries no `at` at all (verified: its keys are coin /
  // warming / rows / measured / retry_after_s / note), so this is the normal
  // path for one, not an error.
  if (at == null) return { ms: recvMs, srv: false };
  if (at - recvMs > SRV_STAMP_LEAD_MS) return { ms: recvMs, srv: false };
  if (recvMs - at > SRV_STAMP_LAG_MS) return { ms: recvMs, srv: false };
  // Clamp a stamp inside the lead tolerance so an age can never read negative.
  return { ms: Math.min(at, recvMs), srv: true };
}

/* Per-coin PRINT SIZE (/api/xprints) — the anonymous half of block 3.
   Deliberately a separate endpoint from /api/xvenue: the server splits them
   so one request does not double an 8-call fan-out, and the client keeps
   that split rather than pretending they arrive together. */
async function loadXPrints(coin) {
  const cur = state.xp[coin];
  // A WARMING payload is not a measurement and must not hold the success
  // floor. MEASURED 2026-08-15: the cold-start warming shape was stored as
  // a success and pinned for the full AGG_XP_TTL_MS, so the tape block read
  // "not measured" for two minutes after every restart while the server was
  // ready in about five seconds. The server now states its own
  // `retry_after_s`; honour that number rather than planting a second copy
  // of it here to go stale independently. The xvenue twin does the same
  // thing in xvStale() — same convention, one file.
  const floor = cur && cur.err ? 20000
    : (cur && cur.d && cur.d.warming) ? ((cur.d.retry_after_s || 5) * 1000)
    : AGG_XP_TTL_MS;
  if (cur && (cur.loading || Date.now() - (cur.at || 0) < floor)) return;
  const kept = cur ? cur.d : null;
  const keptAt = cur ? cur.dAt : null;
  const keptSrv = cur ? !!cur.dSrv : false;
  aggPut(state.xp, coin, { coin, loading: true, at: Date.now(), d: kept,
                           dAt: keptAt, dSrv: keptSrv });
  try {
    const r = await fetch("/api/xprints?coin=" + encodeURIComponent(coin));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    if (d && d.error) throw new Error(d.error);
    // dAt from the payload's own build stamp, so the server's cache hold is
    // inside the age this tab prints. See srvStamp().
    const st = srvStamp(d, Date.now());
    aggPut(state.xp, coin, { coin, d, at: Date.now(), dAt: st.ms, dSrv: st.srv });
  } catch (e) {
    // Last good payload survives a blip; the block says how old it is and
    // that the refresh is failing, which beats blanking the tape column.
    aggPut(state.xp, coin, { coin, err: (e && e.message) || String(e),
                             at: Date.now(), d: kept, dAt: keptAt,
                             dSrv: keptSrv });
  }
  if (state.wtab === "venues") renderVenuesTab();
}

/* Whale detail for ONE symbol on ONE HL-family venue. The chart already
   polls state.whaleCoin for the charted symbol; this covers the OTHER
   Hyperliquid rows in a cross-listing (hyna:BTC beside core BTC), which the
   chart never asks about. It is a LOCAL read server-side — whales.coin_detail
   reads the persisted sweep store and makes no upstream call — so this adds
   no load to the HL rate limit the sweep is already close to. */
async function loadWhaleSym(sym) {
  if (!sym) return;
  if (state.whaleCoin && state.whaleCoin.coin === sym) return;
  const cur = state.whByCoin[sym];
  if (cur && (cur.loading || Date.now() - (cur.at || 0) <
      (cur.err ? 20000 : AGG_WH_TTL_MS))) return;
  aggPut(state.whByCoin, sym, { sym, loading: true, at: Date.now(),
                                d: cur ? cur.d : null });
  try {
    const r = await fetch("/api/whales?coin=" + encodeURIComponent(sym));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    // Sibling of loadWhaleCoin's guard and of xprints/xvenue's: a 200-error
    // payload stored as `d` here reads to whFor()'s consumers as a venue row
    // with no whales on it, which is the coverage claim this pane exists to
    // never make. Routed to the catch it keeps the last good `d` and errs.
    if (d && d.error) throw new Error(d.error);
    aggPut(state.whByCoin, sym, { sym, d, at: Date.now() });
  } catch (e) {
    aggPut(state.whByCoin, sym, { sym, err: (e && e.message) || String(e),
                                  at: Date.now(),
                                  d: cur ? cur.d : null });
  }
  if (state.wtab === "venues") renderVenuesTab();
}

function whFor(sym) {
  if (state.whaleCoin && state.whaleCoin.coin === sym)
    return { d: state.whaleCoin, err: null };
  return state.whByCoin[sym] || null;
}

/* ── the coverage asymmetry, per venue ─────────────────────────────────
   Per-wallet identity is NOT uniform across these venues, and rendering it
   as though it were is the exact failure this block exists to prevent: an
   empty xyz whale overlay read as "no whales in this market" for a year.
   Three states, never collapsed, keyed by the `chain` each venue record
   already carries — so a venue added to venues.py inherits a state instead
   of silently rendering blank:

     named   hyperliquid — clearinghouseState is public per wallet with no
                           auth, and whales.py sweeps a 200-wallet roster.
                           Even here the honest label is "tracked wallets",
                           never "the market".
     anon    bnb         — Aster publishes no per-account data at any price:
                           positions, leaderboard and the REST forced-order
                           feed were each probed and none is public. Size is
                           real and ANONYMOUS.
             starknet    — Extended's per-account endpoints are auth-gated to
                           the key holder's OWN account, so a third party's
                           position is not public either.
     unswept zklighter   — Lighter DOES publish per-address positions
                           keylessly. THIS TERMINAL does not sweep them. That
                           is a boundary of this terminal, not of the venue,
                           and it must not wear the same colour as a venue
                           that publishes nothing.

   /api/xvenue states the same asymmetry once, in its caveats. This table is
   what lets every ROW carry it, instead of one footnote under all of them. */
const AG_IDENT = {
  hyperliquid: { st: "named", chip: "NAMED WALLETS",
    why: "clearinghouseState is public per wallet on the Hyperliquid " +
         "family — this terminal sweeps a tracked roster, which is a " +
         "SAMPLE of the venue, never all of it" },
  zklighter: { st: "unswept", chip: "NOT TRACKED HERE",
    why: "Lighter publishes per-address positions keylessly, but this " +
         "terminal's whale sweep does not query them — a boundary of THIS " +
         "TERMINAL, not of the venue. Absence here is not absence of whales" },
  bnb: { st: "anon", chip: "ANONYMOUS SIZE ONLY",
    why: "Aster publishes no per-account data at any price — no positions, " +
         "no leaderboard, no public forced-order REST feed. Size on this " +
         "venue is real and unattributable" },
  starknet: { st: "anon", chip: "ANONYMOUS SIZE ONLY",
    why: "Extended's per-account endpoints are auth-gated to the key " +
         "holder's OWN account, so a third party's position is not public" },
};
const AG_IDENT_UNKNOWN = { st: "unknown", chip: "COVERAGE UNKNOWN",
  why: "no identity coverage has been established for this venue's chain — " +
       "unknown, which is not the same as anonymous and not the same as none" };

function agIdent(chain) { return AG_IDENT[chain] || AG_IDENT_UNKNOWN; }

/* Age of a client-held payload, in seconds. */
function agHeld(entry) {
  // Age of the DATA, never of the last attempt. See the dAt/at split in
  // loadXVenue: a failed refresh moves `at` and must not move this. Since
  // srvStamp() landed, dAt is the payload's own BUILD time where the server
  // supplied one, so this age now contains the server's cache hold as well as
  // the hold in this tab — the two halves that were previously one visible
  // and one not.
  const t = entry && (entry.dAt || (entry.d ? null : entry.at));
  return t ? Math.max(0, (Date.now() - t) / 1000) : null;
}

/* WHICH clock this entry's age is counted from. An age whose basis is receipt
   understates by the server's cache hold — bounded, but real — so the number
   is never shown without a way to read what it is an age OF. */
function agHeldWhy(entry) {
  if (!entry || !entry.dAt) return "no payload has landed for this yet";
  return entry.dSrv
    ? "counted from the moment the SERVER built this payload (it re-serves " +
      "that same payload for up to 60s, and that hold is inside this number)"
    : "counted from when this payload reached this tab — it carried no usable " +
      "build stamp, so the server's cache hold of up to 60s is NOT inside " +
      "this number and the true age is larger";
}

/* ── BLOCK 2 · the charted instrument, venue by venue ──────────────── */
/* THE PRICE VERDICT, READ OFF THE ROW INSTEAD OF ASSUMED FROM ITS EXISTENCE.

   cross_venue._px_verdict is a THREE-state verifier — verified / unchecked /
   disagrees (a refuted row never reaches `rows`; it goes to `split`) — and
   xvenue carries the verdict onto every row as `px_verified` plus a written
   `px_note`. BOTH render sites ignored BOTH fields and hardcoded "price
   agrees within Nbps" for any row that carried a px_diff_bps at all, so the
   further apart the two prices were, the more emphatic the false claim.

   MEASURED LIVE 2026-08-19 on xyz:TSLA: the mkts row shipped
   px_verified="disagrees", px_diff_bps=1507.9 and a px_note saying in as many
   words that the gap is unexplained — and the tooltip over it read "price
   agrees within 1507.9bps". That is the house invariant inverted in its worst
   direction: not a missing value rendered as a fact, but a MEASURED NEGATIVE
   rendered as its own opposite, on the pane a reader uses to decide whether a
   second book exists to size against.

   A payload too old to carry a verdict gets the neutral wording. "Agrees" is
   the one sentence that cannot be written without the verdict that says so. */
function pxMatchTxt(r) {
  if (!r || r.home) return "";
  const d = r.px_diff_bps, v = r.px_verified;
  if (v === "verified")
    return "price agrees within " + d + "bps (price VERIFIES the ticker " +
      "match, it never makes one)";
  // The server's own sentence, VERBATIM where it exists — it already names
  // the gap, the tolerance and the reason, and re-stating any of that in
  // front of it produced "PRICE DISAGREES by 1507.9bps — price DISAGREES by
  // 1508 bps, …". A written verdict is not a value to be re-decorated.
  if (v === "disagrees")
    return r.px_note || ("PRICE DISAGREES by " + d + "bps, past the verify " +
      "tolerance. NOT refuted — a gap this size is a fact about a price, not " +
      "about identity, so this listing still counts as a second book.");
  if (v === "unchecked")
    return r.px_note || ("price NOT VERIFIED — one side publishes no price " +
      "in the venue snapshot, so the identity check never ran on this row. " +
      "Neither confirmed nor refuted.");
  return d != null
    ? "prices differ by " + d + "bps — this payload carries no verification " +
      "verdict, so the match is neither confirmed nor refuted here"
    : "";
}

/* One-word chip for the same verdict, for the places that have room to SHOW
   it rather than hide it in a title. A verified row gets nothing: the default
   must be quiet, and only the two states a reader would act on are drawn. */
function pxMatchChip(r, cls) {
  const v = r && !r.home ? r.px_verified : null;
  if (v !== "disagrees" && v !== "unchecked") return "";
  return '<span class="' + cls + (v === "unchecked" ? " unk" : "") +
    '" title="' + esc(pxMatchTxt(r)) + '">' +
    (v === "disagrees" ? "PX\u2260" : "PX?") + '</span>';
}

function xvBoardHtml(coin) {
  const out = [];
  const xv = state.xv[coin];
  // Named by BASE ticker because that is what the rows are grouped by — but
  // when the charted symbol is not the base (hyna:ETH), say which one is
  // charted, or the ◂ marker is the only clue and it is 6px wide.
  const head = (right) =>
    '<div class="ag-h">THIS INSTRUMENT — <b>' + esc(baseSym(coin)) +
    '</b> ACROSS VENUES' + (coin === baseSym(coin) ? '' :
      '<span class="ag-k">charted ' + esc(coin) + '</span>') +
    '<span class="ag-age" title="' + esc(agHeldWhy(xv)) + '">' + right +
    '</span></div>';
  if (!xv || (!xv.d && !xv.err))
    return head("loading") + '<div class="ag-note">loading the ' +
      esc(coin) + ' book comparison…</div>';
  if (!xv.d)
    return head("FAILED") + '<div class="ag-bad">could not load — <b>' +
      esc(xv.err || "no payload") + '</b></div>';
  const d = xv.d;
  const heldS = agHeld(xv);
  if (d.warming)
    return head(fmtAge(heldS)) + '<div class="ag-note">' +
      esc(d.note || "venue snapshot warming — retrying…") + '</div>';
  const rows = d.rows || [];
  // Book age is the payload's age PLUS the snapshot age it was built on —
  // the volume/OI columns are that old even when the books are not.
  out.push(head('BOOKS ' + fmtAge(heldS) + ' · SNAP ' +
    fmtAge((d.snap_age_s || 0) + (heldS || 0))));
  if (xv.err)
    out.push('<div class="ag-bad">refresh FAILING — <b>' + esc(xv.err) +
      '</b> · rows below are the payload from ' + fmtAge(heldS) + ' ago</div>');
  if (!rows.length)
    return out.join("") + '<div class="ag-note">' +
      esc(d.note || "no listings found for this instrument") + '</div>';

  const cheap = (d.cheapest || {});
  const totVol = rows.reduce((a, r) => a + (r.vol_24h || 0), 0);
  for (const r of rows) {
    const bk = r.book || {};
    const b25 = (bk.bands || []).find((x) => x.bps === 25) || {};
    const b50 = (bk.bands || []).find((x) => x.bps === 50) || {};
    // The server already computes this row's share of the instrument's
    // cross-venue volume; re-deriving it would be a second, divergent
    // definition of the same word. Local sum only as a fallback.
    const sh = r.share_pct != null ? r.share_pct
      : (totVol ? (r.vol_24h || 0) / totVol * 100 : null);
    const bits = [];
    // mid: the measured book first. A snapshot price is DATED and says so
    // with a star — it can be snap_age + held seconds old.
    if (bk.mid != null)
      bits.push('<span class="ag-k">mid</span>' + fmtPx(bk.mid));
    else
      bits.push('<span class="ag-k">mid</span><span class="ag-dim" title="' +
        esc("snapshot price, not a live book — the venues snapshot is ~" +
          Math.round((d.snap_age_s || 0) + (heldS || 0)) + "s old · " +
          (bk.err ? "book fetch failed: " + bk.err
                  : bk.note || "no live book fetched")) + '">' +
        (r.px_snap != null ? fmtPx(r.px_snap) + "*" : "not measured") +
        '</span>');
    if (bk.spread_bps != null)
      bits.push('<span class="ag-k">spr</span>' + (bk.spread_bps * 10).toFixed(2) +
        'bp');
    else
      bits.push('<span class="ag-k">spr</span><span class="ag-dim" title="' +
        esc(bk.err || bk.note || "no measured book") + '">n/m</span>');
    if (b25.bid_usd != null && b25.ask_usd != null)
      bits.push('<span class="ag-k" title="resting notional within ±25bps ' +
        'of mid — CANCELLABLE size, shown not committed' +
        (b50.bid_usd != null ? ' · ±50bps $' + fmtBig(b50.bid_usd) + '/$' +
          fmtBig(b50.ask_usd) : b50.unresolved ? ' · ±50bps: ' +
          esc(b50.unresolved) : '') + '">±25b</span>$' +
        fmtBig(b25.bid_usd) + '/$' + fmtBig(b25.ask_usd));
    else
      // never an empty cell: on Lighter majors this is a 250-order REST cap,
      // not an empty book, and the two must not look alike
      bits.push('<span class="ag-k">±25b</span><span class="ag-amb" title="' +
        esc(b25.unresolved || bk.err || bk.note || "band unresolved") +
        '">not measured</span>');
    bits.push('<span class="ag-k">vol</span>$' + fmtBig(r.vol_24h));
    if (r.oi_usd != null)
      bits.push('<span class="ag-k" title="' + esc((r.oi_src || "") +
        " — per-venue; never summed with another venue's OI") +
        '">OI</span>$' + fmtBig(r.oi_usd));
    else
      bits.push('<span class="ag-k">OI</span><span class="ag-amb" title="' +
        esc(r.oi_note || "open interest not published for this listing — " +
          "unknown, not zero") + '">n/p</span>');
    const f8 = r.funding_1h != null ? r.funding_1h * 8 * 100 : null;
    if (f8 != null)
      bits.push('<span class="ag-k" title="' + esc((r.funding_src || "") +
        " · positive = longs pay") + '">f/8h</span><span class="' +
        fundingClass(f8) + '">' + (f8 >= 0 ? "+" : "") + f8.toFixed(4) +
        '%</span>');
    else
      bits.push('<span class="ag-k">f/8h</span><span class="ag-dim">n/m</span>');

    out.push('<div class="ag-row">' +
      '<div class="ag-l1"><span class="ag-v">' + esc(r.venue) + '</span>' +
      (r.home ? '<span class="ag-home" title="the venue being charted">◂' +
        '</span>' : '') +
      '<span class="ag-sym" title="' + esc(r.sym_native || r.sym) +
      (pxMatchTxt(r) ? ' · ' + pxMatchTxt(r) : '') +
      '">' + esc(r.sym) + '</span>' + pxMatchChip(r, "ag-pxq") +
      (r.off_hours ? '<span class="ag-off" title="this market is outside ' +
        'its scheduled session — a wide, thin book here is the schedule, ' +
        'not the venue">OFF-HOURS</span>' : '') +
      (cheap.venue === r.venue ? '<span class="ag-cheap" title="' +
        esc(cheap.why || "") + '">CHEAPEST</span>' : '') +
      '<span class="ag-bar" title="' + fmtShare(sh) + ' of this instrument' +
      "'" + 's cross-venue volume"><i style="width:' +
      Math.min(100, sh || 0).toFixed(1) + '%"></i></span>' +
      '<span class="ag-share">' + fmtShare(sh) + '</span></div>' +
      '<div class="ag-l2">' + bits.join(' <span class="ag-sep">·</span> ') +
      '</div></div>');
  }
  if (cheap.venue)
    out.push('<div class="ag-note">cheapest to trade: <b>' +
      esc(cheap.venue) + '</b> — ' + esc(cheap.why || "") +
      ' · a description of the books, not a routing instruction</div>');
  else if (rows.length > 1 && cheap.why)
    out.push('<div class="ag-note">no cheapest venue claimed — ' +
      esc(cheap.why) + '</div>');
  // Both fields arrive as LISTS of venue names (measured: {"no_book":
  // ["mkts"]}). esc() on an array prints "a,b" — join them so two excluded
  // venues do not read as one venue with a comma in its name.
  const names = (x) => Array.isArray(x) ? x.join(", ") : String(x);
  if (cheap.no_book && (!Array.isArray(cheap.no_book) || cheap.no_book.length))
    out.push('<div class="ag-amber">excluded from the ranking, book not ' +
      'fetched: ' + esc(names(cheap.no_book)) +
      ' — UNKNOWN here, not worse</div>');
  if (cheap.off_hours_excluded &&
      (!Array.isArray(cheap.off_hours_excluded) ||
       cheap.off_hours_excluded.length))
    out.push('<div class="ag-amber">excluded from the ranking, outside its ' +
      'scheduled session: ' + esc(names(cheap.off_hours_excluded)) +
      ' — a wide book off-hours is the schedule, not the venue</div>');
  if (d.only) out.push('<div class="ag-note">' + esc(d.only) + '</div>');
  // The listings that exist and did not get a slot, as a ROSTER rather
  // than a sentence. MEASURED 2026-08-15: on SOL the omission was
  // Extended's genuine SOL-USD ($7.4M/24h, $8.2M OI) displaced by Aster's
  // own tiny SOLUSD1 — a whole VENUE missing from the board that answers
  // "where else can I trade this". A count ("2 smaller listings") could not
  // say that, and "smaller" was not even true. The server now names each
  // omission with its volume and WHY it lost its slot, largest first; a
  // venue-level absence and a same-venue demotion are different facts and
  // are legible as different rows in a list in a way they are not inside
  // one long sentence.
  if ((d.others_hidden || []).length) {
    out.push('<div class="ag-note">NOT SHOWN — <b>' + d.others_hidden.length +
      '</b> further listing(s) exist on venues this board did not have room ' +
      'for. ' + esc(d.others_rule || OTHERS_RULE_FALLBACK) + '</div>');
    for (const hd of d.others_hidden)
      out.push('<div class="ag-hid"><div class="ag-l1">' +
        '<span class="ag-v">' + esc(hd.venue) + '</span>' +
        '<span class="ag-sym">' + esc(hd.sym) + '</span>' +
        '<span class="ag-hvol">$' + fmtBig(hd.vol) + '/24h' +
        // esc() around fmtShare: its measured-tiny rung is the literal
        // string "<0.1%", and a bare "<" in an HTML string is a tag the
        // browser has to guess about.
        (hd.share_pct != null ? ' · ' + esc(fmtShare(hd.share_pct)) : '') +
        '</span></div><div class="ag-why">' + esc(hd.why || "") +
        '</div></div>');
  } else if (d.others_note) {
    out.push('<div class="ag-note">' + esc(d.others_note) + '</div>');
  }
  if (d.fanout_note) out.push('<div class="ag-note">' + esc(d.fanout_note) +
    '</div>');
  for (const sp of d.split || [])
    // HIP-3 symbols already carry their venue prefix (hyna:GOLD), so
    // venue + ":" + sym printed "hyna:hyna:GOLD" — measured live on
    // xyz:GOLD. Prefix only when the symbol does not name its own venue.
    out.push('<div class="ag-amber">same ticker, DIFFERENT asset: ' +
      esc(String(sp.sym).includes(":") ? sp.sym : sp.venue + ":" + sp.sym) +
      ' price differs ' + sp.px_diff_bps +
      'bps — excluded from the comparison</div>');
  for (const f of d.failed || [])
    out.push('<div class="ag-bad"><b>' + esc(f.venue) + ' ' +
      esc(f.what || "fetch") + ' FAILED</b> — ' +
      esc(f.impact || f.error || "") + '</div>');
  return out.join("");
}

/* ── BLOCK 3 · who is behind those books ───────────────────────────────
   Three states, three colours, never collapsed into one column of blanks.
   A venue that publishes nothing must not look like a venue nobody asked,
   and neither may look like a venue with no whales in it. */
function whoBoardHtml(coin) {
  const out = [];
  const xv = state.xv[coin];
  const xp = state.xp[coin];
  const rows = ((xv && xv.d && xv.d.rows) || []);
  const pByVenue = {};
  for (const p of ((xp && xp.d && xp.d.rows) || [])) pByVenue[p.venue] = p;
  const pFail = {};
  for (const f of ((xp && xp.d && xp.d.failed) || [])) pFail[f.venue] = f;
  // The whole ENDPOINT is warming — global, transient, and nothing to do
  // with any one venue's coverage. MEASURED 2026-08-15: with no branch for
  // it, all four rows fell through to "no tape row returned for this venue
  // — not measured, not empty", printing a whole-endpoint condition four
  // times as if it were a per-venue property, while the header stamped a
  // fresh age ("TAPE 0S") on a payload holding no measurement at all. The
  // server now distinguishes the two for us: rows is NULL rather than []
  // (which would mean measured-and-empty), measured is false, and the note
  // is written in this endpoint's own terms.
  const xpWarm = !!(xp && xp.d && xp.d.warming);
  const ageBits = [];
  if (xpWarm) ageBits.push('TAPE not measured');
  else if (xp && xp.d) ageBits.push('TAPE ' + fmtAge(agHeld(xp)));
  else if (xp && xp.err) ageBits.push('TAPE FAILED');
  else ageBits.push('TAPE loading');
  out.push('<div class="ag-h">WHO IS BEHIND THE BOOKS<span class="ag-age" ' +
    'title="' + esc(agHeldWhy(xp)) + '">' + ageBits.join(' · ') +
    '</span></div>');
  if (!rows.length)
    return out.join("") + '<div class="ag-note">no venue rows yet for ' +
      esc(coin) + ' — this block follows the instrument block above</div>';
  if (xp && xp.err)
    out.push('<div class="ag-bad">print-size refresh FAILING — <b>' +
      esc(xp.err) + '</b>' + (xp.d ? ' · tape figures below are ' +
      fmtAge(agHeld(xp)) + ' old' : '') + '</div>');
  // Said ONCE, for the block, in the server's own words.
  if (xpWarm)
    out.push('<div class="ag-amb" style="padding:2px 6px 3px">' +
      esc(xp.d.note || "print sizes are not measured yet — warming now, " +
        "retrying shortly. This is not a measurement of zero.") + '</div>');

  for (const r of rows) {
    const id = agIdent(r.chain);
    const pr = pByVenue[r.venue] || null;
    const st = (pr && pr.stats) || null;
    const lines = [];
    let cls = id.st, chip = id.chip, chipTitle = id.why;

    if (id.st === "named") {
      const w = whFor(r.sym);
      const wd = w && w.d;
      const cov = (wd && wd.coverage) || {};
      if (!w) {
        chip = "NOT QUERIED"; cls = "unswept";
        chipTitle = "the whale sweep has not been asked about " + r.sym +
          " yet — unknown, not empty";
        lines.push('<span class="ag-dim">whale detail not fetched for ' +
          esc(r.sym) + ' yet</span>');
      } else if (wd && wd.n_positions == null) {
        // The sweep never queried this venue. NOT zero positions.
        chip = "NOT COVERED"; cls = "unswept";
        chipTitle = cov.why || "this venue has not been swept";
        lines.push('<span class="ag-amb">' + esc(cov.why ||
          ("no whale sweep has reported on " + r.sym + " yet")) + '</span>');
      } else if (!wd) {
        // Asked and got nothing back. NOT "no whales" — say which it is.
        chip = "SWEEP FETCH FAILED"; cls = "unknown";
        chipTitle = "the whale detail for " + r.sym + " could not be read";
        lines.push('<span class="ag-amb">whale detail unavailable — ' +
          esc((w && w.err) || "no payload") +
          ' · this is a read failure, not an empty book</span>');
      } else {
        const L = wd.long_ntl || 0, S = wd.short_ntl || 0;
        const tot = L + S;
        lines.push('<span class="up">LONG $' + fmtBig(L) + '</span>' +
          ' <span class="ag-sep">·</span> <span class="dn">SHORT $' +
          fmtBig(S) + '</span> <span class="ag-sep">·</span> ' +
          (tot ? (L / tot * 100).toFixed(0) + '% long' : 'flat') +
          ' <span class="ag-sep">·</span> ' + wd.n_positions + ' pos');
        // "tracked wallets", never "the market". NOTE what wallets_holding
        // actually counts: whales._venue_stats increments it for a wallet
        // holding ANY position on that DEX, not a position in this coin.
        // Labelling it "hold BTC" invented a per-coin count the sweep never
        // measured; the per-coin number is n_positions, one line above.
        const covBits = [];
        if (cov.wallets_holding != null && cov.wallets_tracked != null)
          covBits.push(cov.wallets_holding + ' of ' + cov.wallets_tracked +
            ' tracked wallets hold a position on ' +
            (cov.venue || r.venue) + ' (any coin)');
        if (cov.last_sweep_at)
          covBits.push('swept ' + fmtAge(Math.max(0,
            Date.now() / 1000 - cov.last_sweep_at)) + ' ago');
        if (covBits.length)
          lines.push('<span class="ag-dim">' + esc(covBits.join(' · ')) +
            '</span>');
        // The server's own sentence for an incomplete sweep, verbatim: it
        // states the LOWER BOUND better than a re-derivation would.
        if (!cov.complete && cov.why)
          lines.push('<span class="ag-amb">' + esc(cov.why) + '</span>');
        const tops = (wd.positions || []).slice(0, 2).map((p) =>
          '<span class="' + (p.side === "long" ? "up" : "dn") + '">' +
          esc(p.label || "") + ' ' + esc(p.side) + ' $' + fmtBig(p.ntl) +
          '</span>').join(' <span class="ag-sep">·</span> ');
        if (tops) lines.push(tops);
      }
    }

    // The anonymous half. Present on EVERY row that has a tape, including
    // the named ones: a print distribution and a position roster are two
    // different measurements of the same book, and the named venues have
    // the WORST tape sample here (HL serves exactly 10 prints).
    if (st) {
      // Quantile label. NOT String(q*100) with trailing zeros stripped:
      // that turned 0.90 into "p9", rendering a p90 tail as the ninth
      // percentile — a different claim, not a rounder one. toFixed(1) then
      // unary + drops the ".0" without touching the digits that matter.
      const q = st.tail_q != null
        ? 'p' + (+(st.tail_q * 100).toFixed(1)) + ' $' + fmtBig(st.tail_usd)
        : '<span class="ag-amb" title="' + esc(st.tail_note || "") +
          '">unsupported at n=' + st.n + '</span>';
      lines.push('<span class="ag-k" title="the ANONYMOUS tape measurement — ' +
        'a print distribution and a position roster are two different ' +
        'measurements of the same book">tape</span>' + st.n + ' prints' +
        ' <span class="ag-sep">·</span> <span class="ag-k">med</span>$' +
        fmtBig(st.median_usd) + ' <span class="ag-sep">·</span> ' +
        '<span class="ag-k" title="' + esc(st.tail_note || "") + '">tail' +
        '</span>' + q + ' <span class="ag-sep">·</span> <span class="ag-k">' +
        'max</span>$' + fmtBig(st.max_usd) +
        (st.window_s != null ? ' <span class="ag-sep">·</span> ' +
          '<span class="ag-k" title="the window those prints span — the same ' +
          'count means very different things over 20s and over 40h">over' +
          '</span>' + fmtAge(st.window_s) : ''));
    } else if (pFail[r.venue]) {
      lines.push('<span class="ag-amb">tape FAILED — ' +
        esc(pFail[r.venue].impact || pFail[r.venue].error || "") + '</span>');
    } else if (pr && pr.note) {
      lines.push('<span class="ag-amb">' + esc(pr.note) + '</span>');
    } else if (xpWarm) {
      // Deliberately NO per-row line. The reason this row has no tape is
      // global and already stated once above; repeating it here is what
      // turned a transient endpoint state into four per-venue coverage
      // claims. An absent line under a stated global cause is honest; a
      // per-venue sentence about a global cause is not.
      void 0;
    } else if (xp && xp.d) {
      /* RE-AUDITED 2026-08-16 and left alone. This line was seen on four
         venues at once and read as a defect; it is not. It is self-labelled
         not-measured (never "empty"), the warming branch above already owns
         the whole-endpoint case, and the residual is consistent with the
         known 60-90s post-restart window in which the upstream answers 429.
         Watch-list only — if it is ever seen persisting well past that
         window on a venue the endpoint claims to cover, THAT is the defect,
         and it is a server-side coverage question, not this string. */
      lines.push('<span class="ag-dim">no tape row returned for this ' +
        'venue — not measured, not empty</span>');
    } else {
      lines.push('<span class="ag-dim">print distribution loading…</span>');
    }

    out.push('<div class="ag-who ag-' + cls + '">' +
      '<div class="ag-l1"><span class="ag-v">' + esc(r.venue) + '</span>' +
      '<span class="ag-sym">' + esc(r.sym) + '</span>' +
      '<span class="ag-chip ag-c-' + cls + '" title="' + esc(chipTitle) +
      '">' + esc(chip) + '</span></div>' +
      lines.map((l) => '<div class="ag-l2">' + l + '</div>').join("") +
      '<div class="ag-why">' + esc(id.why) + '</div></div>');
  }
  out.push('<div class="ag-note">NAMED and ANONYMOUS are different kinds of ' +
    'measurement, not different amounts of it — a venue with no account ' +
    'data is not a venue with no whales, and the tracked roster on the ' +
    'named venues is a sample of its venue, never all of it.</div>');
  return out.join("");
}

/* Caveats the SERVER states, rendered rather than re-derived — resting depth
   is cancellable, this terminal routes nothing, OI is per-venue. Deduped
   across the three payloads because the three modules deliberately repeat
   the load-bearing ones. */
function aggCaveatsHtml(coin) {
  const seen = new Set();
  const items = [];
  const take = (arr, src) => {
    for (const c of arr || []) {
      const k = String(c).slice(0, 48).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({ c: String(c), src });
    }
  };
  take((state.venues || {}).caveats, "venues");
  const xv = state.xv[coin], xp = state.xp[coin];
  take((xv && xv.d || {}).caveats, "books");
  take((xp && xp.d || {}).caveats, "prints");
  if (!items.length) return "";
  return '<div class="ag-h">WHAT THESE NUMBERS DO NOT SAY</div>' +
    items.map((i) => '<div class="ag-cav"><span class="ag-csrc">' +
      esc(i.src) + '</span>' + esc(i.c) + '</div>').join("");
}

/* Three OI states, never two. A venue that publishes a venue-wide figure, a
   venue measured on a SUBSET of its own book, and a venue whose OI is not
   published at all are three different claims — and only the first is a
   venue total. The server distinguishes them (oi_partial, oi_coverage_pct,
   oi_markets_measured/total, and a named oi_incomplete[]); this renders that
   distinction rather than flattening every null into "OI NOT PUBLISHED",
   which told the reader that Aster publishes no open interest when in fact
   it publishes it per symbol and its background census had not landed yet.
   A subset figure must never sit beside a complete one wearing the same
   face: it is a LOWER BOUND with a coverage percentage and an age. */
function oiStateFor(v, incMap) {
  const inc = incMap[v.venue] || null;
  // The last-resort `why`. It used to assert "not published by this
  // venue", which is precisely the claim this function must never
  // manufacture: when neither the venue record nor oi_incomplete stated a
  // reason, the reason is UNKNOWN — in both directions.
  const why = v.oi_note || (inc && inc.why) ||
    "no reason for the missing figure was declared — unknown, not a " +
    "measured zero and not a venue known to withhold it";
  if (v.oi_usd == null) {
    // A venue that measures OI per symbol (Aster) and has simply not
    // finished is NOT a venue that publishes none (Lighter). Both are
    // "unknown"; they are unknown for different reasons and the reader
    // needs to know which one can be waited out.
    // MEASURED 2026-08-15: the heuristic that stood here was
    // `v.oi_markets_total != null && !v.oi_censuses`, and it inverted one
    // case exactly one branch over — a PUBLISHING venue whose census had
    // COMPLETED but produced nothing (oi_censuses > 0, oi_usd still null;
    // the server's "measurement failed") fell through to "OI NOT
    // PUBLISHED", labelling a covered venue uncovered. That is the same
    // inversion this function was written to remove, one step further in.
    // So it is no longer derived here at all: venues.py now has every
    // adapter DECLARE `oi_publishes` and maps that declaration to one of
    // four named states (_oi_missing_state), carried on every venue record
    // and every oi_incomplete entry. Four states, none guessed — and a
    // venue whose adapter declared nothing says so rather than being
    // assigned to either side.
    const pub = v.oi_publishes;
    const st = (inc && inc.state) || null;
    const label = pub === false ? "OI NOT PUBLISHED"
      : pub === true ? (st === "measurement failed" ? "OI MEASUREMENT FAILED"
                                                    : "OI NOT YET MEASURED")
      : "OI COVERAGE UNDECLARED";
    return { kind: "missing", why, publishes: pub == null ? null : pub,
             state: st, label,
             // An undeclared venue is the one case where the label alone is
             // not enough — it names an absence of information, so the
             // server's sentence about that absence rides along on the row
             // rather than only in the hover title.
             sub: pub == null ? why : null };
  }
  const cov = v.oi_coverage_pct;
  const partial = v.oi_partial === true || (cov != null && cov < 99.95) ||
    (v.oi_markets_measured != null && v.oi_markets_total != null &&
     v.oi_markets_measured < v.oi_markets_total);
  if (partial) {
    const bits = [];
    if (v.oi_markets_measured != null && v.oi_markets_total != null)
      bits.push(v.oi_markets_measured + " of " + v.oi_markets_total +
        " markets measured");
    if (cov != null) bits.push(cov.toFixed(1) + "% of venue OI");
    if (v.oi_age_s != null) bits.push("measured " + fmtAge(v.oi_age_s) +
      " ago");
    return { kind: "subset", label: "OI $" + fmtBig(v.oi_usd) + " SUBSET",
             sub: bits.join(" · "), why };
  }
  return { kind: "full", label: "OI $" + fmtBig(v.oi_usd),
           sub: v.oi_age_s != null ? "measured " + fmtAge(v.oi_age_s) + " ago"
                                   : null,
           why: v.oi_note || (v.oi_method || "") };
}

function renderVenuesTab() {
  $("whead").innerHTML = "";
  $("watch-meta").textContent = "AGGREGATOR · MKT + INSTRUMENT + WHO";
  const d = state.venues;
  const coin = state.sel;
  // Blocks 2 and 3 are keyed to the CHARTED coin, not to this tab, and both
  // loaders are TTL-guarded against the server's own cache — so the 20s
  // universe repaint that lands here costs nothing upstream.
  if (coin) { loadXVenue(coin); loadXPrints(coin); }
  for (const r of ((state.xv[coin] || {}).d || {}).rows || [])
    if (r.chain === "hyperliquid") loadWhaleSym(r.sym);
  if (!d) {
    $("wbody").innerHTML = '<tr><td class="empty">' + (state.venuesErr
      ? 'venue snapshot failed — ' + esc(state.venuesErr)
      : 'loading venue snapshot…') + '</td></tr>';
    return;
  }
  const t = d.totals || {};
  const vol = t.vol_24h || 0;
  const out = [];
  if (state.venuesErr)
    out.push('<div class="sc-warn">last refresh failed — <b>' +
      esc(state.venuesErr) + '</b> · showing the snapshot from ' +
      fmtAge(venueAgeS()) + ' ago</div>');
  out.push('<div class="ag-h">MARKET — EVERY COVERED VENUE' +
    '<span class="ag-age">SNAP ' + fmtAge(venueAgeS()) + '</span></div>');
  out.push('<div class="vn-head"><b>$' + fmtBig(vol) + '</b> 24H VOL · <b>' +
    (t.markets_live != null ? t.markets_live : "–") + '</b> LIVE MKTS · <b>' +
    (t.venues_live || 0) + '</b> LIVE / ' + (t.venues_dormant || 0) +
    ' DORMANT / ' + (t.venues_failed
      ? '<b class="vn-bad">' + t.venues_failed + ' FAILED</b>'
      : '0 FAILED') + '</div>');
  // OI headline: the sum is shown because the server computes it, but never
  // alone — how many venues are behind it, and who is missing from it, are
  // part of the number.
  const incMap = {};
  for (const i of d.oi_incomplete || []) incMap[i.venue] = i;
  // ONE derivation, used by the headline, the per-venue rows and the
  // named-and-why banner below — counted separately, they drift.
  // HISTORY, corrected server-side 2026-08-15: the server used to bucket
  // Aster's unfinished census under "not published" while this row called
  // it NOT YET MEASURED — two contradictory claims about one venue on one
  // screen. venues.py now declares coverage per venue and names four
  // distinct reasons, and oiStateFor reads that declaration instead of
  // re-deriving it, so the divergence is closed at the source. The note
  // stays to record that it is closed, not that it is open.
  const oiSt = new Map();
  for (const v of d.venues || []) oiSt.set(v.venue, oiStateFor(v, incMap));
  const oiTally = { full: 0, subset: 0, pending: 0, failed: 0, nopub: 0,
                    undecl: 0 };
  for (const st of oiSt.values())
    // Keyed on the SERVER'S DECLARATION (`oi_publishes`, and oi_incomplete's
    // `state`), never on the label string this file just built. Matching
    // display text silently rebuckets every venue the next time a label is
    // reworded, and the headline and the rows then disagree — which is the
    // exact drift the single `oiSt` derivation above exists to prevent.
    oiTally[st.kind !== "missing"
      ? (st.kind === "subset" ? "subset" : "full")
      : st.publishes === false ? "nopub"
      : st.publishes !== true ? "undecl"
      : st.state === "measurement failed" ? "failed" : "pending"]++;
  const oiParts = [];
  if (oiTally.full) oiParts.push(oiTally.full + ' complete');
  if (oiTally.subset) oiParts.push(oiTally.subset + ' SUBSET only');
  if (oiTally.pending) oiParts.push(oiTally.pending + ' not yet measured');
  // A publishing venue whose measurement FAILED and a venue that publishes
  // nothing are counted apart: one can be waited out, the other cannot.
  if (oiTally.failed) oiParts.push(oiTally.failed + ' measurement FAILED');
  if (oiTally.nopub) oiParts.push(oiTally.nopub + ' not published');
  if (oiTally.undecl) oiParts.push(oiTally.undecl + ' coverage UNDECLARED');
  out.push('<div class="vn-oi" title="' + esc(OI_CAVEAT) + '">GROSS OI <b>$' +
    fmtBig(t.oi_usd_gross) + '</b> across ' + (t.oi_venues_reporting || 0) +
    ' of ' + (t.oi_venues_total || 0) + ' venues' +
    (oiParts.length ? ' (' + oiParts.join(' · ') + ')' : '') +
    ' — NOT additive, hedges double-count; a LOWER BOUND while any venue ' +
    'is short</div>');
  for (const i of d.oi_incomplete || []) {
    const st = oiSt.get(i.venue);
    out.push('<div class="vn-oimiss"><b>' + esc(i.venue) + '</b> ' +
      esc(st ? st.label.replace(/^OI /, "")
             : String(i.state || "").toUpperCase()) +
      ' — ' + esc(i.why) + '</div>');
  }
  // THE headline fact of this board, stated only while measured true.
  const core = (d.venues || []).find((v) => v.kind === "core");
  const top = (d.venues || [])[0];
  if (core && top && top !== core && (top.vol_24h || 0) > (core.vol_24h || 0))
    out.push('<div class="vn-fact">' + esc(top.venue.toUpperCase()) +
      ' OUT-TRADES ' + esc(core.venue.toUpperCase()) + ' — $' +
      fmtBig(top.vol_24h) + ' vs $' + fmtBig(core.vol_24h) + ' (' +
      (top.vol_24h / core.vol_24h).toFixed(1) + 'x)</div>');
  for (const v of d.venues || []) {
    const sh = vol ? (v.vol_24h || 0) / vol * 100 : 0;
    const oi = oiSt.get(v.venue) || oiStateFor(v, incMap);
    const oiHtml = '<span class="vn-oi-' + oi.kind + '" title="' +
      esc(oi.why || "") + '">' + esc(oi.label) + '</span>' +
      (oi.sub ? ' <span class="vn-oisub">' + esc(oi.sub) + '</span>' : '');
    const tops = (v.top || []).slice(0, 3).map((m) => {
      const f8 = m.funding != null ? m.funding * 8 * 100 : null;
      // toFixed(4), the watch/FUND convention — at 3 decimals UNITREE's
      // measured 6e-5% printed as "+0.000%", a confident zero it is not.
      return esc(baseSym(m.sym)) + ' $' + fmtBig(m.vol) + (f8 == null ? '' :
        ' <span class="' + fundingClass(f8) + '">' + (f8 >= 0 ? '+' : '') +
        f8.toFixed(4) + '%</span>');
    }).join(' · ');
    out.push('<div class="vn-row">' +
      '<div class="vn-l1">' +
      '<span class="vn-name">' + esc(v.venue) + '</span>' +
      '<span class="vn-kind">' + esc(String(v.kind || "").toUpperCase()) +
      '</span>' +
      '<span class="vn-bar" title="' + fmtShare(sh) +
      ' of measured 24h volume"><i style="width:' +
      Math.min(100, sh).toFixed(1) + '%"></i></span>' +
      '<span class="vn-share">' + fmtShare(sh) + '</span>' +
      '<span class="vn-vol">$' + fmtBig(v.vol_24h) + '</span>' +
      '</div>' +
      '<div class="vn-l2">' + (v.markets != null ? v.markets : "–") +
      ' mkts · ' + oiHtml + (tops ? ' · top ' + tops : '') + '</div>' +
      // The basis lines the server publishes per venue: a volume that is
      // quote-denominated rather than USD, and a funding rate that had to be
      // divided by each market's own interval, are facts ABOUT the numbers
      // on the line above and belong next to them.
      (v.vol_basis ? '<div class="vn-basis">vol: ' + esc(v.vol_basis) +
        '</div>' : '') +
      (v.funding_basis ? '<div class="vn-basis">funding: ' +
        esc(v.funding_basis) + '</div>' : '') +
      (v.excluded_note ? '<div class="vn-basis">' + esc(v.excluded_note) +
        '</div>' : '') +
      (v.cross_listing_note ? '<div class="vn-basis">' +
        esc(v.cross_listing_note) + '</div>' : '') +
      (v.degraded ? '<div class="vn-basis vn-degr">degraded: ' +
        esc(v.degraded) + '</div>' : '') +
      '</div>');
  }
  if ((d.dormant || []).length)
    out.push('<div class="vn-dormant">DORMANT: ' + d.dormant.map((v) =>
      esc(v.venue) + ' (' + (v.markets || 0) + ')').join(' · ') +
      ' — deployed but untraded, not broken</div>');
  for (const f of d.failed || [])
    out.push('<div class="vn-failed"><b>' + esc(f.venue) +
      ' FETCH FAILED</b> — ' + esc(f.error || "") +
      (f.impact ? '<br>' + esc(f.impact) : '') + '</div>');
  out.push('<div class="vn-foot">ranked by 24h volume · volume IS additive ' +
    'across venues, OI is not · funding per 8h on each venue' + "'" +
    's top markets · snapshot ' + fmtAge(venueAgeS()) +
    ' old · /api/venues, server cache 5m, client poll 5m' +
    // Depth is conspicuously absent from this block, and silence would read
    // as an oversight. There is no venue-level depth to publish: depth
    // belongs to ONE book at ONE instant, so it is measured per instrument
    // in the block below and nowhere else.
    '<br>no depth column here on purpose — depth is not a venue-level ' +
    'quantity. It belongs to one book at one instant, so it is measured ' +
    'per instrument in the next block' + (state.sel
      ? ' (charted: ' + esc(state.sel) + ')' : '') + '</div>');
  // Block 2 and 3: the charted instrument, and who is behind those books.
  if (coin) {
    out.push(xvBoardHtml(coin));
    out.push(whoBoardHtml(coin));
    out.push(aggCaveatsHtml(coin));
  }
  // Dated survey section, appended AFTER the live blocks so the boundary
  // between live and surveyed is unmissable. Empty string when the server
  // has no survey file — no section beats an empty market.
  out.push(landscapeHtml(d.landscape));
  $("wbody").innerHTML = '<tr><td colspan="7" style="white-space:normal;' +
    'overflow:visible;max-width:none"><div class="venues-pane">' +
    out.join("") + '</div></td></tr>';
}

// The strip is a doorway, not just a readout — same deal as the tape rows.
$("venuebar").addEventListener("click", () => {
  const b = document.querySelector('#wtabs button[data-t="venues"]');
  if (b) b.click();
});
loadVenues();
setInterval(loadVenues, VENUES_POLL_MS);
// Between polls only the AGE moves; repaint so "2M OLD" never goes stale.
setInterval(() => {
  renderVenueStrip();
  if (state.wtab === "venues") renderVenuesTab();
}, 60000);

/* ---------------- ticker tape ---------------- */
function renderTape() {
  const parts = [];
  const all = [...state.watchCrypto.map((c) => [c, state.universe.crypto[c]]),
               ...state.watchEquity.map((c) => [c, state.universe.equity[c]])];
  for (const [coin, ctx] of all) {
    const mid = state.mids[coin] != null ? state.mids[coin] : (ctx && ctx.mid_px);
    const chg = pct(mid, ctx && ctx.prev_day_px);
    parts.push(`<span class="tk" data-coin="${esc(coin)}" title="open ${esc(coin)} chart">` +
      `<span class="s">${esc(baseSym(coin))}</span>` +
      `<span class="p">${fmtPx(mid)}</span>` +
      `<span class="${chg == null ? "" : chg >= 0 ? "up" : "dn"}">` +
      `${chg == null ? "" : (chg >= 0 ? "▲" : "▼") + Math.abs(chg).toFixed(2) + "%"}</span></span>`);
  }
  $("tape-inner").innerHTML = parts.join("") + parts.join("");
}

// The tape was the most visible list of symbols on screen and the only one you
// could not click. Delegated so the duplicated marquee half works too.
$("tape").addEventListener("click", (e) => {
  const el = e.target.closest(".tk");
  if (!el || !el.dataset.coin) return;
  if (exactCoin(el.dataset.coin)) selectCoin(el.dataset.coin);
});

/* ---------------- chart (canvas candlesticks) ---------------- */
function nextEventFor(coin) {
  const base = baseSym(coin);
  const today = etDate(0);
  return state.events.find((e) =>
    e.date >= today && e.expected_move_pct != null &&
    (e.hl_coin === coin || e.symbol === base || e.proxy === base)) || null;
}

const IV_MS = { "1m": 60000, "5m": 300000, "15m": 900000, "30m": 1800000,
                "1h": 3600000, "4h": 14400000, "1d": 86400000 };

/* ── label lanes ────────────────────────────────────────────────────────
   Every instrument that writes a level label into the price pane goes
   through this.

   Measured on the live chart with the full stack on: 43 labels inside a
   590x349 pane, FOUR instruments writing into the same right-edge column
   (price axis at x=596, S/R at 586, book walls at 587, last-price tag at
   595), and the book's own wall labels stacked at y=148, 150 and 151 —
   three labels inside three pixels. The composition problem was never any
   single layer. It was that no layer knew the others existed, so each one
   was individually reasonable and collectively unreadable.

   A lane is an x position + alignment owned by exactly one instrument.
   Within a lane the allocator refuses a slot that collides with one
   already taken, so a label is either legible or absent — never smeared
   on top of another. Priority is draw order: the most important layer
   claims its slots first. */
/* Canvas type scale.

   Measured: 15 of 29 chart labels were 8px and one was 9px. 8px monospace
   is below the size at which a glyph has enough pixels to be read at a
   glance — it is legible in the sense that it can be deciphered, which is
   not the same thing on an instrument you scan rather than read. Two sizes
   only, both above the floor, so the chart has a type hierarchy instead of
   five arbitrary sizes.

   The stack names real monospace faces before the generic: on macOS the
   bare `monospace` keyword resolves to a variable-width fallback in some
   Chrome versions, which is the difference between a column of digits
   lining up and not. */
const CHART_MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const CHART_FONT_S = '10px ' + CHART_MONO;   // annotations, wall labels
const CHART_FONT_M = '11px ' + CHART_MONO;   // axes, level names

/* Whale event value-label geometry. Three numbers, none of them invented
   here — each is a value this pane already commits to somewhere else.

   EV_CLEAR is the 5px of air the event triangle already leaves between the
   datum and its own first ink (moveTo(ex, ey ± 5) in the whale block). The
   label uses the same margin to sit off the candle, so "just clear of" means
   one thing on this pane rather than two.

   EV_LH is the lane allocator's OWN default gap (labelLanes: gap ?? 14).
   Stacking any tighter would place rows the allocator then rejects as
   clashing with each other, so 14 is the tightest stack that can survive its
   own collision test — and two rows exactly 14 apart clear it, because the
   test is `< gap`.

   EV_STACK_MAX bounds the column, and it is 5 rather than 4 because the rows
   are now measured from the CANDLE rather than from the event triangle. Two
   things changed with that. The triangle can hold row 0 — it did for 11 of
   23 labels across ten live views — so the ladder genuinely starts one row
   in whenever the glyph overhangs the bar edge, which is most longs. And the
   old cap was never the promise it looked like: "47px off the bar" was
   measured from the triangle, and the labels it produced sat 59, 80, 94 and
   150px off their bars. Row 4 is 5 + 4x14 = 61px and that is now a true
   ceiling on the distance rather than an aspirational one. Past it the
   block's standing rule applies — a mark that is pinned in x and cannot move
   is DROPPED rather than drawn somewhere it lies. */
const EV_CLEAR = 5, EV_LH = 14, EV_STACK_MAX = 5;

/* Whale event TRIANGLE geometry.

   TRI_W / TRI_H / TRI_GAP are the mark itself: an 8x6 glyph whose near
   edge sits TRI_GAP off the datum (the trade's entry_px). They were three
   literals inside the draw (4, 5, 11) and the label pass re-derived the
   same box from the same literals, which is how the two drifted apart.

   TRI_PITCH is the LOCAL collision step, not a pane-wide rail. Two glyphs
   that would occupy the same pixel — within TRI_BAND in x and TRI_H in y —
   are separated by this much in the outward direction (long down, short
   up). It is TRI_H + 2, the tightest pitch that leaves a visible gap
   between two 6px glyphs. Default Y is y(entry_px); only a colliding pair
   is nudged, so two events at different fill prices do not share a
   scanline just because a global grid said so.

   TRI_BAND is when two glyphs are deemed to share an x-band: 8px of width
   plus 1px of air. Narrower and neighbouring bars' marks touch; wider and
   marks that could have coexisted are pushed apart for nothing.

   TRI_REACH bounds how far a glyph may be displaced from its own price —
   8 steps, i.e. 64px. Past it the mark is DROPPED and counted, because a
   triangle 100px from its entry is not a placement, it is a different
   claim. */
const TRI_W = 8, TRI_H = 6, TRI_GAP = 5, TRI_PITCH = 8, TRI_BAND = 9,
      TRI_REACH = 8;

/* ── canvas palette ─────────────────────────────────────────────────────
   Measured before this: 57 colour literals inside drawChart, of which
   #20d67b appeared at 10 alpha levels and #ff4d5e at 11, plus four rgba()
   families whose alpha was computed per data point to three decimal places.
   That is what produced 362 distinct RENDERED colours from what was never
   362 decisions — it was ~40 marks x an alpha ladder x two backgrounds.

   The rule the tokens encode:

     HUE names the INSTRUMENT FAMILY or a genuine POLARITY.
     FORM (dash, weight, anchor, position) names WHICH instrument.
     A mark whose only channel is hue is a mark that cannot be read by the
     ~6% of men with deuteranopia, and half the marks here were exactly that.

   Two axes that used to share #ff4d5e are now separated by hue, because they
   are not the same question: red-as-DOWN is a direction, CC.alarm is a
   data-integrity failure. A feed dying and a candle falling must not look
   alike.

   THREE alpha rungs and no fourth. Below A_FAINT a green and a red are
   measurably indistinguishable under deuteranopia (dE00 1.6 at 0x22), so
   A_FAINT is never allowed to carry a side. Measured stronger than that:
   EVERY token at A_FAINT composites to under 3:1 against the panel
   (down 1.64, vol 1.85, s2 1.58, s3 2.16), i.e. below the threshold at
   which a line can be read at all. So A_FAINT is chrome ONLY — gridlines,
   scrims, zero/reference rules. A level that means something is A_MID or
   it is not drawn. */
const CC = {
  /* structure — achromatic, brightness = distance from the decision */
  grid:  "#15222a",   // gridlines, sub-pane frames, gutter borders, axis stubs
  s1:    "#3d4a54",   // dormant context ticks, watermark, UTC, box borders
  s2:    "#6e808e",   // axis labels, pane captions, reference lines, S/R
  s3:    "#a8bac6",   // promoted levels, readouts, VWAP, MACD signal
  plan:  "#d8e4ec",   // marks the OWNER authored: ruler ENTRY, crosshair tag

  /* polarity — only marks with a genuine side may use these.

     up is BRIGHTER than down by design, not by accident: hue alone gives
     the pair a deuteranopic dE00 of 10.7, which is why the candles failed
     their own redundancy rule at the zoom this terminal actually runs at
     (140 bars -> 3px bodies, too narrow for the hollow-body channel to
     fire). Lifting the RED collapses the pair — #ff6b78 measures dE00 3.1,
     worse than doing nothing — but lifting the GREEN widens it on every
     axis at once: dE00 10.7 -> 19.4 deut, deuteranopic LUMINANCE ratio
     1.49 -> 2.13, panel contrast 10.0 -> 13.0. So the redundant channel for
     every side-bearing mark on this canvas is brightness, it costs no
     second glyph and no extra ink, and it survives at 3px and at A_MID
     (where the pair measures 15.9, up from 7.6). */
  up:    "#4df09b",   // up / bid / long   — the BRIGHT one
  down:  "#ff4d5e",   // down / ask / short — the DARK one
  live:  "#ff9f0a",   // the live market NOW: the price, and whale money
  alarm: "#f25ab0",   // data-integrity failure, and nothing else

  /* instrument families */
  vol:   "#3aa0ff",   // volume-at-price, POC
  fast:  "#35d0e0",   // EMA20 / EMA50 (weight separates), RSI14, MACD line

  /* opaque plates */
  onLive:  "#000000",     // text on the live-price tag
  veil:    "#00000055",   // "we have no data for this region" scrim
  plate:   "#060b0ee6",
  fpPlate: "#04090cf2",
  xhTag:   "#131c22",
};
const A_MID = "a6";     // 0.65 — may carry a side
const A_FAINT = "59";   // 0.35 — reference and chrome only, never a side

/* Dash alphabet. Two full-width horizontal levels may NEVER share a rhythm;
   a curve and a level may, and a vertical and a horizontal may.
     [3,3]  reference / zero        — achromatic, never coloured
     [4,3]  the live price          — sole owner
     [5,3]  the trade ruler         — sole owner (VWAP vacated it, now solid)
     [7,4]  promoted context level  — S/R (grey) and POC (blue): one idea,
                                      two instruments, separated by hue
     [6,4]  whale LONG cohort       — sole owner (the event band vacated it)
     [2,3]  whale SHORT cohort      — sole owner (the POC vacated it)
     [2,2]  forecast level          — a price that has not traded */
const D_REF = [3, 3], D_LAST = [4, 3], D_RULER = [5, 3],
      D_CTX = [7, 4], D_LONG = [6, 4], D_SHORT = [2, 3], D_FCST = [2, 2];

/* A context level earns the plot when price can REACH it.
   d = |level - last| / ATR14.  Below CTX_HOT it is a full-width bright line;
   between CTX_HOT and CTX_FAR it is a full-width dim line; beyond that it is
   a 4px tick in the dead 5px of price-axis gutter before the labels, which is
   where a price you cannot reach today belongs. Hysteresis so a level parked
   on the threshold does not flip between a 4px tick and a 570px line on every
   tick of the mid. */
/* CTX_FAR was 4. It is 3 to match the measured RELEVANCE cliff on the levels
   this now mostly draws: of the prior-period levels alive at any moment, only
   24.1% are still within 3 ATR of spot 7 days later and 15.1% after 30 — so
   one distance rule retires about three quarters of the ink inside a week,
   which is the aging rule this chart uses INSTEAD of an age rule (edge decay
   by age is flat zero; there is no edge to decay).
   Measured honestly: on today's snapshot of 12 symbols the change is a NO-OP
   — full-width line counts are identical at CTX_FAR 4 and 3 (1h median 2 max
   4, 4h median 4 max 5, 1d median 5 max 6). It is a guard on the far tail,
   not an improvement anyone will see today. */
const CTX_HOT = 1.35, CTX_HOT_OFF = 1.65, CTX_FAR = 3;
/* Backstop behind the ATR rule: price sitting inside a cluster can promote
   everything at once, and 14 full-width lines in a 185px band is the density
   complaint restated. */
const CTX_MAX_WIDE = 6;

/* ── prior-period S/R: the tolerance, and why none of it is painted ──────

   A level is a ZONE, not a price — measured max overshoot past a level is
   p50 0.63 ATR, p70 1.20. The fractal method this replaces used a FIXED
   0.35% for the same job, which is 0.49xATR on xyz:AAPL and 0.09xATR on VVV:
   one number meaning 5.4x different things across one book. So the tolerance
   is expressed in ATR.

   ATR of WHICH series — the DAILY one. Everything about a prior-period level
   is computed on the 1d series, and nothing about it may depend on the
   interval the chart happens to show; that independence IS the feature. A
   tolerance taken from the charted interval's ATR would quietly put the
   level SET back on the viewport, which is the bug being removed.

   AND IT IS NEVER PAINTED. Measured on live data: 2 x 0.6 x daily ATR14
   spans 43.3% of BTC's default 1h/140-bar price range (35.9% on 4h, 117% on
   15m, 906% on 1m; HYPE 57.4% on 1h). The plan permits "at most a 1px dotted
   edge pair" — at these widths that pair is not a zone edge, it is two more
   full-width lines pinned near the top and bottom of the pane, which is the
   exact ink failure (one wash over 53% of the pane accounting for 68.9% of
   all ink) this canvas has already shipped once. "At most" includes none, so
   the tolerance costs no ink at all: it gates the coincident-extreme merge,
   and it rides on every level as `zone` for the hit/peek radius the
   pointer-disclosure work will need. */
const SR_ZONE_ATR = 0.6;
/* A daily series whose newest bar is older than this has missed a whole UTC
   day. The levels are still drawn — they are prices that really traded — but
   the legend says STALE, because "prior day" would then be naming the wrong
   day, and a name that is wrong about WHEN is worse than no name. */
const SR_STALE_MS = 26 * 3600000;
const SR_PERIOD = { D: "prior day", W: "prior week", M: "prior month",
                    Q: "prior quarter" };
// Longest period first: where two periods print the SAME price the longer one
// owns the drawn price, and the merged name reads Q, M, W, D.
const SR_RANK = { Q: 0, M: 1, W: 2, D: 3 };
/* The verdict travels WITH the layer, in the same commit as the layer, the
   way #p-sides carries "descriptive, not predictive" for aggressor flow. The
   soft risk in this whole feature is that "stable, calendar-anchored,
   well-named" reads as "works". It does not. */
const SR_VERDICT =
  "Prior-period highs & lows — reference marks, NOT a tested edge. Measured: " +
  "real levels rejected 59.2% of fresh touches; matched displaced-RANDOM " +
  "levels rejected 60.0%. Edge minus control -0.83pp, 95% block-bootstrap CI " +
  "[-2.22, +0.58], across 266 pre-registered cells on 9 instruments. The " +
  "harness had power (a lookahead swing-pivot oracle scores +6.22pp). Real " +
  "levels are not even VISITED more often than arbitrary nearby prices — an " +
  "identical 2.38 fresh touches per level per fold on both arms, so the folk " +
  "'~60% of touches bounce' number is entirely baseline. Recorded as " +
  "horizontal-sr-levels / NO_GO in the edge registry. These lines are drawn " +
  "because they are STABLE — the same prices at every interval and every " +
  "scroll position (Jaccard 1.000, against 0.075 across an interval change " +
  "for the fractal method they replaced) — not because they predict.";
const SR_CAVEAT_UTC =
  "Periods are UTC calendar day / week (Mon-Sun) / month / quarter. NOT IST, " +
  "and NOT the US cash session: the prior 'day' for an equity perp is a 24h " +
  "UTC day, which is not 09:30-16:00 ET.";

/* ── the ONE offEnd clamp ────────────────────────────────────────────────
   `offEnd` counts bars hidden to the RIGHT of the window, and may go
   NEGATIVE: that scrolls PAST the newest bar, leaving blank space on the
   right so the live candle clears the price axis, book gutter and whale
   rail. See the longer note in drawChart for why that affordance exists.

   WHY THIS HELPER EXISTS — do not inline it again. Four sites clamp offEnd
   (the draw, chartZoom, chartPanBars and the drag handler) and they had
   already drifted into three different expressions. THE DRIFT WAS THE BUG.
   Measured on the pre-fix build, 1h/300 candles, default 140-bar view:
     * chartPanBars floored at 0 while the drag and the draw floored at
       -fwdRoom, so trackpad forward-pan was completely dead — five
       deltaX:-120 swipes gave offEnd 0,0,0,0,0;
     * and from the forward limit (offEnd -39) one forward swipe teleported
       the view 39 bars BACKWARD to offEnd 0.
   Every clamp now goes through here so they cannot separate again.

   `windowBars` is the WINDOW SIZE (state.scale.slots), never the drawn
   count (state.scale.n). They are equal only while offEnd >= 0; past the
   newest bar the slice is shorter than the window and n < slots.

   The back bound is floored at 0 because the window has a hard minimum of
   20 bars: a series shorter than that makes (length - windowBars) negative
   and would force a forward scroll the user never asked for on a
   thinly-traded new listing. */
const FORWARD_ROOM = 0.28;      // share of the window scrollable past `now`
function clampOffEnd(off, windowBars) {
  const w = Math.max(1, windowBars || 1);
  const fwd = Math.max(5, Math.round(w * FORWARD_ROOM));
  return Math.max(-fwd, Math.min(off, Math.max(0, state.candles.length - w)));
}

/* A slot is a ROW plus a SPAN, not a row.

   Rows alone forced every instrument that writes into the price pane to
   share one lane, because a left-anchored label can be long enough to reach
   a right-anchored one — measured at 0.7px apart — and a y-only allocator
   cannot see that. But sharing a lane on those grounds means an S/R label at
   x 78-197 blocks the whale roster footer at x 282-542, four hundred pixels
   away, for no reason at all. Measured in the owner's own configuration:
   lane "left" holds seven labels and rejects the next eleven, and the two
   marks that lost were the whale cohort's short line and the footer that
   qualifies the whale order ticks.

   So callers may declare the x span they will actually paint into. Two
   labels clash only when their rows AND their spans overlap. Omitting the
   span means "assume I could be anywhere", which is what every caller meant
   before and is still the safe default — a site that has not been taught to
   measure itself stays exactly as strict as it was. */
function labelLanes() {
  const taken = {};
  const NOX = [-Infinity, Infinity];
  const clash = (lane, yy, gap, a, b) =>
    (taken[lane] || []).some((v) =>
      Math.abs(v.y - yy) < (gap == null ? 14 : gap) &&
      // 3px of air, so two spans that merely touch still read as separate.
      !(v.b + 3 <= a || b + 3 <= v.a));
  return {
    /* true if the slot was free (and is now claimed). */
    place(lane, yy, gap, x0, x1) {
      const ys = taken[lane] || (taken[lane] = []);
      const [a, b] = (x0 == null || x1 == null) ? NOX : [x0, x1];
      // Default follows the type scale: two 11px labels need more than 11px
      // of separation to read as two labels. Tuned for 8px text originally,
      // which is why raising the fonts brought overlaps back.
      if (clash(lane, yy, gap, a, b)) return false;
      ys.push({ y: yy, a, b });
      return true;
    },
    /* Same test, claiming nothing. For marks that are pinned in x as well as
       y and therefore have to consult their x-NEIGHBOURS' lanes before
       claiming their own — see the whale event labels. */
    free(lane, yy, gap, x0, x1) {
      const [a, b] = (x0 == null || x1 == null) ? NOX : [x0, x1];
      return !clash(lane, yy, gap, a, b);
    },
    /* Claim the first of several candidate y positions.

       A label that loses its preferred slot is not always better dropped:
       the whale cohort lines, for instance, are drawn whether or not their
       label wins, so losing the label leaves a dashed line across the pane
       with no noun on it — which is the exact failure this whole pass
       exists to remove. Those marks nudge instead: same lane, same rules,
       just a row up or down. Returns the y actually claimed, or null. */
    placeNear(lane, ys0, gap, offsets, minY, maxY, x0, x1) {
      for (const dy of offsets) {
        const yy = ys0 + dy;
        if (yy < minY || yy > maxY) continue;
        if (this.place(lane, yy, gap, x0, x1)) return yy;
      }
      return null;
    },
    /* Find a free RUN on a row, sliding right past whatever already holds it.

       For a label naming a full-width horizontal line, every x on that line
       is equally "on the line" — so a blocked left edge is not a reason to
       leave the row, it is a reason to move along it. Only if the whole row
       is spoken for does the label try a neighbouring row.

       `widths` is the fitText ladder measured longest-first: a row that
       cannot host the full sentence may still host a shorter rung of it, and
       a short label on the right line beats a long one on the wrong line.
       Returns {y, x, i} — i indexes the ladder, so the caller paints exactly
       the string whose width was reserved. */
    placeRun(lane, ys0, gap, offsets, minY, maxY, widths, xMin, xMax) {
      const ys = taken[lane] || (taken[lane] = []);
      const g = gap == null ? 14 : gap;
      for (const dy of offsets) {
        const yy = ys0 + dy;
        if (yy < minY || yy > maxY) continue;
        const blockers = ys.filter((v) => Math.abs(v.y - yy) < g)
                           .sort((p, q) => p.a - q.a);
        for (let i = 0; i < widths.length; i++) {
          const w = widths[i];
          let x = xMin;
          for (const bl of blockers) {
            if (bl.a - 3 - x >= w) break;        // clean gap before this one
            if (bl.b + 3 > x) x = bl.b + 3;      // (Infinity for undeclared)
          }
          if (x + w <= xMax) { ys.push({ y: yy, a: x, b: x + w }); return { y: yy, x, i }; }
        }
      }
      return null;
    },
    count(lane) { return (taken[lane] || []).length; },
  };
}

/* Pick the longest phrasing that actually fits, or print nothing.

   Labels on this chart have been clipped twice, and both times the cause was
   the same: a string whose width was ASSUMED rather than measured, sized for
   the pane the author happened to have open. The gutter especially — 67.8px
   usable at this pane, 45px at the narrow floor — will silently swallow the
   end of any label written for a wide window.

   So every annotation that can vary in length now names its own fallbacks,
   longest first, and this picks the first that measures under budget.
   Returning null (nothing fit) is a legitimate outcome: a label you can only
   read half of is worse than a mark with no label, because half a label
   still looks like a complete fact.

   Callers MUST set ctx.font before calling — measureText reads the current
   font, and the two chart sizes differ by 10% in advance width. */
function fitText(ctx, cands, budget) {
  for (const s of cands) if (ctx.measureText(s).width <= budget) return s;
  return null;
}

/* Every interactive path draws through scheduleDraw(), never through
   drawChart() directly.

   Measured before this: a drag across the canvas fired the pan listener AND
   the crosshair listener on the same mousemove, each calling drawChart() —
   two full repaints per event, and a mousemove stream runs well over 100
   events/second, so one drag asked for ~200 complete chart renders (every
   indicator, every overlay, the whole order book, from scratch). The browser
   cannot deliver that, so events queue behind the paint and the chart lags
   the pointer, which is what "the scrolling feels weird" actually is.
   Coalescing to one paint per animation frame caps it at the display rate. */
let drawPending = 0;        // rAF handle; 0 = nothing in flight
let drawAskedAt = 0;
function scheduleDraw() {
  const now = Date.now();
  if (drawPending) {
    /* A frame is already requested — normally we just coalesce into it. But
       requestAnimationFrame is SUSPENDED, not merely slowed, whenever the
       browser decides the page is not being looked at: a background tab, a
       minimised window, another macOS Space, or a window fully occluded by
       another (which does not even fire visibilitychange). A callback queued
       just before that happens never runs, so a plain boolean latch stays
       true forever and every later interaction returns here and paints
       nothing — the chart freezes, permanently, with no error.

       Verified live: with the page hidden, three consecutive scheduleDraw()
       calls issued zero rAF requests. So the latch expires: if the frame we
       asked for has not run in 400ms it is abandoned and re-requested, and
       the first frame after rAF resumes repaints. */
    if (now - drawAskedAt < 400) return;
    cancelAnimationFrame(drawPending);
  }
  drawAskedAt = now;
  drawPending = requestAnimationFrame(() => { drawPending = 0; drawChart(); });
}

/* Pointer position over the canvas, in CSS px relative to its own box.
   The hovered BAR INDEX is deliberately NOT stored here: an index only means
   something inside the geometry of the frame that produced it, so it is
   derived fresh on every draw. */
const PTR = { x: null, y: null, inside: false };

function hoverIndexIn(plotL, plotR, n, slots) {
  if (!PTR.inside || PTR.x == null || !n) return null;
  // Off the plot (price axis, book gutter, volume-profile column) = no candle.
  if (PTR.x < plotL || PTR.x > plotR) return null;
  // Pitch is the WINDOW, not the bar count: past the end they differ, and
  // dividing by n there would map the cursor to a bar it is not over.
  const pitch = Math.max(1, plotR - plotL) / (slots || n);
  const i = Math.floor((PTR.x - plotL) / pitch);
  return i >= 0 && i < n ? i : null;   // the blank forward zone has no candle
}

/* Same question against the LAST drawn geometry — used only to decide whether
   a mousemove is worth a repaint. */
function hoverIndex() {
  const sc = state.scale;
  return sc ? hoverIndexIn(sc.plotL, sc.plotR, sc.n, sc.slots) : null;
}

/* ── POINTER-ADDRESSED DISCLOSURE: peek and pin ────────────────────────

   WHY THIS EXISTS RATHER THAN ANOTHER LAYER. The price pane holds 253
   simultaneously hit-testable objects in 451x180 px — one per ~320 px2 —
   so any new always-on layer competes with 252 others, and the ones that
   lose print nothing at all. Meanwhile the marks already on the glass throw
   away almost everything they know: a whale entry tick carries addr, side,
   ntl, lev, entry, uPnL and liq_px (returned on 40 of 40 positions by
   /api/whales) and draws a 8px dash; an event triangle carries type, addr,
   delta_ntl, position_ntl, lev, prev_szi and szi and draws a 8px triangle;
   a resting order carries reduce_only, is_trigger and trigger_px and reaches
   the canvas as one amber tick. The information is 100% in the browser and
   100% discarded. So it is addressed by the POINTER instead of by a toggle:
   nothing new is permanently lit, and the mark you are asking about answers.

   PEEK is ephemeral — one object, no click, no state, no persistence, gone
   when the pointer leaves. PIN is the same plate held open on purpose, max
   three, and deliberately NOT persisted to localStorage: a pin that
   outlives the session becomes exactly the forgotten-indicator problem this
   profile's all-true hlterm_inds blob is the proof of.

   SUPPRESSED whenever another instrument owns the pointer — a pan, a ruler
   target drag, or an armed ruler. The ruler is the one path that writes
   state the owner did not ask for, and it must not have a plate under it. */
const PEEK_DWELL_MS = 350;
const PIN_MAX = 3;
const PLATE_RH = 11;         // row height, the footprint box's, verbatim
const PLATE_HEAD = 16;       // its header allowance, verbatim

/* HOW FAR SHORT A STORED LADDER MAY FALL BEFORE THE PLATE SAYS SO.

   The rungs are a sum over stored per-price cells; the bar's Δ comes from the
   b/s tier, which is a COMPLETE measurement of the same bar. Two measurements
   of one quantity, so their difference IS the ladder's shortfall — nothing has
   to be counted in minutes to see it. Only two harmless disagreements have to
   be tolerated, or the plate would cry wolf on bars that are perfectly whole:
     the wire encodes every cell as WHOLE dollars, half-up with a $1 floor
     (server _dollars), so a bar holding `lc` stored minutes of up to 13
     encoded cells each (12 kept rungs + the rn/rb/rs remainder) can round
     DOWN by at most ~$6.50 per stored minute; and
     float summation over hundreds of rungs.
   Measured, the two tiers agree to the cent on every minute fully inside the
   collector's lifetime, so this is headroom rather than slack. The case it
   must MISS is rounding; the case it must CATCH — a minute present in the
   store but holding only part of its own prints, which is the shape of every
   restart minute and every subscribe-replay backfill — was 1.3% of its bar. */
const LADDER_TOL_REL = 0.005;   // of the bar's own traded volume
const LADDER_TOL_USD = 6.5;     // per stored minute, from the $1-floor encoding

/* HITS accumulates during a draw; HITS_LAST is the last COMPLETED frame.

   The split is load-bearing. Hit-testing must run against the frame the
   user is actually pointing at, and the plate's lane claim happens ~2,000
   lines BEFORE the layers that register their objects — so at claim time
   the accumulator is empty and only the completed frame can answer. Each
   entry therefore carries DATA coordinates (`ms`, `px`) beside its pixels:
   pixels answer "what is under the cursor", and ms/px let the plate be
   re-anchored against THIS frame's geometry, so a new candle or a pan
   between the hover and the paint cannot leave a plate pointing at a price
   that has moved. `d` is a live reference into state, not a copy. */
const HITS = [];
let HITS_LAST = [];
const PEEK = { key: null, obj: null, timer: null };
/* Pins are scoped to ONE instrument, exactly as state.ruler.coin scopes the
   owner's plan: held when another symbol is charted, drawn only on their
   own. A pin on a BAR additionally dies on an interval change (`iv`); a pin
   on a price level or a whale survives one, because the object it names
   does. */
const PINS = { coin: null, list: [] };

function hitAdd(o) { HITS.push(o); }

function objectAt(px, py) {
  if (px == null || py == null) return null;
  let best = null, bestRank = Infinity;
  for (const o of HITS_LAST) {
    /* TWO TARGET SHAPES, ONE RANKING. A DISC ({r}) is right for the glyphs:
       an 8px triangle, an 8x1 entry tick — marks about as tall as they are
       wide, where one radius describes the ink honestly.

       TEXT IS NOT THAT SHAPE, and pretending it is produced a measured
       wrong answer. A "$5.0M" value label is ~30x9px: the disc that reaches
       its ends is 15px in radius and swallows every mark within a row of
       it, while the disc that does not reach its ends leaves most of the
       number unhittable. Probed live before this change, the $5.0M label
       body answered with four OTHER events — "increased $439.6K" on 94 of
       the probes and the $5.0M event on none of them. Off by up to 11x, and
       silently: a plate appeared, so the reader had no way to know the
       terminal had answered about a different whale.

       A BOX ({hw,hh}) is the ink, so the answer is the mark the pointer is
       actually on. Both shapes normalise their distance into [0,1] against
       their OWN extent, which is what lets `rank` compare a box and a disc
       on one scale — and what lets a tight target win inside a loose one. */
    let d, r;
    if (o.hw != null) {
      const ax = Math.abs(px - o.x) / Math.max(1, o.hw);
      const ay = Math.abs(py - o.y) / Math.max(1, o.hh || 1);
      if (ax > 1 || ay > 1) continue;
      d = Math.max(ax, ay); r = 1;
    } else {
      r = Math.max(1, o.r || 6);
      const dx = px - o.x, dy = py - o.y;
      d = Math.sqrt(dx * dx + dy * dy);
      if (d > r) continue;
    }
    /* Rank by priority band first, then by how CENTRED the hit is inside
       the object's OWN radius. Raw distance would hand every hover to
       whichever object happened to be pushed first, and normalising by r is
       what lets a small precise mark win inside a large loose one — the
       only ordering under which nested objects are addressable at all. */
    const rank = (o.prio == null ? 5 : o.prio) * 10 + d / r;
    if (rank < bestRank) { bestRank = rank; best = o; }
  }
  return best;
}

function peekClear() {
  clearTimeout(PEEK.timer);
  PEEK.timer = null;
  PEEK.key = null;
  if (PEEK.obj) { PEEK.obj = null; scheduleDraw(); }
}

/* Called from the chart's own mousemove. The dwell is per-OBJECT, not per
   pixel: crossing the same tick twice without leaving it must not restart
   the clock, and moving off it must cancel the pending peek rather than
   pop a plate for something the pointer has left. */
function peekHover() {
  if (PAN.active || RDRAG.active || state.ruler.armed) { peekClear(); return; }
  const o = objectAt(PTR.x, PTR.y);
  const k = o ? o.key : null;
  if (k === PEEK.key) return;
  PEEK.key = k;
  clearTimeout(PEEK.timer);
  PEEK.timer = null;
  // Left the previous object: the plate goes NOW, not after another dwell.
  if (PEEK.obj) { PEEK.obj = null; scheduleDraw(); }
  if (!o) return;
  PEEK.timer = setTimeout(() => {
    PEEK.timer = null;
    if (PEEK.key !== k) return;      // moved on while the clock ran
    PEEK.obj = o;
    /* The chart's repaint gate is "only when the hovered BAR changes", and a
       bar is many pixels wide — so a peek that waited for it would not
       appear until the pointer crossed a bar boundary. This schedules its
       own frame for exactly that reason. */
    scheduleDraw();
  }, PEEK_DWELL_MS);
}

function pinClearAll() {
  if (!PINS.list.length) return false;
  PINS.list = [];
  scheduleDraw();
  return true;
}

/* Escape clears the NEWEST pin before falling through to the ruler, so one
   key walks back out of a stack of disclosures in the order they were made
   without destroying the trade plan underneath them. */
function pinPopNewest() {
  if (PINS.coin !== state.sel || !PINS.list.length) return false;
  PINS.list.pop();
  scheduleDraw();
  return true;
}

function pinToggle(o) {
  if (PINS.coin !== state.sel) { PINS.coin = state.sel; PINS.list = []; }
  const i = PINS.list.findIndex((p) => p.key === o.key);
  if (i >= 0) {
    PINS.list.splice(i, 1);
    showToast("unpinned " + o.title);
    scheduleDraw();
    return;
  }
  PINS.list.push({ ...o, pinned: true, iv: o.perBar ? state.interval : null });
  if (PINS.list.length > PIN_MAX) {
    // FIFO, and it NAMES what it dropped — a pin vanishing silently is the
    // reader losing a fact without being told they lost it.
    const gone = PINS.list.shift();
    showToast("pin limit " + PIN_MAX + " — dropped " + gone.title);
  } else {
    showToast("pinned " + o.title + " · right-click to remove · x clears all");
  }
  scheduleDraw();
}

/* The plate's title and rows, built at PAINT time from the live datum
   rather than at registration time — registration runs for every drawn
   object on every frame, and building 80 strings a frame to show at most
   four of them is work nobody sees. Capped at five rows by §4: a plate that
   scrolls is a panel, and this is an annotation. */
function peekTitle(o) {
  const d = o.d || {};
  if (o.kind === "whpos")
    return "WHALE " + String(d.side || "").toUpperCase() + " · " +
      (d.label || "wallet");
  if (o.kind === "wevent")
    return "WHALE " + String(d.type || "acted").toUpperCase() + " " +
      (d.side === "long" ? "LONG" : "SHORT");
  if (o.kind === "whord")
    return "WHALE " + (d.side === "bid" ? "BID" : "ASK") +
      (d.reduce_only ? " EXIT" : "") + (d.is_trigger ? " STOP" : "");
  if (o.kind === "news") {
    const heads = d.heads || [];
    const name = baseSym(state.sel);
    return heads.length > 1 ? name + " · " + heads.length + " HEADLINES"
                            : name + " NEWS";
  }
  return "OBJECT";
}

function peekRows(o) {
  const d = o.d || {};
  const rows = [];
  const money = (v) => (v == null ? "–" : "$" + fmtBig(Math.abs(v)));
  const ist = (ts) => ts
    ? new Date(ts * 1000).toLocaleTimeString("en-GB", IST) + " IST" : "–";
  if (o.kind === "whpos") {
    rows.push(["size", money(d.ntl)]);
    rows.push(["entry", fmtPx(d.entry_px)]);
    if (d.lev != null) rows.push(["leverage", (+d.lev).toFixed(1) + "x"]);
    if (d.upnl != null)
      rows.push(["uPnL", (d.upnl >= 0 ? "+" : "-") + money(d.upnl)]);
    /* THE LINE THAT CAN END THE ACCOUNT. /api/whales returns liq_px on 40 of
       40 positions and the chart draws none of them; the distance matters
       more than the price, so both travel together and the % is signed
       against the mark, not against the entry. */
    if (d.liq_px != null && o.spot)
      rows.push(["liq", fmtPx(d.liq_px) + "  " +
        (Math.abs(d.liq_px - o.spot) / o.spot * 100).toFixed(2) + "% away"]);
    else if (d.liq_px != null) rows.push(["liq", fmtPx(d.liq_px)]);
  } else if (o.kind === "wevent") {
    rows.push(["who", d.label || d.addr || "–"]);
    rows.push(["change", (d.delta_ntl >= 0 ? "+" : "-") + money(d.delta_ntl)]);
    // position_ntl is the size AFTER the event — "now", never "was".
    if (d.position_ntl != null)
      rows.push(["now", money(d.position_ntl) +
        (d.lev != null ? " at " + (+d.lev).toFixed(0) + "x" : "")]);
    rows.push(["at", fmtPx(d.entry_px)]);
    const fillClk = d.ts_src === "fill";
    rows.push([fillClk ? "fill tx" : "sweep",
      ist(d.ts) + (fillClk && d.hash ? " · " + String(d.hash).slice(0, 12) : "")]);
  } else if (o.kind === "whord") {
    rows.push(["size", money(d.ntl)]);
    rows.push(["resting at", fmtPx(d.limit_px)]);
    /* A stop RESTS at its limit and FIRES at its trigger, and the two are
       nowhere near each other on the live book (limit 58,144 / trigger
       63,200 against spot 63,600). Both, or neither. */
    if (d.is_trigger && d.trigger_px != null)
      rows.push(["fires at", fmtPx(d.trigger_px)]);
    rows.push(["who", d.label || "–"]);
    if (d.ts) rows.push(["resting", fmtAge(Date.now() / 1000 - d.ts)]);
  } else if (o.kind === "news") {
    for (const h of (d.heads || []).slice(0, 5)) {
      const ms = newsPubMs(h);
      const when = ms
        ? new Date(ms).toLocaleTimeString("en-GB", IST) + " IST" : "–";
      const src = String(h.source || h.category || "");
      const hd = String(h.headline || "").slice(0, 72);
      rows.push([when, src ? hd + " · " + src : hd]);
    }
  }
  return rows.slice(0, 5);
}

function drawChart() {
  const canvas = $("chart");
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + "px"; canvas.style.height = H + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  // Hit targets belong to the frame that drew them; same discipline as
  // state.heatWalls, which is cleared on the no-candles path below for the
  // same reason — a stale hit target is a plate describing a mark that is
  // no longer on the glass.
  HITS.length = 0;

  /* Snap every glyph to the device-pixel grid.

     Measured before this: 76% of the chart's text was drawn at fractional
     coordinates (x=103.25, 204.39, y=51.9 …). After ctx.scale(dpr) those
     land between physical pixels, so the rasteriser spreads each glyph
     across two columns and the whole chart reads soft — the single largest
     legibility loss on the canvas, and invisible in code review because
     every call site looks correct.

     Done once here rather than at ~30 call sites so it cannot be forgotten
     by the next layer added. Rounding is to 1/dpr, i.e. whole DEVICE
     pixels, not whole CSS pixels. */
  const snap = (v) => Math.round(v * dpr) / dpr;
  // Bind the PROTOTYPE method, not ctx.fillText: the line below installs an
  // own property on the context, so on the next frame `ctx.fillText` would
  // resolve to the previous frame's wrapper and each draw would wrap the
  // wrapper — an unbounded closure chain on a canvas that redraws every
  // second. Reaching past the instance keeps it exactly one deep forever.
  const _fillText = CanvasRenderingContext2D.prototype.fillText;
  ctx.fillText = (t, tx, ty, ...rest) =>
    _fillText.call(ctx, t, snap(tx), snap(ty), ...rest);

  // Viewport slice. 300 bars into a ~700px plot is 2.3px per candle —
  // unreadable by default. The default view shows the newest DEFAULT_BARS;
  // scroll to zoom, drag to pan, 0 to reset.
  const all = state.candles;
  const DEFAULT_BARS = 140;
  const vCount = Math.max(20, Math.min(all.length,
    state.view.count || Math.min(all.length, DEFAULT_BARS)));
  /* offEnd may go NEGATIVE: that scrolls PAST the newest bar, leaving blank
     space on the right.

     Without it the live candle is pinned against the price axis, the book
     gutter and the whale rail — exactly the furniture that makes it hard to
     read — and there is no way to move it. Every real charting package
     allows this for the same reason. The forward limit scales with the
     window so it is a constant fraction of the view at any zoom. */
  // Clamp site 1 of 4, shared with chartZoom, chartPanBars and the drag
  // handler. The window size is what bounds it, never the drawn count.
  const vOff = clampOffEnd(state.view.offEnd, vCount);
  state.view.offEnd = vOff;                      // keep clamped state honest
  const vEnd = all.length - vOff;
  const i0 = Math.max(0, vEnd - vCount);          // window start in `all`
  // Past the end, the slice is SHORTER than the window. `slots` keeps the
  // bar pitch fixed at the window size so the survivors stay their normal
  // width and the surplus shows as empty space, instead of stretching a
  // handful of candles across the whole pane.
  const cs = all.slice(i0, Math.min(all.length, vEnd));
  const slots = vCount;
  if (!cs.length) {
    state.scale = null;          // never let a stale scale outlive its candles
    state.heatWalls = [];        // ...and never leave clickable hit-targets behind
    HITS_LAST = [];              // ...nor peek/pin targets (same reason)
    /* ...nor the two DOM readouts, which are the only marks here that survive
       a clearRect. selectCoin() empties state.candles and calls drawChart()
       synchronously, so this branch runs under the NEW symbol's title while
       #chart-meta still reads the OLD symbol's O/H/L/C and #legend still
       carries the old symbol's decoder chips. That is a previous
       instrument's numbers presented as this one's — the same failure the
       srDaily and sidesError guards in selectCoin were written to stop, at
       the one address that draws nothing and therefore cleans nothing. */
    const lgEl0 = $("legend");
    if (lgEl0) { lgEl0.style.display = "none"; lgEl0.innerHTML = ""; }
    const cm0 = $("chart-meta");
    if (cm0) cm0.textContent = "";
    const xh0 = $("xhair");
    if (xh0) xh0.style.display = "none";
    $("chart").style.cursor = ""; $("chart").title = "";
    /* THREE outcomes, three sentences. This drew "loading candles…" for all
       of them (audited 2026-08-16), which is a promise of bars for two cases
       where no bar is ever coming: a market the venue serves as EMPTY, and a
       fetch that FAILED. state.candlesNote carries which one happened; null
       means no fetch has completed yet for this symbol, and that is the only
       state in which the word "loading" is true. */
    const cn = state.candlesNote &&
               state.candlesNote.coin === state.sel &&
               state.candlesNote.interval === state.interval
      ? state.candlesNote : null;
    ctx.font = CHART_FONT_M; ctx.textAlign = "left";
    if (!cn) {
      ctx.fillStyle = alpha(CC.s1, A_FAINT);
      ctx.fillText("loading candles…", W / 2 - 50, H / 2);
      return;
    }
    const head = cn.kind === "error"
      ? "NO CHART — the candle fetch FAILED"
      : "NO CHART — this market has no candle history";
    /* A LITERAL left margin, not plotL. plotL is `const` and is declared ~360
       lines below this branch, so reading it here is a temporal-dead-zone
       ReferenceError that kills the whole frame — caught by forcing a frame on
       CHILLGUY rather than by reading state, which is the only way this branch
       is ever reached. The original line used W/2-50 for the same reason. */
    const padX = 10;
    ctx.fillStyle = cn.kind === "error" ? CC.alarm : CC.s3;
    ctx.fillText(head, padX, H / 2 - 8);
    // Wrapped by hand: the pane has no paragraph layer and these sentences are
    // longer than any label budget in the file.
    ctx.fillStyle = alpha(CC.s1, A_MID);
    let wy = H / 2 + 8;
    const maxW = Math.max(80, W - padX * 2);
    let line = "";
    for (const word of String(cn.text).split(/\s+/)) {
      const t = line ? line + " " + word : word;
      if (ctx.measureText(t).width > maxW && line) {
        ctx.fillText(line, padX, wy); wy += 13; line = word;
      } else line = t;
      if (wy > H - 12) break;
    }
    if (line && wy <= H - 12) ctx.fillText(line, padX, wy);
    return;
  }
  /* The legend is an absolute overlay ON this canvas, so the canvas has to
     RESERVE room for it or it lands on whatever the last layer drew there.

     Measured before this: at a 502px canvas with the full stack on, the
     #legend box spanned y 221-302 while the delta strip's caption drew at
     y=270 and MACD's at y=233 — both underneath an opaque #0a1014cc
     background. The decoder key was covering the marks it decodes, which is
     the same class of failure as an unreadable label and slightly funnier.

     Its height is not knowable before the chips are built (they are built by
     the layers, at the bottom of this function), so it is measured from the
     element as it stands from the previous frame. That is stable: the chip
     set is a function of which indicators drew, and reserving VERTICAL space
     changes none of the predicates that gate them — every one of those tests
     is horizontal (plotR >= 220, axisR >= 260) or about data. So there is no
     oscillation, only a one-frame lag on the very first paint.

     Capped, because a wrapped four-line legend on a short chart must not be
     allowed to eat the price band it is annotating. */
  const lgEl = $("legend");
  // The cap is 40%, not a tidier 22%: sixteen chips wrapped into a 380px
  // column measure 114px, and a cap that stops short of the box that exists
  // does not prevent the overprint, it just makes it smaller. The price band
  // is protected further down by its own share-of-canvas floor, which is the
  // right place for that argument to be made.
  const lgReserve = (lgEl && lgEl.style.display === "block")
    ? Math.min(lgEl.offsetHeight + 6, Math.max(0, H * 0.4)) : 0;
  const padR = 56, padT = 10, padB = 22;
  // padB is the DATE AXIS zone and stays put — its labels, ticks and the
  // crosshair time tag are all pinned to it. stackB is the bottom of the
  // drawn STACK (price band, sub-panes), which is what has to rise to clear
  // the legend. Conflating the two put the legend on top of the crosshair
  // tag instead of the delta caption; same bug, new address.
  const stackB = padB + lgReserve;
  const avail = Math.max(1, H - padT - stackB);
  const nPanes = (state.inds.cvd ? 1 : 0) + (state.inds.rsi ? 1 : 0) + (state.inds.macd ? 1 : 0);
  /* THE VOLUME STRIP RESERVES NOTHING NOW.

     Measured at this desk (1728x1000, default preset, frames forced because
     rAF does not fire in the verification pane): the price plot used 93.5%
     of the height it was given — the candles spanned y(min c.l)..y(max c.h)
     = 320.5 of 342.9 — while the strip beneath it used 17.3% of its own
     66.08px (mean bar 11.45px, median 7.72px, i.e. ~58px of nothing above
     the typical bar). And `volH = max(24, avail * 0.16)` had NO GATE: no key
     hid it, no key shrank it, and quiet mode made it BIGGER (66.08 -> 73.44)
     because it was a share of whatever the legend left behind.

     Volume is a real input — it is what confirms the one VALIDATED edge in
     the registry — but it does not need 13.5% of the canvas to say so. It is
     now a wash across the bottom 18% of the PRICE pane, composited at
     A_FAINT and drawn before the candles so it can never sit on top of
     price, and it reserves zero. `v` hides it, which is strictly more than
     it could do before. The band's ceiling is exported as state.scale.volTop
     (see there) so a measurement harness can subtract it analytically
     instead of guessing which rects are candles. */
  let paneH = nPanes ? Math.max(34, avail * (nPanes > 2 ? 0.12 : nPanes > 1 ? 0.14 : 0.18)) : 0;
  /* The price band must survive a short chart.

     The 34px floor above is absolute, so its SHARE of the canvas is
     unbounded: measured at H=200 with cvd+rsi+macd on, the stack claimed
     167 of 178 usable pixels and the candles were left a 23px band. A few
     pixels shorter and (H - padT - priceB) goes NEGATIVE — y() inverts and
     the entire chart draws upside down with the axis labels interleaved.
     So the sub-panes are given only what is left over the price band's
     share, and they shrink together rather than one of them winning.

     The cap moved 0.55 -> 0.30 of `avail` and NOTHING ELSE in this block
     moved. Measured: cvd+rsi+macd took the price plot from 342.9 to 185.9px
     — 45.8% of it — for three panes of which CVD's divergence is a recorded
     NO-GO at n=44,177 and RSI fills 45.0% of its own pane. The `k` scaling
     and the 10px floor are exactly what stop the upside-down chart above, so
     they are untouched; only the constant is a judgement about worth. */
  const gaps = nPanes * 4;
  const budget = Math.max(0, avail * 0.30 - gaps);
  const want = nPanes * paneH;
  if (want > budget) {
    const k = budget / want;
    paneH = nPanes ? Math.max(10, paneH * k) : 0;
  }
  const priceB = stackB + nPanes * (paneH + 4);
  // sub-pane slots stack upward from the bottom of the stack; idx 0 highest
  const paneBot = (idx) => H - stackB - (nPanes - 1 - idx) * (paneH + 4);
  /* The volume overlay's band, in pixels, settled HERE with the rest of the
     layout rather than inside the draw — the same rule the book gutter had
     to learn: a layer that computes its own geometry two hundred lines below
     the layers that must avoid it gives them nothing to avoid.

     18% of the drawable price band. At this desk that is 74.3px of a 413px
     pane — larger than the 66.08px strip it replaces, and it costs the price
     plot nothing because it is composited over it rather than cut out of it. */
  const priceBot = H - priceB;
  const volBandH = state.inds.vol ? Math.max(8, (priceBot - padT) * 0.18) : 0;
  const volTop = priceBot - volBandH;
  /* Boxes of the captions the sub-panes print, so a later mark can find a row
     that is actually free instead of assuming one. Deriving the occupied rows
     from geometry alone was not enough: each pane writes at top+10/+11, but
     CVD writes a SECOND row at top+23 (its provenance line) and a badge on
     the right of the first — measured, a marker placed by geometry cleared
     the headline and landed 3.3px inside "server tape · N samples". Recording
     what was actually drawn cannot go stale when a pane gains a row. */
  const paneTextBoxes = [];
  const paneCap = (t, x, y) => {
    if (!t) return;
    const w = ctx.measureText(t).width;
    const x0 = ctx.textAlign === "right" ? x - w
             : ctx.textAlign === "center" ? x - w / 2 : x;
    // Generous by ~1px on each edge: this feeds a CLEARANCE test, where
    // over-reserving costs a row and under-reserving costs a collision.
    paneTextBoxes.push({ x0: x0 - 1, x1: x0 + w + 1, y0: y - 11, y1: y + 3 });
    ctx.fillText(t, x, y);
  };
  const n = cs.length;
  // include the event band inside the price scale so it is always visible
  const ev = nextEventFor(state.sel);
  const last = cs[n - 1].c;
  let lo = Math.min(...cs.map((c) => c.l)), hi = Math.max(...cs.map((c) => c.h));
  // The TRUE extremes of the window, kept before anything widens the scale.
  // The readout at the bottom quotes H/L and must report the candles, not the
  // drawing range — with an event band on it was already quoting the band.
  const winLo = lo, winHi = hi;
  /* The band no longer widens the price scale.

     `hi = Math.max(hi, evUp); lo = Math.min(lo, evDn)` was live and
     unconditional: a forecast about one future day expanded the range so the
     candles had to be compressed to make room for the forecast's own band.
     Measured on today's data it cost the candles 1.3% of vertical
     resolution; on an FOMC/CPI move it would be severe. An edge that falls
     outside the drawn range now clamps to the pane border and says so,
     which is a visible failure instead of a silent rescale. */
  const evOn = !!(ev && state.inds.ev);
  let evUp = null, evDn = null;
  if (evOn) {
    evUp = last * (1 + ev.expected_move_pct / 100);
    evDn = last * (1 - ev.expected_move_pct / 100);
  }
  /* Headroom. Mapping hi->padT and lo->the pane floor EXACTLY means the
     extreme wick of the window is permanently glued to the edge of the plot,
     which is why panning read as snapping: every step that changes the
     extreme re-anchors the whole scale against a hard stop instead of easing
     into empty space. It also hung the 16px last-price tag half off the
     canvas whenever the newest bar was the window high. 3.5% at each end. */
  /* AND A FLOOR IN PIXELS, because 3.5% of a range is not a distance.

     The extreme bar of the window could not host its OWN row-0 value label.
     Measured: 0.035/1.07 x 342.9 = 11.21px of pixel headroom (the label
     placer reported 11.2), against the 12.60px a long's row 0 needs
     (EV_CLEAR 5 + ascent 7.6) and the 14.07px a short's needs at the same
     extreme (EV_CLEAR + descent 1.47 + ascent). So the drop test in the
     whale block fired and the number on the most interesting bar in the
     window — the high or the low — was the one number that vanished.

     The volume overlay lifted the pane and took headroom to ~15px, which
     clears the long case and clears the short case by 0.93px. Nothing should
     rest on 0.93px of a value that moves with every layout, so the pad is
     floored at whatever buys EV_ROOM pixels instead.

     Solved, not iterated: headroom_px = P/(R+2P) * plotH, so P >= EV_ROOM*R /
     (plotH - 2*EV_ROOM) delivers EV_ROOM px exactly. CAPPED at 8% of the
     range, because on a short pane that expression runs away (at plotH 200 it
     asks for 9.5% a side) and squeezing the candles to guarantee a caption is
     the wrong trade — above the cap the guarantee simply is not held, which
     the placer already handles by dropping the label rather than overprinting
     it. Nothing here can widen the scale beyond 8%+3.5%; the event band's
     rescale was removed for exactly that reason. */
  const EV_ROOM = 16;
  const rawRange = (hi - lo || Math.abs(hi) * 0.002 || 1);
  const plotHpx = priceBot - padT;
  const padFloor = plotHpx > 2 * EV_ROOM + 20
    ? Math.min(rawRange * 0.08, EV_ROOM * rawRange / (plotHpx - 2 * EV_ROOM))
    : 0;
  const padSpan = Math.max(rawRange * 0.035, padFloor);
  hi += padSpan; lo -= padSpan;
  const span = hi - lo || 1;
  // With the heatmap on, the liquidity gutter is RESERVED: the candle plot
  // ends at plotR so the book is its own instrument rather than a wash of
  // colour behind the newest bars.
  const heatOn = !!(state.inds.heat && state.heat.coin === state.sel && state.heat.live);
  const axisR = W - padR;
  // The gutter is a guest: it never takes more than 40% of the pane, and it
  // stands down entirely when there is not enough width to host it usefully.
  const gutterFits = heatOn && axisR >= 260;
  /* Scale the gutter to how much of the SERIES the book actually covers: on
     a 1d chart the book is a sliver and should not cost 22%.

     Measured against the VISIBLE range (as this did) the gutter width became
     a function of zoom: zooming in shrinks hi-lo, so cover rises to 1 and the
     gutter grew from 89px to 198px across the zoom range. That moves plotR,
     which moves plotW, which re-lays out every candle — so each wheel click
     resized the plot as well as zooming it, and the cursor-anchored zoom
     maths (which reads the PREVIOUS frame's plotW) drifted off the bar it was
     supposed to be pinning. Measuring against the full fetched series keeps
     the same intent and makes the column's width a property of the market,
     not of the viewport. Quantised to 8px so a data tick cannot jitter it. */
  let heatCover = 1;
  if (gutterFits && state.heat.live && state.heat.live.length && all.length) {
    const ps = state.heat.live.map((r) => r[0]);
    let aLo = Infinity, aHi = -Infinity;
    for (const c of all) { if (c.l < aLo) aLo = c.l; if (c.h > aHi) aHi = c.h; }
    heatCover = Math.min(1, (Math.max(...ps) - Math.min(...ps)) /
      Math.max(1e-9, aHi - aLo));
  }
  const gutterW = gutterFits
    ? Math.round(Math.min(Math.max(76, axisR * 0.22 * Math.max(0.45, heatCover)),
                          200, axisR * 0.4) / 8) * 8 : 0;
  const gutterL = axisR - gutterW;
  /* The candle plot must END where the furniture begins.

     It used to be laid out all the way to axisR and then CLIPPED at the book
     gutter, which meant the newest bars were drawn and thrown away: measured
     live, openR was 530 against a newest-bar x of 628.7 — **101px and ~22
     candles, including the live one, rendered and then cut**. The live price
     is the one bar you cannot afford to hide.

     Sizing the plot to the furniture instead is also what makes scrolling
     past the end meaningful: there is now a real right edge to scroll the
     last candle away from.

     The earlier note here worried that making plotW depend on book-data
     arrival would drift the cursor-anchored zoom. It does not: chartZoom
     anchors on the BAR COUNT (sc.n) and a fraction of the plot, never on
     plotW in pixels, and the pan handler reads the current frame's pitch. */
  /* THE RIGHT COLUMN: ONE column, ONE tenant, default NONE.

     Three independent audits measured the in-canvas raw book and landed on
     the same verdict. 84 x 342.9 = 28,805 px2 to draw 40 levels into a 6.0px
     band: 1.75% of its own height used, 94.2% of its rows blank, ±3.09 bps
     of reach against a 464 bps pane — while #sidebook renders the IDENTICAL
     book (same top bid, same top ask, same state.book) as 16 legible
     price/size rows 3px to its right. And it was ON by default. The volume
     profile, which genuinely fills a column, was OFF by default and lived in
     a 60.94px gutter at the opposite end of the pane from the POC label that
     names it. The defaults were backwards, not the idea.

     So there is now one right-hand column with one tenant:
       "none"  (default) — colW 0, and the plot keeps the 84px
       "vp"              — the volume profile, right-anchored at the axis
       "book"            — the resting book, AGGREGATED (see the draw block)
     `b` cycles none -> vp -> book -> none, and the VP and BOOK buttons are
     the same choice, so they are mutually exclusive at the handler.

     The width formula is the book's, unchanged. Its 70px floor is DERIVED,
     not chosen: at 6.021px per glyph the widest real wall label, "ASK
     $378.2K" (11 glyphs, 66.23px), needs 69.2px of container and "LIVE BOOK"
     needs 57.2px. VP's own floor is 46. 84 clears both — so the profile on
     the right is WIDER than the 60.94px it had on the left AND costs zero
     plot width, because it displaces furniture instead of adding to it. */
  /* PRECEDENCE, DECIDED AND RECORDED (audit 2026-08-16).

     The question: with the heat gutter live, the owner presses VPROF or BOOK.
     Who gets the right edge?

     "The explicit toggle beats the automatic one" does not resolve it, because
     BOTH are explicit toggles. Heat is the H key and the HEAT button; VP and
     BOOK are the B key and their own buttons. The only automatic part is
     gutterFits, which is a WIDTH test (axisR >= 260), not a choice.

     What resolves it is asymmetric degradation — which of the three has a
     reduced form that still answers the question it was turned on to answer:

       VPROF -> the POC still draws, full width, NAMED ("POC 63,478 most-traded
                price"). The one number the profile exists to produce survives;
                only the histogram needs the column.
       BOOK  -> #sidebook renders the IDENTICAL book (same state.book, same top
                bid/ask) as 16 legible price/size rows 3px to the right of this
                column, AND the heat gutter that took the column is drawing the
                same resting depth by price. Nothing is lost that is not on
                screen twice already.
       HEAT  -> has NO reduced form. It is a price x TIME surface; there is no
                single level that stands for it. At 0px it is nothing at all.

     So HEAT KEEPS THE EDGE, and the price of that decision is paid in words:
     every one of the three states below must SAY what it yielded and what
     survives. That obligation is the whole reason this is written down —
     the VP branch has always honoured it (see the else at the VOLUME PROFILE
     legend push), and the BOOK branch did NOT until this audit: it lit its
     button, cost a keystroke, drew nothing and said nothing, which is the
     house invariant wearing a different hat. cycleRightCol() was worse: it
     positively TOASTED "right column: resting book" at a moment when no book
     would be drawn. A false claim is worse than a silent no-op.

     If this is ever revisited: making VP/BOOK win instead does not remove the
     problem, it moves it — heat would then be the lit button drawing nothing,
     and it is the one of the three that cannot degrade. */
  const colTenant = gutterFits ? "none"            // heat owns the right edge
    : state.inds.vp ? "vp"
    : (state.inds.book && state.book && state.book.coin === state.sel) ? "book"
    : "none";
  /* Why the owner's BOOK/VPROF press produced nothing, in the words the legend
     will use. Computed here, next to the decision, rather than at the two draw
     sites — a tenant that is stood down has no draw site to speak from. */
  const colYield = !gutterFits ? null
    : "column yielded to the heatmap gutter";
  const colShows = colTenant !== "none" && axisR >= 220;
  const colW = colShows ? Math.round(Math.min(84, Math.max(70, axisR * 0.14))) : 0;
  /* The whale rail is now UNCONDITIONAL with respect to the column.

     It used to be a passenger of the book gutter — no book, no rail — which
     inverts the reason it exists. The rail was created to END a measured
     overprint in which four unrelated vocabularies shared one 82px band,
     separated only by hue and dash rhythm; and it is the best
     pixels-per-decision object on this canvas: 14px wide, 8 ticks over a
     196px span, 14.16% ink, and the only place a resting whale order appears
     at its own price. Retiring the book column must not take it down.

     It IS still owned by the whale toggle, which the layout spec left
     implicit. Without that, `q` could not clear it — and quiet is the one
     key on this instrument that promises a bare chart. */
  const railW = (state.inds.wh && state.whaleCoin &&
                 state.whaleCoin.coin === state.sel &&
                 (state.whaleCoin.orders || []).length) ? 14 : 0;
  /* ONE expression sizes the plot; the SAME expression places the furniture.

     The recorded bug this guards: openR 530 against a newest-bar x of 628.7
     — 101px and ~22 candles, including the live one, laid out and then
     clipped away — happened because the reservation and the draw disagreed
     about where the right boundary was. There is now a single identity, and
     it holds in every tenant state. Stated exactly, because a comment that
     overstates it invites a future session to "fix" the wrong side —
     MEASURED true in all six states (none / vp / book / +cvd / +cvd+rsi+macd
     / quiet) at 1728x1000:

         plotR + (furnitureW ? 3 + railW + colW : 0)
             === (heat ? gutterL : axisR)

     The 3px gap exists only when there IS furniture to be separated from: in
     quiet, with no rail and no tenant, plotR runs all the way to axisR and
     the plot is 655px, not 652.

     openR, the boundary every plot-content layer clips and budgets against,
     is plotR itself. Not "plotR unless a rail exists" — the same number. */
  const furnitureW = (colW || railW) ? colW + railW + 3 : 0;
  const rightEdge = gutterFits ? gutterL : axisR;
  const plotR = rightEdge - furnitureW;
  const colL = colW ? axisR - colW : null;
  const railL = railW ? (colW ? colL : rightEdge) - railW : null;
  /* The volume profile's LEFT gutter is retired.

     It cost 64.94px — 11.7% of plot width — whenever it was on, and it put
     the histogram at the far end of the pane from the POC label that names
     it. Moving the profile into the right column closes that split and hands
     the width back. plotL survives as a name because every x-mapping and
     every left-anchored caption in this function reads it; it is simply 0
     now, in every configuration. */
  const plotL = 0;
  const plotW = Math.max(1, plotR - plotL);
  const x = (i) => plotL + (i + 0.5) * (plotW / slots);
  const y = (p) => padT + (hi - p) / span * (H - padT - priceB);
  // One time mapping for every pane. CVD used to map (ms-t0)/(t1-t0) while the
  // candles used (i+0.5)/n, so every bucket sat half a bar to the left of the
  // candle that produced it. Same function now, so they line up exactly.
  const barMs = n > 1 ? (cs[1].t - cs[0].t) : 60000;
  const t0 = +cs[0].t;
  const cx = (ms) => plotL + ((ms - t0) / barMs + 0.5) * (plotW / slots);
  // Whale events are instants, not bar aggregates. cx() is candle-centred
  // (the +0.5), so a fill late in a bar is drawn on the NEXT candle. Intra-bar
  // time: left edge = open, right edge = next open. CVD/news keep cx().
  const cxT = (ms) => plotL + ((ms - t0) / barMs) * (plotW / slots);
  // Hit-targets are rebuilt by whichever wall sources draw this frame
  // (book gutter, heatmap); without this reset the book pushed a fresh
  // copy of its walls on every draw.
  state.heatWalls = [];
  const lanes = labelLanes();
  /* Widest of a fitText ladder under the CURRENT font. A label has to
     reserve the span it MIGHT paint, not the one it turns out to use: the
     rung is chosen after the slot is won, and a slot won on the strength of
     the short rung would be a lie if the long rung then printed. */
  const widest = (cands) => Math.max(...cands.map((s) => ctx.measureText(s).width));
  // Gutter geometry is LAYOUT, so it is settled before anything draws.
  // It used to be computed inside the book's own draw block, two hundred
  // lines below the S/R and whale layers that need to avoid it — those
  // layers had no way to know where the book would land, so they drew
  // straight through it.
  /* Whale resting orders keep their own 14px rail. It is LAYOUT for the same
     reason the column is: the layers to its left have to know where it ends
     before they draw.

     Why a separate rail at all. Measured on live BTC, the entire visible raw
     book spanned about SIX pixels of a 405px column — ~98% empty vertically
     and dead full horizontally — and four unrelated vocabularies were
     sharing that one 82px band: book bars, book wall labels, whale order
     ticks, whale position ticks, separated only by hue and dash rhythm. That
     is why every mark in there needed a prefix declaring which vocabulary it
     belonged to, and why the shortest possible prefix — a bare "W" — got
     read as the start of a word.

     A column is labelled once at its head, not once per cell. So the whale
     orders live OUT of any column, their ticks stay on the price axis where
     a resting order belongs, and their text escapes leftward into ~500px of
     empty plot instead of fighting for 11 characters.

     The filter is hoisted here (it used to live 800 lines below) because the
     labels and the footer are budgeted against railL. railW above reserves
     on orders EXISTING; this list re-filters to the visible price window, so
     the reservation and the plot stay consistent even when every order is
     off-screen. */
  const railShows = railW > 0;
  const whOrders = (railShows ? (state.whaleCoin.orders || []) : [])
    // A stop rests at its LIMIT price but fires at its TRIGGER price, and the
    // two are nowhere near each other: the live book carries a reduce-only
    // stop with limit_px 58,144 and trigger_px 63,200 against spot ~63,600.
    // Placed on limit_px it filtered out of the window entirely — the chart
    // simply never drew it. The trigger is the price that matters, so that is
    // where it is filtered and where it is drawn.
    .map((o) => ({ ...o, px: (o.is_trigger && o.trigger_px) || o.limit_px }))
    .filter((o) => o.px >= lo && o.px <= hi)
    .sort((a, b) => b.ntl - a.ntl);
  /* Right edge available to layers that must not enter the rail or the
     column — and it is plotR itself, by the identity stated above. It used
     to be `railL != null ? railL - 3 : plotR`, i.e. a SECOND expression for
     the same boundary, which is exactly the shape of the bug that clipped 22
     candles: two derivations of one number, free to drift. */
  const openR = plotR;
  /* axisR / railL / openR ride along for the same reason plotL and plotR
     already do: they are this frame's horizontal boundaries, and anything
     resolving a pointer against the drawn geometry needs them from OUTSIDE
     drawChart. No behaviour change — the values are the locals above.

     volTop is published for a different reason, and it is a measurement
     obligation rather than a convenience. The standing harness trap here is
     that "candle-ish rects" also match the volume bars, which share x and
     width with candle bodies — so a min-top..max-bottom span across them
     used to reach from the candle high down to the volume FLOOR, and a label
     sitting cleanly BELOW a candle read as inside it. That already produced
     one wrong diagnosis. Now that volume is composited INTO the price band
     the two are geometrically indistinguishable, so the rule ("a bar's true
     extent is y(c.h)..y(c.l), from the SERIES, never from rect extremes")
     needs a companion the harness can actually use: volTop is the ceiling of
     the wash, volBot its floor, so an overlay rect can be subtracted
     analytically instead of guessed at. A canvas rect has no identity; the
     only defence is publishing the geometry.

     colTenant/colL/colW are the right column as this frame drew it — which
     is the only honest answer to "how wide is the plot", since the tenant
     can be none. */
  state.scale = { hi, lo, span, padT, padR, priceB, H, W, n, slots,
                  plotR, plotL, plotW, gutterL, heatOn, barMs, t0,
                  axisR, railL, openR, railW,
                  volTop: volBandH ? volTop : null,
                  volBot: volBandH ? priceBot : null,
                  colTenant, colL, colW };
  // Crosshair target, resolved against THIS frame's geometry rather than
  // carried over from the frame that drew last (see PTR).
  state.hover = hoverIndexIn(plotL, plotR, n, slots);
  /* Body width leaves a visible gap between candles once there is room;
     sub-pixel positions are snapped so 1px wicks stop smearing to grey.

     The old rule capped the body at 13px absolutely. That cap is only ever
     reached when you have zoomed IN, which is exactly when candles should be
     fat: at a 20-bar view in a 700px plot the slot is 35px and a 13px body
     left 22px of air, so the closer you looked the more the chart turned into
     sparse toothpicks floating in a grid. Width is now a share of the slot
     with a 1px minimum gap enforced (`slot-1`), so bodies grow with the zoom
     and can still never touch or clip their neighbours. */
  const slot = plotW / slots;
  const cw = Math.max(1, Math.min(Math.floor(slot * 0.78),
                                  Math.floor(slot) - 1, 34));
  /* Indicators are computed over the FULL fetched series and then sliced to
     the window. Computing them on the slice — as every call below used to —
     restarts each warmup at the left edge of whatever you happen to be
     looking at, so the viewport silently redefined the numbers:
       * at a 20-bar zoom EMA50 and MACD(12,26,9) have no defined value at
         all (they need 50 and 35 bars of warmup), so both simply vanished
         and the MACD pane went blank the moment you zoomed in;
       * BOLL(20) survived on exactly one bar, RSI14 on six;
       * while panning, the SAME bar reported a different RSI/EMA on every
         frame, because its warmup window slid along with the viewport.
     The window decides what you SEE. It must never decide what a number IS. */
  const win = (series) => series.slice(i0, i0 + n);

  /* ── reachability: a context level earns the plot when price can REACH it ──

     Measured before this: fourteen full-width horizontal lines coexisting
     inside a 185px price band — one every 13px, against 11px type, in five
     dash rhythms and four hues. Every level instrument drew at full width
     always, so "full width" carried no information at all.

     Now it does. `d = |level - last| / ATR14` asks the only question with a
     right answer: can price get there today? ATR rather than a percentage
     because reachability is a volatility question, and computed on `all`
     rather than the viewport slice — the window decides what you SEE, never
     what a number IS (same rule as every other indicator here).

       d < CTX_HOT   full width, bright   — the break candidates
       d < CTX_FAR   full width, dim      — present, not shouting
       beyond        a 4px tick in the price-axis gutter

     The gutter band [axisR+1, axisR+5] is genuinely free: the axis labels
     below print at axisR + 6. A level you cannot reach is a scale
     annotation, and that is where scale annotations live.

     This is also the structural answer to "the owner leaves indicators on
     and forgets": a forgotten indicator now costs a tick, not a line. */
  const atr14 = (() => {
    const s = all;
    if (s.length < 15) return Math.abs(last) * 0.005;
    let t = 0;
    for (let i = s.length - 14; i < s.length; i++)
      t += Math.max(s[i].h - s[i].l, Math.abs(s[i].h - s[i - 1].c),
                    Math.abs(s[i].l - s[i - 1].c));
    return (t / 14) || Math.abs(last) * 0.005;
  })();
  // Hysteresis, keyed by VALUE not identity: the level providers hand back
  // freshly built objects (priorPeriodLevels rebuilds its set whenever the
  // daily series or the UTC day moves, volumeProfile every frame), so an
  // identity-keyed Set would never see the same level twice and the
  // hysteresis would do nothing. Rebuilt fresh each frame and swapped in at
  // the end, so it cannot grow. Prior-period levels are the same PRICE frame
  // after frame, which is the first time this value key has had anything
  // stable to hold on to.
  const prevHot = state.ctxHot instanceof Set ? state.ctxHot : new Set();
  const nextHot = new Set();
  let wideUsed = 0, dimUsed = 0;
  const dormant = [];                 // levels demoted to the axis gutter
  const ctxTier = (key, px) => {
    const k = key + ":" + px.toFixed(2);
    const d = Math.abs(px - last) / atr14;
    const isHot = d < (prevHot.has(k) ? CTX_HOT_OFF : CTX_HOT);
    if (isHot) nextHot.add(k);
    if (isHot && wideUsed < CTX_MAX_WIDE) { wideUsed++; return 2; }
    // Dim levels get a sub-budget so a cluster of far levels drawn early
    // cannot spend the whole cap before a hot level drawn later asks for it.
    if (!isHot && d < CTX_FAR && dimUsed < 3 && wideUsed < CTX_MAX_WIDE - 2) {
      wideUsed++; dimUsed++; return 1;
    }
    return 0;
  };
  const ctxTick = (px, tag, must) => {
    if (px < lo || px > hi) return false;
    const t = Math.round(y(px)) + 0.5;
    ctx.strokeStyle = CC.s1; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(axisR + 1, t); ctx.lineTo(axisR + 5, t); ctx.stroke();
    // `must` = the legend has already PROMISED this level by name, so its tag
    // cannot be left to win the nearest-above/nearest-below contest below.
    // Measured: with the heat gutter live, VOLUME PROFILE degrades to the POC
    // and its legend says "POC level only" — but the POC lost that contest and
    // printed no label at all, leaving a 4px unnamed tick under a sentence
    // naming it. A promise made in the legend has to be kept on the canvas.
    dormant.push({ px, y: y(px), tag, must: !!must });
    return true;
  };

  /* ── the owner's ruler claims its label rows FIRST ────────────────────

     drawLevel used to end in a bare ctx.fillText — the last label family on
     this canvas still outside the lane allocator. Measured in the shipping
     build, ruler parked on the two S/R levels in view: "ENTRY 63,294" at row
     109.5 spanning x 6-85.5 against "63,290 · 5 touches" at row 109.5
     spanning x 53.5-172.7 (32.0px of overprint), and the STOP label at row
     134 sitting on the whole of "62,748 · 2 touches" at row 134 (119.2px —
     the S/R label entirely inside it). Same rows, same baseline, both.

     PRIORITY — which is why the claim lives up here and not where it paints.
     The ruler draws near-last, so a lanes.place() at the paint site would
     lose every tie: the owner's own plan yielding to a level a detector
     guessed at. Claiming ahead of the other "left" callers is how this file
     already spells priority (the live price tag reserves its axis slot just
     below, ahead of the round numbers, for exactly this reason). So the
     ruler goes first and S/R, whales and the rest bend around it.

     What may yield, in order: the wall note, then the price, then the label
     itself — the rung ladder, longest first. Never the ROW: offsets are [0],
     because the label sits 3px above its own line and one row of drift would
     hang a price off the neighbouring line. And never the LINE, which
     drawLevel paints unconditionally. A contested row is worked ALONG rather
     than abandoned — placeRun slides the label rightwards past whatever
     holds it, which is the case it was written for. */
  const ru = state.ruler;
  const ruOn = ru.entry != null && ru.coin === state.sel;
  const ruPlan = { entry: null, stop: null, target: null };
  // Liquidity context: a level sitting on a wall behaves very differently
  // from one hanging in a void.
  // "thin" only means thin if the book actually covers that price. Outside
  // the aggregated window we know nothing, and a stale book knows nothing.
  const wallNote = (px) => {
    const H = state.heat;
    if (!state.inds.heat || !H.live || H.coin !== state.sel) return "";
    if (Date.now() - H.at > HEAT_STALE_MS) return "  ·  book stale";
    const pxs = H.live.map((r) => r[0]);
    if (px < Math.min(...pxs) || px > Math.max(...pxs))
      return "  ·  beyond book range";
    const sz = H.live.map((r) => r[1]).sort((a, b) => a - b);
    const typical = sz[Math.floor(sz.length * 0.5)] || 0;
    const hit = H.live
      .filter((r) => Math.abs(r[0] - px) <= Math.max(px * 0.0015, H.bucketW || 0))
      .sort((a, b) => b[1] - a[1])[0];
    if (!hit) return "  ·  no resting size";
    return hit[1] >= typical
      ? `  ·  $${fmtBig(hit[1])} resting`
      : `  ·  thin ($${fmtBig(hit[1])})`;
  };
  if (ruOn) {
    // Callers MUST set the font before measuring, and this measures for a
    // paint ~1200 lines below that sets the same CHART_FONT_M.
    ctx.font = CHART_FONT_M;
    // plotL + 4, not the old hardcoded 6: with the volume profile on, plotL
    // is 50-100px and the ruler labels printed straight over the VP
    // histogram. Every other left-column label already anchors to plotL.
    const ruX = plotL + 4;
    // 0..H, i.e. no row gate at all — the offsets are [0], so the only row
    // this can ever claim is the one its own line is on.
    const ruClaim = (px, cands) => ({
      cands,
      slot: lanes.placeRun("left", y(px) - 3, 14, [0], 0, H,
                           cands.map((c) => ctx.measureText(c).width),
                           ruX, openR),
    });
    ruPlan.entry = ruClaim(ru.entry,
      [`ENTRY ${fmtPx(ru.entry)}`, "ENTRY"]);
    if (ru.stop != null) {
      const riskPct = Math.abs(ru.entry - ru.stop) / ru.entry * 100;
      const stopHead = `STOP ${fmtPx(ru.stop)}  risk ${riskPct.toFixed(2)}%`;
      ruPlan.stop = ruClaim(ru.stop,
        [stopHead + wallNote(ru.stop), stopHead, `STOP ${fmtPx(ru.stop)}`, "STOP"]);
    }
    if (ru.target != null) {
      // R:R needs a stop to be a ratio at all. The old line divided by it
      // unguarded and would have printed "R:R NaN" — a confident-looking
      // number for an undefined one. No stop, no ratio, and the label says
      // only what it knows.
      const rr = ru.stop != null
        ? Math.abs(ru.target - ru.entry) / Math.abs(ru.entry - ru.stop) : null;
      const tgtHead = `TARGET ${fmtPx(ru.target)}` +
        (rr != null && isFinite(rr) ? `  R:R ${rr.toFixed(2)}` : "");
      ruPlan.target = ruClaim(ru.target,
        [tgtHead + wallNote(ru.target), tgtHead, `TARGET ${fmtPx(ru.target)}`, "TARGET"]);
    }
  }

  /* ── PEEK / PIN plates claim HERE and paint LAST ──────────────────────

     Same idiom as the ruler directly above, and for the same reason: these
     paint after every automatic layer, so a lanes.place() at the paint site
     would lose every tie to a level a detector guessed at. Claim order IS
     the priority statement, and it reads ruler > pin > peek > automatic —
     the owner's plan first, then what he deliberately held open, then what
     he is merely pointing at, then everything the chart decided by itself.

     Position comes from the object's DATA coordinates against THIS frame's
     cx()/y(), never from the pixels recorded when the pointer hit it.
     Existence comes from HITS_LAST, the last COMPLETED frame — the layers
     that register these objects run ~2,000 lines below this point, so the
     accumulator is empty here and only the finished frame can answer. An
     object that has left the window is simply not drawn: nothing is
     invented for it, and the pin is HELD, not dropped, exactly as the
     ruler's plan is held while another symbol is charted. */
  const plates = [];
  const platePlan = (o) => {
    const live = HITS_LAST.find((hh) => hh.key === o.key);
    if (!live) return;                       // off the window this frame
    const rows = peekRows(o);
    if (!rows.length) return;
    const title = peekTitle(o);
    ctx.font = CHART_FONT_S;
    let bw = ctx.measureText(title).width + 10;
    for (const [k, v] of rows)
      bw = Math.max(bw, ctx.measureText(k).width +
                        ctx.measureText(v).width + 20);
    bw = Math.min(230, Math.ceil(bw));
    const bh = rows.length * PLATE_RH + PLATE_HEAD;
    const ax = live.ms != null
      ? (live.kind === "wevent" ? cxT(live.ms) : cx(live.ms))
      : live.fx;
    const ay = live.px != null ? y(live.px) : live.fy;
    // Edge-flip and clamp, both taken verbatim from the footprint box —
    // that clamp logic is already correct and there is no second opinion
    // worth having about where a plate may not go.
    let bx = ax + 10;
    if (bx + bw > plotR) bx = Math.max(plotL + 2, ax - bw - 10);
    const byTop = padT + 2, byBot = H - priceB - bh - 4;
    const by0 = Math.max(byTop, Math.min(ay - 8, byBot));
    const freeAt = (yy) => {
      if (yy < byTop || yy > byBot) return false;
      for (let r = yy + 6; r < yy + bh; r += 14)
        if (!lanes.free("left", r, 14, bx, bx + bw)) return false;
      return true;
    };
    let by = by0;
    for (const dy of [0, 14, -14, 28, -28, 42, -42, 56, -56])
      if (freeAt(by0 + dy)) { by = by0 + dy; break; }
    for (let r = by + 6; r < by + bh; r += 14) {
      lanes.place("left", r, 14, bx, bx + bw);
      // A plate reaching into the book column has to be seen by the gutter's
      // own labels too — one region, one arbiter, no exceptions.
      if (bx + bw > gutterL) lanes.place("book", r, 14);
    }
    plates.push({ o, rows, title, bx, by, bw, bh, ax, ay,
                  pinned: !!o.pinned });
  };
  if (PINS.coin === state.sel)
    for (const p of PINS.list)
      if (p.iv == null || p.iv === state.interval) platePlan(p);
  // One peek at a time, ever — and never a second copy of something pinned.
  if (PEEK.obj && !PINS.list.some((p) => p.key === PEEK.obj.key))
    platePlan(PEEK.obj);

  // grid + right axis — at ROUND price levels, not span/4 arbitrary ones.
  // "64,000" on a gridline is verifiable at a glance; "63,847" is noise.
  ctx.strokeStyle = CC.grid; ctx.fillStyle = CC.s2; ctx.font = CHART_FONT_M;
  ctx.textAlign = "left";
  const rawStep = span / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag)
    .find((st) => span / st <= 7) || 10 * mag;
  // The live price tag is painted much later but reserves its axis slot
  // now, because when the market sits near a round number the tag and that
  // gridline's label land on the same 9px and print through each other.
  // Reserving first makes the priority explicit: the price you are trading
  // beats the round number next to it.
  lanes.place("axis", y(cs[n - 1].c), 13);
  /* The grid stops at openR, not axisR. The book and whale-order columns to
     its right are separate instruments with their own vocabularies; running
     the price grid underneath them was only invisible because a #0a121780
     rectangle was painted over it, and that rectangle is gone (see the book
     block — it measured 12% of the pane at a contrast of 3/765). */
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const yy = Math.round(y(p)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(openR, yy); ctx.stroke();
    if (lanes.place("axis", yy, 13)) ctx.fillText(fmtPx(p), axisR + 6, yy + 3);
  }
  // time labels
  ctx.textAlign = "center";
  /* Time labels on ROUND clock boundaries, chosen in time, not in bars.

     The old loop stepped the bar INDEX by n/6. On the default view (140
     hourly bars, 6 ticks) that step is exactly 24 hours, so all six labels
     printed the same clock time — measured live, the axis read
     "05:00  05:00  05:00  05:00  05:00  05:00". It was not a formatting
     bug; dividing a bar count can land on any period, and whenever it
     lands on a multiple of a day the axis silently stops carrying
     information.

     Same treatment as the price gridlines: pick the smallest step from a
     ladder of human clock intervals that keeps the label count sane, then
     label the boundaries themselves. A step that crosses days shows the
     date, so the axis can never repeat itself again. */
  const MIN_LABEL_PX = 54;                    // widest label + breathing room
  const STEPS_MS = [60e3, 5*60e3, 15*60e3, 30*60e3, 3600e3, 2*3600e3,
                    4*3600e3, 6*3600e3, 12*3600e3, 86400e3, 2*86400e3,
                    7*86400e3, 14*86400e3, 30*86400e3];
  const spanMs = (+cs[n - 1].t + barMs) - +cs[0].t;
  const maxLabels = Math.max(2, Math.floor(plotW / MIN_LABEL_PX));
  const stepMsAxis = STEPS_MS.find((st) => spanMs / st <= maxLabels) ||
                     STEPS_MS[STEPS_MS.length - 1];
  const dayStep = stepMsAxis >= 86400e3;
  const firstTick = Math.ceil(+cs[0].t / stepMsAxis) * stepMsAxis;
  for (let tms = firstTick; tms <= +cs[n - 1].t + barMs; tms += stepMsAxis) {
    const px = cx(tms);
    // Time labels are centre-aligned, so a tick sitting 2px inside the plot
    // still writes ~18px beyond it — off the left edge of the canvas, or into
    // the price axis on top of the "UTC" tag. Reserve half a label.
    if (px < plotL + 17 || px > plotR - 17) continue;
    const d = new Date(tms);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    // Midnight is the one tick that must name its date even on an
    // intraday step, or a multi-day window reads as one long day.
    const isMidnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
    const lab = dayStep || isMidnight
      ? (d.getUTCMonth() + 1) + "/" + d.getUTCDate()
      : hh + ":" + mm;
    ctx.fillStyle = isMidnight && !dayStep ? CC.s3 : CC.s2;
    ctx.fillText(lab, px, H - 8);
    // A faint tick joins the label to the plot it indexes.
    ctx.strokeStyle = CC.grid;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, H - stackB);
    ctx.lineTo(Math.round(px) + 0.5, H - stackB + 3);
    ctx.stroke();
  }
  ctx.fillStyle = CC.s2;
  // The axis is UTC (HL candle buckets are UTC-aligned), the tape is IST,
  // the clock is IST: label the axis so 15:00-above-20:30 stops looking
  // like a bug. Deliberately NOT converted to IST — daily candles would
  // render their boundaries at 05:30.
  ctx.textAlign = "right";
  ctx.fillStyle = CC.s1;
  ctx.fillText("UTC", W - 6, H - 8);
  /* ── expected move: a boundary, never a region ────────────────────────

     What this was: `ctx.fillStyle = "#ff9f0a12"; ctx.fillRect(plotL, y(evUp),
     plotR - plotL, y(evDn) - y(evUp))`, gated by nothing in state.inds —
     the only layer on the canvas no toggle could disable. Measured live it
     covered 52.6% of the pane HEIGHT at 100% width and accounted for 86% of
     every lit pixel in the default view, at a contrast of 27 out of 765:
     a haze, not a level. Deleting that one call took the default pane from
     62% lit to 21%.

     Three changes, in order of how much each buys:
       1. The fill is gone. A band's information is its two edges.
       2. It is behind `state.inds.ev`, default OFF.
       3. Even switched on it only reaches the plot when the event is within
          48h. A ±1.19% ONE-DAY estimate for an OPEX eight days out is a
          calendar entry — it belongs in the EVENT RADAR pane, not painted
          across 140 past bars. Beyond 48h it is two ticks on the price
          scale, which is what an unreachable price annotation is.
     And it no longer widens the price scale; see the evOn block above. */
  let evChip = "";
  if (evOn) {
    const evHrs = (Date.parse(ev.date + "T00:00:00Z") - Date.now()) / 3600000;
    const evNear = evHrs <= 48;
    const evClamp = (p) => Math.max(padT + 1, Math.min(H - priceB - 1, y(p)));
    ctx.font = CHART_FONT_M;
    if (!evNear) {
      // dormant: two ticks on the price scale, nothing across the plot
      for (const p of [evUp, evDn]) ctxTick(p, "±" + ev.expected_move_pct.toFixed(2) + "%");
    } else {
      // Achromatic, not amber. This is a forecast, not a polarity and not
      // the live price — and amber was carrying seven unrelated meanings,
      // of which "the price the market is at" is the one worth keeping.
      // [2,2] is the sole forecast rhythm on the canvas.
      ctx.strokeStyle = CC.s3; ctx.setLineDash(D_FCST);
      for (const p of [evUp, evDn]) {
        const yy = evClamp(p);
        ctx.beginPath(); ctx.moveTo(plotL, yy); ctx.lineTo(openR, yy); ctx.stroke();
        // An edge outside the drawn range clamps to the border and says so
        // with a caret, rather than silently rescaling the instrument.
        if (p > hi || p < lo) {
          ctx.fillStyle = CC.s3;
          ctx.textAlign = "right";
          ctx.fillText(p > hi ? "▲ above view" : "▼ below view", openR - 2,
                       yy + (p > hi ? 10 : -3));
          ctx.textAlign = "left";
        }
      }
      ctx.setLineDash([]);
    }
    // "OPEX ±1.19%" asked the reader to know an abbreviation AND to guess a
    // horizon: 1.19% by the 21st, on the 21st, or intraday? It is a ONE-DAY
    // expected move, so the label says so. The event name is spelled out
    // for the same reason "W" was: this is the only place the word appears.
    const evName = { opex: "OPTIONS EXPIRY", fomc: "FOMC", cpi: "CPI",
                     nfp: "JOBS REPORT" }[ev.event_type] ||
                   ev.event_type.toUpperCase();
    const pct = ev.expected_move_pct.toFixed(2);
    // Drawn at plotL+4, not a hardcoded x=6: with the volume profile on,
    // plotL is 50-100px, so this printed straight over the VP histogram.
    // Every other left-column label already anchors to plotL.
    const evCands = [
      `${evName} ${ev.date} · expected 1-day move ±${pct}%`,
      `${evName} ${ev.date} · 1-day move ±${pct}%`,
      `${evName} · 1-day move ±${pct}%`,
      `${evName} ±${pct}%`,
    ];
    // Only the NEAR case earns a plot-width label. Beyond 48h the two axis
    // ticks plus the legend chip carry it, and the chip states the distance
    // in days — which is the fact that decides whether it matters at all.
    if (evNear && lanes.place("left", evClamp(evUp) - 4, 14,
                              plotL + 4, plotL + 4 + widest(evCands))) {
      ctx.fillStyle = CC.s3; ctx.textAlign = "left";
      const evTxt = fitText(ctx, evCands, openR - (plotL + 4));
      if (evTxt) ctx.fillText(evTxt, plotL + 4, evClamp(evUp) - 4);
    }
    evChip = `<span class="li" style="color:${CC.s3}">${esc(evName)} ${esc(ev.date)} ` +
      `<i style="color:${CC.s3}">· 1-day move ±${pct}%` +
      (evNear ? ` · dashed edges = forecast, never traded`
              : ` · ${Math.max(0, Math.round(evHrs / 24))}d out — axis ticks only`) +
      `</i></span>`;
  }
  const legend = [];
  /* A failing refresh over bars that DID load must not be silent.

     loadCandles keeps the last good series when the venue errors — right, a
     price that traded is still a price that traded — but the chart then looks
     exactly like a live one. This is the row that stops it looking live. It
     is first in the legend on purpose: everything after it is derived from
     the series this row is casting doubt on. */
  if (state.candlesNote && state.candlesNote.kind === "error" &&
      state.candlesNote.coin === state.sel &&
      state.candlesNote.interval === state.interval) {
    const agoS = Math.max(0, Math.round((Date.now() - state.candlesNote.at) / 1000));
    legend.push(`<span class="li" style="color:${CC.alarm}" ` +
      `title="${esc(state.candlesNote.text)}">⚠ CANDLE REFRESH FAILING ` +
      `<i style="color:${CC.alarm}">· these bars are the last good fetch, ` +
      `${agoS}s ago · not the current market</i></span>`);
  }
  if (evChip) legend.push(evChip);
  // liquidity heatmap — confined to a right-hand gutter so it informs the
  // price action instead of burying it. History flows left->right toward the
  // live ladder at the right edge; the walls that matter get named.
  /* ── volume profile: RIGHT column tenant ──────────────────────────────

     It used to own a reserved gutter on the LEFT, 60.94px wide, and the
     price action paid for it. Two things were wrong with that and neither
     was the profile itself. First, it cost 11.7% of plot width to a layer
     that is off by default. Second, the histogram sat at x <= 60.94 while
     the POC label that names it was left-anchored just to its right and the
     level it marks ran the full width of the pane — the picture and its noun
     at opposite ends of the instrument.

     As the right column's tenant it gets 84px instead of 60.94 — WIDER —
     costs the plot nothing when the tenant is "none", and its bars grow
     LEFT from the price axis, so the profile's own peak and the POC label
     that names it land on the same edge. */
  if (state.inds.vp) {
    // 40 bins with a column to draw them in, 24 without (the POC line and
    // its label still draw when the column stood down for width).
    const vp = volumeProfile(cs, colShows && colTenant === "vp" ? 40 : 24);
    if (colShows && colTenant === "vp") {
      const va = valueArea(vp, 0.7);
      const bh = Math.max(1.5, (H - padT - priceB) / vp.B - 1);
      for (let i = 0; i < vp.B; i++) {
        if (!vp.buckets[i]) continue;
        const py = y(vp.bucketPx(i));
        const bw3 = (vp.buckets[i] / vp.max) * (colW - 3);
        const inVA = vp.bucketPx(i) >= va.lo && vp.bucketPx(i) <= va.hi;
        // The POC bucket is the peak of THIS histogram, so it stays in the
        // histogram's own hue at full weight. It used to be #ff9f0a99 —
        // the live-price amber — which made the most-traded price look like
        // the current price inside a blue column.
        ctx.fillStyle = i === vp.pocIdx ? CC.vol
          : inVA ? alpha(CC.vol, A_MID) : alpha(CC.vol, A_FAINT);
        // Right-anchored at the price axis, growing LEFT. On the left gutter
        // this grew right, toward the candles; here it grows away from them.
        ctx.fillRect(axisR - bw3, py - bh / 2, bw3, bh);
      }
      /* Value area: two boundary ticks, not a region fill. The fill measured
         3.8% of the pane at contrast 23/765 — larger than the histogram it
         qualifies and 5.6x fainter than it. Membership is already encoded by
         bar lightness, so the wash was saying the same thing a second time
         and less legibly. */
      ctx.strokeStyle = alpha(CC.vol, A_MID); ctx.lineWidth = 1;
      for (const p of [va.hi, va.lo]) {
        const vy = Math.round(y(p)) + 0.5;
        ctx.beginPath(); ctx.moveTo(colL, vy); ctx.lineTo(axisR, vy); ctx.stroke();
      }
      ctx.strokeStyle = CC.grid;
      ctx.beginPath(); ctx.moveTo(colL - 0.5, padT);
      ctx.lineTo(colL - 0.5, H - priceB); ctx.stroke();
      /* Lane "gutter", NOT lane "left".

         Lane "left" holds the EMA/VWAP/BOLL head tags, the S/R names, the
         POC label in its fallback position and the whale cohort lines — all
         of which live in or reach across the PLOT. This header used to claim
         in "left" while sitting at x=1, which was harmless there and would
         be catastrophic here: at x≈572 it would be claiming a row in the
         exact region where those tags paint, and the recorded collision in
         this file (BOLL over $5.4M, 1–4px apart in y) is that shape exactly.
         The column is a separate region, so it gets a separate lane. */
      ctx.fillStyle = CC.s2; ctx.font = CHART_FONT_S; ctx.textAlign = "right";
      const vpHdr = fitText(ctx, ["VOL PROFILE", "VOL PROF", "VP"], colW - 4);
      if (vpHdr && lanes.place("gutter", padT + 9, 14))
        ctx.fillText(vpHdr, axisR - 3, padT + 9);
      ctx.textAlign = "left";
      // Was "VP·POC 63,509 VA 63,100–64,200" — an entry that answered three
      // initialisms with three more. The legend is the one place on this
      // instrument where words are free, so it spends them.
      legend.push(`<span class="li" style="color:${CC.vol}">VOLUME PROFILE ` +
        `<i style="color:${CC.s3}">right column · value area ${fmtPx(va.lo)}–${fmtPx(va.hi)}` +
        ` · volume is spread across each bar's high–low range, not pinned to its typical price` +
        `</i></span>`);
    } else {
      // Says WHICH constraint stood the column down. "VP needs width" was
      // the only rung and it was wrong whenever heat owned the right edge.
      legend.push(`<span class="li" style="color:${CC.s3}">VOLUME PROFILE ` +
        `<i style="color:${CC.s3}">` + (gutterFits
          ? "column yielded to the heatmap gutter — POC level only"
          : "not enough width for the column — POC level only") + `</i></span>`);
    }
    /* POC: off [2,3] and off amber.

       [2,3] was shared with the whale SHORT cohort line — two full-width
       horizontal levels, both drawn whenever VP is on, in one rhythm. The
       comment on the whale layer states outright that dash rhythm is its
       colourblind side channel, so the collision made that channel useless.
       POC moves to [7,4], the "price memory" rhythm it shares with S/R
       (hue separates those two: blue = a volume statistic, grey = a touch
       count), and [2,3] becomes the whale short line's alone.

       It also earns its width now like every other context level. */
    const pocTier = ctxTier("poc", vp.pocPx);
    // When the column drew the histogram, the POC is already visible inside it
    // and the tick is a bonus. When the column stood down, the legend says
    // "POC level only" and this tick IS the whole of what survived — so it is
    // promised, and must carry its name.
    if (pocTier === 0)
      ctxTick(vp.pocPx, "POC " + fmtPx(vp.pocPx), !(colShows && colTenant === "vp"));
    else {
      ctx.strokeStyle = pocTier === 2 ? CC.vol : alpha(CC.vol, A_FAINT);
      ctx.setLineDash(D_CTX);
      ctx.beginPath(); ctx.moveTo(plotL, y(vp.pocPx)); ctx.lineTo(openR, y(vp.pocPx)); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.font = CHART_FONT_M;
    /* The POC label follows its histogram into the column when the column is
       there, and stays at the left end of its own line when it is not.

       Both placements are defensible and the wrong one is the one that
       splits the mark: a label at plotL+4 with the bars it summarises 570px
       away is two objects, not one. In the column it claims lane "gutter"
       with the header; in the fallback it claims lane "left" with S/R and
       the cohort lines, exactly as before. */
    if (pocTier > 0 && colShows && colTenant === "vp") {
      const pocCol = ["POC " + fmtPx(vp.pocPx), "POC"];
      if (lanes.place("gutter", y(vp.pocPx) - 3, 14)) {
        const t = fitText(ctx, pocCol, colW - 4);
        if (t) {
          ctx.fillStyle = pocTier === 2 ? CC.vol : CC.s2; ctx.textAlign = "right";
          ctx.fillText(t, axisR - 3, y(vp.pocPx) - 3);
          ctx.textAlign = "left";
        }
      }
    } else if (pocTier > 0) {
      // POC is standard futures vocabulary and still an initialism. There is
      // ~500px of empty plot to the right of this label, so the expansion is
      // free — and this chart is read at 2am, not in an exam.
      const pocCands = [
        "POC " + fmtPx(vp.pocPx) + " most-traded price",
        "POC " + fmtPx(vp.pocPx) + " most-traded",
        "POC " + fmtPx(vp.pocPx),
      ];
      if (lanes.place("left", y(vp.pocPx) - 3, 14,
                      plotL + 4, plotL + 4 + widest(pocCands))) {
        ctx.fillStyle = pocTier === 2 ? CC.vol : CC.s2; ctx.textAlign = "left";
        const pocTxt = fitText(ctx, pocCands, openR - (plotL + 4));
        if (pocTxt) ctx.fillText(pocTxt, plotL + 4, y(vp.pocPx) - 3);
      }
    }
  }
  /* ── the liquidity heat WASH is gone ───────────────────────────────────

     What was here: one full-plot-width fillRect per book level, 29 of them,
     at alpha 0.02–0.15 (x0.4 again when stale). Measured: 68.7% of the pane
     with everything on and 71.9% of all lit pixels, at a mean contrast of
     26.9 out of 765 and a MAX of 41. It was the largest mark on the canvas
     by a factor of nearly two and it sat at the threshold of visibility —
     and when the book went stale it became strictly invisible while still
     costing two thirds of the pane.

     It was also the SAME BOOK the heat gutter renders 20px to the right,
     with history and named walls, in a different palette: a reader who
     learned "teal = bid" from the wash met "green = bid" immediately after.
     One instrument, drawn twice, in two vocabularies. The gutter shows
     strictly more, so the wash is deleted rather than confined — including
     its teal/rose labels and the desaturated pair itself, which no longer
     appears anywhere on this canvas.

     The walls that mattered are not lost: they re-enter through the gutter's
     own named-wall pass below, and now earn plot width through ctxTier()
     like every other context level. */

  // support / resistance = calendar-anchored PRIOR-PERIOD EXTREMES.
  // The method, the null result and the fail-closed rule are at
  // priorPeriodLevels(); this block only decides how much plot each level
  // earns and refuses to draw one it cannot name.
  if (state.inds.sr) {
    // No inner `const last` here any more: it shadowed the outer one with a
    // byte-identical right-hand side, which is how two derivations of the
    // same number drift apart in this file.
    // S/R labels used to sit at plotR-4, i.e. inside the same 10px column
    // as the price axis, the book's wall labels and the last-price tag.
    // They are full-width horizontal lines, so the left end names them just
    // as well and leaves the right edge to the instruments that can only
    // live there. The line itself stops short of the book gutter.
    const srR = openR, srX = plotL + 3;
    ctx.font = CHART_FONT_M;
    /* S/R is no longer green/red.

       `const isRes = l.px >= last` coloured a level by whether it sits ABOVE
       or BELOW the current price — a third semantic on a hue pair already
       carrying candle direction, book side, whale side and five other
       things. It read backwards against the candle convention (a green
       candle means the bar went UP; a green S/R meant the level is DOWN),
       and the level FLIPPED HUE as price crossed it: the same level changed
       colour without changing anything about itself, because the colour was
       reporting where price is, not what the level is.

       Above/below is already drawn — the always-on live-price line is right
       there, and the label states the price. So the hue leaves, and the two
       tiers of grey now say the thing worth saying instead: how close price
       is to getting here. */
    const sr = srLevelSet();
    if (!sr || !sr.levels.length) {
      /* FAIL CLOSED, and SAY SO. This is the sharpest risk in the whole
         rewrite: levels drawn from a daily series that failed to load, or
         that does not reach back far enough, would be the house invariant
         broken in its purest form — a price presented as history that was
         never measured. No series, no lines, and the reason on the glass. */
      const why = (sr && sr.why) || "the daily series has not loaded yet";
      legend.push(`<span class="li" style="color:${CC.alarm}" ` +
        `title="${esc(SR_VERDICT + "  ·  " + SR_CAVEAT_UTC)}">` +
        `⚠ S/R UNAVAILABLE · ${esc(why)}</span>`);
    } else {
      /* Nearest-first, so ctxTier's reach budget is spent on the levels
         price is closest to. Levels outside the drawn price band are not
         drawn at all — that is the set limiting ITSELF, which is why there
         is no cap, no sort by importance and no ranking here.

         Measured on 12 symbols: 12 raw levels each (9 where the listing is
         younger than the prior quarter), of which a median of 9 fall inside
         a 150-bar 4h window, of which ctxTier promotes a median of 4 (max 5)
         to full-width lines and demotes the rest to 4px axis ticks. On 1h it
         is a median of 2 lines. Ranking is refuted anyway — in the same
         study touch-count ordering runs BACKWARDS (2 touches 61.48%, 8+
         touches 56.10%) — so the old "N touches" suffix is gone outright and
         the name carries the provenance instead. */
      const inView = sr.levels.filter((l) => l.px >= lo && l.px <= hi)
        .sort((a, b) => Math.abs(a.px - last) - Math.abs(b.px - last));
      let lines = 0, far = 0, noRoom = 0;
      for (const l of inView) {
        const nm = l.names.join("·");
        const tag = `${nm} ${fmtPx(l.px)}`;
        const tier = ctxTier("sr", l.px);
        if (tier === 0) { ctxTick(l.px, tag); far++; continue; }
        const yy = y(l.px);
        /* THE LINE IS NOT DRAWN UNLESS ITS NAME CAN BE PRINTED.

           It used to be the other way round: the lane claim guarded only the
           fillText, so a lost row left a dashed full-width line with no
           price and no noun on it — 1 of 3 S/R labels was being dropped, and
           an unnamed line across the pane is the owner's complaint in its
           purest form. A level that cannot be named now falls back to the
           4px axis tick, which still says a level is there and still carries
           its name into the dormant roster.

           placeRun, not place: every x on a full-width line is equally "on
           the line", so a blocked left edge is a reason to slide RIGHT along
           the row, not to give up — the ruler's own labels have worked this
           way for a while, and it is why the fallback should be rare.
           Offsets are [0] for the same reason they are there: the label sits
           3px above its own line and one row of drift would hang a price off
           the neighbouring level.

           The reach slot ctxTier already charged for this level is left
           spent. Conservative on purpose: refunding it would promote a later
           level into a row that has just proved unusable. */
        const cands = [...new Set([tag, `${l.names[0]} ${fmtPx(l.px)}`, nm,
                                   l.names[0]])]
          .sort((a, b) => ctx.measureText(b).width - ctx.measureText(a).width);
        const slot = lanes.placeRun("left", yy - 3, 14, [0], 0, H,
                                    cands.map((c) => ctx.measureText(c).width),
                                    srX, srR);
        if (!slot) { ctxTick(l.px, tag); noRoom++; continue; }
        ctx.strokeStyle = tier === 2 ? alpha(CC.s3, A_MID) : alpha(CC.s2, A_FAINT);
        ctx.setLineDash(D_CTX);
        ctx.beginPath(); ctx.moveTo(plotL, yy); ctx.lineTo(srR, yy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = tier === 2 ? CC.s3 : CC.s2;
        ctx.textAlign = "left";
        ctx.fillText(cands[slot.i], slot.x, slot.y);
        lines++;
      }
      ctx.textAlign = "left";
      /* The legend states the COUNT of each outcome, not just the layer's
         name: a reader who can see "3 lines · 5 out of reach" knows the
         chart is holding levels it chose not to draw, which is the whole
         difference between a quiet chart and a lying one. */
      const bits = [`${lines} line${lines === 1 ? "" : "s"}`];
      if (far) bits.push(`${far} out of reach`);
      if (noRoom) bits.push(`${noRoom} no room to name`);
      const gappy = sr.levels.filter((l) => l.gaps > 0);
      const srTitle = SR_VERDICT + "  ·  " + SR_CAVEAT_UTC +
        (sr.asOf ? "  ·  Daily series through " + srYmd(sr.asOf) + " UTC." : "") +
        (sr.skipped.length
          ? "  ·  " + sr.skipped.map((s) => s.why).join("  ·  ") : "") +
        (gappy.length
          ? "  ·  " + gappy.map((l) => l.names.join("·") +
              " was measured over a period missing " + l.gaps + " daily bar" +
              (l.gaps === 1 ? "" : "s") +
              ", so the true extreme may sit in a day this series never saw")
            .join("  ·  ")
          : "");
      legend.push(`<span class="li" style="color:${CC.s3}" ` +
        `title="${esc(srTitle)}">PRIOR-PERIOD LEVELS ${bits.join(" · ")}` +
        (sr.skipped.length
          ? " · no " + sr.skipped.map((s) => "P" + s.code).join("/") : "") +
        `</span>` +
        // The verdict is VISIBLE, not only in the tooltip. #p-sides prints
        // "descriptive, not predictive" the same way for aggressor flow.
        `<span class="li" style="color:${CC.s2}" title="${esc(SR_VERDICT)}">` +
        `reference marks · not an edge (59.2% vs 60.0% random)</span>`);
      if (sr.stale || sr.err)
        legend.push(`<span class="li" style="color:${CC.alarm}" ` +
          `title="${esc((sr.err ? "Daily refresh failed: " + sr.err + ". " : "") +
            "The levels below are the last ones this series could support. " +
            SR_CAVEAT_UTC)}">⚠ S/R DAILY ` +
          `${sr.stale ? "STALE" : "REFRESH FAILED"}` +
          `${sr.asOf ? " · through " + srYmd(sr.asOf) + " UTC" : ""}</span>`);
    }
  }
  /* ── volume / delta: an OVERLAY on the price pane, not a strip under it ─

     Same two modes as before (volume, or per-candle DELTA with FP on), same
     bars, same normalisation. What changed is that they are composited into
     the bottom 18% of the price band instead of being cut out of the canvas
     above it, and that `v` can turn them off — the old strip had no gate of
     any kind. Drawn HERE, before the candles, so the wash can never sit on
     top of price; and it registers nothing with the lane allocator except
     its one caption, because 140 rects claiming rows would starve S/R, POC
     and the whale labels across the bottom fifth of the plot. */
  const vy0 = priceBot;
  const stepMs = n > 1 ? cs[1].t - cs[0].t : 0;
  const cflow = state.inds.fp ? candleFlow(stepMs) : null;
  // Per-bar delta now comes from the SERVER's 48h buckets, not the browser
  // session. Reading it from the session tape meant a chart you had just
  // opened showed one or two bars of delta and a row of dead ticks — useless
  // for reading delta across time, which is the whole point of the strip.
  const dHist = state.inds.fp ? barDelta(cs, stepMs) : null;
  /* FP with the overlay hidden is a real state and it must say so. Without
     this, pressing v while FP is on removes per-bar delta from the canvas
     and nothing anywhere reports that the layer the owner switched on is not
     being drawn — the same class of silence as the strip's old "max $1". */
  if (dHist && !volBandH)
    legend.push(`<span class="li" style="color:${CC.s3}">DELTA per bar ` +
      `<i style="color:${CC.s3}">overlay hidden — press V to show it</i></span>`);
  if (dHist && volBandH) {
    let dmax = 1, observed = 0;
    for (const c of cs) {
      const d = dHist.get(c.t);
      if (d !== undefined) { observed++; dmax = Math.max(dmax, Math.abs(d)); }
    }
    /* The zero line is what makes this strip READABLE AS DELTA.

       Measured: the volume strip and the delta strip draw the same bars, in
       the same place, in the same two hues, and swap meaning on a toggle the
       owner sets once and forgets — the only difference was alpha 0.25 vs
       0.67. On live BTC 1h, 36 of 139 bars have a delta sign OPPOSITE to
       their candle direction, so a quarter of the strip silently flips
       meaning. Now the two modes differ in FORM, which needs no caption:
       delta STRADDLES a drawn zero line, volume SITS ON THE FLOOR (and, see
       below, is grey). */
    const zero = volTop + volBandH / 2;
    ctx.strokeStyle = alpha(CC.s2, A_FAINT); ctx.setLineDash(D_REF);
    ctx.beginPath(); ctx.moveTo(plotL, zero); ctx.lineTo(plotR, zero); ctx.stroke();
    ctx.setLineDash([]);
    for (let i = 0; i < n; i++) {
      const d = dHist.get(cs[i].t);
      if (d === undefined) {
        /* Outside tape coverage: draw NOTHING.

           This was a 2px tick in CC.s1 at A_FAINT, which composites to
           1.22:1 against the panel — the faintest mark on the canvas by a
           wide margin, and comfortably under the threshold at which a pixel
           is distinguishable from the background at all. It was ink spent
           to say "no data here", in a strip whose zero line is already
           drawn and where an absent bar says the same thing by being
           absent. The DELTA legend chip states the coverage as a count
           ("112/140 bars"), which is the channel that actually carries it. */
        continue;
      }
      const bh = (Math.abs(d) / dmax) * (volBandH / 2);
      // Side is carried by which way the bar grows from the zero line; the
      // hue is the redundant channel, not the only one.
      ctx.fillStyle = d >= 0 ? alpha(CC.up, A_MID) : alpha(CC.down, A_MID);
      ctx.fillRect(x(i) - cw / 2, d >= 0 ? zero - bh : zero, cw, Math.max(1, bh));
    }
    ctx.fillStyle = CC.s2; ctx.font = CHART_FONT_M; ctx.textAlign = "left";
    /* `max $1` was not a measurement. `dmax` is initialised to 1 so it can be
       a running maximum; when the tape covers none of the window the loop
       above never runs and that initialiser reached the screen wearing the
       grammar of a real statistic — "the biggest delta bar here was one
       dollar", i.e. the market is dead. A fabricated number is worse than an
       unreadable one, because the reader has no way to know to distrust it.
       So: no coverage, no statistic. And the strip now says what delta IS,
       which it never did — buy notional minus sell notional. */
    /* Budgeted against openR, not plotR. When the book gutter draws,
       gutterFits is false so plotR === axisR and the whale rail and the book
       column both live INSIDE plotR — so a caption measured against plotR is
       measured against a container that already has 87px spoken for, and the
       fallback ladder cannot rescue it because every rung is being asked the
       wrong question. S/R, POC and the expiry band already used openR; the
       two sub-pane captions were the ones this pass lengthened and forgot. */
    const dTxt = observed === 0
      ? fitText(ctx, [
          "DELTA per bar (buy − sell $) · no tape coverage in this window",
          "DELTA per bar · no tape coverage here",
          "DELTA · no tape",
        ], openR - (plotL + 4))
      : fitText(ctx, [
          `DELTA per bar = buy − sell $  ·  ${observed}/${n} bars on tape  ·  max $${fmtBig(dmax)}`,
          `DELTA = buy − sell $ · ${observed}/${n} bars · max $${fmtBig(dmax)}`,
          `DELTA buy−sell · ${observed}/${n} bars`,
        ], openR - (plotL + 4));
    /* The caption goes through the ALLOCATOR now. It never did: it painted
       at a fixed y inside a band nothing else could enter, which was true
       while the strip was its own reserved zone and stopped being true the
       moment the band became the bottom of the price pane. It nudges rather
       than dropping — the coverage count ("112/140 bars on tape") is the
       only channel that carries partial tape coverage. */
    const dY = lanes.placeNear("left", volTop + 9, 14, [0, -14, 14, -28],
                               padT + 10, priceBot - 2,
                               plotL + 4, plotL + 4 + ctx.measureText(dTxt || "").width);
    // Through paneCap, NOT a bare fillText: paneCap is what records the drawn
    // box in paneTextBoxes, and the "no tape ◀" tape-boundary marker below
    // clears itself against exactly that registry. Drawn bare, this caption
    // was invisible to the marker's clearance test — two independent
    // placers, two disjoint registries, and the marker printed straight
    // through it. Measured: the caption and the marker resolve to the same
    // row by two different expressions.
    if (dTxt && dY != null) paneCap(dTxt, plotL + 4, dY);
    legend.push(`<span class="li" style="color:${CC.s3}">DELTA per bar ` +
      (observed === 0 ? `<i style="color:${CC.s3}">no tape coverage</i>`
                      : `${observed}/${n} bars`) + `</span>`);
  } else if (volBandH) {
    /* Volume goes GREY.

       `up = c.c >= c.o` — this strip was coloured by CANDLE DIRECTION, not
       by flow. So its 5,013 px² of green and red restated, at a quarter
       opacity, the fact drawn immediately above it in full opacity, while
       occupying the exact pixels that mean something entirely different the
       moment FP is switched on. It encoded nothing the candle did not
       already carry, and it cost one of the two hues the chart can least
       afford to spend. Bar HEIGHT is the datum here; direction never was. */
    const vmax = Math.max(...cs.map((c) => c.v)) || 1;
    ctx.fillStyle = alpha(CC.s2, A_FAINT);
    for (let i = 0; i < n; i++) {
      const vh = (cs[i].v / vmax) * volBandH;
      ctx.fillRect(x(i) - cw / 2, vy0 - vh, cw, vh);
    }
    /* The overlay says what it is, which the strip never had to: as a
       reserved band its position WAS its caption, and inside the price pane
       it no longer is. One row, arbitrated like every other piece of text on
       this canvas, and dropped rather than overprinted if the row is taken —
       the legend chip below carries the same fact where space is flat. */
    ctx.fillStyle = CC.s2; ctx.font = CHART_FONT_M; ctx.textAlign = "left";
    const vCands = [
      `VOLUME per bar · overlay, bottom 18% of the price pane · max ${fmtBig(vmax)}`,
      `VOLUME per bar · max ${fmtBig(vmax)}`,
      `VOLUME · max ${fmtBig(vmax)}`,
      `VOLUME`,
    ];
    const vTxt = fitText(ctx, vCands, openR - (plotL + 4));
    const vY = lanes.placeNear("left", volTop + 9, 14, [0, -14, 14, -28],
                               padT + 10, priceBot - 2,
                               plotL + 4, plotL + 4 + ctx.measureText(vTxt || "").width);
    // Same registry rule as the DELTA caption above — this one shares its
    // anchor row (volTop + 9) and is its mutually-exclusive twin, so it has
    // the identical collision with the tape-boundary marker.
    if (vTxt && vY != null) paneCap(vTxt, plotL + 4, vY);
    legend.push(`<span class="li" style="color:${CC.s3}">VOLUME ` +
      `<i style="color:${CC.s3}">overlay on the bottom 18% of the price pane · V hides it</i></span>`);
  }
  /* ── candles and the price overlays, clipped to the open plot ──────────

     plotR USED to run all the way to axisR whenever the book column drew,
     so the candles, the Bollinger envelope and the moving
     averages all ran UNDERNEATH the book gutter and the whale rail. That was
     invisible only because a #0a121780 rectangle was painted on top of them
     — a fill measuring 12% of the pane at a contrast of 3/765, i.e. a mark
     nobody can see whose only job was to hide marks that should not be
     there. The rectangle is deleted; a clip does the job for nothing.

     plotR is now pulled in as well — it is sized to EXCLUDE the rail and the
     right column by the one identity stated in the layout block, so openR
     and plotR are the same number and this clip has nothing left to cut. It
     stays as the backstop it always was: two derivations of one boundary is
     the shape of the bug that clipped 22 candles, and a clip that can only
     ever be a no-op is cheaper than trusting that they never diverge again.

     A clip rather than pulling plotR in was the ORIGINAL argument: plotR feeds plotW,
     and the cursor-anchored zoom maths reads the PREVIOUS frame's plotW, so
     making plotW a function of whether book data happens to have arrived
     would make every wheel click drift. Geometry stays put; only ink stops
     at the boundary. */
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, padT, Math.max(0, openR), Math.max(0, H - padT - priceB));
  ctx.clip();
  // candles
  for (let i = 0; i < n; i++) {
    const c = cs[i], up = c.c >= c.o;
    ctx.strokeStyle = ctx.fillStyle = up ? CC.up : CC.down;
    const xi = Math.round(x(i)) + 0.5;
    ctx.beginPath(); ctx.moveTo(xi, y(c.h)); ctx.lineTo(xi, y(c.l)); ctx.stroke();
    const top = Math.round(y(Math.max(c.o, c.c))), bot = Math.round(y(Math.min(c.o, c.c)));
    const bh2 = Math.max(1, bot - top);
    /* Hollow up-body once there is room for one — the oldest convention in
       the instrument, and a genuine non-hue channel for the one mark on this
       canvas that is judged relatively (an up bar next to a down bar). Below
       4px of body a hollow rect degrades to a smear, so the rule is scoped
       to where individual bars are actually read.

       It therefore does NOT fire in the view this terminal actually runs:
       140 bars in a ~583px plot gives slot 4.17 and cw 3, and cw reaches 4
       only past a ~1050px canvas. Instrumented, that was 0 hollow bodies
       against 74 solid ones — so for the default zoom the candles' entire
       redundant channel was this branch, and this branch never ran.
       The channel that does the work at 3px is LUMINANCE, built into the
       CC.up/CC.down pair itself (see the palette): the up hue is the bright
       one by construction, so an up bar is brighter than a down bar at
       every width, every alpha, and under both simulated dichromacies. The
       hollow body is now a bonus at zoom, not the load-bearing channel. */
    if (up && cw >= 4 && bh2 >= 3) {
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x(i) - cw / 2) + 0.5, top + 0.5, cw - 1, bh2 - 1);
    } else {
      ctx.fillRect(Math.round(x(i) - cw / 2), top, cw, bh2);
    }
  }

  /* NEWS FLAGS. One discrete mark above a bar that holds a material headline
     for THIS name. Multiple headlines on one bar collapse to one mark (count
     lives in the peek). Bars with none stay clean. BTC/crypto with zero
     Finnhub rows draw NOTHING — never refill from the ALL/TOP river. */
  if (state.inds.news) {
    const nc = state.newsChart;
    const heads = (nc && nc.coin === state.sel) ? (nc.news || []) : [];
    const byBar = new Map();
    const bms = barMs > 0 ? barMs : (IV_MS[state.interval] || 3600000);
    for (const hn of heads) {
      const ms = newsPubMs(hn);
      if (ms == null) continue;
      for (let i = 0; i < n; i++) {
        const t0b = +cs[i].t;
        if (ms >= t0b && ms < t0b + bms) {
          if (!byBar.has(i)) byBar.set(i, []);
          byBar.get(i).push(hn);
          break;
        }
      }
    }
    ctx.setLineDash([]);
    for (const [i, list] of byBar) {
      const c = cs[i];
      const gx = x(i);
      const gy = Math.max(padT + 5, y(c.h) - 6);
      if (gy > H - priceB - 4) continue;
      ctx.fillStyle = CC.live;
      ctx.beginPath();
      ctx.moveTo(gx, gy - 3);
      ctx.lineTo(gx + 3, gy);
      ctx.lineTo(gx, gy + 3);
      ctx.lineTo(gx - 3, gy);
      ctx.closePath();
      ctx.fill();
      hitAdd({ kind: "news", key: "news:" + c.t,
               x: gx, y: gy, r: 7, prio: 2,
               ms: +c.t, px: c.h, perBar: true,
               d: { heads: list },
               title: list.length > 1
                 ? (list.length + " headlines")
                 : (baseSym(state.sel) + " NEWS") });
    }
    const nBars = byBar.size;
    const meta = (nc && nc.coin === state.sel) ? nc.meta : null;
    const nm = baseSym(state.sel);
    if (nBars)
      legend.push(`<span class="li" style="color:${CC.live}">NEWS · ${nBars} bar${nBars === 1 ? "" : "s"} with headlines</span>`);
    else if (meta && meta.total === 0)
      legend.push(`<span class="li" style="color:${CC.s3}">NEWS · no material headlines for ${esc(nm)} — this name, not a quiet market</span>`);
    else
      legend.push(`<span class="li" style="color:${CC.s3}">NEWS · no headlines on these bars for ${esc(nm)}</span>`);
  }

  // indicator overlays
  const plotLine = (series, color, dash, lw) => {
    ctx.strokeStyle = color; ctx.lineWidth = lw || 1.2;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      if (series[i] == null) continue;
      const yy = y(series[i]);
      if (!started) { ctx.moveTo(x(i), yy); started = true; }
      else ctx.lineTo(x(i), yy);
    }
    ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
  };
  /* A curve is NAMED AT ITS HEAD, not decoded from a legend key.

     Three smoothed-price overlays used to be told apart only by hue —
     #35d0e0, #c084fc, #ffb84d — which meant the reader had to colour-match a
     chip in a corner to a line in the plot, and two of those hues were doing
     other jobs elsewhere on the same canvas. Now they share one family and
     each prints its own name at its last plotted point. ~30px of 10px type
     replaces three entries in a palette that has no budget left. */
  const headTag = (series, txt, color) => {
    let i = n - 1;
    while (i >= 0 && series[i] == null) i--;
    if (i < 0) return;
    ctx.font = CHART_FONT_S;
    const w = ctx.measureText(txt).width;
    const tx = Math.min(x(i) + 4, openR - 2 - w);
    const ty = y(series[i]) + 3;
    if (ty < padT + 8 || ty > H - priceB - 2) return;
    if (!lanes.place("left", ty, 11, tx, tx + w)) return;
    ctx.fillStyle = color; ctx.textAlign = "left";
    ctx.fillText(txt, tx, ty);
  };
  if (state.inds.boll) {
    const bbF = bollSeries(all, 20, 2);
    const bb = { mid: win(bbF.mid), up: win(bbF.up), dn: win(bbF.dn) };
    /* The envelope FILL is deleted. It measured 19.3% of the pane at a
       contrast of 29/765, while its own two edges — already stroked, right
       below — carry every bit of the same information at 4x the contrast for
       one ninth of the ink. It was also grey at 8%, which is exactly the
       tone that shifts every other grey mark on the chart. Mark the
       boundary, never fill the region. */
    plotLine(bb.up, alpha(CC.s2, A_FAINT), null, 1);
    plotLine(bb.dn, alpha(CC.s2, A_FAINT), null, 1);
    plotLine(bb.mid, alpha(CC.s2, A_MID));
    const lb = bb.mid[n - 1];
    headTag(bb.mid, "BOLL", alpha(CC.s2, A_MID));
    legend.push(`<span class="li" style="color:${CC.s3}">BOLL(20,2) ${lb != null ? fmtPx(lb) : ""}</span>`);
  }
  if (state.inds.ema) {
    // One hue, two weights. EMA50 gave up #c084fc so violet could become the
    // alarm colour and stop red carrying both "down" and "broken"; a longer
    // average being a heavier line is a rule you can read without a key,
    // which #c084fc-vs-#35d0e0 never was.
    const e20 = win(emaSeries(all, 20)), e50 = win(emaSeries(all, 50));
    plotLine(e20, CC.fast, null, 1.2);
    plotLine(e50, CC.fast, null, 2.2);
    headTag(e20, "EMA20", CC.fast);
    headTag(e50, "EMA50", CC.fast);
    // Both curves name themselves at their own head on the canvas, so the
    // chips carry the value and nothing else — "thin"/"thick" was a key for
    // a distinction the reader never has to make from the legend.
    legend.push(`<span class="li" style="color:${CC.fast}">EMA20 ${e20[n-1] != null ? fmtPx(e20[n-1]) : ""}</span>`);
    legend.push(`<span class="li" style="color:${CC.fast}">EMA50 ${e50[n-1] != null ? fmtPx(e50[n-1]) : ""}</span>`);
  }
  if (state.inds.vwap) {
    // Session-anchored (UTC day), computed on the full series. Anchored at
    // "the left edge of the window" it was not VWAP at all: the line moved
    // under the cursor every time you panned, because its accumulator
    // restarted wherever you happened to be looking.
    // Solid, not [5,3]: that rhythm belonged to the trade ruler as well, and
    // a smoothed price and the owner's own plan must not share a form.
    const vw = win(vwapSeries(all, barMs < 86400000));
    plotLine(vw, CC.s3, null, 1.6);
    headTag(vw, "VWAP", CC.s3);
    legend.push(`<span class="li" style="color:${CC.s3}">VWAP${barMs < 86400000 ? "·d" : ""} ${vw[n-1] != null ? fmtPx(vw[n-1]) : ""}</span>`);
  }
  ctx.restore();                     // end of the clipped plot-content phase
  // CVD sub-pane — order flow under the price it produced.
  // Two things were wrong before: it accumulated only from the moment you
  // clicked a coin (so switching symbols zeroed it), and it mapped time to its
  // own span rather than the candles above, so it never lined up with price.
  // Now it reads the server's collected trade history and shares the chart's
  // exact time axis, with per-bucket delta bars behind the cumulative line.
  let paneIdx = 0;
  if (state.inds.cvd) {
    const cBot = paneBot(paneIdx++), cTop = cBot - paneH;
    ctx.strokeStyle = CC.grid;
    ctx.strokeRect(plotL, cTop, plotR - plotL, paneH);
    ctx.fillStyle = CC.s2; ctx.font = CHART_FONT_M; ctx.textAlign = "left";

    const fhb = (state.flowHist && state.flowHist.coin === state.sel)
      ? state.flowHist : null;
    const hist = fhb ? (fhb.series || []) : [];
    const live = (state.flow.coin === state.sel ? state.flow.points : []);

    /* THE bucket_s GUARD — this pane was the LAST flowHist consumer without
       one, and unlike its two siblings it must refuse only HALF the drawing.

       barDelta and candleFlow both test |bucket_s - want| <= 1 and hand back
       nothing when it fails. Measured on this desk with the server's 60s
       series against a 1h chart: barDelta returned 0 bars and candleFlow 0
       hist-backed bars, while THIS pane plotted 360 sixty-second buckets into
       a 140-slot plot at 3.19px each — 2.6 overprinting bars per candle slot,
       every one of them drawn ONE CANDLE (1h) wide while representing 60s,
       the largest reading $12,753,841 — under a caption that said "server
       tape · 360 samples" and meant it.

       THE ASYMMETRY IS THE POINT, and it is why this is not a copy of the
       other two. `cvd` is a RUNNING TOTAL: p.cvd is the tape's cumulative
       buy-minus-sell as of p.ms whatever width the bucket was, so re-basing
       it to the window and stroking it against the shared cx() time axis is
       exact at any resolution — a bucket mismatch changes how finely the LINE
       is sampled and nothing about what it says. `delta` is PER BUCKET, and a
       per-bucket figure has no meaning at all once it is drawn one candle
       wide. So the line survives and the bars are withheld, which is strictly
       more than refusing both: the pane keeps the measurement it can still
       stand behind and drops only the channel that would lie.

       Refused in BOTH directions — 60s buckets on a 1h chart and 1h buckets
       on a 1m chart are the same defect — exactly as the siblings refuse it,
       so the three flow readouts on one canvas can never disagree about
       whether the series is usable.

       And it is SAID, twice, rather than silently not drawn: on the
       provenance row under the headline, which is width-budgeted, and again
       in the legend, which is not and can carry the whole reason. Nothing
       here may render as a quiet market.

       Not only transient, either. loadFlowHist's catch keeps the last good
       series ("keep last") and its 200+{error} branch deliberately keeps the
       previous bucket_s — so ONE failed fetch across an interval change
       leaves a mismatched series in place until the next successful read. */
    const wantBk = Math.max(60, Math.round(barMs / 1000));
    const bkOk = !fhb || !fhb.bucket_s || Math.abs(fhb.bucket_s - wantBk) <= 1;
    // Seconds are not this UI's vocabulary: the reader is being asked to
    // compare this against an interval button that says 1H, not "3600s".
    const bkTxt = (v) => !v ? "?"
      : v % 86400 === 0 ? (v / 86400) + "d"
      : v % 3600 === 0 ? (v / 3600) + "h"
      : v % 60 === 0 ? (v / 60) + "m" : v + "s";

    // `cx` is the shared bar-centre mapping defined with the candle geometry,
    // so a CVD turn sits directly under the bar that produced it.
    const wT0 = +cs[0].t, wT1 = +cs[cs.length - 1].t + barMs;

    const inWin = hist.filter((p) => p.ms >= wT0 && p.ms <= wT1);
    let pts = inWin.map((p) => ({ ms: p.ms, cvd: p.cvd, delta: p.delta }));
    // "buckets" named nothing this UI ever defines. These are the server's
    // fixed-interval tape aggregates; "samples" is what they are.
    let srcLabel = `server tape · ${inWin.length} samples`;
    let sessionOnly = false;
    if (pts.length < 2 && live.length >= 2) {
      pts = live.map((p) => ({ ms: p.ms, cvd: p.cvd, delta: 0 }));
      // "live session only" read as a setting. It is a DEGRADATION: the
      // server's flow history does not cover this window, so the line is
      // drawn from whatever this browser tab has personally watched go past
      // since it was opened. That distinction is the most consequential fact
      // in the pane and it was the smallest text in it.
      srcLabel = "this browser tab only";
      sessionOnly = true;
    }

    if (pts.length < 2) {
      /* FOUR empty states, because they are four different facts and only one
         of them was ever printed.

         Audited 2026-08-16: every empty CVD read "CVD · collecting tape…".
         For xyz:AAPL / MSFT / AMZN / META / AMD that is false — the flow
         collector is at 60/60 slots and its subscription set is ADD-ONLY
         until the process restarts, so nothing is being collected and nothing
         ever will be before a restart. BOTH SIDES said exactly that, on the
         same screen, for the same symbol, at the same instant. Two panes
         disagreeing is bad; the one that says "collecting" is the one that
         costs money, because it reads as "wait and flow will appear".

         The server carries the flag (/api/flow `subscribed` + `why`), so this
         is read, not guessed. NOT-SUBSCRIBED and NOT-YET-ANSWERED are also
         kept apart: a fetch genuinely in flight is the only case where the
         word "loading" is true. */
      const fhc = (state.flowHist && state.flowHist.coin === state.sel)
        ? state.flowHist : null;
      let emptyOpts;
      if (hist.length) {
        emptyOpts = ["CVD · no trades inside this window — zoom out or pick a shorter interval",
                     "CVD · no trades in this window — zoom out",
                     "CVD · no trades here"];
      } else if (!fhc) {
        emptyOpts = ["CVD · asking the server for this market's tape…",
                     "CVD · loading tape…", "CVD · …"];
      } else if (fhc.err) {
        // Read BEFORE the two claims below, both of which describe a tape
        // that was actually looked at. A failed request looked at nothing.
        emptyOpts = ["CVD · the tape request FAILED — nothing was read, so this blank is not a quiet market",
                     "CVD · tape NOT READ — blank is not zero flow",
                     "CVD · NOT READ"];
      } else if (fhc.subscribed === false) {
        emptyOpts = ["CVD · " + state.sel + " is NOT in the trade-tape collector — no tape is being recorded and none will arrive",
                     "CVD · " + state.sel + " NOT collected — blank is not zero flow",
                     "CVD · NOT collected"];
      } else {
        emptyOpts = ["CVD · subscribed, but no tape recorded for this window yet",
                     "CVD · collecting tape…", "CVD · …"];
      }
      const emptyTxt = fitText(ctx, emptyOpts, openR - (plotL + 6));
      paneCap(emptyTxt, plotL + 6, cTop + 12);
      /* The canvas caption is width-budgeted and at this desk it drops to the
         middle rung, which keeps "NOT collected" but loses WHY. The legend has
         no such budget and can carry the server's own sentence — including the
         60/60 slot count and the add-only rule that makes it permanent until a
         restart — with the full text in the tooltip. Same fact, two reaches. */
      if (fhc && fhc.subscribed === false) {
        legend.push(`<span class="li" style="color:${CC.alarm}" ` +
          `title="${esc(fhc.why || "not in the trade-tape collector")}">` +
          `CVD NOT COLLECTED <i style="color:${CC.s3}">· ${esc(state.sel)} is ` +
          `not in the trade-tape collector — an empty pane here means NOT ` +
          `RECORDED, not a market that has not traded</i></span>`);
      }
    } else {
      // Re-base cumulative to the window so the visible swing fills the pane.
      const base = pts[0].cvd - (pts[0].delta || 0);
      const vals = pts.map((p) => p.cvd - base);
      const vMax = Math.max(...vals, 0), vMin = Math.min(...vals, 0);
      const vSpan = (vMax - vMin) || 1;
      const cy = (v) => cTop + (vMax - v) / vSpan * paneH;

      /* THE WITHHOLDING TEST, and it is deliberately narrower than bkOk.

         The browser-session fallback carries delta 0 on every point, so its
         bars draw nothing whether or not the server's bucket width matched —
         announcing a refusal there would name a defect in a series that did
         not come from the server at all. */
      const bkBad = !bkOk && !sessionOnly;

      // delta bars first, behind the line — and only at this chart's own bar
      // width. See the guard above for why the LINE is drawn regardless.
      if (!bkBad) {
        const dMax = Math.max(...pts.map((p) => Math.abs(p.delta || 0)), 1);
        const bw2 = Math.max(1, plotW / Math.max(1, n) * 0.7);
        pts.forEach((p) => {
          const d = p.delta || 0;
          if (!d) return;
          const h = Math.abs(d) / dMax * (paneH * 0.32);
          // 0x33 measured a deuteranopic separation of 46/765 — below the
          // threshold at which the two are different colours at all. A_MID is
          // the lowest rung allowed to carry a side.
          ctx.fillStyle = d > 0 ? alpha(CC.up, A_MID) : alpha(CC.down, A_MID);
          ctx.fillRect(cx(p.ms) - bw2 / 2, d > 0 ? cBot - h : cBot, bw2, h ? h : 1);
        });
      }

      ctx.strokeStyle = alpha(CC.s2, A_FAINT); ctx.setLineDash(D_REF);
      ctx.beginPath(); ctx.moveTo(plotL, cy(0)); ctx.lineTo(plotR, cy(0)); ctx.stroke();
      ctx.setLineDash([]);

      const cur = vals[vals.length - 1];
      ctx.strokeStyle = cur >= 0 ? CC.up : CC.down;
      ctx.lineWidth = 1.3; ctx.beginPath();
      pts.forEach((p, i2) => {
        // NOT named x/y: those are the chart's own mapping functions and
        // shadowing them inside a drawing loop is one edit away from a bug.
        const lx = cx(p.ms), ly = cy(p.cvd - base);
        i2 ? ctx.lineTo(lx, ly) : ctx.moveTo(lx, ly);
      });
      ctx.stroke(); ctx.lineWidth = 1;

      /* The headline used to claim "CVD +$53.3K in window" ten pixels above a
         source line reading "live session only · 0m" — the pane contradicting
         itself, one of the two statements necessarily false. Both are fixed
         here: the span prints in whatever unit is not zero, and while the
         browser-session fallback covers under a minute the headline figure is
         suppressed outright. A number the pane itself says covers nothing
         must not be rendered in the same weight as a measured one. */
      const spanMs = pts[pts.length - 1].ms - pts[0].ms;
      const spanMin = Math.round(spanMs / 60000);
      const spanTxt = spanMin >= 60 ? (spanMin / 60).toFixed(1) + "h collected"
        : spanMin >= 1 ? spanMin + " min collected"
        : Math.max(1, Math.round(spanMs / 1000)) + " sec collected";
      const thin = sessionOnly && spanMin < 1;
      /* ── one row, two tenants ────────────────────────────────────────────
         The headline and the divergence badge both draw on baseline
         cTop + 11 — one left-aligned at plotL + 6, one right-aligned at the
         pane's right edge — and neither knew the other existed. That was
         survivable while the headline read "CVD +$53.3K in window" (139.1px,
         clearing the badge by 45px) and stopped being survivable the moment
         this pass expanded it to "CVD (cumulative buy − sell) …" at 311.3px:
         measured 305.8px of overprint at the 502px canvas this terminal
         actually runs at, in the owner's own saved view. Two 11px labels
         printed straight through each other, which is precisely the failure
         the pass was written to remove.

         So the row is now shared explicitly. The headline is the pane's
         primary statement and gets first call on the width; the badge —
         which is labelled "descriptive" and forecasts nothing — takes the
         remainder after the headline has been measured, and degrades or
         disappears rather than colliding. Both are budgeted against openR
         so neither can reach into the whale rail or the book column. */
      const rowL = plotL + 6, rowR = openR - 4, rowW = Math.max(0, rowR - rowL);
      const div = flowDivergence();
      // CVD is an unexpanded initialism nowhere defined in this UI, and the
      // value is re-based to the visible window — so the level is meaningless
      // across windows and only the shape carries information. Note the
      // ladder now drops "this window" BEFORE it drops the expansion: the
      // expansion is the decoder, the suffix is a nicety.
      ctx.fillStyle = thin ? CC.s2 : (cur >= 0 ? CC.up : CC.down);
      const sgn = cur >= 0 ? "+" : "-", mag = "$" + fmtBig(Math.abs(cur));
      const cvdCands = thin
        ? ["CVD (cumulative buy − sell) · too little tape to total",
           "CVD (buy − sell) · too little tape",
           "CVD · too little tape"]
        : [`CVD (cumulative buy − sell) ${sgn}${mag} this window`,
           `CVD (buy − sell) ${sgn}${mag} this window`,
           `CVD (buy − sell) ${sgn}${mag}`,
           `CVD ${sgn}${mag}`];
      /* Two passes over ONE ladder. The first keeps a reserve for the badge;
         if not even the shortest rung fits inside that reserve, the row is
         too narrow for two tenants and the badge gives up the whole row
         rather than the headline giving up the pane. Measured at a 380px
         canvas before this: the pane printed "BULLISH DIVERGENCE" and no CVD
         figure at all, which states the priority backwards. */
      const headBudget = div ? Math.max(60, rowW * 0.6) : rowW;
      const cvdTxt = fitText(ctx, cvdCands, headBudget) ||
                     fitText(ctx, cvdCands, rowW);
      paneCap(cvdTxt, rowL, cTop + 11);
      const headW = cvdTxt ? ctx.measureText(cvdTxt).width : 0;

      /* Second line pushed to +23 from +21. At 11px the ink of two baselines
         10px apart overlaps by 0.68px (descent 2.29 + ascent 8.39 = 10.68) —
         it was already at -0.01px before this pass and the parentheses added
         to the headline tipped it over. And it now has a budget at all: it
         was the one varying label left drawing through a bare fillText, and
         after it grew to "…· 139.0h collected" it ran 48.7px past openR and
         was sliced by the canvas edge outright on a narrow window.

         "buckets" was jargon this UI defines nowhere. */
      ctx.fillStyle = CC.s2;
      /* The provenance line is a SECOND row inside this pane, and it has to
         prove the pane is tall enough to hold one before it draws.

         It and the RSI caption are the only two labels left on the canvas
         that write through a bare fillText, claiming no lane — so the
         de-overlap allocator cannot see either of them and cannot arbitrate
         between them. At cTop + 23 with a descent of ~2.3 this row needs
         ~25.3px of pane; when the sub-panes are squeezed below that the row
         is simply drawn past the bottom of its own pane and lands on the
         RSI caption in the pane underneath. Measured: it overlapped at 7 of
         9 window sizes with all indicators on, including 500x300 and
         700x300, and the deeper the squeeze the worse the overlap.

         The squeeze is not hypothetical — it is what a taller legend does to
         `paneH` through lgReserve, which is why trimming the legend below
         and clamping here are one fix in two places. Clamping is the part
         that holds no matter what the legend does next.

         Dropping the row is the right failure: it is provenance, the least
         load-bearing thing in the pane, and the CVD headline above it
         already names the series. */
      /* On a bucket mismatch this row carries the refusal, because it is the
         row that says WHERE the pane's numbers came from and that answer has
         changed: one of the two channels is no longer being drawn. The ladder
         degrades down to the two words that must survive any width. */
      const srcTxt = fitText(ctx, bkBad
        ? [`${srcLabel} at ${bkTxt(fhb.bucket_s)} · ${spanTxt} · PER-BUCKET BARS WITHHELD, line is exact`,
           `${srcLabel} at ${bkTxt(fhb.bucket_s)} · BARS WITHHELD`,
           `${bkTxt(fhb.bucket_s)} buckets, ${bkTxt(wantBk)} bars · BARS WITHHELD`,
           `BARS WITHHELD`]
        : [`${srcLabel} · ${spanTxt}`, srcLabel, spanTxt], rowW);
      const SRC_DY = 23, SRC_DESC = 3;
      if (cTop + SRC_DY + SRC_DESC <= cBot) paneCap(srcTxt, rowL, cTop + SRC_DY);

      if (div) {
        // Rendered in a NEUTRAL colour, and labelled "descriptive".
        //
        // This annotation was tested directly (2026-08-13, 90 hypotheses
        // in its family, ported exactly from this function): gross edge
        // -0.0045% to +0.0027% per trade, and in the persistent form the
        // user actually sees it, NEGATIVE at 4 of 5 horizons. It does not
        // forecast. Painting it green/red made it read as a buy/sell call
        // in the same palette the terminal uses for real signals — so the
        // colour is gone and the word "descriptive" is on it. It stays
        // because the observation itself is true and worth seeing; only
        // the implied instruction was wrong.
        const divTxt = fitText(ctx, [
          `${div.kind.toUpperCase()} DIVERGENCE · ${div.note} · descriptive`,
          `${div.kind.toUpperCase()} DIVERGENCE · descriptive`,
          `${div.kind.toUpperCase()} DIVERGENCE`,
        ], rowW - headW - 10);
        if (divTxt) {
          ctx.fillStyle = CC.s3;
          ctx.textAlign = "right";
          paneCap(divTxt, rowR, cTop + 11);
          ctx.textAlign = "left";
        }
      }
      /* THE SECOND REACH. Same shape the NOT-COLLECTED case uses two
         branches up: the canvas caption is width-budgeted and at this desk
         drops to "BARS WITHHELD", which keeps the FACT and loses the REASON;
         the legend has no width budget and can carry the reason, with the
         arithmetic in the tooltip. A withheld channel that says nothing is
         indistinguishable from a flat tape, and this pane is not allowed to
         render an absence as a measurement. */
      if (bkBad) {
        const finer = fhb.bucket_s < wantBk;
        const nR = Math.max(1, Math.round(finer ? wantBk / fhb.bucket_s
                                                : fhb.bucket_s / wantBk));
        const wrong = finer
          ? `${nR} buckets would be printed on top of each other inside every ` +
            `candle slot, each drawn a full ${bkTxt(wantBk)} wide while ` +
            `representing ${bkTxt(fhb.bucket_s)}`
          : `one ${bkTxt(fhb.bucket_s)} bucket would be dropped whole onto the ` +
            `single ${bkTxt(wantBk)} bar holding its start, inventing a print ` +
            `${nR}x the size of anything that traded in that bar`;
        legend.push(`<span class="li" style="color:${CC.alarm}" title="${esc(
          `The server bucketed this tape at ${bkTxt(fhb.bucket_s)}; this chart's ` +
          `bars are ${bkTxt(wantBk)}. Drawn as they are, ${wrong} — so the ` +
          `per-bucket delta bars are NOT DRAWN. The cumulative LINE above them ` +
          `is unaffected and is still exact: CVD is a running total, so a ` +
          `different bucket width changes how finely it is sampled, not what it ` +
          `says. This clears on the next successful /api/flow read at this ` +
          `interval — it is here at all because a failed fetch keeps the last ` +
          `good series, which can outlive the interval it was fetched for.`)}">` +
          `CVD BARS WITHHELD <i style="color:${CC.s3}">· server bucketed at ` +
          `${esc(bkTxt(fhb.bucket_s))} against ${esc(bkTxt(wantBk))} bars — ` +
          `the cumulative line is still exact, only the per-bucket bars are ` +
          `not drawn</i></span>`);
      }
      /* THE SOURCE'S HEALTH, READ BEFORE THE NUMBER DERIVED FROM IT.

         A wedged collector draws a perfectly flat, perfectly confident CVD
         line. This chip is the only thing on the canvas that can tell that
         apart from a balanced tape, and it is pushed AHEAD of the CVD value
         chip deliberately: the reader should reach "is this tape running"
         before "what does this tape say". Silent when healthy — an all-clear
         on every frame is noise, and the button badge already carries
         coverage — and silent when UNKNOWN rather than inventing an
         all-clear, which is the same rule the empty-state branches follow. */
      const tapeH = flowTapeHealth();
      if (tapeH && tapeH.bad)
        legend.push(`<span class="li" style="color:${CC.alarm}" ` +
          `title="${esc(tapeH.why)}">${esc(tapeH.txt)} ` +
          `<i style="color:${CC.s3}">· the CVD line is not advancing — this ` +
          `is the collector, not the market</i></span>`);
      const bal = flowBalance();
      // Amber used to be the MIDDLE of this green/red scale — "neither buy
      // nor sell" — which is the one thing a third polarity colour must not
      // mean when it also means whale money, the live price and a warning.
      // The absence of a side is achromatic.
      legend.push(`<span class="li" style="color:${cur >= 0 ? CC.up : CC.down}">` +
        `CVD ${cur >= 0 ? "+" : "-"}$${fmtBig(Math.abs(cur))}</span>` +
        `<span class="li" style="color:${bal.buyPct >= 55 ? CC.up : bal.buyPct <= 45 ? CC.down : CC.s2}">` +
        `${bal.buyPct.toFixed(0)}% buy 60s</span>` +
        (div ? `<span class="li" style="color:${CC.s3}">` +
          `${div.kind} div <i style="color:${CC.s3}">· descriptive</i></span>` : ""));
    }
  }
  // RSI sub-pane
  if (state.inds.rsi) {
    const r = win(rsiSeries(all, 14));
    const rBot = paneBot(paneIdx++), rTop = rBot - paneH;
    const ry = (v) => rTop + (100 - v) / 100 * paneH;
    // Framed over the x-range it actually plots into. It used to be drawn
    // 0..axisR while its line runs plotL..plotR, so with the volume-profile
    // column on the box started ~50px left of its own data and with the book
    // gutter on it ran up to 200px right of it — three sub-panes each with a
    // different idea of where the chart begins.
    ctx.strokeStyle = CC.grid;
    ctx.strokeRect(plotL, rTop, plotR - plotL, paneH);
    ctx.setLineDash(D_REF); ctx.strokeStyle = alpha(CC.s2, A_FAINT);
    for (const g of [30, 70]) {
      ctx.beginPath(); ctx.moveTo(plotL, ry(g)); ctx.lineTo(plotR, ry(g)); ctx.stroke();
    }
    ctx.setLineDash([]);
    // #e0c060 was a FOURTH amber tone, 58/765 from #ffb84d in normal
    // vision — nobody could read the difference, and it made amber mean one
    // more thing. RSI joins the computed-indicator family instead.
    ctx.strokeStyle = CC.fast; ctx.lineWidth = 1.2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      if (r[i] == null) continue;
      if (!started) { ctx.moveTo(x(i), ry(r[i])); started = true; }
      else ctx.lineTo(x(i), ry(r[i]));
    }
    ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = CC.s2; ctx.font = CHART_FONT_M; ctx.textAlign = "left";
    const rl = r[n - 1];
    paneCap("RSI14 " + (rl != null ? rl.toFixed(1) : "–"), plotL + 6, rTop + 10);
    legend.push(`<span class="li" style="color:${CC.fast}">RSI14 ${rl != null ? rl.toFixed(1) : ""}</span>`);
  }
  // MACD sub-pane
  if (state.inds.macd) {
    const mdF = macdSeries(all, 12, 26, 9);
    const md = { macd: win(mdF.macd), signal: win(mdF.signal), hist: win(mdF.hist) };
    const mBot = paneBot(paneIdx++), mTop = mBot - paneH;
    const vals = [];
    for (let i = 0; i < n; i++) {
      if (md.macd[i] != null) vals.push(md.macd[i]);
      if (md.signal[i] != null) vals.push(md.signal[i]);
      if (md.hist[i] != null) vals.push(md.hist[i]);
    }
    const mAbs = Math.max(1e-9, ...vals.map(Math.abs));
    const my = (v) => mTop + (1 - v / mAbs) / 2 * paneH;   // symmetric around 0
    ctx.strokeStyle = CC.grid;
    ctx.strokeRect(plotL, mTop, plotR - plotL, paneH);
    ctx.setLineDash(D_REF); ctx.strokeStyle = alpha(CC.s2, A_FAINT);
    ctx.beginPath(); ctx.moveTo(plotL, my(0)); ctx.lineTo(plotR, my(0)); ctx.stroke();
    ctx.setLineDash([]);
    // histogram first (behind the lines)
    for (let i = 0; i < n; i++) {
      if (md.hist[i] == null) continue;
      // Sign is carried by which side of the drawn zero line the bar grows
      // from; hue is the redundant channel. 0x55 raised to A_MID so the two
      // clear the deuteranopic JND rather than sitting just under it.
      ctx.fillStyle = md.hist[i] >= 0 ? alpha(CC.up, A_MID) : alpha(CC.down, A_MID);
      const y0 = my(0), y1 = my(md.hist[i]);
      ctx.fillRect(x(i) - cw / 2, Math.min(y0, y1), cw, Math.max(1, Math.abs(y1 - y0)));
    }
    const plotPane = (series, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        if (series[i] == null) continue;
        if (!started) { ctx.moveTo(x(i), my(series[i])); started = true; }
        else ctx.lineTo(x(i), my(series[i]));
      }
      ctx.stroke(); ctx.lineWidth = 1;
    };
    plotPane(md.macd, CC.fast);
    plotPane(md.signal, CC.s3);
    ctx.fillStyle = CC.s2; ctx.font = CHART_FONT_M; ctx.textAlign = "left";
    const ml = md.macd[n - 1], sl = md.signal[n - 1];
    paneCap("MACD(12,26,9) " + (ml != null ? fmtPx(ml) : "–"), plotL + 6, mTop + 10);
    legend.push(`<span class="li" style="color:${CC.fast}">MACD ${ml != null ? fmtPx(ml) : ""}</span>` +
      `<span class="li" style="color:${CC.s3}">SIG ${sl != null ? fmtPx(sl) : ""}</span>`);
  }

  state.heatWalls = [];
  if (gutterFits) {
    const H0 = state.heat;
    // Live mid, not the last candle close: the close can be a minute old and
    // every neighbouring panel quotes the mid.
    const mid = state.mids[state.sel] != null ? +state.mids[state.sel] : cs[n - 1].c;
    const stale = Date.now() - H0.at > HEAT_STALE_MS;
    const fade = stale ? 0.35 : 1;             // a frozen book must not look live

    const gutterR = axisR;
    const liveW = Math.max(30, gutterW * 0.36);
    const histR = gutterR - liveW;

    const sizes = H0.live.map((r) => r[1]).sort((a, b) => a - b);
    const norm = sizes[Math.floor(sizes.length * 0.85)] || sizes[sizes.length - 1] || 1;
    const cellH = Math.max(2, (H - padT - priceB) / 120);
    /* Alpha SNAPPED to the three-rung ladder.

       This used to be a continuously computed rgba() with three decimal
       places of alpha, and it — with three siblings — is the mechanism that
       turned 57 authored colour literals into 362 distinct rendered ones.
       A magnitude encoding layered on top of a categorical one, at a
       resolution nobody can invert by eye. Three rungs is what the eye can
       actually read back, and A_FAINT is never allowed to carry a side, so
       the faintest cells fall back to grey rather than to an unreadable
       green-or-red. */
    const heatColor = (t, side, boost) => {
      const a = Math.min(0.9, 0.08 + t * (boost || 0.8)) * fade;
      if (a < 0.28) return alpha(CC.s2, A_FAINT);
      const base = side === "b" ? CC.up : CC.down;
      return a >= 0.55 ? base : alpha(base, A_MID);
    };
    // Aggregated buckets: size rests between the label and the NEAR edge, so
    // quote the edge price actually meets first.
    const bw = H0.bucketW || 0;
    const nearEdge = (px, side) => side === "b" ? px + bw : px - bw;

    /* No background fill. It measured 21.8% of the pane at a contrast of
       15/765 — and it is DARKER than the panel it sits on, so it was paint
       spent making a column slightly less visible than the thing behind it.
       A column is defined by an edge; the 1px border below already existed
       and is all it ever needed. Nothing draws under it now anyway: the
       plot-content phase is clipped to openR. */
    ctx.strokeStyle = CC.grid;
    ctx.beginPath(); ctx.moveTo(gutterL, padT);
    ctx.lineTo(gutterL, H - priceB); ctx.stroke();
    // font + alignment only: this settles what fitText MEASURES against. The
    // colour is set at the paint site, which is no longer here.
    ctx.font = CHART_FONT_S; ctx.textAlign = "left";
    // Budgeted like every other varying label. Unmeasured it needed 76.25px
    // against a gutterW floor of exactly 80 — it fit only because the 8px
    // quantiser rounded 76 up, the thinnest unguarded margin in the design.
    const heatHdr = fitText(ctx,
      stale ? ["RESTING BOOK · STALE", "BOOK · STALE", "STALE"]
            : ["RESTING BOOK", "BOOK"], gutterW - 5);
    /* The header is MEASURED here (its width decides the ladder's crowding
       seed below) but PAINTED after the data, on a plate — see the paint
       site under the live ladder. It used to print first and take whatever
       the strip then washed over it: measured 2026-08-18, with the persisted
       history wired in, 48% of this header's ink box sat under 0.35-alpha
       cells. The wall labels 200 lines down already solved this exact
       problem with a CC.plate sized to the text; this is that, applied to
       the label they arbitrate against. */

    // --- history on a real time axis: a gap in data reads as a gap ---------
    const snaps = H0.snaps;
    const histW = histR - gutterL;
    /* PUBLISHED FOR THE FETCH. loadDepthHist sizes its bucket request from
       this width, and the width is only known once layout has run — which is
       here, in the draw. It was declared and never assigned, so every request
       used the 64-column fallback: the exact fixed pin the block above warns
       about, since this strip is 46-128px wide depending on zoom and venue
       coverage. Written once per draw, read once per fetch. */
    GUTTER_HIST_W = Math.max(0, Math.round(histW));

    /* THE SERVER'S RECORD FIRST; the session ring is its FALLBACK.
       (C17, 2026-08-18 — this was the "fully built, fully unwired" block.)

       depthHistCols(), loadDepthHist() and GUTTER_HIST_W were all written,
       and nothing called any of them: the strip drew state.heat.snaps and
       only state.heat.snaps — a five-minute ring that dies with the tab —
       while the comment block above promised a reload-surviving record that
       reaches as far back as the chart does. The server has been collecting
       and persisting that record the whole time (SCREEN reads the same store
       through metrics()), so this wires the reader to the writer rather than
       deleting a working collector's only chart consumer.

       The two sources are not interchangeable and the legend says which one
       is on the glass: the ring is 2-second SNAPSHOTS of the aggregated
       ladder, the record is minute-folded BAND PROFILES turned into shells.
       They also carry different spans, which is the whole point.

       The strip's time axis is the CHART's window, so the strip and the
       candles beside it answer the same question over the same hours. */
    let histNote = null;         // what the legend must say about this strip
    let histCov = null;          // the collector's own coverage sentence
    const histT0 = t0, histT1 = +cs[n - 1].t + barMs;
    const hist = histW > 6 ? depthHistCols(histT0, histT1) : null;
    if (hist) {
      const spanMs = Math.max(1, histT1 - histT0);
      const colW = Math.max(1, Math.min(histW, histW * (hist.bucketMs / spanMs)));
      // ONE time->x mapping for the columns AND for the veil edge below. Two
      // expressions for the same boundary is the drift this file keeps
      // paying for: measured, a veil computed off `histW` while the columns
      // sat on `histW - colW` overhung the first column by 0.8px and dimmed
      // recorded data as if it were unrecorded.
      const colX = (ms) => gutterL + ((ms - histT0) / spanMs) * (histW - colW);
      for (const col of hist.cols) {
        const bx = colX(col.ms);
        for (const c of col.cells) {
          if (c.hi < lo || c.lo > hi) continue;
          // A shell is drawn across the price range it actually occupies,
          // clipped to the visible band — never as a fixed-height cell like
          // the ladder's, because its height IS its band width.
          const yTop = y(Math.min(hi, c.hi)), yBot = y(Math.max(lo, c.lo));
          ctx.fillStyle = heatColor(Math.min(1, c.d / hist.norm), c.side, 0.6);
          ctx.fillRect(bx, yTop, colW, Math.max(1, yBot - yTop));
        }
      }
      /* Before the first stored row there is NO RECORD, and there never will
         be: Hyperliquid publishes no book archive, so this cannot be
         backfilled. Blank there would read as "the book was empty back
         then". The veil is the canvas's existing "we have no data for this
         region" scrim, and it is the reason the block above calls itself
         un-backfillable rather than merely short. */
      if (hist.firstMs > histT0) {
        const vx = Math.min(gutterL + histW, colX(hist.firstMs));
        ctx.fillStyle = CC.veil;
        ctx.fillRect(gutterL, padT, Math.max(0, vx - gutterL),
                     Math.max(0, (H - priceB) - padT));
        /* BOTH TIERS, or the sentence understates its own record. The
           collector's `note` counts MINUTE rows against their 48h retention
           ("49.1h of 48h collected") while this strip is usually drawing the
           HOURLY tier behind it — measured 2026-08-18 on BTC, a 140h window
           drew 96h of hourly record under a note that says 49.1h. Quoting
           the note alone would have made a covered span read as uncovered,
           which is this desk's house bug in its other direction. */
        const cov = hist.coverage || {};
        const covBits = [];
        if (cov.note) covBits.push(esc(String(cov.note)) + " at minute resolution");
        if (cov.hourly_rows) covBits.push(cov.hourly_rows + " hourly rows behind that");
        histCov = (covBits.join(" · ") || "the collector returned no coverage figure") +
          ` — this strip draws ${spanLabel(histT1 - hist.firstMs)} of the ` +
          `chart's ${spanLabel(spanMs)}; the veiled part was NEVER RECORDED, ` +
          `and the book publishes no archive to backfill it from`;
      }
      histNote = spanLabel(histT1 - Math.max(histT0, hist.firstMs)) +
                 ` hist ±${hist.outerBps}bps`;
    } else if (snaps.length && histW > 6) {
      const tEnd = H0.at || Date.now();
      const tStart = tEnd - HEAT_WINDOW_MS;
      const colW = Math.max(1.5, histW * (2000 / HEAT_WINDOW_MS));
      for (const sn of snaps) {
        if (sn.t < tStart) continue;
        const bx = gutterL + ((sn.t - tStart) / HEAT_WINDOW_MS) * (histW - colW);
        for (const [px, ntl, side] of sn.rows) {
          if (px < lo || px > hi) continue;
          ctx.fillStyle = heatColor(Math.min(1, ntl / norm), side, 0.6);
          ctx.fillRect(bx, y(px) - cellH / 2, colW, cellH);
        }
      }
      // SESSION, and it says so: this ring started when the tab did and is
      // gone on reload, which is a different fact from a short record.
      histNote = histLabel(snaps) + " hist · session only";
      /* WHY the persisted record is not the thing on the glass. A reader who
         has been told the strip survives reloads is owed the reason it is
         not doing so here, and the collector's own sentence is the one that
         distinguishes "0.0h collected" (this coin was only just subscribed)
         from "not in the collector at all". */
      const dh0 = state.depthHist;
      const cov0 = (dh0 && dh0.coin === state.sel && dh0.coverage) || null;
      histCov = (cov0 && cov0.note)
        ? `${esc(String(cov0.note))} — until that record can draw, this strip ` +
          `is the SESSION ring only: it starts when the tab does and a reload ` +
          `erases it`
        : null;
    }

    /* --- live ladder: side is the ANCHOR EDGE, not the hue -----------------

       Every level used to grow the same way, so bid-vs-ask was carried by
       hue alone across 20-40 marks of which exactly two are ever labelled.
       A filled rect cannot be dashed, so the redundant channel has to be
       geometry: bids anchor at the right edge and grow LEFT, asks anchor at
       the ladder's left edge and grow RIGHT. Plus the mid line below, which
       answers the side question for the whole column at once. Zero extra
       pixels, and the column finally looks like a book. */
    for (const [px, ntl, side] of H0.live) {
      if (px < lo || px > hi) continue;
      const t = Math.min(1, ntl / norm);
      ctx.fillStyle = heatColor(t, side, 0.85);
      const barw = Math.max(2, t * liveW);
      ctx.fillRect(side === "b" ? gutterR - barw : histR,
                   y(px) - cellH / 2, barw, Math.max(2, cellH));
    }
    // The mid was derivable and never drawn. One achromatic reference line
    // in the one rhythm reserved for reference lines. Its CAPTION is placed
    // after the named walls below, for the same reason as in the live book:
    // a reference caption must not outrank a wall that states its own side.
    let heatMidY = null;
    if (mid >= lo && mid <= hi) {
      heatMidY = Math.round(y(mid)) + 0.5;
      ctx.strokeStyle = alpha(CC.s2, A_FAINT); ctx.setLineDash(D_REF);
      ctx.beginPath(); ctx.moveTo(histR, heatMidY); ctx.lineTo(gutterR, heatMidY); ctx.stroke();
      ctx.setLineDash([]);
    }

    /* --- the column's header, PAINTED LAST of the non-label marks ---------
       Measured, fitted and seeded into the label arbitration above; it is
       drawn here so neither the history wash nor a full-width ladder bar can
       print through it, on the same CC.plate the wall labels use. Its
       position is unchanged, so the crowding seed at padT+11 still describes
       exactly where the ink is. */
    if (heatHdr) {
      ctx.font = CHART_FONT_S; ctx.textAlign = "left";
      ctx.fillStyle = CC.plate;
      ctx.fillRect(gutterL + 2, padT - 1,
                   Math.min(gutterW - 4, ctx.measureText(heatHdr).width + 4), 12);
      ctx.fillStyle = CC.s2;
      ctx.fillText(heatHdr, gutterL + 4, padT + 9);
    }

    // --- named walls, quoted at the edge price will actually test ----------
    const inView = H0.live.filter((r) => r[0] >= lo && r[0] <= hi);
    const walls = inView.slice().sort((a, b) => b[1] - a[1]).slice(0, 3);
    const byEdge = new Map();
    for (const [px, ntl, side] of walls) {
      const edge = nearEdge(px, side);
      const prev = byEdge.get(edge);
      if (!prev || ntl > prev.ntl)
        byEdge.set(edge, { px: edge, bucket: px, ntl, side, y: y(edge), stale });
    }
    state.heatWalls = [...byEdge.values()];
    ctx.font = CHART_FONT_M;
    /* Seeded at -99, the topmost wall never tested against the "RESTING BOOK"
       header drawn at padT+9 and printed straight through it — measured
       72.3 x 6.5px of overprint with BOTH tenants at alpha 1. The header is a
       label in the same column; seed the crowding test with it so the first
       wall arbitrates like any other pair. A kept wall then sits at padT+22
       or lower, whose text box top (yy-13 at CHART_FONT_M) is exactly the
       header's baseline. */
    const gutterLabelYs = heatHdr ? [padT + 11] : [];
    let lastLabelY = gutterLabelYs.length ? gutterLabelYs[0] : -99;
    for (const w of state.heatWalls.slice().sort((a, b) => a.y - b.y)) {
      const yy = w.y;
      const crowded = yy - lastLabelY < 11;   // adjacent buckets: guide only
      /* The guide earns the plot like every other context level.

         It used to run x=0 -> gutterL unconditionally, in green/red at 0x30,
         straight across the wash of the SAME book — a level line in the
         polarity hues at an alpha whose deuteranopic separation is 43/765.
         Now: reachable walls get a full-width guide in the wall's own side
         hue, the rest get a tick on the price axis, and ◀/▶ on the label
         carries the side without hue.

         Both live tiers are A_MID. The dim tier was A_FAINT, which measures
         1.64:1 (ask) and 2.52:1 (bid) against the panel — under the 3:1 at
         which a line is a line, and it was ALSO the tier that carried a side
         in hue, which the palette rule three screens up forbids in as many
         words. The label that was supposed to rescue it is dropped by the
         `crowded` test below, and walls are crowded exactly when they
         cluster. So the two tiers now differ by WIDTH, not by opacity: a
         reachable wall spans the plot, a near one stops at the midpoint. */
      const wTier = ctxTier("wall", w.px);
      if (wTier === 0) ctxTick(w.px, fmtPx(w.px) + " wall");
      else {
        ctx.strokeStyle = alpha(w.side === "b" ? CC.up : CC.down, A_MID);
        ctx.setLineDash(D_CTX);
        const gx = wTier === 2 ? plotL : plotL + (gutterL - plotL) * 0.55;
        ctx.beginPath(); ctx.moveTo(gx, yy); ctx.lineTo(gutterL, yy); ctx.stroke();
        ctx.setLineDash([]);
      }
      const dist = (w.px - mid) / mid * 100;
      /* ◀ = bid, ▶ = ask, so side survives with no hue at all.

         This used to be ▲/▼, which put TWO decoders for the same two glyphs
         on one canvas: captured in a single frame, "▲ 64,300 $62.4M" is a
         book ASK while "▼ WHALES SHORT" is a short — so ▲ meant ask in one
         layer and long in the next, and the legend printed both keys at
         once. A glyph is the fallback channel for the reader whose hue
         perception has already failed; an ambiguous fallback is no fallback.
         ▲/▼ is now reserved for LONG/SHORT, and the book uses the same
         left/right vocabulary as its own anchor-edge rule and its own chip
         ("bids ◀ from axis / asks ▶ from edge"). */
      let label = `${w.side === "b" ? "◀" : "▶"} ${fmtPx(w.px)} $${fmtBig(w.ntl)}`;
      const distLbl = `${dist >= 0 ? "+" : ""}${dist.toFixed(2)}%`;
      // Drop the distance tag, then the size, rather than let them collide.
      const distW = ctx.measureText(distLbl).width;
      let showDist = ctx.measureText(label).width + distW + 12 <= gutterW;
      if (!showDist && ctx.measureText(label).width + 8 > gutterW)
        label = (w.side === "b" ? "\u25c0 " : "\u25b6 ") + fmtPx(w.px);
      if (crowded) continue;
      lastLabelY = yy;
      gutterLabelYs.push(yy);
      ctx.globalAlpha = fade;
      ctx.textAlign = "left";
      // The backing plate spanned the FULL gutter width for a label that
      // rarely filled half of it — 3.6% of the pane at contrast 13/765.
      // Sized to its text now.
      ctx.fillStyle = CC.plate;
      ctx.fillRect(gutterL + 2, yy - 10, Math.min(gutterW - 4,
                   ctx.measureText(label).width + 4), 10);
      ctx.fillStyle = w.side === "b" ? CC.up : CC.down;
      ctx.fillText(label, gutterL + 4, yy - 2);
      if (showDist) {
        ctx.textAlign = "right";
        ctx.fillStyle = CC.s2;
        ctx.fillText(distLbl, gutterR - 3, yy - 2);
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";
    }
    /* Against every drawn label, not just the most recent one. The old test
       consulted lastLabelY alone: with walls at y 174 and 187 and MID at
       175.5 it cleared against 187 and landed 1.5px from 174 — measured
       18.1 x 8.5px of overprint, the faint wall over the full-alpha caption.
       Ascending-y iteration makes "the last one" equivalent to "all previous"
       for the WALLS, but MID is not in that order, so it needs the whole set
       (which now includes the gutter header). */
    if (heatMidY != null &&
        gutterLabelYs.every((ly) => Math.abs(heatMidY - ly) >= 11)) {
      ctx.font = CHART_FONT_S; ctx.textAlign = "right";
      ctx.fillStyle = CC.s2;
      ctx.fillText("MID", histR - 2, heatMidY - 2);
      ctx.textAlign = "left";
    }

    // --- imbalance over a SYMMETRIC band, else it just tracks range position
    const reach = Math.max(1e-9, Math.min(hi - mid, mid - lo));
    const band = H0.live.filter((r) => Math.abs(r[0] - mid) <= reach);
    const bidN = band.filter((r) => r[2] === "b").reduce((a, r) => a + r[1], 0);
    const askN = band.filter((r) => r[2] === "a").reduce((a, r) => a + r[1], 0);
    const bidShare = bidN + askN > 0 ? bidN / (bidN + askN) * 100 : 50;
    const bandPct = reach / mid * 100;
    const nearest = band.slice()
      .sort((a, b) => Math.abs(a[0] - mid) - Math.abs(b[0] - mid))
      .find((r) => r[1] > norm * 0.8);
    const age = H0.at ? Math.round((Date.now() - H0.at) / 1000) : null;
    if (H0.err || stale) {
      /* RED-AS-ALARM LEAVES THE POLARITY HUE.

         This chip used the exact literal #ff4d5e that also encodes down
         candle, ask, short, stop, resistance and negative MACD. Data
         freshness and price direction are orthogonal axes; a dead feed and a
         falling market must not look alike. CC.alarm is violet, it is
         reserved on this canvas for data-AVAILABILITY chips (this one, and
         S/R's stale / unavailable notes — same semantic, never a price), and
         it is measured at a worst-case
         CVD-simulated separation of 18/765 from every retained token — the
         best available. The word STALE and the 0.35 globalAlpha on the data
         remain, so hue is the third channel here, never the only one. */
      // The ⚠ is the decoder, not a sentence about the hue — and the hue is
      // no longer violet, which the sentence would have gone on asserting.
      legend.push(`<span class="li" style="color:${CC.alarm}">⚠ LIQ STALE` +
        `${age != null ? " " + age + "s" : ""}${H0.err ? " · feed error" : ""}</span>`);
    } else {
      legend.push(
        `<span class="li" style="color:${bidShare >= 55 ? CC.up : bidShare <= 45 ? CC.down : CC.s2}">` +
        `LIQ ${bidShare.toFixed(0)}% bid ±${bandPct.toFixed(1)}%</span>` +
        (nearest ? `<span class="li" style="color:${CC.s3}">wall ` +
          `${fmtPx(nearEdge(nearest[0], nearest[2]))} ` +
          `(${((nearEdge(nearest[0], nearest[2]) - mid) / mid * 100).toFixed(2)}%)</span>` : "") +
        `<span class="li" style="color:${CC.s3}">${H0.sig}sf buckets · ` +
        // histNote names WHICH record the strip drew and how far it reaches.
        // `histLabel(snaps)` alone printed "0s hist" with nothing on the
        // strip at all — a measured zero over a strip nobody had filled.
        `${histNote || "no history strip yet"} · ${age}s</span>`);
    }
    /* The record's own coverage, in the server's words, whenever the strip
       reaches less far back than the chart does. The sentence is
       depth_history.coverage()'s own, so this legend cannot drift from what
       the collector thinks it holds — and the veiled left-hand region of the
       strip is the same fact drawn rather than said. */
    if (histCov)
      legend.push(`<span class="li" style="color:${CC.s3}">BOOK HISTORY ` +
        `<i style="color:${CC.s3}">${histCov}</i></span>`);
    legend.push(`<span class="li" style="color:${CC.up}">RESTING BOOK </span>` +
      `<span class="li" style="color:${CC.up}">◀ bid</span>` +
      `<span class="li" style="color:${CC.down}">▶ ask</span>`);
    /* Every wall in this gutter is a BUCKET whose width is the aggregation
       the server used. If it used a different one than was asked for, the
       size of every mark changed with it — so the substitution is named on
       the glass rather than left to be inferred from the bucket edges. */
    if (state.heat.reqNote)
      legend.push(`<span class="li" style="color:${CC.s3}">⚠ BOOK REQUEST ` +
        `ALTERED <i style="color:${CC.s3}">${esc(String(state.heat.reqNote))} — ` +
        `these buckets are the server's resolution, not the requested one</i></span>`);
  } else if (state.inds.heat) {
    /* HEAT'S SILENT-DEAD STATE (audit 2026-08-16).

       gutterFits gated this ENTIRE block, including the legend rows it pushes
       ("LIQ x% bid", "⚠ LIQ STALE Ns"). So with the layer on and no depth data
       the gutter contributed nothing and explained nothing, while the HEAT
       button and the H key both reported success. Measured: with state.heat
       emptied, {heat:true} drew 317 canvas ops against an all-off baseline of
       317 — drawsNothing true — plotW unchanged at 655, legend string empty.

       Usually a sub-2s flash, because the #indbtns handler calls pollHeat() on
       turn-on. But on a market with no depth coverage, or against a wedged
       /api/depth, it is a permanently lit dead control — and this system lost
       24 minutes of CVD to a wedged collector on the day of this audit. "Not
       measured" must not look like "measured zero", and a control that
       silently does nothing is that same failure wearing a different hat.

       Four distinct causes, four distinct sentences: they are different facts
       and the reader would act on each differently. The err case is the one
       that matters most — state.heat.err was already being carried and had
       nowhere on the canvas to be said. */
    const heatWhy =
      state.heat.err ? `depth feed error — ${esc(String(state.heat.err))}`
      : state.heat.coin !== state.sel
        ? `no depth for ${esc(baseSym(state.sel))} yet — this market may not be ` +
          `in the depth collector at all, in which case none is coming`
      : !state.heat.live
        ? `depth for ${esc(baseSym(state.sel))} returned no levels — NOT an empty book`
      : "not enough width for the gutter — it needs 260px of pane and " +
        `has ${Math.round(axisR)}px`;
    legend.push(`<span class="li" style="color:${CC.s3}">LIQUIDITY HEATMAP ` +
      `<i style="color:${CC.s3}">${heatWhy} · nothing is drawn, and a blank ` +
      `gutter here means NOT MEASURED, not no liquidity</i></span>`);
  }

  /* The nearest dormant level above and below price keeps a compact name.

     A 4px tick on the axis tells you THAT there is a level out there but not
     WHICH — and the two closest to price are the two most likely to matter
     next. Everything further out stays a bare tick; the crosshair and the
     axis carry the rest. */
  if (dormant.length) {
    const yLast = y(last);
    const above = dormant.filter((d) => d.y < yLast).sort((a, b) => b.y - a.y)[0];
    const below = dormant.filter((d) => d.y >= yLast).sort((a, b) => a.y - b.y)[0];
    // Promised levels first: they are named in the legend, so they get their
    // lane before the two proximity picks compete for the rest.
    const promised = dormant.filter((d) => d.must && d !== above && d !== below);
    ctx.font = CHART_FONT_S; ctx.textAlign = "right";
    for (const d of promised.concat([above, below])) {
      if (!d || !d.tag) continue;
      const w = ctx.measureText(d.tag).width;
      if (!lanes.place("left", d.y + 3, 12, openR - 2 - w, openR - 2)) continue;
      ctx.fillStyle = CC.s1;
      ctx.fillText(d.tag, openR - 2, d.y + 3);
    }
    ctx.textAlign = "left";
  }

  /* last price — amber, [4,3], and now the ONLY amber full-width line.

     The ruler ENTRY level was also #ff9f0a and also full width, one dash
     unit away at [5,3]: an observed fact (where the market is) and the
     owner's own plan (where he intends to get in) rendered as near-identical
     marks. Confusing those two is a trading error, not a legibility
     annoyance. ENTRY moves to the plan colour below. */
  ctx.strokeStyle = CC.live; ctx.setLineDash(D_LAST);
  ctx.beginPath(); ctx.moveTo(0, y(last)); ctx.lineTo(axisR, y(last)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = CC.live; ctx.textAlign = "left"; ctx.font = CHART_FONT_M;
  ctx.fillRect(axisR, y(last) - 8, padR, 16);
  ctx.fillStyle = CC.onLive;
  ctx.fillText(fmtPx(last), axisR + 5, y(last) + 4);

  /* trade-level ruler (planning overlay) — this only PAINTS.

     The label rows were claimed near the top of the frame, ahead of every
     other "left" caller, and the priority argument lives with the claim. */
  if (ruOn) {
    const drawLevel = (px, color, plan, name) => {
      /* A level the owner placed can sit outside the drawn price range: a 2R
         target above the window, or a plan restored from hlterm_ruler onto a
         chart that has moved since. y(px) is then off-canvas and the level
         painted as NOTHING — present in state, absent on the glass, which is
         this file's one unforgivable failure mode and became reachable from
         the first frame once the ruler started surviving a reload.

         Same remedy the event band already uses (see the padSpan note): clamp
         to the border and name what is out there, never rescale the
         instrument around an overlay. The clamped line is a MARKER, not the
         level: rulerTargetHit measures against the TRUE y, so the marker is
         not itself a handle. A target a few pixels out of view is still
         grabbable (its true y is within the band, and dragging pulls it back
         into range); one far out of view is not, which is correct — you
         cannot drag a line that is not where the price is. */
      const off = px > hi ? 1 : px < lo ? -1 : 0;
      const yy = off > 0 ? padT + 0.5 : off < 0 ? H - priceB - 0.5 : y(px);
      ctx.strokeStyle = color; ctx.setLineDash(D_RULER); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(axisR, yy); ctx.stroke();
      ctx.setLineDash([]); ctx.lineWidth = 1;
      if (off) {
        // The lane claim was made at the off-canvas row, so this names itself
        // at the border instead — right-aligned, same slot the "▲ above view"
        // caret uses, and it carries the PRICE because the label that would
        // have carried it is not on screen.
        ctx.fillStyle = color; ctx.font = CHART_FONT_M; ctx.textAlign = "right";
        ctx.fillText(`${off > 0 ? "▲" : "▼"} ${name} ${fmtPx(px)} ` +
                     `${off > 0 ? "above" : "below"} view`,
                     openR - 2, yy + (off > 0 ? 10 : -3));
        ctx.textAlign = "left";
        return;
      }
      // The LINE is unconditional. A level the owner placed himself is on the
      // glass whether or not its name won a row; only the naming can lose.
      if (!plan || !plan.slot) return;
      // Exactly the rung whose width placeRun reserved, at the x it reserved
      // — measuring a second string here would be reserving one label and
      // painting another.
      ctx.fillStyle = color; ctx.font = CHART_FONT_M; ctx.textAlign = "left";
      ctx.fillText(plan.cands[plan.slot.i], plan.slot.x, plan.slot.y);
    };
    /* Risk and reward were two full-plot-width fills at 0x14 — measured as
       the LEAST distinguishable pair on the whole canvas (deuteranopic
       separation 16/765). The two marks that tell you which side of entry
       loses money were the two least readable marks drawn. They become a
       pair of 8px brackets at the left edge: same information, ~1% of the
       ink, and legible. The words STOP / risk% and TARGET / R:R on the
       levels themselves were always the real channel. */
    if (ru.stop != null) {
      const lo2 = Math.min(ru.entry, ru.stop), hi2 = Math.max(ru.entry, ru.stop);
      const bracket = (pTop, pBot, col) => {
        const yA = y(pTop), yB = y(pBot);
        ctx.strokeStyle = col; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(plotL + 9, yA); ctx.lineTo(plotL + 1, yA);
        ctx.lineTo(plotL + 1, yB); ctx.lineTo(plotL + 9, yB);
        ctx.stroke(); ctx.lineWidth = 1;
      };
      bracket(hi2, lo2, alpha(CC.down, A_MID));
      if (ru.target != null) {
        const t1 = Math.min(ru.entry, ru.target), t2 = Math.max(ru.entry, ru.target);
        bracket(t2, t1, alpha(CC.up, A_MID));
      }
    }
    // ENTRY is the owner's INTENT, so it is drawn in the colour reserved for
    // marks the owner authored — never in the live-price amber.
    drawLevel(ru.entry, CC.plan, ruPlan.entry, "ENTRY");
    if (ru.stop != null) drawLevel(ru.stop, CC.down, ruPlan.stop, "STOP");
    if (ru.target != null) drawLevel(ru.target, CC.up, ruPlan.target, "TARGET");
  }

  /* Footprint ladder for the hovered bar.

     It used to be gated on `f.levels.size` — i.e. it drew ONLY when the
     bucket had been wiped and rebuilt from the browser ring, and drew
     absolutely nothing for a bar this tab never watched. On a 1h chart the
     ring reaches a median of 46 minutes, so that silence covered every bar
     but the newest, and it was indistinguishable from the ladder of a
     genuinely dead bar. Both facts are now printed, and they are different
     sentences: "no prints in this bar" is a measurement, "this bar closed
     before the tab connected" is the absence of one. `cov` (from candleFlow)
     is what separates them. */
  if (state.inds.fp && cflow && state.hover != null && cs[state.hover]) {
    const f = cflow.get(cs[state.hover].t);
    {
      // No bucket at all — neither the server series nor the ring reaches
      // this bar. Nothing was measured, in either channel.
      const cov = f ? f.cov : "none";
      // `lsrc` is set by candleFlow and is the ONLY thing that says which of
      // the two ladders these rungs came from. One source per bar, never a
      // blend — see the precedence block there.
      const lsrc = f ? f.lsrc : null;
      const all = f ? [...f.levels.entries()]
        .map(([px, L]) => ({ px, b: L.b, s: L.s, tot: L.b + L.s }))
        .sort((a, b) => b.tot - a.tot) : [];
      const rows = all.slice(0, 8).sort((a, b) => b.px - a.px);
      /* WHAT THE TOP-8 CUT LEFT OUT, counted rather than dropped. The box has
         always drawn 8 rungs and never said there were more, which reads as
         "these are all the prices" — a confident fact standing in for a
         missing one. Two cuts stack here and both are counted: this local
         slice, and the server's own top-12 wire cut (rn/rb/rs), which on a
         busy 1h bar is the larger of the two. */
      const cutN = Math.max(0, all.length - rows.length);
      const moreN = cutN + (f && f.rn || 0);
      const moreB = all.slice(rows.length).reduce((a, r) => a + r.b, 0) + (f && f.rb || 0);
      const moreS = all.slice(rows.length).reduce((a, r) => a + r.s, 0) + (f && f.rs || 0);
      /* The one line that says what this ladder is entitled to claim. SEVEN
         states now, because they are seven different facts:
           full + rows     the ring watched the whole bar — no note needed
           full + no rows  the ring watched the whole bar and NOTHING traded
           stored (whole)  the server's minute-resolution level tier covers
                           this bar and its rungs ACCOUNT FOR the bar's whole
                           traded volume — a real footprint on a bar this tab
                           never saw, and a complete one
           stored (short)  the rungs total materially less than the bar traded.
                           THE MINUTE COUNT CANNOT SEE THIS: a minute the
                           collector started recording partway through is
                           present, so lc counted it as covered
           stored (unchecked)  no complete bar total exists to check the rungs
                           against, so completeness is unknown — which is not
                           a pass and does not get to look like one
           partial         no stored ladder, ring joined mid-bar; Δ is still
                           complete when it comes from the server bucket
           none            no stored ladder and the bar closed before this tab
                           connected — and WHICH absence that is, is named */
      const ringMin = Math.max(1, Math.round((Date.now() - (tapeRingStartMs() || Date.now())) / 60000));
      /* Why there is no STORED ladder for this bar — four distinct causes, and
         the pane must not let them wear each other's sentence. Derived from
         the shipped spans (from_ms/to_ms/since_ms), never from parsing the
         server's prose, and `lvWhy` (bucket-width or resolution refusal) wins
         because it explains a ladder that exists and is being declined. */
      const lv = cflow.lv;
      const lvGap = () => {
        if (cflow.lvWhy) return cflow.lvWhy.concat(["no usable stored ladder"]);
        if (!lv) return ["stored ladder not loaded", "no stored ladder"];
        if (lv.from_ms == null && lv.since_ms == null)
          return ["the stored level tier is empty so far", "level store empty"];
        if (lv.from_ms == null)
          return [`no stored levels for ${state.sel} yet`, "none stored for this coin"];
        const bt = +cs[state.hover].t;
        if (lv.to_ms != null && bt > lv.to_ms)
          return ["newer than the last stored minute", "not stored yet"];
        if (bt < lv.from_ms)
          return [`older than the stored ladder (kept ${lv.retain_h || 48}h)`,
                  "older than the level store"];
        return ["no stored levels for this bar", "no stored ladder"];
      };
      let note = null;
      /* The note's TONE, decided where the note's WORDS are, because they are
         one statement and were drifting apart: the hue used to be re-derived
         at paint time from a second copy of the coverage test. "ok" is the
         quiet all-clear, "alarm" is a measured shortfall or an unwatched bar,
         and "unchecked" is neither — a claim this pane could not verify. */
      let noteTone = "alarm";
      if (!f) note = ["no flow recorded for this bar", "no flow here"];
      else if (lsrc === "stored") {
        /* THE FOURTH PROVENANCE. Δ and ladder now come from two different
           server tiers — buy/sell from the b/s buckets, rungs from the level
           tier — and the tiers have different reach (400d hourly vs 48h at
           one minute), so the sentence names the ladder's own coverage in the
           tier's own unit. `lmEff` bounds the in-flight bar by elapsed
           minutes, so a bar 12 minutes into an hour reads 12/12, not 12/60. */
        const lc = f.lc || 0, lm = f.lmEff || f.lm || 1;
        /* A MINUTE THAT IS PRESENT BUT NOT WHOLE — the fifth case, and the one
           lc/lm is blind to. lc counts WHOLE MINUTES, so a minute the
           collector only caught the tail of still counts as covered and this
           note used to read "all Nm of this bar" in the calm hue. Measured on
           BTC's 16:37 IST 1m bar (a restart landed at 16:37:43): rungs
           totalling $61.8K drawn as the complete footprint of a bar whose Δ
           was +$4.6M — 1.3% of the bar, presented as 100% of it.

           So the claim is settled by MEASUREMENT instead of by counting: Δ is
           the b/s tier's complete total for this bar, the rungs are the level
           tier's, remainder included, and a material gap between them is the
           ladder's own shortfall. LADDER_TOL_* is what separates that from the
           wire's whole-dollar rounding. */
        const ladTot = all.reduce((a, r) => a + r.tot, 0) +
                       (f.rb || 0) + (f.rs || 0);
        const barTot = (f.fromHist && !f.noDelta && (f.buy + f.sell) > 0)
          ? f.buy + f.sell : null;
        const ladTol = barTot == null ? 0
          : Math.max(barTot * LADDER_TOL_REL, LADDER_TOL_USD * Math.max(1, lc));
        const ladPct = barTot == null ? null : ladTot / barTot;
        /* Never round a real shortfall to a reassuring "0%", and never round a
           sliver up to a whole percent it does not have. */
        const ladTxt = ladPct == null ? "" : ladPct >= 0.0995
          ? Math.round(ladPct * 100) + "%"
          : ladPct >= 0.001 ? (ladPct * 100).toFixed(1) + "%" : "<0.1%";
        if (barTot != null && barTot - ladTot > ladTol)
          note = [`ladder = stored · only $${fmtBig(ladTot)} of the bar's $${fmtBig(barTot)}`,
                  `ladder = stored · only ${ladTxt} of the bar`,
                  `ladder = ${ladTxt} of this bar`, `ladder: ${ladTxt} of bar`];
        else if (barTot == null) {
          /* Nothing to check the rungs against — the b/s tier has no complete
             total for this bar, which its own Δ line already says. An
             unverified claim is not a verified one and may not wear its hue. */
          noteTone = "unchecked";
          note = [`ladder = stored levels · ${lc}/${lm}m · total not cross-checked`,
                  `ladder = stored · ${lc}/${lm}m · unchecked`,
                  `stored ${lc}/${lm}m · unchecked`, `stored ${lc}/${lm}m ?`];
        } else {
          /* Checked, and whole. When minutes are missing from the store yet
             the rungs still account for every dollar the bar traded, those
             minutes traded nothing: complete BY MEASUREMENT, so it reads
             complete and calm — the count stays in the sentence rather than
             being dressed up as full coverage, and rather than crying wolf
             over a minute that was empty. */
          noteTone = "ok";
          note = lc >= lm
            ? [`ladder = stored levels · all ${lm}m of this bar`,
               `ladder = stored levels · all ${lm}m`,
               `ladder = stored · ${lc}/${lm}m`, `stored ${lc}/${lm}m`]
            : [`ladder = stored · all $${fmtBig(barTot)} of this bar · ${lc}/${lm}m`,
               `ladder = stored · whole bar · ${lc}/${lm}m`,
               `ladder = stored · ${lc}/${lm}m, whole bar`, `stored ${lc}/${lm}m`];
        }
      }
      else if (cov === "none") {
        const g = lvGap();
        note = [`bar not watched · ${g[0]}`, g[0], g[1], "no ladder"];
      }
      else if (cov === "partial")
        note = f.fromHist
          ? [`Δ = whole bar · ladder = last ${ringMin}m`,
             "Δ = whole bar · ladder = tape only", "ladder: partial"]
          : [`Δ AND ladder: tape only, last ${ringMin}m`,
             "Δ and ladder: tape only", "tape only"];
      else if (!rows.length) {
        noteTone = "ok";
        note = ["no prints in this bar — measured, not missing",
                "no prints in this bar (measured)", "no prints (measured)"];
      }
      /* Δ provenance, same discipline. `fromHist` means the figure is the
         server's complete bucket for the bar; without it the figure is a sum
         over the prints this tab personally saw, which on a boundary bar is
         a fraction of the truth (measured mean understatement 55.3% on BTC
         1h). The old box printed both as a bare "Δ $x". */
      const dTxt = (!f || f.noDelta) ? "Δ not measured"
        : `Δ ${f.buy - f.sell >= 0 ? "+" : "-"}$${fmtBig(Math.abs(f.buy - f.sell))}` +
          (f.fromHist ? "" : (cov === "full" ? "" : " (tape only)"));
      ctx.font = CHART_FONT_S;
      const noteTxt = note ? fitText(ctx, note, 234) : null;
      const moreTxt = moreN > 0
        ? `+${moreN} more · $${fmtBig(moreB)} / $${fmtBig(moreS)}` : null;
      const bw = Math.max(108, Math.min(244,
        Math.ceil(Math.max(ctx.measureText("FOOTPRINT  " + dTxt).width,
                           noteTxt ? ctx.measureText(noteTxt).width : 0,
                           moreTxt ? ctx.measureText(moreTxt).width : 0)) + 10));
      const rh = 11, boxH = rows.length * rh + 16 + (noteTxt ? rh : 0) +
                            (moreTxt ? rh : 0);
      let bx = x(state.hover) + 10;
      if (bx + bw > plotR) bx = Math.max(plotL + 2, x(state.hover) - bw - 10);
      let by = Math.min(y(cs[state.hover].h), H - priceB - boxH - 4);
      by = Math.max(padT + 2, by);
      ctx.fillStyle = CC.fpPlate;
      ctx.fillRect(bx, by, bw, boxH);
      ctx.strokeStyle = CC.grid; ctx.strokeRect(bx, by, bw, boxH);
      ctx.textAlign = "left";
      ctx.fillStyle = CC.s2;
      ctx.fillText(`FOOTPRINT  ${dTxt}`, bx + 4, by + 10);
      if (noteTxt) {
        // Coverage is a DATA fact, so it wears the alarm hue the coverage
        // warning on the canvas already uses — except where it reports a
        // completed measurement of a quiet bar, which is not a shortfall.
        /* A COMPLETE stored ladder is not a shortfall either — it is the
           tier doing its job on a bar the ring never saw — so it wears the
           same quiet hue a fully-watched bar does. Partial coverage, a
           refused width and an unwatched bar keep the alarm hue.
           THE TONE IS NO LONGER RE-DERIVED HERE. It used to be a second copy
           of the coverage test — `lc >= lmEff` — which is exactly the test
           that could not see a minute stored only in part, so the calm hue
           went onto a ladder holding 1.3% of its bar. It is now set beside
           the sentence it belongs to, and the third value is the one this
           pane was missing: a claim it could not check is neither an
           all-clear nor a failure, so it gets the dim caption hue rather
           than borrowing either. */
        ctx.fillStyle = noteTone === "ok" ? CC.s3
                      : noteTone === "unchecked" ? CC.s2 : CC.alarm;
        ctx.fillText(noteTxt, bx + 4, by + 10 + rh);
      }
      const maxTot = Math.max(...rows.map((r) => r.tot), 0) || 1;
      const rowTop = by + 16 + (noteTxt ? rh : 0);
      rows.forEach((r, i) => {
        const ry = rowTop + i * rh;
        const sw = (r.tot / maxTot) * (bw - 8);
        /* The row TINT is gone. Measured at deuteranopic separation 1.6 of
           765 — below the just-noticeable difference for a large uniform
           patch, on an 11px row. And the bar length encodes TOTAL volume,
           not the majority it was tinted for, so the two channels disagreed.
           The buy and sell figures below already print in fixed columns,
           which is a positional channel that works. */
        ctx.fillStyle = alpha(CC.s2, A_FAINT);
        ctx.fillRect(bx + 4, ry, sw, rh - 2);
        ctx.fillStyle = CC.s2;
        ctx.fillText(fmtPx(r.px), bx + 6, ry + 8);
        ctx.textAlign = "right";
        ctx.fillStyle = CC.up;
        ctx.fillText(fmtBig(r.b), bx + bw - 40, ry + 8);
        ctx.fillStyle = CC.down;
        ctx.fillText(fmtBig(r.s), bx + bw - 5, ry + 8);
        ctx.textAlign = "left";
      });
      /* The remainder, stated. Drawn in the dim hue rather than the alarm
         one: levels beyond the eighth are a DELIBERATE cut, not a gap in the
         data, and the two must not look alike on the same plate. */
      if (moreTxt) {
        ctx.fillStyle = CC.s3;
        ctx.fillText(moreTxt, bx + 6, rowTop + rows.length * rh + 8);
      }
    }
  }

  // SERVER-series coverage boundary. The collector keeps 48h of minute
  // buckets (90d hourly); a 1d chart can span months. Without this the CVD
  // line simply stopped partway across and read as a broken/misaligned pane
  // rather than "there is no tape back here". This is the SERVER clock — the
  // browser's own ring reaches ~46 minutes, three to four orders of magnitude
  // less, and it is the footprint ladder, not this veil, that answers to it.
  if (state.inds.cvd || state.inds.fp) {
    const ts = flowHistStartMs();
    if (ts != null && ts > +cs[0].t) {
      const bx = Math.max(plotL, Math.min(plotR, cx(ts)));
      if (bx > plotL + 2) {
        // Dim only what the tape actually governs. With FP off the strip is
        // ordinary volume, which is known for every bar — dimming it there
        // would claim missing data that is not missing.
        /* Dim only what the tape actually governs. With FP off the strip is
           ordinary volume, which is known for every bar — dimming it there
           would claim missing data that is not missing. The volume overlay
           is INSIDE the price band now, so with FP on the dimmed region runs
           from the top of the sub-pane stack down through the overlay's own
           band; with FP off it stops at the price floor. */
        const dimTop = (state.inds.fp && volBandH) ? volTop : (H - priceB);
        const dimBot = H - stackB;
        ctx.fillStyle = CC.veil;
        ctx.fillRect(plotL, dimTop, bx - plotL, Math.max(0, dimBot - dimTop));
        // Vertical, so it shares no namespace with the horizontal levels.
        ctx.strokeStyle = alpha(CC.s1, A_MID); ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(bx, dimTop); ctx.lineTo(bx, dimBot); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = CC.s2; ctx.font = CHART_FONT_S; ctx.textAlign = "right";
        /* dimTop+9 IS the topmost sub-pane's caption row — cTop(0) is
           dimTop+4 and the caption sits at cTop+11 — so this marker was
           pinned 6px from the CVD headline and overprinted it by 54.2 x 5px
           whenever the tape boundary fell under that text. It is arbitrated
           now, against the boxes the panes actually recorded, in BOTH axes:
           the marker is right-aligned at the boundary while every caption is
           left-aligned at the plot edge, so the top row is usually free once
           x is taken into account, and the search only walks down when it is
           genuinely not. If no row in the band clears (a 10px pane floor can
           leave none), the marker is dropped rather than stacked — the dashed
           boundary, the pane's own "N min collected" provenance line, the
           "N/n bars on tape" caption and the ⚠ coverage warning all still
           carry the fact, and none of them can collide here. */
        const mw = ctx.measureText("no tape ◀").width;
        let tapeY = null;
        for (let ty = dimTop + 9; ty <= dimBot - 2; ty += 6) {
          const box = { x0: bx - 3 - mw, x1: bx - 3, y0: ty - 11, y1: ty + 3 };
          const clear = paneTextBoxes.every((p) =>
            Math.min(p.x1, box.x1) - Math.max(p.x0, box.x0) <= 0 ||
            Math.min(p.y1, box.y1) - Math.max(p.y0, box.y0) <= 0);
          if (clear) { tapeY = ty; break; }
        }
        if (tapeY != null) ctx.fillText("no tape ◀", bx - 3, tapeY);
        ctx.textAlign = "left";
        // Actionable: name the largest interval the tape fully covers, so the
        // fix for a 4%-covered pane is one click rather than trial and error.
        const coverMs = (+cs[n - 1].t + barMs) - ts;
        const fit = ["1m", "5m", "15m", "30m", "1h", "4h"].filter(
          (iv) => IV_MS[iv] * n <= coverMs).pop();
        const pctCov = coverMs / (barMs * n) * 100;
        if (pctCov < 60) {
          /* A coverage warning is a DATA problem, not a price: alarm hue —
             and a ⚠, because the hue is the channel that fails first. The
             legend chip carried the glyph and this canvas mark did not, so
             on the canvas its ONLY channel against a neighbouring POC or
             VOLUME PROFILE label was the alarm hue itself. */
          ctx.fillStyle = CC.alarm; ctx.textAlign = "left";
          ctx.fillText(`\u26a0 tape covers ${pctCov.toFixed(0)}% of window` +
            (fit && fit !== state.interval ? ` — press ${fit} for full flow` : ""),
            plotL + 4, dimTop - 3);
        }
      }
    }
  }

  // ── live resting book, on the price axis ─────────────────────────────
  // The book pane and the chart were two instruments the reader had to
  // fuse by eye. Here every resting level is a horizontal bar at ITS OWN
  // price on the chart's y-axis — bids grow LEFT from the axis, asks grow
  // RIGHT from the far edge, so the anchor edge carries the side and the
  // hue only reinforces it — with the largest walls labelled in dollars and
  // click-to-alert (same machinery as the heatmap walls). Whale resting
  // orders overlay in amber: the book says
  // how much is resting, the amber says a tracked whale owns it.
  // Stands down when the heatmap gutter is on (that IS the book, over time),
  // and it is now the right column's OPT-IN tenant rather than a default —
  // aggregated, so it fills the pane it is given instead of drawing 40
  // levels into 6 pixels.
  // colL is settled in the layout block, not here, because the whale overlay
  // below has to know where this band starts. Historically it did not: plotR
  // ran to axisR while the book drew, so the whale entry ticks (plotR-8 →
  // plotR) landed ENTIRELY inside the book column — solid green whale-long
  // strokes on top of solid green book bids, same hue, same orientation,
  // same 8px of x, terminating at the same pixel, two unrelated meanings.
  // Both indicators were on by default, so that was the default view.
  /* The whale COHORT label slots are claimed here, ahead of the whale ORDER
     labels immediately below and of the overlay that actually draws them ~150
     lines further down. All three now share lane "left", and drawn in code
     order the order labels won — which is the wrong way round.

     An order label that loses its slot still leaves an amber tick on the
     rail, a roster footer stating the count, total and exit count, and a
     legend chip. A cohort line that loses its label leaves a dashed line
     across the pane with nothing naming it at all. So the mark with no
     fallback reserves first.

     S/R, POC and the expected-move band all drew earlier and keep their
     priority untouched: those are levels the user explicitly switched on,
     and demoting them to make room for an always-on overlay would be the
     same mistake in the other direction.

     Reserving first was not enough on its own. Measured across 380-1400px:
     the long slot lost to "OPTIONS EXPIRY" by 2px of a 14px gap at two of
     four widths, and with the volume profile or S/R switched on BOTH slots
     lost — to "VOL PROFILE" and to POC — at every width tested. The line is
     stroked before the slot is consulted, so the reader was left with an
     unnamed green dashed line across the pane: the owner's original
     complaint, regenerated by the fix for it.

     So a cohort label that cannot have its own row takes the next one. It
     nudges by whole 14px rows, up to two in each direction, never outside
     the price band. A label one row off a line it names is a small cost; the
     line's own colour, dash rhythm and the words LONG/SHORT all still tie
     them together, and there are only ever two of them. A line with no noun
     on it is not a small cost — it is the bug. */
  const whSlot = { long: null, short: null };
  /* ▲/▼ prefix — a third side channel, and the one that survives everything.

     Side on this mark was carried by hue plus dash rhythm, and BOTH rhythms
     were double-booked: [6,4] with the expected-move band's edges and [2,3]
     with the POC. Those two instruments have now vacated (the band is gated
     and drawn at [2,2], the POC moved to [7,4]), so the rhythms are the
     whale layer's alone again — and the glyph makes the side readable even
     at the shortest rung, since the ladder drops the price before the side. */
  const whCands = (side, ntl, px) => {
    const g = side === "LONG" ? "▲" : "▼";
    return [
      `${g} WHALES ${side} $${fmtBig(ntl)} open · avg entry ${fmtPx(px)}`,
      `${g} WHALES ${side} $${fmtBig(ntl)} · avg entry ${fmtPx(px)}`,
      `${g} WHALES ${side} $${fmtBig(ntl)} open`,
      `${g} WHALES ${side}`,
    ];
  };
  // n_positions == null means the sweep never queried this venue: there is no
  // cohort to label, so no slot is claimed for one. (avg_*_entry is null there
  // too, so this changes no allocation — it states the reason it does not.)
  if (state.inds.wh && state.whaleCoin && state.whaleCoin.coin === state.sel &&
      state.whaleCoin.n_positions != null) {
    const wcp = state.whaleCoin;
    ctx.font = CHART_FONT_M;
    for (const [k, px, ntl] of [["long", wcp.avg_long_entry, wcp.long_ntl],
                                ["short", wcp.avg_short_entry, wcp.short_ntl]])
      if (px != null && px >= lo && px <= hi)
        whSlot[k] = lanes.placeRun("left", y(px) - 3, 14,
                                   [0, 14, -14, 28, -28, 42, -42],
                                   padT + 10, H - priceB - 2,
                                   whCands(k.toUpperCase(), ntl, px)
                                     .map((s) => ctx.measureText(s).width),
                                   plotL + 4, openR);
  }
  /* The roster footer's slot is claimed here too, for the same reason and
     one step down the same priority list.

     It is the fallback that makes one-label-per-side honest — "15 WHALE
     ORDERS RESTING" is what tells you the two labelled ticks are 2 of 15 —
     and it was claiming its slot 160 lines below the order labels it backs
     up. Measured: present in 52 of 52 frames in the owner's default view,
     and 0 of 52 the moment S/R is switched on, losing by 0.6px to a label it
     exists to qualify. A summary that disappears exactly when the thing it
     summarises gets crowded is worse than no summary. */
  let whFootCands = null, whFootSlot = false;
  if (railShows && whOrders.length) {
    const nExit = whOrders.filter((o) => o.reduce_only).length;
    const plural = whOrders.length === 1 ? "" : "S";
    const totl = whOrders.reduce((a, o) => a + o.ntl, 0);
    const exits = nExit ? ` · ${nExit} exit${nExit === 1 ? "" : "s"}` : "";
    whFootCands = [
      `${whOrders.length} WHALE ORDER${plural} RESTING · $${fmtBig(totl)}${exits}`,
      `${whOrders.length} WHALE ORDER${plural} · $${fmtBig(totl)}${exits}`,
      `${whOrders.length} WHALE ORDER${plural}${exits}`,
      `${whOrders.length} WHALE ORDER${plural}`,
    ];
    ctx.font = CHART_FONT_M;
    /* Roster lives in the legend now. Reserving the left lane for a
       right-anchored footer painted the callout across the candles. */
    whFootSlot = false;
  }

  /* ── right column tenant: THE RESTING BOOK, AGGREGATED ────────────────

     The raw websocket ladder is the layer this column used to draw, and it
     was illegible for a reason that has nothing to do with the idea. Measured
     at the owner's default 1h zoom: it spans 63,082–63,121 against a pane of
     62,426–65,392 — ±3.09 bps against 464 bps, 1.17% of the pane's height,
     40 hairlines inside 6.0px. hl.py's own docstring says the full-precision
     book covers ~0.07% of price, "far too narrow to plot against a chart".
     The layer plotted it anyway.

     The same book, fetched at the nSigFigs that heatSigFigs() ALREADY picks
     from the visible span, returns ±308 bps and 27 of 40 rows inside the
     window — 91.0% coverage at the same zoom, 78x more. The codebase owned
     the fix; the column was simply never given it. So: aggregated, and the
     interval gate another audit proposed is unnecessary — this is a
     resolution problem, not a zoom problem.

     Two things this column MUST say, and neither appeared on the canvas
     before (reach_bps lived only in the SIDES pane, `cancellable` only in
     the sidebar and the server):

       * TRUNCATED. Every symbol returns exactly 20 levels a side at every
         resolution, so reach = 20 x bucket. That is where the API stops, NOT
         where liquidity ends, and the column must not let the eye read
         truncation as emptiness. So the column's border is drawn ONLY across
         the band the ladder actually resolves, with end-caps: what is
         outside it is unresolved, and it looks unresolved.
       * CANCELLABLE. Measured live, 98.0% of BTC resting size that leaves
         the ±25bps book is cancelled rather than traded (ETH 99.7%, SOL
         98.7%, HYPE 92.8%). This is shown size, not committed size. */
  if (colShows && colTenant === "book") {
    const bookL = colL;
    /* Aggregated if the poll has landed, RAW as a named fallback — never a
       silent one. A raw ladder drawn under an aggregated caption would
       misstate its own reach by two orders of magnitude, which is the exact
       failure mode this whole column is being rebuilt to remove. 20s, so a
       single missed 2s poll does not flip the label back and forth. */
    const aggOk = !!(state.heat.coin === state.sel && state.heat.live &&
                     state.heat.live.length && Date.now() - state.heat.at < 20000);
    const levels = [];
    if (aggOk) {
      for (const r of state.heat.live)
        levels.push({ px: r[0], ntl: r[1], side: r[2] === "b" ? "bid" : "ask" });
    } else {
      const bk = state.book;
      for (const b of bk.bids || []) levels.push({ px: b.px, ntl: b.px * b.sz, side: "bid" });
      for (const a of bk.asks || []) levels.push({ px: a.px, ntl: a.px * a.sz, side: "ask" });
    }
    const inRange = levels.filter((l) => l.px >= lo && l.px <= hi);
    if (levels.length) {
      // What the ladder RESOLVES, measured from the ladder itself rather
      // than assumed from the level count — a venue that returns fewer than
      // 20 a side must not be reported as if it returned 20.
      const bMin = Math.min(...levels.map((l) => l.px));
      const bMax = Math.max(...levels.map((l) => l.px));
      const nBid = levels.filter((l) => l.side === "bid").length;
      const nAsk = levels.length - nBid;
      const bkMid = state.mids[state.sel] != null ? +state.mids[state.sel] : last;
      const reachBps = bkMid ? Math.max(bkMid - bMin, bMax - bkMid) / bkMid * 1e4 : 0;
      const covLo = Math.max(bMin, lo), covHi = Math.min(bMax, hi);
      const covPct = Math.max(0, (covHi - covLo) / span * 100);
      const yTop = Math.max(padT, Math.min(H - priceB, y(covHi)));
      const yBot = Math.max(padT, Math.min(H - priceB, y(covLo)));
      let bmy = null;                       // set only if the mid is in view
      /* The border spans the RESOLVED band and nothing else, with 4px
         end-caps. A full-height border was the mark that made a 6px ladder
         read as a column reaching from the top of the pane to the bottom —
         it drew the container, not the contents, and the container was the
         part that was not true. */
      ctx.strokeStyle = CC.grid; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bookL - 0.5, yTop); ctx.lineTo(bookL - 0.5, yBot);
      ctx.moveTo(bookL - 0.5, Math.round(yTop) + 0.5); ctx.lineTo(bookL + 3.5, Math.round(yTop) + 0.5);
      ctx.moveTo(bookL - 0.5, Math.round(yBot) + 0.5); ctx.lineTo(bookL + 3.5, Math.round(yBot) + 0.5);
      ctx.stroke();
      if (inRange.length) {
        const maxN = Math.max(...inRange.map((l) => l.ntl));
        /* SIDE IS THE ANCHOR EDGE.

           Every level used to grow leftward from axisR, so bid-vs-ask was
           hue and nothing else — and exactly two of them ever get the words
           BID/ASK. Bids anchor at the right edge and grow LEFT, asks anchor
           at the column's left edge and grow RIGHT. Three redundant cues
           (growth direction, side of the mid line, hue), zero extra pixels. */
        for (const l of inRange) {
          const yy = Math.round(y(l.px)) + 0.5;
          const w = Math.max(1, (l.ntl / maxN) * (colW - 4));
          ctx.strokeStyle = alpha(l.side === "bid" ? CC.up : CC.down, A_MID);
          ctx.beginPath();
          if (l.side === "bid") { ctx.moveTo(axisR, yy); ctx.lineTo(axisR - w, yy); }
          else { ctx.moveTo(bookL + 2, yy); ctx.lineTo(bookL + 2 + w, yy); }
          ctx.stroke();
        }
        // The mid was derivable and never drawn, so the anchor rule had
        // nothing to be read against. One reference line, reference rhythm.
        if (bkMid >= lo && bkMid <= hi) {
          bmy = Math.round(y(bkMid)) + 0.5;
          ctx.strokeStyle = alpha(CC.s2, A_FAINT); ctx.setLineDash(D_REF);
          ctx.beginPath(); ctx.moveTo(bookL, bmy); ctx.lineTo(axisR, bmy); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      /* The caption stack goes FIRST and claims its rows, because the header
         used to print LAST and claim nothing: a wall near the top of the
         visible range landed on the same 9px and the two printed through
         each other. Reserving first states the priority — what this column
         IS outranks any one level in it.

         Lane "gutter", not "left": lane "left" is the PLOT's text column
         (EMA/VWAP/BOLL head tags, S/R names, cohort lines, the whale roster
         footer), and a right-column claim in it would block plot labels 500px
         away while colliding with none of them. Separate region, separate
         lane — the same argument the plot's own two ends had to settle. */
      ctx.font = CHART_FONT_S; ctx.textAlign = "right";
      const capW = colW - 4;
      const rungs = [
        aggOk ? ["RESTING BOOK", "LIVE BOOK", "BOOK"]
              : ["RAW BOOK unagg", "RAW BOOK", "BOOK RAW"],
        [`±${fmtBps(reachBps)}bps ${Math.round(covPct)}%`,
         `±${fmtBps(reachBps)}bps`, `±${fmtBps(reachBps)}b`],
        ["TRUNCATED", "TRUNC"],
        ["CANCELLABLE", "CANCELS"],
      ];
      ctx.fillStyle = CC.s2;
      rungs.forEach((cands, i) => {
        const ry = padT + 9 + i * 11;
        const t = fitText(ctx, cands, capW);
        if (t && lanes.place("gutter", ry, 11)) ctx.fillText(t, axisR - 3, ry);
      });
      /* Wall labels: arm the top two per side for click-to-alert, LABEL only
         the largest of each. Measured before this: four labels landed at
         y=148, 150, 151 and 156 — the top walls cluster near the mid by
         definition, so "top 2 per side" is four labels inside eight pixels
         and the allocator silently dropped three. The hit-targets are
         unchanged, so a click never depends on a label winning its slot. */
      const tops = (side) => inRange.filter((l) => l.side === side)
        .sort((a, b) => b.ntl - a.ntl).slice(0, 2);
      const bookLblX = (wl) => axisR - 3 - Math.min(capW, ctx.measureText(
        (wl.side === "bid" ? "BID $" : "ASK $") + fmtBig(wl.ntl)).width);
      for (const side of ["bid", "ask"]) {
        tops(side).forEach((wl, idx) => {
          const yy = y(wl.px);
          /* "b"/"a", NOT "B"/"A". state.heatWalls is one array read by one
             consumer (the click handler), and that consumer tests
             `w.side === "b"` — the heatmap gutter's convention, which is
             what fills this array in the other mode. Pushing uppercase here
             meant the test never matched and EVERY book-wall alert armed
             with the word "ask" in it, including on bids. */
          state.heatWalls.push({ px: wl.px, bucket: wl.px, ntl: wl.ntl,
                                 side: wl.side === "bid" ? "b" : "a", y: yy, stale: false });
          if (idx > 0) return;                       // hit-target only
          if (!lanes.place("gutter", yy, 14, bookLblX(wl), axisR - 3)) return;
          // "$1.5M" was a dollar amount belonging to nothing — no unit, no
          // side, no verb. The word restores a non-colour channel.
          const t = fitText(ctx, [(side === "bid" ? "BID $" : "ASK $") + fmtBig(wl.ntl),
                                  "$" + fmtBig(wl.ntl)], capW);
          if (!t) return;
          ctx.fillStyle = wl.side === "bid" ? CC.up : CC.down;
          ctx.fillText(t, axisR - 3, yy - 2);
        });
      }
      ctx.textAlign = "left";
      /* The legend carries the sentences the 80px column can only abbreviate.
         Chip colour is the MARK's colour: #40a8a0 teal appeared nowhere on
         the canvas, so a reader using the chip as a key was handed a hue that
         does not exist in the thing being keyed. */
      legend.push(`<span class="li" style="color:${CC.s3}">` +
        (aggOk ? `RESTING BOOK` : `RESTING BOOK (raw, unaggregated — aggregated ladder not in yet)`) +
        ` <i style="color:${CC.s3}">±${fmtBps(reachBps)} bps · ${nBid}/${nAsk} levels bid/ask · ` +
        `resolves ${covPct.toFixed(1)}% of the visible price band — ` +
        `TRUNCATED at the API's level cap, which is where the feed stops, not where liquidity ends` +
        `</i></span>` +
        `<span class="li" style="color:${CC.up}">◀ bid</span>` +
        `<span class="li" style="color:${CC.down}">▶ ask</span>` +
        (bmy != null ? `<span class="li" style="color:${CC.s3}">┄ mid</span>` : "") +
        `<span class="li" style="color:${CC.s2}" title="measured live: 98.0% of BTC resting size ` +
        `that leaves the ±25bps book is CANCELLED, not traded (ETH 99.7%, SOL 98.7%, HYPE 92.8%)">` +
        `CANCELLABLE — shown, not committed</span>`);
    } else {
      // Reserved a column and had nothing to put in it. Say that, rather
      // than leaving an empty 84px band to be read as an empty book.
      legend.push(`<span class="li" style="color:${CC.s3}">RESTING BOOK ` +
        `<i style="color:${CC.s3}">no levels returned for ${esc(state.sel)} yet</i></span>`);
    }
  } else if (state.inds.book) {
    /* THE MISSING ELSE (audit 2026-08-16).

       BOOK was the one control on this chart that lit its button, cost a
       keystroke, changed literally nothing on the glass and said nothing about
       why. Measured: with heat genuinely live (40 levels, age 1s), {heat} and
       {heat,book} produced a byte-identical legend and an identical canvas
       op-set — colTenant "none", colW 0 — while the BOOK button stayed lit.
       The VP branch four hundred lines up has always had this else. This is
       the same else, and it names WHICH of the four constraints stood the
       column down, because they are four different facts and the reader would
       act on them differently.

       It also names where the book still IS. That is the point of the
       precedence decision recorded at colTenant: BOOK is the tenant that can
       be stood down cheaply precisely BECAUSE #sidebook renders the identical
       ladder 3px to the right — but that is only true if the legend says so
       instead of leaving the reader to discover it. */
    const bookWhy =
      colYield ? `${colYield}, which is drawing the same resting depth by ` +
                 `price at the right edge — H frees the column`
      : state.inds.vp ? "one column, one tenant — VOLUME PROFILE has it · " +
                        "B cycles none / profile / book"
      : (!state.book || state.book.coin !== state.sel)
        ? `no book for ${esc(baseSym(state.sel))} on this tab yet`
      : "not enough width for the column at this pane size";
    legend.push(`<span class="li" style="color:${CC.s3}">BOOK COLUMN ` +
      `<i style="color:${CC.s3}">${bookWhy} · the same ladder is in ORDER BOOK, ` +
      `right of the chart</i></span>`);
  }

  if (railShows) {
    /* ── whale resting orders: their own rail, their own column ──────────
       These are limit orders ≥$3M owned by one of the tracked wallets —
       money WAITING to trade, which is a different instrument from the
       book's aggregate size and from a filled position. It used to be
       rendered as "W $16.1M✕" inside the book's 67.8px column, and that
       string failed in three separate ways:

         * "W " has no word boundary, so the owner read "Willow". No other
           mark in this app abbreviates an instrument to one letter.
         * "✕" (U+2715) is this app's own dismiss control — the watchlist
           remove, the dossier close, the alert dismiss — and the hints bar
           literally teaches "✕ remove". So the most decision-relevant bit
           on the mark, "this is an EXIT, not new demand", rendered as a
           close button. It also sat ~70px from "×5" meaning touch count.
         * Nothing decodable fits 67.8px anyway: "WHALE $16.1M" is 72.3px,
           and "EXIT $16.1M" clears it by 1.6px, which dies on one resize.

       So the text leaves the gutter. The ticks stay on the price axis where
       a resting order belongs, in a 14px rail of their own, and the label
       right-aligns just left of that rail into ~500px of empty plot. The
       same mark that could not afford 11 characters can now afford 80. */
    if (whOrders.length) {
      const labelled = { bid: false, ask: false };
      const budget = (railL - 4) - plotL;
      for (const o of whOrders) {
        const ry = Math.round(y(o.px));
        ctx.strokeStyle = CC.live; ctx.fillStyle = CC.live;
        // Reduce-only is now TEXTURE, not a glyph: a hollow tick is an exit,
        // a solid one is new money. Hollow-means-reducing is not invented
        // here — the whale event triangles below already use it — so one
        // convention does two jobs instead of a third being introduced.
        if (o.reduce_only) {
          ctx.lineWidth = 1;
          ctx.strokeRect(railL + 0.5, ry - 2.5, Math.max(1, railW - 3), 5);
        } else {
          ctx.fillRect(railL, ry - 1, Math.max(1, railW - 2), 3);
        }
        ctx.lineWidth = 1;
        /* Hit target. Only ONE order per side wins a label (the rest are
           counted in the footer and never named), so for the other thirteen
           this is the only way their size, their trigger price and whether
           they are an EXIT can be read at all. */
        hitAdd({ kind: "whord",
                 key: "whord:" + o.side + ":" + o.px + ":" + o.ntl,
                 x: railL + railW / 2, y: ry, r: 8, prio: 1,
                 fx: railL + railW / 2, px: o.px, spot: last, d: o,
                 title: "whale " + o.side + " $" + fmtBig(o.ntl) });
        // One label per side, largest first (whOrders is sorted by notional).
        // Every order keeps its tick, and the footer below states the true
        // count — previously ~8 of 15 labels printed and the other 7 were
        // dropped by the lane allocator with nothing on screen saying so,
        // which made the visible set an unmarked arbitrary subset.
        if (labelled[o.side]) continue;
        /* Lane "left", the SAME lane as S/R, POC, the expected-move band and
           the whale position lines — even though this label is right-anchored
           to the rail and those are left-anchored at plotL+4.

           They have to share, because they can reach each other. Measured
           live: the cohort label "WHALES SHORT $555.0M open · avg entry
           64,593" ends at x=295.4 and this label began at x=296.1 — 0.7px
           apart, and on separate lanes the allocator, which only compares y,
           had no way to see it. A left column that can use 70% of the plot
           and a right column that can use the rest are not two columns; they
           are one, and one region gets one lane. This is the same rule the
           gutter already states for its own text.

           Sharing the lane is right; sharing it BLINDLY was not. The
           allocator now takes the x span each label will paint, so this one
           still yields to a cohort label long enough to reach it and no
           longer yields to an S/R label four hundred pixels away. */
        const money = "$" + fmtBig(o.ntl);
        /* Two independent bits, so two independent words.
             reduce_only  — this order CLOSES an existing position
             is_trigger   — this order FIRES at a price rather than resting
           The ternary chain treated them as one choice and let STOP swallow
           EXIT, which lost the more consequential of the two: the live book
           carries exactly such an order (ask, $5.8M, reduce_only AND trigger)
           and it printed "WHALE ASK $5.8M STOP", saying nothing about the
           money leaving. Only the hollow tick carried that, and a texture is
           not a substitute for a word. */
        const kind = (o.reduce_only ? " EXIT" : "") + (o.is_trigger ? " STOP" : "");
        const side = o.side === "bid" ? "BID" : "ASK";
        /* The ladder drops SIZE before it drops the verb. It used to be the
           other way round — the last rung kept "$16.3M" and threw away
           "EXIT" — which inverts the priority: side is recoverable from where
           the tick sits relative to price, and size is one decade of amber
           tick thickness away, but "is this money arriving or leaving" is
           recoverable from nothing else on the mark. */
        const oCands = [`WHALE ${side} ${money}${kind}`,
                        `WHALE ${money}${kind}`,
                        kind ? `WHALE${kind}` : `WHALE ${money}`];
        ctx.font = CHART_FONT_M;
        const ow = widest(oCands);
        // ry + 3 — the baseline this actually paints; see the S/R note above.
        labelled[o.side] = true;
        /* Callout is ON the 14px rail: side letter at the tick. Size is the
           tick thickness; hover (hitAdd) still carries WHALE BID $N. The
           long "WHALE BID $27.7M" string used to paint left into the bars. */
        ctx.font = CHART_FONT_S;
        ctx.fillStyle = CC.live;
        ctx.textAlign = "center";
        ctx.fillText(o.side === "bid" ? "B" : "A", railL + railW / 2, ry + 3);
      }
      /* The roster, on the canvas rather than only in the legend. The count
         comes from the same array the ticks iterate, so "15 WHALE ORDERS"
         always equals fifteen visible ticks, and the exit count is the one
         place the reader learns that some of this amber is money leaving. */
      // Candidates were built where the slot was claimed, so the width the
      // allocator reserved and the width this paints are the same list.
      ctx.font = CHART_FONT_M;
      const foot = whFootCands && fitText(ctx, whFootCands, (railL - 4) - plotL);
      if (foot && whFootSlot) {          // slot reserved far above; see there
        ctx.fillStyle = CC.live; ctx.textAlign = "right";
        ctx.fillText(foot, railL - 4, H - priceB - 3);
      }
      legend.push(`<span class="li" style="color:${CC.live}">WHALE ORDERS ${whOrders.length} resting</span>`);
    }
    ctx.textAlign = "left";
  }

  // ── whale overlay: entries and events for THIS pair ──────────────────
  // Entry VWAP lines say where the whale cohort is positioned; event
  // markers say when we saw them act, on the same time axis as the tape.
  /* NOT COVERED is the one legend entry that is NOT gated on a mark having
     been drawn — it exists BECAUSE nothing was drawn. The overlay is ON by
     default and guarded only on `px != null`, so on a venue the sweep has
     never queried it painted nothing and said nothing, and for a year an
     empty overlay on xyz:TSLA read to the user as "no whales in this market".
     n_positions is null there (never asked) rather than 0 (asked, none), so
     the chip states the venue and carries the coverage sentence in its
     tooltip. Whale amber, like every other mark this layer owns. */
  if (state.inds.wh && state.whaleCoin && state.whaleCoin.coin === state.sel &&
      state.whaleCoin.n_positions == null) {
    const wcv = state.whaleCoin.coverage || {};
    legend.push(`<span class="li" style="color:${CC.live}" title="${esc(wcv.why ||
      "the whale sweep has not queried this venue")}">\u26a0 WHALES NOT COVERED` +
      `${wcv.venue ? " on " + esc(wcv.venue) : ""}</span>`);
  }
  if (state.inds.wh && state.whaleCoin && state.whaleCoin.coin === state.sel &&
      state.whaleCoin.n_positions != null) {
    const wc = state.whaleCoin;
    // The whale overlay's right edge is openR, which is plotR — the same
    // number since the plot became sized to exclude its furniture. It used
    // to matter a great deal that these were different: the book column
    // owned [colL, axisR] while plotR ran to axisR, so everything measured
    // from plotR was painted on top of the book in the book's own two
    // colours, and dash rhythm cannot separate them there — a whale long is
    // solid, exactly like a bid level. Named openR rather than plotR anyway,
    // because openR is what "the plot you may paint into" MEANS here, and
    // the day a fourth column appears it is the name that must move.
    const whR = openR;
    // Side must survive colourblindness here too, and hue alone cannot do
    // it now that whale-long and book-bid share one green: the DASH RHYTHM
    // is the second channel. Long = long dashes, short = tight dots.
    /* The label now goes at the LEFT end of the line, in the same column as
       S/R, POC and the expected-move band — and in the same lane, so the
       allocator can see them as one column instead of two that happen to
       miss each other.

       That column is where levels-with-a-history belong. It also breaks up
       the pile-up on the right: "WHALE L $233.4M avg 64,073" was
       right-aligned within ~20px of the amber order labels and interleaved
       with them in y, so the two instruments perceptually WERE one list —
       which is exactly how the owner read them, as a single run of tokens.

       This label was never space-constrained. It used 156.5px of a 444px
       budget; ~290px sat unused while the meaning was compressed out of it. */
    const lvl = (px, color, dash, side, ntl, slot) => {
      if (px == null || px < lo || px > hi) return false;
      const yy = y(px);
      /* The cohort line earns the plot like every other level. A cost basis
         four ATR away is a fact about the past, not a line to trade against;
         below the reach threshold it becomes a tick on the price scale and
         the roster footer still states the position. */
      const tier = ctxTier("wh" + side, px);
      if (tier === 0) {
        ctxTick(px, (side === "LONG" ? "\u25b2" : "\u25bc") + " " + fmtPx(px));
        return true;
      }
      /* A_MID, not A_FAINT, for the near tier. A_FAINT composites to 1.64:1
         against the panel for the short cohort — drawn, in the DEFAULT view,
         below the contrast at which it can be seen — and it is a line whose
         side is in its hue, which A_FAINT is not allowed to carry. There are
         at most two cohort lines, so paying A_MID for them costs nothing;
         the tiers stay distinct because the near one stops short. */
      ctx.strokeStyle = tier === 2 ? color : alpha(color.slice(0, 7), A_MID);
      ctx.setLineDash(dash);
      const wx = tier === 2 ? plotL : plotL + (whR - plotL) * 0.55;
      ctx.beginPath(); ctx.moveTo(wx, yy); ctx.lineTo(whR, yy); ctx.stroke();
      ctx.setLineDash([]);
      /* `slot` is {y, x, i} from placeRun, claimed far above so this label
         outranks the whale ORDER labels it shares a lane with. It carries an
         x as well as a y because a blocked row is not a reason to leave the
         line — every point on a full-width level is on that level, so the
         label slides right past whatever holds the left of the row and only
         changes row when the whole row is taken.

         Measured before that: with the volume profile or S/R switched on,
         BOTH cohort labels lost their slot at every width tested and the
         reader was left with two unnamed dashed lines. null still means the
         band is genuinely full — the legend chip then carries the colour
         rule, which is why that chip now spells out green long / red short.

         "avg 64,073" never said average of WHAT — price, size, leverage? —
         and "L"/"S" read as initials, which is why "WHALE L" parsed as a
         name. Plural + "open" separates a filled POSITION from the resting
         ORDERS that used to share this edge, and "avg entry" names the
         number as a cost basis rather than a current price or a target.
         The ladder drops the PRICE before it drops the words: a bare number
         with no noun is the failure being fixed, and the line's own
         y-position already is that price with the axis 20px away. */
      if (slot == null) return true;
      ctx.font = CHART_FONT_M; ctx.textAlign = "left";
      ctx.fillStyle = tier === 2 ? color : alpha(color.slice(0, 7), A_MID);
      // Exactly the rung whose width placeRun reserved — measuring one string
      // and painting a different one is how labels escape their allocation.
      ctx.fillText(whCands(side, ntl, px)[slot.i], slot.x, slot.y);
      // If it had to leave its own row, a tail joins the two so the
      // association is drawn rather than assumed.
      if (Math.abs(slot.y - (yy - 3)) > 1) {
        ctx.strokeStyle = color; ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(slot.x - 2.5, yy); ctx.lineTo(slot.x - 2.5, slot.y - 3);
        ctx.stroke();
      }
      return true;
    };
    let whLvl = false;
    // D_LONG and D_SHORT are the whale layer's alone again: the expected-move
    // band has vacated [6,4] and the POC has vacated [2,3].
    if (wc.avg_long_entry)
      whLvl = lvl(wc.avg_long_entry, alpha(CC.up, A_MID), D_LONG,
                  "LONG", wc.long_ntl, whSlot.long) || whLvl;
    if (wc.avg_short_entry)
      whLvl = lvl(wc.avg_short_entry, alpha(CC.down, A_MID), D_SHORT,
                  "SHORT", wc.short_ntl, whSlot.short) || whLvl;
    if (whLvl)
      legend.push(`<span class="li" style="color:${CC.live}">WHALE POSITIONS</span>` +
        `<span class="li" style="color:${CC.up}">\u25b2 long</span>` +
        `<span class="li" style="color:${CC.down}">\u25bc short</span>`);
    // Individual entries >=$1M: ticks on the right edge, so ten whales do
    // not become ten dashed lines across the candles. Thickness is the
    // magnitude decade (1e6/1e7/1e8) — exponent-only, deliberately coarse,
    // the same ladder the whales pane rail uses for its 2/4/6/9px heights.
    /* Demoted, not deleted.

       33 ticks at an 11px mean pitch inside an 8px column, with a 1/2/3/4px
       magnitude ladder finer than the pitch and no legend entry anywhere
       describing them: a comb, not a scale. Under the reach rule only the
       ticks price can actually get to draw on the rail, the rest collapse
       into a count, and the ladder finally gets the chip that names it.
       [3,2] retired in favour of D_SHORT so one rhythm means one thing —
       [2,3] and [3,2] share a 10px device period at dpr 2 and differ only in
       duty cycle, which is not resolvable on a 1px line. */
    let whTicks = 0, whHidden = 0;
    for (const wp of wc.positions || []) {
      if (wp.ntl < 1e6 || wp.entry_px == null ||
          wp.entry_px < lo || wp.entry_px > hi) continue;
      const yy = y(wp.entry_px);
      const long = wp.side === "long";
      // CTX_HOT, not CTX_FAR: at 4 ATR this filtered out 1 of 36 ticks on
      // live BTC and the comb survived intact. The rail is 8px wide — it can
      // hold the entries price can actually reach and nothing else.
      if (Math.abs(wp.entry_px - last) / atr14 >= CTX_HOT) { whHidden++; continue; }
      whTicks++;
      ctx.strokeStyle = long ? CC.up : CC.down;
      ctx.setLineDash(long ? [] : D_SHORT);   // non-colour side channel
      // floor() — this was missing, so the "deliberately coarse exponent-only
      // decade" the comment above describes did not exist: the expression
      // produced 17 distinct widths between 1.2px and 3.1px on live data, a
      // continuous ladder nobody can invert by eye at a 6px median tick
      // pitch. Now it is genuinely three steps: $1M, $10M, $100M.
      ctx.lineWidth = Math.min(4, 1 + Math.floor(Math.log10(wp.ntl / 1e6)));
      ctx.beginPath(); ctx.moveTo(whR - 8, yy); ctx.lineTo(whR, yy); ctx.stroke();
      ctx.lineWidth = 1; ctx.setLineDash([]);
      /* Hit target for peek/pin. The tick is 8x1 px and carries addr, side,
         ntl, lev, entry, uPnL and liq_px — every one of which is discarded
         by the mark itself. `spot` rides along so the liq row can state the
         distance, which is the half of a liquidation price that matters. */
      hitAdd({ kind: "whpos", key: "whpos:" + wp.addr + ":" + wp.entry_px,
               x: whR - 4, y: yy, r: 8, prio: 1, fx: whR - 4,
               px: wp.entry_px, spot: last, d: wp,
               title: "whale " + wp.side + " " + (wp.label || "") });
    }
    // The chip the tick ladder never had. Nothing on the canvas said what
    // thickness meant, and the WHALE POSITIONS chip describes the LINES.
    if (whTicks)
      legend.push(`<span class="li" style="color:${CC.s3}">${whTicks} ENTRY TICKS` +
        (whHidden ? ` <i style="color:${CC.s3}">${whHidden} out of reach</i>` : "") + `</span>`);
    // Timestamped events inside the window: when we SAW whales act.
    // A closed event used to paint grey, which threw away the side entirely
    // — a closed long and a closed short were identical in both channels.
    // Now it keeps the side colour AND the side-encoding triangle direction,
    // and says "closed" by being hollow instead of filled.
    let drewEvent = false;
    // Value labels are collected here and placed in a second pass below —
    // where one goes depends on the bar under it and on how many other
    // events share that bar, which cannot be known mid-loop.
    const evLabels = [];
    /* WHAT THE WINDOW THREW AWAY. The two range tests below are the only
       reason a queried, non-empty event list can draw nothing, and until
       these counters existed "the sweep found no whale action here" and
       "every whale action is outside the view you have panned to" were the
       same picture: no triangles, no chip, nothing. One is a measurement of
       the market, the other is a measurement of the viewport, and the chip
       below refuses to let the second read as the first.
       Counted separately because the remedies differ: off in TIME is fixed
       by panning or a longer interval, off in PRICE by zooming out. `evBad`
       is neither — an event the feed shipped without a timestamp or an entry
       price cannot be placed at all, and a silent drop there would be the
       same class of lie one level down. */
    let evOffT = 0, evOffP = 0, evBad = 0;
    /* PASS 1 — WHAT IS PLACEABLE AT ALL. Nothing draws here: a glyph's
       default y is y(entry_px), and a local collision step may still
       depend on every other triangle sharing its pixel, which is not
       known until the whole list has been read. */
    const evMarks = [];
    for (const e of wc.events || []) {
      if (!e.ts || e.entry_px == null) { evBad++; continue; }
      const ms = e.ts * 1000;
      if (ms < +cs[0].t || ms > +cs[n - 1].t + barMs) { evOffT++; continue; }
      if (e.entry_px < lo || e.entry_px > hi) { evOffP++; continue; }
      evMarks.push({ e, ex: cxT(ms), ey: y(e.entry_px), up: e.side === "long" });
    }

    /* ── WHERE A TRIANGLE GOES ─────────────────────────────────────────────

       Default Y is the trade's own price. A glyph stands TRI_GAP off
       y(entry_px), long below / short above, apex toward the datum. Two
       events with different entry_px therefore land on different scanlines.

       THE LADDER IS GONE. The previous placement parked every triangle on
       a global TRI_PITCH grid measured from padT, so a busy pane read as
       one stacked rail — glyphs sharing a scanline regardless of fill
       price. That is why they sat in one line. They do not any more.

       Collision is LOCAL to a pixel. If another glyph already occupies
       within TRI_BAND in x AND TRI_H in y of this event's natural box,
       the newcomer steps one TRI_PITCH outward (long down, short up)
       from ITS OWN price, not onto a pane-wide rung. Repeat out to
       TRI_REACH; past that the mark is dropped and counted. Two events
       at the same price and time stack as a short local column. Two
       events at different prices do not share a scanline.

       ORDER IS LARGEST DELTA FIRST, then ts, then addr. Unchanged: the
       winner of a contested pixel keeps its true price, and the same
       feed always draws the same column.

       x is untouched and still means WHEN (cxT). Fill vs hollow, long/
       short apex direction, and the hit target travelling with the glyph
       are unchanged. A 1px leader at A_FAINT still runs from y(entry_px)
       to the glyph's near edge when they are more than 1px apart, so a
       nudged mark still states its entry. A box outside [padT, H-priceB]
       is not a slot; dropping silently would make a busy bar look quiet,
       so those land in evCapped and the legend chip says "+N more". */
    evMarks.sort((a, b) => (b.e.delta_ntl || 0) - (a.e.delta_ntl || 0) ||
                           (a.e.ts || 0) - (b.e.ts || 0) ||
                           String(a.e.addr || "").localeCompare(String(b.e.addr || "")));
    const triTop = padT, triBot = H - priceB;
    const triPlaced = [];      // {gx, cy} of glyphs already standing
    let evCapped = 0;
    // PASS 2 — place at price, nudge only on a same-pixel clash, then draw.
    for (const m of evMarks) {
      const dir = m.up ? 1 : -1;    // outward from the datum: long down, short up
      // Snapped in x as well as y. The glyph is 8px wide and already rounds
      // time to +-4px, so a sub-device-pixel shift costs nothing and buys a
      // hard edge on both the triangle and the 1px leader beneath it.
      const gx = snap(m.ex);
      // Natural centre: TRI_GAP off y(entry_px), then half the glyph.
      // This is the trade's price, not a padT-measured rung.
      const nat = m.ey + dir * (TRI_GAP + TRI_H / 2);
      let cy = null;
      for (let d = 0; d <= TRI_REACH; d++) {
        const cand = snap(nat + dir * d * TRI_PITCH);
        const cgt = cand - TRI_H / 2, cgb = cand + TRI_H / 2;
        if (cgt < triTop || cgb > triBot) break;
        let hit = false;
        for (const p of triPlaced)
          if (Math.abs(p.gx - gx) < TRI_BAND && Math.abs(p.cy - cand) < TRI_H)
            { hit = true; break; }
        if (!hit) { cy = cand; break; }
      }
      if (cy == null) { evCapped++; continue; }
      triPlaced.push({ gx, cy });
      const gt = cy - TRI_H / 2, gb = cy + TRI_H / 2;
      const col = m.up ? CC.up : CC.down;
      drewEvent = true;
      /* THE PRICE, DRAWN. Chrome at A_FAINT and 1px, pinned to the glyph's
         own x, so the only ink it can cross already belongs to this event —
         the same argument the $-label's leader makes further down. Skipped
         when the glyph is within 1px of its datum, where the line would be
         shorter than the join between the two things it connects. */
      const near = m.ey <= gt ? gt : (m.ey >= gb ? gb : m.ey);
      if (Math.abs(near - m.ey) > 1) {
        ctx.strokeStyle = alpha(String(col).slice(0, 7), A_FAINT);
        ctx.lineWidth = 1; ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(gx, snap(m.ey)); ctx.lineTo(gx, near);
        ctx.stroke();
      }
      ctx.beginPath();
      // Apex AWAY from the base on the side the trade is: long points up,
      // short points down. gt/gb are the glyph box at y(entry_px) (plus a
      // local collision step, if any), not a pane-wide rung.
      if (m.up) { ctx.moveTo(gx, gt); ctx.lineTo(gx - TRI_W / 2, gb); ctx.lineTo(gx + TRI_W / 2, gb); }
      else { ctx.moveTo(gx, gb); ctx.lineTo(gx - TRI_W / 2, gt); ctx.lineTo(gx + TRI_W / 2, gt); }
      ctx.closePath();
      /* Hollow means REDUCING EXPOSURE, not just "closed". The feed emits
         five types — opened, increased, decreased, flipped, closed — and
         only "closed" was hollow, so "decreased" drew identically to
         "increased": a whale cutting a position and a whale adding to one
         were the same mark. On the live BTC feed that is 13 of 40 events
         asserting the opposite of what happened, which is a correctness bug
         rather than a legibility one, and it had to be fixed before any
         legend line could honestly describe this glyph. */
      const reducing = m.e.type === "closed" || m.e.type === "decreased";
      if (reducing) { ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke(); }
      else { ctx.fillStyle = col; ctx.fill(); }
      /* Hit target travels with the glyph. It used to be registered at
         the datum (ey +- 8) because that is where the glyph was; if the
         mark has been nudged off its price the target has to move with
         it, or the peek answers for a whale whose mark is 60px away —
         the one failure mode this pane must never have, since the plate
         would be confidently wrong rather than empty. The $-label is
         gated at $3M AND has to win a lane, so most triangles are
         anonymous marks and the peek is what names them. */
      hitAdd({ kind: "wevent", key: "wev:" + m.e.ts + ":" + m.e.addr,
               x: gx, y: (gt + gb) / 2, r: 8, prio: 1,
               ms: m.e.ts * 1000, px: m.e.entry_px, spot: last, d: m.e,
               title: (m.e.type || "event") + " $" + fmtBig(m.e.delta_ntl) });
      /* Collect only. The $3M gate and the axis/gutter guard are the two
         rules that decide whether a label EXISTS, so they stay here where
         the event is; everything about WHERE it goes is decided below,
         once every event on this bar is known. Only PLACED events get here:
         a label for a triangle that was capped out would be a number with no
         mark under it. */
      if ((m.e.delta_ntl || 0) >= 3e6 && gx < openR - 20)
        evLabels.push({ e: m.e, ex: gx, ey: m.ey, col, up: m.up, gt, gb,
                        // The bar under the label: the column gx sits in.
                        // gx is the event's own timestamp inside the bar
                        // (left edge = open), so nearest-centre is THAT bar,
                        // not the next one — which is where candle-centred
                        // cx() used to park a late fill.
                        bi: Math.max(0, Math.min(n - 1,
                              Math.round((gx - plotL) / slot - 0.5))) });
    }

    /* ── where a value label goes ───────────────────────────────────────

       It used to go at y(entry_px) ± a constant — 20px below the datum for
       a long, 14px above for a short. That is an offset from a PRICE with
       no reference to the bar at that x, so whether the label cleared the
       candle or printed straight through it was decided by where the entry
       happened to fall inside that bar's range, i.e. by luck. Measured on
       the live feed before this change: BTC 15m "$5.0M" at x 295.5 sat at
       y 184 inside a bar drawn 168 -> 435; ETH 1h "$13.2M" at x 465 sat at
       y 280.5 inside 248 -> 423; SOL 1h "$3.8M" at x 259.5 sat at y 203.5
       inside 188 -> 435. Three of eleven labels across five views were
       inside their candle and four more overlapped a wick.

       Now the label is anchored to the BAR: just clear of that bar's drawn
       extent, WICK INCLUDED — the high, not the top of the body.

       SIDE IS CHOSEN BY THE SIDE OF THE TRADE, never by the price. The
       glyph already encodes it: a long draws its triangle below the datum,
       a short above. So a long's label goes below the bar's LOW and a
       short's above the bar's HIGH, and label and triangle stay on the same
       side of the bar — which is what keeps side legible when a cluster of
       triangles is too tight to read individually. It is also the ordinary
       buy-below / sell-above convention, so it costs no explaining.

       THE CANDLE IS THE ONLY REFERENCE. An earlier pass also max'd the
       anchor against the triangle's own extent, on the true observation that
       entry_px is the WHALE'S entry and can fall outside the bar the event
       is timestamped into. That is exactly why the triangle must not set the
       anchor: the gap the reader then sees is measured from a PRICE, and it
       moves with wherever that entry happened to fall. Measured live with
       that rule in force, EV_CLEAR's 5px of air off the glyph came out as
       5.0, 5.0, 5.1, 5.2, 10.9, 12.1, 12.4, 13.0, 13.4, 15.5, 15.8, 15.9,
       18.9, 20.8, 29.8, 33.1, 43.5, 60.7, 80.4, 94.2 and 152.5px of air off
       the CANDLE across ten live views — 15 of 25 labels more than 10px from
       the bar they name, and four of them further from it than the bar is
       tall. That is the complaint, twice.

       So the anchor is y(c.l) / y(c.h) and nothing else, and the triangle is
       handled where it belongs: as an OCCUPANT of the stack rather than a
       datum for it. It holds row 0 whenever its ink box overlaps the label's
       there, and the label steps one row FURTHER OUT — never toward the bar,
       never re-measured from the glyph. Rows are therefore always 5, 19, 33,
       47 or 61px off the candle, which is a ladder a reader can count. Every
       gap measured after this change landed on it to within 0.2px.

       The occupant is THIS label's own triangle and no other. Testing every
       triangle whose 8px x-span can reach the label was tried first and
       measured worse: a $5M label is 30px wide and BTC 1h puts 18 triangles
       inside that span, 15 of them sub-$1M events that are drawn but never
       labelled, which blocked rows 0, 1 and 2 outright and cost 2 of 25
       labels across ten live views. A neighbour 15px to the side is a
       glancing clip of an 8px glyph; the label's own triangle is the only
       one GUARANTEED to be under it, because both are centred on the same
       ex. Overlap is tested bare, with no added pad — a pad buys a few px of
       air at the cost of a whole 14px row, and distance from the candle is
       the thing being fixed here.

       WHAT THIS RULE DOES NOT FIX, measured: a 30px label at a 4px bar pitch
       spans eight bars, so clearing ITS bar does not clear a taller
       neighbour — 6 of 16 labels across five live views still cross some
       other bar's wick. Anchoring to the extreme of every bar under the
       label instead was measured at 0-74px (median 22px) of extra
       displacement, which buys a clean wick by moving the number away from
       the bar it belongs to. The label's own bar is what the reader pairs
       it with, so that is what it clears.

       STACKING, which is the ask. Events on one bar — or on bars close
       enough that their ~36px labels reach each other — stack OUTWARD from
       the candle, one lane row each, so they read as a column that can be
       counted rather than a smear. Order is largest delta first, then ts,
       then x: fully determined, so the same data always draws the same
       column, and the biggest number gets the row nearest the candle, which
       is both the easiest to associate and the least likely to be lost. */

    /* Every row still goes through the lane allocator, for the reasons this
       block has always had to.

       The x-bucket had a seam. Bucketing by Math.round(ex/44) means two
       labels 1px apart in x can land in different buckets, and the
       allocator only ever compares within a lane — so neighbours across a
       bucket boundary were never compared at all and printed through each
       other, measured at 31 widths between 630 and 1440px. A ~36px centred
       label can only reach its immediate neighbours, so each one has to
       find its row free in the buckets either side before claiming its own.
       Each label checks both directions, so every pair gets seen from at
       least one end. Stacking does not weaken this: a row rejected in a
       neighbouring bucket is exactly the signal to step one row further
       out, which is how labels on ADJACENT bars stack as well as labels on
       the same bar.

       It must also clear lane "left". The curve head tags (EMA20 / EMA50 /
       VWAP / BOLL, named at their last plotted point) and the compact names
       on the nearest dormant levels live in that lane, and both sit at the
       right of the plot, which is exactly where recent whale events bunch.
       Measured when they were added: "BOLL" over "$5.4M" and "±1.19%" over
       "$25.3M", 1-4px apart in y. Same failure mode as the bucket seam —
       two marks in different lanes that can reach each other — so the fix
       is the same: declare the span and consult the other lane.

       This mark yields rather than the tags, because it is pinned in x by
       its timestamp and cannot move out of the way, while everything it
       collides with is already placed. It claims in "left" as well so the
       next event label sees it; nothing but the legend flush and the
       crosshair draws after this. */
    evLabels.sort((a, b) => (b.e.delta_ntl || 0) - (a.e.delta_ntl || 0) ||
                            (a.e.ts || 0) - (b.e.ts || 0) || a.ex - b.ex);
    ctx.font = CHART_FONT_S;
    ctx.textAlign = "center";
    for (const L of evLabels) {
      const c = cs[L.bi];
      if (!c) continue;
      const evTxt2 = "$" + fmtBig(L.e.delta_ntl);
      const tm = ctx.measureText(evTxt2), ew = tm.width;
      /* The ink box of THIS string, not a guessed cap height. fillText takes
         a BASELINE, so below the bar it has to be pushed down by the ascent
         and above the bar lifted by the descent — otherwise EV_CLEAR is
         measured from the baseline on one side and from the glyph tops on
         the other, and the same constant produces two different gaps.
         Measured at 10px mono: ascent 7.6, descent 1.47 (the $ descends), so
         ignoring it made the gap above 3.5px against 5.0px below. */
      const asc = tm.actualBoundingBoxAscent || 7;
      const dsc = tm.actualBoundingBoxDescent || 0;
      const bkt = Math.round(L.ex / 44);
      /* Anchored to the bar's DRAWN extent — its high and low, wick and all,
         never the body, and never the triangle or the entry price under it
         (see above). This is row 0; every other row is this plus whole EV_LH
         steps outward, so every gap on screen is measured from the candle. */
      const y0 = L.up
        ? y(c.l) + EV_CLEAR + asc    // long  → EV_CLEAR below the bar's LOW
        : y(c.h) - EV_CLEAR - dsc;   // short → EV_CLEAR above the bar's HIGH
      /* Its own glyph's ink box — the box the triangle ACTUALLY took,
         handed over by the pass above. Re-deriving it from the datum
         would miss a local collision nudge and guard a row the triangle
         has vacated. */
      const triT = L.gt, triB = L.gb;
      let ly = null, kUsed = 0;
      for (let k = 0; k < EV_STACK_MAX; k++) {
        const cand = y0 + (L.up ? 1 : -1) * k * EV_LH;
        // Off the plot is not a slot. The stack only ever grows away from
        // the bar, so the first row that falls off the edge ends the search.
        if (cand - asc < padT || cand + dsc > H - priceB) break;
        /* Row 0's occupant, when there is one: THIS label's own triangle,
           off the same datum the glyph was drawn from. `continue`, not
           `break` — a triangle is 6px of ink against a 14px row pitch, so
           the row immediately outside it is nearly always clear, and
           breaking here would drop a label that has somewhere good to go. */
        if (!(cand + dsc <= triT || triB <= cand - asc)) continue;
        if (lanes.free("wevent" + (bkt - 1), cand, EV_LH) &&
            lanes.free("wevent" + (bkt + 1), cand, EV_LH) &&
            lanes.free("left", cand, EV_LH, L.ex - ew / 2, L.ex + ew / 2) &&
            lanes.place("wevent" + bkt, cand, EV_LH) &&
            lanes.place("left", cand, EV_LH, L.ex - ew / 2, L.ex + ew / 2)) {
          ly = cand; kUsed = k; break;
        }
      }
      // Dropped, never overprinted — the standing rule for a mark that
      // cannot move in x. The peek names every triangle, so a lost label
      // costs a glance, while an overprinted one costs both numbers.
      if (ly == null) continue;
      /* A HAIRLINE, WHEN THE NUMBER HAD TO LEAVE ROW 0.

         The anchor rule above is right and the stack is right, but with
         EV_STACK_MAX 5 at EV_LH 14 a row-4 label sits 61px from its bar, and
         at that distance it stops reading as belonging to it — which is the
         residual behind "still not visibly right below the candle". The
         alternative on the table was anchoring to the extreme of every bar
         the 30px label spans; that was measured at 0-74px (median 22px) of
         EXTRA displacement, i.e. it buys a clean wick by moving the number
         further from the bar it names. A leader states the pairing instead,
         at any displacement, for zero vertical room.

         It claims NOTHING in the allocator: 1px wide, pinned to L.ex, which
         is the same x the label and its own triangle are centred on, so the
         only thing it can cross is ink that already belongs to this event.
         Drawn from the bar's own extreme to the label's near INK edge (not
         its baseline), so it touches neither. A_FAINT because it is chrome:
         it carries no side, no size and no price — the label it points at
         carries all three. */
      if (kUsed > 0) {
        const barY = L.up ? y(c.l) : y(c.h);
        const inkY = L.up ? ly - asc : ly + dsc;
        if (Math.abs(inkY - barY) > 2) {
          ctx.strokeStyle = alpha(String(L.col).slice(0, 7), A_FAINT);
          ctx.lineWidth = 1; ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(L.ex + 0.5, barY + (L.up ? 1 : -1));
          ctx.lineTo(L.ex + 0.5, inkY - (L.up ? 1 : -1));
          ctx.stroke();
        }
      }
      ctx.fillStyle = L.col;
      ctx.fillText(evTxt2, L.ex, ly);
      /* THE LABEL IS ITS OWN HIT TARGET, registered HERE because here is the
         only place `ly` exists. The triangle's target was registered up at
         the datum; the label is placed by the pass above, 9.5-43.6px away
         from it (measured across the live stack), and until this line the
         label had no target at all. Hovering the number therefore fell
         through to whatever disc happened to cover that pixel — a NEIGHBOUR
         whale, answering with its own size. That is the one place on this
         canvas where the terminal replied with a confidently wrong number
         rather than with nothing.

         Box, not disc, and the box is the ink (see objectAt): +2px of slop
         on each side, which is a pointer tolerance, not a claim about where
         the glyphs are. prio 0 — one band tighter than the triangle's 1 —
         so where the label overlaps a neighbour's loose 8px disc the label
         wins, which is what the d/r normalisation in objectAt was built for.
         Its own triangle carries the SAME key, so the two targets are one
         object to peek/pin: crossing from the number to its glyph does not
         re-arm the dwell clock or swap the plate. */
      hitAdd({ kind: "wevent", key: "wev:" + L.e.ts + ":" + L.e.addr,
               x: L.ex, y: ly - (asc - dsc) / 2,
               hw: ew / 2 + 2, hh: (asc + dsc) / 2 + 2, prio: 0,
               ms: L.e.ts * 1000, px: L.e.entry_px, spot: last, d: L.e,
               title: (L.e.type || "event") + " $" + fmtBig(L.e.delta_ntl) });
    }
    // The triangles and the entry ticks carry no text at all, so unlike every
    // other mark on this pane they cannot explain themselves inline. This is
    // the one piece of chart vocabulary that genuinely needs the legend.
    if (drewEvent)
      legend.push(`<span class="li" style="color:${CC.s3}">▲▼ whale acted` +
        (evCapped ? ` <i style="color:${CC.s3}" title="${esc(evCapped +
          " more whale events fall inside this view and were NOT drawn: every local " +
          "step within " + TRI_REACH + " of their own entry price was already taken by " +
          "another triangle at the same pixel. They are held, not lost — the whales " +
          "pane lists them, and zooming in on that time band spreads them out." +
          " A stack is capped so it cannot run off the pane; this is what the cap " +
          "cost on this view.")}">+${evCapped} more</i>` : "") + `</span>`);
    /* Nothing drew, but events EXIST. Says which axis put them out of reach
       and how many, so the reader knows there is something to pan or zoom
       to. Deliberately not pushed alongside drawn triangles: with marks on
       screen the reader can already see the layer is alive, and a permanent
       "n more elsewhere" chip on every view is noise. */
    else if (evOffT || evOffP || evBad || evCapped) {
      const parts = [];
      if (evOffT) parts.push(evOffT + " off this time window");
      if (evOffP) parts.push(evOffP + " off this price range");
      if (evBad) parts.push(evBad + " unplaceable (no ts/entry)");
      if (evCapped) parts.push(evCapped + " with no free pixel in the local stack");
      legend.push(`<span class="li" style="color:${CC.s3}" ` +
        `title="${esc((wc.events || []).length + " whale events were returned " +
          "for this instrument and none of them fall inside the view you are " +
          "looking at: " + parts.join(", ") + ". This is a statement about the " +
          "VIEWPORT, not about the market — pan, widen the interval or zoom " +
          "out to reach them.")}">` +
        `▲▼ ${(wc.events || []).length} WHALE EVENTS OFF-VIEW</span>`);
    }
    /* Same invariant one level down: positions ARE swept on this venue but
       resting orders are fetched on core only, so the absence of amber order
       ticks here is not-fetched, not nobody-resting. Said only when the layer
       actually drew something, so it qualifies visible marks rather than
       announcing itself over an empty plot (which the chip above already
       covers). */
    if ((wc.coverage || {}).orders_covered === false && (whLvl || whTicks || drewEvent))
      legend.push(`<span class="li" style="color:${CC.s3}" ` +
        `title="${esc((wc.coverage || {}).orders_why || "")}">` +
        `whale orders NOT FETCHED here</span>`);
    ctx.textAlign = "left";
  }

  /* The legend is flushed HERE, after every layer has had its say.

     It used to render ~450 lines above this point, which meant the two
     indicators that are ON BY DEFAULT — the book gutter and the whale
     overlay, both drawn below it — could not contribute to it at all. Any
     legend.push() in those blocks was built and then silently discarded, so
     of the twelve indicators the only two the owner had never opted into
     were also the only two with no explanation anywhere on screen. In his
     saved view (whale + book, everything else off) this element computed to
     display:none: the vocabulary he was asking about had no decoder at all.

     Every entry is gated on the predicate that actually DREW the mark, not
     on the button that requests it — the right column, for instance, needs
     its tenant selected AND 220px of axis AND (for the book) levels to draw,
     and it yields entirely to the heatmap gutter. Keying off the button
     would print a decoder for a column that stood down for width, which is
     the same class of lie as the delta strip's "max $1". Where the column
     stands down, the chip says WHICH constraint stood it down. */
  /* ── PEEK / PIN plates paint HERE: after every automatic layer, so the
     thing the owner is actually asking about is never buried by a layer the
     chart decided on by itself. Their rows were claimed ~2,000 lines above,
     immediately after the ruler's, which is where the priority actually
     lives; this is only ink. */
  for (const pl of plates) {
    if (pl.pinned) {
      // A pin keeps a leader and a marker on its object, because the plate
      // can be pushed rows away by the allocator and a plate with nothing
      // tying it to a mark is a caption for an unknown thing.
      ctx.strokeStyle = CC.live; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pl.ax, pl.ay);
      ctx.lineTo(pl.bx < pl.ax ? pl.bx + pl.bw : pl.bx, pl.by + 8);
      ctx.stroke();
      ctx.fillStyle = CC.live;
      ctx.fillRect(pl.ax - 2, pl.ay - 2, 4, 4);
    }
    ctx.fillStyle = CC.fpPlate;
    ctx.fillRect(pl.bx, pl.by, pl.bw, pl.bh);
    ctx.strokeStyle = pl.pinned ? CC.live : CC.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(pl.bx, pl.by, pl.bw, pl.bh);
    ctx.font = CHART_FONT_S; ctx.textAlign = "left";
    ctx.fillStyle = pl.pinned ? CC.live : CC.s3;
    ctx.fillText(pl.title, pl.bx + 4, pl.by + 10);
    pl.rows.forEach(([k, v], i) => {
      const ry = pl.by + PLATE_HEAD + i * PLATE_RH + 8;
      ctx.textAlign = "left"; ctx.fillStyle = CC.s2;
      ctx.fillText(k, pl.bx + 4, ry);
      ctx.textAlign = "right"; ctx.fillStyle = CC.s3;
      ctx.fillText(v, pl.bx + pl.bw - 4, ry);
    });
    ctx.textAlign = "left";
  }
  /* The frame's hit registry becomes the one the pointer is answered
     against, now that every layer has finished registering. Swapped
     wholesale rather than mutated, for the same reason state.ctxHot below
     is: a registry that accumulates across frames answers for marks that
     are no longer drawn. */
  HITS_LAST = HITS.slice();

  /* Swap the reach hysteresis set for the one this frame built. Rebuilt from
     scratch every frame and replaced wholesale, so it tracks exactly the
     levels that were on screen and cannot grow without bound. */
  state.ctxHot = nextHot;

  const lg = $("legend");
  if (legend.length) { lg.style.display = "block"; lg.innerHTML = legend.join(""); }
  else { lg.style.display = "none"; lg.innerHTML = ""; }

  // crosshair
  if (state.hover != null && cs[state.hover]) {
    const i = state.hover, c = cs[i];
    ctx.strokeStyle = alpha(CC.s2, A_FAINT);
    ctx.beginPath(); ctx.moveTo(x(i), padT); ctx.lineTo(x(i), H - stackB); ctx.stroke();
    const d = new Date(c.t);
    const when = state.interval === "1d"
      ? d.toISOString().slice(0, 10)
      : d.toISOString().slice(5, 16).replace("T", " ");
    const xh = $("xhair");
    xh.style.display = "block";
    let extra = "";
    if (state.inds.fp || state.inds.cvd) {
      const dm = barDelta(cs, stepMs);
      const d = dm.get(c.t);
      extra = d === undefined ? "  Δ —"
        : `  Δ ${d >= 0 ? "+" : "-"}$${fmtBig(Math.abs(d))}`;
    }
    xh.textContent = `${when}Z  O ${fmtPx(c.o)} H ${fmtPx(c.h)} L ${fmtPx(c.l)} ` +
      `C ${fmtPx(c.c)} V ${fmtBig(c.v)}${extra}`;
    // Time tag pinned to the axis under the cursor — the corner readout is
    // where the numbers live, but the eye asking "when was this bar?" is
    // looking at the bottom of the crosshair line. Both zones, since the
    // axis is UTC and the user's clock is IST.
    const ist = d.toLocaleString("en-GB", { timeZone: "Asia/Kolkata",
      hour: "2-digit", minute: "2-digit",
      ...(state.interval === "1d" || state.interval === "4h"
          ? { day: "2-digit", month: "short" } : {}) }).replace(",", "");
    const tag = `${when}Z · ${ist} IST`;
    ctx.font = CHART_FONT_M;
    const tw = ctx.measureText(tag).width + 8;
    const tx = Math.max(plotL, Math.min(plotR - tw, x(i) - tw / 2));
    ctx.fillStyle = CC.xhTag;
    ctx.fillRect(tx, H - padB + 1, tw, 12);
    ctx.strokeStyle = alpha(CC.s1, A_MID);
    ctx.strokeRect(tx + 0.5, H - padB + 1.5, tw - 1, 11);
    ctx.fillStyle = CC.plan; ctx.textAlign = "left";
    ctx.fillText(tag, tx + 4, H - padB + 10);
  } else {
    $("xhair").style.display = "none";
  }

  const first = cs[0].o, chg = pct(last, first);
  const zoomed = vCount < all.length || vOff !== 0;
  $("chart-meta").textContent =
    `O ${fmtPx(first)}  H ${fmtPx(winHi)}  L ${fmtPx(winLo)}  C ${fmtPx(last)}  ` +
    `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}% (WINDOW)` +
    (zoomed ? `  · ${n}/${all.length} bars` +
      (vOff > 0 ? " · ⏴" + vOff : vOff < 0 ? " · " + (-vOff) + " ahead" : "") : "");
}

/* ---------------- liquidity heatmap ----------------
   The full-precision book spans only ~0.07% of price — invisible against a
   chart. Hyperliquid can aggregate levels into coarser buckets (nSigFigs),
   so we ask for the granularity that matches what the chart is showing. */
const HEAT_WINDOW_MS = 5 * 60 * 1000;   // fallback window: session ring only
const HEAT_STALE_MS = 10000;            // no fresh book for this long = stale

function histLabel(snaps) {
  if (!snaps.length) return "0s";
  const secs = Math.round((snaps[snaps.length - 1].t - snaps[0].t) / 1000);
  return secs < 60 ? secs + "s" : Math.round(secs / 60) + "m";
}

/* ms -> "45s" / "12m" / "3.5h" / "9d". The strip's span is the CHART's span,
   so it moves with zoom and interval and the chip has to say all four. */
function spanLabel(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return s + "s";
  if (s < 5400) return Math.round(s / 60) + "m";
  if (s < 172800) return (s < 36000 ? (s / 3600).toFixed(1) : Math.round(s / 3600)) + "h";
  return Math.round(s / 86400) + "d";
}

/* ---------------- persisted depth history ----------------

   The gutter's history strip used to draw `state.heat.snaps` and nothing
   else: a five-minute ring buffer that died with the tab, so "did the book
   thin out BEFORE the move?" could only ever be asked of the last five
   minutes, and a reload erased even that. `datasources/depth_history.py` now
   persists the depth CURVE server-side — notional resting within
   ±[5,10,25,50,100,250]bps of mid, per side, median-folded to one row a
   minute, 48h fine / 400d hourly — so the strip reaches back as far as the
   chart does and survives a reload. It cannot be backfilled: Hyperliquid
   publishes no book archive, which is why the veil and the coverage note
   below are not decoration.

   THE RECORD IS A BAND PROFILE, NOT A LEVEL BOOK. It knows how much was
   resting within ±25bps of mid; it never knows that $4M sat at 64,300. So a
   history cell is a SHELL — the notional between one band and the next,
   differenced out of the cumulative bands HERE and nowhere else — drawn
   across the price range that shell actually occupies, and shaded by DENSITY
   ($ per bp) so a 5bp-wide shell and a 150bp-wide one are comparable at all.
   Shading the cumulative band directly would paint the same dollars six times
   over and make every book on the venue look bottom-heavy.

   Normalised against its OWN 85th percentile rather than against the live
   ladder's: the question this strip answers is "is the book thinner than it
   has been?", which is a comparison inside the record, and the ladder's
   per-bucket dollars are a different unit entirely. */
const DEPTH_MIN_ROWS = 2;      // below this the server record cannot draw

/* Width in px the gutter's history strip had on the last frame. Layout is
   settled in drawChart and the fetch has to know it, because the strip is
   46-128px wide and the number of columns it can honestly draw is the number
   of buckets worth asking for. Written once per draw, read once per fetch. */
let GUTTER_HIST_W = 0;

function depthHistCols(tStart, tEnd) {
  const dh = state.depthHist;
  if (!dh || dh.coin !== state.sel) return null;
  const rows = dh.series || [];
  if (rows.length < DEPTH_MIN_ROWS) return null;
  const grid = dh.bands_bps || [5, 10, 25, 50, 100, 250];
  const bucketMs = (dh.bucket_s || 60) * 1000;
  const cols = [], dens = [];
  for (const r of rows) {
    const mid = r.mid;
    if (!mid || r.ms + bucketMs < tStart || r.ms > tEnd) continue;
    const cells = [];
    for (const side of ["b", "a"]) {
      const band = (side === "b" ? r.bid : r.ask) || [];
      let prevI = -1;
      for (let i = 0; i < grid.length; i++) {
        if (band[i] == null) continue;      // band unresolvable at this tick
        const inner = prevI < 0 ? 0 : grid[prevI];
        const shell = band[i] - (prevI < 0 ? 0 : band[prevI]);
        prevI = i;
        const wBps = grid[i] - inner;
        // A seam between the two nSigFigs resolutions can in principle hand
        // back a smaller cumulative at the wider band. That is not a shell of
        // negative liquidity, it is a shell we cannot difference — so it is
        // dropped and reads as a hole, never drawn as zero.
        if (wBps <= 0 || !(shell > 0)) continue;
        const sgn = side === "b" ? -1 : 1;
        const pIn = mid * (1 + sgn * inner / 1e4);
        const pOut = mid * (1 + sgn * grid[i] / 1e4);
        const d = shell / wBps;
        cells.push({ lo: Math.min(pIn, pOut), hi: Math.max(pIn, pOut), d, side });
        dens.push(d);
      }
    }
    if (cells.length) cols.push({ ms: r.ms, cells });
  }
  if (!cols.length) return null;
  dens.sort((a, b) => a - b);
  const norm = dens[Math.floor(dens.length * 0.85)] || dens[dens.length - 1] || 1;
  // The OUTER band travels with the columns because it is the strip's price
  // reach: nothing is recorded beyond it, so blank sky above the top shell
  // means "outside the recorded band", never "no resting size up there".
  return { cols, norm, bucketMs, firstMs: rows[0].ms,
           outerBps: grid[grid.length - 1],
           coverage: dh.coverage || null };
}

async function loadDepthHist() {
  if (!state.inds.heat || !state.sel) return;
  const coin = state.sel, iv = state.interval;
  try {
    const bars = state.candles.length || 120;
    const barSec = Math.max(60, Math.round((state.candles.length > 1
      ? (state.candles[1].t - state.candles[0].t) : 300000) / 1000));
    /* Ask at the chart's own resolution — then COARSEN until the strip can
       draw what it asked for.

       The CVD pane can take 140 one-bar buckets because it owns the full plot
       width. This strip owns 46-128px, so 140 columns would be four-fifths
       thrown away and the fifth that survived would be whichever row happened
       to paint last in each pixel: an arbitrary sample dressed up as a
       summary. Coarsening instead sends the roll-up to the server's _merge(),
       which is the only place that knows depth takes a MEDIAN and never a sum
       — summing a level would make the number a function of the sampling
       rate. The bucket stays an integer multiple of the chart's bar, so a
       column is always a whole number of bars. */
    const cols = Math.max(24, Math.min(160, Math.round(GUTTER_HIST_W || 64)));
    const bucket = barSec * Math.max(1, Math.ceil(bars / cols));
    // Minute tier is 48h; only an hourly-or-coarser request reaches the
    // 400-day tier behind it, exactly as the flow collector's two tiers work.
    const capH = bucket >= 3600 ? 24 * 400 : 48;
    const hours = Math.min(capH, Math.max(1, barSec * bars / 3600));
    const r = await fetch(`/api/depth?coin=${encodeURIComponent(coin)}` +
                          `&bucket=${bucket}&hours=${hours.toFixed(1)}`);
    const d = await r.json();
    if (state.sel !== coin || state.interval !== iv) return;   // user moved on
    state.depthHist = {
      coin, bucket_s: d.bucket_s, series: d.series || [],
      bands_bps: d.bands_bps, coverage: d.coverage || null,
      delta_pct: d.delta_pct || null, delta_band_bps: d.delta_band_bps,
      at: Date.now(),
    };
    drawChart();
  } catch (e) { /* keep last */ }
}

function heatSigFigs() {
  const sc = state.scale;
  if (!sc || !sc.lo) return 4;
  const spanPct = sc.span / ((sc.hi + sc.lo) / 2) * 100;
  return spanPct > 2 ? 3 : spanPct > 0.2 ? 4 : 5;   // ~6% / ~0.6% / ~0.06%
}

async function pollHeat() {
  /* Serves TWO consumers now: the heatmap gutter, and the right column's
     book tenant, which draws the aggregated ladder rather than the raw
     websocket one (the raw one covers 1.17% of the pane at the owner's
     default zoom; this one covers 91.0%). They cannot both be on — the
     column stands down whenever the gutter fits — so one cache is enough. */
  if (!state.sel || (!state.inds.heat && !state.inds.book)) return;
  const sig = heatSigFigs();
  const coin = state.sel;
  try {
    const d = await fetch(`/api/book?coin=${encodeURIComponent(coin)}&sig=${sig}`)
      .then((r) => r.json());
    if (d.coin !== state.sel) return;              // symbol changed mid-flight
    if (state.heat.coin !== coin || state.heat.sig !== sig)
      state.heat = { coin, sig, snaps: [], live: null, at: 0, bucketW: 0, err: null };
    if (d.error) { state.heat.err = d.error; drawChart(); return; }
    /* Same note, the other consumer. heatSigFigs() only ever returns 3, 4 or
       5, so the server has no reason to substitute today — but the gutter
       and the right-column ladder are both drawn in BUCKETS whose width is
       exactly this parameter, so a silent substitution would rescale every
       wall on the glass. Carried, and stated in the legend below. */
    state.heat.reqNote = d.request_note || null;
    const bids = d.bids || [], asks = d.asks || [];
    const rows = [];
    for (const l of bids) rows.push([l.px, l.sz * l.px, "b"]);
    for (const l of asks) rows.push([l.px, l.sz * l.px, "a"]);
    if (!rows.length) return;
    // Aggregation rounds bids DOWN and asks UP to the bucket edge, so a
    // labelled price sits on the far side of where the size actually rests.
    // Keep the bucket width so we can quote the NEAR edge instead.
    let bw = 0;
    if (bids.length > 1) bw = Math.abs(bids[0].px - bids[1].px);
    else if (asks.length > 1) bw = Math.abs(asks[1].px - asks[0].px);
    state.heat.bucketW = bw;
    state.heat.err = null;
    state.heat.live = rows;
    state.heat.at = Date.now();
    const hs = state.heat.snaps;
    if (!hs.length || state.heat.at - hs[hs.length - 1].t > 2000) {
      hs.push({ t: state.heat.at, rows });
      const cutoff = state.heat.at - HEAT_WINDOW_MS;
      while (hs.length && hs[0].t < cutoff) hs.shift();
    }
    drawChart();
  } catch (e) { /* transient */ }
}
/* GATED ON VISIBILITY — this is the rate-limit fix.

   Measured 2026-08-16 during a live 429 outage: every poller below ran at full
   rate in EVERY open tab, including hidden ones. Nine tabs were open at the
   time (this desk accumulates them), so the terminal was making nine times the
   outbound Hyperliquid traffic it needed and rate-limiting ITSELF — a direct
   HL call from the shell answered in 0.3s at the same moment /api/candles was
   returning 429. The visibilitychange handler above already refills pollHeat,
   loadCandles, loadSrDaily, loadSides and loadSidesBook the instant a tab comes
   back, so a hidden tab loses nothing by standing down. The comment at the top
   of this file claiming "the document.hidden discipline lives at the CALL
   sites... exactly like pollHeat" was aspirational: pollHeat's own interval had
   no gate. */
setInterval(() => { if (!document.hidden) pollHeat(); }, 2000);
// Browsers throttle timers in background tabs, so the book can be minutes old
// on return. The staleness banner covers the gap; this refills it immediately.
document.addEventListener("visibilitychange", () => {
  // Background tabs suspend requestAnimationFrame, so a draw scheduled just
  // before the tab was hidden can still be sitting in the queue. Drop it here
  // so a suspended frame can never leave scheduleDraw() convinced a repaint
  // is already on its way (scheduleDraw's own 400ms expiry is the backstop
  // for occlusion, which does not fire this event at all).
  if (drawPending) { cancelAnimationFrame(drawPending); drawPending = 0; }
  // BOTH SIDES is on the same throttled timers, and now that its ladder and
  // its payload state their age, a tab that has been in the background comes
  // back saying "40s old" until the next tick. Refill it here for the same
  // reason the heat map is refilled: the banner is for a real gap, not for
  // one this handler can close.
  if (!document.hidden) {
    pollHeat(); loadCandles(); loadSrDaily(); loadSides(); loadSidesBook();
  }
});

/* ---------------- trade-level ruler ----------------
   R arms it; first click sets entry, second sets stop (target seeded at 2R,
   then dragged with the handle below); Enter converts the levels into
   standing price alerts.

   The whole plan persists under hlterm_ruler. It did not, and the alerts it
   arms live in hlterm_alerts, which DO: a reload left three standing alerts
   with nothing on the glass to explain them. */
function yToPrice(clientY) {
  const sc = state.scale; if (!sc) return null;
  const rect = $("chart").getBoundingClientRect();
  const yPx = clientY - rect.top;
  // Only the price pane maps to a price; the sub-panes and axis do not.
  if (yPx < sc.padT || yPx > sc.H - sc.priceB) return null;
  return sc.hi - (yPx - sc.padT) * sc.span / (sc.H - sc.padT - sc.priceB);
}

/* Inverse of yToPrice, and the exact mapping drawChart's local y() paints
   with. A hit-test derived any other way would be testing against a line
   that is not the one on the glass. */
function priceToY(px) {
  const sc = state.scale;
  if (!sc || px == null || !isFinite(px)) return null;
  return sc.padT + (sc.hi - px) / sc.span * (sc.H - sc.padT - sc.priceB);
}

/* The target is the one level of the plan the owner is expected to move:
   entry and stop are where the structure is, the target is where he decides
   the trade is worth taking. Grab band is +/-6px — a hair under the 7px the
   wall hit-test uses, and deliberately no wider, because every pixel of it
   is a pixel of the canvas where a press no longer starts a pan. */
const RULER_GRAB_PX = 6;
const RDRAG = { active: false, moved: false, startY: 0 };

function rulerTargetHit(e) {
  const ru = state.ruler;
  if (ru.armed || ru.target == null || ru.coin !== state.sel) return false;
  const yy = priceToY(ru.target);
  if (yy == null) return false;
  const rect = $("chart").getBoundingClientRect();
  return Math.abs((e.clientY - rect.top) - yy) <= RULER_GRAB_PX;
}

function rulerDragTo(e) {
  const ru = state.ruler;
  if (ru.entry == null) return;
  // A press inside the band that then pans horizontally must not nudge the
  // target by a pixel on the way past. Nothing moves until the pointer has
  // committed vertically.
  if (!RDRAG.moved && Math.abs(e.clientY - RDRAG.startY) < 3) return;
  const px = yToPrice(e.clientY);
  if (px == null || !isFinite(px)) return;   // dragged off the price pane
  RDRAG.moved = true;
  $("chart").style.cursor = "ns-resize";
  // The target is the REWARD side by construction: whichever side of entry
  // the stop is not on. Dragging it across entry would make the printed
  // "R:R" a ratio of two losses, so the handle stops at entry instead.
  const eps = Math.abs(ru.entry) * 1e-5;
  ru.target = ru.stop == null ? px
    : ru.stop < ru.entry ? Math.max(px, ru.entry + eps)
                         : Math.min(px, ru.entry - eps);
  scheduleDraw();
}

function rulerDragEnd() {
  RDRAG.active = false;
  $("chart").style.cursor = "";
  if (!RDRAG.moved) return;      // a press that never committed is still a click
  const ru = state.ruler;
  saveRuler();
  // The click event fires after mouseup — same one-tick suppression the pan
  // uses, so releasing a drag over a liquidity wall does not also arm an
  // alert there.
  setTimeout(() => { RDRAG.moved = false; }, 0);
  const rr = ru.stop != null && ru.entry !== ru.stop
    ? Math.abs(ru.target - ru.entry) / Math.abs(ru.entry - ru.stop) : null;
  const head = `target ${fmtPx(ru.target)}` +
    (rr != null && isFinite(rr) ? `  R:R ${rr.toFixed(2)}` : "");
  // An alert does not follow the line it was armed from. If ENTER has already
  // been pressed, the OLD target price is still standing in hlterm_alerts and
  // a line that has visibly moved must not be allowed to imply otherwise.
  const oldT = ru.armedAt ? ru.armedAt.target : null;
  if (oldT != null && Math.abs(oldT - ru.target) > Math.abs(ru.entry) * 1e-5)
    showToast(`${head} — alert still armed at ${fmtPx(oldT)}, ENTER to re-arm`);
  else showToast(head);
}

function toggleRuler() {
  const ru = state.ruler;
  // Taking manual control retires any stored plan for another coin: the key
  // is about to describe this one instead.
  state.rulerPending = null;
  if (ru.armed || ru.entry != null) clearRuler();
  else {
    ru.armed = true;
    $("chart").classList.add("ruler");
    $("chart").style.cursor = ""; $("chart").title = "";
    showToast("RULER — click entry, then stop");
  }
  drawChart();
}

function clearRuler() {
  state.ruler = { armed: false, coin: null, entry: null, stop: null,
                  target: null, armedAt: null };
  $("chart").classList.remove("ruler");
  // Also reached from selectCoin: switching instrument has always abandoned
  // the plan, so the stored copy goes with it rather than being resurrected
  // on the next reload. rulerPending is deliberately NOT cleared here — it is
  // how selectCoin hands a stored plan back to its own coin.
  saveRuler();
  drawChart();
}

/* ── ruler persistence — hlterm_ruler ─────────────────────────────────────
   One JSON blob, read inside try/catch, discarded whole rather than half
   applied — the same shape as hlterm_layouts / hlterm_inds / hlterm_alerts.
   Nothing here expires: the alerts a plan armed do not expire either, and a
   second silent-drop path is exactly what this key exists to remove. */
const RULER_KEY = "hlterm_ruler";

const ruNum = (v) => (typeof v === "number" && isFinite(v) && v > 0 ? v : null);

function saveRuler() {
  const ru = state.ruler;
  if (ru.entry == null || !ru.coin) {
    // Nothing planned. An armed-but-empty ruler has no levels to restore.
    try { localStorage.removeItem(RULER_KEY); } catch (e) { /* non-fatal */ }
    return;
  }
  try {
    localStorage.setItem(RULER_KEY, JSON.stringify({
      coin: ru.coin, entry: ru.entry, stop: ru.stop, target: ru.target,
      armed: !!ru.armed, armedAt: ru.armedAt || null, at: Date.now(),
    }));
  } catch (e) { /* quota — non-fatal, same as saveLayouts */ }
}

function readSavedRuler() {
  let raw = null;
  try { raw = localStorage.getItem(RULER_KEY); } catch (e) { return null; }
  if (!raw) return null;
  let d = null;
  try { d = JSON.parse(raw); } catch (e) { d = null; }
  const coin = d && typeof d.coin === "string" && d.coin ? d.coin : null;
  const entry = d ? ruNum(d.entry) : null;
  if (!coin || !entry) {
    // Corrupt or half-written. Drop it and SAY so — a plan disappearing
    // without a word is the failure this key was added to prevent, and a
    // silent discard here would reproduce it exactly.
    try { localStorage.removeItem(RULER_KEY); } catch (e) { /* non-fatal */ }
    showToast("saved ruler was unreadable — discarded");
    return null;
  }
  const stop = ruNum(d.stop);
  const a = d.armedAt && typeof d.armedAt === "object" ? d.armedAt : null;
  return {
    coin, entry, stop,
    // Target and stop are written together by rulerClick; a target with no
    // risk leg is not half a plan, it is an R:R with no denominator.
    target: stop != null ? ruNum(d.target) : null,
    armed: !!d.armed && stop == null,
    armedAt: a ? { entry: ruNum(a.entry), stop: ruNum(a.stop),
                   target: ruNum(a.target) } : null,
    at: ruNum(d.at),
  };
}

function applyRuler(s) {
  state.ruler = { armed: s.armed, coin: s.coin, entry: s.entry, stop: s.stop,
                  target: s.target, armedAt: s.armedAt };
  $("chart").classList.toggle("ruler", !!s.armed);
  saveRuler();
  drawChart();
  // Provenance, not decoration: levels that reappear on their own have to
  // say when they were drawn. An unrecorded time is reported as unrecorded
  // rather than printed as the epoch.
  const when = s.at ? new Date(s.at).toLocaleTimeString("en-IN", IST) + " IST"
                    : "an unrecorded time";
  showToast(`ruler restored — ${baseSym(s.coin)} plan from ${when}`);
}

/* How many standing alerts this plan actually has — counted, not assumed.
   armedAt is null until ENTER is pressed (readSavedRuler permits that
   explicitly), so a plan that was drawn and never armed has no alerts at all;
   and an armed one can have fired or been dismissed since, which is why the
   levels are checked against the live alert list rather than inferred from
   armedAt alone. loadAlerts() runs before restoreRuler() in boot, so this
   reads the restored list and not an empty one. */
function rulerArmedCount(s) {
  if (!s || !s.armedAt) return 0;
  const lv = [s.armedAt.entry, s.armedAt.stop, s.armedAt.target]
    .filter((v) => v != null);
  return (state.alerts || []).filter((a) => !a.fired && a.coin === s.coin &&
    lv.some((v) => Math.abs(a.level - v) < Math.abs(v) * 1e-6)).length;
}

function restoreRuler() {
  const s = readSavedRuler();
  if (!s) return;
  if (s.coin !== state.sel) {
    // Never draw one instrument's levels over another's chart. The plan is
    // held, not shown, and comes back the moment its own coin is charted;
    // staying silent here would leave its armed alerts with no visible cause.
    // But the alerts clause is a claim about STANDING ALERTS and used to be
    // printed unconditionally — on a plan whose ENTER was never pressed it
    // asserted watchers that were never created at all.
    state.rulerPending = s;
    const n = rulerArmedCount(s);
    showToast(`saved ruler is for ${baseSym(s.coin)}, not ${baseSym(state.sel)}` +
      " — select it to restore " +
      (n ? `(its ${n} alert${n === 1 ? " is" : "s are"} still armed)`
         : s.armedAt ? "(the alerts it armed are gone — fired or dismissed)"
                     : "(it armed no alerts — ENTER was never pressed on it)"));
    return;
  }
  applyRuler(s);
}

function wallAtEvent(e) {
  if (!state.heatWalls.length) return null;
  const rect = $("chart").getBoundingClientRect();
  const yPx = e.clientY - rect.top;
  let best = null, bestD = 7;                       // px tolerance
  for (const w of state.heatWalls) {
    const d = Math.abs(w.y - yPx);
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}

function rulerClick(e) {
  const ru = state.ruler;
  /* ONLY AN UNMODIFIED CLICK ACTS. This is the one path on the chart that
     writes state the owner did not ask for: armAlert -> state.alerts ->
     localStorage, and those alerts fire to Telegram. Everything else here
     redraws.

     MEASURED on the pre-fix build: no mouse handler read modifier state at
     all, so alt-click, shift-click, ctrl-click and cmd-click were silently
     identical to a bare click and each one armed an alert on whatever
     liquidity wall was within 7px of the release. Alt-click and cmd-click
     are OS-level gestures on macOS (and ctrl-click opens the context menu),
     so the user pressing them is by definition not asking this chart for
     anything. Modified click does nothing — that is the whole rule.

     The other half of the same defect (a straight-down drag falling through
     as a click) is fixed by the radial dead zone in the pan handler; both
     are needed, they close different doors. */
  if (e && (e.altKey || e.shiftKey || e.metaKey || e.ctrlKey)) return;
  {
    const rectN0 = $("chart").getBoundingClientRect();
    const hitN0 = objectAt(e.clientX - rectN0.left, e.clientY - rectN0.top);
    if (hitN0 && hitN0.kind === "news") return;
  }
  if (!ru.armed) {
    // A news flag under the pointer is not a wall and not a ruler click.
    // Drag still pans (mousedown already armed PAN); this only skips the
    // click-to-arm path so a flag cannot steal a wall alert.
    const rectN = $("chart").getBoundingClientRect();
    const hitN = objectAt(e.clientX - rectN.left, e.clientY - rectN.top);
    if (hitN && hitN.kind === "news") return;
    // Not planning a trade: a click on a liquidity wall arms an alert there,
    // so the level you can see is the level you can act on.
    const w = wallAtEvent(e);
    if (w && w.stale) { showToast("liquidity feed stale — not arming"); return; }
    if (w) {
      const ok = armAlert(state.sel, w.px,
        `${w.side === "b" ? "bid" : "ask"} wall $${fmtBig(w.ntl)}`);
      showToast(ok ? `alert armed at wall ${fmtPx(w.px)} ($${fmtBig(w.ntl)})`
                   : "could not arm alert");
    }
    return;
  }
  const px = yToPrice(e.clientY);
  if (px == null || !isFinite(px)) { showToast("click inside the price pane"); return; }
  if (ru.entry == null) {
    ru.entry = px; ru.coin = state.sel;
    saveRuler();
    showToast("entry set — now click the stop");
  }
  else if (ru.stop == null) {
    // A zero-height drag has no risk and no R:R — reject rather than render NaN.
    if (Math.abs(px - ru.entry) < ru.entry * 1e-5) {
      showToast("stop must differ from entry"); return;
    }
    ru.stop = px;
    // A SEED, not the answer. The target handle (RDRAG) moves it, so the
    // "R:R" printed on the target label is a measured ratio — this line used
    // to guarantee it read exactly 2.00 for the life of the plan while being
    // dressed up as a computed quantity.
    ru.target = ru.entry + (ru.entry - ru.stop) * 2;
    ru.armed = false;
    $("chart").classList.remove("ruler");
    saveRuler();
    /* THE SEEDED TARGET CAN LAND OFF THE PANE, WHERE IT CANNOT BE DRAGGED.

       entry + 2R is often above the drawn range: measured on BTC with entry
       64,483.81 and stop 63,917.51 the seed was 65,616.41, whose priceToY is
       -30.0 — thirty pixels above the top of the canvas. rulerTargetHit reads
       the TRUE y (correctly), so the handle is not grabbable, the printed R:R
       stays exactly 2.00 for the life of the plan, and this toast instructed
       an action that could not be performed. The LEVEL is drawn honestly
       ("▲ TARGET 65,616 above view", clamped at the border) — it is the
       instruction that was wrong, so the instruction is what changes. */
    const ty = priceToY(ru.target);
    const scH = state.scale ? state.scale.H : null;
    const offPane = ty == null || scH == null || ty < 0 || ty > scH;
    showToast(offPane
      ? "seeded target " + fmtPx(ru.target) + " is OUTSIDE the view — press − " +
        "or scroll to zoom out before you can drag it · ENTER arms alerts · R clears"
      : "drag TARGET to set R:R · ENTER to arm alerts · R to clear");
  }
  drawChart();
}

function rulerArmAlerts() {
  const ru = state.ruler;
  if (ru.entry == null || !ru.coin) return;
  let n = 0;
  if (armAlert(ru.coin, ru.entry, "ruler entry")) n++;
  if (ru.stop != null && armAlert(ru.coin, ru.stop, "ruler stop")) n++;
  if (ru.target != null && armAlert(ru.coin, ru.target, "ruler target")) n++;
  // The prices the standing alerts actually sit at. Dragging the target
  // afterwards moves the LINE and nothing else, and rulerDragEnd reads this
  // to say so instead of letting the new line speak for the old alert.
  ru.armedAt = { entry: ru.entry, stop: ru.stop, target: ru.target };
  saveRuler();
  showToast(n + " alert" + (n === 1 ? "" : "s") + " armed");
}

let toastTimer = null;
function showToast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = "none"; }, 2600);
}

$("chart").addEventListener("click", (e) => {
  if (PAN.moved || RDRAG.moved) return;   // that was a pan / target drag
  rulerClick(e);
});

/* ── chart zoom + pan ────────────────────────────────────────────────────
   Scroll to zoom (anchored on the cursor so the candle under it stays
   put), drag to pan, "0" or double-click resets to the newest bars.
   The viewport is a window over candles already fetched — no refetch. */

/* THE WINDOW IS state.view.count, NOT THE WINDOW THE LAST FRAME DREW.

   Every handler below needs "how many bars are in the view". Three of them
   used to read it off `state.scale` — the geometry the LAST DRAW published —
   while writing their answer into the LIVE `state.view`. A wheel emits
   ~90-120 events/s against a 60fps draw, so several handlers routinely run
   between two frames and every one of them after the first read a base that
   was already superseded. That is the shipping condition, not an edge case.

   MEASURED live on BTC, 1h, default 140-bar view, cursor mid-plot:
     * two 0.8 zooms with NO draw between them gave {count:112, offEnd:28};
       one frame apart the same two give {90, 25}. The second zoom was LOST
       (112 -> 112) and its cursor-anchoring correction was applied anyway,
       so the chart panned 14 bars for a zoom that never happened.
     * six 0.95 events inside one frame gave count 133 where the same six
       give 103, plus 18 bars of pan under a 7-bar zoom.
   chartPanBars never had the bug because it bases on live state — this is
   that, applied to the other three sites so they cannot drift apart again.

   `state.scale` stays the FALLBACK, never the source: view.count is null
   until something sets it, and the first zoom of a session has to size
   itself against whatever the last frame actually drew. It is still the
   WINDOW (`slots`), never the drawn count (`n`) — they diverge the moment
   offEnd goes negative and reading `n` is a separate bug fixed above.
   The clamp mirrors drawChart's own vCount so the base is exactly the
   window the next frame will use, even after the series changed length
   under a stale view.count (interval switch onto a short listing). */
function viewWindow() {
  const all = state.candles, sc = state.scale;
  if (state.view.count)
    return Math.max(20, Math.min(all.length || state.view.count, state.view.count));
  return (sc && (sc.slots || sc.n)) || Math.min(all.length || 140, 140);
}

function chartZoom(factor, anchorFrac) {
  const all = state.candles;
  if (!all.length) return;
  /* The base every zoom multiplies is the WINDOW (`slots`), not the number
     of candles actually DRAWN (`n`). They diverge the moment offEnd goes
     negative, and reading `n` there made zoom-out eat itself. Measured on
     the pre-fix build from the default view, no prior panning: one ordinary
     two-finger flick (30 x deltaY:+4) ran 141,141,140,138,135,131,126,120,
     113,105,96,86,75,63,50,37,28,21 and hit the 20-bar FLOOR, because each
     zoom-OUT event pushed offEnd one more negative so `n` fell by 1 while
     the 1.008 factor added less than 1 -- from event 3 on, every zoom-OUT
     event SHRANK the window. The same total delivered as one deltaY:+120
     correctly gave 140 -> 178. From the forward limit zoom-out was
     arithmetically impossible (the factor had to exceed slots/n = 1.386
     merely to hold still; a Chrome detent supplies 1.221 and the per-event
     clamp caps at 1.6), so ten zoom-OUT detents took 140 -> 39.

     And it is the LIVE window, not the last drawn one — see viewWindow()
     above for the wheel-coalescing measurements that forced that. */
  const cur = viewWindow();
  let next = Math.max(20, Math.min(all.length, Math.round(cur * factor)));
  // A fine-grained factor (trackpad, or any zoom at a small bar count) can
  // round to the count we already have, which used to return silently — so
  // gentle scrolling did nothing at all and only a hard flick moved the view.
  // Any non-unit factor must move the window by at least one bar.
  if (next === cur && factor !== 1) {
    next = factor < 1 ? cur - 1 : cur + 1;
    next = Math.max(20, Math.min(all.length, next));
  }
  if (next === cur) return;
  /* Keep the bar under the cursor at the same screen position: the bars to
     the RIGHT of the anchor scale by the same factor as the whole window.

     offEnd counts bars hidden to the RIGHT of the window, and the anchor bar
     does not move in the series, so bars-right-of-anchor + offEnd is an
     invariant across the zoom. Solving it gives
         offEnd' = offEnd + (rightOfAnchor - nextRight)
     — the term was the other way round, which anchored the cursor to the
     mirror image of where it actually was. Measured on the live chart: with
     the pointer at mid-plot, zooming 140 -> 70 bars moved the bar under the
     cursor from index 230 to 265, so the chart lunged 35 bars in the wrong
     direction on every wheel click and the candle you were pointing at was
     the one thing guaranteed to leave the screen. With the sign right it is
     230 -> 230, and zoom-in-then-out returns to the exact starting view. */
  const rightOfAnchor = Math.round(cur * (1 - (anchorFrac == null ? 1 : anchorFrac)));
  const nextRight = Math.round(rightOfAnchor * (next / cur));
  let off = state.view.offEnd + (rightOfAnchor - nextRight);
  // Belt and braces: widening the window can only ever reveal MORE history,
  // never hide bars that were already visible. With the sign above corrected
  // this is a no-op for every anchor position, but it is the invariant that
  // the earlier drift (zoom out silently scrolling away from now, and never
  // coming back) violated, so it stays as a guard rather than a comment.
  if (next > cur && state.view.offEnd > 0) off = Math.min(off, state.view.offEnd);
  state.view.count = next;
  state.view.offEnd = clampOffEnd(off, next);
  scheduleDraw();
}

/* Pan by a bar delta, clamped to the series. Shared by drag, trackpad
   horizontal scroll and the keyboard. */
function chartPanBars(bars) {
  // Window, not drawn count -- same divergence as chartZoom. And the clamp
  // is the shared one: floored at 0 here, this branch could not reach the
  // forward room the draw and the drag both allow, which is why trackpad
  // forward-pan did nothing at all. This site was always based on the LIVE
  // offEnd, which is why the wheel-coalescing bug never reached it; it takes
  // its window from viewWindow() now so a zoom earlier in the SAME frame
  // cannot leave it clamping against the previous window either.
  const next = clampOffEnd(state.view.offEnd + bars, viewWindow());
  if (next === state.view.offEnd) return;
  state.view.offEnd = next;
  scheduleDraw();
}

function chartResetView() {
  state.view = { count: null, offEnd: 0 };
  drawChart();
  showToast("view reset — newest bars");
}

/* Wheel: zoom on vertical scroll, pan on horizontal scroll.

   The old handler read only the SIGN of deltaY and applied a flat 1.25x /
   0.8x per event. A mouse wheel emits one event per detent, so that felt
   right; a trackpad emits a continuous stream of small deltas, so a single
   two-finger flick delivered 20-40 events and multiplied the zoom by 1.25
   each time — from 140 bars to the 20-bar floor and back in one gesture.
   That is the "scrolling is weird" report. Now the factor is exponential in
   the ACTUAL delta, normalised across deltaMode (Firefox reports lines, not
   pixels) and clamped per event, so a wheel detent still moves ~1.22x while
   a trackpad glide is smooth. Horizontal intent pans instead of zooming,
   because on a trackpad that is the natural way to scroll a chart sideways. */
/* ── the wheel axis is latched for the GESTURE, not decided per event ────
   The axis used to be a bare `Math.abs(dx) > Math.abs(dy)` evaluated on
   every event, with no dead zone and no memory. Real trackpad gestures ramp
   in and ramp out through near-diagonal events, so intent that is obvious to
   the hand is ambiguous to any single event. MEASURED on the pre-fix build,
   1h/300 candles, default 140-bar view: a realistic 11-event macOS sideways
   swipe (deltaX ramping 4,18,52,96,120,120,96,52,18,6,2 with the small
   vertical bleed a real hand produces) PANNED on 8 events and ZOOMED on 3 —
   the ramp-in and the ramp-out — leaving the window at 137 bars after a
   purely horizontal gesture.

   So the axis is claimed once per gesture and held: 1.5x hysteresis to claim
   it, 150 ms of idle to release it, and NOTHING happens while an event is
   ambiguous. Dropping an ambiguous event is benign — the next event of the
   same gesture acts, and 150 ms later the next gesture starts clean. Acting
   on one is not benign: it zooms a chart the user was scrolling. */
const WHEEL_IDLE_MS = 150, WHEEL_HYST = 1.5;
const WHEEL = { axis: null, last: 0 };
$("chart").addEventListener("wheel", (e) => {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dy = e.deltaY * unit, dx = e.deltaX * unit;
  const now = Date.now();
  if (now - WHEEL.last > WHEEL_IDLE_MS) WHEEL.axis = null;   // gesture ended
  WHEEL.last = now;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  /* Shift+wheel pans, as every other charting package does. Chrome and
     Safari already deliver shift+wheel in deltaX; Firefox leaves it in
     deltaY, so the pan magnitude falls back to dy. The axis is latched to x
     either way, so releasing shift part-way through a glide cannot turn the
     rest of that gesture into a zoom. */
  if (e.shiftKey) WHEEL.axis = "x";
  else if (!WHEEL.axis) {
    if (ax > ay * WHEEL_HYST) WHEEL.axis = "x";
    else if (ay > ax * WHEEL_HYST) WHEEL.axis = "y";
    else return;                    // ambiguous (includes 0,0) — wait
  } else if (ax > ay * WHEEL_HYST) {
    WHEEL.axis = "x";               // decisive re-claim, see below
  } else if (ay > ax * WHEEL_HYST) {
    WHEEL.axis = "y";
  }
  /* Re-claim, not just idle-release. Holding the axis until 150 ms of SILENCE
     swallowed whole gestures: measured, after 6 x deltaX:-120 latched x, ten
     immediately-following deltaY:+100 events did NOTHING at all (offEnd frozen
     at -39, count null) because the x branch returns early on dx=0. A trader
     swiping sideways and then zooming has to wait out a timer he cannot see.
     The re-claim uses the SAME 1.5x hysteresis as the initial claim, so it
     cannot undo what the latch was built for: the ramp-in/ramp-out events that
     flip a horizontal swipe into a zoom are NEAR-DIAGONAL and never clear 1.5x
     on the off-axis. Only a decisive gesture on the other axis takes over. */
  if (WHEEL.axis === "x") {
    const pan = e.shiftKey ? (dx || dy) : dx;
    // Latched to x but this event carries no horizontal component: hold the
    // view still rather than let the `|| (pan > 0 ? 1 : -1)` floor below
    // manufacture a one-bar step out of a zero delta.
    if (!pan) return;
    const sc = state.scale;
    // Same pitch the drag handler uses. Dividing by the drawn count here
    // instead of the window made the identical finger distance move the
    // chart 38.6% further by trackpad than by drag at the forward limit
    // (measured: plotW 450.8 over n 101 = 4.463 px/bar vs slots 140 =
    // 3.220 px/bar).
    // plotW can only come from the drawn frame; the bar COUNT it is divided
    // by comes from the live window, for the reason in viewWindow().
    const slot = sc ? Math.max(1, sc.plotW / viewWindow()) : 6;
    // Left-swipe (pan > 0) walks back in time, matching drag-left.
    chartPanBars(Math.round(pan / slot) || (pan > 0 ? 1 : -1));
    return;
  }
  if (!dy) return;
  const sc = state.scale;
  const rect = e.currentTarget.getBoundingClientRect();
  let frac = null;
  if (sc) {
    const xRel = e.clientX - rect.left;
    frac = Math.max(0, Math.min(1, (xRel - sc.plotL) / Math.max(1, sc.plotW)));
  }
  const factor = Math.min(1.6, Math.max(0.625, Math.exp(dy * 0.002)));
  chartZoom(factor, frac);
}, { passive: false });

const PAN = { active: false, moved: false, startX: 0, startY: 0, startOff: 0 };
$("chart").addEventListener("mousedown", (e) => {
  if (state.ruler.armed || e.button !== 0) return;
  // The target handle outranks the pan inside its own 12px band. That band
  // exists only while a ruler target is drawn on THIS coin, and the
  // ns-resize cursor announces it before the button goes down.
  if (rulerTargetHit(e)) {
    RDRAG.active = true; RDRAG.moved = false; RDRAG.startY = e.clientY;
    e.preventDefault();
    return;
  }
  PAN.active = true; PAN.moved = false;
  PAN.startX = e.clientX; PAN.startY = e.clientY;
  PAN.startOff = state.view.offEnd;
});
window.addEventListener("mousemove", (e) => {
  /* The button can be released where no mouseup ever reaches us — outside
     the browser window, or swallowed by a native drag. MEASURED on the
     pre-fix build: after a mousedown, two further moves carrying buttons:0
     kept panning, taking offEnd to -39; the chart followed a bare cursor
     with nothing held down. `buttons` is a bitmask of what is CURRENTLY
     down, so bit 0 clear means the pan is over whether or not we saw it
     end. Close it through the same path a real mouseup takes. */
  if ((PAN.active || RDRAG.active) && !(e.buttons & 1)) { endChartDrag(); return; }
  if (RDRAG.active) { rulerDragTo(e); return; }
  if (!PAN.active) return;
  const sc = state.scale;
  if (!sc) return;
  const dx = e.clientX - PAN.startX;
  const dy = e.clientY - PAN.startY;
  /* RADIAL dead zone, not a horizontal one. The old test was
     `Math.abs(dx) > 4`, so a drag straight down the pane never set `moved`
     and fell through to the click handler as a click — MEASURED: dx=0,
     dy=140 armed an alert on the wall under the release point. Same 4px
     radius, now measured in both axes. */
  if (dx * dx + dy * dy > 16) PAN.moved = true;
  if (!PAN.moved) return;
  $("chart").style.cursor = "grabbing";
  // Bar delta is measured from the drag ORIGIN against the origin's offset,
  // so a pan that hits the end of history and comes back lands exactly where
  // it started rather than accumulating rounding on the way.
  const bars = Math.round(dx / Math.max(1, sc.plotW / viewWindow()));
  // Negative offEnd = scrolled past the newest bar. Shared clamp, so the
  // drag stops exactly where the view stops rather than fighting a bound
  // the user cannot see -- and its back bound now uses the window like the
  // draw does, instead of the drawn count (viewWindow: the LIVE window, so a
  // wheel-zoom mid-drag cannot leave the drag on the previous one).
  const next = clampOffEnd(PAN.startOff + bars, viewWindow());
  if (next !== state.view.offEnd) { state.view.offEnd = next; scheduleDraw(); }
});
/* ONE exit for a chart drag, whatever ends it: a real mouseup, a button
   released off-window (detected on the next move), focus leaving the page,
   or the OS cancelling the pointer stream. This is the body the mouseup
   handler always had; it is a named function now only so the other three
   endings cannot drift away from it. */
function endChartDrag() {
  if (RDRAG.active) { rulerDragEnd(); return; }
  // A drag must not fall through as a click (wall alert / ruler). The click
  // event fires after mouseup, so clear the flag a tick later.
  if (PAN.active && PAN.moved) {
    $("chart").style.cursor = "";
    setTimeout(() => { PAN.moved = false; }, 0);
  }
  PAN.active = false;
}
window.addEventListener("mouseup", endChartDrag);
// Interrupted, not finished: leaving PAN.active/RDRAG.active set here is how
// the chart ends up following a cursor with no button held.
window.addEventListener("blur", endChartDrag);
window.addEventListener("pointercancel", endChartDrag);
$("chart").addEventListener("dblclick", (e) => { e.preventDefault(); chartResetView(); });

/* RIGHT-CLICK = PIN toggle. Verified unclaimed before taking it: `grep -c
   contextmenu` over this file was 0, so nothing on the chart, the panes or
   the document reads the event. preventDefault suppresses the OS menu on
   the canvas only — every other element keeps its native context menu.

   Right-click on empty canvas deliberately does NOT clear the pins: a
   destructive action on a miss is how a stack of deliberate disclosures
   disappears by accident. `x` clears them, Escape pops the newest. */
$("chart").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const rect = $("chart").getBoundingClientRect();
  const o = objectAt(e.clientX - rect.left, e.clientY - rect.top);
  if (!o) {
    showToast("nothing to pin here — right-click a whale tick, order or event");
    return;
  }
  peekClear();                  // the pin supersedes the peek of the same mark
  pinToggle(o);
});

/* crosshair mouse tracking

   The pointer position is recorded here; the BAR INDEX under it is derived
   inside drawChart from that frame's own geometry (see PTR). Storing the
   index here instead meant it was computed against the geometry of the
   previous frame and then reused as an index into the next one — so after a
   wheel-zoom (pointer stationary, window resized) the crosshair, the OHLC
   readout and the footprint ladder all described a bar that was no longer
   under the cursor, until the user happened to move the mouse. */
$("chart").addEventListener("mousemove", (e) => {
  const rect = $("chart").getBoundingClientRect();
  PTR.x = e.clientX - rect.left;
  // y is new: the crosshair only ever needed a column, but an OBJECT under
  // the pointer needs both axes (see objectAt).
  PTR.y = e.clientY - rect.top;
  PTR.inside = true;
  peekHover();
  if (PAN.active && PAN.moved) return;   // panning owns the cursor and the draw
  if (RDRAG.active) return;              // the target drag owns both
  if (!state.ruler.armed) {
    // The target handle is invisible until the cursor is on it, so it has to
    // be the first thing tested — a wall sitting under the target line would
    // otherwise claim the cursor and hide the only affordance there is.
    if (rulerTargetHit(e)) {
      $("chart").style.cursor = "ns-resize";
      $("chart").title = "drag to move the target — R:R follows";
    } else {
      const w = wallAtEvent(e);
      $("chart").style.cursor = w ? "pointer" : "";
      $("chart").title = w
        ? `click to alert at ${fmtPx(w.px)} — $${fmtBig(w.ntl)} resting` : "";
    }
  }
  // Only repaint when the hovered bar actually CHANGES. A mousemove stream is
  // ~100/s and a bar is many pixels wide, so most events land on the bar that
  // is already highlighted and used to trigger a full redraw anyway.
  if (hoverIndex() !== state.hover) scheduleDraw();
});
$("chart").addEventListener("mouseleave", () => {
  PTR.inside = false;
  PTR.y = null;
  peekClear();
  $("chart").style.cursor = "";
  if (state.hover != null) scheduleDraw();
});

async function loadFlowHist() {
  const coin = state.sel, iv = state.interval;
  try {
    // Ask for buckets at the chart's own resolution so CVD turns land on bars.
    const bucket = Math.max(60, Math.round((state.candles.length > 1
      ? (state.candles[1].t - state.candles[0].t) : 300000) / 1000));
    // The collector keeps minute buckets for 48h and hourly for 90 days, so an
    // hourly-or-coarser chart can now ask far beyond 48h. Sub-hourly charts
    // stay capped — there is no minute-resolution tape older than that, and
    // asking for it would just draw an empty left half.
    const capH = bucket >= 3600 ? 24 * 400 : 48;
    const hours = Math.min(capH, Math.max(2, bucket * (state.candles.length || 120) / 3600));
    /* THE PER-PRICE LADDER IS OPT-IN AND COSTS BYTES, so it is asked for only
       when the layer that draws it is on. /api/flow ships no level key at all
       without this, which is why the whole block below tolerates their
       absence rather than treating it as an empty measurement.

       Payload, measured server-side at top-12: 6,053 B without levels ->
       14,611 B with, for 24 bars. A 1m chart asks for ~300 bars, so ~100 kB
       per refresh over loopback, and only while FP is on. */
    const wantLv = !!state.inds.fp;
    const r = await fetch(`/api/flow?coin=${encodeURIComponent(coin)}` +
                          `&bucket=${bucket}&hours=${hours.toFixed(1)}` +
                          (wantLv ? "&levels=1" : ""));
    const d = await r.json();
    if (state.sel !== coin || state.interval !== iv) return;   // user moved on
    /* The SUBSCRIPTION flag is carried, not just the series.

       Audited 2026-08-16: an empty series was rendered "CVD · collecting
       tape…" for five of this watchlist's own symbols (xyz:AAPL, MSFT, AMZN,
       META, AMD) while BOTH SIDES, on the same screen at the same instant,
       correctly said they are not in the collector at all. The collector is
       at 60/60 slots and its set is ADD-ONLY until the process restarts, so
       "collecting" was a progress message for a process that is not running.
       /api/flow carries `subscribed` and `why`; dropping them here is what
       forced the CVD pane to guess. */
    /* `subscribed` and `why` are the two fields that stop the CVD pane
       guessing, and a 200 + {error} envelope carries NEITHER — so the pane's
       final else-branch fired and said "subscribed, but no tape recorded for
       this window yet", which asserts BOTH that the market is in the
       collector and that the collector saw no trades. Two measurements, over
       a route that answered with a fault. The last good tape is kept (it was
       real when it was read) and the failure is carried in `err`, which the
       pane now reads before it reaches any of the three claims. */
    if (d && d.error) {
      const keepFh = (state.flowHist && state.flowHist.coin === coin)
        ? state.flowHist : null;
      state.flowHist = { coin, bucket_s: keepFh ? keepFh.bucket_s : null,
                         series: keepFh ? keepFh.series : [],
                         subscribed: keepFh ? keepFh.subscribed : null,
                         why: keepFh ? keepFh.why : "",
                         // Health is NOT carried forward across a fault: the
                         // last good "socket is alive" would go on reassuring
                         // the reader through an outage. Unknown, and said so.
                         status: null, heldAt: keepFh ? keepFh.heldAt : null,
                         // The stored ladder travels with the series it was
                         // cut from — same reason, same rule: it was a real
                         // measurement when it was read. Carried as ONE unit
                         // so the ladder can never outlive the bucket width
                         // it was aggregated at.
                         lv: keepFh ? keepFh.lv : null,
                         lvAsked: keepFh ? keepFh.lvAsked : false,
                         err: String(d.error) };
      syncIndButtons();          // the badge says ERR, not a stale hour count
      drawChart();
      return;
    }
    /* THE COLLECTOR-HEALTH BLOCK TRAVELS NOW. /api/flow has always shipped
       `status` — state, wedged, wedge_note, ws_stale, last_msg_age_s,
       stale_after_s, subs_live/quiet — on the coin-scoped route as well as
       the bare one, and every one of those keys was 0-reference in this file.
       Dropped here, a wedged websocket reaches the CVD pane as a line that
       simply stops advancing under a caption that still says "server tape ·
       N samples": a missing value rendering as a confident fact, in exactly
       the direction the house rule forbids. This file's own comment records
       that a wedged collector already cost this desk 24 minutes.

       `heldAt` is stamped because last_msg_age_s ages in the reader's hand
       exactly like every other shipped age on this terminal. */
    /* THE LEVEL TIER TRAVELS AS ONE OBJECT, never as loose sibling keys.

       `levels` is meaningless without the bucket width it was aggregated at
       and the resolution it was stored at, and those three drifting apart is
       exactly how a ladder gets drawn at a width the delta beside it does not
       share. `lv` is null when the response carried no level keys at all —
       which is NOT an empty ladder: it is a request that did not ask for one
       (FP off at fetch time), or a server that predates the tier. histLevels()
       distinguishes those from a measured empty. */
    const lv = (d.levels !== undefined) ? {
      rows: d.levels || [],
      top_n: d.levels_top_n || 0,
      bucket_s: d.levels_bucket_s,          // CLAMPED, same as bucket_s above
      resolution_s: d.levels_resolution_s,  // stored granularity (server 60s)
      retain_h: d.levels_retain_h,
      from_ms: d.lvl_from_ms, to_ms: d.lvl_to_ms,
      since_ms: d.levels_since_ms,          // oldest minute the TIER holds
      began_ms: d.levels_began_ms,          // when THIS process started
      why: d.levels_why || "",
      at: Date.now()
    } : null;
    state.flowHist = { coin, bucket_s: d.bucket_s, series: d.series || [],
                       subscribed: d.subscribed, why: d.why || "", err: null,
                       lv, lvAsked: wantLv,
                       status: d.status || null, heldAt: Date.now() };
    // The CVD button's coverage badge is read from exactly this object, so
    // it is refreshed where the object changes and nowhere else.
    syncIndButtons();
    drawChart();
  } catch (e) { /* keep last */ }
}

async function loadCandles() {
  const coin = state.sel, iv = state.interval;
  try {
    const r = await fetch(`/api/candles?coin=${encodeURIComponent(state.sel)}&interval=${state.interval}`);
    const d = await r.json();
    // Late response for a symbol/interval the user already left would paint
    // another coin's prices (and scale) onto this chart.
    if (d.coin && d.coin !== state.sel) return;
    if (d.interval && d.interval !== state.interval) return;
    /* A FAILED fetch is not an empty market, and this used to render as one.

       Audited 2026-08-16: `state.candles = d.candles || []` read no error
       field at all, so an upstream fault silently emptied the series and
       landed on the identical "loading candles…" screen as a market that
       genuinely has no history. Same rule loadSrDaily already follows — a
       price that traded is still a price that traded, so the series we have
       is KEPT — but the failure is recorded instead of being swallowed, and
       the chart says so above the bars it is still showing. */
    if (d.error) {
      state.candlesNote = { coin, interval: iv, kind: "error", at: Date.now(),
        text: String(d.error) +
              (d.error_detail ? " (" + d.error_detail + ")" : "") };
      drawChart();
      return;
    }
    /* Keep a panned view pinned to the BARS it is looking at, not to a
       distance from the end of the array.

       state.view.offEnd counts back from the newest bar, so every refresh
       that appends a candle slides the window one bar forward. Pinned to the
       right edge (offEnd 0) that is exactly right — the chart should follow
       the market. Panned into history it is not: the candles you were
       studying crept off the right edge once a minute, on a 60s timer, with
       no input from the user. Re-derive the offset from the timestamp that
       was last on the right edge instead. */
    const prev = state.candles;
    const anchorT = state.view.offEnd > 0 && prev.length
      ? prev[Math.max(0, prev.length - 1 - state.view.offEnd)].t : null;
    state.candles = d.candles || [];
    /* The server distinguishes "served and EMPTY" from "still in flight"; so
       does this. `empty_note` is the venue's own completed measurement of no
       history and is preferred over anything invented here. */
    state.candlesNote = state.candles.length ? null : {
      coin, interval: iv, kind: "empty", at: Date.now(),
      text: d.empty_note ||
        (coin + " " + iv + ": the venue served this market's candle history " +
         "and it was EMPTY — 0 bars. A completed measurement of no history, " +
         "not a fetch still in flight."),
    };
    if (anchorT != null && state.candles.length) {
      let idx = -1;
      for (let i = state.candles.length - 1; i >= 0; i--) {
        if (+state.candles[i].t === +anchorT) { idx = i; break; }
      }
      // Anchor bar aged out of the series entirely: hold the oldest window
      // we can rather than teleporting the user back to now.
      state.view.offEnd = idx >= 0
        ? state.candles.length - 1 - idx
        : Math.min(state.view.offEnd, Math.max(0, state.candles.length - 1));
    }
    drawChart();
    renderNewsCtx();
    loadDes();
    if (state.inds.cvd || state.inds.fp) loadFlowHist();
    // The gutter's history strip is the CHART's window, so it refreshes with
    // the chart for the same reason CVD does: a new coin, a new interval or a
    // new bar all change what the strip has to cover. Same shape as the line
    // above, and it costs no upstream call — /api/depth is served from the
    // local record. loadDepthHist no-ops when HEAT is off.
    loadDepthHist();
  } catch (e) { /* keep last */ }
}

/* The DAILY series, fetched on its own for the prior-period S/R levels.

   Separate from loadCandles ON PURPOSE. The levels must not depend on the
   interval the chart is showing — that independence is the entire reason
   this method replaced the fractal one — so they are never derived from
   state.candles, not even when the chart happens to BE on 1d. One code
   path, no interval branch, nothing to drift.

   No new endpoint and no paging: /api/candles?interval=1d already returns
   rows[-300:] and the deepest period needed is a quarter. The server caches
   that response for 300s, which is what SR_DAILY_TTL_MS matches.

   Deliberately NOT gated on state.inds.sr. Gating it would add a wake-up
   path for every route that can turn the layer on — the button, the command
   palette, the quiet-toggle restore, a restored layout — and a missed one
   would show the legend's "daily series has not loaded yet" note forever
   instead of levels. One 300s-cached request every five minutes is cheaper
   than that class of bug.

   The document.hidden discipline lives at the CALL sites (the interval below
   and the visibilitychange handler), exactly like pollHeat and loadCandles:
   a hidden tab suspends rAF, so a fetch that lands there paints nothing. */
const SR_DAILY_TTL_MS = 300000;
let srDailyBusy = null;              // coin whose daily fetch is in flight

async function loadSrDaily(force) {
  const coin = state.sel;
  const sd = state.srDaily;
  const fresh = sd && sd.coin === coin && sd.candles && !sd.err &&
                Date.now() - sd.at < SR_DAILY_TTL_MS;
  if (!force && fresh) return;
  if (srDailyBusy === coin) return;
  srDailyBusy = coin;
  try {
    const r = await fetch(`/api/candles?coin=${encodeURIComponent(coin)}` +
                          `&interval=1d`);
    const d = await r.json();
    // A late response for a symbol the reader has left would put another
    // instrument's prices on this chart under this chart's name.
    if (state.sel !== coin || (d.coin && d.coin !== coin)) return;
    /* "the daily series came back empty" three lines down is a MEASUREMENT of
       the series, and a 200 + {error} envelope carries no `candles` — so it
       was being written for a request that FAILED, and the legend then told
       the reader this market has no daily history. The catch below is already
       written to keep the last good series and record the real reason; this
       is how a 200-shaped failure reaches it instead of bypassing it. */
    if (d && d.error) throw new Error(d.error);
    const cs = d.candles || [];
    state.srDaily = { coin, candles: cs, at: Date.now(), calc: null,
                      err: cs.length ? null
                                     : "the daily series came back empty" };
  } catch (e) {
    if (state.sel !== coin) return;
    /* Keep the last good series if there is one — a price that traded is
       still a price that traded — but RECORD the error, because the legend
       has to be able to say the set may be behind. Silently serving the old
       series as if the refresh had succeeded is the failure this codebase
       keeps fixing. */
    const keep = sd && sd.coin === coin && sd.candles ? sd.candles : null;
    state.srDaily = { coin, candles: keep, at: Date.now(), calc: null,
                      err: String((e && e.message) || e) || "fetch failed" };
  } finally {
    if (srDailyBusy === coin) srDailyBusy = null;
  }
  drawChart();
}

function selectCoin(coin) {
  const prev = state.sel;
  state.sel = coin;
  $("chart-title").textContent = coin.includes(":") ? coin : coin + "-PERP";
  state.candles = []; state.trades = []; state.book = null;
  // The previous symbol's verdict is not this one's. Left standing, an
  // "EMPTY history" note from CHILLGUY would sit under BTC's name for the
  // ~200ms until the new fetch lands — a completed measurement of the wrong
  // instrument, which is the failure the srDaily/sidesError drops below were
  // written to stop.
  state.candlesNote = null;
  // Not "no prints on the new coin" — "not listening to it yet". Carrying the
  // previous coin's print stamp forward would let the flow block reason about
  // a tape it never heard.
  state.tradeSeenMs = 0; state.tradeSeenCoin = null;
  state.scale = null;
  if (state.heat.coin !== coin) state.heat = { coin: null, sig: null, snaps: [], live: null, at: 0, bucketW: 0, err: null };
  if (state.flow.coin !== coin) state.flow = { coin: null, cvd: 0, since: 0, points: [], recent: [], tape: [] };
  if (!state.flowHist || state.flowHist.coin !== coin) state.flowHist = null;
  /* Prior-period S/R is a per-INSTRUMENT fact: a level is a price, and a
     price belongs to one symbol. Drop the previous symbol's daily series
     rather than let it draw one more frame under the new name — the same
     discipline state.rulerPending already enforces for the owner's plan. */
  if (!state.srDaily || state.srDaily.coin !== coin) state.srDaily = null;
  loadSrDaily();
  if (state.ruler.coin && state.ruler.coin !== coin) clearRuler();
  // A plan restored from storage for a coin we were not charting comes back
  // the moment that coin IS charted — the only place its levels mean
  // anything. clearRuler above has already retired whatever was on screen.
  if (state.rulerPending && state.rulerPending.coin === coin) {
    const p = state.rulerPending;
    state.rulerPending = null;
    applyRuler(p);
  }
  if (!state.whaleCoin || state.whaleCoin.coin !== coin) state.whaleCoin = null;
  loadWhaleCoin();
  if (!state.sides || state.sides.coin !== coin) { state.sides = null; state.sidesAt = 0; }
  if (!state.sidesBook || state.sidesBook.coin !== coin) state.sidesBook = null;
  // A failure that happened on the PREVIOUS symbol is not this symbol's load
  // state. Left uncleared, switching after a failure showed the old error as
  // the new coin's status while its own fetch was still in flight.
  if (coin !== prev) { state.sidesError = null; state.sidesBookErr = null; }
  renderSides(); loadSides(); loadSidesBook();
  renderTrades(); renderBook();
  drawChart();
  loadCandles();
  renderWatch();
  resubTrades(prev, coin);
  if (!state.newsChart || state.newsChart.coin !== coin) state.newsChart = null;
  loadChartNews();
  renderNewsCtx();
  loadDes();
  if (!state.newsAll && coin !== prev) loadResearch();
}

/* ---------------- order flow / CVD ----------------
   Cumulative Volume Delta from the aggressor tape: buy-initiated notional
   minus sell-initiated. SESSION-scoped — Hyperliquid's REST tape returns only
   the last handful of trades, so there is no honest way to backfill; the pane
   states how long it has been accumulating.
   side "B" = buy aggressor, verified against the live book (B lifted the ask
   45x vs 8 bid-hits; A hit the bid 17x and never lifted). */
const FLOW_WINDOW_MS = 60000;      // rolling buy/sell balance window
const FLOW_MAX_POINTS = 900;
const TAPE_MAX = 6000;             // raw prints retained for footprint/delta

/* Per-bar delta from the server's collected buckets, keyed by candle open.
   `loadFlowHist` asks for buckets at the chart's own resolution and the
   collector groups on epoch boundaries, so a bucket start IS a candle open for
   every standard interval. Bars with no bucket are left undefined — absent
   from the tape is not the same as zero delta, and drawing them as zero would
   invent balance where there is no data. */
function barDelta(cs, stepMs) {
  const fh = state.flowHist;
  if (!fh || fh.coin !== state.sel) return new Map();
  const want = Math.max(60, Math.round((stepMs || 60000) / 1000));
  const out = new Map();
  // Only trust the series if the server bucketed at the chart's resolution;
  // otherwise a 1h chart would take 5m buckets and show a twelfth of the flow.
  if (fh.bucket_s && Math.abs(fh.bucket_s - want) > 1) return out;
  for (const p of fh.series || []) out.set(p.ms, p.delta);
  return out;
}

/* TWO tape clocks, and they are three to four ORDERS OF MAGNITUDE apart.
   This one was called `tapeStartMs`, which named neither.

   `flowHistStartMs` — oldest bucket the SERVER holds for this coin, in ms:
   the point before which no pane can honestly show flow at all. Measured
   2026-08-19 on BTC 1h: 17,975 minutes of reach (299 hourly buckets).

   `tapeRingStartMs` — earliest print still in THIS BROWSER's raw ring, which
   is the only clock the per-price footprint ladder can speak for, because
   /api/flow carries buy/sell notional and no price levels. Measured on BTC
   the same minute: 1.25 minutes of reach on a fresh tab, and a median of 46
   minutes once the ring fills — TAPE_MAX is a COUNT, not a duration.

   Ratio at that instant: 14,329x. Anything that reasoned about ladder
   coverage from the old name was asking the 48h+ collector a question only
   the ~46-minute ring can answer. */
function flowHistStartMs() {
  const fh = state.flowHist;
  if (!fh || fh.coin !== state.sel || !(fh.series || []).length) return null;
  return fh.series[0].ms;
}

function tapeRingStartMs() {
  const fl = state.flow;
  if (!fl || fl.coin !== state.sel || !fl.tape.length) return null;
  /* min, not tape[0].ms: prints are pushed with the exchange's own `time`
     and a batch can land a millisecond out of order, and TAPE_MAX trims
     from the front by ARRIVAL order. The floor has to be the real floor —
     one late print would otherwise declare coverage the ring does not have. */
  let m = Infinity;
  for (const t of fl.tape) if (t.ms < m) m = t.ms;
  return m === Infinity ? null : m;
}

/* Per-candle order flow: buy/sell notional per bar plus the per-price ladder.

   TWO sources, and the whole difficulty is that they overlap. The server's
   /api/flow buckets reach back hours-to-days and are a COMPLETE measurement
   of each bar, but carry no price levels. The browser's raw tape carries the
   levels (that is the footprint) but reaches back only as far as TAPE_MAX
   prints — a COUNT, not a duration: measured on BTC, a median of 46 minutes,
   3 minutes during a burst. So on a 1h chart the tape NEVER covers a whole
   bar and the newest bar is ALWAYS a boundary bar.

   Each bucket is tagged with what was actually measured:
     `fromHist`  buy/sell are the server's complete total for the bar (as
                 opposed to a sum over the prints this tab happened to see).
     `cov`       what the browser ring covers of THIS bar, and therefore what
                 the `levels` ladder is entitled to claim:
                 "full"    ring starts at or before the bar's open
                 "partial" ring starts inside the bar — ladder is a tail only
                 "none"    the bar closed before this tab connected
   Both are READ by the ladder in drawChart. `fromHist` used to be written
   twice and read nowhere. */
/* ---------------- stored per-price levels (the FOURTH provenance) --------

   THE PROBLEM THIS SOLVES, measured on HYPE 2026-08-19 10:42Z with FP on:
   300 minute buckets of real buy/sell present, ONE of them with a ladder,
   because the browser ring held 215 prints (3.4 minutes of reach). Hovering a
   bar 75 minutes old drew "FOOTPRINT Δ -$10.8K / bar closed before this tab
   connected" — honest, and no footprint.

   /api/flow?levels=1 now serves the collector's third tier: per-price buy/sell
   at ONE-MINUTE resolution, kept 48h. It is a DIFFERENT measurement from the
   ring and must never be silently blended with it — see candleFlow's
   precedence block for why the two are never summed into one bar.

   WIRE FORMAT (server _wire_runs): rows of
     {ms, runs:[{m, k, i0, L:[dIdx, buy, sell, ...]}], lc, lm, rn?, rb?, rs?}
   One run per DISTINCT TICK in the bar — 99.81% of minute buckets have one,
   but 3.4% of 1h bars straddle a tick step, so collapsing runs would mis-key
   them. tick = m * 10^k and price = idx * tick, which is the same grid
   tickFor() puts the ring's prints on: the server computes idx against the
   browser's own tick expression and canonicalises (m,k) for the STORAGE key
   only, so the two ladders land on identical rungs rather than 1 ulp apart.

   FOUR REFUSALS, and each one has to be a sentence rather than a blank pane:
     no `lv`          the response carried no level keys — FP was off when it
                      was fetched, or this server predates the tier. NOT an
                      empty measurement.
     bucket mismatch  the ladder was aggregated at a width this chart is not
                      drawing. Refused on the SAME condition barDelta and
                      candleFlow already refuse the series, never separately,
                      so delta and ladder can never disagree about width.
     coarser store    stored resolution > this bar. Inert today (the store is
                      60s and the finest interval is 1m) and deliberately kept:
                      an hourly-resolution ladder under a 5m bar is an
                      aggregate wearing the clothes of a measurement.
     no rows          the tier holds nothing for this coin/window. Which of
                      those it is, is decided per bar in the ladder, from
                      from_ms/to_ms/since_ms — not from prose. */
/* Bucket widths as the chart names them ("60" -> "1m"), so a refusal
   sentence reads in the same units as the interval buttons. */
function lvlWidth(sec) {
  const n = Math.round(sec || 0);
  return n % 86400 === 0 ? (n / 86400) + "d"
       : n % 3600 === 0 ? (n / 3600) + "h"
       : n % 60 === 0 ? (n / 60) + "m" : n + "s";
}

function histLevels(intervalMs) {
  // `why` is a CASCADE, longest first, because the ladder plate is 234px and
  // fitText drops a sentence that does not fit rather than clipping it — a
  // single long refusal would render as no sentence at all, which is the one
  // outcome this pane may not have.
  const none = (why) => ({ bars: new Map(), lv: null, why: why || null });
  const fh = (state.flowHist && state.flowHist.coin === state.sel)
    ? state.flowHist : null;
  if (!fh || !intervalMs) return none(null);
  const lv = fh.lv;
  /* NO `lv` AT ALL IS TWO DIFFERENT FACTS and they must not share a
     sentence. `lvAsked` records whether THIS response asked for levels:
     without it, a server that predates the level tier is indistinguishable
     from a fetch that went out while FP was off, and the pane would tell the
     reader to wait for a refresh that will never carry a ladder. */
  if (!lv) return none(fh.lvAsked
    ? ["this server serves no stored ladder", "no stored ladder served"]
    : ["stored ladder not requested yet", "ladder not requested"]);
  const want = Math.max(60, Math.round(intervalMs / 1000));
  // The SAME guard the series gets, on the SAME comparison. See barDelta.
  if (lv.bucket_s && Math.abs(lv.bucket_s - want) > 1)
    return { bars: new Map(), lv,
             why: [`stored ladder is ${lvlWidth(lv.bucket_s)} buckets, not ${lvlWidth(want)}`,
                   `ladder width ${lvlWidth(lv.bucket_s)} != ${lvlWidth(want)}`,
                   "ladder width mismatch"] };
  // A store coarser than the bar cannot be cut down to it. Degrade, never
  // aggregate-and-imply-precision.
  if (lv.resolution_s && lv.resolution_s > want)
    return { bars: new Map(), lv,
             why: [`stored levels are ${lvlWidth(lv.resolution_s)} buckets, too coarse for ${lvlWidth(want)}`,
                   `stored ladder too coarse (${lvlWidth(lv.resolution_s)} buckets)`,
                   `stored: ${lvlWidth(lv.resolution_s)} buckets`] };
  /* MEMOISED ON THE PAYLOAD OBJECT, because candleFlow runs on every frame
     and this decode is the same size as the rest of it. A 1m chart ships ~300
     bars x up to 12 rungs; decoding 3,600 cells per repaint would roughly
     double candleFlow's cost for a result that only changes when
     loadFlowHist replaces `lv`. Keyed by interval so an interval change
     re-decodes, and hung off `lv` so a new fetch drops the whole cache with
     the object it belongs to. `lmEff` is the one field that ages, and it is
     refreshed below on every call rather than cached. */
  const memo = lv.__dec || (lv.__dec = {});
  if (memo[intervalMs]) {
    const hit = memo[intervalMs];
    lvlAgeIn(hit, intervalMs);
    return { bars: hit, lv, why: null };
  }
  const bars = new Map();
  for (const row of lv.rows || []) {
    if (!row || row.ms == null) continue;
    const b = Math.floor(row.ms / intervalMs) * intervalMs;
    let e = bars.get(b);
    if (!e) { e = { levels: new Map(), lc: 0, lm: 0, rn: 0, rb: 0, rs: 0 }; bars.set(b, e); }
    e.lc += row.lc || 0;
    e.lm = Math.max(e.lm, row.lm || 0);
    e.rn += row.rn || 0; e.rb += row.rb || 0; e.rs += row.rs || 0;
    for (const run of row.runs || []) {
      const tick = run.m * Math.pow(10, run.k);
      if (!(tick > 0) || !isFinite(tick)) continue;   // unreconstructable rung
      const L = run.L || [];
      for (let j = 0; j + 2 < L.length; j += 3) {
        const px = (run.i0 + L[j]) * tick;
        // Two runs can land on the same price when a bar straddles a tick
        // step. Same price is the same rung, so they ADD — overwriting would
        // discard one side of a genuinely split level.
        let cell = e.levels.get(px);
        if (!cell) { cell = { b: 0, s: 0 }; e.levels.set(px, cell); }
        cell.b += L[j + 1]; cell.s += L[j + 2];
      }
    }
  }
  lvlAgeIn(bars, intervalMs);
  memo[intervalMs] = bars;
  return { bars, lv, why: null };
}

/* lm is the minutes a bar SPANS, so on the bar still in flight it counts
   minutes that have not happened yet, and lc < lm would read as a shortfall
   that is really just the clock — a 12-minute-old hourly bar would report
   "12 of 60m recorded" while being completely covered. Bounded by elapsed
   minutes for that one bar, and only DOWNWARD: lmEff can never claim more
   coverage than the server reported. Recomputed on every call, never cached,
   because it is the one field here that ages in the reader's hand. */
function lvlAgeIn(bars, intervalMs) {
  const now = Date.now();
  for (const [b, e] of bars) {
    e.lmEff = (b + intervalMs > now)
      ? Math.max(1, Math.min(e.lm || 1, Math.ceil((now - b) / 60000)))
      : (e.lm || 1);
  }
}

function candleFlow(intervalMs) {
  const out = new Map();
  if (!intervalMs) return out;
  const fh = (state.flowHist && state.flowHist.coin === state.sel)
    ? state.flowHist : null;
  /* The bucket_s guard barDelta has always had, and candleFlow never did.
     Measured: one 4h bucket of $5,000,000 fed to candleFlow(60000) put the
     entire $5,000,000 on a SINGLE 1-minute bar (00:00Z), while barDelta,
     handed the same series, correctly returned nothing. It is transient —
     bounded by one fetch round-trip after an interval change, since
     loadFlowHist re-asks at the chart's own resolution — but it reaches the
     footprint header, and a transient $5M print is still a $5M lie. Refused
     in BOTH directions, exactly as barDelta refuses it, so the two flow
     readouts on one canvas can never disagree about whether the series is
     usable. */
  const want = Math.max(60, Math.round(intervalMs / 1000));
  const hist = (fh && (!fh.bucket_s || Math.abs(fh.bucket_s - want) <= 1))
    ? (fh.series || []) : [];
  for (const p of hist) {
    const b = Math.floor(p.ms / intervalMs) * intervalMs;
    let c = out.get(b);
    if (!c) { c = { buy: 0, sell: 0, levels: new Map(), fromHist: true, cov: "none" }; out.set(b, c); }
    c.buy += p.buy; c.sell += p.sell;
  }
  // The RING's floor, not the server series' (they were 14,329x apart when
  // this was measured) — the ladder is built from ring prints, so ring reach
  // is the only honest statement of its coverage.
  const tape = (state.flow && state.flow.coin === state.sel) ? state.flow.tape : [];
  const ring = tapeRingStartMs();
  const coverOf = (b) => ring == null ? "none"
    : ring <= b ? "full"
    : ring < b + intervalMs ? "partial" : "none";
  for (const [b, c] of out) c.cov = coverOf(b);
  for (const t of tape) {
    const b = Math.floor(t.ms / intervalMs) * intervalMs;
    let c = out.get(b);
    if (!c) { c = { buy: 0, sell: 0, levels: new Map(), fromHist: false, cov: coverOf(b) }; out.set(b, c); }
    /* THE DEDUP, NARROWED TO THE OVERLAP.

       hist and tape describe the same trades on any bar the ring covers, so
       something has to give way or the bar double-counts. It used to be the
       whole bucket: the first tape print landing in a hist bucket zeroed
       buy/sell and rebuilt from the tape alone. On a boundary bar — where the
       ring holds a tail and hist holds all of it — that discards the complete
       measurement and keeps the scrap.

       Run verbatim: hist buy $40,000,000 / sell $10,000,000 plus ONE $1,000
       buy print reported buy $1,000, sell $0, delta +$1,000.

       On real data, sweeping every possible tape-start minute:
         BTC 1h   sign of delta WRONG in 255 of 567 cuts (45.0%), mean volume
                  understated 55.3% (median 61.3%); worst single bar
                  $107,492,656 of error — true +$68.15M rendered as -$39.34M
                  on the 14:00Z bar.
         HYPE 1h  188/567 wrong sign (33.2%), mean understatement 54.5%.
       Worst when the tape BARELY covers the bar; at a 59s offset the median
       error is 0.0%, because with no tape print in the bucket the wipe never
       fired at all.

       So the wipe now fires only where it was ever justified — cov "full",
       where the tape is itself the complete measurement. On a straddled bar
       the hist total STANDS and the tape contributes only `levels`, which
       hist cannot provide. */
    if (c.fromHist && c.cov === "full") { c.buy = 0; c.sell = 0; c.fromHist = false; }
    if (!c.fromHist) { if (t.buy) c.buy += t.ntl; else c.sell += t.ntl; }
    const tick = Math.max(1e-9, tickFor(t.px));
    const lvl = Math.round(t.px / tick) * tick;
    let L = c.levels.get(lvl);
    if (!L) { L = { b: 0, s: 0 }; c.levels.set(lvl, L); }
    if (t.buy) L.b += t.ntl; else L.s += t.ntl;
  }
  /* ---- PRECEDENCE: ring, then store, and NEVER both on one bar ----------

     The two ladders describe the same trades wherever they overlap, so
     summing them would double-count exactly the way the hist/tape delta wipe
     above was written to stop. One source per bar, chosen by which one can
     honestly claim the whole bar:

       cov "full"     the ring watched the bar open to close, so it IS the
                      complete measurement and it is LIVE — fresher than the
                      store, which is a snapshot from the last fetch. Ring
                      wins, including when it saw nothing: "full + no rungs"
                      is the measured-quiet bar, and letting the store
                      overwrite that would turn a measurement into a guess.
       otherwise      the ring holds a tail at best. The store covers the
                      whole bar at minute resolution, so the store wins and
                      the ring's tail is DISCARDED rather than added.
       neither        no ladder, and the pane says which absence it is.

     `lsrc` is what the ladder prints its provenance from. It is the fourth
     state this pane has had to name, next to fromHist and cov. */
  const HL = histLevels(intervalMs);
  for (const [b, c] of out) {
    if (c.cov === "full") { c.lsrc = c.levels.size ? "ring" : null; continue; }
    const sv = HL.bars.get(b);
    if (sv && sv.levels.size) {
      c.levels = sv.levels; c.lsrc = "stored";
      c.lc = sv.lc; c.lm = sv.lm; c.lmEff = sv.lmEff;
      c.rn = sv.rn; c.rb = sv.rb; c.rs = sv.rs;
    } else c.lsrc = c.levels.size ? "ring" : null;
  }
  /* A bar the LEVEL tier has and the b/s tiers do not. Unreachable while the
     server keeps levels a strict subset of its bucket keys, and handled
     anyway because the alternative is a real ladder rendered under "no flow
     recorded for this bar". `noDelta` keeps the Δ line saying "not measured"
     rather than printing a confident $0. */
  for (const [b, sv] of HL.bars) {
    if (out.has(b) || !sv.levels.size) continue;
    out.set(b, { buy: 0, sell: 0, levels: sv.levels, fromHist: false,
                 cov: coverOf(b), noDelta: true, lsrc: "stored",
                 lc: sv.lc, lm: sv.lm, lmEff: sv.lmEff,
                 rn: sv.rn, rb: sv.rb, rs: sv.rs });
  }
  // Carried ON the Map so the ladder can explain an ABSENT stored ladder
  // without re-deriving the refusal. Read-only to every other caller.
  out.lvWhy = HL.why;
  out.lv = HL.lv;
  return out;
}

function tickFor(px) {
  // ~2bp buckets: fine enough to see stacking, coarse enough to aggregate
  const raw = px * 0.0002;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  return Math.max(mag, Math.round(raw / mag) * mag);
}

function recordFlow(t, notional) {
  if (state.flow.coin !== state.sel)
    state.flow = { coin: state.sel, cvd: 0, since: Date.now(), points: [], recent: [], tape: [] };
  const fl = state.flow;
  const buy = t.side === "B";
  fl.cvd += buy ? notional : -notional;
  const ms = +t.time || Date.now();
  fl.recent.push({ ms, buy, ntl: notional });
  // Raw tape: footprint/delta are derived from this on demand, so switching
  // interval re-buckets the same trades instead of losing them.
  fl.tape.push({ ms, px: +t.px, ntl: notional, buy });
  if (fl.tape.length > TAPE_MAX) fl.tape.shift();
  const cutoff = Date.now() - FLOW_WINDOW_MS;
  while (fl.recent.length && fl.recent[0].ms < cutoff) fl.recent.shift();
  const last = fl.points[fl.points.length - 1];
  if (!last || Date.now() - last.ms > 1000) {
    fl.points.push({ ms: Date.now(), cvd: fl.cvd, px: +t.px });
    if (fl.points.length > FLOW_MAX_POINTS) fl.points.shift();
  } else {
    last.cvd = fl.cvd; last.px = +t.px;
  }
}

function flowBalance() {
  let b = 0, s = 0;
  for (const r of state.flow.recent) (r.buy ? (b += r.ntl) : (s += r.ntl));
  const tot = b + s;
  return { buy: b, sell: s, buyPct: tot > 0 ? b / tot * 100 : 50, tot };
}

/* Divergence: price and flow disagreeing is the read that makes CVD worth
   watching — new highs on falling CVD means supply is absorbing the bid. */
function flowDivergence() {
  const pts = state.flow.points;
  if (pts.length < 12) return null;
  const mid = Math.floor(pts.length / 2);
  const dPx = pts[pts.length - 1].px - pts[mid].px;
  const dCvd = pts[pts.length - 1].cvd - pts[mid].cvd;
  const pxRange = Math.max(...pts.map((p) => p.px)) - Math.min(...pts.map((p) => p.px));
  const cvdRange = Math.max(...pts.map((p) => p.cvd)) - Math.min(...pts.map((p) => p.cvd));
  if (pxRange <= 0 || cvdRange <= 0) return null;
  const pxMove = dPx / pxRange, cvdMove = dCvd / cvdRange;
  if (Math.abs(pxMove) < 0.25 || Math.abs(cvdMove) < 0.25) return null;
  if (pxMove > 0 && cvdMove < 0) return { kind: "bearish", note: "price up, flow selling" };
  if (pxMove < 0 && cvdMove > 0) return { kind: "bullish", note: "price down, flow buying" };
  return null;
}

function renderFlowMeta() {
  const el = $("flow-meta");
  if (!el) return;
  const f = flowBalance();
  if (!f.tot) { el.textContent = ""; return; }
  const cls = f.buyPct >= 55 ? "up" : f.buyPct <= 45 ? "dn" : "fl";
  el.innerHTML = `<span class="${cls}">${f.buyPct.toFixed(0)}% BUY</span>` +
    `<span class="fl"> 60s $${fmtBig(f.tot)}</span>`;
}

/* ---------------- time & sales + order book streams ---------------- */
function resubTrades(prevCoin, coin) {
  if (!ws || ws.readyState !== 1) return;
  for (const type of ["trades", "l2Book"]) {
    if (prevCoin && prevCoin !== coin)
      ws.send(JSON.stringify({ method: "unsubscribe",
        subscription: { type, coin: prevCoin } }));
    ws.send(JSON.stringify({ method: "subscribe",
      subscription: { type, coin: coin } }));
  }
}

let bookLastDraw = 0;
function renderBook() {
  const b = state.book;
  if (!b || !b.bids.length || !b.asks.length) {
    $("book-rows").innerHTML = '<div class="bk-row"><span class="bs">awaiting depth…</span></div>';
    $("book-spread").textContent = "";
    const imb0 = $("imb");
    imb0.className = ""; imb0.title = "";
    $("imb-fill").style.width = "50%";
    return;
  }
  const N = 7;                                   // levels per side
  const asks = b.asks.slice(0, N), bids = b.bids.slice(0, N);
  let cum = 0;
  const askCum = asks.map((l) => (cum += l.sz));
  cum = 0;
  const bidCum = bids.map((l) => (cum += l.sz));
  const maxCum = Math.max(askCum[askCum.length - 1] || 0, bidCum[bidCum.length - 1] || 0) || 1;
  const row = (l, c, side) =>
    `<div class="bk-row ${side}"><span class="depth" style="width:${(c / maxCum * 100).toFixed(1)}%"></span>` +
    `<span class="bp">${fmtPx(l.px)}</span><span class="bs">${fmtBig(l.sz * l.px)}</span></div>`;
  const bestA = asks[0].px, bestB = bids[0].px;
  const mid = (bestA + bestB) / 2;
  const spreadBps = (bestA - bestB) / mid * 1e4;
  $("book-spread").textContent = spreadBps.toFixed(2) + " BPS";
  // imbalance gauge: bid share of top-N notional depth
  const bidNtl = bids.reduce((s, l) => s + l.sz * l.px, 0);
  const askNtl = asks.reduce((s, l) => s + l.sz * l.px, 0);
  const ratio = bidNtl + askNtl > 0 ? bidNtl / (bidNtl + askNtl) : 0.5;
  const imb = $("imb");
  $("imb-fill").style.width = (ratio * 100).toFixed(1) + "%";
  imb.className = ratio >= 0.65 ? "skew bid" : ratio <= 0.35 ? "skew ask" : "";
  imb.title = `spread-local (top ${N} levels): bids ${Math.round(ratio * 100)}% / asks ${Math.round((1 - ratio) * 100)}%` +
    (ratio >= 0.65 ? " — bid-heavy" : ratio <= 0.35 ? " — ask-heavy" : "");
  $("book-rows").innerHTML =
    asks.map((l, i) => row(l, askCum[i], "ask")).reverse().join("") +
    `<div class="bk-mid"><span>${fmtPx(mid)}</span><span class="sp">±${((bestA - bestB) / 2).toPrecision(2)}</span></div>` +
    bids.map((l, i) => row(l, bidCum[i], "bid")).join("");
}

function renderTrades() {
  // Flag prints that are large relative to what is currently trading — the
  // ones worth reacting to rather than the retail dust.
  const sizes = state.trades.slice(0, 60).map((t) => t.ntl || t.sz * t.px)
    .sort((a, b) => a - b);
  const big = sizes.length ? sizes[Math.floor(sizes.length * 0.9)] : Infinity;
  const rows = state.trades.slice(0, 40).map((t) => {
    const ntl = t.ntl || t.sz * t.px;
    return `<div class="tr-row${ntl >= big ? " big" : ""}">` +
      `<span class="tp ${t.side === "B" ? "up" : "dn"}">${fmtPx(t.px)}</span>` +
      `<span class="ts sz">${fmtBig(ntl)}</span>` +
      `<span class="ts tm">${t.time}</span></div>`;
  });
  $("tns-rows").innerHTML = rows.join("") ||
    '<div class="tr-row"><span class="ts">awaiting prints…</span></div>';
}

$("ivls").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll("#ivls button").forEach((x) => x.classList.remove("on"));
  b.classList.add("on");
  state.interval = b.dataset.i;
  loadCandles();
});
window.addEventListener("resize", drawChart);
// The chart box also changes without a window resize — the alert bar appearing,
// a layout preset, the regime strip wrapping. Without this the canvas keeps a
// stale bitmap and state.scale maps clicks to the wrong prices.
if (window.ResizeObserver) {
  let rafPending = false;
  new ResizeObserver(() => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; drawChart(); });
  }).observe($("chart-area"));
  // The SIDES pane sizes its ladder and its print count to the height it
  // actually has, so a preset change has to re-run that arithmetic. Straight
  // call, no rAF: this pane draws into the DOM, not a canvas.
  let sidesPending = false, sidesLastTier = -1;
  new ResizeObserver(() => {
    if (sidesPending) return;
    sidesPending = true;
    setTimeout(() => {
      sidesPending = false;
      const t = sidesTier();
      // A tier change rewrites prose in six blocks, so it needs the full
      // rebuild; anything else only moves the ladder and the print count.
      if (t !== sidesLastTier) { sidesLastTier = t; renderSides(); return; }
      renderSidesLadder(); renderSidesTape();
    }, 60);
  }).observe($("sides-body"));
}

/* command line: type a symbol, ENTER to load */
/* Universe-EXACT resolution for data-driven lookups (intel feed, dossier).
   The research DB carries non-Hyperliquid venues (ostium:, cash:, flx:, km:,
   mkts:, para:) and EDGAR/news tickers that are not coin ids, so a fuzzy
   prefix match would silently route the user to an unrelated market
   (GOOG -> xyz:GOOGL, T -> TRX). Returns null when the name is untradeable
   here, which callers render as non-clickable. */
function exactCoin(sym) {
  if (!sym) return null;
  if (state.universe.crypto[sym]) return sym;
  if (state.universe.equity[sym]) return sym;
  if (state.universe.equity["xyz:" + sym]) return "xyz:" + sym;
  return null;
}

/* Fuzzy prefix match — ONLY for the human-typed command line, where a
   best-effort guess is helpful and the user sees the result immediately. */
/* User input is uppercased before it gets here, but 111 of the ~336 listed
   symbols contain lowercase — every `xyz:` equity and the k-denominated
   memecoins (kPEPE, kSHIB, kBONK, kLUNC, kFLOKI, kDOGS, kNEIRO). Matching
   case-sensitively meant a third of the universe could not be typed at all,
   including symbols copied straight out of this UI. */
function resolveCoin(q) {
  if (!q) return null;
  // Strip decorations people naturally type around a ticker.
  let t = String(q).trim()
    .replace(/^[$#]/, "")
    .replace(/[-/](PERP|USDT?|USDC)$/i, "")
    .trim();
  if (!t) return null;
  const cry = Object.keys(state.universe.crypto || {});
  const eq = Object.keys(state.universe.equity || {});
  const lc = t.toLowerCase();

  const ci = (list, pick) => list.find((c) => pick(c).toLowerCase() === lc);
  // exact, case-insensitive — handles kPEPE and a pasted "xyz:TSLA"
  let hit = ci(cry, (c) => c) || ci(eq, (c) => c) || ci(eq, (c) => baseSym(c));
  if (hit) return hit;
  // k-denominated listing: someone types PEPE, Hyperliquid lists kPEPE
  hit = ci(cry, (c) => c.replace(/^k/i, ""));
  if (hit) return hit;
  // last resort: unique prefix, still case-insensitive
  const pre = (list, pick) => {
    const m = list.filter((c) => pick(c).toLowerCase().startsWith(lc));
    return m.length ? m[0] : null;
  };
  return pre(cry, (c) => c) || pre(eq, (c) => baseSym(c)) || null;
}

/* Visible add-to-watchlist box. The +SYM command-bar syntax stayed
   undiscovered — a labelled input in the watch panel is the obvious path.
   Lives in the header, NOT the table body, because the body re-renders on
   every price tick and would eat the input's focus and text. */
/* ── live tab badges ─────────────────────────────────────────────────────
   A tab label alone says what a panel IS; a trader needs to know whether it
   currently MATTERS. Each badge is the single number that decides the click:
   biggest watchlist move, biggest universe move, worst funding, top signal
   score (colored by side), and the burn tab's live state (buyback stepping
   in / a token's spend slowing). Pure read of already-loaded state — no new
   requests. */
function updateTabBadges() {
  const set = (t, html) => {
    const b = document.querySelector('#wtabs button[data-t="' + t + '"]');
    if (!b) return;
    let em = b.querySelector(".tb");
    if (!em) { em = document.createElement("em"); em.className = "tb"; b.appendChild(em); }
    if (em.innerHTML !== html) em.innerHTML = html;
    em.style.display = html ? "" : "none";
  };
  // WATCH: largest absolute move on the user's own list
  let best = null;
  for (const c of [...state.watchCrypto, ...state.watchEquity]) {
    const ctx = ctxFor(c) || {};
    const mid = state.mids[c] != null ? +state.mids[c] : ctx.mid_px;
    const ch = pct(mid, ctx.prev_day_px);
    if (ch != null && (!best || Math.abs(ch) > Math.abs(best.ch))) best = { c, ch };
  }
  /* VENUE, NOT JUST TICKER — the same doctrine whSymCell states for the
     tables, applied to the badges, which had it in exactly one of four
     places (PORT). Measured on glass before this change: the WHALES badge
     read "INTC -$883.7K L" for xyz:INTC — a HIP-3 equity perp on its own
     dex, its own book and its own wallets, printed as if it were the
     Nasdaq-adjacent thing a reader assumes when a badge says INTC. The
     owner trades market.xyz with real size, so this is the wrong half to
     drop: a truncated ticker is visibly truncated, a dropped venue is
     silently wrong. whDexTag returns "" for core, so core badges are
     byte-identical to before. */
  set("watch", best && Math.abs(best.ch) >= 2
    ? `<i class="${best.ch >= 0 ? "up" : "dn"}">${esc(baseSym(best.c))}${whDexTag({ coin: best.c })} ${best.ch >= 0 ? "+" : ""}${best.ch.toFixed(0)}%</i>` : "");
  // MOVERS: top universe mover
  const g = ((state.movers || {}).gainers || [])[0];
  const l = ((state.movers || {}).losers || [])[0];
  const top = g && l ? (Math.abs(g.chg_pct) >= Math.abs(l.chg_pct) ? g : l) : (g || l);
  set("movers", top
    ? `<i class="${top.chg_pct >= 0 ? "up" : "dn"}">${top.chg_pct >= 0 ? "+" : ""}${top.chg_pct.toFixed(0)}%</i>` : "");
  // FUND: most extreme 8h funding
  const f = ((state.movers || {}).funding_extremes || [])[0];
  set("funding", f && Math.abs(f.funding_8h_pct) >= 0.05
    ? `<i class="${fundingClass(f.funding_8h_pct)}">${f.funding_8h_pct.toFixed(2)}%</i>` : "");
  // SIGNALS: top score, colored by direction
  const sg = ((state.signals || {}).signals || [])[0];
  set("signals", sg && sg.score >= 40
    ? `<i class="${/short/i.test(sg.direction || sg.side || "") ? "dn" : "up"}">${esc(sg.base || baseSym(sg.coin))}${whDexTag(sg)} ${Math.round(sg.score)}</i>` : "");
  // PORT: a tight liquidation outranks PnL — it is the number that ends accounts
  const po = state.port || {};
  if (po.address && po.n_positions) {
    const tight = (po.positions || []).filter((p) => p.liq_band === "danger");
    // liq_band is null for every CROSS position, so filtering on it alone made
    // this badge unreachable in the owner's actual margin mode and it silently
    // degraded to PnL. Account-level danger is the same event; it gets in here.
    // A venue already BELOW maintenance has no percentage to rank on, and
    // acctAdverseMovePct is null there by design — ranking on that alone would
    // drop the worst state there is out of the badge and degrade to PnL again.
    // It sorts ahead of every finite distance instead.
    const acct = (po.venues || [])
      .filter((v) => v.n_positions)
      .map((v) => {
        const st = acctLiqState(v);
        return { venue: v.venue, st, rank: st.state === "breached" ? -Infinity : st.pct };
      })
      .filter((r) => r.st.state === "breached" || acctBand(r.st.pct) === "danger")
      .sort((a, b) => a.rank - b.rank)[0] || null;
    const w = tight.sort((a, b) => a.liq_dist_pct - b.liq_dist_pct)[0] || null;
    if (w || acct) {
      // Whichever is nearer the event owns the badge.
      if (w && (!acct || w.liq_dist_pct <= acct.rank))
        set("port", `<i class="hot">${esc(w.coin)} ${w.liq_dist_pct.toFixed(0)}%</i>`);
      else if (acct.st.state === "breached")
        set("port", `<i class="hot">${esc(acct.venue)} acct ≤MAINT</i>`);
      else
        set("port", `<i class="hot">${esc(acct.venue)} acct ${acct.st.pct.toFixed(0)}%</i>`);
    } else {
      const u = po.unrealized || 0;
      set("port", `<i class="${u >= 0 ? "up" : "dn"}">${u >= 0 ? "+" : "-"}$${fmtBig(Math.abs(u))}</i>`);
    }
  } else { set("port", ""); }
  // WHALES: the biggest single whale move of the last hour — the number that
  // decides whether the tab is worth a click right now.
  const whEvs = ((state.whales || {}).events || []);
  const hourAgo = Date.now() / 1000 - 3600;
  let big = null;
  for (const e of whEvs) {
    if ((e.ts || 0) < hourAgo) break; // newest-first: past the hour, stop
    if (!big || (e.delta_ntl || 0) > (big.delta_ntl || 0)) big = e;
  }
  set("whales", big
    ? `<i class="${big.side === "long" ? "up" : "dn"}">${esc(baseSym(big.coin))}${whDexTag(big)} ` +
      `${big.type === "closed" || big.type === "decreased" ? "-" : "+"}$` +
      `${fmtBig(big.delta_ntl)} ${big.side === "long" ? "L" : "S"}</i>` : "");
  // ALERTS: fires the user has not looked at yet. His OWN fires own the
  // badge — at ~85 whale prints a day a combined count is permanently hot and
  // therefore says nothing. Whale-only unseen still shows, unstyled, so the
  // tab never goes blank while something is arriving.
  const fired = ((state.alertFeed || {}).fired) || [];
  /* A corrupt hlterm_alerts_seen used to silence the badge completely.

     `+(getItem(...) || 0)` yields NaN for any non-numeric value, every
     `(f.at||0) > NaN` is false, and the unseen count collapses to 0 — "not
     measured" rendered as "measured zero", in the direction that HIDES fires
     the owner has not looked at. Verified live: with the key set to "garbage"
     the badge element vanished entirely while 15 unseen own-fires sat in the
     ledger. Falling back to 0 (treat everything as unseen) errs toward
     over-reporting, which is the correct side for an alert. */
  const seenRaw = Number(localStorage.getItem("hlterm_alerts_seen"));
  const seen = Number.isFinite(seenRaw) ? seenRaw : 0;
  const unseenMine = mineFires().filter((f) => (f.at || 0) > seen).length;
  const unseenWhale = fired.filter((f) => isWhaleFire(f) && (f.at || 0) > seen).length;
  set("alerts", unseenMine ? `<i class="hot">${unseenMine}</i>`
    : unseenWhale ? `<i>${unseenWhale}\uD83D\uDC0B</i>` : "");
  // BURN: live urgency — buyflow stepping in beats a slowing badge
  const bf = state.buyflow || {};
  let burn = "";
  if (bf.ok && bf.state === "stepping in" && bf.ratio_60m)
    burn = `<i class="hot">${bf.ratio_60m.toFixed(1)}x</i>`;
  else {
    const slowing = Object.values(state.buyback || {})
      .filter((p) => p.trend && p.trend.state === "slowing" && p.trend.confirmed).length;
    if (slowing) burn = `<i class="dn">${slowing}▼</i>`;
  }
  set("burn", burn);
}
setInterval(() => { updateTabBadges(); renderHints(); }, 10000);
setTimeout(updateTabBadges, 4000);
loadAlertsFeed();
setInterval(loadAlertsFeed, 60000);
loadPort();
setInterval(() => { if (!document.hidden) loadPort(); }, 20000);
/* Same cadence as positions, and for the same reason the server gave them a
   shared cache entry: a stop is only meaningful beside the leg it protects,
   so the two must not drift apart on screen. STOPS_TTL is 20s server-side,
   so this polls the cache rather than the venues. */
loadStops();
/* 20s -> 90s. Resting orders are not a tick-rate quantity: they change when
   the owner places or pulls one, which is minutes-to-hours apart, and each
   poll fans out frontendOpenOrders PER DEX (up to 10 venues). At a 20s poll
   against a 20s server TTL every single poll was a cache MISS — measured: a
   real 1.0-1.2s fan-out on every tick, age_s resetting to 0.0 each time. The
   server TTL is now 90s too, so multi-tab load collapses onto one fetch. */
setInterval(() => { if (!document.hidden) loadStops(); }, 90000);
loadFundingX();
setInterval(loadFundingX, 300000);   // predicted funding; server caches 5 min
setInterval(() => { if (!document.hidden) loadWhaleCoin(); }, 60000);   // whale overlay for the charted pair
setInterval(() => { if (state.wtab === "screen") loadScreen(); }, 60000);
/* Poll while the DEEP tab is open so a queued workup flips to a verdict
   without a manual refresh; a run takes ~9 min so 30s is ample. */
setInterval(() => { if (state.wtab === "deep") loadDeep(); }, 30000);
/* Whales polls even when the tab is closed: the badge (biggest move <1h)
   has to fire without a visit, and the fetch is a local read of a JSON
   store — no upstream cost. */
loadWhales();
setInterval(() => { if (!document.hidden) loadWhales(); }, 60000);

$("watch-add").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const el = e.target;

  /* On the DEEP tab this box queues a workup instead of adding to the
     watchlist — same control, meaning follows the visible tab. Symbols are NOT
     resolved through resolveCoin() here: a deep dive accepts anything the data
     layer can serve (NVDA, BTC-USD, HYPE-USD), which is a wider set than the
     HL watchlist universe, and the server's gate is the real authority on
     whether a run is allowed. */
  if (state.wtab === "deep") {
    const sym = el.value.trim().toUpperCase();
    if (!sym) return;
    deepAct(sym);
    el.value = "";
    el.placeholder = "queued " + sym + " — ~9 min";
    setTimeout(() => { el.placeholder = "+ add symbol"; }, 2500);
    return;
  }

  const coin = resolveCoin(el.value.trim().toUpperCase());
  if (coin) {
    addWatch(coin);
    el.value = "";
    el.placeholder = "added " + baseSym(coin) + " ✓";
    setTimeout(() => { el.placeholder = "+ add symbol"; }, 1500);
  } else {
    /* Restore the TITLE too, not just the border.

       Audited 2026-08-16: only borderColor was restored, so after one bad
       symbol this input's tooltip read "unknown symbol — try the HL name…"
       for the rest of the session — a control describing an old failure
       instead of its own purpose. The title is captured and put back on the
       same timer that clears the border.

       And say it in WORDS. A 800ms colour change is not a message: it is
       gone before it is read, it is invisible to a colourblind reader, and
       the typed text stays in the box, so a second later the field looks
       accepted-but-ignored. */
    const was = el.title;
    el.style.borderColor = "#ff4d5e";
    el.title = "unknown symbol — try the HL name (WIF, kPEPE, GOOGL…)";
    showToast("no market named " + el.value.trim().toUpperCase() +
              " on HL core or the HIP-3 dexes — not added");
    el.select();                      // the next keystroke replaces it
    setTimeout(() => { el.style.borderColor = ""; el.title = was; }, 800);
  }
});

$("cmd").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  let q = $("cmd").value.trim().toUpperCase();
  if (!q) return;
  // dossier: "TSLA ?"
  if (q.endsWith("?") && q.length > 1) {
    const c = resolveCoin(q.slice(0, -1).trim());
    if (c) { openDossier(c); $("cmd").value = ""; return; }
    $("cmd").style.borderColor = "#ff4d5e";
    showToast("no market named " + esc(q.slice(0, -1).trim()) +
              " — nothing to open a dossier on");
    setTimeout(() => ($("cmd").style.borderColor = ""), 600);
    return;
  }
  // alert syntax first: "BTC > 65000" / "TSLA < 300"
  const al = tryCreateAlert(q);
  if (al === true) { $("cmd").value = ""; return; }
  if (al === "already" || al === "bad") {
    $("cmd").style.borderColor = al === "already" ? "#ffb84d" : "#ff4d5e";
    $("cmd").title = al === "already" ? "price is already beyond that level" : "";
    setTimeout(() => { $("cmd").style.borderColor = ""; $("cmd").title = ""; }, 900);
    return;
  }
  const adding = q.startsWith("+");
  if (adding) q = q.slice(1);
  const coin = resolveCoin(q);
  if (coin) {
    if (adding) addWatch(coin); else selectCoin(coin);
    $("cmd").value = "";
  } else {
    /* Say it. Audited 2026-08-16: the ONLY feedback for an unresolvable symbol
       was borderColor for 600ms, with the typed text left in the box — so a
       second later the command line looked accepted-but-ignored, and a
       colourblind reader got no signal at all. Verified on ZZZZ and on CJK
       input: no toast, no text, field still holding the input 4.5s later. */
    $("cmd").style.borderColor = "#ff4d5e";
    showToast("no market named " + esc(q) + " on HL core or the HIP-3 dexes" +
              (adding ? " — not added to the watchlist" : ""));
    $("cmd").select();                // the next keystroke replaces it
    setTimeout(() => ($("cmd").style.borderColor = ""), 600);
  }
});

/* ---------------- events radar ---------------- */
function hlTradeUrl(coin) {
  return "https://app.hyperliquid.xyz/trade/" + encodeURIComponent(coin);
}

/* ---------------- insider buy clusters ---------------- */
async function loadInsiders() {
  try {
    const d = await fetch("/api/insiders").then((r) => r.json());
    // The INTEL STACK panel that hosted #insiders was replaced by BOTH SIDES;
    // the clusters themselves still feed the dossier and the SIGNALS ranking,
    // so the FETCH must survive the element's absence. A no-op sink keeps the
    // status/`head()` bookkeeping intact without a null check at every use.
    const el = $("insiders") ||
      { set textContent(v) {}, set innerHTML(v) {}, get textContent() { return ""; } };
    const head = (extra) => { el.textContent = ""; state.insiderNote = extra; return ""; };
    if (d.status === "warming") {
      head("EDGAR scanning…");
      renderIntel();
      return;
    }
    if (d.error) {
      state.insiders = []; renderIntel();
      el.innerHTML = head(esc(d.error));
      return;
    }
    const cl = d.clusters || [];
    state.insiders = cl;
    renderIntel();
    if (!cl.length) {
      el.innerHTML = head(`${d.tickers_scanned || 0} names scanned`) +
        '<div class="ins-empty">no open-market insider purchases in window</div>';
      return;
    }
    head(`${cl.length} insider cluster${cl.length === 1 ? "" : "s"}` +
         (d.truncated ? " · truncated" : ""));
  } catch (e) { /* keep last */ }
}

/* ---------------- symbol dossier ----------------
   Everything the terminal knows about one name, on one screen: the pre-trade
   checklist. Assembled entirely from data already loaded — no extra fetches. */
function dossierSections(coin) {
  const base = baseSym(coin);
  const ctx = ctxFor(coin) || {};
  const sig = ((state.signals && state.signals.signals) || []).find((s) => s.coin === coin);
  const card = (state.cards || []).find((c) => c.asset === coin || c.base_symbol === base);
  const ins = (state.insiders || []).find((c) => c.ticker === base);
  const evs = (state.events || []).filter((e) => e.hl_coin === coin || e.symbol === base)
    .filter((e) => e.date >= etDate(0)).slice(0, 3);
  const news = (state.news || []).filter((n) => n.base_symbol === base).slice(0, 4);
  return { base, ctx, sig, card, ins, evs, news };
}

/* Alert-template button: turns any displayed level into a standing alert. */
function alarmBtn(coin, level, note) {
  const v = Number(level);
  if (!coin || !isFinite(v)) return "";
  return `<span class="alarm" data-coin="${esc(coin)}" data-level="${v}" ` +
    `data-note="${esc(note)}" title="alert at ${fmtPx(v)} (${esc(note)})">⏰</span>`;
}

/* ---------------- cross-venue comparison (dossier box) ----------------
   Same instrument, every venue that lists it, side by side: mid, spread,
   ±25bps depth, volume, OI, funding. Server-assembled on demand from the
   venues snapshot plus a bounded book fan-out (/api/xvenue). Read-only
   decision support — the terminal routes nothing, this is for SEEING where
   the depth and demand actually sit. */
const XVENUE_TTL_MS = 60000;   // matches the server-side cache for one coin

function xvStale(cur) {
  if (!cur) return true;
  if (cur.loading) return false;
  const age = Date.now() - (cur.at || 0);
  if (cur.err) return age > 15000;               // retry a failure, unhurried
  if (cur.d && cur.d.warming) return age > 5000; // venue snapshot warming
  return age > XVENUE_TTL_MS;
}

async function loadXVenue(coin) {
  const cur = state.xv[coin];
  if (cur && !xvStale(cur)) return;
  const kept = cur ? cur.d : null;
  const keptAt = cur ? cur.dAt : null;    // when `kept` was MEASURED, not when we asked
  const keptSrv = cur ? !!cur.dSrv : false;
  aggPut(state.xv, coin, { coin, loading: true, at: Date.now(), d: kept,
                           dAt: keptAt, dSrv: keptSrv });
  try {
    const r = await fetch("/api/xvenue?coin=" + encodeURIComponent(coin));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    if (d && d.error) throw new Error(d.error);
    // dAt from the payload's own build stamp, so the server's ≤60s cache hold
    // is inside the age this tab prints instead of being reset to 0 by it.
    const st = srvStamp(d, Date.now());
    aggPut(state.xv, coin, { coin, d, at: Date.now(), dAt: st.ms, dSrv: st.srv });
  } catch (e) {
    // Keep the last payload through a blip, but carry the error out so the
    // box says the refresh failed rather than wearing a current face.
    aggPut(state.xv, coin, { coin, err: (e && e.message) || String(e),
                             at: Date.now(), d: kept, dAt: keptAt,
                             dSrv: keptSrv });
  }
  if (state.dossierCoin === coin) drawDossier(coin);
  // The aggregator board holds the CHARTED coin, which need not be the coin
  // whose dossier is open. Both read the same store now, so both are told.
  if (state.wtab === "venues" && state.sel === coin) renderVenuesTab();
}

function xvenueBox(coin, box) {
  const TITLE = "CROSS-VENUE · SAME INSTRUMENT";
  const xv = state.xv[coin];
  if (!xv || xv.coin !== coin)
    return box(TITLE, '<div class="dz-empty">loading cross-venue comparison…</div>');
  const d = xv.d;
  if (!d)
    return box(TITLE, `<div class="dz-empty">${xv.loading
      ? "loading cross-venue comparison…"
      : "could not load — <b>" + esc(xv.err || "no payload") + "</b>"}</div>`);
  if (d.warming)
    return box(TITLE, `<div class="dz-empty">${esc(d.note ||
      "venue snapshot warming — retrying…")}</div>`);
  const rows = d.rows || [];
  if (!rows.length)
    return box(TITLE, `<div class="dz-empty">${esc(d.note || "no listings found")}</div>`);

  const cheap = d.cheapest || {};
  // dAt, not at: `at` moves on every failed retry, which made a stale
  // table report itself as freshly fetched. See agHeld(). dAt is now the
  // payload's own build stamp where the server gave one (srvStamp), so the
  // server's cache hold is inside heldS rather than resetting it to 0.
  const heldS = Math.max(0, Math.round((Date.now() - (xv.dAt || xv.at)) / 1000));
  const band50 = (bk) => (bk.bands || []).find((x) => x.bps === 50) || {};
  const cell = (txt, cls, title) =>
    `<span class="xv-n${cls ? " " + cls : ""}"${title ? ` title="${esc(title)}"` : ""}>${txt}</span>`;

  let h = `<div class="xv-t">` +
    `<div class="xv-r head"><span>venue</span><span class="xv-n">mid</span>` +
    `<span class="xv-n">spread</span><span class="xv-n">±25bps bid/ask</span>` +
    `<span class="xv-n">vol 24h</span><span class="xv-n">OI</span>` +
    `<span class="xv-n">fund/8h</span></div>`;
  for (const r of rows) {
    const bk = r.book || {};
    const b25 = (bk.bands || []).find((x) => x.bps === 25) || {};
    const b50 = band50(bk);
    // venue cell: home marker, cheapest chip, and the price-verification
    // story in the tooltip — matched by TICKER, price only VERIFIES.
    const vTitle = (r.home ? "the venue this market is charted from"
        : "same base ticker" + (pxMatchTxt(r) ? "; " + pxMatchTxt(r) : "")) +
      (r.share_pct != null ? " · " + r.share_pct + "% of this instrument's cross-venue volume" : "") +
      (bk.src ? " · book: " + bk.src : "");
    const vCell = `<span class="xv-v" title="${esc(vTitle)}">${esc(r.venue)}` +
      (r.home ? `<span class="xv-home" title="the venue being charted">◂</span>` : "") +
      (cheap.venue === r.venue
        ? `<span class="xv-cheap" title="${esc(cheap.why || "")}">CHEAPEST</span>` : "") +
      // The verdict, VISIBLE — not only in the cell's own title. A reader
      // scanning for a second book to size against should not have to hover
      // every row to find the one whose price never checked out.
      pxMatchChip(r, "xv-pxq") +
      `</span>`;
    // mid: measured book first; the snapshot price is a dated fallback and
    // must say so — it is up to (snap_age_s + held) old.
    const midCell = bk.mid != null
      ? cell(fmtPx(bk.mid), "", "book mid · spread " +
          (bk.spread_bps != null ? (bk.spread_bps * 10).toFixed(2) + "bps" : "?") +
          (bk.reach_bps != null ? " · served book reaches " + bk.reach_bps + "bps" : ""))
      : cell(r.px_snap != null ? fmtPx(r.px_snap) + "*" : "–", "xv-dim",
          "*snapshot price (venues snapshot ~" +
          Math.round((d.snap_age_s || 0) + heldS) + "s old) — live book " +
          (bk.err ? "failed: " + bk.err : "not available" +
            (bk.note ? " — " + bk.note : "")));
    const spCell = bk.spread_bps != null
      ? cell((bk.spread_bps * 10).toFixed(2) + "bp", "",
          "full-band spread from the measured book · tick " +
          (bk.tick_bps != null ? bk.tick_bps + "bps" : "?"))
      : cell("–", "xv-dim", bk.err || bk.note || "no measured book");
    let dCell;
    if (b25.bid_usd != null && b25.ask_usd != null) {
      dCell = cell(`$${fmtBig(b25.bid_usd)}/$${fmtBig(b25.ask_usd)}`, "",
        `resting notional within ±25bps of mid — bid $${fmtBig(b25.bid_usd)} ` +
        `/ ask $${fmtBig(b25.ask_usd)}` +
        (b50.bid_usd != null && b50.ask_usd != null
          ? ` · ±50bps $${fmtBig(b50.bid_usd)}/$${fmtBig(b50.ask_usd)}`
          : b50.unresolved ? ` · ±50bps: ${b50.unresolved}` : "") +
        " · CANCELLABLE resting size — shown, not committed");
    } else {
      // "not measured" in words, never an empty cell: a blank here would
      // read as an empty book, and on Lighter majors it is a REST cap.
      dCell = cell("not measured", "xv-dim",
        b25.unresolved || bk.err || bk.note || "±25bps band unresolved");
    }
    const volCell = cell(r.vol_24h != null ? "$" + fmtBig(r.vol_24h) : "–",
      r.vol_24h == null ? "xv-dim" : "",
      "24h volume, from the venues snapshot");
    const oiCell = r.oi_usd != null
      ? cell("$" + fmtBig(r.oi_usd), "", "open interest · " +
          (r.oi_src || "") + " — per-venue, never summed (hedges sit on both sides of a sum)")
      : cell("n/p", "xv-dim",
          r.oi_note || "OI not published by this venue's stats endpoint — unknown, not zero");
    const f8h = r.funding_1h != null ? r.funding_1h * 8 * 100 : null;
    const fCell = f8h != null
      ? `<span class="xv-n ${fundingClass(f8h)}" title="${esc((r.funding_src || "") +
          " · positive = longs pay")}">${f8h.toFixed(4)}%</span>`
      : cell("–", "xv-dim", r.funding_note || "funding unknown for this venue");
    h += `<div class="xv-r">${vCell}${midCell}${spCell}${dCell}${volCell}${oiCell}${fCell}</div>`;
  }
  h += `</div>`;

  const notes = [];
  if (xv.err)
    notes.push(`<div class="xv-warn">refresh FAILING — <b>${esc(xv.err)}</b> · ` +
      `table is the payload from ${heldS}s ago</div>`);
  if (d.only) notes.push(`<div class="xv-warn">${esc(d.only)}</div>`);
  for (const f of d.failed || [])
    notes.push(`<div class="xv-warn">${esc(f.venue)} ${esc(f.what || "")} failed — ` +
      `${esc(f.impact || f.error || "")}</div>`);
  for (const s of d.split || [])
    notes.push(`<div class="xv-warn">same ticker, DIFFERENT asset: ` +
      `${esc(s.venue)}:${esc(s.sym)} price differs ${s.px_diff_bps}bps — excluded</div>`);
  // Same roster as the VENUES pane (see whoBoardHtml's sibling above): the
  // reader of a dossier is asking the same "where else does this trade"
  // question, and a named venue is the answer a count cannot give.
  if ((d.others_hidden || []).length) {
    notes.push(`<div class="dz-empty">NOT SHOWN — ${d.others_hidden.length} ` +
      `further listing(s) exist. ${esc(d.others_rule || OTHERS_RULE_FALLBACK)}` +
      `</div>`);
    for (const hd of d.others_hidden)
      notes.push(`<div class="dz-empty">· <b>${esc(hd.venue)}</b> ` +
        `${esc(hd.sym)} — $${fmtBig(hd.vol)}/24h` +
        (hd.share_pct != null ? ` · ${esc(fmtShare(hd.share_pct))}` : ``) +
        ` — ${esc(hd.why || "")}</div>`);
  } else if (d.others_note) {
    notes.push(`<div class="dz-empty">${esc(d.others_note)}</div>`);
  }
  if (d.fanout_note) notes.push(`<div class="dz-empty">${esc(d.fanout_note)}</div>`);
  if (cheap.venue) {
    notes.push(`<div class="dz-empty">cheapest to trade: <b>${esc(cheap.venue)}</b> — ` +
      `${esc(cheap.why || "")} · a description of the books, not a routing instruction</div>`);
  } else if (rows.length > 1 && cheap.why) {
    notes.push(`<div class="dz-empty">no cheapest venue claimed — ${esc(cheap.why)}</div>`);
  }
  /* "Fetched Ns ago (server caches ≤60s)" named the hold and then excluded it
     from the number beside it: dAt was receipt time, so a cache HIT printed
     0s over a payload up to a hold-plus-fan-out old (measured: 18.4s of real
     age rendered as "Fetched 0s ago"). The hold is inside the number now, so
     the sentence says that; when the basis is receipt instead, it says the
     opposite rather than letting one wording cover both. */
  notes.push(`<div class="dnote">${esc(d.note || "")} Depth is resting and ` +
    `cancellable. ${xv.dSrv
      ? `Measured ${heldS}s ago — the server stamps this payload when it ` +
        `builds it and re-serves it for up to 60s, so that hold is inside ` +
        `this age.`
      : `Received ${heldS}s ago — this payload carried no build stamp, so ` +
        `the server's cache hold of up to 60s is NOT inside this age and the ` +
        `true age is larger.`}</div>`);
  return box(TITLE, h + notes.join(""));
}

function openDossier(coin) {
  $("dossier").dataset.mode = "symbol";
  state.dossierCoin = coin;
  loadXVenue(coin);
  drawDossier(coin);
  $("dossier").style.display = "flex";
  // A pre-trade checklist that silently freezes its price is worse than no
  // price: re-render on the live tick, preserving scroll position.
  clearInterval(state.dossierTimer);
  state.dossierTimer = setInterval(() => {
    if (state.dossierCoin) {
      loadXVenue(state.dossierCoin);   // TTL-guarded; a no-op while fresh
      drawDossier(state.dossierCoin);
    }
  }, 3000);
}

function burnDossier(bb, coin, box) {
  const meas = bb.measured || {};
  const net = meas.net;
  const hold = bb.holdings;
  const ctx = ctxFor(coin) || {};
  const px = state.mids[coin] != null ? +state.mids[coin] : ctx.mid_px;
  const usd = (t) => (px != null && t != null ? t * px : null);
  const money = (t) => { const v = usd(t); return v == null ? fmtBig(t) : "$" + fmtBig(v); };
  const row = (a, b, c) => `<div class="dz-row"><span class="dz-a">${a}</span>` +
    `<span class="dz-b">${b}</span>` + (c ? `<span class="dz-c">${c}</span>` : "") + `</div>`;

  // 1. What it does, and whether it actually buys.
  const funded = !!bb.bid;
  let out = row(esc(BB_TAG[bb.kind] || bb.kind), esc(bb.detail),
                funded ? "buys on market" : "not market-bought");

  // 2. The bid — the number that matters most.
  if (bb.bid) {
    const b = bb.bid.usd_day != null ? bb.bid.usd_day : usd(bb.bid.tokens_day);
    const pv = bb.global_vol24h && b ? b / bb.global_vol24h * 100 : null;
    const bidLabel = /AF 24h fills|spot fills/i.test(bb.bid.basis || "")
      ? "AF 24h fills" : "buying (labelled window)";
    out += row(bidLabel, `<b class="up">$${fmtBig(b)}/day</b>`,
      (pv != null ? pv.toFixed(2) + "% of 24h vol · " : "") + esc(bb.bid.basis));
  } else if (bb.paused) {
    out += row("buying now", `<b class="dn">PAUSED</b>`,
      esc(bb.paused.since + " — " + bb.paused.why));
  } else {
    out += row("buying now", `<span class="fl">no measurable market buying</span>`, "");
  }

  // 3. Accumulated position / destroyed supply.
  if (hold) {
    out += row("float removed", `<b>${money(hold.held)}</b>` +
      (hold.pct_supply ? ` (${hold.pct_supply.toFixed(1)}% of supply)` : ""),
      esc(hold.label));
    if (hold.rate) {
      const d = usd(hold.rate.per_day);
      out += row("wallet 7d", `<span class="${hold.rate.per_day >= 0 ? "up" : "dn"}">` +
        `${hold.rate.per_day >= 0 ? "+" : "−"}$${fmtBig(Math.abs(d))}/day</span>`,
        esc(hold.rate.basis));
    }
    if (hold.not_a_buyback_counter) {
      out += row("caveat", `<span class="dn">balance is not a pure buyback counter</span>`,
        "wallet also pays out");
    }
  }
  if (meas.cumulative_burned != null && meas.cumulative_pct_supply >= 0.05) {
    out += row("burned lifetime", `<b>${money(meas.cumulative_burned)}</b> at today's px`,
      `${fmtBig(meas.cumulative_burned)} ${esc(coin)} · ` +
      `${meas.cumulative_pct_supply.toFixed(1)}% of supply`);
  }

  // 4. Live window or last event — never a 30d archive net as /day.
  if (net && net.basis === "intraday") {
    const per = usd(Math.abs(net.net_per_day));
    out += row("net supply (live)", `<span class="${net.deflationary ? "up" : "dn"}">` +
      `${net.deflationary ? "−" : "+"}$${fmtBig(per)}/day</span>`,
      `measured live over ${net.span_hours}h`);
  } else {
    const d1 = meas.burn_1d, d7 = meas.avg_per_day_7d;
    if (d1 > 0) out += row("1d on-chain", `<b>${money(d1)}</b>`, "last 24h");
    else if (d7 > 0) out += row("7d on-chain", `<b>${money(d7)}/day</b>`, "7d mean");
    else if ((bb.history_stats || {}).d7 > 0 && burnHistRecent(bb))
      out += row("7d archive", `<b>$${fmtBig(bb.history_stats.d7)}/day</b>`, "not a 30d net");
    else {
      const ev = burnLastEvent(bb);
      if (ev) out += row("last event",
        `<b>${ev.usd != null ? "$" + fmtBig(ev.usd) : money(ev.tokens)}</b>`,
        burnIstDate(ev.ms));
    }
  }

  // 5. Cadence and what is next.
  const sch = bb.schedule;
  if (sch && sch.regular && sch.next_ts) {
    const dd = (sch.next_ts * 1000 - Date.now()) / 86400000;
    out += row("next burn",
      `<b>${new Date(sch.next_ts * 1000).toISOString().slice(0, 10)}</b> ` +
      `${esc(sch.weekday)} ${esc(sch.hour_utc)}Z (` +
      `${(sch.stale || dd < -2) ? "sched stale" : (dd < 0 ? "due" : "~" + dd.toFixed(0) + "d")})`,
      `every ~${sch.period_days}d · ${esc(sch.confidence)}`);
  } else if (sch && sch.gaps_days) {
    out += row("cadence", `<span class="fl">irregular</span>`,
      `gaps ${sch.gaps_days.join(", ")}d`);
  }

  // 6. The actual events, so the cadence claim is checkable.
  const evs = bb.burn_events || [];
  if (evs.length) {
    out += `<div class="dz-row sub"><span class="dz-a">recent burns</span></div>`;
    out += evs.slice(0, 5).map((e) =>
      `<div class="dz-row sub"><span class="dz-a">` +
      `${new Date(e.ts * 1000).toISOString().slice(0, 10)}</span>` +
      `<span class="dz-b">${money(e.size)}</span>` +
      `<span class="dz-c">${fmtBig(e.size)} ${esc(coin)}</span></div>`).join("");
  }

  // 7. Where to verify it. The url is built upstream from per-programme
  // config, so it gets the same scheme allowlist as the news links: on
  // anything that is not http(s) the ADDRESS still prints — it is the fact
  // that lets the reader verify by hand — but this desk will not offer it as
  // something to click.
  if (bb.explorer) {
    const bbHref = safeHref(bb.explorer.url);
    const bbAddr = `${esc(bb.explorer.addr.slice(0, 10))}…${esc(bb.explorer.addr.slice(-6))}`;
    out += row("verify", bbHref
      ? `<a href="${esc(bbHref)}" target="_blank" rel="noopener">${bbAddr} ↗</a>`
      : `<span title="this programme's explorer link is not an http(s) url, ` +
        `so it is printed rather than linked">${bbAddr}</span>`,
      esc(bb.explorer.label || ""));
  }

  // 8. The trend — a single rate is a snapshot; the shape is the signal.
  const hs = bb.history_stats || {};
  if (hs.d7 != null || hs.d30 != null) {
    const parts = [];
    for (const w of [7, 30, 90]) {
      const v = hs["d" + w];
      if (v != null) parts.push(`${w}d <b>$${fmtBig(v)}</b>/d`);
    }
    let dir = "";
    if (hs.d7 != null && hs.d30 != null && hs.d30 > 0) {
      const ch = (hs.d7 - hs.d30) / hs.d30 * 100;
      dir = `<span class="${ch >= 0 ? "up" : "dn"}">` +
        `${ch >= 0 ? "+" : ""}${ch.toFixed(0)}% vs 30d</span>`;
    }
    // "burned" is fee revenue destroyed in kind; "bought" is a real bid. Both
    // are $/day and would look identical without saying which.
    const hm = bb.history_meta || {};
    const label = hm.kind === "burned" ? "gross burn trend" : "buyback trend";
    // Direction, not just level — "how much" is the easy half of the question.
    const tr = bb.trend;
    const dirTag = tr
      ? `<b class="bb-trend ${esc(tr.state)}">${tr.state.toUpperCase()}</b>` +
        (tr.confirmed ? `<span class="fl"> confirmed on 90d</span>` : "")
      : `<span class="fl">trend unknown</span>`;
    out += row(label, parts.join(" · "), dirTag + " " + dir);
    // A weekly batch burner does not spend daily; the mean is still the right
    // comparison, but calling it a daily rate without the cadence misleads.
    if (hm.cadence && hm.cadence.batch) {
      out += row("cadence", `${hm.cadence.events} events over ` +
        `${hm.cadence.span_days}d`, `~every ${hm.cadence.every_days}d — ` +
        `rates above are batches averaged per day`);
    }
  }
  // Revenue -> expected bid. The pass-through is policy-stable (HYPE IQR
  // 65.6-69.7% weekly), so a gap between expected and measured is a POLICY
  // signal, which a raw slowing number cannot distinguish from soft revenue.
  const rev = bb.revenue;
  if (rev) {
    out += row("revenue → bid",
      `fees $${fmtBig(rev.fees_usd_day_7d)}/d × ${rev.passthrough_pct.toFixed(0)}% ` +
      `= expect <b>$${fmtBig(rev.expected_usd_day)}/d</b>`,
      (rev.measured_usd_day != null
        ? `measured $${fmtBig(rev.measured_usd_day)}/d (${rev.gap_pct >= 0 ? "+" : ""}${(rev.gap_pct || 0).toFixed(0)}%)`
        : "") +
      (rev.attribution ? ` · <b class="${/POLICY/.test(rev.attribution) ? "dn" : "fl"}">${esc(rev.attribution)}</b>` : ""));
  }
  out += burnHistoryChart(bb, coin, usd);

  out += burnMeterHtml(coin);
  // Say plainly what the event study found, so the panel is not read as a
  // buy signal it does not support.
  out += `<div class="dnote">mechanism is the protocol's claim ` +
    `(${esc(bb.source || "n/a")}); every figure above is measured on-chain. ` +
    `Tested: forward returns after burns do not beat volume-matched random ` +
    `timestamps — treat this as position-sizing context, not an entry trigger.</div>`;
  return box("TOKENOMICS · BUYBACK / BURN", out);
}

/* Daily buyback/burn in USD. Bars not a line: the flow is discrete daily
   events, and a line would imply spend on days a programme did nothing. */
function burnHistoryChart(bb, coin, usd) {
  const h = bb.history || [];
  if (h.length < 3) {
    return bb.history_stats ? "" :
      `<div class="dnote">daily history is still building for ${esc(coin)}</div>`;
  }
  const W = 468, Hh = 76, pad = 2;
  const max = Math.max(...h.map((r) => r.usd)) || 1;
  const t0 = h[0].ms, t1 = h[h.length - 1].ms;
  const span = Math.max(1, t1 - t0);
  const bw = Math.max(1.2, W / h.length - 0.6);
  // 7-day trailing mean over the same axis, so deceleration is visible as a
  // slope rather than something you have to infer from two numbers.
  const ma = h.map((_, i) => {
    const from = h[i].ms - 7 * 86400000;
    const win = h.filter((r) => r.ms <= h[i].ms && r.ms >= from);
    return win.reduce((a, r) => a + r.usd, 0) / 7;
  });
  const X = (ms) => pad + ((ms - t0) / span) * (W - pad * 2);
  const Y = (v) => Hh - 12 - (v / max) * (Hh - 20);
  const bars = h.map((r) =>
    `<rect x="${(X(r.ms) - bw / 2).toFixed(1)}" y="${Y(r.usd).toFixed(1)}" ` +
    `width="${bw.toFixed(1)}" height="${Math.max(0.8, Hh - 12 - Y(r.usd)).toFixed(1)}" ` +
    `fill="#28d7d0" opacity="0.55"/>`).join("");
  const line = ma.map((v, i) =>
    `${i ? "L" : "M"}${X(h[i].ms).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const days = Math.round(span / 86400000) + 1;
  const lab = (ms) => new Date(ms).toISOString().slice(5, 10);
  const hm2 = bb.history_meta || {};
  const title = hm2.kind === "burned" ? "burned per event" : "bought per day";
  return `<div class="dz-row sub"><span class="dz-a">${title}</span>` +
    `<span class="dz-c">${days}d · peak $${fmtBig(max)} · ` +
    `<span style="color:#ffb84d">line = 7d mean/day</span></span></div>` +
    `<svg class="bh-chart" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none">` +
    `<line x1="${pad}" y1="${Hh - 12}" x2="${W - pad}" y2="${Hh - 12}" stroke="#15222a"/>` +
    bars +
    `<path d="${line}" fill="none" stroke="#ffb84d" stroke-width="1.4"/>` +
    `<text x="${pad}" y="${Hh - 2}" fill="#7c8f9c" font-size="8">${lab(t0)}</text>` +
    `<text x="${W - pad}" y="${Hh - 2}" fill="#7c8f9c" font-size="8" ` +
    `text-anchor="end">${lab(t1)}</text></svg>`;
}

function drawDossier(coin) {
  const { base, ctx, sig, card, ins, evs, news } = dossierSections(coin);
  const mid = state.mids[coin] != null ? state.mids[coin] : ctx.mid_px;
  const chg = pct(mid, ctx.prev_day_px);
  const f8h = ctx.funding != null ? ctx.funding * 8 * 100 : null;
  const box = (title, body) =>
    `<div class="dz"><div class="dz-h">${esc(title)}</div>${body}</div>`;
  const na = '<div class="dz-empty">none</div>';

  const head =
    `<div class="dh"><span class="dh-sym">${esc(base)}</span>` +
    `<span class="dh-coin">${esc(coin)}</span>` +
    `<span class="dh-px">${fmtPx(mid)}</span>` +
    `<span class="${chg == null ? "fl" : chg >= 0 ? "up" : "dn"}">${chg == null ? "–" : (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%"}</span>` +
    `<span class="spacer"></span>` +
    `<a class="dh-link" href="${hlTradeUrl(coin)}" target="_blank" rel="noopener">TRADE ↗</a>` +
    `<span class="dh-x" id="dz-close">✕</span></div>`;

  // WHALES ON THIS PAIR — same grammar as the scanner pane so the encoding
  // transfers: the same rail against the same board waterline at the top,
  // then the same L/S letter token per position. Dollars stay spelled in
  // FULL here — this column is 290px+ and is only open once the trader has
  // committed to one pair, so it is the right home for the precision the
  // 204px pane gave up. It must not inherit the pane's compression.
  const wc = (state.whaleCoin && state.whaleCoin.coin === coin) ? state.whaleCoin : null;
  const wagg = ((state.whales || {}).aggregates) || {};
  const wbL = wagg.total_long_ntl || 0, wbS = wagg.total_short_ntl || 0;
  const wbase = (wbL + wbS) > 0 ? wbL / (wbL + wbS) * 100 : null;
  const wrow = wc ? { long_ntl: wc.long_ntl, short_ntl: wc.short_ntl,
                      n_long: 0, n_short: 0 } : null;
  const wshare = wrow ? whShare(wrow) : null;
  /* THREE states, not two. `wc && wc.n_positions` is falsy for n_positions
     null AND for 0, so "this venue has never been queried" and "the sweep
     asked and nobody is there" both rendered as no section at all — the exact
     collapse the coverage field exists to prevent. A never-queried venue now
     says NOT COVERED in the drawer instead of looking like an empty market,
     and a partial sweep prints its lower-bound caveat under its numbers. */
  const wcov = (wc && wc.coverage) || {};
  const wNote = wcov.complete === false ? (wcov.why || "") : "";
  const wNoteHtml = wNote ? `<div class="dz-empty">${esc(wNote)}</div>` : "";
  const whaleBody = !wc ? ""
    : wc.n_positions == null
    ? `<div class="dz-empty" style="color:var(--amber2)"><b>NOT COVERED</b> — ` +
      `${esc(wcov.why || ("the whale sweep has not queried " +
        (wcov.venue || coin)))}</div>`
    : !wc.n_positions
    ? `<div class="dz-empty">the sweep queried ${esc(wcov.venue || coin)} and ` +
      `no tracked wallet holds a position in this pair</div>` + wNoteHtml
    : (
    (wshare != null && wbase != null
      ? `<div class="dz-wh-rail" style="--wl:${wbase.toFixed(2)}%">` +
        whRail(wrow, wbase, true) + whLeanTok(wshare) + `</div>`
      : "") +
    `<div class="dz-wh-sum">${wc.n_positions} tracked whales · ` +
    (wshare != null ? `${wshare.toFixed(0)}% long` +
      (wbase != null ? ` vs book ${wbase.toFixed(0)}%` : "") + ` · ` : "") +
    `$${fmtBig(wc.long_ntl)} long / $${fmtBig(wc.short_ntl)} short</div>` +
    (wc.positions || []).slice(0, 8).map((p) => {
      const held = p.seen_open_at
        ? "opened " + alertAgo(p.seen_open_at)
        : "held since before tracking" +
          (wc.tracking_since ? " (" + new Date(wc.tracking_since * 1000)
            .toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata",
              day: "2-digit", month: "short" }) + ")" : "");
      // Two same-vocabulary .up/.dn spans used to sit in this row — the
      // first meaning side, the second meaning PnL sign — with nothing
      // saying the two greens meant different things. Side is now the L/S
      // letter token, so the only coloured number left is unambiguously PnL.
      const long = p.side === "long";
      return `<div class="dz-wh-row">` +
        `<span class="wh-side ${long ? "l" : "s"}" title="${long ? "long" : "short"} position">` +
        `${long ? "L" : "S"}</span>` +
        `<b>$${fmtBig(p.ntl)}</b>` +
        `<span>@ ${fmtPx(p.entry_px)}${p.lev ? " · " + p.lev + "x" : ""}</span>` +
        `<span class="dz-wh-pnl ${p.upnl >= 0 ? "up" : "dn"}">pnl ${p.upnl >= 0 ? "+" : "-"}$${fmtBig(Math.abs(p.upnl))}</span>` +
        `<i>${esc(p.label || "")} · ${held}</i></div>`;
    }).join("") + wNoteHtml);
  const whaleBox = whaleBody ? box("WHALES ON THIS PAIR", whaleBody) : "";

  const xvBox = xvenueBox(coin, box);

  const market = box("MARKET", `<div class="dkv">` +
    `<span>funding/8h <b class="${fundingClass(f8h)}">${f8h == null ? "–" : f8h.toFixed(4) + "%"}</b></span>` +
    `<span>OI <b>${fmtUsd(oiUsd(ctx))}</b></span>` +
    `<span>vol 24h <b>${fmtUsd(ctx.day_volume)}</b></span>` +
    (sig ? `<span>trend <b>${esc(sig.trend || "–")}</b></span>` : "") +
    `</div>`);

  const score = sig ? box("SETUP SCORE", `<div class="dscore">` +
    `<span class="ds-num">${Math.round(sig.score)}</span>` +
    `<span class="ds-dir ${esc(sig.direction || "")}">${esc((sig.direction || "").toUpperCase())}</span>` +
    (sig.thin ? '<span class="sg-thin">THIN BOOK</span>' : "") +
    (sig.badges || []).map((b) => `<span class="badge ${b.tag.replace(/[^A-Z]/g, "")}" title="${esc(b.why)}">${esc(b.tag)}</span>`).join("") +
    `</div>` +
    `<div class="dbars">` + Object.entries(sig.factors).map(([k, v]) => {
      const w = (state.signals.weights || {})[k] || 20;
      return `<div class="dbar"><span class="db-k">${esc(FACTOR_LABEL[k] || k)}</span>` +
        `<span class="db-t"><span class="db-f" style="width:${Math.min(100, v / w * 100)}%"></span></span>` +
        `<span class="db-v">${v}</span></div>`;
    }).join("") + `</div>`) : "";

  // expected-move band edges as one-click alerts
  const evMove = evs.find((e) => e.expected_move_pct != null);
  const bandRow = (evMove && mid)
    ? `<div class="dz-row"><span class="dz-a">±move band</span>` +
      `<span class="dz-b">${fmtPx(mid * (1 - evMove.expected_move_pct / 100))}` +
      alarmBtn(coin, mid * (1 - evMove.expected_move_pct / 100), "band low") +
      ` … ${fmtPx(mid * (1 + evMove.expected_move_pct / 100))}` +
      alarmBtn(coin, mid * (1 + evMove.expected_move_pct / 100), "band high") +
      `</span><span class="dz-c">${esc(evMove.event_type)}</span></div>` : "";

  const catalyst = box("CATALYSTS", evs.length ? evs.map((e) =>
    `<div class="dz-row"><span class="dz-a">${esc(e.date)}</span>` +
    `<span class="dz-b">${esc(e.label)}</span>` +
    `<span class="dz-c">${e.expected_move_pct != null ? "±" + e.expected_move_pct.toFixed(2) + "%" : "—"}</span></div>`
  ).join("") + bandRow : na);

  const desk = box("RESEARCH DESK", card
    ? `<div class="dz-row"><span class="dz-a ${esc((card.direction || "none").toLowerCase())}">${esc((card.direction || "none").toUpperCase())}</span>` +
      `<span class="dz-b">${esc((card.state || "").replace(/_/g, " "))}</span>` +
      `<span class="dz-c">interest ${card.llm_interest_level || 0}/10</span></div>` +
      (card.entry_low != null
        ? `<div class="dlevels">entry <b>${esc(card.entry_low)}–${esc(card.entry_high)}</b>` +
          alarmBtn(coin, card.entry_low, "desk entry") + ` · ` +
          `stop <b class="dn">${esc(card.invalidation)}</b>` +
          alarmBtn(coin, card.invalidation, "desk stop") + ` · ` +
          `targets <b class="up">${esc((card.targets || []).join(" / "))}</b>` +
          (card.targets || []).map((t) => alarmBtn(coin, t, "desk target")).join("") +
          `</div>` : "") +
      `<div class="dthesis">${esc(card.thesis || "")}</div>` +
      (card.why_not ? `<div class="dcounter"><b>counter:</b> ${esc(card.why_not)}</div>` : "") +
      (Array.isArray(card.missing) && card.missing.length
        ? `<div class="dmissing">missing gate: ${card.missing.map(esc).join(", ")}</div>` : "") +
      `<div class="dnote">interest level is an uncalibrated LLM self-report</div>`
    : na);

  const insider = box("INSIDER BUYS · FORM 4", ins
    ? `<div class="dz-row"><span class="dz-a">${ins.n_insiders}× buyers</span>` +
      `<span class="dz-b">$${fmtBig(ins.total_buy_usd)}</span>` +
      `<span class="dz-c">last ${esc(ins.last_buy || "")}</span></div>` +
      (ins.buyers || []).map((b) =>
        `<div class="dz-row sub"><span class="dz-a">${esc(b.name)}</span>` +
        `<span class="dz-b">${esc(b.role || "")}</span>` +
        `<span class="dz-c">$${fmtBig(b.usd)} · ${esc(b.date)}</span></div>`).join("")
    : na);

  const bb = buybackFor(coin);
  const tokenomics = bb ? burnDossier(bb, coin, box) : "";

  // Same feed as the NEWS panel, so the same scheme allowlist — this is the
  // sibling site renderNews's fix would have missed.
  const newsBox = box("NEWS", news.length ? news.map((n) => {
    const nHref = safeHref(n.url);
    return `<div class="dz-row"><span class="dz-b">${nHref
      ? `<a href="${esc(nHref)}" target="_blank" rel="noopener">${esc(n.headline)}</a>`
      : esc(n.headline)}</span><span class="dz-c">${esc(n.category || "")}</span></div>`;
  }).join("") : na);

  const prior = document.querySelector("#dossier .dbody");
  const scroll = prior ? prior.scrollTop : 0;
  $("dossier").innerHTML =
    `<div class="dbox">${head}<div class="dbody">${score}${market}${xvBox}${whaleBox}${tokenomics}${catalyst}${desk}${insider}${newsBox}</div></div>`;
  const body = document.querySelector("#dossier .dbody");
  if (body) body.scrollTop = scroll;
  $("dz-close").onclick = closeDossier;
  document.querySelectorAll("#dossier .alarm").forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const ok = armAlert(b.dataset.coin, +b.dataset.level, b.dataset.note, true);
      showToast(ok ? `alert armed @ ${fmtPx(+b.dataset.level)}` : "could not arm alert");
      b.classList.toggle("on", ok);
    };
  });
}

function closeDossier() {
  $("dossier").dataset.mode = "";
  state.dossierCoin = null;
  clearInterval(state.dossierTimer);
  $("dossier").style.display = "none";
}

// Bound once, not per-open: rebinding on every open leaks listeners.
$("dossier").addEventListener("click", (e) => {
  if (e.target.id === "dossier") closeDossier();
});
/* ---------------- keyboard map ----------------
   Every shortcut is inert while the command line has focus, so typing a
   symbol never triggers an action. */
const PRESETS = ["default", "scan", "trade", "event"];

function setPreset(name) {
  state.preset = PRESETS.includes(name) ? name : "trade";
  $("grid").className = state.preset === "default" ? "" : "p-" + state.preset;
  localStorage.setItem("hlterm_preset", state.preset);
  showToast("desk layout: " + state.preset.toUpperCase());
  syncLayButtons();
  requestAnimationFrame(drawChart);
}

/* The desk presets now have a VISIBLE control, and this is the only thing that
   shows which one is active.

   Audited 2026-08-16: F1-F4 were the sole affordance for the four presets, and
   on macOS those keys are brightness / Mission Control / Spotlight unless the
   user has enabled "use F1, F2, etc. as standard function keys" — so on a
   default Mac they never reach the page. The palette was the only fallback and
   it did not answer the word "layout" (that word was a section HEADER, not a
   keyword on any row). Measured cost of that: the owner has been sitting on
   DEFAULT when TRADE is a materially bigger chart at the same window, one
   keystroke away, with nothing on screen naming it.

   RE-MEASURED 2026-08-16 rather than carried over, by replaying this file's
   own layout expressions (padR 56 / padT 10 / padB 22 / priceB = stackB +
   panes) at 1728x1000, under two layer sets:

     DEFAULT -> TRADE  plot width 638 -> 742 px                        +16.3%
                       area with sr+whale+volume  263,494 -> 380,646   +44.5%
                       area with every layer off  300,645 -> 424,281   +41.1%
     DEFAULT -> SCAN   213,521 px2                                     -19.0%
     DEFAULT -> EVENT  269,346 px2 — same width as TRADE, less height   +2.2%

   A figure inherited from an earlier pass claimed +52.1% for TRADE and +9.8%
   for EVENT. Neither reproduces here: +52.1% implies a priceH of 540 where
   this window measures 513 at an identical lgReserve of 46. Those numbers are
   NOT repeated on the glass. WIDTH is quoted to the reader as exact because it
   does not depend on the legend; AREA is always quoted with its layer set
   attached, because lgReserve is subtracted from the pane and the legend wraps
   differently at every width — an area figure with no layer set beside it is
   the kind of number that looks measured and is not reproducible.

   Same shape as syncIndButtons: the DOM class is the only on-screen display of
   state.preset, so it must be re-synced anywhere state.preset can change
   (setPreset covers the F-keys, the palette, the buttons and applyLayout). */
function syncLayButtons() {
  document.querySelectorAll("#laybtns button").forEach((b) =>
    b.classList.toggle("on", b.dataset.preset === state.preset));
}

const layEl = document.getElementById("laybtns");
if (layEl) layEl.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-preset]");
  if (b) setPreset(b.dataset.preset);
});

function moveScannerSelection(delta) {
  const sel = "tr.wr[data-coin], .sig-row[data-coin]";
  const rows = [...document.querySelectorAll(sel)];
  if (!rows.length) return;
  const cur = rows.findIndex((r) => r.dataset.coin === state.sel);
  // Off-list selection: enter from the end the user is moving toward.
  let i = cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : cur + delta;
  if (i < 0 || i >= rows.length) return;          // at the end: do nothing
  const coin = rows[i].dataset.coin;
  if (coin === state.sel) return;                 // no redundant re-subscribe
  selectCoin(coin);
  // selectCoin re-renders the list, so the old node is detached — re-query.
  const fresh = document.querySelector(`${sel.split(",")[0]}[data-coin="${CSS.escape(coin)}"], ` +
    `.sig-row[data-coin="${CSS.escape(coin)}"]`);
  if (fresh) fresh.scrollIntoView({ block: "nearest" });
}

const HELP_ROWS = [
  ["⌘K / >", "command palette (every function, searchable)"],
  ["/", "focus command line"],
  ["1–5", "the FIRST FIVE scanner tabs — alerts, port, screen, whales and "
        + "venues have no key, use ⌘K"],
  ["↑ ↓", "step through scanner"], ["R", "trade ruler (click entry, then stop)"],
  ["drag TARGET", "move the ruler target — R:R follows it"],
  ["Enter", "arm alerts from ruler levels"], ["E", "radar tradeable / all"],
  ["H", "liquidity heatmap"], ["C", "order flow / CVD"], ["F", "footprint / delta per bar"], [".", "refresh chart"],
  ["B", "right column: none / volume profile / resting book"],
  ["V", "volume overlay on the bottom of the price pane"],
  ["scroll / + −", "zoom chart"], ["drag / 0", "pan chart / reset view"],
  ["shift+scroll", "pan the chart sideways"],
  ["F1–F3", "desk layout: scan / trade / event — also the DEFAULT/SCAN/TRADE/"
          + "EVENT buttons in the chart header, which is where to click if "
          + "macOS eats the F-keys. TRADE is +16.3% plot width (638->742px) "
          + "and +44.5% plot area at a 1728x1000 window."],
  ["F4", "default desk layout"],
  ["D", "dossier for charted symbol"], ["W", "whale book (full per-coin table)"],
  ["Q", "quiet chart — every indicator layer off, q again to restore"],
  ["hover 350ms", "peek — whale tick / order / event answers in place"],
  ["right-click", "pin that peek open (max 3)"],
  ["X", "clear all pins"],
  ["⌘K → Layout", "save / restore a named desk — captures preset, symbol, "
                + "interval, tab and every chart layer, so a working setup "
                + "survives a reload (symbol and interval do not, on their own)"],
  ["?", "this help"], ["Esc", "close / clear"],
];

function toggleHelp() {
  const el = $("dossier");
  if (el.style.display === "flex" && el.dataset.mode === "help") { closeDossier(); return; }
  // Stop the symbol dossier's 3s redraw, or it repaints over the help panel.
  clearInterval(state.dossierTimer);
  state.dossierCoin = null;
  el.dataset.mode = "help";
  el.innerHTML = `<div class="dbox"><div class="dh"><span class="dh-sym">KEYS</span>` +
    `<span class="spacer"></span><span class="dh-x" id="dz-close">✕</span></div>` +
    `<div class="dbody"><div class="dz">` +
    HELP_ROWS.map(([k, v]) =>
      `<div class="dz-row"><span class="dz-a"><kbd>${esc(k)}</kbd></span>` +
      `<span class="dz-b">${esc(v)}</span></div>`).join("") +
    `</div></div></div>`;
  el.style.display = "flex";
  $("dz-close").onclick = closeDossier;
}

document.addEventListener("keydown", (e) => {
  const typing = e.target.id === "cmd" || e.target.tagName === "INPUT";
  // Checked ahead of the typing guard: ⌘K is expected to work from anywhere,
  // including mid-word in the symbol bar.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    PAL.open ? palClose() : palOpen();
    return;
  }
  /* The palette owns the keyboard while open — but only if the keyboard can
     still REACH it, and it could not.

     Audited 2026-08-16: Escape / ↑ / ↓ / ⏎ are bound to #pal-input alone, and
     this early return sits AHEAD of the document-level Escape branch. So the
     moment focus left that input the palette became a keyboard trap: every key
     but ⌘K dead, only a backdrop click to escape. The reproducer is the
     palette's own footer — a real click on the line reading "↑↓ move · ⏎ run ·
     esc close" moves focus to BODY, after which "esc close" is false. Verified:
     activeElement BODY, PAL.open true, Escape did nothing, ArrowDown did
     nothing. An instruction printed on the control that the control then
     ignores is a false claim, not just a gap.

     Two belts: keys aimed at the palette are re-aimed at it here when focus
     has wandered, and the mousedown handler below puts focus back. */
  if (PAL.open) {
    if (e.target !== $("pal-input") &&
        ["Escape", "Enter", "ArrowDown", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "Escape") { palClose(); return; }
      $("pal-input").focus();
      $("pal-input").dispatchEvent(new KeyboardEvent("keydown",
        { key: e.key, bubbles: true, cancelable: true }));
    }
    return;                        // every other key belongs to the palette
  }
  if (e.key === "Escape") {
    if (typing) { e.target.blur(); return; }
    if ($("dossier").style.display === "flex") closeDossier();
    // Newest pin first, THEN the ruler: one key walks back out of a stack of
    // disclosures in the order they were made without destroying the trade
    // plan underneath them.
    else if (pinPopNewest()) showToast("pin cleared");
    else clearRuler();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === "?") { e.preventDefault(); toggleHelp(); return; }
  // With an overlay open, only "?" and Escape (handled above) do anything —
  // otherwise arrows/tabs/R would silently rearrange the terminal behind it.
  if ($("dossier").style.display === "flex") return;
  if (e.key === "/") { e.preventDefault(); $("cmd").focus(); return; }
  if (e.key === ">") { e.preventDefault(); palOpen(); return; }
  if (e.key === "Enter") {
    /* ENTER BELONGS TO A FOCUSED CONTROL, NOT TO THE CHART.

       The typing guard above excludes #cmd and INPUT. A focused <button> is
       neither, so Enter fell straight through to rulerArmAlerts() — which
       writes standing, Telegram-firing alerts to hlterm_alerts with no
       confirmation. Every interval button, scanner tab, indicator button and
       event-radar tab leaves focus on itself after a click, and the ruler
       plan now SURVIVES A RELOAD by design, so the trigger is always loaded.
       Measured 2026-08-16: focus #ivls button[data-i="1h"], press Enter →
       state.alerts 0→3, toast "3 alerts armed". Same from a scanner tab.
       Worse, the browser ALSO fires click on the focused button, so one key
       did two unrelated things.

       Deliberately narrower than widening `typing`: single-letter shortcuts
       (h/c/f/v/b/q/d/w/x) are expected to work right after a button click,
       and folding BUTTON into `typing` would kill every one of them. Enter is
       the only key that is both a browser-level activation key for the
       focused control and a writer of standing state. */
    const t = e.target;
    if (t && t !== document.body && (t.tagName === "BUTTON" ||
        t.tagName === "A" || t.tagName === "SELECT" || t.isContentEditable)) {
      return;
    }
    // A key that silently does nothing is the same failure wearing a hat:
    // say what ENTER is for rather than swallowing the press.
    if (state.ruler.entry == null || !state.ruler.coin) {
      showToast("no ruler plan on this chart — click the price pane to set " +
        "ENTRY, click again for STOP, then ENTER arms alerts at those levels");
      return;
    }
    rulerArmAlerts();
    return;
  }
  if (e.key === "ArrowDown") { e.preventDefault(); moveScannerSelection(1); return; }
  if (e.key === "ArrowUp") { e.preventDefault(); moveScannerSelection(-1); return; }
  if (e.key >= "1" && e.key <= "5") {
    const tab = ["watch", "movers", "funding", "signals", "burn"][+e.key - 1];
    const btn = document.querySelector(`#wtabs button[data-t="${tab}"]`);
    if (btn) btn.click();
    return;
  }
  if (/^F[1-4]$/.test(e.key)) {
    e.preventDefault();
    setPreset(["scan", "trade", "event", "default"][+e.key.slice(1) - 1]);
    return;
  }
  switch (e.key.toLowerCase()) {
    case "r": toggleRuler(); break;
    case "e": {
      const cur = state.evfilter === "all" ? "tradeable" : "all";
      const b = document.querySelector(`#evtabs button[data-f="${cur}"]`);
      if (b) b.click();
      break;
    }
    case "h": {
      const b = document.querySelector('#indbtns button[data-ind="heat"]');
      if (b) b.click();
      break;
    }
    case "c": {
      const b = document.querySelector('#indbtns button[data-ind="cvd"]');
      if (b) b.click();
      break;
    }
    case "f": {
      const b = document.querySelector('#indbtns button[data-ind="fp"]');
      if (b) b.click();
      break;
    }
    // b = the RIGHT COLUMN's tenant. Verified free against this switch
    // (r/e/h/c/f/d/w/q/x, +/=, -/_, 0, .) and the guards above it (?, /, >,
    // Enter, arrows, 1-5, F1-F4, Escape, Cmd-K) before it was claimed.
    case "b": cycleRightCol(); break;
    // v = the volume/delta overlay. Same check. The strip it replaces had no
    // key at all, which is why it could never be turned off.
    case "v": {
      /* Delegates to the button, exactly as h/c/f do — it did NOT before,
         because there was no VOL button to delegate to. Now that there is,
         the direct-mutation path would set state.inds.vol and leave the
         button class stale: a lit button over an absent overlay, which is
         the button lying about the canvas. One path writes this state. */
      const b = document.querySelector('#indbtns button[data-ind="vol"]');
      if (b) b.click();
      // Inside QUIET the button handler has already toasted the fact that
      // matters more — that this toggle is a view and is not being saved.
      // Overwriting it with the cheerier line would hide it.
      if (!QUIET.stash) showToast(state.inds.vol
        ? "volume overlay on — bottom 18% of the price pane"
        : "volume overlay off");
      break;
    }
    case "d": if (state.sel) openDossier(state.sel); break;
    case "w": openWhaleBook(); break;
    // q = QUIET (see toggleQuiet). Verified free before claiming it: this
    // switch covers r/e/h/c/f/d/w, +/=, -/_, 0 and . , and the guards above
    // it cover ?, /, >, Enter, arrows, 1-5, F1-F4, Escape and Cmd-K. No
    // handler in this file reads "q".
    case "q": toggleQuiet(); break;
    // x = clear every pin. Verified free against this switch (r/e/h/c/f/d/w/q,
    // +/=, -/_, 0, .) and the guards above it (?, /, >, Enter, arrows, 1-5,
    // F1-F4, Escape, Cmd-K) at the time it was claimed.
    case "x": showToast(pinClearAll() ? "pins cleared" : "no pins to clear");
      break;
    case "+": case "=": chartZoom(0.8); break;
    case "-": case "_": chartZoom(1.25); break;
    case "0": chartResetView(); break;
    case ".": loadCandles(); showToast("chart refreshed"); break;
  }
});

/* ── LAYOUTS ─────────────────────────────────────────────────────────────
   F1-F4 already switch CSS presets, but a preset is only pane geometry —
   it forgets the instrument, timeframe, indicators and scanner tab, which
   is most of what a workflow actually is. A layout captures the whole desk
   so "equity open" or "burn research" is one keystroke, not six. */
const LAYOUT_KEY = "hlterm_layouts";
const LAYOUT_FIELDS = ["preset", "sel", "interval", "wtab", "evfilter"];

function loadLayouts() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}") || {}; }
  catch (e) { return {}; }
}

function saveLayouts(all) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(all)); }
  catch (e) { /* quota — non-fatal */ }
}

function captureLayout() {
  const l = { inds: { ...state.inds }, at: Date.now() };
  for (const k of LAYOUT_FIELDS) l[k] = state[k];
  // The watchlist is part of a workflow: an equity layout that restores a
  // crypto watchlist is not the desk you saved.
  l.watchCrypto = [...state.watchCrypto];
  l.watchEquity = [...state.watchEquity];
  return l;
}

function applyLayout(l) {
  if (!l) return;
  if (l.inds) {
    QUIET.stash = null;      // a restored layout replaces the stash wholesale
    state.inds = { ...state.inds, ...l.inds };
    syncIndButtons();
    localStorage.setItem("hlterm_inds", JSON.stringify(state.inds));
  }
  if (Array.isArray(l.watchCrypto)) state.watchCrypto = [...l.watchCrypto];
  if (Array.isArray(l.watchEquity)) state.watchEquity = [...l.watchEquity];
  if (l.watchCrypto || l.watchEquity) saveCustomWatch();
  if (l.evfilter) {
    state.evfilter = l.evfilter;
    const b = document.querySelector(`#evtabs button[data-f="${l.evfilter}"]`);
    if (b) {
      document.querySelectorAll("#evtabs button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
    }
    if (state.events) renderEvents(state.events);
  }
  if (l.wtab) {
    const b = document.querySelector(`#wtabs button[data-t="${l.wtab}"]`);
    if (b) b.click(); else { state.wtab = l.wtab; renderWatch(); }
  }
  if (l.interval && l.interval !== state.interval) {
    state.interval = l.interval;
    document.querySelectorAll("#ivls button").forEach((x) =>
      x.classList.toggle("on", x.dataset.i === l.interval));
  }
  if (l.preset) setPreset(l.preset);
  // Coin last: selectCoin re-subscribes and reloads candles, so it should
  // see the final interval rather than fetching twice.
  if (l.sel && l.sel !== state.sel) selectCoin(l.sel);
  else loadCandles();
}

/* ── COMMAND PALETTE ─────────────────────────────────────────────────────
   One searchable place for every function, showing the key binding beside
   each entry so it teaches the shortcuts instead of hiding them. The
   symbol bar keeps "/" — this is the verb surface, that one is the noun. */
const PAL = { open: false, sel: 0, rows: [], stage: null };

function palCommands() {
  const cmds = [];
  const add = (section, title, hint, run, keywords) =>
    cmds.push({ section, title, hint, run, kw: (keywords || "") + " " + title });

  // Each tab carries the words a user would actually type for it — "port"
  // must find Positions, "pnl" must find it too. Generic keywords made the
  // whole group indistinguishable.
  const tabs = [
    ["watch", "Watch", "1", "watchlist symbols prices"],
    ["movers", "Movers", "2", "gainers losers biggest moves"],
    ["funding", "Funding", "3", "crowded carry rate extremes"],
    ["signals", "Signals", "4", "setups score edge ranking"],
    ["burn", "Burn / buyback", "5", "supply programmes absorb"],
    ["whales", "Whales", "", "whale tracking leaderboard smart money "
      + "big wallets flow skew opened flipped positions"],
    ["alerts", "Alerts", "", "armed fired monitors telegram log"],
    ["port", "Positions & risk", "", "port portfolio pnl liquidation "
      + "exposure leverage margin wallet book"],
    // VENUES had NO palette entry and no key — the tab button and an
    // undocumented click on the VENUES strip were its only two doorways.
    ["venues", "Venues (cross-venue board)", "", "aggregator cross venue hip-3 "
      + "dex lighter aster extended xyz oi share market count additive"]];
  for (const [t, label, key, kw] of tabs)
    add("Go to", label, key, () => {
      const b = document.querySelector(`#wtabs button[data-t="${t}"]`);
      if (b) b.click();
    }, "tab panel scanner " + kw);

  add("Go to", "Whale book (full per-coin table)", "W", () => openWhaleBook(),
    "whales lean long short share net gross concentration wallets book table");

  for (const iv of ["1m", "5m", "15m", "30m", "1h", "4h", "1d"])
    add("Chart", "Interval " + iv.toUpperCase(), "", () => {
      const b = document.querySelector(`#ivls button[data-i="${iv}"]`);
      if (b) b.click();
    }, "timeframe candles");

  const inds = [["wh", "Whale overlay (entries + events)", ""],
                ["news", "News flags", "",
                 "headline flags material finnhub"],
                ["ema", "EMA", ""], ["boll", "Bollinger", ""], ["vwap", "VWAP", ""],
                ["sr", "Support / resistance", ""],
                ["vp", "Volume profile (right column)", "B",
                 "vprof volume by price poc point of control value area histogram"],
                ["book", "Resting book (right column, aggregated)", "B"],
                ["heat", "Liquidity heatmap", "H"], ["cvd", "CVD / order flow", "C"],
                ["fp", "Footprint (delta per bar)", "F"], ["rsi", "RSI", ""],
                ["macd", "MACD", ""],
                // EVENT had a button but no palette entry, and VOL had an
                // entry but no button. Both halves are now present for both.
                ["ev", "Event expected-move band", "",
                 "expected move earnings opex catalyst calendar"]];
  for (const [id, label, key, kw] of inds)
    add("Chart", "Toggle " + label, key, () => {
      const b = document.querySelector(`#indbtns button[data-ind="${id}"]`);
      if (b) b.click();
    }, "indicator study overlay " + (kw || ""));
  add("Chart", "Toggle DES note", "", () => {
    const b = $("des-chip"); if (b) b.click();
  }, "des description context cited note bloomberg");

  add("Chart", "Right column: none / volume profile / resting book", "B",
      () => cycleRightCol(), "gutter tenant vp book depth ladder width");
  // Through the button for the same reason the V key is: one write path, or
  // the button class goes stale against state.inds.vol.
  add("Chart", "Volume overlay (show / hide)", "V", () => {
    const b = document.querySelector('#indbtns button[data-ind="vol"]');
    if (b) b.click();
  }, "strip delta footprint bottom pane height volume bars per bar");
  add("Chart", "Refresh chart", ".", () => { loadCandles(); showToast("chart refreshed"); });
  add("Chart", "Quiet chart (every indicator layer off)", "Q", () => toggleQuiet(),
      "declutter bare clean hide overlays");
  add("Chart", "Trade ruler (entry then stop)", "R", () => toggleRuler(), "risk size bracket");
  if (state.sel)
    add("Chart", "Open dossier for " + baseSym(state.sel), "D",
        () => openDossier(state.sel), "detail info");

  /* "layout" was a SECTION HEADER and appeared in no row's title or keywords,
     so the palette — the only fallback for F-keys macOS eats — returned
     nothing useful for the one word a user would type. Measured before the
     fix: query "layout" matched only "Save current layout as…"; "f2" matched
     nothing. The words a person actually types when the chart is too small
     are here now, and the four presets also have visible buttons (#laybtns). */
  for (const p of PRESETS)
    add("Layout", "Desk preset: " + p, p === "default" ? "F4" :
        "F" + (PRESETS.indexOf(p)), () => setPreset(p),
        "layout desk pane geometry workspace arrangement resize "
        + "bigger chart more chart area larger price plot screen space "
        + (p === "default" ? "f4" : "f" + PRESETS.indexOf(p))
        + (p === "trade" ? " biggest chart maximise" : ""));

  const saved = loadLayouts();
  for (const name of Object.keys(saved).sort())
    add("Layout", "Restore: " + name, "", () => {
      applyLayout(saved[name]);
      showToast("layout: " + name);
    }, "workspace desk");
  add("Layout", "Save current layout as…", "", () => palPrompt(
    "layout name", (name) => {
      if (!name) return;
      const all = loadLayouts();
      all[name] = captureLayout();
      saveLayouts(all);
      showToast("saved layout: " + name);
    }), "workspace store desk");
  if (Object.keys(saved).length)
    add("Layout", "Delete a saved layout…", "", () => palPrompt(
      "layout to delete", (name) => {
        const all = loadLayouts();
        if (!all[name]) { showToast("no layout: " + name); return; }
        delete all[name];
        saveLayouts(all);
        showToast("deleted layout: " + name);
      }), "workspace remove");

  add("Go to", "Screener / carry / basis", "", () => {
    const b = document.querySelector('#wtabs button[data-t="screen"]');
    if (b) b.click();
  }, "screen scan filter eqs carry basis funding apr oi");
  for (const [k, p] of Object.entries((state.screen || {}).presets || {}))
    add("Screen", p.label.split(" — ")[0], "", () => {
      loadScreen({ preset: k, sort: null, filters: null });
      const b = document.querySelector('#wtabs button[data-t="screen"]');
      if (b) b.click();
    }, "screener " + k.replace(/-/g, " ") + " " + p.label);
  add("Go to", "Whale events feed", "", () => {
    const b = document.querySelector('#wtabs button[data-t="whales"]');
    if (b) b.click();
    setTimeout(() => {
      const h = document.getElementById("wh-feed");
      if (h) h.scrollIntoView({ block: "start" });
    }, 120);
  }, "whales opened closed flipped tape moves feed");
  add("Alerts", "Show armed alerts & fired log", "", () => {
    const b = document.querySelector('#wtabs button[data-t="alerts"]');
    if (b) b.click();
  }, "monitor telegram");
  add("Alerts", "Arm alerts from ruler levels", "⏎", () => rulerArmAlerts());

  add("Data", "Refresh buyback / burn programmes", "", () => {
    loadBuyback(0); showToast("reloading programmes…");
  }, "supply");
  add("Data", "Refresh signals", "", () => { loadSignals(); showToast("rescoring…"); });
  add("Data", "Toggle radar tradeable / all", "E", () => {
    const cur = state.evfilter === "all" ? "tradeable" : "all";
    const b = document.querySelector(`#evtabs button[data-f="${cur}"]`);
    if (b) b.click();
  }, "events calendar");
  add("Help", "Keyboard shortcuts", "?", () => toggleHelp());
  return cmds;
}

/* Subsequence fuzzy match: every query char must appear in order. Scores
   prefix and word-start hits higher so "sig" ranks "Signals" over
   "Refresh signals". */
function palSubseq(hay, q) {
  let i = 0, score = 0, prev = -1;
  for (const ch of q) {
    const idx = hay.indexOf(ch, i);
    if (idx < 0) return 0;
    score += idx === 0 ? 12 : (hay[idx - 1] === " " || hay[idx - 1] === ":") ? 8 : 1;
    if (prev >= 0 && idx === prev + 1) score += 4;      // contiguous run
    prev = idx;
    i = idx + 1;
  }
  return score;
}

/* Title match dominates keyword match, and a literal substring dominates a
   scattered subsequence. Without this, "cvd" scored "Interval 1D" above
   "Toggle CVD" — c/v/d all appear in "timeframe candles interval 1d", each
   at a word start. Subsequence alone is too generous to be a ranking. */
function palScore(cmd, q) {
  if (!q) return 1;
  const n = q.toLowerCase();
  const title = (cmd.title || "").toLowerCase();
  const kw = (cmd.kw || "").toLowerCase();
  // Word boundaries matter more than which field matched: "port" sits
  // mid-word inside "Support / resistance" but starts a word in the
  // Positions keywords, and the user means Positions. Ranking purely by
  // field put the accidental substring first.
  const atWordStart = (hay, idx) => idx === 0 || " /:-".includes(hay[idx - 1]);
  let best = 0;
  const ti = title.indexOf(n), ki = kw.indexOf(n);
  if (ti === 0) best = 400;                              // title prefix
  else if (ti > 0 && atWordStart(title, ti)) best = 300; // word start in title
  else if (ki >= 0 && atWordStart(kw, ki)) best = 280;   // word start in keywords
  else if (ti > 0) best = 200;                           // mid-word in title
  else if (ki >= 0) best = 100;                          // mid-word in keywords
  const sub = palSubseq(title, n) * 2 || palSubseq(kw, n);
  return Math.max(best, sub);
}

function palRender(q) {
  const list = $("pal-list");
  let rows;
  if (PAL.stage) {
    rows = [];
  } else {
    rows = palCommands()
      .map((c) => ({ c, s: palScore(c, q) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((r) => r.c);
    // A bare symbol is a noun, not a verb: offer the three things you can
    // do with it rather than making the user leave for the command bar.
    const coin = q && q.length >= 2 ? resolveCoin(q.toUpperCase()) : null;
    if (coin) {
      const symRows = [
        { section: "Symbol", title: "Chart " + baseSym(coin), hint: "⏎",
          run: () => selectCoin(coin) },
        { section: "Symbol", title: "Add " + baseSym(coin) + " to watchlist", hint: "",
          run: () => addWatch(coin) },
        { section: "Symbol", title: "Dossier for " + baseSym(coin), hint: "",
          run: () => openDossier(coin) }];
      // "lay" is a prefix of LAYER but the user almost certainly wants the
      // Layout commands. Symbols lead only on an exact ticker.
      if (baseSym(coin).toLowerCase() === q.toLowerCase()) rows.unshift(...symRows);
      else rows = rows.concat(symRows);
    }
  }
  PAL.rows = rows;
  if (PAL.sel >= rows.length) PAL.sel = Math.max(0, rows.length - 1);
  if (!rows.length) {
    list.innerHTML = '<div class="pal-empty">no matching command</div>';
    return;
  }
  let last = null;
  list.innerHTML = rows.map((c, i) => {
    const head = c.section !== last
      ? `<div class="pal-sec">${esc(c.section)}</div>` : "";
    last = c.section;
    return head +
      `<div class="pal-row${i === PAL.sel ? " on" : ""}" data-i="${i}">` +
      `<span class="pal-t">${esc(c.title)}</span>` +
      (c.hint ? `<span class="pal-k">${esc(c.hint)}</span>` : "") + `</div>`;
  }).join("");
  const sel = list.querySelector(".pal-row.on");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function palPrompt(label, done) {
  PAL.stage = { label, done };
  const inp = $("pal-input");
  inp.value = "";
  inp.placeholder = label + "…";
  $("pal-list").innerHTML = `<div class="pal-empty">${esc(label)} — type a name, ⏎ to confirm</div>`;
  palOpen(true);
  inp.focus();
}

function palOpen(keep) {
  PAL.open = true;
  if (!keep) { PAL.stage = null; PAL.sel = 0; $("pal-input").value = ""; }
  $("palette").style.display = "flex";
  const inp = $("pal-input");
  if (!keep) inp.placeholder = "type a command, or a symbol…";
  inp.focus();
  inp.select();
  if (!keep) palRender("");
}

function palClose() {
  PAL.open = false;
  PAL.stage = null;
  $("palette").style.display = "none";
  $("pal-input").blur();
}

function palRun(i) {
  const c = PAL.rows[i];
  if (!c) return;
  palClose();
  try { c.run(); } catch (e) { showToast("command failed"); }
}

$("pal-input").addEventListener("input", (e) => {
  if (PAL.stage) return;                 // free-text stage: no filtering
  PAL.sel = 0;
  palRender(e.target.value.trim());
});

$("pal-input").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); palClose(); return; }
  if (e.key === "Enter") {
    e.preventDefault();
    if (PAL.stage) {
      const { done } = PAL.stage;
      const v = $("pal-input").value.trim();
      palClose();
      done(v);
      return;
    }
    palRun(PAL.sel);
    return;
  }
  if (PAL.stage) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    PAL.sel = Math.min(PAL.rows.length - 1, PAL.sel + 1);
    palRender($("pal-input").value.trim());
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    PAL.sel = Math.max(0, PAL.sel - 1);
    palRender($("pal-input").value.trim());
  }
});

$("pal-list").addEventListener("click", (e) => {
  const r = e.target.closest(".pal-row");
  if (r) palRun(+r.dataset.i);
});

$("palette").addEventListener("mousedown", (e) => {
  if (e.target.id === "palette") { palClose(); return; }  // backdrop dismisses
  /* Anything else inside the box keeps the keyboard. The footer and the list's
     padding are not focusable, so a real click on them moved focus to BODY and
     stranded the palette (see the PAL.open branch in the document handler).
     preventDefault keeps the input's caret and selection where they were. */
  if (e.target !== $("pal-input")) {
    e.preventDefault();
    $("pal-input").focus();
  }
});

/* ---------------- market regime strip ---------------- */
function istDate(offsetDays) {
  return new Date(Date.now() + (offsetDays || 0) * 86400000)
    .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function daysUntil(dstr) {
  if (!dstr) return null;
  const d = new Date(String(dstr) + "T00:00:00Z");
  const t = new Date(etDate() + "T00:00:00Z");
  if (isNaN(d) || isNaN(t)) return null;
  return Math.round((d.getTime() - t.getTime()) / 86400000);
}

/* traffic-light states: "g" supportive, "a" caution, "r" adverse, null info-only */
function regimeVerdict(counts) {
  if (counts.g - counts.r >= 2) return { word: "RISK-ON", cls: "st-g" };
  if (counts.r - counts.g >= 2) return { word: "RISK-OFF", cls: "st-r" };
  return { word: "MIXED", cls: "st-a" };
}

async function loadRegime() {
  try {
    const d = await fetch("/api/regime").then((r) => r.json());
    // A failed rebuild arrives as HTTP 200 + {error}. Every field below is
    // then undefined, so no chip gets pushed and the strip fell through to
    // its bare "unavailable" — which WIPED a good regime read and named
    // neither the failure nor whose it was. Routed to the catch, the last
    // good strip stands (it was real when it was read) and the retry runs.
    if (d && d.error) throw new Error(d.error);
    const chips = [];
    const counts = { g: 0, a: 0, r: 0 };
    const push = (state, html) => {
      if (state) counts[state] += 1;
      chips.push(html.replace('class="rchip"',
        'class="rchip' + (state ? " st-" + state : "") + '"'));
    };
    const fg = d.fear_greed;
    if (fg) {
      const cls = fg.value < 40 ? "rg-fear" : fg.value > 60 ? "rg-greed" : "rg-neutral";
      const dir = fg.prev != null ? (fg.value > fg.prev ? "↑" : fg.value < fg.prev ? "↓" : "→") : "";
      const fgSt = fg.value >= 40 && fg.value <= 60 ? "g" :
                   fg.value < 25 || fg.value > 75 ? "r" : "a";
      push(fgSt, `<span class="rchip"><span class="rl">F&amp;G</span>` +
        `<b class="${cls}">${fg.value} ${esc(fg.label.toUpperCase())}</b>${dir}</span>`);
    }
    const g = d.global;
    if (g && g.total_mcap_usd) {
      const chg = g.mcap_chg_24h_pct;
      const mcSt = chg == null ? null : chg > 1 ? "g" : chg < -1 ? "r" : "a";
      push(mcSt, `<span class="rchip"><span class="rl">MCAP</span><b>$${fmtBig(g.total_mcap_usd)}</b>` +
        (chg != null ? `<span class="${chg >= 0 ? "up" : "dn"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span>` : "") +
        `</span>`);
      if (g.btc_dominance_pct != null)
        push(null, `<span class="rchip"><span class="rl">BTC.D</span><b>${g.btc_dominance_pct.toFixed(1)}%</b></span>`);
    }
    const s = d.stables;
    if (s) {
      const stSt = s.delta_7d_pct >= 0.05 ? "g" : s.delta_7d_pct <= -0.05 ? "r" : "a";
      push(stSt, `<span class="rchip"><span class="rl">STABLES</span><b>$${fmtBig(s.total_usd)}</b>` +
        `<span class="${s.delta_7d_usd >= 0 ? "up" : "dn"}">${s.delta_7d_usd >= 0 ? "+" : "−"}$${fmtBig(Math.abs(s.delta_7d_usd))} 7D</span></span>`);
    }
    const fed = d.fed;
    if (fed && fed.effr && fed.effr.rate != null) {
      push(null, `<span class="rchip" title="NY Fed effective fed funds rate (${esc(fed.effr.date || "")}) · target ${fed.effr.target_from}–${fed.effr.target_to}%">` +
        `<span class="rl">EFFR</span><b>${fed.effr.rate.toFixed(2)}%</b></span>`);
      const moveName = (bp) => bp === 0 ? "HOLD" :
        (bp > 0 ? "HIKE" : "CUT") + Math.abs(bp);
      const fomc = d.fomc;
      if (fomc && fomc.meetings && fomc.meetings.length) {
        const m = fomc.meetings[0];
        const top = m.outcomes.slice().sort((a, b) => b.prob - a.prob);
        const lbl = top.map((o) =>
          `${Math.round(o.prob * 100)}% ${moveName(o.move_bp)}`).join(" / ");
        const tip = "ZQ fed-funds-futures implied (FedWatch math; expectation-chained)\n" +
          fomc.meetings.map((mm) =>
            `${mm.meeting}: ` + mm.outcomes.slice().sort((a, b) => b.prob - a.prob)
              .map((o) => `${Math.round(o.prob * 100)}% ${moveName(o.move_bp)}`).join(" / ") +
            `  (→ ${mm.implied_rate_after}%)`).join("\n");
        const dtm = daysUntil(m.meeting);
        const fomcSt = dtm == null ? null : dtm <= 1 ? "r" : dtm <= 7 ? "a" : "g";
        push(fomcSt, `<span class="rchip" title="${esc(tip)}">` +
          `<span class="rl">FOMC ${esc(m.meeting.slice(5).replace("-", "/"))}</span>` +
          `<b class="${m.expected_move_bp > 6 ? "dn" : m.expected_move_bp < -6 ? "up" : "rg-neutral"}">${esc(lbl)}</b></span>`);
      } else if (fed.implied && fed.implied["3m_spread_bp"] != null) {
        // fallback when futures quotes are unavailable: bill-implied path
        const bp = fed.implied["3m_spread_bp"], mv = fed.implied["3m_moves_priced"];
        const dir = bp > 6 ? "HIKE" : bp < -6 ? "CUT" : "HOLD";
        const cls = bp > 6 ? "dn" : bp < -6 ? "up" : "rg-neutral";
        chips.push(`<span class="rchip" title="3M T-bill minus EFFR — policy moves priced over next quarter (bill-implied approximation, not meeting odds)">` +
          `<span class="rl">FED PATH</span><b class="${cls}">${dir}</b>` +
          `<span class="rl">${bp > 0 ? "+" : ""}${bp}bp 3M ≈ ${Math.abs(mv)} move${Math.abs(mv) === 1 ? "" : "s"}</span></span>`);
      }
      const sp = fed.implied;
      if (sp && sp.s2s10_bp != null)
        push(null, `<span class="rchip" title="10Y minus 2Y treasury spread"><span class="rl">2s10s</span>` +
          `<b class="${sp.s2s10_bp >= 0 ? "up" : "dn"}">${sp.s2s10_bp >= 0 ? "+" : ""}${sp.s2s10_bp}bp</b></span>`);
    }
    const etf = d.etf;
    const etfChip = (label, e) => {
      if (!e || e.last_flow_usd == null) return;
      const f = e.last_flow_usd, pos = f >= 0;
      const tip = `${label} spot ETF daily net flows (SoSoValue)\n` +
        e.recent.map((r) => `${r.date}: ${r.flow_usd >= 0 ? "+" : "−"}$${fmtBig(Math.abs(r.flow_usd))}`).join("\n") +
        `\n5d sum: ${e.sum5_usd >= 0 ? "+" : "−"}$${fmtBig(Math.abs(e.sum5_usd))}` +
        `\nstreak: ${Math.abs(e.streak_days)}d ${e.streak_days >= 0 ? "inflow" : "outflow"}` +
        `\nAUM: $${fmtBig(e.aum_usd)}`;
      const eSt = e.streak_days >= 2 ? "g" : e.streak_days <= -2 ? "r" : "a";
      push(eSt, `<span class="rchip" title="${esc(tip)}"><span class="rl">${label} ETF</span>` +
        `<b class="${pos ? "up" : "dn"}">${pos ? "+" : "−"}$${fmtBig(Math.abs(f))}</b>` +
        `<span class="rl">${e.streak_days ? Math.abs(e.streak_days) + "d " + (e.streak_days > 0 ? "in" : "out") : ""}</span></span>`);
    };
    if (etf) { etfChip("BTC", etf.btc); etfChip("ETH", etf.eth); }
    const h = d.hl;
    if (h && h.breadth_pct != null) {
      const brSt = h.breadth_pct > 60 ? "g" : h.breadth_pct < 40 ? "r" : "a";
      push(brSt, `<span class="rchip"><span class="rl">BREADTH</span>` +
        `<b class="${h.breadth_pct >= 50 ? "up" : "dn"}">${h.breadth_pct}%</b>` +
        `<span class="rl">${h.advancers}↑ ${h.decliners}↓</span></span>`);
      push(null, `<span class="rchip"><span class="rl">HL OI</span><b>$${fmtBig(h.agg_oi_usd)}</b>` +
        `<span class="rl">VOL $${fmtBig(h.agg_vol_usd)}</span></span>`);
      if (h.median_funding_8h_pct != null) {
        const dev = Math.abs(h.median_funding_8h_pct - 0.01);  // vs structural baseline
        const mfSt = dev <= 0.01 ? "g" : dev <= 0.03 ? "a" : "r";
        push(mfSt, `<span class="rchip"><span class="rl">MED FUND</span>` +
          `<b class="${fundingClass(h.median_funding_8h_pct)}">${h.median_funding_8h_pct}%</b></span>`);
      }
    }
    const v = regimeVerdict(counts);
    const verdictChip =
      `<span class="rchip regime-word ${v.cls}" title="majority vote of ` +
      `${counts.g + counts.a + counts.r} stateful chips — ` +
      `${counts.g} supportive / ${counts.a} caution / ${counts.r} adverse">` +
      `<b>${v.word}</b></span>`;
    $("regime-chips").innerHTML = chips.length
      ? verdictChip + '<span class="sep">·</span>' +
        chips.join('<span class="sep">·</span>')
      : '<span class="rchip dim">unavailable</span>';
  } catch (e) {
    // 5 minutes is a long time to show a stale strip after a blip.
    // The chips that are already up stay up — they were measured, and a
    // regime read does not stop being true because the next one failed. But
    // if there has never been a good read there is nothing to keep, and
    // "loading…" sitting there forever is the same lie as a blank: it says
    // an answer is coming. Only that case is overwritten.
    const rel = $("regime-chips");
    if (rel && !rel.querySelector(".rchip:not(.dim)"))
      rel.innerHTML = '<span class="rchip dim" title="' +
        esc((e && e.message) || String(e)) +
        '">regime NOT READ — retrying</span>';
    setTimeout(loadRegime, 20000);
  }
}

/* ---------------- price alerts ---------------- */
function loadAlerts() {
  try { state.alerts = JSON.parse(localStorage.getItem("hlterm_alerts") || "[]"); }
  catch (e) { state.alerts = []; }
  renderAlerts();
}
function saveAlerts() {
  localStorage.setItem("hlterm_alerts", JSON.stringify(state.alerts));
}

function renderAlerts() {
  const bar = $("alertbar");
  if (!state.alerts.length) { bar.style.display = "none"; return; }
  bar.style.display = "flex";
  $("alert-chips").innerHTML = state.alerts.map((a) =>
    `<span class="achip ${a.fired ? "fired" : ""}" data-id="${a.id}">` +
    `<span class="ac-sym">${esc(baseSym(a.coin))}</span>` +
    `<span>${a.op} ${fmtPx(a.level)}</span>` +
    (a.fired ? `<span>@ ${fmtPx(a.firedAt)}</span>` : "") +
    `<span class="ac-x" title="dismiss">✕</span></span>`).join("");
  document.querySelectorAll(".achip .ac-x").forEach((x) => {
    x.onclick = () => {
      const id = +x.parentElement.dataset.id;
      state.alerts = state.alerts.filter((a) => a.id !== id);
      saveAlerts(); renderAlerts();
    };
  });
}

function beep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.frequency.value = 880; g.gain.value = 0.08;
    o.start();
    o.frequency.setValueAtTime(1320, ac.currentTime + 0.12);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.5);
    o.stop(ac.currentTime + 0.5);
  } catch (e) { /* no audio */ }
}

function fireAlert(a, px) {
  a.fired = true; a.firedAt = px;
  saveAlerts(); renderAlerts(); beep();
  const msg = `${baseSym(a.coin)} crossed ${a.op === ">" ? "above" : "below"} ` +
              `${fmtPx(a.level)} — now ${fmtPx(px)}`;
  if (window.Notification && Notification.permission === "granted")
    new Notification("TERMINAL V ALERT", { body: msg });
  // Ledger first, network second: the crossing is a fact the moment it
  // happens, and it has to survive both a refused send and the whale flood
  // that evicts it from the server log within hours.
  notifyAndSettle("🔔 " + msg, recordMyFire("price", "🔔 " + msg));
}

function checkAlerts(mids) {
  let dirty = false;
  for (const a of state.alerts) {
    if (a.fired) continue;
    const raw = mids[a.coin];
    if (raw == null) continue;
    const px = +raw;
    if ((a.op === ">" && px >= a.level) || (a.op === "<" && px <= a.level)) {
      fireAlert(a, px); dirty = true;
    }
  }
  if (dirty) saveAlerts();
}

/* Arm an alert at an explicit level. Direction is inferred from where price
   is now, so "notify me when it reaches X" always does the obvious thing. */
function armAlert(coin, level, note, dedupeByNote) {
  if (!coin || !isFinite(level)) return false;
  const cur = state.mids[coin] != null ? +state.mids[coin]
    : (ctxFor(coin) || {}).mid_px;
  if (cur == null) return false;
  const op = level > cur ? ">" : "<";
  const dup = state.alerts.some((a) => !a.fired && a.coin === coin && (
    (a.op === op && Math.abs(a.level - level) < level * 1e-6) ||
    // template levels ride the live mid, so those match on intent; wall
    // alerts are fixed prices and must NOT collide on a rounded $ label
    (dedupeByNote && note && a.note === note)));
  if (dup) return true;
  if (window.Notification && Notification.permission === "default")
    Notification.requestPermission();
  state.alerts.push({ id: Date.now() + Math.random(), coin, op, level,
                      fired: false, note: note || "" });
  saveAlerts(); renderAlerts();
  return true;
}

function tryCreateAlert(q) {
  const m = q.match(/^([A-Z0-9:]+)\s*([<>])\s*([0-9][0-9,._]*\.?[0-9]*)$/);
  if (!m) return false;
  const coin = resolveCoin(m[1]);
  const level = parseFloat(m[3].replace(/[,_]/g, ""));
  if (!coin || !isFinite(level) || level <= 0) return "bad";
  const cur = state.mids[coin] != null ? +state.mids[coin]
    : (ctxFor(coin) && ctxFor(coin).mid_px);
  if (cur != null &&
      ((m[2] === ">" && cur >= level) || (m[2] === "<" && cur <= level)))
    return "already";   // price is already beyond the level — nothing to cross
  if (window.Notification && Notification.permission === "default")
    Notification.requestPermission();
  state.alerts.push({ id: Date.now(), coin, op: m[2], level, fired: false });
  saveAlerts(); renderAlerts();
  return true;
}

/* ---------------- indicators ---------------- */

/* The button row is the only on-screen display of state.inds, and it was
   being re-derived at three separate call sites. One function, so a fourth
   path that changes the layers cannot forget to update the buttons. */
/* WHAT IS WAITING BEHIND A LAYER THAT IS OFF.

   The defect class this pass exists to close has TWO halves and only the
   first was ever fixed. Half one: a working layer with no control at all —
   the volume profile, then VOL, and both now have a button and a palette
   entry. Half two, still open until here: a button tells you a layer EXISTS
   and says nothing about whether there is anything behind it. CVD sat off
   over 139 hours of collected tape and HEAT sits over 122 hours of recorded
   book, and neither button said so; conversely HEAT on a market the depth
   collector never took is a permanently lit dead control, and you only find
   that out AFTER you spend the click and read the empty pane.

   So the two data-backed layers carry a coverage badge, and it costs no
   canvas: both numbers are already in memory from polls this client makes
   anyway. CVD reads state.flowHist (loaded with the chart), HEAT reads
   state.depth from the 20s universe poll — the same map the watchlist's SIDE
   cell already keys on, where a missing coin means NOT COLLECTED and
   stale:true means dropped. No new request is made for either.

   `dead` is the honest half and is why this is not decoration: NONE and OLD
   are refusals, printed in the alarm hue, and they say the pane would be
   empty BEFORE the click rather than after it. A layer whose badge is absent
   is one whose coverage this client genuinely does not know — which is not
   the same as zero, and is why nothing is printed in that case. */
/* IS THE TAPE BEHIND THIS PANE STILL RUNNING?

   Every CVD mark on this canvas is drawn from the flow collector's websocket.
   When that socket wedges, the series simply stops growing — the line goes
   flat, the caption keeps saying "server tape · N samples", and NOTHING on
   the canvas distinguishes "nobody is buying" from "nobody is listening".
   Those are opposite facts and the pane rendered them identically.

   The server measures this precisely and ships it on the coin-scoped route:
   `wedged` plus a written `wedge_note`, `last_msg_age_s` against the
   collector's own `stale_after_s` threshold, and `ws_stale`. Returns null
   when the health block did not travel — an unread socket is UNKNOWN, and
   this must never manufacture an all-clear out of a missing field.

   The age is the server's plus this client's hold, the same arithmetic
   fxAgeS()/sdAgeFrom() use: the shipped number alone always understates the
   age of what the eye is actually looking at. */
function flowTapeHealth() {
  const fh = state.flowHist;
  if (!fh || fh.coin !== state.sel) return null;
  const st = fh.status;
  if (!st) return null;
  const held = fh.heldAt ? Math.max(0, (Date.now() - fh.heldAt) / 1000) : 0;
  const age = st.last_msg_age_s != null ? st.last_msg_age_s + held : null;
  const lim = st.stale_after_s || 300;
  const ago = (s) => s == null ? "?"
    : s < 90 ? Math.round(s) + "s"
    : s < 5400 ? Math.round(s / 60) + "m"
    : (s / 3600).toFixed(1) + "h";
  if (st.wedged === true)
    return { bad: true, txt: "TAPE WEDGED " + ago(age),
             why: st.wedge_note || ("the trade-tape websocket is wedged — no " +
               "frame in " + ago(age) + ". The CVD line below is NOT " +
               "advancing, and a flat line here is the collector, not the " +
               "market.") };
  /* THE ALARM MUST COME FROM THE SERVER'S SILENCE, NOT FROM OUR OWN.

     `age` is the server's last_msg_age_s PLUS how long this page has held the
     payload, and the client refetches /api/flow far less often than the 300s
     threshold — so `held` alone would push a perfectly live tape past `lim`
     and paint a red alarm out of a polling gap. Observed live and twice
     spontaneously: the chip read "TAPE SILENT 6m" while the SAME payload's
     wedge_note, quoted in its own tooltip, said "socket is ALIVE (last frame
     0.2s ago); 58 of 60 coins printed within 60s". A chip that contradicts
     its own tooltip is worse than no chip.

     So the alarm is gated on the SERVER's own measurement. When our copy is
     what has gone stale we say exactly that instead — a stale reading is NOT
     a silent tape, it is an unknown one, and this file's whole standard is
     that those two must never share a face. */
  const srvAge = st.last_msg_age_s;
  if (srvAge != null && srvAge > lim)
    return { bad: true, txt: "TAPE SILENT " + ago(srvAge),
             why: "the collector reports no frame from the trade-tape " +
               "websocket in " + ago(srvAge) + ", past its own " + ago(lim) +
               " staleness threshold. Whatever the line below does from here " +
               "is the socket, not the tape." +
               (st.wedge_note ? " Collector says: " + st.wedge_note : "") };
  if (held > lim)
    return { bad: false, stale: true, txt: "tape reading " + ago(held) + " old",
             why: "the collector was healthy when this page last asked (" +
               ago(srvAge) + " since its last frame, " + ago(held) + " ago), " +
               "but we have not re-asked since. This is OUR reading going " +
               "stale, NOT the tape going quiet — the two are different facts " +
               "and this chip will not dress one as the other." };
  if (st.ws_stale)
    return { bad: true, txt: "TAPE STALE",
             why: st.wedge_note || "the collector reports its websocket as " +
               "stale — the series behind this pane may not be advancing" };
  return { bad: false, txt: "tape live " + ago(age),
           why: (st.wedge_note || "socket alive") +
             " · last frame " + ago(age) + " ago (server age plus this " +
             "page's hold), against a " + ago(lim) + " staleness threshold" +
             (st.subs_live != null && st.subscribed != null
               ? " · " + st.subs_live + " of " + st.subscribed +
                 " subscribed coins printed inside the last bucket" : "") };
}

function indCoverage(id) {
  if (id === "cvd") {
    const fh = state.flowHist;
    // A badge carrying another coin's coverage is worse than no badge. This
    // is the gap between a coin switch and the fetch that answers it.
    if (!fh || fh.coin !== state.sel) return null;
    if (fh.err) return { txt: "ERR", dead: true,
      why: "the last tape request for " + state.sel + " FAILED (" + fh.err +
           ") — the coverage behind this button is UNKNOWN, not zero" };
    if (fh.subscribed === false) return { txt: "NONE", dead: true,
      why: fh.why || (state.sel + " is not in the trade-tape collector, so " +
           "turning this on draws an empty pane — and that blank is NOT a " +
           "quiet market, it is a tape nobody is recording") };
    /* A WEDGED TAPE OUTRANKS A COVERAGE COUNT. "299h" over a socket that
       stopped an hour ago is a true statement about the store and a false
       impression about the pane: it says there is plenty behind this button
       without saying that none of it is still arriving. */
    const th = flowTapeHealth();
    if (th && th.bad) return { txt: "STOP", dead: true, why: th.why };
    const ser = fh.series || [];
    if (ser.length < 2) return null;
    const h = (ser[ser.length - 1].ms - ser[0].ms) / 3600000;
    /* A LOWER BOUND, and it is labelled as one. loadFlowHist asks for exactly
       the chart's own window (bucket x candle count), so this span is bounded
       by the REQUEST, not by the store — the collector keeps minute buckets
       for 48h and hourly for 90 days behind it. "At least" is the only
       version of this sentence that is true at every interval. */
    return { dead: false,
      txt: h >= 1 ? Math.round(h) + "h" : Math.max(1, Math.round(h * 60)) + "m",
      why: "at least " + (h >= 1 ? h.toFixed(1) + "h" : Math.round(h * 60) + " min") +
           " of tape for " + state.sel + " (" + ser.length + " samples at " +
           (fh.bucket_s ? fh.bucket_s + "s" : "the collector's own width") +
           ") is already collected and waiting behind this button. It is a " +
           "lower bound: the chart asks for its own window, and the collector " +
           "holds minute buckets for 48h and hourly buckets for 90 days behind " +
           "whatever was asked for." };
  }
  if (id === "heat") {
    const d = (state.depth || {})[state.sel];
    const ds = state.depthSlots;
    if (!d) return { txt: "NONE", dead: true,
      why: state.sel + " is NOT in the depth collector" +
           (ds && ds.slots_pressure
             ? " (" + ds.subscribed + " of " + ds.max_coins + " slots in use " +
               "and the set is ADD-ONLY until the server restarts)"
             : "") +
           " — turning this on draws an empty gutter, and no past hour can " +
           "ever be backfilled." };
    if (d.stale) return { txt: "OLD", dead: true,
      why: state.sel + " was dropped from the depth collector: " +
           (d.h != null ? d.h.toFixed(1) + "h" : "some") + " of history " +
           "exists but the newest sample is stale, so this gutter would be " +
           "history that has ENDED, not a live book." };
    if (!(d.h > 0)) return null;
    return { dead: false, txt: Math.round(d.h) + "h",
      why: d.h.toFixed(1) + "h of resting-book depth for " + state.sel +
           " is already recorded and waiting behind this button." };
  }
  return null;
}

function syncIndButtons() {
  document.querySelectorAll("#indbtns button").forEach((b) => {
    b.classList.toggle("on", !!state.inds[b.dataset.ind]);
    /* The LABEL, captured once, because the badge lives inside the button and
       b.textContent is read elsewhere as the layer's name (the QUIET toast).
       Appending to the button without this would have made that toast read
       "CVD 139h on". */
    if (!b.dataset.label) b.dataset.label = b.textContent.trim();
    const cov = indCoverage(b.dataset.ind);
    let bg = b.querySelector(".indbg");
    if (!cov) { if (bg) bg.remove(); return; }
    if (!bg) { bg = document.createElement("i"); b.appendChild(bg); }
    bg.className = "indbg" + (cov.dead ? " dead" : "");
    if (bg.textContent !== cov.txt) bg.textContent = cov.txt;
    // Its OWN title, not the button's: the button's tooltip is the layer's
    // description and must not be clobbered by its coverage.
    bg.title = cov.why;
  });
}

/* QUIET (q) — one key that gives the price back its pane.

   MEASURED at the owner's own 1728x1000 layout with three FORCED drawChart()
   calls (rAF does not fire in a hidden pane, so a frame has to be forced or
   the canvas sits at its 300x150 default and reports nothing):

     all 13 indicator layers on    price pane 450.8 x 180.4 = 23.3% of canvas
     the code default (wh + book)  price pane 554   x 332.8 = 52.8%
     every layer off               price pane 655   x 353   = 66.2%

   Quiet is worth 2.84x the price-pane area. Independently measured on the
   same frames: mark density triples (19.4 -> 64.6 marks per 10k px^2) and
   label-lane REJECTION rises 15.6% -> 22.9% — in the crowded state nearly a
   quarter of the labels the chart asks for are silently not drawn, so the
   reader is missing information he believes he is looking at. That, not
   frame time, is the cost of the loud chart: drawChart is 1.0-1.3 ms median
   with all 13 layers on against a 16.7 ms budget. Every argument here is a
   legibility argument and none of them is a performance argument.

   This is a VIEW toggle, not a preference: it stashes the current selection,
   does NOT write hlterm_inds, and restores it on the second press. Touching
   an indicator button while quiet drops the stash rather than having the
   click undone by the next q — see the #indbtns handler. */
const QUIET = { stash: null };

/* THE RIGHT COLUMN's tenant, on one key.

   The column is 84px and it can host exactly one instrument, so the two
   buttons that fill it (VP, BOOK) are one choice with three states and this
   is the keyboard form of that choice: none -> volume profile -> resting
   book -> none. "none" is a first-class state and the default, which is the
   whole point — measured at this desk, reserving nothing gives the price
   plot 638px instead of 554px, and the layer that was spending those 84px by
   default was drawing 40 book levels into a 6.0px band while an identical,
   legible copy of the same book rendered 3px to its right. */
function cycleRightCol() {
  // Same rule as the button row: inside QUIET this is a view change, so the
  // stash survives and hlterm_inds is not written. Writing it here had the
  // identical failure — the quiet all-false blob persisted over the owner's
  // saved layer set, with "q again to restore" still on screen.
  const inQuiet = !!QUIET.stash;
  const cur = state.inds.vp ? "vp" : state.inds.book ? "book" : "none";
  const next = cur === "none" ? "vp" : cur === "vp" ? "book" : "none";
  state.inds.vp = next === "vp";
  state.inds.book = next === "book";
  if (!inQuiet) localStorage.setItem("hlterm_inds", JSON.stringify(state.inds));
  syncIndButtons();
  // The book tenant draws the AGGREGATED ladder, which rides the heat poll.
  if (next === "book") pollHeat();
  /* The toast describes the FRAME ABOUT TO BE DRAWN, not the flag just set.

     Audited 2026-08-16: with the heat gutter live this said, unconditionally,
     "right column: resting book (aggregated, truncated, cancellable)" at a
     moment when colTenant resolved to "none" and no book would be drawn — and
     "right column: volume profile" when only the POC would draw. Both were
     captured verbatim under live heat. That is not a silent no-op, it is a
     positive assertion of something false, which is worse: a no-op leaves the
     reader uncertain, a false toast leaves him confident and wrong.

     Same test as heatOn in drawChart. The width half of gutterFits (axisR >=
     260) is deliberately NOT re-derived here — it needs a laid-out canvas and
     this runs before the frame — so the toast speaks only to the condition it
     can actually check, and the legend carries the width case. Saying less
     than you know is fine; saying more is the bug being fixed. */
  const heatOwns = !!(state.inds.heat && state.heat.coin === state.sel &&
                      state.heat.live);
  const yielded = heatOwns && next !== "none"
    ? " — heatmap owns the right edge, so " +
      (next === "vp" ? "the POC level draws and the histogram does not"
                     : "the ladder stays in ORDER BOOK beside the chart") +
      "; H frees the column"
    : "";
  showToast("right column: " + (
    next === "none" ? "none — the plot keeps the width"
    : next === "vp" ? "volume profile"
    : "resting book (aggregated, truncated, cancellable)") + yielded +
    (inQuiet ? " · quiet is a view — not saved" : ""));
  drawChart();
}

function toggleQuiet() {
  if (QUIET.stash) {
    state.inds = QUIET.stash;
    QUIET.stash = null;
    showToast("indicators restored");
  } else {
    const off = {};
    for (const k of Object.keys(state.inds)) off[k] = false;
    QUIET.stash = state.inds;          // the object itself; nothing mutates it
    state.inds = off;
    showToast("quiet chart — q again to restore");
  }
  syncIndButtons();
  // Same rule the button handler uses: a layer switched back on must not
  // wait for the next poll to have data, or it restores as an empty pane.
  if (state.inds.heat || state.inds.book) pollHeat();
  if (state.inds.cvd || state.inds.fp) loadFlowHist();
  loadDepthHist();      // its own state.inds.heat gate, see the strip's draw
  renderNewsCtx();
  drawChart();
}

/* One-time migration to the quiet default.

   hlterm_inds was written in two places, read in one, and never reset, so
   there was no path back to a quiet chart short of thirteen clicks. This
   profile's persisted blob was measured all-thirteen-true — the 23.3% state
   above — and the diagnoses note it may have been set by an agent session
   measuring density rather than by the owner.

   Deliberately strict: only an ALL-true blob is replaced. A mixed selection
   is a decision and is left alone. It runs at most once (the flag is
   recorded even when nothing was replaced), so a user who deliberately
   turns the layers back on afterwards is never fought. The reset is
   announced, never silent — discarding someone's selections without saying
   so is the same class of harm as renaming their storage keys. */
const INDS_MIGRATED_KEY = "hlterm_inds_quiet_v1";

function migrateInds(saved) {
  if (localStorage.getItem(INDS_MIGRATED_KEY)) return saved;
  localStorage.setItem(INDS_MIGRATED_KEY, String(Date.now()));
  const allOn = saved && Object.keys(state.inds).every((k) => saved[k] === true);
  if (!allOn) return saved;
  localStorage.setItem("hlterm_inds", JSON.stringify(state.inds));
  // Deferred past boot on purpose: restoreRuler toasts after loadUniverse
  // resolves, and this message fires at most once ever, so it is the one
  // that must not be overwritten.
  setTimeout(() => showToast(
    "indicators reset — press q to toggle, buttons still work"), 2000);
  return null;                  // fall through to the code default below
}

/* One-time promotion of S/R to on.

   Flipping the literal above to true is NOT sufficient on its own, and
   assuming it was would have shipped a silent no-op for exactly the profile
   this is for: the quiet-default migration wrote hlterm_inds with sr:false,
   and loadInds spreads the saved blob OVER the code defaults.

   It is also not the layer he switched off. The S/R he last saw was the
   fractal method that moved when he moved; this is a different instrument
   wearing the same button. So it is turned on once, ANNOUNCED (silently
   overriding someone's selection is the same class of harm as renaming
   their storage keys), and the flag is recorded whether or not anything
   changed so it can never run a second time and never fight a reader who
   turns it back off. */
const INDS_SR_KEY = "hlterm_sr_prior_v1";

function promoteSrLevels() {
  if (localStorage.getItem(INDS_SR_KEY)) return;
  localStorage.setItem(INDS_SR_KEY, String(Date.now()));
  if (state.inds.sr) return;               // already on — nothing to announce
  state.inds.sr = true;
  localStorage.setItem("hlterm_inds", JSON.stringify(state.inds));
  // 3.5s, not migrateInds' 2s: both one-shot toasts can fire on the same
  // first load, and neither may be the one that gets overwritten.
  setTimeout(() => showToast(
    "S/R is now prior-period highs & lows — the SR button hides it"), 3500);
}

/* One-time retirement of the in-canvas book from the DEFAULT view.

   Flipping the literal in state.inds is not sufficient on its own, and
   assuming it was would ship a silent no-op for exactly the profile this is
   for: loadInds spreads the saved blob OVER the code defaults, and this
   profile's blob has book:true in it because book:true was the default for
   as long as the key has existed.

   What was measured: the column is 84 x 342.9 = 28,805 px2 and it used 1.75%
   of its own height, 94.2% of its rows blank, reaching ±3.09 bps against a
   464 bps pane — while #sidebook rendered the identical book as 16 legible
   rows 3px away. The book is not deleted; it is now the right column's
   opt-in tenant, AGGREGATED so that it fills the pane it is given.

   Announced, never silent — discarding someone's selection without saying so
   is the same class of harm as renaming their storage keys — and the flag is
   recorded whether or not anything changed, so it can never run twice and
   never fights a reader who turns it back on. */
const INDS_RIGHTCOL_KEY = "hlterm_rightcol_v1";

function retireCanvasBook() {
  if (localStorage.getItem(INDS_RIGHTCOL_KEY)) return;
  localStorage.setItem(INDS_RIGHTCOL_KEY, String(Date.now()));
  if (!state.inds.book) return;              // nothing to retire, nothing to say
  state.inds.book = false;
  localStorage.setItem("hlterm_inds", JSON.stringify(state.inds));
  // 5s: migrateInds toasts at 2s and promoteSrLevels at 3.5s, and all three
  // one-shots can fire on the same first load. None may overwrite another.
  setTimeout(() => showToast(
    "in-chart book is off — b cycles the right column: none / profile / book"), 5000);
}

function loadInds() {
  try {
    const s = migrateInds(
      JSON.parse(localStorage.getItem("hlterm_inds") || "null"));
    if (s) state.inds = { ...state.inds, ...s };
  } catch (e) { /* defaults */ }
  promoteSrLevels();
  retireCanvasBook();
  /* The two tenants cannot both be lit. A blob saved before the column
     existed can carry vp:true and book:true together, and the buttons would
     then both read "on" while only one of them drew. VP wins because it is
     the one the owner has to opt into deliberately. */
  if (state.inds.vp && state.inds.book) state.inds.book = false;
  syncIndButtons();
}

function emaSeries(cs, period) {
  const k = 2 / (period + 1), out = new Array(cs.length).fill(null);
  let e = null;
  for (let i = 0; i < cs.length; i++) {
    e = e == null ? cs[i].c : cs[i].c * k + e * (1 - k);
    if (i >= period - 1) out[i] = e;
  }
  return out;
}

function bollSeries(cs, period, mult) {
  const mid = new Array(cs.length).fill(null),
        up = mid.slice(), dn = mid.slice();
  let sum = 0, sumsq = 0;
  for (let i = 0; i < cs.length; i++) {
    sum += cs[i].c; sumsq += cs[i].c * cs[i].c;
    if (i >= period) {
      const old = cs[i - period].c;
      sum -= old; sumsq -= old * old;
    }
    if (i >= period - 1) {
      const m = sum / period;
      const sd = Math.sqrt(Math.max(0, sumsq / period - m * m));
      mid[i] = m; up[i] = m + mult * sd; dn[i] = m - mult * sd;
    }
  }
  return { mid, up, dn };
}

/* Session VWAP, re-anchored at each UTC day boundary (`daily`), which is what
   VWAP means and is the only anchor that does not move when the viewport
   does. On a 1d-or-coarser chart every bar is its own session, so the reset
   is switched off there and the series accumulates from the oldest bar. */
function vwapSeries(cs, daily) {
  const out = new Array(cs.length).fill(null);
  let pv = 0, vv = 0, day = null;
  for (let i = 0; i < cs.length; i++) {
    if (daily) {
      const d = Math.floor(+cs[i].t / 86400000);
      if (day !== null && d !== day) { pv = 0; vv = 0; }
      day = d;
    }
    const tp = (cs[i].h + cs[i].l + cs[i].c) / 3;
    pv += tp * (cs[i].v || 0); vv += cs[i].v || 0;
    out[i] = vv > 0 ? pv / vv : null;
  }
  return out;
}

/* ── Support/Resistance = calendar-anchored PRIOR-PERIOD EXTREMES ────────

   WHAT THIS REPLACED. srLevels() derived fractal pivots, a 0.35% cluster
   tolerance and a >=2-touch filter ENTIRELY from the visible slice, so the
   levels moved whenever the reader moved. Measured stability, Jaccard over
   the views a user actually produces: 0.383 under scroll and zoom, and
   0.075 across an interval change — 7.5% of the levels survived switching
   1h to 4h. Prior-period extremes score 1.000, by construction, because
   none of their inputs is on screen.

   SAY THE NULL RESULT PLAINLY. This method does not predict, and neither
   did any other horizontal S/R method tested. Across 266 pre-registered
   cells on 9 instruments, real levels rejected 59.20% of fresh touches;
   displaced-RANDOM levels rejected 60.03%. Edge minus control -0.83pp, 95%
   block-bootstrap CI [-2.22, +0.58]. The harness had power — a lookahead
   swing-pivot oracle scores +6.22pp [+3.9,+8.7], lookahead window extremes
   +38.7pp, against honest half-widths of 2.0-2.5pp. The decisive diagnostic
   is that real levels are not even VISITED more often than arbitrary nearby
   prices: an identical 2.38 fresh touches per level per fold on both arms.
   The folk "~60% of touches bounce" figure is entirely baseline. Recorded
   as horizontal-sr-levels / NO_GO in datasources/edge_registry.py, and
   SR_VERDICT puts it on the glass rather than in a file the reader will
   never open.

   So the method is chosen on STABILITY, and the label says where the price
   CAME FROM — PDH = prior day high — rather than ranking levels the reader
   cannot tell apart in outcome. Touch-count ranking is refuted in the same
   study (2 touches 61.48%, 8+ touches 56.10%, i.e. backwards by 3.52pp), so
   the "N touches" suffix is deleted rather than reworded.

   NOT SHIPPED, on evidence: no multi-timeframe confluence badge (3-TF
   +8.05pp CI [-8.0,+22.3] on 1.3% of events — no trend and too rare to be a
   chart feature); no volume-profile-derived levels (an oracle computed on
   the FUTURE window scores -2.71pp, CI [-5.0,-0.4] — negative WITH PERFECT
   FORESIGHT, because high-volume nodes are where price churns through, not
   where it turns); no "show more levels" control; no separate RTH level set
   for the equity perps (signs disagree across NVDA/AAPL/TSLA, the signature
   of noise) — session structure for those belongs on the TIME axis.

   FAIL CLOSED. No daily series, or a period that begins before this
   market's first daily bar, yields NO LINE and a legend that names which
   period is missing and why. Measured: xyz:RKLB's first daily bar is
   2026-05-04 and the prior quarter began 2026-04-01, so RKLB has 9 levels,
   not 12, and no PQH/PQL/PQC — drawing a quarter extreme out of two thirds
   of a quarter would be a confident fact assembled from history that does
   not exist.

   DATA PATH, and why it needed no server change: /api/candles?interval=1d
   already returns rows[-300:] (measured: BTC 300 bars, 2025-10-20 through
   2026-08-15) and the deepest period needed is a quarter, <=92 days. Daily
   highs and lows aggregate EXACTLY to weekly/monthly/quarterly extremes, so
   nothing here is approximated. */

function srDailyAtr(d) {
  if (!d || !d.length) return 0;
  const lastC = Math.abs(d[d.length - 1].c);
  if (d.length < 15) return lastC * 0.005;
  let t = 0;
  for (let i = d.length - 14; i < d.length; i++)
    t += Math.max(d[i].h - d[i].l, Math.abs(d[i].h - d[i - 1].c),
                  Math.abs(d[i].l - d[i - 1].c));
  return (t / 14) || lastC * 0.005;
}

// UTC, always, and dated so the caveat can state the boundary it used.
const srYmd = (ms) => new Date(ms).toISOString().slice(0, 10);

function priorPeriodLevels(daily, nowMs) {
  const DAYMS = 86400000;
  const out = { levels: [], skipped: [], asOf: null, stale: false, zone: 0,
                err: null, why: null };
  if (!daily || !daily.length) {
    out.why = "no daily series for this symbol";
    return out;
  }
  out.asOf = daily[daily.length - 1].t;
  out.stale = nowMs - out.asOf > SR_STALE_MS;
  out.zone = SR_ZONE_ATR * srDailyAtr(daily);
  /* The bar covering the CURRENT UTC day is still forming. A prior-period
     extreme may only be built from days that have CLOSED — an "extreme" of
     a day still trading is a number that can change under the reader. */
  const dayStart = Math.floor(nowMs / DAYMS) * DAYMS;
  const done = daily.filter((c) => c.t < dayStart);
  if (!done.length) {
    out.why = "the daily series holds no completed UTC day yet";
    return out;
  }
  const firstT = daily[0].t;
  const pd = done[done.length - 1];
  const dt = new Date(dayStart);
  const yy = dt.getUTCFullYear(), mo = dt.getUTCMonth();
  // Weeks start Monday 00:00 UTC. getUTCDay() is Sunday-based, hence the +6.
  const wkStart = dayStart - ((dt.getUTCDay() + 6) % 7) * DAYMS;
  const q0 = Math.floor(mo / 3) * 3;
  /* "Prior day" is the last COMPLETED bar rather than literally yesterday,
     so a gap in the series names the last day that actually traded instead
     of silently producing nothing. Its date rides on the level and is
     printed in the legend tooltip, so a "prior day" three days old can be
     seen to be three days old. Date.UTC handles month -1 and quarter -3 by
     rolling the year for us. */
  const spans = [
    { code: "D", start: pd.t, end: pd.t + DAYMS },
    { code: "W", start: wkStart - 7 * DAYMS, end: wkStart },
    { code: "M", start: Date.UTC(yy, mo - 1, 1), end: Date.UTC(yy, mo, 1) },
    { code: "Q", start: Date.UTC(yy, q0 - 3, 1), end: Date.UTC(yy, q0, 1) },
  ];
  for (const sp of spans) {
    if (firstT > sp.start) {
      out.skipped.push({ code: sp.code, why:
        "The " + SR_PERIOD[sp.code] + " began " + srYmd(sp.start) + ", before " +
        "this market's first daily bar (" + srYmd(firstT) + "), so its high " +
        "and low cannot be measured and no line is drawn for it." });
      continue;
    }
    const bars = daily.filter((c) => c.t >= sp.start && c.t < sp.end);
    if (!bars.length) {
      out.skipped.push({ code: sp.code, why:
        "The " + SR_PERIOD[sp.code] + " (" + srYmd(sp.start) + " to " +
        srYmd(sp.end - DAYMS) + ") has no daily bar in this series." });
      continue;
    }
    /* A gap INSIDE the period means the true extreme may sit in a day this
       series never saw. The level is still the highest/lowest price we can
       actually show, so it is drawn — and the gap is carried on the level
       and stated in the legend rather than quietly widening the claim.
       Measured today: 0 gaps on BTC/HYPE/xyz:TSLA/xyz:RKLB — the xyz equity
       perps do print (thin) weekend daily bars, so weekends are not gaps. */
    const days = Math.round((sp.end - sp.start) / DAYMS);
    const gaps = Math.max(0, days - bars.length);
    let hi = bars[0].h, lo = bars[0].l;
    for (const b of bars) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
    const mk = (kind, px) => ({
      px, kind, gaps, code: sp.code, zone: out.zone,
      name: "P" + sp.code + kind, names: ["P" + sp.code + kind],
      from: bars[0].t, to: bars[bars.length - 1].t,
    });
    out.levels.push(mk("H", hi), mk("L", lo),
                    mk("C", bars[bars.length - 1].c));
  }
  /* MERGE only levels that PRINT THE SAME PRICE, and only across DIFFERENT
     periods. Both conditions are measured, not taste.

     Merging everything inside the full +-0.6 x daily ATR tolerance collapses
     12 raw levels to 6-9 on the twelve symbols checked — but it gets there
     by swallowing a period's own structure. On BTC the prior day's HIGH
     (63,615) and its CLOSE (63,029) are 0.55 ATR apart, so the merged line
     would carry the label PDH at a price 586 BELOW the actual prior-day
     high; worst case across the twelve was 0.58 ATR. A label that names a
     level and prints a price that is not that level's price is the house
     invariant broken. Printed-price identity cannot lie: every name in a
     merged group is true at the precision the reader is shown.

     It still does real work, on exactly the days a coincidence is real.
     Measured across 12 symbols x 141 levels: 0 merges on a Saturday (the
     prior day is Friday, the prior week ended Sunday — nothing coincides),
     17 on a Monday (PWC == PDC, PWH == PDH: the week ended on the prior
     day), 39 on the first day of a quarter (PQL == PML == PWL). It never
     invents a coincidence and never hides one. */
  out.levels.sort((a, b) => a.px - b.px);
  const groups = [];
  for (const l of out.levels) {
    const g = groups[groups.length - 1];
    const coincident = g && Math.abs(l.px - g.px) <= out.zone &&
      fmtPx(l.px) === fmtPx(g.px) &&
      !g.members.some((m) => m.code === l.code);
    if (coincident) g.members.push(l);
    else groups.push({ px: l.px, members: [l] });
  }
  out.levels = groups.map((g) => {
    g.members.sort((a, b) => SR_RANK[a.code] - SR_RANK[b.code]);
    const lead = g.members[0];
    return Object.assign({}, lead, {
      names: g.members.map((m) => m.name),
      gaps: Math.max(...g.members.map((m) => m.gaps)),
      members: g.members,
    });
  });
  return out;
}

/* Memoised per (symbol, daily-series tip, UTC day).

   The UTC day is in the key because the PERIODS move even when the series
   does not: at 00:00 UTC "prior day" becomes a different day, and a cache
   keyed on the series alone would go on naming yesterday's yesterday. */
function srLevelSet() {
  const sd = state.srDaily;
  /* Another instrument's prices on this chart is the failure this file
     guards against hardest, so there is no fallback and no last-good here:
     wrong coin, no levels. */
  if (!sd || sd.coin !== state.sel) return null;
  if (!sd.candles || !sd.candles.length) {
    return { levels: [], skipped: [], asOf: null, stale: false, zone: 0,
             err: sd.err || null,
             why: sd.err ? "daily series failed to load (" + sd.err + ")"
                         : "the daily series has not loaded yet" };
  }
  const now = Date.now();
  const key = sd.candles[sd.candles.length - 1].t + ":" +
              Math.floor(now / 86400000);
  if (!sd.calc || sd.calc.key !== key)
    sd.calc = { key, res: priorPeriodLevels(sd.candles, now) };
  /* Staleness is a function of the CLOCK, not of the series, so it is
     refreshed outside the memo — a cached set must never go on reporting
     "fresh" for the rest of the session. Same for the fetch error: the
     levels can be good while the refresh behind them is failing. */
  sd.calc.res.stale = now - sd.calc.res.asOf > SR_STALE_MS;
  sd.calc.res.err = sd.err || null;
  return sd.calc.res;
}

/* Volume profile: volume-at-price over the loaded window.

   Each bar's volume is spread UNIFORMLY across the price range it actually
   traded through (its high..low), not dropped whole into the bucket holding
   its typical price. The old rule put 100% of a bar's volume in one bin;
   measured on this series the median candle spans 2.48 bins, p90 4.99 and
   max 10.55, so the POC it produced was a statement about where typical
   prices CLUSTERED being presented as where volume TRADED. Those are
   different claims and only one of them is what a volume profile means.

   Uniform-within-bar is an approximation and is named as one: without tick
   data there is no way to know where inside a bar the volume actually went,
   and every charting package makes the same assumption for the same reason.
   It is fixed in the same change that moves the profile into the right
   column — before that the layer was off by default and invisible, and this
   is the change that makes it discoverable. */
function volumeProfile(cs, bins) {
  const lo = Math.min(...cs.map((c) => c.l)), hi = Math.max(...cs.map((c) => c.h));
  const span = hi - lo || 1;
  const B = bins || 24;
  const buckets = new Array(B).fill(0);
  const bin = (p) => Math.min(B - 1, Math.max(0, Math.floor((p - lo) / span * B)));
  for (const c of cs) {
    const b0 = bin(c.l), b1 = bin(c.h);
    const share = (c.v || 0) / (b1 - b0 + 1);
    for (let i = b0; i <= b1; i++) buckets[i] += share;
  }
  let poc = 0;
  for (let i = 1; i < B; i++) if (buckets[i] > buckets[poc]) poc = i;
  const bucketPx = (i) => lo + (i + 0.5) / B * span;
  return { buckets, max: Math.max(...buckets) || 1, pocPx: bucketPx(poc),
           pocIdx: poc, bucketPx, lo, hi, B };
}

/* Value area: expand out from the POC, always taking the fatter neighbour,
   until `frac` of total volume is enclosed. This is the zone the market
   agreed on — price leaving it is the thing worth noticing. */
function valueArea(vp, frac) {
  const total = vp.buckets.reduce((a, b) => a + b, 0);
  if (!total) return { lo: vp.lo, hi: vp.hi };
  let lo = vp.pocIdx, hi = vp.pocIdx, acc = vp.buckets[vp.pocIdx];
  while (acc < total * frac && (lo > 0 || hi < vp.B - 1)) {
    const below = lo > 0 ? vp.buckets[lo - 1] : -1;
    const above = hi < vp.B - 1 ? vp.buckets[hi + 1] : -1;
    if (above >= below) { hi++; acc += vp.buckets[hi]; }
    else { lo--; acc += vp.buckets[lo]; }
  }
  return { lo: vp.bucketPx(lo), hi: vp.bucketPx(hi) };
}

function emaOfArr(arr, period) {
  const k = 2 / (period + 1), out = new Array(arr.length).fill(null);
  let e = null, seen = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    e = e == null ? arr[i] : arr[i] * k + e * (1 - k);
    seen++;
    if (seen >= period) out[i] = e;
  }
  return out;
}

function macdSeries(cs, fast, slow, sig) {
  const closes = cs.map((c) => c.c);
  const ef = emaOfArr(closes, fast), es = emaOfArr(closes, slow);
  const macd = closes.map((_, i) =>
    ef[i] != null && es[i] != null ? ef[i] - es[i] : null);
  const signal = emaOfArr(macd, sig);
  const hist = macd.map((m, i) =>
    m != null && signal[i] != null ? m - signal[i] : null);
  return { macd, signal, hist };
}

function rsiSeries(cs, period) {
  const out = new Array(cs.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i < cs.length; i++) {
    const d = cs[i].c - cs[i - 1].c;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= period) {
      ag += g / period; al += l / period;
      if (i === period) out[i] = 100 - 100 / (1 + (al === 0 ? 1e9 : ag / al));
    } else {
      ag = (ag * (period - 1) + g) / period;
      al = (al * (period - 1) + l) / period;
      out[i] = 100 - 100 / (1 + (al === 0 ? 1e9 : ag / al));
    }
  }
  return out;
}

document.getElementById("indbtns").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const k = b.dataset.ind;
  /* WHILE QUIET, A LAYER TOGGLE IS PART OF THE VIEW AND IS NOT PERSISTED.

     This used to read `QUIET.stash = null` — "a deliberate click ends QUIET"
     — and then fall through to the localStorage write below. Measured
     2026-08-16 with a saved set of {sr, wh, vol}: press q (stash taken, all
     off), click EMA, and hlterm_inds was overwritten with the QUIET blob plus
     ema, i.e. {ema:true, everything-else:false}. sr/wh/vol were gone from
     memory AND from disk. The next q re-stashed the crippled set, and the
     toast said "quiet chart — q again to restore" the entire time. The one
     control advertised as reversible was the one that destroyed the layout,
     and it wrote the loss through to disk where a reload could not undo it.

     Quiet is documented as a VIEW that does not write hlterm_inds. A toggle
     made inside that view inherits the same rule: it changes what is drawn,
     the stash is left intact so q still restores exactly what was saved, and
     the toast says plainly that this one is not being saved. The alternative
     — silently restoring the stashed layers on top of the click — would put
     layers back on a chart the user just deliberately emptied. */
  const inQuiet = !!QUIET.stash;
  if (!inQuiet) QUIET.stash = null;
  state.inds[k] = !state.inds[k];
  /* VP and BOOK are ONE choice — the right column's tenant — so turning one
     on turns the other off. Two independent booleans for one 84px column
     would mean a state in which both buttons are lit and only one of them is
     drawn, which is the button lying about the canvas. */
  if ((k === "vp" || k === "book") && state.inds[k])
    state.inds[k === "vp" ? "book" : "vp"] = false;
  syncIndButtons();
  if (inQuiet) {
    const kept = Object.keys(QUIET.stash).filter((x) => QUIET.stash[x]).length;
    showToast((b.dataset.label || b.textContent).trim() +
      (state.inds[k] ? " on" : " off") +
      " — quiet is a VIEW, so this is not saved; q restores your " +
      kept + " saved layer" + (kept === 1 ? "" : "s"));
  } else {
    localStorage.setItem("hlterm_inds", JSON.stringify(state.inds));
  }
  // The book tenant reads the AGGREGATED ladder, which arrives on the heat
  // poll — same rule as heat: a layer switched on must not restore as an
  // empty column while it waits for the next 2s tick.
  if ((k === "heat" || k === "book") && state.inds[k]) pollHeat();
  // ...and the strip beside that ladder, for the same reason: turning HEAT on
  // must not leave the persisted history blank until the next candle refresh.
  if (k === "heat" && state.inds[k]) loadDepthHist();
  // Toggling flow on should show history immediately, not after the next
  // candle refresh.
  if ((k === "cvd" || k === "fp") && state.inds[k]) loadFlowHist();
  if (k === "news") {
    /* Flags only. DES has its own chip and must not die with NEWS. */
    if (state.inds.news) loadChartNews();
    drawChart();
  }
  drawChart();
  renderHints();          // heat on/off changes whether "click wall" is true
});

/* The EVENT RADAR header slot. It named the panel's scope (±MOVE · 45D) and
   nothing about whether the calendar under it is current — so a 45-day radar
   built two hours ago during a server restart looked identical to one built
   this minute. Every other dated surface on this desk carries its age here;
   this one now does too, and says NEVER rather than a number when there has
   been no successful read at all. */
function updateEvMeta() {
  const el = $("ev-meta");
  if (!el) return;
  const s = (state.slow || {}).events || {};
  if (!s.err) {
    el.textContent = "±MOVE · 45D";
    el.title = "calendar read " + slowAgeTxt("events");
    el.classList.remove("stale");
    return;
  }
  el.textContent = s.at ? "±MOVE · 45D · READ " + slowAgeTxt("events").toUpperCase()
                        : "±MOVE · 45D · NOT READ";
  el.title = "the calendar refresh is FAILING — " + s.err +
    (s.at ? ". What is drawn below is the last calendar that arrived, not the current one."
          : ". Nothing has been read this session, so nothing below is a calendar.");
  el.classList.add("stale");
}

function renderEvents(evs) {
  state.events = evs;      // chart band lookup (always the full set)
  drawChart();
  renderNewsCtx();
  updateEvMeta();
  const shown = state.evfilter === "all" ? evs : evs.filter((e) => e.tradeable);
  if (!shown.length) {
    /* "no calendar data" is a MEASUREMENT — it says the calendar was built
       and holds nothing. A failed build renders identically unless the error
       is read, and an earnings day that renders as an empty calendar is the
       most expensive shape this bug has. */
    const se = (state.slow || {}).events || {};
    $("events").innerHTML = evs.length
      ? '<div class="empty">no tradeable-market events — switch to ALL</div>'
      : se.err
      ? '<div class="empty" style="white-space:normal">NOT MEASURED — the ' +
        'calendar request failed (<b>' + esc(se.err) + '</b>). This is not an ' +
        'empty calendar and not an uneventful 45 days; it is a question that ' +
        'got no answer. The chart’s event bands are absent for the same ' +
        'reason.</div>'
      : '<div class="empty">no calendar data</div>';
    return;
  }
  const today = etDate(0);
  const tomorrow = etDate(1);

  const evRow = (e, date) => {
    const macro = e.symbol === "MACRO";
    const lockup = e.event_type === "lockup";
    const move = e.expected_move_pct;
    let mcls = "small";
    if (move != null) mcls = move >= 4 ? "big" : move >= 2 ? "mid" : "small";
    const meth = lockup ? "EST" :
                 e.method === "options-implied" ? "IMPL" :
                 e.method === "historical-event" ? "HIST" :
                 e.method === "realized-vol" ? "RVOL" : "";
    const rowCls = (date === today ? "ev today" : date === tomorrow ? "ev tmrw" : "ev") +
                   (e.hl_coin ? " clickable" : "");
    const scls = macro ? "macro" : lockup ? "lockup" : "";
    const mktLink = e.hl_coin
      ? `<a class="mkt" href="${hlTradeUrl(e.hl_coin)}" target="_blank" rel="noopener" title="open ${esc(e.hl_coin)} on Hyperliquid">↗</a>`
      : `<span class="mkt off" title="not listed on Hyperliquid">·</span>`;
    return `<div class="${rowCls}" data-sym="${esc(e.hl_coin || "")}" title="${esc(e.detail || "")}">` +
      `<span class="es ${scls}">${esc(macro ? e.event_type.toUpperCase() : e.symbol)}</span>` +
      `<span class="el">${lockup ? "🔓 " : ""}${esc(e.label)}</span>` +
      `<span class="em ${mcls}">${move != null ? "±" + move.toFixed(2) + "%" : "—"}</span>` +
      `<span class="meth">${meth}</span>${mktLink}</div>`;
  };

  const out = [];
  // NOW block: imminent risk (today + tomorrow) pinned on top, biggest move first
  const nowEvs = shown.filter((e) => e.date >= today && e.date <= tomorrow)
    .sort((a, b) => (b.expected_move_pct || 0) - (a.expected_move_pct || 0));
  if (nowEvs.length) {
    out.push(`<div class="evd now">⚠ NOW · NEXT 48H</div>`);
    for (const e of nowEvs) out.push(evRow(e, e.date));
  }
  const byDate = {};
  for (const e of shown) {
    if (e.date <= tomorrow) continue;          // already pinned above
    (byDate[e.date] = byDate[e.date] || []).push(e);
  }
  for (const date of Object.keys(byDate).sort()) {
    const d = new Date(date + "T00:00:00");
    const dow = ["SUN","MON","TUE","WED","THU","FRI","SAT"][d.getDay()];
    out.push(`<div class="evd">${esc(date)} ${dow}</div>`);
    for (const e of byDate[date]) out.push(evRow(e, date));
  }
  $("events").innerHTML = out.join("");
  document.querySelectorAll(".ev.clickable").forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.closest("a.mkt")) return;  // external link handles itself
      if (el.dataset.sym) selectCoin(el.dataset.sym);
    };
  });
}

$("evtabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll("#evtabs button").forEach((x) => x.classList.remove("on"));
  b.classList.add("on");
  state.evfilter = b.dataset.f;
  renderEvents(state.events);
});

$("newstabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll("#newstabs button").forEach((x) => x.classList.remove("on"));
  b.classList.add("on");
  state.newsAll = b.dataset.f === "all";
  loadResearch();
});

const _desChip = $("des-chip");
if (_desChip) {
  syncDesChip();
  _desChip.addEventListener("click", () => {
    state.desOn = !state.desOn;
    try { localStorage.setItem("hlterm_des", state.desOn ? "1" : "0"); } catch (e) {}
    syncDesChip();
    if (state.desOn) loadDes();
    renderNewsCtx();
  });
}

/* ---------------- news + research ---------------- */
/* An age in the units a reader thinks in. Hours under two days (a headline
   from this morning and one from last night are different trades), days after
   that. Null in, "age unknown" out — never "0", which is the whole house rule.
   Takes ageDays()'s float so the UTC parsing lives in exactly one place. */
function newsAgeTxt(days) {
  if (days == null || !isFinite(days)) return "age unknown";
  if (days < 0) return "future-stamped";
  const h = days * 24;
  return h < 1 ? Math.max(1, Math.round(h * 60)) + "m"
       : h < 48 ? h.toFixed(h < 10 ? 1 : 0) + "h"
                : days.toFixed(1) + "d";
}

/* THE NEWS HEADER, which used to be the string "25 MATERIAL" and nothing else.

   Audited 2026-08-16: that number is the SQL LIMIT, not a total (984 material
   rows are held), and the pane carried no age of any kind while every one of
   its 25 visible headlines was between 41.7h and 78.3h old and the pipeline
   that feeds it had last cycled 33h earlier. On a desk where BOOKS says 12S,
   TAPE says 23S and SNAP says 4M, a feed with no age reads as live BY
   CONTRAST — a dead tape wearing a live one's clothes.

   state.pipelineNote used to be written into #res-meta, an element deleted
   with the INTEL STACK panel, so the one string that could have said
   "PIPELINE OFFLINE" was computed every poll and thrown into a null guard.
   It lands here now: news is that pipeline's only remaining visible output. */
const NEWS_CHART_LIMIT = 100;

function newsPubMs(row) {
  const s = row && row.published_at;
  if (!s) return null;
  let iso = String(s).trim().replace(" ", "T");
  if (!/[Zz]|[+-]\d\d:?\d\d$/.test(iso))
    iso += iso.length <= 10 ? "T00:00:00Z" : "Z";
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? null : ms;
}

function researchUrl() {
  if (state.newsAll) return "/api/research?all=1";
  return "/api/research?coin=" + encodeURIComponent(state.sel);
}

/* Dedicated fetch for FLAGS. Always the charted name, never ALL.
   The NEWS river keeps its own loadResearch path (CN 25 / ALL 25).
   DES is /api/des and does not hide when NEWS is off. */
function loadChartNews() {
  const coin = state.sel;
  if (!coin) return;
  fetch("/api/research?coin=" + encodeURIComponent(coin) +
        "&limit=" + NEWS_CHART_LIMIT).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then((d) => {
    if (state.sel !== coin) return;
    if (!d || d.error) return;
    const mode = (d.news_meta && d.news_meta.mode) || "all";
    if (mode !== "cn") return;     // never take TOP/ALL rows as this name's flags
    if (d.news_meta && d.news_meta.coin && d.news_meta.coin !== coin) return;
    state.newsChart = { coin, news: d.news || [], meta: d.news_meta, at: Date.now() };
    renderNewsCtx();
    loadDes();
    scheduleDraw();
  }).catch(() => { /* keep last good for this coin */ });
}

function ctxCites() {
  const coin = state.sel;
  const base = baseSym(coin);
  const lines = [];
  const last = (state.candles && state.candles.length)
    ? state.candles[state.candles.length - 1].c : null;
  const uctx = ctxFor(coin) || {};
  const f8h = uctx.funding != null ? uctx.funding * 8 * 100 : null;
  if (last != null) {
    let v = "last " + fmtPx(last);
    let tip = "last close of the loaded candle series (candles.c)";
    if (f8h != null) {
      v += " · fund/8h " + (f8h >= 0 ? "+" : "") + f8h.toFixed(4) + "%";
      tip += " · universe.funding is the HL 1h rate, shown x8 as FUND/8H (same field as the watch FUND/8H column)";
    }
    lines.push({ k: "TAPE", v, cite: "candles.c", title: tip });
  } else if (f8h != null) {
    lines.push({ k: "TAPE",
      v: "fund/8h " + (f8h >= 0 ? "+" : "") + f8h.toFixed(4) + "%",
      cite: "universe.funding",
      title: "universe.funding is the HL 1h rate, shown x8 as FUND/8H" });
  }
  const wc = (state.whaleCoin && state.whaleCoin.coin === coin) ? state.whaleCoin : null;
  const depth = (state.depth || {})[coin];
  const sd = (state.sides && state.sides.coin === coin) ? state.sides : null;
  if (wc && wc.n_positions != null && ((wc.long_ntl || 0) + (wc.short_ntl || 0)) > 0) {
    const L = wc.long_ntl || 0, S = wc.short_ntl || 0;
    const pctL = L / (L + S) * 100;
    lines.push({ k: "LEAN",
      v: "whales " + pctL.toFixed(0) + "% long · $" + fmtBig(L) + " / $" + fmtBig(S),
      cite: "whaleCoin.long_ntl",
      title: "tracked-whale cohort notional already in memory — whaleCoin.long_ntl / whaleCoin.short_ntl" });
  } else if (depth && !depth.stale && depth.imb != null) {
    const bid = (1 + depth.imb) / 2 * 100;
    lines.push({ k: "LEAN",
      v: "book " + bid.toFixed(0) + "% bid ±" + (depth.band_bps || "?") + "bps",
      cite: "depth.imb",
      title: "resting-book imbalance already in memory — depth.imb (+1 all bid / -1 all ask)" });
  } else if (sd && sd.imb != null) {
    const bid = (1 + sd.imb) / 2 * 100;
    lines.push({ k: "LEAN",
      v: "sides " + bid.toFixed(0) + "% bid",
      cite: "sides.imb",
      title: "book imbalance already in memory — sides.imb" });
  }
  const ev = nextEventFor(coin);
  if (ev) {
    const lab = (ev.date ? ev.date + " " : "") + (ev.label || ev.event_type || "");
    const mv = ev.expected_move_pct != null ? " ±" + ev.expected_move_pct.toFixed(2) + "%" : "";
    lines.push({ k: "NEXT", v: lab + mv, cite: "events",
      title: "next dated row in state.events for this symbol (event radar)" });
  }
  const nc = state.newsChart;
  const rows = (nc && nc.coin === coin) ? (nc.news || []) : [];
  if (rows.length) {
    const hn = rows[0];
    const href = safeHref(hn.url);
    const age = newsAgeTxt(ageDays(hn.published_at));
    lines.push({ k: "HEADLINE", v: hn.headline || "", href, extra: age,
      cite: href || "news_items.headline",
      title: "newest material headline in newsChart for this name (not the ALL river)" });
  } else if (nc && nc.meta && nc.meta.total === 0) {
    lines.push({ empty: true,
      v: "no material headlines for " + base + " — this name, not a quiet market" });
  }
  return lines.slice(0, 4);
}

function desAgeTxt(ageS) {
  if (ageS == null || !isFinite(ageS) || ageS < 0) return "";
  if (ageS < 5) return "just now";
  if (ageS < 60) return Math.round(ageS) + "s";
  if (ageS < 90 * 60) return Math.round(ageS / 60) + "m";
  return (ageS / 3600).toFixed(1) + "h";
}

function syncDesChip() {
  const b = $("des-chip");
  if (!b) return;
  b.classList.toggle("on", !!state.desOn);
}

let desPollTimer = null;

function loadDes() {
  if (!state.desOn) return;
  const coin = state.sel;
  if (!coin) return;
  state.desFetchCoin = coin;
  fetch("/api/des?coin=" + encodeURIComponent(coin)).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then((d) => {
    if (state.sel !== coin) return;
    if (!d || d.error) throw new Error((d && d.error) || "des");
    state.des = Object.assign({ coin }, d);
    renderNewsCtx();
    if (d.status === "pending") {
      if (!state.desWait || state.desWait.coin !== coin)
        state.desWait = { coin, at: Date.now() };
      if (Date.now() - state.desWait.at > 30000) {
        state.des.fail = "DES failed / using cites only";
        state.des.status = "fail";
        state.des.mode = "cites";
        if (!state.des.cites || !state.des.cites.length) state.des.cites = ctxCites();
        renderNewsCtx();
        return;
      }
      clearTimeout(desPollTimer);
      desPollTimer = setTimeout(loadDes, 2500);
    } else {
      state.desWait = { coin: null, at: 0 };
    }
  }).catch(() => {
    if (state.sel !== coin) return;
    state.des = { coin, mode: "cites", status: "fail",
      fail: "DES failed / using cites only", cites: ctxCites(), lines: [] };
    renderNewsCtx();
  });
}

function renderNewsCtx() {
  const el = $("news-ctx");
  if (!el) return;
  /* DES is independent of NEWS flags and of CN/ALL. Off hides the note
     and is silent — no CONTEXT card underneath. */
  if (!state.desOn) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const coin = state.sel;
  const base = baseSym(coin);
  const des = (state.des && state.des.coin === coin) ? state.des : null;
  const cites = (des && des.cites && des.cites.length) ? des.cites : ctxCites();
  const llm = !!(des && des.mode === "llm" && des.lines && des.lines.length);
  const fail = des && des.fail;
  const pending = des && des.status === "pending";
  let extra = "";
  if (fail) extra = "DES failed / using cites only";
  else if (pending) extra = "cites only · note pending";
  else if (des && des.age_s != null) extra = desAgeTxt(des.age_s);
  const rows = llm ? des.lines.slice(0, 4) : cites.slice(0, 4);
  el.hidden = false;
  const head = '<div class="nctx-h">' + esc(base) + ' DES' +
    (extra ? '<span class="nctx-age">' + esc(extra) + '</span>' : '') + '</div>';
  if (!rows.length) {
    el.innerHTML = head;
    return;
  }
  el.innerHTML = head + rows.map((ln) => {
    if (ln.empty)
      return '<div class="nctx-empty">' + esc(ln.v) + '</div>';
    if (llm || ln.text) {
      const text = ln.text || ln.v || "";
      const href = safeHref(ln.href || (ln.cite && /^https?:\/\//i.test(ln.cite) ? ln.cite : null));
      const cite = ln.cite ? (href
        ? '<a class="nctx-cite" href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(ln.cite.replace(/^https?:\/\//i, "").slice(0, 28)) + '</a>'
        : '<span class="nctx-cite">' + esc(ln.cite) + '</span>') : '';
      return '<div class="nctx-row" title="' + esc(ln.cite || '') + '">' +
        '<span class="nctx-v">' + esc(text) + '</span>' + cite + '</div>';
    }
    const href = safeHref(ln.href);
    const body = href
      ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(ln.v) + '</a>'
      : esc(ln.v);
    const age = ln.extra ? '<span class="nctx-age">' + esc(ln.extra) + '</span>' : '';
    const cite = ln.cite && !href
      ? '<span class="nctx-cite">' + esc(ln.cite) + '</span>' : '';
    return '<div class="nctx-row" title="' + esc(ln.title || ln.cite || '') + '">' +
      (ln.k ? '<span class="nctx-k">' + esc(ln.k) + '</span>' : '') +
      '<span class="nctx-v">' + body + age + '</span>' + cite + '</div>';
  }).join("");
}


function loadResearch() {
  const want = state.newsAll ? "all" : state.sel;
  fetch(researchUrl()).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then((d) => {
    if (!d || d.error) return;
    const mode = (d.news_meta && d.news_meta.mode) || "all";
    if (state.newsAll && mode !== "all") return;
    if (!state.newsAll && (mode !== "cn" || d.news_meta.coin !== want)) return;
    state.slow.research = { at: Date.now(), err: null };
    renderNews(d.news || [], d.news_meta);
    renderResearch(d);
    // When the river is CN, the same payload can seed flags until the
    // wider newsChart fetch lands. Never seed from ALL — that would put
    // other names' headlines on this chart.
    if (mode === "cn" && (!state.newsChart || state.newsChart.coin !== want)) {
      state.newsChart = { coin: want, news: d.news || [], meta: d.news_meta, at: Date.now() };
      renderNewsCtx();
      loadDes();
      scheduleDraw();
    }
  }).catch((e) => {
    state.slow.research = { at: (state.slow.research || {}).at || null,
                            err: (e && e.message) || String(e) };
    updateNewsMeta();
  });
}

function updateNewsMeta() {
  const el = $("news-meta");
  if (!el) return;
  const m = state.newsMeta || {};
  const bits = [], why = [];
  const shown = state.news.length;
  if (m.mode === "cn" && m.base) bits.push(m.base + " CN");
  else if (m.mode === "all") bits.push("ALL");
  if (m.total != null && m.total > shown) {
    bits.push(`newest ${shown} of ${m.total}`);
    why.push(`${shown} newest of ${m.total} material stories held — this is a PAGE, not a total.`);
  } else {
    bits.push(shown + " MATERIAL");
  }
  const nd = state.news.length ? ageDays(state.news[0].published_at) : null;
  if (shown) {
    const at = newsAgeTxt(nd);
    bits.push(nd != null && nd >= 1 ? at + " OLD" : at);
    why.push(nd == null
      ? "The newest story carries no publish time, so this feed's age is UNKNOWN — not fresh."
      : `Newest story published ${at} ago.`);
  }
  /* WHOSE STALENESS IS WHICH. The two rungs below this one describe the
     UPSTREAM pipeline's age — how long since it last cycled — which is a
     different fact from how long since THIS TAB last got an answer out of
     /api/research. During a local-server-down window the pipeline rungs kept
     reading "cycled 40m ago" (true, and read 40 minutes ago) while nothing
     on screen said the panel itself had stopped refreshing. Placed ahead of
     both pipeline rungs because it governs whether either can be trusted:
     when this one is lit, the pipeline ages beside it were themselves read
     at the stamped time and have been standing still ever since. */
  const sr = (state.slow || {}).research || {};
  if (sr.err) {
    bits.push(sr.at ? "FEED " + slowAgeTxt("research").toUpperCase() : "FEED NOT READ");
    why.push(sr.at
      ? `This panel's own refresh is FAILING (${sr.err}). Everything below is the payload that arrived ${slowAgeTxt("research")}, not the current one — including the pipeline ages, which were read then too.`
      : `This panel's refresh has never succeeded this session (${sr.err}). Nothing here has been read from the server.`);
  }
  /* INTEL vs PIPELINE. Cycles can keep landing while synthesis writes
     nothing (measured 2026-08-24 to 26: 39h, news still ingesting, 0 cards).
     INTEL goes on the visible header first; PIPELINE STALE is the same
     width-budget so it stays in the tooltip when the book is already frozen. */
  const cd = ageDays(state.pipelineLastCardAt);
  const intelStale = !!(state.pipelineLastCardAt && cd != null && cd * 24 >= 6);
  if (intelStale) {
    bits.push(`INTEL ${newsAgeTxt(cd)} STALE`);
    why.push(`Newest intel card is ${newsAgeTxt(cd)} old. Cycles can keep running while synthesis writes nothing — that is a frozen book, not a quiet tape.`);
  }
  const pd = ageDays(state.pipelineAt);
  if (!state.pipelineAt) {
    bits.push("PIPELINE OFFLINE");
    why.push("The upstream research pipeline reported no cycle at all — nothing new is being written.");
  } else if (pd != null && pd * 24 >= 6) {
    if (!intelStale) bits.push(`PIPELINE ${newsAgeTxt(pd)} STALE`);
    why.push(`Pipeline last cycled ${state.pipelineNote.replace(/^PIPELINE /, "")} — ${newsAgeTxt(pd)} ago. Rows stop arriving when it stops running.`);
  } else {
    why.push(`Pipeline last cycled ${newsAgeTxt(pd)} ago.`);
  }
  el.textContent = bits.join(" · ");
  el.title = why.join(" ");
}

function renderNews(news, meta) {
  state.news = news;
  if (meta) state.newsMeta = meta;
  updateNewsMeta();
  const empty = (meta && meta.mode === "cn")
    ? ("no material headlines for " + esc(meta.base || baseSym(state.sel)) +
       " — this name, not a quiet market")
    : "no material news";
  $("news").innerHTML = news.length ? news.map((n) => {
    // Every neighbouring surface on this desk dates itself; this one dropped
    // published_at on the floor while rendering three-day-old headlines.
    const d = ageDays(n.published_at);
    const at = newsAgeTxt(d);
    const cls = d == null ? "na unk" : d >= 1 ? "na old" : "na";
    // http(s) only — see safeHref. A url this origin will not follow renders
    // as the plain headline, which is what the row was for anyway.
    const href = safeHref(n.url);
    return `<div class="nrow" data-sym="${esc(n.base_symbol)}"><span class="ns">${esc(n.base_symbol)}</span>` +
    `<span class="nh">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(n.headline)}</a>` : esc(n.headline)}</span>` +
    `<span class="${cls}" title="${esc(n.published_at ? "published " + n.published_at : "this row carries no publish time — its age is UNKNOWN")}">${esc(at)}</span>` +
    `<span class="nc">${esc(n.category || "")}</span></div>`;
  }).join("")
    : '<div class="empty">' + empty + '</div>';
}

$("news").addEventListener("click", (e) => {
  if (e.target.closest("a")) return;
  const row = e.target.closest(".nrow");
  if (!row || !row.dataset.sym) return;
  const sym = row.dataset.sym;
  const coin = exactCoin(sym) || exactCoin("xyz:" + sym) ||
               (state.universe.equity && state.universe.equity["xyz:" + sym] ? "xyz:" + sym : null) ||
               (state.universe.crypto && state.universe.crypto[sym] ? sym : null);
  if (coin && coin !== state.sel) selectCoin(coin);
});

function renderResearch(d) {
  state.cards = d.cards || [];
  state.pipelineAt = (d.pipeline && (d.pipeline.timestamp || d.pipeline.cycle_id)) || null;
  state.pipelineLastCardAt = (d.pipeline && d.pipeline.last_intel_card_at) || null;
  state.pipelineNote = (d.pipeline && d.pipeline.cycle_id)
    ? "PIPELINE " + d.pipeline.cycle_id + "Z" : "PIPELINE OFFLINE";
  updateNewsMeta();
  renderIntel();
}

/* ---------------- intel stack ----------------
   One ranked feed instead of three competing blocks. Every item declares its
   source, and confluence (a scored setup carrying badges) pins to the top. */
const INTEL_KIND = {
  signal: { label: "SIGNAL", cls: "k-signal" },
  desk: { label: "DESK", cls: "k-desk" },
  insider: { label: "INSIDER", cls: "k-insider" },
  news: { label: "NEWS", cls: "k-news" },
};

function ageDays(dstr) {
  if (!dstr) return null;
  // Pipeline writes "YYYY-MM-DD HH:MM:SS" (UTC) and EDGAR writes "YYYY-MM-DD";
  // both must be read as UTC or every age is off by the browser's offset.
  let iso = String(dstr).trim().replace(" ", "T");
  if (!/[Zz]|[+-]\d\d:?\d\d$/.test(iso)) iso += iso.length <= 10 ? "T00:00:00Z" : "Z";
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return (Date.now() - d.getTime()) / 86400000;
}

function buildIntel() {
  const items = [];
  const sigByCoin = {};
  const sigs = (state.signals && state.signals.signals) || [];
  for (const s of sigs) sigByCoin[s.coin] = s;

  // 1. confluence — scored setups carrying badges, the highest-value items
  for (const s of sigs) {
    if (!s.badges || !s.badges.length) continue;
    items.push({
      kind: "signal", coin: s.coin, sym: baseSym(s.coin), pinned: true,
      weight: 1000 + s.score,
      title: `${s.direction ? s.direction.toUpperCase() + " " : ""}score ${Math.round(s.score)}`,
      badges: s.badges,
      detail: (s.top_factors || []).join(" + ") +
        (s.catalyst ? ` · ${s.catalyst.type} in ${s.catalyst.days}d ±${s.catalyst.move_pct}%` : "") +
        (s.thin ? " · THIN" : ""),
    });
  }

  // 2. desk cards — actionable outranks forming outranks watch
  const stateW = { actionable: 300, setup_forming: 200, watch: 100, no_trade: 0, invalidated: 0 };
  for (const c of state.cards || []) {
    const age = ageDays(c._created_at);
    items.push({
      kind: "desk", coin: exactCoin(c.asset) || exactCoin(c.base_symbol) || "",
      sym: c.base_symbol || baseSym(c.asset),
      weight: (stateW[c.state] || 50) + (c.llm_interest_level || 0) -
        Math.min(60, (age || 0) * 2),
      title: `${(c.direction || "none").toUpperCase()} ${(c.state || "").replace(/_/g, " ")}`,
      dir: (c.direction || "none").toLowerCase(),
      detail: c.entry_low != null
        ? `E ${c.entry_low}–${c.entry_high} · S ${c.invalidation} · T ${(c.targets || []).join("/")}`
        : (c.thesis || "").slice(0, 90),
      age,
    });
  }

  // 3. insider clusters — conviction decayed by staleness
  for (const cl of state.insiders || []) {
    const age = ageDays(cl.last_buy);
    items.push({
      kind: "insider", coin: exactCoin(cl.ticker) || "", sym: cl.ticker,
      weight: 120 + Math.min(80, cl.n_insiders * 12) +
        Math.min(60, (cl.total_buy_usd || 0) / 5e5) - Math.min(80, (age || 0) * 2),
      title: `${cl.n_insiders}× bought $${fmtBig(cl.total_buy_usd)}`,
      detail: (cl.buyers || []).slice(0, 2)
        .map((b) => `${b.name.split(" ")[0]}${b.role ? " (" + b.role + ")" : ""}`).join(", "),
      age,
    });
  }

  // 4. material news, but only for names the terminal is actually tracking —
  //    the wide NEWS river below already carries the unfiltered feed.
  const tracked = new Set([
    ...Object.keys(sigByCoin).map(baseSym),
    ...(state.cards || []).map((c) => c.base_symbol),
    ...(state.insiders || []).map((c) => c.ticker),
    ...state.watchEquity.map(baseSym), ...state.watchCrypto,
  ]);
  for (const n of (state.news || []).slice(0, 40)) {
    if (!tracked.has(n.base_symbol)) continue;
    items.push({
      kind: "news", coin: exactCoin(n.base_symbol) || "", sym: n.base_symbol,
      weight: 60, title: n.headline, url: n.url, detail: n.category || "",
    });
  }

  // Per-source quotas: a plain weight sort lets the ~28 desk cards swallow the
  // whole feed, which would make this the desk panel under a new name. Each
  // source keeps its own ranking; the quota only decides how many it gets.
  const QUOTA = { signal: 6, desk: 8, insider: 5, news: 5 };
  const byKind = {};
  for (const it of items) (byKind[it.kind] = byKind[it.kind] || []).push(it);
  const chosen = [];
  for (const [kind, list] of Object.entries(byKind)) {
    list.sort((a, b) => b.weight - a.weight);
    chosen.push(...list.slice(0, QUOTA[kind] || 4));
  }
  chosen.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.weight - a.weight);
  return chosen;
}

function renderIntel() {
  // The INTEL STACK panel was replaced by BOTH SIDES. buildIntel() still runs
  // because state.cards / state.insiders feed the dossier and the SIGNALS
  // tab; only the panel that duplicated them is gone.
  /* #res-meta went with the INTEL STACK panel, so this null-guard swallowed
     state.pipelineNote on every poll — including the one value that mattered,
     "PIPELINE OFFLINE". The note now lands in #news-meta (see updateNewsMeta),
     which is where the pipeline's only surviving visible output lives, and the
     dead write is gone rather than left looking like coverage that exists. */
  const el = $("cards");
  if (!el) return;
  const items = buildIntel();
  if (!items.length) { el.innerHTML = '<div class="empty">no intel yet</div>'; return; }
  el.innerHTML = items.map((it) => {
    const k = INTEL_KIND[it.kind];
    const badges = (it.badges || []).map((b) =>
      `<span class="badge ${b.tag.replace(/[^A-Z]/g, "")}" title="${esc(b.why)}">${esc(b.tag)}</span>`).join("");
    // buildIntel() carries news urls through unchanged, so this is the third
    // render site fed by the same pipeline. Allowlisted like the other two.
    const iHref = safeHref(it.url);
    const title = iHref
      ? `<a href="${esc(iHref)}" target="_blank" rel="noopener">${esc(it.title)}</a>`
      : esc(it.title);
    const age = it.age != null
      ? `<span class="i-age">${it.age < 1 ? "today" : Math.round(it.age) + "d"}</span>` : "";
    return `<div class="irow${it.pinned ? " pin" : ""}${it.coin ? "" : " noclick"}" data-coin="${esc(it.coin)}">` +
      `<span class="i-kind ${k.cls}">${k.label}</span>` +
      `<span class="i-sym">${esc(it.sym)}</span>` +
      `<span class="i-body"><span class="i-title ${it.dir || ""}">${title}</span>${badges}` +
      (it.detail ? `<span class="i-detail">${esc(it.detail)}</span>` : "") + `</span>` +
      age +
      (it.coin ? '<span class="i-dossier" title="open dossier">⋯</span>' : "") +
      `</div>`;
  }).join("");
  el.querySelectorAll(".irow").forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest("a")) return;
      const coin = row.dataset.coin;
      if (!coin) return;
      if (e.target.classList.contains("i-dossier")) openDossier(coin);
      else selectCoin(coin);
    };
  });
}

/* renderFunding() lived here and is DELETED (2026-08-18). It rendered the
   crowded-funding chips into #funding-strip, which went with the INTEL STACK
   panel — the element is in no HTML this app serves, so the function's first
   act was to look it up, not find it, and return. Its caller in loadSlow() and
   the #funding-strip / .fchip rules in style.css went with it. The FUND tab
   is the surviving funding surface and it ranks the whole universe, which is
   the wider scope of the two. */

/* ══════════════════════════════════════════════════════════════════════
   BOTH SIDES — one instrument, every dataset that has a side
   ══════════════════════════════════════════════════════════════════════
   His brief, verbatim: "I want it to have all data at one place so i can see
   the buy and sell side to get the whole picture." That is a PER-INSTRUMENT
   question, and answering it used to mean visiting up to five panes that
   share a single slot (#wbody) plus a canvas gutter that is suppressed
   whenever HEAT fits. This pane answers it in one column.

   Every block renders on the SAME rail with the waterline pinned at 50%.
   Left of the line is BID / BUY / LONG / longs-pay / you-are-long; right is
   ASK / SELL / SHORT. The centre is pinned rather than data-derived because
   the whole value of the stack is comparing six bars down one column by eye.

   WHAT IT REFUSES TO DO
   - No venue ranking, no fill-cost estimate, no routing. At his measured
     $5-10k clip, impact is 0.001%-0.046% and xyz quotes 0.13-3.24bps, so
     execution cost is not the question. Presence and drain are. Depth is
     therefore quoted in CLIPS — his size is the denominator that turns a
     dollar figure into a presence read.
   - No directional claim, anywhere. Recorded research: 1h flow-to-direction
     correlation +0.005 across 534 minute-horizon hypotheses with fees 17x
     the best edge, and this terminal's own divergence annotation tested
     NO-GO. Resting depth is CANCELLABLE — it is where liquidity is SHOWN.
   - No summary score. Nine readings, no synthesis: synthesis is where a
     read-only terminal starts implying a trade.
   - No summed open interest, and no summed account value across venues. */

const CLIP_KEY = "hlterm_clip_usd";
const SIDES_POLL_MS = 12000;
/* The depth store samples once a minute; the pane polls every 12s. A snapshot
   older than this has missed at least two of its own sampling intervals, which
   is the point where "the book" becomes "a photograph of the book". */
const SIDES_BANDS_STALE_MS = 150000;

/* Degrade tiers, keyed to the height the pane ACTUALLY has. Shedding
   detail beats clipping it, and it beats scrolling to it: the whole value
   of the stack is that every block sits at a fixed y. Tier 0 is the desk
   layout the pane was budgeted for (1728x1000 -> an 845px body); each
   tier below it gives up ladder levels first, then prose, and never gives
   up a coverage statement or a gap warning. */
function sidesTier() {
  const b = $("sides-body");
  const h = (b && b.clientHeight) || 845;
  return h >= 800 ? 0 : h >= 700 ? 1 : h >= 610 ? 2 : 3;
}
function sidesLevels() { return [6, 5, 4, 3][sidesTier()]; }

/* Set by the single measured retry in renderSides(): the height tiers cannot
   know in advance whether the YOU block holds a position (empty 50px, filled
   ~160px) or whether a gap warning fired, so prose density is decided by
   MEASURING the rendered pane once and re-rendering compact if it did not
   fit. Compact never removes a coverage fact or a gap warning — it folds
   standing caveats into the title and leaves a visible marker. */
let sdCompact = false;
function sdTight() { return sdCompact || sidesTier() >= 2; }

function sdClip() {
  try {
    const v = +localStorage.getItem(CLIP_KEY);
    return v > 0 ? v : 10000;
  } catch (e) { return 10000; }
}
function sdClips(usd) {
  const c = sdClip();
  if (usd == null || !isFinite(usd) || !c) return null;
  return usd / c;
}
function sdClipTxt(usd) {
  const n = sdClips(usd);
  if (n == null) return "–";
  return n >= 1000 ? (n / 1000).toFixed(1) + "Kc"
       : n >= 10 ? Math.round(n) + "c"
       : n >= 1 ? n.toFixed(1) + "c" : n.toFixed(2) + "c";
}
function sdPct(v, dp) {
  if (v == null || !isFinite(v)) return "–";
  return (v >= 0 ? "+" : "") + v.toFixed(dp == null ? 1 : dp) + "%";
}
function sdCls(v) { return v == null ? "fl" : v > 0 ? "up" : v < 0 ? "dn" : "fl"; }

/* Guard the field you are about to dereference, not a neighbouring one.
   `x != null` in front of `y.toFixed()` is not a guard, it is a coincidence
   that has held so far. */
const sdNum = (v) => (typeof v === "number" && isFinite(v) ? v : null);

/* Age in words. A cached number that cannot say how old it is has no business
   sitting next to live ones wearing the same face. */
function sdAgo(ms) {
  if (ms == null || !isFinite(ms)) return "unknown age";
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "m"
                                     : (s / 3600).toFixed(1) + "h";
}

/* THE SAME AGE, FOR A LOWER BOUND — floor where sdAgo rounds. sdAgo is built
   for "this is how old it is" and rounds to the nearest unit, which is right
   there and wrong the moment the number carries a "+": a 90s bound printed as
   "2m+" claims 30 more seconds of silence than was measured, and a 9m54s bound
   printed as "10m+" claims 6. Truncating can only ever understate a bound,
   which keeps the claim true; rounding can falsify it. */
function sdAgoFloor(ms) {
  if (ms == null || !isFinite(ms)) return "unknown age";
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m"
                                     : (Math.floor(s / 360) / 10).toFixed(1) + "h";
}

/* AGE, without trusting two clocks against each other. A server stamp minus a
   client Date.now() is a clock-skew measurement wearing an age's clothes, so
   every age below is built from two SERVER stamps (the payload's own build
   time minus the event time) plus two CLIENT stamps (now minus when that
   payload landed). Neither difference ever crosses machines. `d.at` is the
   server-side epoch seconds the /api/sides payload was assembled at. */
function sdNow(d) {
  const at = d && d.at ? d.at * 1000 : null;
  const since = state.sidesAt ? Math.max(0, Date.now() - state.sidesAt) : 0;
  return at == null ? Date.now() : at + since;
}
/* A server-computed age_s, carried forward by however long the payload has
   been standing on screen. The poll is 12s and the pane deliberately keeps the
   last good payload through an outage, so the shipped number on its own always
   understates the age of what the eye is actually looking at. */
function sdAgeFrom(secs) {
  if (secs == null || !isFinite(secs)) return null;
  const since = state.sidesAt ? Math.max(0, Date.now() - state.sidesAt) : 0;
  return Math.max(0, secs * 1000 + since);
}

/* THE RAIL. Both halves scale to the larger side, so the imbalance reads as
   asymmetry across the waterline rather than as two independent bars.
   `clipRule` puts a 1px cyan tick where ONE clip lands on this scale — drawn
   only when it is far enough from the centre to resolve at 1 device pixel,
   because a tick sitting on the waterline is a lie about resolution. */
function sdRail(l, r, opt) {
  opt = opt || {};
  const L = Math.max(0, +l || 0), R = Math.max(0, +r || 0);
  const m = Math.max(L, R) || 1;
  const lw = L / m * 50, rw = R / m * 50;
  const cls = opt.tall ? "sd-rail tall" : "sd-rail";
  let h = `<span class="${cls}"${opt.title ? ` title="${esc(opt.title)}"` : ""}>`;
  const ln = opt.neutral || opt.lNeutral, rn = opt.neutral || opt.rNeutral;
  if (L > 0) h += `<span class="sd-b l${ln ? " neutral" : ""}" style="width:${lw.toFixed(2)}%"></span>`;
  if (R > 0) h += `<span class="sd-b r${rn ? " neutral" : ""}" style="width:${rw.toFixed(2)}%"></span>`;
  if (opt.clipRule) {
    const cw = sdClip() / m * 50;
    if (cw >= 2 && cw <= 49) {
      h += `<span class="sd-clip" style="left:calc(50% - ${cw.toFixed(2)}%)"></span>`;
      h += `<span class="sd-clip" style="left:calc(50% + ${cw.toFixed(2)}%)"></span>`;
    }
  }
  if (opt.lt) h += `<span class="sd-bt l${lw < 16 ? " out" : ""}">${esc(opt.lt)}</span>`;
  if (opt.rt) h += `<span class="sd-bt r${rw < 16 ? " out" : ""}">${esc(opt.rt)}</span>`;
  return h + "</span>";
}

function sdRow(label, rail, value, vcls, title) {
  return `<div class="sd-row"${title ? ` title="${esc(title)}"` : ""}>` +
    `<span class="sd-l">${esc(label)}</span>${rail}` +
    `<span class="sd-v ${vcls || ""}">${value}</span></div>`;
}

/* opt.cls marks the note stale in the pane's shared vocabulary (sd-old, amber);
   opt.title carries the long form of a claim the 8px header can only summarise.
   Both optional — every existing caller passes a plain note and is unchanged. */
function sdHead(name, note, opt) {
  opt = opt || {};
  return `<div class="sd-h"><span>${esc(name)}</span>` +
    (note ? `<span class="sd-hn${opt.cls ? " " + opt.cls : ""}"` +
      (opt.title ? ` title="${esc(opt.title)}"` : "") +
      `>${esc(note)}</span>` : "") + `</div>`;
}

/* NEWEST PRINT STAMP ON THIS PAGE'S OWN FEED for the coin on screen — the feed
   LIVE PRINTS is drawn from, which is NOT the server-side collector the
   AGGRESSOR FLOW block reads. Returned as the exchange's own epoch ms and
   compared only against other exchange-stamped values (bucket boundaries),
   never turned into an age against this machine's clock.
   null = this page has heard no print for this coin since it was selected,
   which is not the same as the market being quiet and is never drawn as if it
   were: a claim that needs this number is simply not made. */
function sdPagePrintMs() {
  if (state.tradeSeenCoin !== state.sel || !state.tradeSeenMs) return null;
  return state.tradeSeenMs;
}

/* A record that covers 17 of 60 minutes STARTS 72% of the way across its own
   track. A footnote saying so is not the same thing: a short history has to
   LOOK short, or the eye reads a full-width line as a full-width record. */
function sdSpark(vals, coveredFrac) {
  if (!vals || vals.length < 2) return "";
  const lo = Math.min(...vals), hi = Math.max(...vals), sp = (hi - lo) || 1;
  const f = Math.max(0.02, Math.min(1, coveredFrac == null ? 1 : coveredFrac));
  const x0 = (1 - f) * 100;
  const pts = vals.map((v, i) =>
    `${(x0 + i / (vals.length - 1) * (100 - x0)).toFixed(2)},` +
    `${(10 - (v - lo) / sp * 9 - 0.5).toFixed(2)}`).join(" ");
  return `<svg class="sd-spark" viewBox="0 0 100 10" preserveAspectRatio="none" ` +
    `style="position:absolute;inset:0;width:100%;height:100%">` +
    `<polyline points="${pts}" fill="none" stroke="#3aa0ff" stroke-width="0.7" ` +
    `vector-effect="non-scaling-stroke"/></svg>`;
}

/* The ladder's own refresh. /api/book is cached 1s server-side, so a 3s
   client poll is at most 20 upstream l2Book calls a minute — and the
   aggregation (nSigFigs) is what makes the ladder readable at all. */
const SIDES_BOOK_MS = 3000;
const SIDES_BOOK_SIG = 4;

/* A failed poll is a FACT about the ladder, not a non-event. This used to
   `return` silently "to keep the last good ladder", and because the cache
   carried no timestamp the ladder it kept could be any age at all — a real
   `HTTP Error 429: Too Many Requests` from /api/book sat behind six stale
   price levels with nothing on screen to say so. */
function sidesBookFailed(coin, msg) {
  if (coin !== state.sel) return;            // the failure belongs to a symbol
  state.sidesBookErr = { coin, msg: msg || "book refresh failed", at: Date.now() };
  renderSidesLadder();                       // and re-draw, so the age advances
}

async function loadSidesBook() {
  const coin = state.sel;
  if (!coin || !document.getElementById("sd-ladder")) return;
  try {
    const r = await fetch(`/api/book?coin=${encodeURIComponent(coin)}&sig=${SIDES_BOOK_SIG}`);
    const d = await r.json();
    if (d.coin !== state.sel) return;         // symbol changed mid-flight
    if (d.error) { sidesBookFailed(coin, d.error); return; }
    const mk = (rows) => (rows || []).map((l) => ({ px: l.px, usd: l.px * l.sz }));
    // Carry the SERVED spread. This ladder is aggregated at nSigFigs=4, where
    // top-of-book minus top-of-book is the bucket width — 10x the real
    // spread on every symbol measured.
    // `at` is not decoration: it is what lets the ladder be shown as OLD
    // rather than shown as current.
    /* request_note is the server saying it did not run the request as asked
       — today only for `sig`, which it coerces to one of [3,4,5] rather than
       rejecting. This client always sends SIDES_BOOK_SIG=4, so the note
       cannot fire from here right now; it is carried anyway because the
       ladder's whole readability argument rests on its aggregation level,
       and a substituted one that nothing reports would make every price on
       this ladder a bucket the reader did not choose. Cheap to carry, and
       the alternative is a silent substitution. */
    state.sidesBook = { coin, bids: mk(d.bids), asks: mk(d.asks),
                        spread_bps: d.spread_bps, spread_src: d.spread_src,
                        req_note: d.request_note || null, sig: d.sig,
                        at: Date.now() };
    state.sidesBookErr = null;
    renderSidesLadder();
  } catch (e) { sidesBookFailed(coin, (e && e.message) || String(e)); }
}

async function loadSides() {
  const coin = state.sel;
  if (!coin) return;
  const qs = new URLSearchParams({ coin, clip: String(sdClip()) });
  const addr = portAddr();
  if (addr) qs.set("addr", addr);
  try {
    const r = await fetch("/api/sides?" + qs.toString());
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    // BEFORE the identity check, not after: a 200-error payload carries no
    // `coin`, so `d.coin !== state.sel` swallowed it as "the user moved on"
    // and returned without ever setting sidesError — the pane went on drawing
    // the last book with no banner, which is precisely the state the banner
    // at the bottom of renderSides was written to prevent.
    if (d && d.error) throw new Error(d.error);
    if (d.coin !== state.sel) return;          // user moved on mid-flight
    state.sides = d;
    state.sidesAt = Date.now();
    state.sidesError = null;
  } catch (e) {
    // The payload from the last SUCCESSFUL poll is deliberately kept — a
    // pane that blanks on one blip is worse than one that keeps the last
    // book. But renderSides now has to say the numbers are that old and
    // that the refresh is failing; see the banner it draws.
    state.sidesError = (e && e.message) || String(e);
  }
  renderSides();
}

/* ── block 1 · LADDER ──────────────────────────────────────────────────
   Drawn from the LIVE websocket book when there is one (full precision, the
   top of book, which is the zone a $5-10k clip actually fills in), and from
   the server's aggregated snapshot otherwise. The wider distances are the
   BANDS block's job, and the mid row states how far this ladder reaches so
   the two are never confused. */
/* How old a cached ladder may be before it stops counting as "the book".
   The poll is every 3s, so past four missed polls this is a photograph, and
   past DROP it is not shown at all — an hour-old ladder is not a ladder. */
const SIDES_BOOK_STALE_MS = 12000;
const SIDES_BOOK_DROP_MS = 90000;

function sidesLadderHtml() {
  const d = state.sides || {};
  const cache = state.sidesBook && state.sidesBook.coin === state.sel
    ? state.sidesBook : null;
  const cacheAge = cache ? Date.now() - (cache.at || 0) : null;
  const served = d.book || {};
  const servedRows = (served.bids || []).length && (served.asks || []).length;
  const servedAge = state.sidesAt ? Date.now() - state.sidesAt : null;
  const bookErr = (state.sidesBookErr && state.sidesBookErr.coin === state.sel)
    ? state.sidesBookErr.msg : null;
  /* The cached ladder used to win over the served book UNCONDITIONALLY and
     without an age, so a served book.err was unreachable while any cache
     survived. Order now: a genuinely fresh cache, else the served snapshot,
     else the cache while it is still worth showing — and whichever is used
     carries its age out of here. */
  let sb = null, ageMs = null;
  if (cache && cacheAge <= SIDES_BOOK_STALE_MS) { sb = cache; ageMs = cacheAge; }
  else if (servedRows) { sb = served; ageMs = servedAge; }
  else if (cache && cacheAge <= SIDES_BOOK_DROP_MS) { sb = cache; ageMs = cacheAge; }
  const src = { bids: (sb && sb.bids) || [], asks: (sb && sb.asks) || [] };
  if (!src.bids.length || !src.asks.length) {
    const why = bookErr || served.err ||
      (cache ? `no fresh book for ${sdAgo(cacheAge)} — the last ladder was ` +
               `dropped rather than left on screen looking current`
             : "awaiting book…");
    return '<div class="sd-empty">' + esc(why) + '</div>';
  }
  const stale = ageMs == null || ageMs > SIDES_BOOK_STALE_MS;
  const n = sidesLevels();
  const bids = src.bids.slice(0, n), asks = src.asks.slice(0, n);
  const mid = (bids[0].px + asks[0].px) / 2;
  const m = Math.max(...bids.map((l) => l.usd), ...asks.map((l) => l.usd)) || 1;
  const cw = sdClip() / m * 100;
  const row = (l, side) => {
    const w = l.usd / m * 100;
    const bar = `<span class="sd-rail">` +
      `<span class="sd-b ${side === "bid" ? "l" : "r"}" style="width:${(w / 2).toFixed(2)}%"></span>` +
      (cw >= 4 && cw <= 98
        ? `<span class="sd-clip" style="left:calc(50% ${side === "bid" ? "-" : "+"} ${(cw / 2).toFixed(2)}%)"></span>`
        : "") + `</span>`;
    const bps = Math.abs(l.px - mid) / mid * 1e4;
    return `<div class="sd-lrow ${side}" title="${esc(fmtPx(l.px))} · ` +
      `${bps.toFixed(2)}bps from mid · $${fmtBig(l.usd)} = ${esc(sdClipTxt(l.usd))} at ` +
      `a $${fmtBig(sdClip())} clip">` +
      `<span class="sd-lp">${fmtPx(l.px)}</span>${bar}` +
      `<span class="sd-lu">$${fmtBig(l.usd)}</span>` +
      `<span class="sd-lc">${esc(sdClipTxt(l.usd))}</span></div>`;
  };
  /* NOT derived from this ladder. At nSigFigs=4 the aggregation bucket is
     exactly 10x the true tick, so the old expression reported 10x the spread
     — BTC 1.60bps against a real 0.1595, xyz:SNDK 6.24 against 0.6174 —
     while the depth store two blocks down held the right number the whole
     time. Both book sources now serve Hyperliquid's own full-precision
     `spread` field; the derivation survives only as a labelled fallback.
     (The chart's BOOK gutter was never wrong: it reads the websocket book,
     which is unaggregated.) */
  const spread = sb.spread_bps != null
    ? sb.spread_bps * 10 : (asks[0].px - bids[0].px) / mid * 1e4;
  // The ladder's own statement of its resolution is the right place for the
  // server's note about the resolution it actually used.
  const reqNote = (sb && sb.req_note) || null;
  const spreadTitle = (sb.spread_src === "exchange"
    ? "spread as the exchange reports it, at full precision — the ladder " +
      "above is aggregated, so its top two prices are one bucket apart, " +
      "not one tick"
    : (sb.spread_src || "derived from the aggregated ladder — upper bound")) +
    (reqNote ? " · REQUEST ALTERED: " + reqNote : "");
  const reach = Math.min(
    (mid - bids[bids.length - 1].px) / mid * 1e4,
    (asks[asks.length - 1].px - mid) / mid * 1e4);
  const bandRow = (d.bands && (d.bands.rows || [])
    .find((r) => r.band_bps === (d.bands.ref_bps || 25))) || null;
  /* THE SAME SNAPSHOT, borrowed. This is the depth-sample band figure that
     DEPTH BY DISTANCE now dates and fades — printed here INLINE WITH A LIVE
     LADDER, where it reads as part of the current book. On xyz:GOLD that was a
     57-minute-old number sitting in the mid row of a fresh ladder. There is no
     room on this row for an age, so past the staleness bound the figure is
     dropped rather than dated: the block below still shows it, faded, with its
     age in its header, which is where a stale measurement belongs. */
  const bandAge = sdAgeFrom(d.bands && d.bands.age_s);
  const bandOld = bandAge == null || bandAge > SIDES_BANDS_STALE_MS;
  const wide = bandRow && bandRow.bid_usd != null && !bandOld
    ? `±${bandRow.band_bps}bps $${fmtBig(bandRow.bid_usd)} / $${fmtBig(bandRow.ask_usd)}`
    : `${n} levels a side`;
  const wideTitle = bandRow && bandRow.bid_usd != null && bandOld
    ? `the ±${bandRow.band_bps}bps depth figure this row usually carries comes ` +
      `from a sample ${bandAge == null ? "of unknown age" : sdAgo(bandAge) + " old"}` +
      `, so it is not shown beside a live ladder — DEPTH BY DISTANCE below has ` +
      `it, dated and faded`
    : "how far the ladder above reaches";
  const lm = document.getElementById("sd-lmeta");
  if (lm) {
    const base = src.bids.length > n
      ? `${n} of ${src.bids.length} levels a side · shown, not committed`
      : "shown, not committed";
    // A failing refresh is said the moment it fails, before the ladder is old
    // enough for the banner — the header is where "this is not updating" goes.
    const errNote = bookErr ? "refresh failing"
                  : served.err ? "server book error" : "";
    const flag = stale ? `${sdAgo(ageMs)} old${errNote ? " · " + errNote : ""}`
                       : errNote;
    lm.textContent = flag ? `${flag} · ${base}` : base;
    lm.title = [
      src.bids.length > n
        ? `the pane is shorter than the full ladder, so it shows the ${n} ` +
          `nearest aggregated levels a side out of ${src.bids.length}`
        : "",
      bookErr ? `last /api/book refresh failed: ${bookErr}` : "",
      served.err ? `/api/sides served its book as: ${served.err}` : "",
      stale ? `these prices arrived ${sdAgo(ageMs)} ago` : "",
    ].filter(Boolean).join(" · ");
  }
  const rows = asks.map((l) => row(l, "ask")).reverse().join("") +
    `<div class="sd-mid" title="the ladder above reaches ${reach.toFixed(1)}bps ` +
    `from mid; the DEPTH BY DISTANCE block below covers the wider bands">` +
    `<span class="sd-mp">${fmtPx(mid)}</span>` +
    `<span class="sd-ms" title="${esc(spreadTitle)}">${spread.toFixed(2)}bps</span>` +
    `<span class="sd-mr" title="${esc(wideTitle)}">${esc(wide)}</span></div>` +
    bids.map((l) => row(l, "bid")).join("");
  /* A substituted aggregation is a fact about EVERY price above it, so it
     gets a visible line and not only a tooltip. A note the reader has to
     hover to find is the same silence in a thinner coat. */
  const reqLine = reqNote
    ? `<div class="sd-gap">book request altered by the server — ` +
      `<b>${esc(reqNote)}</b>. The ladder is drawn at the resolution the ` +
      `server used, not the one asked for.</div>`
    : "";
  if (!stale) return reqLine + rows;
  // Shown, but never as the current book: banner with the real age and the
  // real reason, and the prices themselves faded so the eye cannot mistake
  // a frozen ladder for a live one.
  const why = bookErr ? `refresh failing — ${bookErr}`
            : served.err ? `server book error — ${served.err}`
            : "no fresh book has arrived";
  return reqLine + `<div class="sd-gap">ladder is <b>${esc(sdAgo(ageMs))} old</b> · ` +
    `${esc(why)} — these are the last prices that arrived, not the ` +
    `current book</div><div class="sd-fade">${rows}</div>`;
}

function renderSidesLadder() {
  const el = document.getElementById("sd-ladder");
  if (!el) return;
  el.innerHTML = sidesLadderHtml();
}

/* ── block 8 · TAPE ────────────────────────────────────────────────────
   Renders exactly as many prints as FIT and says how many it held. The
   sidebook's time & sales draws 40 rows into 214px and silently clips 27 of
   them; a pane that cannot be scrolled must not repeat that. */
function renderSidesTape() {
  const box = document.getElementById("sd-trows");
  if (!box) return;
  const note = document.getElementById("sd-tnote");
  const say = (txt) => {
    if (!note) return;
    note.hidden = !txt;
    note.textContent = txt || "";
  };
  /* Clear the note BEFORE measuring. It is a sibling in the same column and
     the rows box is the flexible one, so a note left standing from the last
     pass eats the very height that decides whether the note is needed —
     which latches: once shown it starved the box on every subsequent tape
     tick and never came back, even after the space it was reporting on had
     returned. Measure the box as it is when the note is not in the layout. */
  say("");
  const held = state.trades || [];
  const h = box.clientHeight || 0;
  const n = Math.floor(h / 13);
  const meta = document.getElementById("sd-tmeta");
  const sizes = held.slice(0, 60).map((t) => t.ntl || t.sz * t.px).sort((a, b) => a - b);
  const p90 = sizes.length ? sizes[Math.floor(sizes.length * 0.9)] : 1;
  if (!held.length) {
    if (meta) meta.textContent = "no prints yet · IST";
    box.innerHTML = '<div class="sd-empty">no prints since this pane opened</div>';
    return;
  }
  // Too short for even one row: collapse to the summary rather than clip.
  // The FLOW block above carries the same information at lower resolution,
  // which is exactly why this is the block that gives way.
  if (n < 1) {
    const buy = held.filter((t) => t.side === "B")
      .reduce((a, t) => a + (t.ntl || t.sz * t.px), 0);
    const all = held.reduce((a, t) => a + (t.ntl || t.sz * t.px), 0) || 1;
    if (meta) meta.textContent = "no room for rows";
    box.innerHTML = "";
    say(`buy ${Math.round(buy / all * 100)}% / ` +
      `sell ${Math.round(100 - buy / all * 100)}% of $${fmtBig(all)} over ` +
      `${held.length} held prints — the pane is too short to list them`);
    return;
  }
  if (meta) {
    meta.textContent = `${Math.min(n, held.length)} of ${held.length} held · IST`;
  }
  box.innerHTML = held.slice(0, n).map((t) => {
    const ntl = t.ntl || t.sz * t.px;
    const buy = t.side === "B";
    const w = Math.min(50, ntl / (p90 || 1) * 25);
    return `<div class="sd-trow ${buy ? "buy" : "sell"}${ntl >= p90 ? " big" : ""}" ` +
      `title="${esc(t.time)} · ${buy ? "BUY lifted the ask" : "SELL hit the bid"} · ` +
      `$${fmtBig(ntl)} = ${esc(sdClipTxt(ntl))}">` +
      `<span class="sd-tt">${esc(t.time)}</span>` +
      `<span class="sd-rail"><span class="sd-b ${buy ? "l" : "r"}" ` +
      `style="width:${w.toFixed(1)}%"></span>` +
      `<span class="sd-bt ${buy ? "l" : "r"}${w < 16 ? " out" : ""}">$${fmtBig(ntl)}</span></span>` +
      `<span class="sd-tp">${fmtPx(t.px)}</span></div>`;
  }).join("");
}

function sidesIdentHtml(d) {
  const id = d.ident || {};
  const ctx = ctxFor(state.sel) || {};
  const px = state.mids[state.sel] != null ? state.mids[state.sel] : id.px;
  const chg = pct(px, ctx.prev_day_px != null ? ctx.prev_day_px : null);
  const kind = id.venue_kind === "core" ? "core" : id.venue_kind === "hip3" ? "hip3" : "";
  const lst = id.listing || {};
  const lcls = { SOLE: "sole", TWIN: "twin", "THIN-2ND": "thin" }[lst.state] || "unknown";
  const ltitle = (lst.why || "") + (lst.others && lst.others.length
    ? " — also on " + lst.others.map((o) => `${o.venue} ${o.share_pct}%`).join(", ") : "") +
    (lst.split && lst.split.length
      ? " · REFUTED same-ticker match: " + lst.split.map((x) =>
          `${x.venue}:${x.sym} price differs ${x.px_diff_bps}bps`).join(", ") : "") +
    " · " + (lst.note || "");
  const chips =
    `<span class="sd-chip ${kind}" title="${esc(id.venue_note || "the venue this market lives on")}">` +
    `${esc(String(id.venue || "?").toUpperCase())}</span>` +
    `<span class="sd-chip ${lcls}" title="${esc(ltitle)}">${esc(lst.state || "UNKNOWN")}</span>`;
  const l2 = [];
  if (id.venue_vol_24h != null)
    l2.push(`${esc(id.venue)} $${fmtBig(id.venue_vol_24h)}/24h · ${id.venue_markets} mkt` +
      (id.venue_share_pct != null ? ` · ${id.venue_share_pct}% of all venue volume` : ""));
  else if (id.venue_note) l2.push(esc(id.venue_note));
  if (id.mkt_vol_24h != null)
    l2.push(`this market $${fmtBig(id.mkt_vol_24h)}/24h`);
  if (lst.state === "SOLE")
    l2.push('<b title="' + esc(lst.note || "") + '">no second book — if this one pulls there is no fallback</b>');
  else if (lst.others && lst.others.length)
    l2.push("also " + lst.others.map((o) => `${esc(o.venue)} ${o.share_pct}%`).join(" · "));
  return `<div class="sd-blk">` +
    `<div class="sd-id"><span class="sd-px">${fmtPx(px)}</span>` +
    `<span class="sd-chg ${sdCls(chg)}">${sdPct(chg, 2)}</span>${chips}</div>` +
    `<div class="sd-id2">${l2.join(" · ")}</div></div>`;
}

function sidesBandsHtml(d) {
  const b = d.bands || {};
  const dr = d.drain || {};
  const rows = b.rows || [];
  /* HOW OLD THIS BOOK IS. The server has always shipped `age_s` and `at_ms`
     and this block read neither, so six band rows drew as a confident current
     book at any age at all — measured live on xyz:GOLD at age_s 429.9, and
     again at 2809.9 (47 minutes) while the rows carried no marker of any kind.
     That made the two most time-sensitive blocks in the pane the only two
     without an age, next to a WHALE header that prints "110s old" and a DRAIN
     line that prints "8.9h of 48h collected". The age goes in the header note,
     where it costs no height, and past SIDES_BANDS_STALE_MS the rows are faded
     the same way the ladder fades a frozen book. */
  const bAgeMs = sdAgeFrom(b.age_s);
  const bStale = bAgeMs != null && bAgeMs > SIDES_BANDS_STALE_MS;
  const bNote = bAgeMs != null
    ? (bStale ? `${sdAgo(bAgeMs)} old — not the current book`
              : `${sdAgo(bAgeMs)} old`)
    : (b.why || b.err ? "" : "sample age unknown");
  let h = `<div class="sd-blk">` +
    `<div class="sd-h"><span>DEPTH BY DISTANCE</span>` +
    `<span class="sd-hn${bStale ? " sd-old" : ""}" title="${esc(
      "imbalance is a function of range. " + (bAgeMs == null
        ? "This payload carried no sample time, so the rows below cannot be "
          + "dated — they are not being claimed as current."
        : "This is the age of the DEPTH SAMPLE these rows were medianed from, "
          + "not the age of the payload: the store samples once a minute and "
          + "a market that stops printing stops being sampled. Anything past "
          + (SIDES_BANDS_STALE_MS / 1000) + "s is drawn faded."))}">` +
    `${esc(bNote)}</span></div>`;
  // b.why explains why the SAMPLE is missing, and _sides_bands emits its six
  // band rows either way — so gating it on an empty row list dropped the
  // sentence in exactly the case it was written for. Print it whenever it is
  // there; the rows below then read as "no sample", not as a flat book.
  if (b.why || b.err || !rows.length)
    h += `<div class="sd-empty">${esc(b.why || b.err || "no depth sample yet")}</div>`;
  let rh = "";
  for (const r of rows) {
    const lbl = "±" + r.band_bps + "bps";
    if (r.bid_usd == null || r.ask_usd == null) {
      const why = r.unresolved || "not resolvable";
      // A bare em-dash is glyph-identical to a MEASURED unresolvable band, so
      // "never collected" and "collected, book ends here" looked the same.
      const tag = /tick/.test(why) ? "— tick>band"
                : /ends|reaches/.test(why) ? "— book ends"
                : /no sample|NOT COLLECTED|not in the depth/i.test(why)
                  ? "— not collected" : "—";
      rh += sdRow(lbl, `<span class="sd-rail"></span>`, tag, "dim", why);
      continue;
    }
    const rail = sdRail(r.bid_usd, r.ask_usd, {
      lt: sdClipTxt(r.bid_usd), rt: sdClipTxt(r.ask_usd), clipRule: true,
      title: `bid $${fmtBig(r.bid_usd)} (${sdClipTxt(r.bid_usd)}) / ` +
             `ask $${fmtBig(r.ask_usd)} (${sdClipTxt(r.ask_usd)})` +
             (r.repeat ? " — " + r.repeat : "") });
    rh += sdRow(lbl, rail, sdPct(r.chg_1h_pct), sdCls(r.chg_1h_pct),
      (r.repeat ? r.repeat + " · " : "") +
      // A band is a median over only the samples that RESOLVED it, and that
      // subset is not the same for every band in a row.
      (r.thin ? r.thin + " · " : "") +
      "right column is the 1h change in this band's total resting size");
  }
  h += bStale ? `<div class="sd-fade">${rh}</div>` : rh;
  /* The waterline in every block above is drawn from an imbalance, and how
     long an imbalance survives is a property of the instrument — measured
     across the collected set it runs 0.01 to 0.93 and does NOT follow book
     size. Without it, the most lopsided-looking book on the screen and the
     noisiest one are the same row. */
  if (b.imb_note)
    h += `<div class="sd-empty">${esc(b.imb_note)}</div>`;
  // ── DRAIN: the same six bands, read over time instead of over distance.
  const cov = dr.coverage || {};
  const mk = (label, v, extra) => {
    if (v == null) {
      return sdRow(label, `<span class="sd-rail"></span>`, "—", "dim",
        "not enough history — " + (cov.note || "collection starts when the " +
        "coin is subscribed and cannot be backfilled"));
    }
    const rail = sdRail(v > 0 ? Math.abs(v) : 0, v < 0 ? Math.abs(v) : 0,
      { neutral: v < 0, title: (v > 0 ? "grew " : "shrank ") + Math.abs(v).toFixed(1) + "%" });
    return sdRow(label, rail, sdPct(v), sdCls(v), extra);
  };
  const tp0 = dr.taken_pulled || {};
  const tpShort = tp0.ok && tp0.taken_pct != null
    ? `${tp0.taken_pct}% traded / ${tp0.pulled_pct}% cancelled` : "";
  h += `<div class="sd-h" style="margin-top:3px"><span>DRAIN ±${dr.band_bps || 25}BPS</span>` +
    `<span class="sd-hn" title="${esc(tp0.note || "")}">` +
    `${esc(cov.note || "")}${sidesTier() >= 3 && tpShort ? " · " + tpShort : ""}` +
    `</span></div>`;
  const merge1h = sdTight();
  if (dr.bid_1h != null || dr.ask_1h != null) {
    h += sdRow(merge1h ? "Δ1H" : "Δ1H SIDE",
      sdRail(Math.abs(dr.bid_1h || 0), Math.abs(dr.ask_1h || 0),
        { lNeutral: (dr.bid_1h || 0) < 0, rNeutral: (dr.ask_1h || 0) < 0,
          lt: sdPct(dr.bid_1h, 0), rt: sdPct(dr.ask_1h, 0),
          title: "bar LENGTH is the size of the move, dimmed = the side " +
                 "SHRANK. bid " + sdPct(dr.bid_1h) + " / ask " + sdPct(dr.ask_1h) }),
      merge1h ? sdPct(dr.h1) : "bid / ask", merge1h ? sdCls(dr.h1) : "dim",
      "the two sides do not have to move together — this is the row that says " +
      "WHICH side is leaving" +
      (merge1h ? ". Value column is the two sides combined." : ""));
  }
  if (!merge1h)
    h += mk("Δ1H", dr.h1, "total resting size within the reference band, 1h ago vs now");
  h += mk("Δ6H", dr.h6);
  h += mk("Δ24H", dr.h24);
  const tp = sidesTier() >= 3 ? {} : (dr.taken_pulled || {});
  if (tp.ok && tp.taken_pct != null) {
    h += sdTight()
      ? `<div class="sd-why" title="${esc(tp.note || "")}">$${fmtBig(tp.drop_usd)} left ` +
        `the book in 1h — <b>${tp.taken_pct}% traded / ${tp.pulled_pct}% cancelled</b>. ` +
        `Descriptive.</div>`
      : `<div class="sd-why" title="${esc(tp.note || "")}">of the $${fmtBig(tp.drop_usd)} ` +
        `that left the book in the last hour, <b>${tp.taken_pct}% is matched by prints</b> ` +
        `in the same minute and ${tp.pulled_pct}% is not — traded away vs cancelled. ` +
        `Descriptive of what happened; not a forecast.</div>`;
  } else if (tp.why || tp.note) {
    h += `<div class="sd-why">${esc(tp.why || tp.note)}</div>`;
  }
  if (dr.session_caveat)
    h += `<div class="sd-gap">${esc(dr.session_caveat)}</div>`;
  return h + `</div>`;
}

/* THE 60S ROW IS NOT AUTOMATICALLY THE LAST 60 SECONDS. _sides_flow returns
   rows[-1] — the most recent minute bucket that HAS PRINTS — and the collector
   only creates a bucket when a print arrives. On anything that does not trade
   every minute (all 110 xyz equity markets outside US hours, which is most of
   the trading day here) that bucket can be arbitrarily old: measured on
   xyz:GOLD at 433s, and again at 2870s, both drawn as "60S" with the tooltip
   "in the last closed minute". A minute with zero prints and a minute with
   $35K of selling rendered as the same confident dollars.
   `m1.ms` — the bucket's START, already in the payload — is what separates
   them, so the row is now decided by WHICH minute the bucket is:
     · at or after the current minute  -> the still-filling current minute
     · the one before that             -> the last closed minute, as labelled
     · anything older                  -> the last closed minute holds NO
       prints, and the stale bucket's dollars are kept off this rail entirely
       rather than being redated to now.

   THE HEADER MUST NOT OUT-CLAIM THE PAYLOAD EITHER. Dating that stale bucket
   in the header as `last print ${sdAgo(mAge)} ago` swapped one false statement
   for another: m1.ms is a bucket START, so it is neither a print time nor the
   bucket's close, and the sentence was about "prints" with no owner while the
   only tape it could describe is the SERVER's. Measured live 2026-08-14
   23:22:57 IST on BTC, one render, one instant: the header read "last print
   31m ago" while LIVE PRINTS six lines below — this page's own websocket to
   the exchange, a different feed entirely — showed a print stamped 23:22:56,
   one second old, with the server's flow_collector wedged. The pane said two
   opposite things about the same market at the same moment.
   What the payload can actually support is a LOWER BOUND on the server tape's
   silence (see silentMs), attributed to that tape, marked sd-old like every
   other stale claim in the pane; when the page's own feed disagrees, the
   disagreement is printed rather than left for the reader to trip over. */
function sidesFlowHtml(d) {
  const f = d.flow || {};
  const m1 = f.m1 || {}, h1 = f.h1 || {};
  const nowMs = sdNow(d);
  const bStart = (m1.ms != null && isFinite(m1.ms)) ? m1.ms : null;
  const curMin = Math.floor(nowMs / 60000) * 60000;
  const mAge = bStart == null ? null : Math.max(0, nowMs - bStart);
  // Strictly older than the last closed minute's start: the collector holds no
  // bucket for the minute that just closed, so no print was recorded in it.
  const mStale = bStart != null && bStart < curMin - 60000;
  const mForming = bStart != null && bStart >= curMin;
  /* SILENCE OF THE SERVER TAPE, which is the only time this payload can date.
     The bucket runs [bStart, bStart+60s) and no bucket exists after it — the
     collector opens one the instant a print arrives — so what is measurable
     is that NOTHING WAS RECORDED SINCE THAT BUCKET CLOSED, a lower bound that
     only grows while the pane stands, hence the "+".
     It is a bound on the SERVER's recording, not on the market's trading, and
     it is not a print time: m1.ms is a bucket boundary and no print sits on
     it. Saying "last print 31m ago" got both wrong at once. */
  const silentMs = bStart == null ? null : Math.max(0, nowMs - bStart - 60000);
  /* DO THE PANE'S TWO INDEPENDENT FEEDS DISAGREE? Both sides of this test are
     exchange-stamped — the collector buckets on t.time (flow_collector.py:235)
     and so does the page's own websocket — so a print stamp and a bucket
     boundary are the same clock, and comparing them is not a skew measurement
     in disguise. The slack is for the exchange's stamping jitter, nothing more.
     When it holds, the market traded after the server's tape went quiet: the
     silence is the COLLECTOR's and must not be reported as the market's. When
     it does not hold, the two feeds agree and nothing extra is claimed — an
     empty rail on a market that has genuinely stopped trading is the truth. */
  const FEED_SKEW_MS = 5000;
  const pagePrintMs = sdPagePrintMs();
  const silentSince = bStart == null ? null : bStart + 60000;
  const pageLive = mStale && pagePrintMs != null && silentSince != null
    && pagePrintMs > silentSince + FEED_SKEW_MS;
  const istAt = (ms) => new Date(ms).toLocaleTimeString("en-IN",
    { timeZone: "Asia/Kolkata", hour12: false });
  const staleTitle = !mStale ? "" :
    "The age of the SERVER's tape, not of the market. The newest minute the "
    + "collector holds starts " + istAt(bStart) + " IST and covers 60s, and it "
    + "holds nothing after that, so it has recorded no print since "
    + istAt(silentSince) + " IST — at least " + sdAgoFloor(silentMs) + ". No "
    + "print time can be read off this payload at all: m1.ms is a bucket "
    + "boundary. LIVE PRINTS below is a DIFFERENT feed — this page's own "
    + "websocket to the exchange — and " + (pagePrintMs == null
      ? "it has carried no print for " + state.sel + " since this coin was "
        + "selected, so it can neither confirm nor deny that the market is quiet."
      : pageLive
        ? "its newest print is stamped " + istAt(pagePrintMs) + " IST, AFTER "
          + "that: this market is trading and the collector is missing it."
        : "its newest print is stamped " + istAt(pagePrintMs) + " IST, no newer "
          + "than the collector's own last minute — the two feeds agree that "
          + "this market has gone quiet.");
  let h = `<div class="sd-blk">` +
    sdHead("AGGRESSOR FLOW",
      (mStale ? `server tape silent ${sdAgoFloor(silentMs)}+ · ` : "") +
      "descriptive, not predictive",
      mStale ? { cls: "sd-old", title: staleTitle } : null);
  if (f.subscribed === false || f.err) {
    return h + `<div class="sd-gap">${esc(f.why || f.err)}</div></div>`;
  }
  if (!f.m1 && !f.h1) {
    /* THE WINDOW, AND THE CLOCK. The server used to answer this branch with
       "subscribed, but no prints recorded yet" and this line echoed it
       verbatim — a ONE-HOUR miss reported as "ever". None of the pane's
       dating machinery above can fire here either, because m1.ms is its only
       clock and there is no m1, so the payload's own `last_bucket_ms` (which
       reaches PAST the window) is the only thing that can date the silence.
       Three distinct states, and they must not collapse into each other:
       recorded-before-but-not-in-this-window, never-recorded-at-all, and an
       older server that ships neither field. */
    const lb = (f.last_bucket_ms != null && isFinite(f.last_bucket_ms))
      ? f.last_bucket_ms : null;
    const winTxt = f.window_h != null ? `${f.window_h}h` : "the query window";
    const dated = lb != null
      ? ` The collector's newest bucket for this market starts ` +
        `<b>${esc(istAt(lb))} IST</b>, ${esc(sdAgoFloor(Math.max(0, nowMs - lb)))}+ ` +
        `ago — older than ${esc(winTxt)}, so this is a quiet market, not an ` +
        `empty one.`
      // The never-recorded case needs NO second sentence: the server's own
      // `why` already carries it in full, and repeating it verbatim below the
      // line it duplicates reads as two independent findings.
      : "";
    return h + `<div class="sd-empty">${esc(f.why || ("nothing recorded in " + winTxt))}` +
      `</div>` + (dated ? `<div class="sd-why">${dated}</div>` : "") + `</div>`;
  }
  if (mStale) {
    // The empty rail is the whole point: nothing was recorded in the minute
    // this row is named after, and the dollars that DO exist belong to a
    // different minute, so they are quoted in the tooltip and never drawn.
    h += sdRow("60S", `<span class="sd-rail"></span>`, "none recorded", "dim",
      "NOTHING was recorded in the last closed minute. The collector holds a "
      + "minute only once a print arrives in it, and the most recent minute it "
      + "holds started " + sdAgo(mAge) + " ago — $" + fmtBig(m1.buy) + " buy / $"
      + fmtBig(m1.sell) + " sell over " + (m1.n || 0) + " prints. That is not "
      + "this minute, so it is not drawn on this rail. Blank here means no "
      + "print was RECORDED, which is not the same claim as a balanced minute, "
      + "and on a market that trades in sessions — or against a collector that "
      + "has stopped listening — not the same claim as a quiet market either.");
    /* THE PANE MUST NOT LET ITS TWO FEEDS CONTRADICT EACH OTHER IN SILENCE.
       When this page's own websocket has printed since the server's tape went
       quiet, the blank rail above is a recording gap and says so out loud —
       the alternative is a reader inferring a dead market from an empty rail
       while prints scroll past six lines below. The time quoted is the
       exchange stamp — the same one LIVE PRINTS labels its rows with, so the
       two blocks read against each other directly — and it is quoted as a
       print that HAPPENED then, never as "the latest": this block redraws on
       the 12s sides poll while the tape redraws on every print, so a "latest"
       here is contradicted by a newer row below within seconds (measured: the
       note said 23:27:10 while the tape already showed 23:27:17). A past-tense
       fact does not rot between polls; a superlative does. */
    if (pageLive)
      h += `<div class="sd-why">this page's own feed took a print at ` +
        `<b>${esc(istAt(pagePrintMs))} IST</b>, after the server tape's last ` +
        `recorded minute closed (${esc(istAt(silentSince))} IST) — so this ` +
        `market IS trading and the blank rail above is the collector recording ` +
        `nothing for ${esc(sdAgoFloor(silentMs))}+, not a quiet market.</div>`;
  } else {
    h += sdRow("60S", sdRail(m1.buy, m1.sell,
      { lt: "$" + fmtBig(m1.buy), rt: "$" + fmtBig(m1.sell) }),
      (m1.n || 0) + " prints", "dim",
      "buy-initiated notional left, sell-initiated right, " + (bStart == null
        ? "in the most recent minute the collector holds — this payload shipped "
          + "no bucket time, so that minute cannot be dated from here"
        : mForming
          ? "so far in the CURRENT minute — " + Math.round(mAge / 1000)
            + "s in and still filling, not a closed 60s"
          : "in the last closed minute"));
  }
  /* Summed from the SAME buckets as the 60S row, so it inherits the same gap:
     when the collector has recorded nothing for the last stretch of the hour,
     these totals are the hour's RECORDED prints, not the hour's traded ones.
     The number is left as it is — it is what was recorded — and the tooltip
     says which minutes are missing from it rather than letting a short hour
     pass as a full one. */
  h += sdRow("1H", sdRail(h1.buy, h1.sell,
    { lt: "$" + fmtBig(h1.buy), rt: "$" + fmtBig(h1.sell) }),
    fmtBig(h1.n || 0) + " prints", "dim",
    "aggressor split over the last hour of the server's own tape"
    + (mStale ? " — and that tape has recorded nothing for the most recent "
        + sdAgoFloor(silentMs) + "+ of it, so this hour is short by however much "
        + "traded in that gap" : ""));
  const sp = f.cvd_spark || [];
  const covered = sp.length ? Math.min(1, sp.length / 60) : 0;
  h += `<div class="sd-row" title="CVD is a LEVEL, not a side, so it gets no rail — ` +
    `read the slope. The line starts where the record starts: ${sp.length} of 60 ` +
    `minutes collected.">` +
    `<span class="sd-l">CVD 1H</span>` +
    `<span class="sd-rail">${sdSpark(sp, covered)}</span>` +
    `<span class="sd-v ${sdCls(f.cvd)}">${(f.cvd || 0) < 0 ? "-" : "+"}` +
    `$${fmtBig(Math.abs(f.cvd || 0))}</span></div>`;
  return h + `</div>`;
}

function sidesWhalesHtml(d) {
  const w = d.whales || {};
  const cov = w.coverage || {};
  /* AGE THROUGH THE PANE'S OWN DOCTRINE, like every sibling block. This one
     line printed `Math.round(snapshot_age_s) + "s old"` straight off the
     payload: a stamp frozen at the moment /api/sides was assembled, which
     does NOT carry forward while the pane stands. The sides poll is 12s, so
     between polls the header understated the snapshot's age by up to 12s and
     an unrefreshed tab could sit for minutes reading "110s old". It also
     printed raw seconds forever — "1847s old" instead of "31m".
     sdAgeFrom adds the client-side time since THIS payload landed (two
     server stamps, two client stamps, never one of each), and sdAgo puts it
     in the same units DEPTH BY DISTANCE and the ladder already use. */
  const whAgeMs = sdAgeFrom(w.snapshot_age_s);
  const age = whAgeMs != null ? sdAgo(whAgeMs) + " old" : "";
  let h = `<div class="sd-blk">` + sdHead("WHALE POSITIONING", age);
  if (w.ok === false || w.err)
    return h + `<div class="sd-gap">${esc(w.why || w.err)}</div></div>`;
  /* DATA AND CAVEAT COEXIST. `if (w.gap) return` was written for "there is
     nothing to show", and then the server began setting `gap` for every
     INCOMPLETE sweep — which is nearly every sweep, since one failed wallet
     fetch out of 200 makes coverage partial (23 failures, live, the day this
     was found). The early return therefore fired permanently and threw away
     58 measured BTC positions, 48 ETH and the 15 xyz:TSLA positions the whole
     dex-aware sweep exists to surface, to print a footnote by itself.

     A LOWER BOUND IS STILL A COUNT. It renders, with its caveat attached
     underneath — the grammar this pane already uses when the header prints
     "110s old" and DRAIN prints "8.9h of 48h collected". Only a genuinely
     unmeasured venue may suppress the rails. `caveat` is the server's field
     for the coexisting case; `gap` is still honoured as a caveat if an older
     payload sends one alongside data, so the numbers survive either way. */
  const note = w.caveat || w.gap || (cov.complete === false ? cov.why : "") || "";
  const noteHtml = note ? `<div class="sd-gap">${esc(note)}</div>` : "";
  /* NEVER QUERIED — n_positions is null, not 0. The two are different facts:
     0 is "the sweep asked this venue and nobody was there", null is "nothing
     has ever asked". Only null suppresses the rails, and it has to SAY so:
     a silent empty block on an unswept venue reads as "no whales here". */
  /* WARMING IS NOT ZERO EITHER. n_positions == null is the server saying
     "never queried"; cov.state === "warming" is it saying "querying, no
     completed sweep yet". Both are not-measured, and only the first one
     reached this gate — so a warming sweep that happened to ship
     n_positions: 0 would have fallen through to the rails below and drawn
     an empty long/short bar, which is the measured-zero reading of a state
     that has measured nothing. Defused server-side today (warming payloads
     null the count); this closes the guard so it stays defused if that
     changes. */
  if (w.n_positions == null || cov.state === "warming")
    return h + `<div class="sd-gap"><b>NOT COVERED</b> — ${esc(note ||
      (cov.state === "warming"
        ? "the whale sweep is warming — no completed sweep for " +
          (cov.venue || "this venue") + " yet, so there is no count to state"
        : "the whale sweep has not queried " + (cov.venue || "this venue")))}` +
      `</div></div>`;
  const ordersCov = cov.orders_covered !== false;
  if (!w.n_positions && !w.bid_ntl && !w.ask_ntl)
    return h + `<div class="sd-empty">${esc(ordersCov
      ? "no tracked wallet holds or rests size here"
      : "no tracked wallet holds a position here")}</div>` + noteHtml + `</div>`;
  h += sdRow("POS", sdRail(w.long_ntl, w.short_ntl,
    { lt: "$" + fmtBig(w.long_ntl), rt: "$" + fmtBig(w.short_ntl) }),
    w.n_positions + " wallets", "dim",
    "open positions of tracked wallets: long left, short right. A snapshot of " +
    "where they ARE, not a claim about where price goes.");
  /* A rail needs two MEASURED sides. On a venue whose book is never fetched
     bid_ntl/ask_ntl arrive as null, and `w.bid_ntl || 0` painted an empty
     rail with "$0" beside it — a measured absence of size that nobody
     measured. The row stays (the reader must not have to notice a missing
     row) and states its own coverage instead. */
  /* `||`, not `&&`. _sides_whales nulls both sides together or sums both
     together, so a one-sided null is unreachable from the current server —
     but the rail's whole argument is that it needs TWO measured sides, and
     `&&` would have drawn a real bar against a null on the day that changes.
     Guarding on the weaker condition costs nothing and cannot go stale. */
  if (w.bid_ntl == null || w.ask_ntl == null)
    h += sdRow("RESTING",
      `<span class="sd-rail"><span style="position:absolute;inset:0;` +
      `display:flex;align-items:center;justify-content:center;z-index:3;` +
      `font-size:7.5px;letter-spacing:.08em;color:var(--amber2)">` +
      `NOT COVERED</span></span>`, "–", "dim",
      cov.orders_why || ("resting orders are not fetched on " +
        (cov.venue || "this venue") + " — this is not-measured, not zero"));
  else
    h += sdRow("RESTING", sdRail(w.bid_ntl, w.ask_ntl,
      { lt: "$" + fmtBig(w.bid_ntl), rt: "$" + fmtBig(w.ask_ntl) }),
      "$" + fmtBig((w.bid_ntl || 0) + (w.ask_ntl || 0)), "dim",
      "resting LIMIT orders owned by tracked wallets — cancellable, like all " +
      "resting size");
  /* Same rule as the whale order rows and the chart: a STOP is quoted at
     the price it FIRES at, not the price it rests at. This line has room
     for one price, so it prints the firing one and says so — quoting the
     resting price bare under the word STOP is what made this surface
     disagree with the chart by 9.7% on the same order. */
  const os = (w.orders || []).slice(0, 2).map((o) => {
    const trig = o.is_trigger && o.trigger_px != null;
    return `${o.side === "bid" ? "BID" : "ASK"} ` +
      `${trig ? "fires " : ""}${fmtPx(trig ? o.trigger_px : o.limit_px)} ` +
      `$${fmtBig(o.ntl)}` +
      (o.reduce_only ? " EXIT" : "") + (o.is_trigger ? " STOP" : "");
  });
  if (os.length) h += `<div class="sd-why">${esc(os.join(" · "))}</div>`;
  if ((w.avg_long_entry || w.avg_short_entry) && sidesTier() < 3)
    h += `<div class="sd-why">avg entry — long ${fmtPx(w.avg_long_entry)} · ` +
      `short ${fmtPx(w.avg_short_entry)}</div>`;
  return h + noteHtml + `</div>`;
}

/* Every number in this block is guarded ON ITSELF. It used to dereference
   `f.pct_8h` behind a check on `f.apr_pct`, and `f.cex.disloc_apr` behind a
   check on `f.cex.median_apr` — and funding_x.py sets disloc_apr to None
   whenever HL's own rate is missing from predictedFundings while the CEX
   median is present, so that second pair comes apart in normal operation.
   The throw is not local: renderSides is what assigns body.innerHTML, so a
   TypeError in here skipped the assignment and left the PREVIOUS render on
   screen — frozen numbers with no error anywhere, re-thrown every 12s. */
function sidesFundingHtml(d) {
  const f = d.funding || {};
  let h = `<div class="sd-blk">` + sdHead("FUNDING", "positive = longs pay");
  const apr = sdNum(f.apr_pct);
  if (apr == null)
    return h + `<div class="sd-empty">${esc(f.why || f.err || "no funding rate")}</div></div>`;
  const mag = Math.min(100, Math.abs(apr));
  const pays = f.pays === "long";
  const p8 = sdNum(f.pct_8h);
  h += sdRow("8H APR", sdRail(pays ? mag : 0, pays ? 0 : mag,
      { title: (pays ? "longs" : "shorts") + " pay " + apr.toFixed(2) + "% APR" }),
    apr.toFixed(1) + "%", fundingClass(apr),
    "the bar sits on the side that PAYS. " +
    (p8 != null ? p8.toFixed(4) + "% per 8h."
                : "the per-8h rate was not served with it."));
  // `(f.usd_day_on_clip || 0).toFixed(2)` printed "$0.00/day" for a cost the
  // server never sent — a missing number wearing a measured zero's clothes.
  const day = sdNum(f.usd_day_on_clip);
  h += `<div class="sd-why"><b>${pays ? "longs" : "shorts"} pay ` +
    (day != null ? `$${day.toFixed(2)}/day` : `— not served for this clip`) +
    `</b> on a $` +
    `<input class="sd-clipin" id="sd-clip" value="${sdClip()}" spellcheck="false" ` +
    `title="your clip size in dollars — press Enter. Every figure in this pane ` +
    `quoted in clips uses it, and the cyan tick on each rail marks where one ` +
    `clip lands."> clip</div>`;
  let cexTxt = f.cex_note || "";
  if (!cexTxt && f.cex) {
    const med = sdNum(f.cex.median_apr), dis = sdNum(f.cex.disloc_apr),
          nv = sdNum(f.cex.n);
    if (med != null)
      cexTxt = `CEX median ${med.toFixed(1)}% APR` +
        (nv != null ? ` over ${nv} venue${nv === 1 ? "" : "s"}` : "") + ` · ` +
        (dis != null ? `dislocation ${dis.toFixed(1)}pts`
                     : `dislocation NOT computed — HL's own rate is missing ` +
                       `from the cross-venue fetch, so the gap is unknown, not zero`);
    else if (dis != null)
      cexTxt = `dislocation ${dis.toFixed(1)}pts · no CEX median in this row`;
    else
      cexTxt = "a CEX row exists for this coin but carries no usable rate";
  }
  if (cexTxt)
    h += sidesTier() >= 3
      ? `<div class="sd-why" title="${esc(cexTxt)}">CEX comparison ⓘ</div>`
      : `<div class="sd-why">${esc(cexTxt)}</div>`;
  return h + `</div>`;
}

function sidesYouHtml(d) {
  const y = d.you || {};
  const q = (y.venues_queried || []).join(", ");
  let h = `<div class="sd-blk"><div class="sd-h"><span>YOUR POSITION</span>` +
    `<span class="sd-hn" title="${esc(y.no_sum_note || "read-only · no keys held")}">` +
    `${esc(q ? "queried: " + q : "read-only")}</span></div>`;
  if (y.status === "no-address") {
    const full = (y.why || "") + " — this pane never holds keys and cannot " +
      "place or cancel an order.";
    return h + (sidesTier() >= 3
      ? `<div class="sd-empty" title="${esc(full)}">no wallet — set one in PORT</div></div>`
      : `<div class="sd-empty">${esc(full)}</div></div>`);
  }
  if (y.status && y.status !== "ok")
    return h + `<div class="sd-gap">${esc(y.why || y.status)}</div></div>`;
  if (y.failed && y.failed.length)
    h += `<div class="sd-gap">could not query ` +
      esc(y.failed.map((x) => x.venue).join(", ")) +
      ` — anything held there is missing from this block</div>`;
  const p = y.position;
  if (!p) {
    h += `<div class="sd-empty">flat on ${esc(state.sel)}` +
      (y.n_positions_total
        ? ` — ${y.n_positions_total} position${y.n_positions_total === 1 ? "" : "s"} ` +
          `open on other markets`
        : ` — and on every venue queried`) + `</div>`;
    return h + `</div>`;
  }
  const long = p.side === "long";
  h += sdRow(long ? "LONG" : "SHORT",
    sdRail(long ? p.notional : 0, long ? 0 : p.notional,
      { lt: long ? "$" + fmtBig(p.notional) : "", rt: long ? "" : "$" + fmtBig(p.notional),
        title: "your side, on the SAME waterline as the book, the flow and " +
               "the whale positioning above" }),
    (p.leverage ? p.leverage + "x" : ""), "dim",
    "entry " + fmtPx(p.entry_px) + " · mark " + fmtPx(p.mark_px));
  // Keyed on liq_px, not liq_dist_pct — same reason as portLiqLineHtml: a leg
  // that HAS a liquidation price but no mark used to be told the cross
  // account-level story, which for an isolated leg is the wrong account.
  const lvt = esc(p.lev_type || "cross");
  const plev = p.leverage ? p.leverage + "x " : "";
  if (+p.liq_px > 0) {
    h += p.liq_dist_pct != null
      ? `<div class="sd-why">liq ${fmtPx(p.liq_px)} — <b>${p.liq_dist_pct.toFixed(1)}% away</b>` +
        (p.liq_band === "danger" ? " · TIGHT" : "") + `</div>`
      : `<div class="sd-why">${plev}${lvt} — liq <b>${fmtPx(p.liq_px)}</b>, but no ` +
        `mark price for this market, so the distance to it is <b>UNKNOWN</b>, not safe</div>`;
  } else if ((p.lev_type || "") === "isolated") {
    h += `<div class="sd-why">${plev}${lvt} — isolated margin is walled off from ` +
      `the cross pool, and no liquidation price came back for this leg: distance ` +
      `<b>UNKNOWN</b>, not safe</div>`;
  } else {
    // Cross margin has no per-position liq price, so this block printed NOTHING
    // — which read as "this leg has no liquidation risk". It has; it is just
    // account-level. venue_account does not carry maint_margin/total_notional,
    // so the figure comes from the PORT payload for the same wallet.
    const vr = portVenueRec(p.dex);
    const st = acctLiqState(vr);
    h += st.state === "ok"
      ? `<div class="sd-why">${plev}${lvt} — no per-position liq price; ` +
        `<b>${st.pct.toFixed(1)}% adverse move</b> liquidates the whole ` +
        `${esc(vr.venue)} account` +
        (acctBand(st.pct) === "danger" ? " · TIGHT" : "") + `</div>`
      : st.state === "breached"
      ? `<div class="sd-why">${plev}${lvt} — no per-position liq price, and ` +
        `${esc(vr.venue)} equity is <b>already AT or BELOW maintenance margin</b> ` +
        `(short by $${acctShortfallUsd(st.shortfall)}): no adverse move left to ` +
        `measure, the account is liquidatable NOW</div>`
      : st.state === "remote"
      ? `<div class="sd-why">${plev}${lvt} — no per-position liq price; the ` +
        `${esc(vr.venue)} account needs a <b>&gt;100% adverse move</b> on the whole ` +
        `book — notional is tiny against equity, so the exact figure is noise</div>`
      : `<div class="sd-why">${lvt}-margined — no ` +
        `per-position liq price exists, and the account figures for the ` +
        `account-level distance have not loaded: distance <b>UNKNOWN</b>, not safe</div>`;
  }
  const bits = [];
  if (p.upnl != null) bits.push(`uPnL ${p.upnl >= 0 ? "+" : "-"}$${fmtBig(Math.abs(p.upnl))}`);
  if (p.funding_usd_day != null)
    bits.push(`funding ${p.funding_usd_day >= 0 ? "+" : "-"}$` +
      `${Math.abs(p.funding_usd_day) >= 1000 ? fmtBig(Math.abs(p.funding_usd_day))
        : Math.abs(p.funding_usd_day).toFixed(2)}/day`);
  if (y.venue_account)
    bits.push(`${esc(y.venue_account.venue)} acct $${fmtBig(y.venue_account.account_value)} · ` +
      `${(y.venue_account.gross_leverage || 0).toFixed(2)}x`);
  if (bits.length) h += `<div class="sd-why">${bits.join(" · ")}</div>`;
  h += sidesStopsHtml(p);
  if (y.no_sum_note && !sdTight())
    h += `<div class="sd-why">${esc(y.no_sum_note)}</div>`;
  return h + `</div>`;
}

/* PROTECTIVE ORDERS FOR THE CHARTED LEG — three states, never two.

   This block draws a live position with a liquidation distance beside it, and
   quiet next to a fully-specified risk line reads as "nothing further to
   report". Until 2026-08-16 quiet was all it could honestly be: no route in
   this terminal fetched frontendOpenOrders for the owner's wallet, so the
   pane said NOT MEASURED and left it there. /api/stops now answers, and the
   three states it distinguishes are rendered as three different sentences:

     measured + exits present -> the stop and what fraction of the leg it covers
     measured + no exits      -> UNPROTECTED, and it says "measured, not assumed"
     not measured             -> the venue and its error, and NO zero anywhere

   The third is the one this function exists for. `state.stops.state` and the
   per-leg `state` field are READ from the server, never inferred from an
   empty list: an order query that failed and a leg with no stop both produce
   no exit orders, and calling the first "unprotected" would be a green light
   drawn from no data. */
function sidesStopsHtml(p) {
  const s = state.stops;
  const unkTitle = "This line is the ABSENCE of a measurement, not a " +
    "measurement of an absence — it is not evidence that a stop exists, and " +
    "it is not evidence that one does not.";
  if (!portAddr()) return "";
  if (!s || s.state === "not_measured") {
    const why = !s
      ? "the resting-order query has not run yet this session"
      : (s.why || s.not_measured_note || s.error || "the query did not complete");
    const named = ((s && s.failed) || [])
      .map((f) => (f.venue || "?") + " — " + (f.error || f.error_kind || "no reason given"));
    return `<div class="sd-why" title="${esc(unkTitle)}">` +
      `<b>stops: NOT MEASURED</b> — ${esc(why)}` +
      (named.length ? ` · <b>failed:</b> ${esc(named.join(" · "))}` : "") + `</div>`;
  }
  // Match on coin AND venue: the same ticker can be held on core and on a
  // HIP-3 dex, and those are two different books with two different answers.
  const rec = (s.protection || []).find((r) =>
    r.coin === p.coin && (r.dex || "") === (p.dex || ""));
  if (!rec) {
    /* The order query succeeded but this leg is not in `protection` — which
       happens when the POSITION half failed for its venue. The server names
       that case rather than leaving it to be guessed at. */
    return `<div class="sd-why" title="${esc(unkTitle)}">` +
      `<b>stops: NOT MEASURED for this leg</b> — ${esc(s.positions_missing_note ||
        s.positions_note || "this position is absent from the protection " +
        "list, so nothing was measured against it")}</div>`;
  }
  if (rec.state === "not_measured")
    return `<div class="sd-why" title="${esc(unkTitle)}">` +
      `<b>stops: NOT MEASURED</b> — ${esc(rec.why || "the resting-order " +
        "query for this venue failed")}</div>`;
  if (rec.state === "unprotected")
    return `<div class="sd-why" title="${esc(rec.why || "")}">` +
      `<b>NO STOP on this position</b> — ${esc(rec.why ||
        (rec.venue + " answered and holds no reduce-only order that would " +
         "close this " + p.side))}</div>`;
  // Protected, wholly or partly. The COVERAGE is stated because a stop for a
  // tenth of the size is not a floor under the position, and a bare "stop
  // 61,200" beside a full-size leg would read as if it were.
  const cov = rec.covered_pct != null ? Math.round(rec.covered_pct) : null;
  const bits = [];
  if (rec.nearest_stop_px != null)
    bits.push(`stop ${fmtPx(rec.nearest_stop_px)}`);
  if (cov != null) bits.push(`covers ${cov}% of the leg`);
  if (rec.n_take_profit) bits.push(`${rec.n_take_profit} take-profit`);
  return rec.state === "stop-loss"
    ? `<div class="sd-why"><b>stop in place</b> — ${esc(bits.join(" · "))}` +
      (cov != null && cov < 100 ? ` · <b>the rest is unprotected</b>` : "") + `</div>`
    : `<div class="sd-why" title="${esc(rec.why || "")}"><b>EXIT ORDERS ONLY — ` +
      `NO STOP</b> — ${esc(rec.why || (rec.n_exit_orders + " reduce-only " +
      "order(s) rest against this leg but none of them is a stop-loss"))}</div>`;
}

function sidesCoverageHtml(d) {
  const c = d.coverage || {};
  const dep = c.depth || {};
  const bits = [];
  bits.push(`<b>depth</b> ${esc(dep.note || "not collected")}`);
  if (c.whale_age_s != null) bits.push(`<b>whales</b> ${Math.round(c.whale_age_s)}s old`);
  const f = (d.flow || {});
  bits.push(`<b>flow</b> ` + (f.subscribed === false ? "not subscribed"
    : (f.rows || 0) + " of 60 min"));
  if (c.venues_failed) {
    bits.push(`<span class="warn">${c.venues_failed} VENUE FETCH FAILED` +
      (c.venues_failed_names && c.venues_failed_names.length
        ? " (" + esc(c.venues_failed_names.join(", ")) + ")" : "") +
      " — venue size and cross-listing here are INCOMPLETE</span>");
  }
  const caveats = "displayed resting size is CANCELLABLE — this is where " +
    "liquidity is shown, not a commitment. " + (c.backfill_note || "") + " " +
    (c.sample_note || "");
  // The coverage FACTS are never folded away — only the two standing
  // caveats, and only with a marker saying they are there.
  return sdTight()
    ? `<div class="sd-cov" title="${esc(caveats)}">${bits.join(" · ")} · ` +
      `<b>resting size is cancellable ⓘ</b></div>`
    : `<div class="sd-cov">${bits.join(" · ")}<br>${esc(caveats)}</div>`;
}

/* The wrapper exists because THIS function is what writes body.innerHTML,
   and it is called from loadSides OUTSIDE that function's try/catch. Any
   throw below — one null field in one block — used to skip the assignment
   entirely and leave the previous render standing, indistinguishable from a
   successful one, on every 12s poll forever. A render that throws must fail
   VISIBLY, so the pane is replaced by the fault rather than by yesterday. */
function renderSides(retry) {
  const body = $("sides-body");
  if (!body) return;
  try {
    renderSidesInto(body, retry);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    try { console.error("renderSides failed", e); } catch (_) { /* no console */ }
    body.innerHTML = `<div class="sd-gap">this pane could not be drawn — ` +
      `<b>${esc(msg)}</b><br>its previous contents have been cleared rather ` +
      `than left on screen: nothing here was current.</div>`;
  }
}

/* Set when a poll was skipped because the clip box had focus, so the pane
   repaints the instant focus leaves rather than waiting out another 12s. */
let sdClipDeferred = false;

function renderSidesInto(body, retry) {
  /* THE 12s POLL MUST NOT DESTROY AN INPUT THE OWNER IS TYPING INTO.

     setInterval(loadSides, 12000) → renderSides() → body.innerHTML = …, which
     re-creates #sd-clip from scratch. Measured 2026-08-16: focus the box, type
     2500, wait 14s — the node is replaced (sameNode false, old node
     disconnected), the value reverts to the 10000 default and activeElement
     falls back to BODY. So the owner had, on average, ~6s to type a number and
     press Enter. hlterm_clip_usd was ABSENT from this profile: he has never
     once succeeded, and every clip-denominated figure in this pane has been
     quoting his $5-10k book against the $10,000 default.

     renderPortTab has had exactly this guard since the identical bug made the
     42-character wallet address untypeable one pane over. This is that guard,
     applied to the one input in this pane. The ladder and the tape keep
     advancing while it holds — they are written by renderSidesLadder /
     renderSidesTape into nodes that already exist and are not rebuilt here —
     so what pauses is the static blocks, for as long as a cursor sits in the
     box, and no longer. */
  const ae = document.activeElement;
  const sameCoin = state.sides && state.sides.coin === state.sel;
  // Scoped to the SAME instrument, for the reason renderWatch's guard is
  // scoped to the PORT tab: unscoped, charting a new coin with the cursor
  // still in the box would freeze this pane — header included — on the
  // previous instrument's book while the chart moved to the new one. A
  // deliberate symbol change outranks a half-typed clip size.
  if (ae && ae.id === "sd-clip" && body.contains(ae) && sameCoin) {
    sdClipDeferred = true; return;
  }
  sdClipDeferred = false;   // this render IS the catch-up; clear the debt
  if (!retry) sdCompact = false;
  const sym = $("sides-sym");
  if (sym) sym.textContent = state.sel || "–";
  const d = state.sides;
  if (!d || d.coin !== state.sel) {
    body.innerHTML = state.sidesError
      ? `<div class="sd-empty">could not load — <b>${esc(state.sidesError)}</b></div>`
      : '<div class="sd-empty">loading both sides…</div>';
    return;
  }
  const meta = $("sides-meta");
  if (meta) meta.textContent = "BID · ASK · BUY · SELL · $" + fmtBig(sdClip()) + " CLIP";
  /* AN UNRECOGNISED SYMBOL IS NOT A MEASURED-EMPTY MARKET, and this pane had
     no way of telling the two apart. server.py sets `known_market` on every
     /api/sides payload and, when it is false, writes `unknown_market_note` —
     a sentence composed for exactly this — and BOTH had zero client
     references. So charting a symbol the venue universe does not list drew an
     empty book, an empty tape, an empty whale block, an empty flow block and
     an empty drain block, five independent silences that on this desk read as
     five measured zeros.

     One unrecognised symbol produces ONE sentence, not five blank blocks: the
     body is replaced rather than each block being left to degrade on its own,
     because a degrade is a statement about a store that WAS asked and none of
     these were. Verified live against /api/sides?coin=ZZZNOTAMARKET, which
     returns known_market false with the note above. */
  if (d.known_market === false) {
    body.innerHTML = `<div class="sd-gap"><b>NOT A MARKET HERE</b><br>` +
      esc(d.unknown_market_note || (state.sel + " is not a market in the " +
        "current venue universe, so nothing was subscribed for it")) +
      `<br>Nothing below was measured, because nothing below was asked.</div>`;
    return;
  }
  /* state.sidesError used to be read ONLY in the no-payload branch above, so
     a failure with a surviving payload was dropped and the whole pane — book,
     depth, drain, flow, whales, funding — was drawn as current for as long as
     the server stayed down. The payload is still worth showing; pretending it
     is live is not. */
  const failed = state.sidesError
    ? `<div class="sd-gap">refresh is FAILING — <b>${esc(state.sidesError)}</b>` +
      `<br>every block below is the payload from ` +
      `<b>${esc(sdAgo(state.sidesAt ? Date.now() - state.sidesAt : null))} ago</b>, ` +
      `not the current market</div>`
    : "";
  body.innerHTML = failed +
    sidesIdentHtml(d) +
    `<div class="sd-blk">` +
      `<div class="sd-h"><span>RESTING BOOK</span>` +
      `<span class="sd-hn" id="sd-lmeta">shown, not committed</span></div>` +
      `<div id="sd-ladder"></div></div>` +
    sidesBandsHtml(d) +
    sidesFlowHtml(d) +
    sidesWhalesHtml(d) +
    sidesFundingHtml(d) +
    sidesYouHtml(d) +
    `<div class="sd-blk sd-tape">` +
      `<div class="sd-h"><span>LIVE PRINTS</span>` +
      `<span class="sd-hn" id="sd-tmeta"></span></div>` +
      // The fallback summary must NOT live inside #sd-trows: that box is
      // `overflow:hidden` and is exactly 0px tall in the case the summary
      // exists to cover, so the honest degrade was itself being clipped.
      `<div class="sd-empty sd-tnote" id="sd-tnote" hidden></div>` +
      `<div class="sd-trows" id="sd-trows"></div></div>` +
    sidesCoverageHtml(d);
  renderSidesLadder();
  renderSidesTape();
  // One measured retry. The height tiers guess from the box; this checks the
  // result. Compacting is content-aware rather than height-aware, which is
  // what a YOU block that is 50px empty and 160px filled requires.
  if (!retry && !sdCompact && body.scrollHeight > body.clientHeight + 1) {
    sdCompact = true;
    return renderSides(true);
  }
  const ci = document.getElementById("sd-clip");
  if (ci) {
    ci.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const v = Math.max(100, Math.min(1e6, +ci.value || 10000));
      try { localStorage.setItem(CLIP_KEY, String(v)); } catch (err) { /* quota */ }
      sdClipDeferred = false;      // the reload below IS the deferred repaint
      loadSides();
    });
    // Focus leaving is the end of the pause. Without this the pane would hold
    // its skipped state until the next 12s tick, which is the stale-pane
    // failure the guard exists to avoid becoming.
    /* AN ACCELERATOR, NOT THE MECHANISM. Correctness does not depend on this
       listener: once focus leaves the box the guard above stops matching, so
       the next 12s poll repaints normally — that fallback is what was measured
       (a render called with focus on BODY rebuilt the pane and cleared the
       debt). This handler only shortens the wait from <=12s to one turn.

       Stated because it could NOT be verified here: in this automation harness
       the document never holds focus (the same condition that stops
       requestAnimationFrame firing), and a blur EVENT is not delivered at all
       — element.blur() moved document.activeElement from #sd-clip to BODY with
       a freshly attached listener recording 0 calls. So the path below is
       written to be correct and is unverified in this environment; the 12s
       fallback beneath it is verified and is what the fix rests on.

       Deferred by one turn ON PURPOSE: during a blur event activeElement can
       still be the blurring node, and a synchronous renderSides() would hit
       the guard above, re-arm the flag and repaint nothing. */
    ci.addEventListener("blur", () => {
      if (!sdClipDeferred) return;
      setTimeout(() => {
        if (!sdClipDeferred) return;                  // a coin change beat us
        const a = document.activeElement;
        if (a && a.id === "sd-clip") return;          // focus came straight back
        sdClipDeferred = false;
        renderSides();
      }, 0);
    });
    ci.title = "clip size in USD — the notional every depth, drain and flow " +
      "number in this pane is quoted against. Type a number and press Enter. " +
      "This pane pauses its 12s repaint while the cursor is in here (the " +
      "ladder and tape keep advancing) and repaints when you leave.";
  }
}

/* ---------------- data loops ---------------- */
/* Never throws. It used to have no try/catch at all while boot did
   `await loadUniverse()`, so a single failed first call — a page load landing
   during a server restart is enough — aborted the whole init: no selectCoin,
   no loaders, and none of the setIntervals ever registered. The terminal was
   then permanently dead with no retry until a manual reload. */
const UNIVERSE_RETRY_MS = [2000, 5000, 15000, 30000];

async function loadUniverse(attempt) {
  attempt = attempt || 0;
  try {
    await _loadUniverseOnce();
    state.universeError = null;
    return true;
  } catch (e) {
    state.universeError = (e && e.message) || String(e);
    const wait = UNIVERSE_RETRY_MS[Math.min(attempt, UNIVERSE_RETRY_MS.length - 1)];
    setTimeout(() => loadUniverse(attempt + 1), wait);
    return false;
  }
}

async function _loadUniverseOnce() {
  const r = await fetch("/api/universe");
  if (!r.ok) throw new Error("HTTP " + r.status);
  const d = await r.json();
  /* THE WIDEST-BLAST ONE. Unread, a 200-error envelope emptied crypto,
     equity, depth and depthSlots in a single assignment — the watchlist, the
     tape and every ctx-derived figure on the desk go blank together, and the
     collector-pressure block reads as "no pressure" because slots is null.
     loadUniverse's caller already has the error path (universeError + the
     retry ladder); it was simply never reached on a 200. */
  if (d && d.error) throw new Error(d.error);
  state.universe.crypto = d.crypto || {};
  state.universe.equity = d.equity || {};
  // In-memory read of the websocket depth collector, shipped with the 20s
  // ctx poll rather than as its own request. Missing coin = not collected.
  state.depth = d.depth || {};
  /* The COLLECTOR's own state, not any one coin's. depth_history.status()
     measures it precisely (slots_free 0, slots_pressure true, and a note
     saying the ratchet is add-only so a newly charted market is NOT recorded
     and its history for that period is permanently unavailable) — and not one
     of those fields appeared anywhere in this file, so the condition was
     discoverable only AFTER charting a market and reading the SIDES block.
     The note itself says it has to be visible before that, not after. */
  state.depthSlots = d.depth_slots || null;
  const custom = loadCustomWatch();
  state.watchCrypto = (custom && custom.crypto) || d.crypto_watch || [];
  state.watchEquity = (custom && custom.equity) || d.equity_watch || [];
  for (const [k, v] of Object.entries(state.universe.equity))
    if (v.mid_px != null && state.mids[k] == null) state.mids[k] = v.mid_px;
  renderWatch(); renderTape();
  // state.depth just moved, and it is what the HEAT button's coverage badge
  // reads. Same reason renderWatch is called here: this poll is where the
  // depth collector's coverage changes.
  syncIndButtons();
  renderNewsCtx();
  loadDes();
}

/* How old a slow panel's newest SUCCESSFUL read is, in words. `never` is not
   a formatting fallback here — it is the state a boot-time or post-eviction
   failure leaves a panel in, and it is the one thing this must not render as
   a number, because "0m ago" over a panel that has never been filled is the
   house bug in its purest form. */
function slowAgeTxt(name) {
  const s = (state.slow || {})[name] || {};
  if (!s.at) return "never";
  const m = (Date.now() - s.at) / 60000;
  return m < 1 ? "just now"
       : m < 90 ? Math.round(m) + "m ago"
       : (m / 60).toFixed(1) + "h ago";
}

/* ── THE SLOW PANELS ──────────────────────────────────────────────────────
   EVENT RADAR, NEWS, RESEARCH/INTEL. Three local routes, refreshed every
   120s, and until this rewrite they shared ONE Promise.all inside ONE silent
   catch with no record anywhere of when any of them last succeeded.

   TWO SEPARATE FAILURES LIVED IN THAT SHAPE.

   First, the 200-error envelope. /api/events answers a build failure with
   HTTP 200 + {events: [], error: …}; `renderEvents(ev.events || [])` read
   that as a measurement, printed "no calendar data" over an earnings day,
   AND overwrote state.events — taking the chart's event bands down with the
   panel. (Exposure is narrow: cache.get_or_fetch serves stale on exceptions,
   so this bites at boot or after an eviction. Narrow is not never.) The last
   good calendar is now kept through a failed refresh, exactly as loadVenues
   keeps its venue snapshot, and the failure is said rather than drawn.

   Second, and this is the one with no upstream trigger at all: during a
   local-server-down or restart window every one of these panels went on
   presenting content minutes or hours old with a completely current face.
   Note what was NOT the trigger — an upstream 429 arrives as an HTTP 200
   body and never rejects a Promise.all, so the failure this file used to be
   suspected of does not exist. The real one is the plain local outage.

   So each fetch now carries its own catch (one failing route cannot take the
   other two down with it) and stamps state.slow[name] with the time of its
   last SUCCESS, which the panels render. A null there means never. */
async function loadSlow() {
  const one = async (name, url) => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      if (d && d.error) throw new Error(d.error);
      state.slow[name] = { at: Date.now(), err: null };
      return d;
    } catch (e) {
      // `at` is CARRIED, not cleared: the panel below is still showing the
      // payload from that moment, so that moment is still the honest age.
      state.slow[name] = { at: (state.slow[name] || {}).at || null,
                           err: (e && e.message) || String(e) };
      return null;              // null = NOT MEASURED, never an empty payload
    }
  };
  /* /api/funding IS NOT FETCHED HERE ANY MORE (dead code, removed 2026-08-18).
     It fed renderFunding, which wrote into #funding-strip — an element that
     went with the INTEL STACK panel and exists nowhere in index.html. The
     renderer early-returned on the missing node, so the poll ran every 120s
     to build a payload nothing could ever display, and the "WATCHLIST
     FUNDING: NO CROWDED READS" sentence the audit chased could not render at
     all. Deleted rather than repaired: the FUND tab already ranks funding
     across the whole universe, which is the surface that survived. The route
     itself stays — it is not this file's to remove — but nothing here calls
     it, which is one fewer request against the same rate-limit budget. */
  const [ev, res] = await Promise.all([
    one("events", "/api/events"),
    one("research", researchUrl()),
  ]);
  if (ev) {
    renderEvents(ev.events || []);
    $("blind").textContent = "BLIND SPOTS: " + (ev.blind_spots || []).join(" · ").toUpperCase();
  } else {
    // Redraw the LAST GOOD calendar so its staleness line refreshes; with no
    // last good, renderEvents([]) now prints the failure instead of "no
    // calendar data" — see the branch it grew for exactly this call.
    renderEvents(state.events || []);
  }
  if (res) { renderNews(res.news || [], res.news_meta); renderResearch(res); }
  else { updateNewsMeta(); renderIntel(); }   // re-stamp the age, keep the rows
  loadChartNews();  // flags follow sel even when the river is ALL
  loadDes();
  loadInsiders();   // cheap once server cache is warm; shows scan status until then
  updateEvMeta();
}

/* ---------------- Hyperliquid WebSocket (live crypto mids) ---------------- */
let ws, wsRetry = 1000;
function connectWS() {
  try { ws = new WebSocket("wss://api.hyperliquid.xyz/ws"); }
  catch (e) { return scheduleReconnect(); }
  ws.onopen = () => {
    wsRetry = 1000;
    ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } }));
    ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids", dex: "xyz" } }));
    resubTrades(null, state.sel);
  };
  ws.onmessage = (msg) => {
    try {
      const d = JSON.parse(msg.data);
      if (d.channel === "allMids" && d.data && d.data.mids) {
        state.lastTickAt = Date.now();
        const mids = d.data.mids;
        for (const coin of [...state.watchCrypto, ...state.watchEquity]) {
          if (mids[coin] != null) {
            state.mids[coin] = +mids[coin];
            updatePx(coin, +mids[coin]);
          }
        }
        checkAlerts(mids);   // alerts may reference non-watchlist coins too
      } else if (d.channel === "l2Book" && d.data && d.data.coin === state.sel) {
        state.lastTickAt = Date.now();
        const [bids, asks] = d.data.levels || [[], []];
        state.book = {
          coin: d.data.coin,     // the chart's book gutter must know whose book
          bids: (bids || []).map((l) => ({ px: +l.px, sz: +l.sz })),
          asks: (asks || []).map((l) => ({ px: +l.px, sz: +l.sz })),
        };
        const now = Date.now();
        if (now - bookLastDraw > 250) {
          bookLastDraw = now;
          renderBook();
        }
      } else if (d.channel === "trades" && Array.isArray(d.data)) {
        state.lastTickAt = Date.now();
        for (const t of d.data) {
          if (t.coin !== state.sel) continue;
          const notional = +t.px * +t.sz;
          state.trades.unshift({
            px: +t.px, sz: +t.sz, side: t.side, ntl: notional,
            time: new Date(t.time).toLocaleTimeString("en-IN",
              { timeZone: "Asia/Kolkata", hour12: false }),
          });
          // Running MAX of the exchange's own print stamps (see
          // state.tradeSeenMs) — max, not last, because a subscription
          // backfill need not arrive in order. This is what lets the pane say
          // "this market traded" without borrowing the collector's word for it.
          if (isFinite(+t.time)) {
            state.tradeSeenMs = state.tradeSeenCoin === t.coin
              ? Math.max(state.tradeSeenMs, +t.time) : +t.time;
            state.tradeSeenCoin = t.coin;
          }
          recordFlow(t, notional);
        }
        renderFlowMeta();
        state.trades.length = Math.min(state.trades.length, 60);
        renderTrades();
        renderSidesTape();
      }
    } catch (e) { /* ignore malformed frames */ }
  };
  ws.onclose = scheduleReconnect;
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}
function scheduleReconnect() {
  $("cdot").className = "cdot down"; $("conntxt").textContent = "RECONNECTING";
  setTimeout(connectWS, wsRetry);
  wsRetry = Math.min(wsRetry * 2, 30000);
}

/* ---------------- boot ---------------- */
(async function boot() {
  /* Chart-display pass 2026-08-27: TRADE is the factory desk (bigger
     price plot). One-shot: a saved "default" was almost certainly the old
     factory, not a choice — F1–F4 never reach a stock Mac. After the flag
     is set, an explicit DEFAULT click sticks. */
  if (!localStorage.getItem("hlterm_chart_display_v1")) {
    const prev = localStorage.getItem("hlterm_preset");
    if (!prev || prev === "default") localStorage.setItem("hlterm_preset", "trade");
    localStorage.setItem("hlterm_chart_display_v1", "1");
  }
  setPreset(localStorage.getItem("hlterm_preset") || "trade");
  loadInds();
  syncDesChip();
  loadAlerts();
  loadMyFires();
  renderHints();          // built from live state, never static — see renderHints
  // Each of these is independent; one failing must not stop the rest, and the
  // intervals below must be registered even on a completely offline start so
  // the terminal heals itself when the server comes back.
  await loadUniverse();
  // restoreRuler runs after selectCoin so it can compare the stored plan's
  // coin against the one actually charted.
  for (const step of [() => selectCoin("BTC"), restoreRuler, loadSlow, loadMovers,
                      loadRegime, loadSignals, loadBuyback, connectWS]) {
    try { step(); } catch (e) { /* next step still runs */ }
  }
  setInterval(() => { if (!document.hidden) loadUniverse(); }, 20000);   // ctx refresh (funding/OI/24h) + equity mids fallback
  setInterval(() => { if (!document.hidden) loadSlow(); }, 120000);      // events/news/research
  setInterval(() => { if (!document.hidden) loadMovers(); }, 60000);     // movers/funding scanner
  setInterval(() => { if (!document.hidden) loadRegime(); }, 300000);    // regime strip (ext sources cached 30m)
  setInterval(() => { if (!document.hidden) loadSignals(); }, 120000);   // composite setup ranking
  setInterval(loadBuyback, 3600000); // buyback programmes + supply snapshots
  loadBuyflow();
  setInterval(loadBuyflow, 30000);   // live AF tape — must be seconds fresh
  setInterval(checkBurnAlerts, 60000); // burn vs sell-flow triggers
  /* keep chart current — and GATED, like every other upstream poller here.
     This one was the un-migrated sibling of the 2026-08-16 rate-limit fix:
     the two lines above it, the one below it and pollHeat all stand down in
     a hidden tab, and the loadSrDaily comment two lines down even claims
     "same document.hidden gate as the rest" — while this line, which drives
     an UPSTREAM /api/candles fetch (and now a local /api/depth one with it),
     ran at full rate in every one of the nine tabs this desk accumulates.
     Nothing is lost: the visibilitychange handler refills loadCandles the
     instant a tab comes back, and a hidden tab suspends rAF so a landing
     fetch paints nothing anyway. */
  setInterval(() => { if (!document.hidden) loadCandles(); }, 60000);
  // The daily series only changes at 00:00 UTC and the server caches it 300s,
  // so this is the slowest poller here; same document.hidden gate as the rest.
  setInterval(() => { if (!document.hidden) loadSrDaily(); }, SR_DAILY_TTL_MS);
  // BOTH SIDES. Reads only warm stores plus one 1s-cached l2Book, so this is
  // cheap; the ladder and the tape inside it update off the websocket at
  // their own cadence and do not wait for this.
  setInterval(() => { if (!document.hidden) loadSides(); }, SIDES_POLL_MS);
  setInterval(() => { if (!document.hidden) loadSidesBook(); }, SIDES_BOOK_MS);
  setInterval(renderTape, 30000);     // tape re-render with fresh mids
})();
