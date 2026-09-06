# termeow integration plan — CVD/delta, social trading, Robinhood launches

Branch `solana-desk` at 62f913d. Written 2026-09-06 after a full read of `server/` and `src/`
plus live probes of every external source named below. Nothing in this document is implemented yet.

## 1. Summary

Three additions, delivered in five phases, none of which changes an existing route's contract:

| Feature | Shape | Depends on |
| --- | --- | --- |
| **CVD + delta** | Server-side per-pair flow ledger (1-minute epoch buckets, txHash-deduped) that accrues from GeckoTerminal prints; anchored CVD, per-bar delta, net-flow windows, coverage boundary on the chart | Phase 0 Gecko client |
| **Social trading (fomo.family)** | Real trader leaderboard, profile drawer, follow chains and a live fill tape, all sourced from robinhoodtrenches.com which indexes ~147 fomo.family traders; fomo profiles are link-outs only | Phase 2 chain support (traders trade on Robinhood Chain) |
| **Robinhood DEX launches** | Robinhood Chain (id 4663) as a second chain in the desk: any `0x` address charts with candles and delta; an RH LAUNCHES tab with buy-side/sell-side per launch, honeypot flag, first buyer, stock-token toggle | Phase 0 Gecko client |

Order: **Phase 0 hardening → 1 flow ledger → 2 Robinhood chain + launches → 3 traders/social → 4 polish**.
Phases 1 and 2 are independent of each other after Phase 0; 3 needs 2.

What this plan will **not** do, and why:

- Scrape fomo.family. Its robots.txt disallows `/profile/`, `/user`, `/token`, `/coin`; profiles sit behind a Privy login; there is no public API (probed today: every `/api/*` path returns the HTML shell). Handles link out to `https://fomo.family/profile/<handle>`, nothing more.
- Execute trades on Robinhood Chain. The spot ticket is a Solana wallet-adapter flow and the server's Jupiter bridge is Solana-only. Robinhood tokens get "open on Uniswap / DexScreener" links; `ENABLE_MAINNET_EXECUTION` semantics are untouched.
- Sum figures from different populations. Tracked-trader USD (147 wallets) and DEX-wide volume (all wallets) are shown side by side, labelled, never added.

## 2. What exists today (from the code read)

### CVD pipeline
- `server/clawpump/cvd.ts` `computeCvd(trades)` is pure. It re-bases the running sum to 0 at the oldest print of each GeckoTerminal page (~300 prints, 24h max), so the **CVD level drifts every 15-second poll**. "Recent" is a 2h window anchored on the last print, not on now.
- `server/clawpump/market.ts:350` `geckoPoolTrades` has a 15s cache, no in-flight dedupe, and is **outside the Gecko 429 backoff** that protects candles. Upstream is `networks/solana/pools/{pair}/trades` with no pagination.
- Per-bar delta exists only client-side: `src/lib/cvdAlign.ts` first-differences the cumulative series at candle boundaries. `MarketChart.tsx` draws it as a histogram plus a CVD line in pane 1, and **tears the whole chart down on every poll** because `cvdSeries` is in the effect deps.
- Two different things are called DELTA: the histogram (per bar) and the strip readout (2h net USD). `BothSidesPanel` declares `spanLabel` but never renders it and shows counts only, no USD.
- Nothing is persisted anywhere in the server; no WebSocket or SSE exists; all liveness is client `setInterval`.
- Tests: `cvd.test.ts` (7), `cvdAlign.test.ts` (2). `geckoPoolTrades` and the route have none.

### Social / KOL
- The only social fields in the app come from `clawpump.tech/api/tokens` (trenches rows: `twitter`, `telegram`, `xVerified`, `xVerifiedHandle`, `agentXUsername`), spread through unvalidated and rendered as `href` with no scheme check.
- `SocialPanel` shows links only when the focused mint is in the current 60-row trenches page (`focusedTrench` matches `mintAddress` only).
- `market.ts:191` already fetches `frontend-api-v3.pump.fun/coins/{mint}` and discards `twitter`/`telegram`/`website`/`creator`.
- KOL tab is `intelligence_signals` from ClawPump, relabelled. `ResearchPanel` reads `provider.news`, which nothing populates (`get_news_feed` MCP tool exists, unused).
- `AccountScreens.tsx` Leaderboard renders a hard-coded `MOCK_LEADERS` array; Referrals are synthetic.
- Zero occurrences of `fomo`, `robinhood`, `follow`, `creator` in the repo.

