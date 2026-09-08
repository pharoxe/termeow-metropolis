# Unified terminal: implementation and remaining coverage

## Implemented

- Both chains share the indexed archive aggregate endpoint, CVD input and aggregate buy/sell/delta readout. SQL reads the entire selected candle range, independent of tape pagination and participant filters. Wallet-net observations are excluded, and exact executions supersede coarse transaction/pool records. Unpriced trades are counted without inventing USD values.
- CVD is anchored to the first loaded candle. It measures captured token-relative pool turnover, not unique wallet capital inflow. Multi-pool routing can legitimately contribute multiple pool legs.
- Existing Robinhood wallet classification and public handle mappings are attached before archive normalization. Protocol verification and social ownership verification have separate labels. The cached protocol classifier is not a verified social-to-wallet ownership registry.
- Solana and Robinhood use the same discovery API envelope and table with window, liquidity, change, volume, source health and disagreement evidence. Solana supports Gecko and DexScreener fallback, preserving case-sensitive addresses.
- Discovery views explain attention, momentum, participant coverage and launch context. FOMO board requests respect the selected chain.

## Observed limits

Browser verification on the active Solana instrument showed 4 of 38 known pools with captured trades. This is not complete market coverage. Collector prioritization, supported decoders, public RPC limits and provider history all remain limiting factors. Public Gecko rate limiting was visible; DexScreener discovery continued to populate the table.

Solana has no supported FOMO verification/social ownership source in this checkout. The Robinhood EIP-7702 classification cannot be copied to Solana. Solana smart-holder rankings therefore report unavailable evidence rather than ranking unrelated anomaly scores. Robinhood's buyer counts also do not prove current holdings or trading skill.

## Next implementation priorities

1. Identity registry keyed by chain and wallet: social account ID, evidence URL/signature, verification type, observation time, expiry and revocation. Signed wallet ownership and provider mapping must remain distinct. Badge status alone is not ownership evidence. A suitable source is required before Solana social attribution can be populated.
2. Expand pool subscriptions with per-pool completeness watermarks and supported-program adapters. Use a reliable indexed/streaming provider for backfill and finality reconciliation. Display captured, missing, delayed and unsupported pools separately. Keep impact filters out of total CVD.
3. Build trader discovery ranking from comparable windows: volume acceleration and liquidity for attention; directional price change with volume confirmation for momentum; verified participant entries and exits with holding evidence for social flow; launch age, graduation and liquidity changes for early markets. Keep source ranks and derived ranks explicit.
4. Add distinct pool-turnover and deduplicated wallet-flow views, preserving routed swap legs rather than treating their sum as unique new capital.

Validation: full suite (1,275 tests) and production build passed, with additional targeted Solana adapter/case tests. Existing large-bundle warning remains.

## Participant baselines and address entry

The contract input is always rendered in a sticky strip. Paste edits the field; Enter or OPEN navigates using the existing chain-aware parser. The app does not read the clipboard in the background.

A process-local worker persists current participant snapshots to `data/terminal/participants.db`. Set `PARTICIPANT_REFRESH_MINUTES=5`, `10` (default), or `15` before starting the server. A single worker checks due jobs without overlap; up to 32 recently requested wallets are active, and requests expire after 24 hours. Refresh times are targets and may slip during upstream failures or queue pressure. The worker runs while the application server is running; due jobs resume after restart. It is not an operating-system cron service.

Solana snapshots enumerate native, SPL and Token-2022 balances through confirmed RPC reads and price assets through DexScreener. They are reference valuations, not audited net worth, historical balance reconstruction or guaranteed executable proceeds. Partial holdings, missing prices, failed refreshes and expired snapshots cannot pass the $50K/$100K wallet filter. Robinhood refreshes the delegation check, while total wallet valuation remains unavailable. Social account ownership remains unverified on both paths.

The UI polls snapshot status every 15 seconds and shows observation/next-check times. The checking animation follows worker state; the update flash follows a new observation timestamp. Reduced-motion preferences disable both.

Validation: 1,283 tests and production build passed, including cadence, overlap prevention, failure retention, partial valuation and stale-filter checks.
