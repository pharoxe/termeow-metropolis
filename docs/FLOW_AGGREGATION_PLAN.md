# termeow flow aggregation plan — all-pairs token flow, live feeds, charts, CVD

Companion to `INTEGRATION_PLAN.md`. Branch `solana-desk` at 62f913d. Written 2026-09-06 after live
probes of every source named below (a probe is a real request made today; "measured" means the
number came back from that request). Nothing here is implemented yet.

## 1. What the three primary sources actually provide

| Source | Gives | Does not give | Measured today |
| --- | --- | --- | --- |
| **Claw REST** `clawpump.tech/api/tokens` | 60-row token list with socials, mcap, vol24, liquidity, launch platform | Per-mint lookup, trades, pools, candles (all 404) | 36 fields per row; every other path returns the site HTML |
| **Claw MCP** (`@clawpump/agents` 0.1.23, 136 tools) | `token_search`, `get_price` (multi-token, Birdeye passthrough), `intelligence_market` (holders, top pools, price changes), `intelligence_signals`, `intelligence_macro`, `intelligence_perps`, `arbitrage_prices` / `arbitrage_quote` (per-DEX price snapshot), `perps_market_data` (Phoenix candles **and order book**), `get_news_feed` | Any trade tape, any per-pool flow, any OHLCV for spot tokens, any websocket | 58 market-flavoured tools of 136; none returns trades |
| **Pump** `swap-api.pump.fun/v2/coins/{mint}/trades` | Keyless trade tape with `type` buy/sell, `amountUsd`, `amountSol`, `userAddress`, `program`, `tx`, `timestamp`; `limit` ≤ 100; **cursor pagination** (`pagination.nextCursor` → `?cursor=`) back to launch | Trades on non-pump venues | ANSEM: 100 trades = 37 min = $26.9k, all `pump_amm`; PumpSwap is 16% of ANSEM's 24h volume, Meteora pools carry 80% |
| **Pump candles** `v1/coins/{mint}/candles` | 1m/5m/… OHLCV on pump venues | Other venues | Live |
| **Pump meta** `frontend-api-v3.pump.fun/coins/{mint}` | Bonding curve, socials, creator | | Live |
| **PumpPortal** `wss://pumpportal.fun/api/data` | `subscribeNewToken` free | `subscribeTokenTrade` / `subscribeAccountTrade` need an API key funded with ≥ 0.02 SOL | Both facts returned by the socket today |

Conclusion: **Claw is discovery, pool list, intel and the Phoenix perp book. Pump is a complete but venue-limited tape. Neither covers a token across all of its pairs**, so aggregation needs the keyless complements below and the app's own on-chain tape.

## 2. Aggregation design: one token, every pair

### Pair registry (per token, refreshed 60s)
Union of:
- DexScreener `token-pairs/v1/{chain}/{addr}` (ANSEM: 30 pairs; FATCOIN on Robinhood: 30 pairs) with per-pair `liquidity`, `volume.{m5,h1,h6,h24}`, `txns.{m5,h1,h6,h24}.{buys,sells}`
- GeckoTerminal `networks/{net}/tokens/{addr}/pools` (ANSEM: 20 pools)
- Claw `intelligence_market.top_pools`
- pump.fun bonding curve + PumpSwap pool from coin meta

Each pair row: `chain, dex, pairAddress, quoteMint, liquidityUsd, vol24, share24, txns, source[]`. `share24` = pair vol24 / sum over pairs.

### Coverage tiers
- **Tier A** = smallest set of pairs reaching ≥ 95% of 24h volume, cap 4. These get trade-level flow (side + USD).
- **Tier B** = everything else. Counts only (DexScreener buys/sells per window). Shown as counts, never converted to USD.
- The panel prints the truth: `flow covers 97% of 24h volume · 4 of 30 pairs trade-level · 26 counts-only`.

ANSEM today: top 4 pairs = 96% of $15.0M. FATCOIN: one Uniswap v3 pool dominates.

### Trade-level sources per Tier A pair
| Chain | Primary | Backfill | Notes |
| --- | --- | --- | --- |
| Solana, pump venues | pump v2 trades (poll 5s, cursor backfill to launch) | same | complete history, keyless |
| Solana, any venue | own tape: RPC `logsSubscribe({mentions:[mint]})` → `getTransaction` → pool-vault token-balance deltas | GeckoTerminal per-pool trades (last ~300, 15s poll) | public RPC accepts ~1 tx/s; Helius free 10 rps (standard ws confirmed with the project key) |
| Robinhood, any venue | own tape: `eth_getLogs` every 2s for Swap topics on Tier A pool addresses (Uniswap v2 `0xd78ad95f…`, v3 `0xc42079f9…`, v4 PoolManager `0x40e9cecb…` filtered by poolId) | GeckoTerminal `robinhood` per-pool trades | official RPC has no websocket (400/404); dRPC HTTP works, its websocket is paid; 622 v3 + 679 v4 swaps chain-wide per 200 blocks (~20s) |

