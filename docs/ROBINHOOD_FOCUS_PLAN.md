# termeow unified desk plan — Solana + Robinhood, one desk

Rewritten 2026-09-06 against `solana-desk` @ 84eca1e after the decision to keep both chains. Every external
fact was measured today with a live request; every code fact comes from a full read of `src/` and `server/`.

## 1. The rule that makes one desk possible

**Chain is a property of the token, not a mode of the desk.** The desk holds one instrument,
`{ chain, address }`. Everything below the page already takes that pair: `/api/flow/token/:chain/:address`,
the registry, the ledger, the GeckoTerminal and DexScreener sources, and the two own tapes. What still assumes
Solana is the market route (`/api/onchain/market`, ClawPump-centric) and the page itself. R1 fixes exactly that.

- **Paste any CA or URL.** base58 → Solana; `0x` + 40 hex → EVM, and DexScreener's token lookup returns the
  chain id with the pairs, so Robinhood versus another EVM chain resolves in the same call. DexScreener,
  GeckoTerminal, pump.fun and launchpad URLs parse to `{ chain, address }`.
- **The ROBINHOOD / SOLANA toggle becomes a list filter** (ALL / SOL / RH) for launches and the social tape,
  and keeps its wallet-funding role. It never changes what the chart shows; the token's chain does.
- **Execution follows the token's chain.** Solana keeps the user-signed Jupiter ticket. Robinhood gets
  Uniswap and DexScreener link-outs until an EVM wallet path is its own project.

## 2. What the terminal is today (measured)

| Layer | Size | State |
| --- | --- | --- |
| Client | 45 files, 4,109 lines + 918 CSS | One page. Every feed Solana-hardcoded. Toggle switches nothing on the data side. Mocks shipping as UI: Automation, Referrals, Leaderboard, Robinhood portfolio stub, swap-bridge preview, ANSEM special case, synthesized Live Feed bubbles. |
| Server | 39 files, 7,085 lines, 367 tests | Solana market path (ClawPump MCP, pump.fun, legacy per-page CVD), chain-neutral flow stack (F1–F5), own tapes for both chains, Lighter venue. |
| Robinhood reachable | 1 capability | Funding a Privy EVM wallet. The Robinhood tape and `chain=robinhood` on the flow route are verified live but no client path requests them. |
| Trader identity | none | No print records who traded. Solana parser computes signers and drops them; Robinhood decoder ignores sender topics. |

## 3. fomo.family wallets on chain (measured, Robinhood)

- Every trader wallet is an EOA delegated with EIP-7702 to one contract: `eth_getCode` returns
  `0xef0100e6cae83bde06e4c305530e199d7217f42808555b` for **24 of 24** wallets sampled. That designator is the
  FOMO fingerprint; no scraping, no API.
- Every fill is relayed. EntryPoint `0x4337084d9e255ff0702461cf8895ce9e3b5ff108`: the receipt's
  `UserOperationEvent` (topic0 `0x49628fd1…`, sender in `topics[2]`) named the wallet **3 of 3**. Relay
  `0xccc88a9d1b4ed6b0eaba998850414b24f1c315be`: no event, but the traded token's Transfer names the wallet;
  across both paths the wallet appeared in the receipt's transfers **6 of 6**.
- Handles: robinhoodtrenches `/api/traders` (147 with handle, followers, fomo profile URL) and every tape row
  carries handle + wallet. Unknown FOMO accounts are labelled `FOMO · 0xabcd…ef12`.
- Discovery: one extra log query per poll on the EntryPoint yields every account-abstraction sender; classify by
  code once, cached forever.

Solana side (to measure in R3 before promising): fomo.family is gasless there too, so the fee payer of every
fill should be their relayer, and the Solana parser already has the signer set.

## 4. Launchpads (measured, keyless)

Robinhood, from Bitquery's public docs, all pollable with `eth_getLogs`:

