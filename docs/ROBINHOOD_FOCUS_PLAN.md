# termeow → Robinhood meme desk: focus plan

Written 2026-09-06 against `solana-desk` @ 5297445. Every external fact below was measured today with a
live request; every code fact comes from a full read of `src/` and `server/`.

## 1. What the terminal is today

| Layer | Size | What it actually does |
| --- | --- | --- |
| Client | 45 files, 4,109 lines + 918 CSS | One page (`DeskPage`, 469 lines). Every data feed is Solana-hardcoded: board, trenches, holders, market, legacy trades, flow (`api.flowToken("solana", …)`). The ROBINHOOD/SOLANA toggle switches **nothing on the data side**; it only picks which Privy wallet funds. |
| Server | 39 files, 7,085 lines, 367 tests | Solana market path (`clawpump/market.ts`, 713 lines: DexScreener + Gecko + pump.fun + ClawPump MCP), the chain-neutral flow stack (registry, ledger, aggregate, collector, side outputs), own tapes for Solana and Robinhood, Lighter venue. |
| Reachable Robinhood | 1 capability | Funding a Privy EVM wallet on chain 4663. The Robinhood own tape (1,410 lines) and `chain=robinhood` on `/api/flow/token` exist but **no client path requests them**. |

Mocks shipping as UI: Automation (hard-coded strategies), Referrals ("Placeholder value"), Leaderboard (five invented traders), RobinhoodPortfolio (static stub), the SWAP/BRIDGE preview string, the `@blknoiz` special case for ANSEM, and the synthesized bubbles in the "Live Feed" panel.

Dead: `OnchainPage.tsx` (133), `EvidencePanel.tsx`, `MarketStats.tsx`, `SignalRadar`, `ToolHealth`, `api.candles` + `/api/onchain/candles`, `LIGHTER_SOURCE`, duplicated Gecko backoff and swap-topic constants.

Heavy for their value: `Grainient.tsx` + `SpecularButton.tsx` = 698 lines of WebGL for a backdrop and one button (17% of non-test client code).

Trader identity: **no print anywhere carries who traded.** `FlowPrint` has chain, pair, tx, time, side, usd, source. The Solana parser computes signers and discards them; the Robinhood decoder ignores the `sender`/`recipient` topics.

## 2. What the product is

A desk for meme tokens launching on Robinhood Chain:

1. **Launches** — every launchpad on chain 4663, from creation through curve to graduation, in one feed.
2. **Token page** — chart, all-pairs flow, CVD and delta for any Robinhood token (the flow stack already does this; it only needs the client to ask for `chain=robinhood`).
3. **FOMO social tape** — fomo.family wallets identified on chain, named where a handle is known, and placed on the chart and tape the moment they trade.

Everything else is either supporting infrastructure or a candidate to cut.

## 3. fomo.family wallets: how identification works (measured)

fomo.family is "multichain and gasless". On Robinhood Chain that means:

- **Every fomo trader wallet is an EOA delegated with EIP-7702** to one contract. `eth_getCode(wallet)` returns exactly `0xef0100e6cae83bde06e4c305530e199d7217f42808555b` for **24 of 24** wallets sampled from the robinhoodtrenches tape (handles: unipcs, orangie, songz, Binkieee, …). The delegate `0xe6cae83bde06e4c305530e199d7217f42808555b` (3,639 bytes) is the FOMO account implementation. That is a deterministic fingerprint: **an address is a FOMO account iff its code equals that designator.** No scraping, no API.
- **Every fill is relayed.** `tx.from` is a bundler, never the wallet. Two relay paths were observed:
  - EntryPoint `0x4337084d9e255ff0702461cf8895ce9e3b5ff108` (ERC-4337): the receipt carries `UserOperationEvent` (topic0 `0x49628fd1…`) whose `topics[2]` is the account. Matched the trader wallet in **3 of 3** receipts.
  - Relay `0xccc88a9d1b4ed6b0eaba998850414b24f1c315be` (7,746 bytes): no user-operation event. The trader is still recoverable because the traded token's ERC-20 `Transfer` in the same receipt has the wallet as `to` (buy) or `from` (sell). Held in **3 of 3** receipts; and in **6 of 6** overall the wallet appears in the receipt's Transfer logs.
