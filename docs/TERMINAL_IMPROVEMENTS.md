# Terminal reliability and workspace improvements

## Data flow

- Active workspace pool registries are re-requested every minute (subject to the registry provider's cache/backoff). The collector receives the replacement pool list, so an open chart can discover new pools without reopening the token.
- Archive revisions are tracked per token. Workspace clients share the serialized snapshot input for each token/revision/10-second heartbeat, avoiding repeated database history queries for identical subscriptions. Heartbeats still refresh source health when no trades arrive.
- Thesis jobs alternate the latest page with historical pages while backfill is active. Both use the existing shared CU budget; no additional paid-call allowance is introduced. Source failures preserve the historical cursor. Recent observations do not imply complete coverage: comparison metrics remain unavailable when there is an unfilled gap.
- Malformed thesis cursors return HTTP 400 before registering collection interest.
- Chart resource results are read directly rather than mirrored through eight local state/effect pairs.

## Workspace

PANELS controls sidebar visibility and width. Settings persist locally; narrow screens use responsive width limits. Token symbols are populated from market responses and displayed beside chain/address on chart tabs. The health strip shows transport connectivity, market/flow response age, stale thresholds, and request failures. Pool coverage details remain in COVERAGE.

`src/lib/themeTokens.ts` is the palette source for terminal CSS custom properties, the chart canvas, and drawing selection colors. Pixel typography remains for branding/navigation; trading values remain monospace.

## Verification

`npm run check`: 1,361 tests passed and the production build passed. New regressions cover per-token revision isolation, latest-page/backfill ordering, and cursor validation. A live local API request with an invalid cursor returned HTTP 400.

Browser checks: four visible chart containers with one search field; single/grid switching; dark/light switching; panel collapse and keyboard width adjustment surviving reload; token labels and connected-stream health; no console errors in the checked session. The panel menu stacking issue found during this pass was fixed.

Provider coverage and CU pacing remain real limitations. A connected transport does not establish complete market coverage, and a paced thesis refresh can remain stale until budget is available. The production build still reports a large bundle warning; route-level splitting is a separate optimization.