### Server invariants
- Same-origin only: Vite proxies `/api` → API port; no CORS, no rate limiter, no server timers.
- Error contract: `ZodError`→400, `UpstreamError`→502, else 500. `/board`, `/trenches`, `getHolders` deliberately return **200 with an `error` field** because the client `request()` throws on non-2xx and would blank the panel.
- `degraded` / `notes[]` / `source` drive the LIVE/PARTIAL chip and `ToolHealth`.
- Execution gate is checked first in every write route; `quoteId` is single-use 60s in-memory.
- MCP `callTool` has **no timeout**; a hung ClawPump child hangs `/board` and `/market`.
- SPA fallback swallows any non-`/api/` route mounted after it. New routers mount beside `index.ts:19-21`.
- `FeatureSection` throws on an unregistered id; stored workspace prefs filter out unknown ids, so a new panel is off for returning users unless the storage key is bumped.
- `.desk-grid` is declared five times in `styles.css` (187, 267, 391, 460, 473, 578); a new grid area must be added to all of them.

## 3. External sources, verified 2026-09-06

| Source | Status | Notes |
| --- | --- | --- |
| fomo.family | No API | robots disallows `/profile/`, `/user`, `/token`, `/coin`; `/api/*` returns HTML. Link-out only. |
| robinhoodtrenches.com | Live, keyless | `GET /api/{status,overview,tokens,tape,radar,flow,traders,closed}` with `window=1h\|24h\|7d\|30d\|all`, `limit`, `stocks`. `wss://robinhoodtrenches.com/ws` pushes `{type:"fills"}`. Status today: 147 wallets, indexer lag 0.3s, 1,212 viewers. Every row carries `handle`, `display_name`, `followers`, `profile_url` (fomo.family), `wallet`, `token` (0x), `symbol`, `pair_url`. Unofficial indexer, no ToS page: isolate behind a flag and label it. |
| Robinhood Chain | Live | Arbitrum Orbit L2, chain id 4663 (`eth_chainId` → `0x1237`), public RPC `rpc.mainnet.chain.robinhood.com`, explorer `robinhoodchain.blockscout.com` with a Blockscout v2 API, Uniswap holds nearly all meme liquidity. Documented honeypot/copycat wave. |
| DexScreener | Full coverage | `chainId: "robinhood"`; `token-pairs/v1/robinhood/{addr}` returns pairs with `txns`, `volume`, `info.socials`; 21 of the latest 30 `token-profiles` and `token-boosts` are robinhood. Ghost-liquidity guard from the old desk still applies to search. |
| GeckoTerminal | Indexed as network `robinhood` | `networks/robinhood/pools/{pool}` returns price data; OHLCV and trades use the same paths as Solana. Free tier is ~30 req/min and 429s under the probes today, so `new_pools`/`trending_pools` could not be confirmed. |
| pump.fun coin meta | Already called | Carries token socials + creator, currently dropped. |
| ClawPump MCP | Solana only | Unused tools relevant here: `get_news_feed`, `get_wallet_summaries`, `get_wallet_history`, `get_transactions`. |

## 4. Architecture decisions