- **Handles.** robinhoodtrenches.com exposes 147 tracked traders with `handle`, `followers` and the fomo.family profile URL (`/api/traders`), and every tape row carries `handle` + `wallet`. That is the seed map wallet→handle. FOMO accounts outside that set are labelled `FOMO · 0xabcd…ef12` until a handle is learned. fomo.family itself stays link-out only (robots disallows profiles; no public API).

Attribution pipeline for a swap on a tracked Robinhood pool:

1. The poller already receives the Swap log. Add the receipt fetch for that tx (one `eth_getTransactionReceipt`; tracked-pool swaps run ~10–20/min on FATCOIN, well inside the public RPC budget once v4 scoping is on).
2. Candidate trader = `UserOperationEvent.sender` if present; else the counterparty of the largest Transfer of the traded token in the receipt that is not a pool, router or the PoolManager.
3. Classify the candidate once via `eth_getCode` (cached forever, positive and negative): FOMO if it equals the designator; otherwise `other`.
4. Attach `trader: { address, kind: "fomo"|"other", handle?, followers? }` to the print. The ledger, windows and large-print ring need nothing new; a FOMO cohort filter is a predicate on prints.

Discovering FOMO wallets proactively (so the set is not limited to 147): one extra `eth_getLogs` leg per poll on the EntryPoint for `UserOperationEvent` over the same block window yields every account-abstraction sender on the chain; classify each new sender by code. This is cheap (one request per two seconds) and builds the complete FOMO population organically.

## 4. Launchpads on Robinhood Chain: keyless coverage (measured)

Factory addresses and events from Bitquery's public docs, all verifiable with `eth_getLogs` on the public RPC:

| Launchpad | Launch contract | Launch event | Curve trades | Graduation |
| --- | --- | --- | --- | --- |
| Pons | factory `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e` | `TokenLaunched` topic0 `8d4aad49…` (token, curve, deployer indexed) | per-token curve `CurveBuy` `ec36bf57…` / `CurveSell` `8113d738…` | `LaunchSwept` `cdb72f15…`, `PoolGraduated` `0a44ef75…`; graduated v4 pools carry hook `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044` |
| pools.trade | entry `0x0000ffffbe8efe702c8703ae3477ff5de3d319c0` (current) and `0x00004c4ccc709ef590f7c81102c0689f0263d4e9` (original); metadata factory `0x000000e200088d55c39a11f609e5f667729ad49b` | `TokenCreated` | none: a real Uniswap v4 pool from block one (hooks none, fee 2500, quote native ETH) | none |
| Flap.sh | router proxy `0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09`; factories `0x78eb178d…`, `0x549574dd…` | `TokenCreated` | `TokenBought` / `TokenSold` (ts, token, buyer, amount, eth, fee, postPrice) | `LaunchedToDEX` |
| trench.today | proxy `0x77dc6f6361b7b99456fc3761ce5b7dda80d83f9d` | `TokenCreate` `e2eb7016…` (creator, curve, token, quote, name, symbol, timestamp, tokenURI) | `TokenPurchase` `b284604a…` / `TokenSale` `fe414901…` / `Sync` `27efe2fe…` | not documented |
| Bags.fm | factory `0xe8cc4431adf8b5a847c113ef0c6af9043219cb37`; shared AMM logic `0x419890a21711c3d3af46b58548376420b9723275` | mint-transfer pattern | `TokensBought` / `TokensSold` on per-token AMM proxies | none (stays on curve) |

