# Data flow audit — 8 September 2026

Checked the running local instance at http://127.0.0.1:5174/onchain.

## Fixed

- Prevented mixed hourly/minute candle history and 5-minute fallback candles mislabeled as another timeframe. Daily fallback now aggregates four-hour OHLCV into daily bars. Provider-capped history remains capped rather than inventing finer candles.
- Cleared the previous timeframe during selection changes and rejected mismatched candle envelopes. Empty responses no longer silently retain the previous interval.
- Rotated unresolved token-symbol lookups and retained successful results when another lookup fails.
- Recovered Robinhood log polling when a previously successful batch starts rejecting future block ranges; switches to head-bounded sequential requests.
- Prevented overlapping market, own-candle, and token-flow requests. Added a 45-second client request timeout.
- Expired stale polled-source health after three minutes and removed the misleading notification claiming all services were synchronized.
- Corrected a websocket test race: wait for subscription acknowledgment, not just server receipt.

## Verification

- `npm run check`: 114 test files, 1,258 tests passed; TypeScript and production build passed. Bundle-size warning remains.
- `git diff --check`: passed.
- Fifteen live API probes returned HTTP 200: health, launches, FOMO status/tape/board, Robinhood discover, Solana trenches, token flow, own 5-second candles, and six market intervals (1m/5m/15m/1h/4h/1d).
- Sample market returned 1,000 bars at 1m/5m/15m/1h, 447 at 4h, and 84 daily bars. Daily no longer duplicates the four-hour series.
- Browser showed populated token symbols, chart, flow totals, and recent order-flow prints on the exact local URL. API probes confirmed incoming tape data.

## Remaining limits

This is not certification of every feature or every upstream provider. Public Solana RPC and GeckoTerminal returned rate limits during the audit, so completeness and continuous freshness cannot be guaranteed. Feed availability recovered during the final probes but can degrade again.

ClawPump, agent credentials, Privy, and a dedicated/fallback Solana RPC were absent in the tested runtime. Authenticated intelligence and actual signed trade execution were not validated. Mainnet execution remains disabled for this local run.

Some contracts have no resolvable symbol and most observed wallets have no verified public handle; addresses must remain visible rather than fabricated names. FOMO transfer monitoring is capped at 1,500 wallets and does not cover every discovered wallet. Sub-minute candles reflect captured, priced trades only. These are partial feeds, not a complete exchange tape.

Probe responses and check logs are in `/private/tmp/termeow-data-audit/`. Changes are local and uncommitted.