1. **Adapter layer, not inline fetches.** New upstreams live in `server/sources/{gecko,dexscreener,robinhoodTrenches,blockscout}.ts`. Each exports typed normalizers, owns its TTL cache and in-flight dedupe, uses `fetchJson` with the 15s timeout, and reports `health()` for `ToolHealth`. Normalizers are pure and tested against fixture JSON captured today (`server/sources/__fixtures__/`).
2. **One Gecko client with a token bucket.** `server/sources/gecko.ts` wraps every GeckoTerminal call (candles, pools, trades, any network) behind a 25-req/min bucket and the existing 20s 429 backoff. Callers that would exceed the budget get the cached value with `stale: true` instead of a 502.
3. **Chain as a first-class dimension.** `server/chains.ts` registry: `{ id, geckoNetwork, dexscreenerChainId, explorerTx, explorerAddress, addressRegex, execution: boolean, intel: "clawpump" | null }`. Existing routes accept `?chain=solana|robinhood` with `solana` as default, so every current URL keeps working.
4. **Failure contract stays 200 + `error`.** New read routes never throw past the error handler; they return the last good payload with `stale`/`error` fields. Write routes keep the execution gate first.
5. **Feature flags in env, off means invisible.** `FLOW_LEDGER_ENABLED` (default true), `FLOW_STORE_DIR` (default unset → memory only), `RH_FEED_ENABLED` (default true), `RH_FEED_STOCKS` (default false). `integrationStatus()` reports them; the UI hides panels whose source is disabled rather than showing empties.
6. **Data honesty.** Null stays null. Every panel names its source and population. Coverage is drawn, not implied. A ticker match across chains is never treated as the same token.
7. **Shared wire types.** `shared/wire.ts` (added to `tsconfig include`) holds `PoolTrade`, `FlowBar`, `Launch`, `Trader`, `Fill`; `src/` and `server/` import them type-only, ending the hand-duplicated `PoolTrade`.

Rate budget (GeckoTerminal free tier ≈ 30/min):

| Caller | Cadence | Per subscribed pair | Cap |
| --- | --- | --- | --- |
| Flow collector (trades) | 15s | 4/min | 4 live pairs → 16/min; 5th+ pair polls at 60s |
| Candles | 45s | 1.3/min | |
| Resolution (pools list) | on focus | 1–3 | |
| Reserve for RH launch pricing | | | 5/min |

## 5. Phases

### Phase 0 — Hardening prerequisites (small, no visible features)

Files: `server/clawpump/mcp.ts`, `server/sources/gecko.ts` (new), `server/clawpump/market.ts`, `server/routes/onchain.ts`, `server/clawpump/cvd.ts`, `shared/wire.ts` (new), `src/lib/safeUrl.ts` (new), `src/components/DeskPanels.tsx`, `tsconfig.json`.

- MCP `call()` races `callTool` against a 12s timer → `{ ok:false, error:"clawpump timeout" }`. Test with a never-resolving stub.
- Gecko client: token bucket + backoff + in-flight dedupe + `network` parameter. `geckoPoolTrades` moves onto it. Existing `market.test.ts` keeps passing (`resetGeckoBackoff` preserved).
- `/api/onchain/trades/:pair`: base58 validator; on upstream failure return the cached window with `stale: true, error` and 200; client keeps last good state instead of zeroing.
- `computeCvd` recent window anchored on `now` (injectable for tests): last print older than 2h → recent counts 0, `flow: "flat"`, `spanLabel` reads `STALE 3H`.
- `safeUrl()` allows `http(s)` only; applied to every `href` built from provider data.
- `BothSidesPanel` renders `spanLabel` and recent buy/sell USD; handle precedence unified to `xVerifiedHandle || agentXUsername`.
- Strip readout renamed `NET 2H`; histogram title `Δ/BAR`.

Acceptance: `npm run check` green; new tests for timeout, bucket, stale envelope, safeUrl, anchored recent window. No UI layout changes.

### Phase 1 — Flow ledger, anchored CVD, per-bar delta

New: `server/flow/ledger.ts`, `server/flow/collector.ts`, `server/flow/store.ts`, `server/routes/flow.ts`, `src/lib/flowSignals.ts`, `src/components/FlowPanel.tsx` (extends BothSidesPanel).
Touched: `server/index.ts` (mount `/api/flow`), `server/config.ts`, `src/api/client.ts`, `src/pages/DeskPage.tsx`, `src/components/MarketChart.tsx`, `src/components/DeskPanels.tsx`, `src/styles.css` (chips only).