Launchpads without published addresses (hood.fun, LaunchHood, Virtuals, Clanker, Bankr, o1, EasyA Kickstart, Mint Club, CASHCAT): GeckoTerminal indexes them as distinct dex ids on network `robinhood` (`hoodit`, `virtuals-robinhood`, `clanker-robinhood`, `bankr-robinhood`, `o1-launchpad-robinhood`, `easya-kickstart-robinhood`, `mint-club-robinhood`, `pons-dot-family`, `pons-v2`, `uniswap-pools-trade`, `swaphood-finance-*`, 39 dexes total). Their factories can be learned from the creation transaction of any pool under that dex id, once, and added to the factory list. None of the launchpad sites exposes a public JSON API (hood.fun, trench.today, flap.sh, bags.fm, pools.trade all serve HTML only; pons.family did not resolve).

Cross-checks already available keyless: DexScreener `token-profiles` and `token-boosts` (16–21 of the latest 30 are robinhood), DexScreener `token-pairs` per token, robinhoodtrenches `radar`/`tokens` (first buyer handle, honeypot flag, tracked buyers) as the FOMO lens on launches.

Paid alternative: Bitquery ($49/mo) decodes all of the above plus the undocumented launchpads and streams them. The keyless design below does not need it; it is the upgrade if launchpad count keeps growing.

## 5. Cut list

Cuts are the first phase, not an afterthought: the pivot is simpler when the Solana-only surface is gone.

### 5a. Safe now (dead or mock; no product decision needed)
- Delete `src/pages/OnchainPage.tsx`, `EvidencePanel.tsx`, `MarketStats.tsx`, `SignalRadar`, `ToolHealth`, `api.candles`, `GET /api/onchain/candles`, `LIGHTER_SOURCE`, the duplicate Gecko backoff in `market.ts`, duplicate topic/`EvmPoolRef` constants in `tape/robinhood/decode.ts`.
- Remove mocks: Automation, Referrals, Leaderboard, RobinhoodPortfolio stub, SWAP/BRIDGE preview, `@blknoiz` special case, synthesized "Live Feed" bubbles. The header nav shrinks to TRADE and PORTFOLIO (Leaderboard returns later as the real FOMO board).
- Collapse the duplicated network toggle into one.

### 5b. Decisions (recommendation in bold)
- **Solana desk: park it.** The product statement is Robinhood. Removing the Solana-only path (`clawpump/market.ts`, `mcp.ts`, legacy `cvd.ts` + `/api/onchain/trades`, `routes/onchain.ts`, `sources/pumpfun.ts`, `tape/solana/*`, SpotTradeTicket/Jupiter, AgenticAnalysis, board/trenches/holders panels, `mint.ts`) drops roughly 3,300 server lines and 1,200 client lines and the ClawPump dependency. The flow stack, ledger, registry, Gecko/DexScreener sources and Robinhood tape stay. If Solana must come back, it returns behind the chain parameter that already exists on every flow route.
- **Lighter: park it** (isolated: `server/lighter/*`, `sources/lighter.ts`, `routes/lighter.ts`, `LighterPanel`, ~1,300 lines). It is perps, not meme launches, and its 2-second book poll is the noisiest client on the page. Keep the code in git history; delete from the tree.
- **WebGL effects: replace** Grainient with a CSS gradient and SpecularButton with the normal button style. 698 lines gone, one WebGL context fewer.
- **Legacy per-page CVD**: goes with the Solana path; the chart's CVD comes from the ledger already (F4).

Result after cuts: a Robinhood-only desk of roughly 2,000 client and 3,500 server lines, with one chain, one tape, one flow stack.

## 6. Build order (each phase is one workflow run: audit → implement → verify → review → necessity)

### R1 — Pivot and prune
- Apply 5a and the approved 5b cuts. `DeskPage` becomes Robinhood: `address` state (0x), `api.flowToken("robinhood", …)`, candles from GeckoTerminal network `robinhood` through the existing `geckoCandles` path with the chain parameter (Gecko pool OHLCV is keyless; token-level is not), own 1-minute candles from ledger prints when Gecko is blocked.
- Registry for Robinhood already works (DexScreener + Gecko pools); Tier A + own tape + Gecko fallback unchanged.
- Acceptance: paste `0x12d5ee79…` (FATCOIN), chart + Δ/BAR + CVD + windows render within 20s; no Solana request leaves the browser; `npm run check` green.

