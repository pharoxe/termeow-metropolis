# Termeow: terminal and charting review

Reviewed 8 September 2026. Scope: repository architecture and critical paths across chart rendering, market adapters, live collectors, trader attribution, history, alerts, analysis, API polling, authentication/execution boundaries, and persistence. This is a static review and product proposal, not an exhaustive line-by-line security audit or a new live certification. No application changes made in this review.

## Recommendation

Keep the existing Lightweight Charts renderer. Build a trustworthy event and position model beneath it, then make chart, tape, trader inspector, and news share one selected instrument and timestamp. Treat “former traders” as historical participants/exited holders as well as FOMO traders; these require distinct labels.

## Highest-priority findings

1. **Trader overlays differ by chain.** `server/routes/flow.ts:180` only attaches the FOMO block on Robinhood. Solana cannot show equivalent named-trader overlays through this path. Introduce chain-specific attribution adapters with a shared event contract, but do not apply Robinhood's delegation test to Solana.
2. **Historical trader markers disappear by design.** `server/routes/flow.ts:33` caps returned FOMO fills at 40; `src/lib/fomoMarkers.ts` additionally caps buckets at 60 and favors largest notional. A history chart is therefore annotated with a recent sample, not all participants in its visible range. Query trades by visible time range with pagination, cluster in screen space, and disclose matched/rendered counts.
3. **Trade timestamp is not a candle inclusion watermark.** `src/lib/deskFlow.ts:101` accepts only prints newer than the market response's `observedAt`. A delayed trade can be absent from upstream candles yet already older than the response time. Add event time, ingestion time, provider candle watermark, revision, and canonical trade identity. Reconcile late events server-side and replace corrected bars. Do not simply widen the time filter: that can double-count volume.
4. **Leaderboard W/L is not true position accounting.** `server/traders/walletStats.ts:101` calls a position closed when both priced sides exist; `:105` compares total sell dollars with buy dollars. A partial exit can look like a closed loss. Track raw token quantity/decimals, inventory, cost basis, fees, transfers, opening balance provenance, and realized/unrealized P&L. Mark incomplete history unknown. Until then, label the existing statistic explicitly as a buy/sell cash-flow proxy, not win rate.
5. **“Confidence” is a heuristic score.** `src/lib/agenticAnalysis.ts:130` scores satisfied conditions with fixed increments; sentiment and whale risk also use text regexes. This is neither calibrated probability nor evidence of another trader's motives. Rename it setup/confluence score; attach timestamped evidence and distinguish missing signals from negative findings.
6. **Deduplication lacks a universal execution identity.** `server/flow/fomoFills.ts:21` merges on tx + wallet + side; book dedupe adds token. Multiple same-side executions in one transaction can collapse. Decide explicitly whether a row is an individual execution or wallet net activity, retain event IDs for each log/instruction, then reconcile duplicate providers against those IDs. Normalize addresses by chain, not blanket lowercase.
7. **Price markers can map to an unrelated bar.** `src/lib/fomoMarkers.ts:candleIndexFor` selects the last candle before an event without checking its interval end. A trade in a gap or after the final candle can attach to that older candle. Require interval containment; show unresolved events in a separate event lane until the proper candle exists.

## Chart and trader experience

Default desktop layout: narrow watchlist on the left, chart taking roughly two-thirds of the central workspace, linked trader/event inspector on the right, and a compact tape beneath. Resize/collapse each pane; save layout per workspace. Avoid squeezing long descriptions into the chart header.

- **Main chart:** clean USD candles by default; explicitly labeled estimated market-cap mode; restrained grid, legible numeric font, tabular digits, muted charcoal background. Reserve green/red for direction, amber for delayed/partial data, blue for selection. Keep pixel branding in the logo rather than dense data text.
- **Two lower panes by default:** volume and net flow/CVD with synchronized time and crosshair. Indicators and extra panes are opt-in, with sensible heights and persisted settings.
- **Trader overlay controls:** followed wallets, publicly attributed wallets, FOMO-classified wallets, anonymous large trades; independent minimum notional and buy/sell filters. Protocol classification and public handle attribution are separate facts.
- **Markers:** small directional glyphs scaled by notional, abbreviated names only for selected/followed traders, clusters at wide zoom. Hover previews; click pins the complete inspector. Never cover candles with dozens of text labels.
- **Inspector:** handle/address, attribution source and freshness, chain, execution timestamp, venue, price, quantity, notional, transaction link, price source, confirmation state, and observed position change. Use “first observed buy” until historical completeness proves new entry.
- **Former participants:** selectable entry/add/reduce/exit/re-entry timeline; faded historical markers; remaining balance and partial-history flag. A sell is not automatically an exit, and a wallet transfer is not automatically a trade.
- **Context lane:** launches, migrations, liquidity changes, sourced news, and large participant activity aligned to time. Selecting a tape row highlights the corresponding candle and opens the same inspector.
- **Why:** show confirmed actions, contemporaneous conditions, and explicitly labeled hypotheses separately. Example: “Wallet bought $12k; price was above session VWAP and five-minute volume exceeded its baseline.” “Bought because of the announcement” requires the trader's own attributable statement; even that is a stated reason, not independently proven motivation.
- **Navigation:** retain wheel zoom, two-axis pan, price-axis scaling, fit/live/reset, drawings, and pane resize. Add historical paging, go-to-time, keyboard command search, session timezone, replay, and linked multi-chart layouts after correctness is established.