Ledger
- Key `chain:pair`. Minute buckets `{ t, buyUsd, sellUsd, buys, sells }` on epoch boundaries so a bucket start is a candle open for every interval. `ingest(trades)` dedupes on `txHash` (ring of last 2,000 hashes per pair) so overlapping Gecko pages never double-count.
- Tiers: minute buckets kept 48h; folded into hourly buckets at ingest (hourly kept 30d). `series(bucketMs, from, to)` merges tiers disjointly (hour keys covered by minute data are excluded from the hourly tier). Unit-tested for exact totals.
- `coverage(from, to)` = share of the window at or after the first ingested print. Long intervals will show partial coverage; that is drawn, not hidden.
- LRU of 64 pairs; each pair ≤ 48×60 + 30×24 buckets ≈ 60 KB.
- `store.ts`: when `FLOW_STORE_DIR` is set, write each pair's JSON every 60s and load on boot; otherwise memory only. Off by default because Railway's disk is ephemeral.

Collector
- Server-side poller for "subscribed" pairs: any pair a client requested flow for in the last 10 minutes. Polls Gecko trades every 15s (60s beyond the 4-pair cap) under the token bucket, ingests, and also refreshes the trades cache so `/trades` costs nothing extra. Replaces per-client fetching; the ledger accrues as long as one viewer is open.

Route
- `GET /api/flow/:chain/:pair?interval=1m|5m|15m|1h|4h|1d&from=&to=&anchor=window|ledger` → `{ chain, pair, interval, bars: [{ time, buyUsd, sellUsd, buys, sells, delta, cvd }], coverage: { from, fraction, firstPrintAt }, anchor, observedAt, source: "geckoterminal→ledger", stale?, error? }`. `cvd` is cumulative from the anchor (default: first bar in the requested window), so the level no longer moves between polls.
- `/api/onchain/trades/:pair` unchanged (still the tape and recent counts).

Client
- `api.flow(...)` polled on the same 15s tick as trades. `MarketChart` gains `flowBars` and splits its effect: chart construction depends on `[candles, indicators, theme, compactAxis]`; flow series update via `setData` on refs. When the ledger has fewer than 2 bars the chart falls back to today's page-based CVD, labelled `PAGE CVD · re-based each poll`.
- Coverage boundary: bars before `firstPrintAt` are dimmed in the delta pane with a `no tape ◀` marker and a hint naming the largest interval fully covered.
- FLOW panel adds a NET table for 1m / 5m / 15m / 1h (buy USD, sell USD, net, prints) from the ledger, plus the coverage chip.
- `flowSignals.ts`: deterministic flags only. `absorption` = close up, delta < 0; `distribution` = close down, delta > 0; `divergence` = price higher high while CVD lower high over N bars. Drawn as small markers, no scores, no words like "bullish".
- Agentic analysis keeps reading `buyUsdRecent - sellUsdRecent`; it also receives `flow.bars` so its "CVD turns positive" condition can use the anchored series. No change to its verdict logic in this phase.

Tests: ledger (dedupe, boundary bucket, fold, disjoint merge, LRU), series aggregation, coverage math, anchor semantics, flowSignals, route validation with a stubbed collector.

Acceptance: open ANSEM, wait 10 minutes: 5m chart shows delta bars inside coverage and a boundary before it; CVD level identical across two consecutive polls; reload keeps the ledger; Gecko calls stay under 25/min with three pairs open (log the bucket).

### Phase 2 — Robinhood Chain + RH launches