### Normalization rules
- Side: a print is a **buy** when the token leaves the pool (buyer receives it). Solana: sign of the pool's token-vault delta. Uniswap v3: sign of `amount0`/`amount1` against `token0()`/`token1()` (decode verified today on pool `0x6d04…7ac1`). v2: `amount0Out > 0` means token0 bought. v4: same via `delta` sign and the pool key.
- USD: pump gives `amountUsd`; Gecko gives `volume_in_usd`; own tape prices the quote leg (SOL, USDC, WETH) with Jupiter price v3 (keyless) or DexScreener pair price at bucket time. A print that cannot be priced is kept with `usd: null` and counted, not guessed.
- Dedupe key: `(chain, tx, pairAddress)`. A Jupiter route split across two ANSEM pools produces two real pool prints and both count; the same print seen from pump v2 and own tape counts once.
- Timestamps: Solana `blockTime`; Robinhood block timestamp cached per block number.

### Ledger (from the integration plan, now keyed per pair)
- Minute epoch buckets `{ t, buyUsd, sellUsd, buys, sells, unpricedBuys, unpricedSells }` per `chain:pair`; hourly tier at ingest; 48h / 30d retention; LRU 64 pairs; optional `FLOW_STORE_DIR`.
- **Token series** = bucket-wise sum over the token's Tier A pairs, with per-pair breakdown kept. Coverage = volume-weighted share of pairs that have buckets in the window.
- Anchors: `window` (first bar shown), `session` (server start), `launch` (pump v2 backfill makes this real for pump-launched tokens).

## 3. Live feed catalog: trades and order flow

### Solana
| Feed | What | Auth / cost | Measured | Role |
| --- | --- | --- | --- | --- |
| Public RPC `wss://api.mainnet-beta.solana.com` `logsSubscribe` | Signatures of every tx mentioning the mint, all venues | Keyless | Subscribed and received notifications today | Trigger for own tape |
| `getTransaction` (public / Helius) | Parsed balances → pool prints | Public ~1 rps; Helius free 10 rps, 1M credits/mo | Helius standard ws confirmed with project key | Own tape reader |
| Helius Enhanced ws `transactionSubscribe` | Pre-parsed tx stream | Business plan | 403 on the project key | Not used |
| Helius LaserStream / Yellowstone gRPC | Gapless account/tx stream | Paid | Not probed | Upgrade path |
| pump.fun v2 trades | Side, USD, wallet, cursor history | Keyless | 100/page, `cursor` works | Primary for pump venues + launch backfill |
| PumpPortal ws | Token/account trade push | Key funded ≥ 0.02 SOL | Message received today | Optional push for pump venues |
| GeckoTerminal per-pool trades | Side, USD, last ~300 | Keyless, ~30 req/min | Live; token-level trades are Pro (401) | Backfill + Tier A fallback |
| DexScreener token-pairs | Buys/sells counts + volume per pair per window | Keyless | 30 pairs for ANSEM | Tier B counts, coverage math |
| Solana Tracker Datastream | Swaps by token/pool/wallet, prices, launches | Key; free 2,500 req/mo, 3 rps; €50/mo Advanced | Handshake returns 200 without key | Optional push, all venues |
| Bitquery | Decoded trades all DEXes, subscriptions, 1s OHLCV | $49/mo | Docs only | Optional, also covers Robinhood |
| Vybe ws | Trades by mint/program/wallet | Key | 401 keyless | Optional |
| Birdeye | Token txs | Key | 401 keyless | Not used |
| **Order flow**: Phoenix perps via Claw `perps_market_data(includeOrderbook)` | Order book + candles | Claw key (already wired) | In app today | Only true order book on the Solana side of the desk |

Memecoins on AMMs have no order book. "Order flow" for them is the aggressor-side tape: side, size buckets, wallet cohorts, first buyers. That is what the ledger and the tape render.

