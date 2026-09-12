# Termeow market-data storage

## What is stored now

- FomoScan boards are normalized server-side into `identity.db` (SQLite): wallet-to-handle/X/avatar identity rows plus the latest ranking snapshot per window.
- FomoScan credit use is recorded in `fomoscan.db`. Browser clients read only `/api/identity/*` and `/api/fomo/*`; they never receive the provider key or call FomoScan.
- Market prints and derived chart history use the terminal archive under `TERMINAL_DATA_DIR`. A Railway volume must mount that directory or deploys remain ephemeral.
- The public leaderboard currently returns at most 100 accounts per request and has no pagination. Termeow caches the 24h, 7d, 30d, and all-time best boards: at most 400 distinct leaders after deduplication, not a fabricated 1,000.

## Lowest-cost durable target

1. Mount a small Railway volume at `/data/terminal` and set `TERMINAL_DATA_DIR=/data/terminal` now. This makes the current SQLite WAL databases durable with no application rewrite.
2. Roll raw trades and candles hourly into date/chain/token partitioned Parquet in Cloudflare R2 (or another S3-compatible cold store). Keep 7–30 days hot locally and compact older bars into 1m/15m/1h aggregates.
3. Add Postgres-compatible metadata only when horizontal replicas are needed. Keep identities, automations, token metadata, and object-manifest pointers there; do not put every tick in row storage.
4. Serve clients through Termeow endpoints with ETags and stale-while-revalidate. One scheduled ingest refreshes FomoScan; thousands of clients reuse the same stored snapshot.
5. Retain raw prints for 30–90 days in compressed Parquet, compact candles indefinitely, identity history as slow-changing snapshots, and per-user agent memory as lean strategy summaries plus references—not raw conversations or chart dumps.