New: `server/chains.ts`, `server/sources/robinhoodTrenches.ts`, `server/sources/dexscreener.ts`, `server/sources/blockscout.ts`, `server/routes/launches.ts`, `src/lib/address.ts`, `src/components/LaunchesTab.tsx`, `src/components/SidesPanel.tsx`.
Touched: `server/clawpump/market.ts` (chain param through `rankCandlePairs`, `geckoCandles`, `resolveGeckoCandles`, `getOnchainMarket`; pump.fun and ClawPump mint tools skipped for non-Solana with a note), `server/routes/onchain.ts` (`?chain=` on `/market`, `/candles`, `/trades`, `/holders`; `/quote` and `/transaction` reject non-Solana with 400), `src/lib/mint.ts` (kept; `address.ts` wraps it), `src/pages/DeskPage.tsx`, `src/components/DeskPanels.tsx` (new WatchTab), `src/components/SpotTradeTicket.tsx` (render links instead of the ticket when `chain !== "solana"`), `src/features/WorkspaceFeatures.tsx` (id `launches`, storage key → `termeow-workspace-v2`), `src/styles.css`.

Chain resolution
- `extractAddress(text)` → `{ chain:"solana", address } | { chain:"robinhood", address } | { error }`. Accepts bare `0x…`, `dexscreener.com/robinhood/{pair}` (pair → token via DexScreener), `robinhoodchain.blockscout.com/token/{addr}`, `robinscan.io/token/{addr}`. Existing Solana URL forms unchanged (all `mint.test.ts` cases stay).
- `focusSpot(mint)` becomes `focusToken({ chain, address })`; `mint` state carries chain. Solana behaviour byte-for-byte the same.
- Market for robinhood: DexScreener `token-pairs/v1/robinhood/{addr}` → pairs; Gecko OHLCV + trades on `networks/robinhood`; holders from Blockscout `api/v2/tokens/{addr}/holders` (top 20, `pct` from `total_supply`); socials from DexScreener `info.socials` + `websites`; `provider.dex_pairs` as today; `notes` say `ClawPump intel: Solana only`. Candle fallback ladder skips pump.fun.
- Ledger and `/api/flow` work unchanged with `chain=robinhood`, so RH tokens get delta from day one.

Launch feed
- `robinhoodTrenches.ts`: typed fetchers for `tokens`, `radar`, `tape`, `flow`, `traders`, `closed`, `overview`; TTLs 30s/30s/15s/30s/60s/60s/60s; `stocks=false` by default; `health()` with last success/failure.
- `dexscreener.ts`: `token-profiles/latest/v1` and `token-boosts/top/v1` filtered to `chainId === "robinhood"` (launch discovery beyond the 147 tracked wallets); pair enrichment via `latest/dex/pairs/robinhood/{pair}` for `pairCreatedAt`, `txns`, `volume`, `liquidity`.
- `GET /api/launches/robinhood?window=1h|24h&stocks=0|1&sort=new|net|buyers|volume` → `{ launches: Launch[], overview, observedAt, sources: {...health}, stale?, error? }`. `Launch = { address, symbol, name, isStock, pairAddress, pairUrl, pairCreatedAt, liquidityUsd, priceUsd, change24Pct, dex: { buys24, sells24, volume24 }, tracked: { buyers, usdIn, usdOut, netUsd, firstBuyer: { handle, followers, at }, sinceFirstBuyPct }, holders, honeypot, sources: ("trenches"|"dexscreener")[] }`. Dedupe by lowercase address; `tracked` is null when only DexScreener saw it.