### Robinhood Chain (id 4663)
| Feed | What | Auth / cost | Measured | Role |
| --- | --- | --- | --- | --- |
| Official RPC `rpc.mainnet.chain.robinhood.com` HTTP | `eth_getLogs`, `eth_call`, blocks | Keyless | 622 v3 + 679 v4 Swap logs per 200 blocks; no websocket | Own tape (poll 2s) |
| dRPC `robinhood.drpc.org` | HTTP JSON-RPC | Keyless HTTP; ws subscriptions paid | `eth_chainId` OK; `eth_subscribe` refused on free plan | HTTP fallback |
| Alchemy Robinhood | HTTP + ws | Key | Demo key 429 | Keyed ws upgrade if `ALCHEMY_API_KEY` is set |
| GeckoTerminal network `robinhood` | Per-pool OHLCV + trades | Keyless, rate-limited | Pool endpoint live; 429 under load | Candles + backfill |
| DexScreener chainId `robinhood` | Pairs, txns, socials, profiles, boosts | Keyless | 30 pairs for FATCOIN; 21/30 latest profiles are robinhood | Registry, Tier B, launches |
| Blockscout `robinhoodchain.blockscout.com/api/v2` | Transfers, holders | Cloudflare challenge for headless clients | 403 "Just a moment" | Not usable server-side |
| robinhoodtrenches.com REST + ws | Fills of 147 tracked fomo.family traders | Keyless, unofficial | Live | Cohort tape, not market tape |
| Bitquery Robinhood | All DEX trades, launchpads (Pons, pools.trade v4, hood.fun…), subscriptions | $49/mo | Docs | Optional market-wide push |
| **Lighter** `mainnet.zklighter.elliot.ai` REST + `wss://…/stream` | Perp order books, recent trades, liquidations, `trade/{market}` and `order_book/{market}` channels | Keyless | Order books, trades and ws frames received today | The only real order book + trade stream in the Robinhood ecosystem (zk-rollup, off-chain; integrated in Robinhood Wallet) |

## 4. Charting

- **Per pair** (exists): GeckoTerminal OHLCV, pump candles, lightweight-charts panes.
- **Token-level (new, AGG toggle)**: price from the highest-liquidity Tier A pair (Gecko token OHLCV is Pro-only); `high`/`low` = max/min across Tier A pairs; volume = sum across all pairs; venue share stacked under the price. Labelled `AGG · 4 pairs · 97%`.
- **Own candles**: when Gecko is rate-limited, build 1m candles from own-tape prints (every print carries price). Robinhood gets this from the decoded swap logs.
- **Live tick**: the newest print updates the forming candle between polls.
- **Panes**: price · volume by venue (stacked) · Δ/bar token-level (split histogram, buys up in green, sells down in red) · CVD lines (token bold, Tier A pairs thin) · coverage shading with `no tape ◀` boundary.
- Robinhood pools chart through the same component with `chain=robinhood`.

## 5. CVD and the side outputs

Definitions (all from the ledger, all labelled with population and coverage):
- **Token CVD** = Σ over Tier A pairs of cumulative (buyUsd − sellUsd) from the anchor.
- **Pair CVD** per Tier A pair; **venue share** of net flow.
- **Side outputs per window (1m / 5m / 15m / 1h)**: buy USD, sell USD, net, print counts, aggressor ratio = buyUsd / (buyUsd + sellUsd), average buy vs average sell size, large prints ≥ $1k listed.
- **All-pairs count ratio** from DexScreener (includes Tier B): buys / (buys + sells) per window. Counts only.
- **Since anchor**: net USD since launch (pump backfill), since session, since window start.
- **Flags** (deterministic): absorption, distribution, divergence, as in the integration plan.

Visualization: split histogram + net line per bar; a side ribbon under the chart (buy share per bar as a 0–100% strip); per-venue stacked delta; tape with side colour and size class; a coverage chip on every number.

## 6. Phases

Numbering continues the integration plan (its Phase 0 hardening and Phase 1 ledger are prerequisites).

### F1 — Pair registry + token aggregation + pump backfill
New: `server/flow/registry.ts`, `server/flow/aggregate.ts`, `server/sources/pumpfun.ts` (v2 trades with cursor walk, candles, meta), `server/routes/flow.ts` (extend), `src/components/FlowCoverage.tsx`.
- Registry from DexScreener ∪ Gecko ∪ Claw ∪ pump; tiering; 60s refresh; cached per token.
- pump v2 poller (5s) for pump pairs; backfill walker to launch with `cursor`, rate 2 pages/s, resumable.
- `GET /api/flow/token/:chain/:addr?interval=&anchor=` → `{ bars (token-level), pairs: [{ pair, dex, share24, tier, bars }], coverage, counts (DexScreener all-pairs), observedAt, stale?, error? }`.
Tests: tiering math on fixture registries; cursor walker idempotence; token sum equals pair sums; coverage weighting.
Accept: ANSEM shows `AGG 4/30 pairs 96%`; net-since-launch populated from pump backfill; pair breakdown sums to token bars.