| Launchpad | Launch contract | Launch event | Curve trades | Graduation |
| --- | --- | --- | --- | --- |
| Pons | factory `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e` | `TokenLaunched` `8d4aad49…` | `CurveBuy` `ec36bf57…` / `CurveSell` `8113d738…` | `LaunchSwept`, `PoolGraduated`; hook `0xe5e70264…be044` |
| pools.trade | `0x0000ffffbe8efe702c8703ae3477ff5de3d319c0`, `0x00004c4ccc709ef590f7c81102c0689f0263d4e9` | `TokenCreated` | none (real v4 pool from block one) | none |
| Flap.sh | router `0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09` | `TokenCreated` | `TokenBought` / `TokenSold` | `LaunchedToDEX` |
| trench.today | proxy `0x77dc6f6361b7b99456fc3761ce5b7dda80d83f9d` | `TokenCreate` `e2eb7016…` | `TokenPurchase` `b284604a…` / `TokenSale` `fe414901…` | not documented |
| Bags.fm | factory `0xe8cc4431adf8b5a847c113ef0c6af9043219cb37` | mint-transfer | `TokensBought` / `TokensSold` | stays on curve |

Undocumented pads (hood.fun, LaunchHood, Virtuals, Clanker, Bankr, o1, EasyA, Mint Club, CASHCAT) are distinct
GeckoTerminal dex ids on network `robinhood` (39 dexes); their factories can be learned once from a pool's
creation transaction. No launchpad site serves a public JSON API.

Solana: PumpPortal `subscribeNewToken` is free and keyless (message received today); pump.fun v2 trades give
the curve-phase tape; DexScreener new profiles and boosts cover the rest.

## 5. The chart (DexScreener-grade on lightweight-charts)

DexScreener runs the licensed TradingView library. Lightweight-charts can match what traders use and beat it
in one place. Gaps today, by visible impact:

1. Candles rebuild the whole chart on every 45s poll → update the last bar in place and append (the flow panes
   already do this).
2. No live candle → prints from both own tapes carry a price; keep it on the print and tick the forming bar on
   every fill.
3. No sub-minute bars → Gecko stops at 1m; our tape does not. 1s/5s/15s bars where the tape is live.
4. Micro-price formatting (subscript zeros), crosshair OHLCV + volume legend, log/linear, USD/native quote next
   to the existing price/mcap toggle, IST axis.
5. Markers: FOMO and tracked fills, launch and graduation events, large prints.
6. Drawings: horizontal lines, trendlines, measure as custom primitives. Full TradingView drawing is out.
7. Depth is set by sources: ~2,000 bars per interval from Gecko, pump.fun to launch on Solana, curve-trade
   candles for Robinhood pre-graduation tokens.

## 6. Cut list

- **Dead:** `OnchainPage.tsx`, `EvidencePanel.tsx`, `MarketStats.tsx`, `SignalRadar`, `ToolHealth`,
  `api.candles` + `/api/onchain/candles`, `LIGHTER_SOURCE`, duplicate Gecko backoff and topic constants.
- **Mocks:** Automation, Referrals, Leaderboard, Robinhood portfolio stub, swap-bridge preview, ANSEM special
  case, synthesized Live Feed bubbles. Header nav shrinks to TRADE and PORTFOLIO; the Leaderboard returns in R3
  as the real FOMO board.
- **Lighter** (~1,300 isolated lines): perps, not launches; its 2s book poll is the noisiest client on the page.
- **WebGL effects** (698 lines): Grainient → CSS gradient, SpecularButton → normal button.
- **Legacy per-page CVD** (`/api/onchain/trades`, `computeCvd`): retired in the chart phase once the ledger
  tape feeds the FLOW panel and the analysis drawer; kept in R1 for Solana only.
- **Kept:** the Solana market path and ClawPump intel (Solana enrichment), pump.fun, both own tapes, the flow
  stack, Privy.

## 7. Build order (each phase one workflow run: audit → implement → verify → review → necessity)