UI
- WatchPanel tab **RH LAUNCHES** (spot mode): sort chips NEW / NET / BUYERS / VOL, a STOCKS toggle (off), rows show symbol, age, a side bar (buys24 vs sells24 share), tracked net USD, first buyer handle, `HONEYPOT` tag in red, `STOCK` tag. Click → `focusToken({ chain:"robinhood" })`.
- **SIDES** panel for a focused RH token (radar area when chain is robinhood, replacing SocialPanel's KOL block which has no RH data): BUY SIDE vs SELL SIDE with three labelled rows: DEX txns (all wallets, 24h), tracked traders (147 wallets, window), ledger delta (Gecko prints, coverage-labelled). Never summed.
- Execution rail on RH: `OPEN ON UNISWAP` (`app.uniswap.org/swap?chain=robinhood&outputCurrency=…`, verify param name at build time) and `DEXSCREENER` links; session card hidden; `TRADING UNAVAILABLE` never shown because no ticket is drawn.
- Ticker tape: RH overview chips (last 5m buys/sells/volume of tracked traders) labelled `RH TRACKED`.

Tests: `extractAddress` matrix (all existing Solana cases + 6 RH forms + EVM-on-Solana error kept for `solana:` scheme), chain registry, each normalizer against captured fixtures, launch merge/dedupe/sort, route validation, `SpotTradeTicket` branch (type-level).

Acceptance: paste `0x12d5ee7917ca430073c3a638ee1e6f0648a98a01` → FATCOIN charts on robinhood with candles and delta within 20s; RH LAUNCHES lists ≥ 20 rows with sources chip; stocks hidden until toggled; no execution controls on RH; all Solana flows unchanged (`ANSEM` regression walk-through recorded).

### Phase 3 — Social trading: traders, profiles, follow chains

New: `server/routes/traders.ts`, `server/sources/robinhoodTrenchesWs.ts` (single upstream socket → SSE fan-out), `src/components/TraderDrawer.tsx`, `src/components/TradersLeaderboard.tsx`, `src/lib/wilson.ts`, `src/lib/sse.ts`.
Touched: `server/index.ts`, `src/api/client.ts`, `src/components/AccountScreens.tsx` (Leaderboard → real data; Referrals left as is but labelled PREVIEW), `src/components/DeskPanels.tsx` (SocialPanel: token socials from pump.fun/DexScreener; `FOMO TAPE` block for RH tokens), `server/clawpump/market.ts` (widen pump.fun meta read), `src/features/WorkspaceFeatures.tsx` (id `traders`).

Routes
- `GET /api/traders?window=24h|7d|30d` → `Trader[]` `{ wallet, handle, displayName, followers, profileUrl, volume, fills, buys, sells, realizedPnl, unrealizedPnl, netPnl, closedTrades, wins, winRate, state, active, lastAt, rank: { wilsonLow, n } }`. `rank` is null when `closedTrades < 5` so tiny samples never outrank real records.
- `GET /api/traders/:wallet` → profile: the row above + `recentFills` (tape filtered to wallet, ≤ 50) + `closed` (closed trades filtered) + `chains` (flow rows where the wallet is lead or follower).
- `GET /api/traders/flow?window=` → follow chains `{ token, symbol, lead, followers[], followerCount, medianLagS, totalUsd, sinceLeadPct }`.
- `GET /api/traders/tape?limit=&token=` → normalized fills.
- `GET /api/traders/stream` → SSE `fill` events from one shared upstream WebSocket, reconnect with 1s→30s backoff, 20s heartbeat, `retry:` hint; clients fall back to 15s polling when SSE errors and say so.

UI
- Leaderboard section: real rows (handle, followers, fomo link, wallet short + Blockscout link, volume, net PnL, win rate with n, state chip), sort by Wilson rank or volume, source chip `robinhoodtrenches · unofficial · Robinhood Chain`. The `YOU` row is dropped (connected wallets are Solana; showing a Solana wallet on an EVM board would be a lie).
- Trader drawer (same pattern as `AgenticAnalysisPanel`): header, stats tiles, recent fills (click → chart on robinhood), closed trades, follow chains joined. `FOLLOW ON FOMO` is a link-out.
- SocialPanel: Solana tokens gain twitter/telegram/website/creator from pump.fun meta (widened read) and DexScreener `info.socials`, removing the `focusedTrench` dependency; RH tokens get `FOMO TAPE`: tracked traders who bought/sold it, first buyer, follow chain.
- Watch tab `TRADERS` (both modes): live tape, newest 40 fills, side colour, handle, size, token → click charts it.

Tests: normalizers, Wilson lower bound (n<5 → null), SSE frame parsing and reconnect state machine (unit, fake socket), profile merge, `safeUrl` on all links.

Acceptance: leaderboard shows real handles within 5s; killing the upstream socket triggers reconnect and the client shows `POLLING` until it recovers; a fill click loads the RH chart; Solana ANSEM SocialPanel shows the X handle without ANSEM being in the trenches page.

### Phase 4 — Polish (optional, after the three features ship)

- Delta divergence markers on the price pane; RH launch toasts (first buy by a handle with > 100k followers, in-app only).
- Wire `get_news_feed` into `provider.news` so `ResearchPanel`'s primary branch stops being dead.
- Light-theme pass over every new chip/panel; `docs/` updates; README port fix (5173 → 5174).
- Chart: extend the no-teardown split to candles.

## 6. Do-not-break register

| Invariant | Where | Rule for new code |
| --- | --- | --- |
| Same-origin API | `vite.config.ts`, `src/api/client.ts` | All new routes under `/api/*`, relative paths only |
| Router mount order | `server/index.ts:19-21` | Mount new routers there, before the static block |
| 200 + `error` for read routes | `/board`, `/trenches`, `getHolders` | New read routes follow it; never let a panel blank |
| Execution gate first | `onchain.ts:115`, `perps.ts:52,69` | RH: reject with 400 before anything else |
| Gecko backoff is module-global | `market.ts:124` | Tests call `resetGeckoBackoff()` in `afterEach` |
| `getOnchainMarket` non-5m recursion | `market.ts:545` | Chain param must flow through the recursive call |
| `.js` imports in `server/`, extensionless in `src/` | tsconfig | Keep both |
| `FeatureSection` throws on unknown id | `WorkspaceFeatures.tsx:53` | Register before JSX; bump storage key |
| `.desk-grid` declared 5 times | `styles.css` | Prefer tabs/drawers over new grid areas (this plan adds no grid area) |
| `/api/health` shape | `railway.toml` | Add fields, never rename |
| `dist/index.html` required in prod | `index.ts:25` | No change to build output paths |
| Caches are unbounded Maps | `market.ts` | New caches are LRU-capped (ledger 64 pairs, launches 1 key per window) |
| `src`/`server` types drift | `types.ts` ×2 | New wire types go in `shared/wire.ts` |

## 7. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| robinhoodtrenches.com is unofficial and could vanish or add auth | Phases 2–3 lose their social/launch feed | Adapter isolation, `RH_FEED_ENABLED`, DexScreener as the second launch source, UI labels the population |
| GeckoTerminal 429s (seen during today's probes) | Delta/candles stall | Shared bucket, stale-serve, collector backs off to 60s, coverage chip shows the gap honestly |
| Honeypots on Robinhood Chain | A launch row invites a bad click | `honeypot` flag from trenches shown red; Blockscout verified-contract check in Phase 4; no execution path exists |
| Chart refactor (no teardown) | Regression in the one component everyone looks at | Behind a `flowBars` prop; old `cvdSeries` path kept as fallback until Phase 4 |
| Workspace storage key bump | Returning users see the onboarding dialog again | Migrate: read v1, add new ids, write v2 |
| MCP timeout changes error text | `notes` strings in UI | Same `tool: error` format |

## 8. Decisions needed from you

1. Ledger persistence: memory only by default (survives while the server runs). Set `FLOW_STORE_DIR` locally if you want it to survive restarts on this Mac.
2. Leaderboard population: Robinhood Chain tracked traders only. There is no equivalent Solana social source without scraping; ClawPump `get_wallet_summaries` could add Solana wallet stats later, without handles.
3. RH LAUNCHES as a watch tab (no grid change) versus its own panel (needs all five grid declarations edited). This plan chooses the tab.
4. Robinhood execution stays out. If you later want it, it is an EVM wallet (wagmi/viem) plus a Uniswap Universal Router path, a separate project.

## 9. Delivery checklist per phase

- Tests first for every pure module (ledger, normalizers, address parsing, Wilson, signals).
- `npm run check` green; captured fixtures committed under `server/sources/__fixtures__/`.
- Manual walk-through recorded: ANSEM (Solana) unchanged, FATCOIN (Robinhood) working, both themes.
- `docs/` updated; `.env.example` gains the four flags with comments.