### F2 — Own tape on Solana
New: `server/tape/solana/{subscribe,reader,parseSwap,price}.ts`.
- `logsSubscribe` per focused mint on `config.rpc.primary` websocket (Helius when set, public otherwise); reconnect and resubscribe on drop.
- Reader queue: `getTransaction(jsonParsed)` at 1 rps public / 8 rps Helius, bounded queue, `dropped` counter surfaced.
- `parseSwap`: pool vault deltas for the mint's Tier A pairs → prints `{ tx, pair, side, tokenAmount, quoteAmount, usd|null, wallet, slot, time }`; unpriced kept.
- Ingest into the ledger with the dedupe key; tape route gains `source: "own"` rows.
Tests: parser fixtures for PumpSwap, Meteora DLMM, Raydium AMM v4, Orca (captured real txs); reconnect state machine.
Accept: with Helius key, 95% of Gecko's prints for the top pair appear in own tape within 5s; queue never exceeds 120.

### F3 — Own tape on Robinhood
New: `server/tape/robinhood/{poller,decode,blocks,price}.ts`.
- Poll `eth_getLogs` every 2s for Tier A pool addresses (v2/v3) and for the v4 PoolManager filtered by poolId; decode side and amounts; block timestamp cache; USD via quote token price.
- Keyed websocket path (`eth_subscribe logs`) when `ALCHEMY_API_KEY` is set.
- Own 1m candles from prints when Gecko is blocked.
Tests: decoders against captured logs (v2, v3, v4); poller cursor and reorg guard (re-read last 5 blocks).
Accept: FATCOIN delta bars update within 3s of a swap; counts match DexScreener h1 buys/sells within 5%.

### F4 — Charts and side outputs
Touched: `MarketChart.tsx`, `DeskPage.tsx`, `FlowPanel.tsx`, `styles.css`.
- AGG toggle, venue-stacked volume, split delta histogram, CVD lines, side ribbon, coverage shading, live tick.
- FLOW panel: windows table, aggressor ratio, large prints, all-pairs counts, since-anchor row.
Tests: aggregation helpers; snapshot of series construction with fixtures.

### F5 — Optional paid or push upgrades (flags, default off)

**Status 2026-09-06:** shipped keyless parts only. Lighter perp order book, taker-side tape and flow windows are live under `/api/lighter/*` and the LIGHTER watch tab (verified: 233 markets, stream book within one poll, trades and flow bars advancing). The Robinhood poller now scopes v4 logs by poolId server-side (drop ratio 99% → 0%), which is the keyless substitute for a websocket. Not built, pending credentials that do not exist in this environment: PumpPortal push (needs a key funded with 0.02 SOL), Solana Tracker push, Bitquery, Alchemy Robinhood websocket. They stay flags in the plan, not code.

- `PUMPPORTAL_API_KEY` (0.02 SOL) → push for pump venues.
- `SOLANATRACKER_API_KEY` → all-venue push on Solana.
- `BITQUERY_TOKEN` → market-wide Robinhood push and launchpad feeds.
- `ALCHEMY_API_KEY` → Robinhood websocket.
- Lighter perp book + trades panel for the perps mode (keyless, could ship earlier as read-only).

## 7. Budgets

| Upstream | Limit | Plan usage |
| --- | --- | --- |
| GeckoTerminal | ~30 req/min shared | candles 1.3/min per pair, trades fallback 4/min per Tier A pair when own tape is down, Robinhood pools same bucket |
| DexScreener | ~300 req/min | registry 1/min per token, counts 4/min per token |
| pump.fun swap-api | undocumented | 12/min per pump pair + backfill 2 pages/s bounded |
| Solana public RPC | ~1 getTransaction/s | reader queue 1 rps, drop counter |
| Helius free | 10 rps, 1M credits/mo | reader 8 rps cap → ~2.9M reads/mo if saturated; cap daily reads at 25k |
| Robinhood RPC | undocumented | 30 `eth_getLogs`/min + block lookups cached |

## 8. Risks

- Gecko 429s stall candles: own candles from prints cover it.
- Public Solana RPC throttles: reader degrades to 1 rps and says so; Helius key removes it.
- Robinhood RPC has no push: 2s polling adds up to 2s latency; keyed websocket removes it.
- pump v2 is undocumented: pin fields in a fixture test; on shape change the source flips to `error` and the pair falls back to Gecko.
- Unpriced prints: shown as counts; never converted with a guessed price.
- Route splits and MEV sandwiches: each pool leg is a real print; sandwiches are real flow. No filtering, but the tape marks same-block buy+sell by one wallet as `SANDWICH?` for the reader.

## 9. Decisions needed

1. Spend 0.02 SOL on a PumpPortal key for pump-venue push, or stay on 5s polling (the plan works either way).
2. Whether market-wide Robinhood push matters enough for Bitquery at $49/mo; the 2s poller is the default.
3. Helius key: the old one is in `~/terminal-v-old.env` and was exposed in chat; rotate before putting it in the new `.env`.
4. Whether Lighter (perp order book in Robinhood Wallet) belongs on the perps page next to Phoenix.
