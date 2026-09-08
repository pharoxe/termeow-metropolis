# Terminal implementation

The on-chain desk now links participant markers, a paginated Time & Sales tape, and a trader inspector. Selecting a trade focuses its candle and exposes wallet attribution, transaction evidence, decoded or explicitly estimated quantity, and preceding market conditions. Wallet following and indicator choices persist locally. Filters cover side, notional and participant cohort. A command palette provides chart and replay navigation.

The terminal archive persists normalized observations in `data/terminal/trades.db` using built-in SQLite (Node 22.13+). It retains corrections and late attribution, supports indexed history pagination, and streams snapshots with reconnection and history refresh. Captured sub-minute candles are rebuilt from stored priced observations; provider OHLCV remains separate from cross-venue trade markers.

Replay shows completed candles and captured trades through the selected time. Live chart flow overlays and quote values are suppressed or replaced during replay. Other site panels remain live. The desk has a revised chart/tape/inspector layout, navigation controls, and explicit coverage and identity labels.

Validation: 116 test files, 1,268 tests passed; production build passed. Final replay and interval callback adjustments passed TypeScript checking and diff validation. Browser verification at http://127.0.0.1:5174/onchain confirmed populated chart, streaming captured trades, linked inspection, wallet following, and responsive inspector layout.

## Limits

- History starts with server capture; public upstream coverage is incomplete and rate-limited.
- Confirmation is observed, not verified finality. Reorg reconciliation remains future work.
- Trader motivations are unknown unless sourced. Context is not an assertion of intent.
- Captured buys and sells do not establish complete positions, exits, cost basis or realized P&L.
- The legacy flow/CVD pipeline remains separate from the archive; this is not a fully unified market-data engine.
- Live order execution was not tested; local execution remains disabled.
- The build reports a large frontend bundle warning; code splitting remains an optimization opportunity.
