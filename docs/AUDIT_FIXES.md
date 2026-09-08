# Audit fixes — 2026-09-08

- Order quantities use the input mint's RPC-reported decimals and exact integer conversion. Zero, negative, excessive precision, and u64 overflow are rejected.
- Quotes are bound to mints, amount, slippage, and wallet. Changed requests return 409; upstream Jupiter route fields must match too. The UI freezes edits during preview, discards superseded responses, expires previews, and checks for wallet/network changes before signing.
- The quote cache expires entries after 60 seconds, sweeps every 30 seconds, and caps storage at 1,000 entries. Transaction construction consumes a quote once.
- Portfolio reads the requested wallet's native SOL, SPL and Token-2022 balances. Public DexScreener prices value those balances; no private ClawPump agent portfolio is returned. Missing balances/prices are labelled, and failed reads can be retried. Price work is limited to 300 distinct mints per request; additional holdings remain visible with unknown prices.
- Dependency overrides replace vulnerable axios and ws versions and upgrade transitive uuid to 11.1.1+ and decode-uri-component to 0.5.x. The latter two cross a major/minor compatibility boundary; the TypeScript build, application tests and browser startup pass, but real wallet login/provider flows still need integration testing. Privy and ClawPump were not downgraded. Reassess overrides when upstream dependencies adopt patched releases.

Validation: 112 test files / 1,247 tests passed, including nine new regressions; production build and basic browser navigation passed; npm audit returned zero vulnerabilities. Wallet signing and live trade submission were not performed. The existing Vite bundle-size warning remains.