## Data and performance architecture

The current tail `series.update()` path is a good foundation (`src/components/MarketChart.tsx:190`). Keep it. Indicators still recompute across the full history during updates; profile realistic multi-pane loads before introducing incremental indicator state or workers.

Replace 15-second flow and 45-second market polling (`src/pages/DeskPage.tsx`) with one instrument subscription over SSE or WebSocket, initial snapshot plus sequenced deltas, reconnect cursor, and gap repair. Upstream websocket support alone does not make browser delivery real-time. Retain polling as a recovery path. Batch rendering per animation frame and isolate tick updates from React's entire desk tree.

Use one normalized server event stream to derive candles, tape, trader positions, and alerts. Preserve provider provenance, venue scope, event ordering, and corrections. Pool-specific candles must not silently absorb trades from unrelated venues. For composite prices, define venue filtering and aggregation explicitly.

Persist append-only raw/normalized events plus indexed derived history; bounded in-memory rings remain caches. The book currently caps 20,000 fills and 5,000 wallets (`server/traders/book.ts`); the flow ledger caps pairs and recent prints. Atomic JSON snapshots already provide restart recovery (`server/persist/store.ts`) but not a durable queryable history or complete replay. Start with an indexed local database suitable for the current single-machine service; scale storage only after measuring throughput and retention needs.

Add per-source queue lag, event age, RPC throttling, decode failure, dropped-event counts, price coverage, reconciliation mismatch, and browser render latency. Show instrument-specific LIVE / DELAYED / PARTIAL / OFFLINE states rather than inferring health from HTTP 200 or socket connectivity.

## Additional improvements

- Saved watchlists, trader follow lists, keyboard command palette, linked selection, and replay bookmarks.
- Alerts based on observed entries, unusual size relative to wallet history, liquidity changes, and clustered activity; include evidence, coverage, cooldown, and deduplication.
- Separate raw wallet activity from claims of skill. Show sample size, observation window, incomplete positions, fees, and selection bias before ranking performance.
- Runtime validation at provider and browser boundaries, including finite OHLCV, ordering, interval alignment, and price/volume units.
- Lazy-load wallet/auth and analysis UI after profiling; virtualize long tapes and tables. Avoid prematurely replacing the chart library.
- Update README: it describes `/perps`, while `src/App.tsx` currently exposes `/onchain` and redirects other routes. Replace legal hash placeholders with actual content before public release.
- Test real quote/sign/submit/confirm behavior in a controlled environment once credentials exist. Current static review does not establish live execution readiness.

## Delivery order and acceptance gates

1. **Truth and consistency:** watermark/reconciliation, canonical event identity, interval containment, accurate trader-stat labels. Gate: duplicate provider deliveries, delayed events, same-tx multiple executions, provider corrections, chain reorgs, and reconnect replay produce identical tape/candle totals within declared coverage.
2. **Trader context:** shared chain adapters, historical range API, identity provenance, position ledger, pinned inspector. Gate: every visible marker opens its evidence; no entry/exit or profit assertion from incomplete data.
3. **Visual polish:** calm typography, clustered markers, event lane, linked views, saved layouts. Gate: labels remain readable and candles usable at narrow widths, high zoom, and busy-event density.
4. **Measured speed and context:** streaming, render batching, profiling, replay, sourced event correlations. Proposed targets—not measurements: p95 local ingest-to-render below 250 ms, p95 warm instrument switch below 500 ms, and smooth 60 Hz navigation on the agreed target machine. Measure upstream delay separately and load-test against a declared event rate.

## Primary references

- Bloomberg chart tools: https://professional.bloomberg.com/products/bloomberg-terminal/charts/
- TradingView renderer and data-feed distinction: https://tradingview.com/charting-library-docs/latest/getting_started/product-comparison/
- TradingView series-marker API: https://tradingview.github.io/lightweight-charts/tutorials/how_to/series-markers

These references inform the product direction; repository findings above come from current local code. No full implementation or new performance benchmark was performed in this review.
