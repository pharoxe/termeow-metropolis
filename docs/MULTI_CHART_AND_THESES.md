# Multi-chart workspace and thesis activity

Open `/onchain`. Add up to four charts with ADD CHART, duplicate, discovery-row plus buttons, or paste a contract address and choose NEW CHART. Normal OPEN replaces the active chart. A fifth chart prompts for which chart to replace.

Choose side-by-side, stacked, grid, or maximized layouts. Click a tile or use Alt+1–4 to focus it. Search, participant inspection, and the detailed tape follow that tile. Timeframes, indicators, drawings, scale, and replay remain independent unless their corresponding link control is enabled. Layout, tokens, active tile, and intervals survive reload. Link toggles and replay positions reset on reload.

Identical request scopes share polling and cached results. The workspace uses one multiplexed SSE connection for its unique token scopes. Closing the last subscriber stops that scope's browser polling; server trade collectors retain their existing expiry policy. Background tiles use recent events while the active tile loads detailed viewport history.

## Thesis source setup

Add `FOMOSCAN_API_KEY` to the server's local `.env` and restart the API. Never expose this key through a VITE variable. Without it, thesis widgets show DISCONNECTED and unknown values; no synthetic records are inserted.

The adapter uses the third-party [FomoScan API](https://api.fomoscan.sh/docs), `/v2/thesis/token/{tokenAddress}`. The server reads at most one 25-record page per token every five minutes for the four most recently requested tokens, with a 24-hour inactivity expiry. Each documented page costs 250 CU; continuously tracking four tokens can consume up to 288,000 CU/day. Backfill shares that budget and may take time on busy tokens. Jobs and normalized records persist in `data/terminal/theses.db` (or TERMINAL_DATA_DIR).

The numeric widget shows observed thesis posts, unique identified authors, posts/hour, change and rate change against the immediately preceding equal-length 1h, 6h, 24h, or 7d window. Percent change is suppressed below five prior posts. Unknown authors are separate. Expand the number to read posts and page through them. The active token's widget also appears in the FOMO tab.

Missing history suppresses comparative metrics. Empty first responses are treated as incomplete harvesting, not proof of zero engagement. Duplicate IDs and edits do not increase counts. Failed or old source snapshots show stale status. Counts are engagement observations, not proof of bullish intent, current holdings, or independent human authorship.

The documented source does not provide deletion events, so this is not a reconciled count of currently published posts. Network attribution must match the requested chain; undocumented Robinhood network identifiers are rejected rather than borrowed from another chain. Live thesis ingestion requires a valid key and has not been validated with authenticated production records in this checkout.

## Verification

Run `npm run check`. Focused regression tests cover workspace restore/cap/close, shared polling cleanup, thesis deduplication and edits, equal-window calculations, invalid networks, and incomplete source coverage. Browser verification covers chart creation, interval isolation/linking, capacity, and layout restoration.