### R1 — One instrument model + prune
- Server: `GET /api/market/:chain/:address?interval=` returning one neutral shape for both chains:
  `{ instrument: { chain, address, symbol, name, image, socials }, priceUsd, marketCapUsd, liquidityUsd,
  volume24Usd, change24Pct, primaryPair, candles, source, degraded, notes }`. Solana delegates to the existing
  `getOnchainMarket` (ClawPump intel intact); Robinhood assembles from DexScreener pairs + GeckoTerminal pool
  OHLCV on network `robinhood`. Flow response gains `tape` (newest 40 Tier A prints from the ledger ring) so
  the FLOW panel works on both chains without the legacy Gecko page.
- Client: `extractAddress(text)` → `{ chain, address }`; instrument state; market and flow polls keyed on the
  instrument; Solana-only polls (board, trenches, holders, legacy trades, quote) gated on `chain === "solana"`;
  execution rail shows the Jupiter ticket on Solana and Uniswap/DexScreener links on Robinhood; brand suffix
  and chart title follow the instrument.
- Prune: everything in §6 except the legacy CVD.
- Acceptance: paste ANSEM → identical Solana desk; paste FATCOIN → chart, Δ/BAR, CVD, windows, tape on
  Robinhood within 20s; a DexScreener robinhood URL resolves; `npm run check` green; client and server each
  smaller than before.

### R2 — Launch feed, both chains
- Robinhood: factory-log leg in the poller for the contracts in §4, decoded to
  `Launch { chain, token, launchpad, creator, curve?, createdAt, tx }`; curve trades ingest into the ledger under
  the curve address; graduation events recorded; Gecko new pools per launchpad dex id and DexScreener profiles
  for undocumented pads; robinhoodtrenches radar for first-buyer handle and honeypot.
- Solana: PumpPortal new-token socket (keyless) + DexScreener profiles; pump.fun v2 backfill already exists.
- `GET /api/launches?chain=all|solana|robinhood&window=&pad=` and a LAUNCHES tab with chain and launchpad
  chips, age, curve progress, first FOMO buyer, buyers, net USD, honeypot. Click opens the token page.

### R3 — FOMO identity and placement, both chains
- `FlowPrint.trader`; receipt fetch per tracked-pool swap on Robinhood; 7702 classifier; EntryPoint discovery
  leg; handle map from robinhoodtrenches. Solana: measure the fee-payer fingerprint first, then the same
  pipeline from the signer set the parser already computes.
- Chart markers per FOMO fill (collapsed per wallet per bucket), FOMO TAPE panel replacing Live Feed, FOMO row
  in the side outputs, real FOMO Leaderboard from our own ledger (Wilson bound, null under 5 closed trades).

### R4 — Chart pass
- Items 1–7 of §5, plus retiring the legacy per-page CVD once the ledger tape and windows feed every consumer.

### R5 — Alerts
- First FOMO buy on a fresh launch, large-following handle entering, graduation events; coverage chips on every
  FOMO number.

## 8. Budgets (public RPCs, per process)

| Call | Cadence | Per minute |
| --- | --- | --- |
| Robinhood `eth_getLogs` swaps + launches + user operations | 2s, one batch | ~30 HTTP |
| Robinhood receipt per tracked-pool swap | on demand | 10–20 |
| Robinhood `eth_getCode` per new address | once, cached | <5 |
| Solana `logsSubscribe` + `getTransaction` | push + 1 rps public / 8 rps Helius | 60 / 480 |
| GeckoTerminal (shared bucket) | candles 45s, pools on focus | <25 |
| DexScreener | registry 60s, profiles 60s | <10 |

## 9. Risks

- FOMO delegate or relay changes: watch the share of user-operation senders with an unknown 7702 designator;
  the Transfer-counterparty fallback is relay-agnostic.
- robinhoodtrenches is unofficial: used only for handles and first-buyer context.
- Public RPC 429s on both chains: the pollers and queues back off; keyed RPCs remove the ceiling.
- Undocumented pads need one-time factory discovery; until then they surface as pools.