### R2 — Launch feed
- `server/launch/`: one extra `eth_getLogs` leg per poll over the launch contracts in §4 (topics per factory), decoded into `Launch { token, launchpad, creator, curve?, createdAt, tx }`; graduation and curve-trade events recorded against the token; Gecko `new_pools` per launchpad dex id and DexScreener profiles/boosts as discovery for undocumented pads; robinhoodtrenches `radar`/`tokens` merged for first-buyer handle and honeypot.
- Route `GET /api/launches?window=&pad=&stocks=0` (200 + error contract) and a LAUNCHES tab: age, launchpad chip, curve progress where the pad exposes it, first FOMO buyer, buyers, net USD, honeypot. Click opens the token page.
- Curve-phase prints (Pons/Flap/trench/Bags trade events) ingest into the ledger under `pair = curve address`, so a token has flow before it has a pool.
- Acceptance: within 5 minutes the tab shows launches from at least three pads with correct creator and age; a curve-phase token shows delta bars.

### R3 — FOMO identity and placement
- `FlowPrint.trader` field; receipt fetch per tracked-pool swap; classifier with the 7702 designator; handle map from robinhoodtrenches traders (refreshed hourly) plus learned handles; EntryPoint `UserOperationEvent` leg for proactive discovery.
- Chart: FOMO fills as markers on the candle that contains them (side colour, handle or short address, size class); same-bucket fills of one wallet collapse into one marker with a count.
- FOMO TAPE panel replacing "Live Feed": newest FOMO fills across tracked tokens, handle, followers, side, USD, token; click focuses the token. Side outputs gain a FOMO row: FOMO buy/sell USD vs everyone, per window.
- Leaderboard returns as the real FOMO board: wallets ranked by net USD and win rate computed from our own ledger prints (Wilson lower bound, null under 5 closed trades), with fomo.family profile link-outs.
- Acceptance: on FATCOIN, FOMO markers appear within 5s of a fill by a tracked handle; a wallet not in the 147 but carrying the designator is labelled `FOMO · 0x…`.

### R4 — Alerts and polish
- Toasts for: first FOMO buy on a fresh launch, a >100k-follower handle entering, graduation events. Coverage chips on every FOMO number (population: FOMO wallets seen by this server).

## 7. Budgets (public Robinhood RPC, per process)

| Call | Cadence | Per minute |
| --- | --- | --- |
| `eth_getLogs` swaps (v2/v3 leg + scoped v4 leg) | 2s | 30 batched |
| `eth_getLogs` launches (all factories, one request) | 2s, same batch | 0 extra HTTP |
| `eth_getLogs` EntryPoint user operations | 2s, same batch | 0 extra HTTP |
| `eth_getTransactionReceipt` per tracked-pool swap | on demand | 10–20 |
| `eth_getCode` per new address | once, cached | <5 |
| `eth_getBlockByNumber` timestamps | per new block seen | ~10 |

Observed today: the public RPC 429s a single poller intermittently; the poller and resolve queue already back off. Batching keeps HTTP requests near one per two seconds. A keyed RPC (Alchemy/QuickNode list Robinhood) removes the 429s if they bite.

## 8. Risks

- The FOMO delegate address can change with an app upgrade. Detect by watching the share of user-operation senders whose code is a 7702 designator but not the known one; alert, then add the new designator.
- Relay paths can change. The Transfer-counterparty fallback is relay-agnostic.
- robinhoodtrenches is unofficial. It is used only for handles and first-buyer context; identification and placement do not depend on it.
- Undocumented launchpads need a one-time factory discovery per pad. Until then they appear via Gecko/DexScreener as pools, not as launch events.

## 9. Decisions needed

1. Park the Solana desk entirely (recommended) or keep it behind the existing chain toggle.
2. Park Lighter (recommended) or keep the tab.
3. Replace the WebGL effects with CSS (recommended).
4. Keyless factory-log launch feed (default) or Bitquery at $49/mo for decoded coverage of every pad from day one.
