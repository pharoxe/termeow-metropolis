# FomoScan: what it costs, and what that buys

Measured against `https://api.fomoscan.sh/openapi.json` and a live `starter` key on 2026-09-08.

## The price list decides the architecture

| Endpoint | CU | Returns |
| --- | --- | --- |
| `/v2/user/wallet/{address}` | **50,000** on a hit, 250 on a 404 | address → user |
| `/v2/user/handle/{handle}`, `/v2/user/id/{id}`, `/pnl` | 2,500 | user → **both** addresses |
| `/v2/leaderboard/*`, `/v2/thesis*`, every `/v2/pump/*` | 250 | up to 100 traders, or 20–25 theses |
| `/v2/ws` | 20,000 **per minute held open** | live thesis frames |
| `/v2/me` | 0 | the key's plan, usage and remaining balance |

A starter plan grants 250,000 CU a month and does not roll over. So one address resolution is a fifth of the month,
and naming the 8,550 Robinhood wallets this server has already seen would cost about 428 million CU — roughly 140
years of plan. **Identity is harvested from the 250 CU reads, never swept by address.**

`/v2/me` costs nothing and reports usage for the whole key, including calls made outside this process. It is the only
honest input to a local meter, so it is polled every five minutes and folded into every budget.

## What a 402 means

A call the balance cannot cover is refused with `402 QUOTA_EXCEEDED` **before** it is charged, while a genuine miss
returns `404` and costs 250 CU. On a drained account the two are diagnostic: 404 is "we hold no user for this
address", and 402 on an address lookup means the resolution would have succeeded. Both were confirmed against
synthetic addresses that had never been queried.

## The meter

`server/terminal/cuBudget.ts` paces one consumer's share of the grant. It holds two gates and takes the tighter:

- **Grant pace** — the consumer's `share` of the monthly grant, released linearly across the UTC month.
- **Balance anchor** — that same share of the balance the account actually held when the meter first saw the period,
  released across the time left in it.

The anchor exists because the grant pace alone is wrong whenever the ledger is younger than the spending: a meter
installed mid-month reads its own empty ledger as "nothing spent" and releases weeks of allowance at once. The anchor
is written once per period and never ratchets up as later readings fall.

On top of both sits a one-off `burst`, so a freshly watched token can still backfill immediately — bounded by the
anchor, which is a ceiling as well as a rate. Without that bound the burst is unbounded spending under another name:
two consumers each holding 5,000 CU would take 10,000 out of a 26,000 balance in their first hour.

When the balance is low the anchor throttles below the nominal cadence, and that is the point. On 2026-09-08, with
22,250 CU left of the month, the board share works out to roughly one board refresh every two days rather than three
a day; the full cadence returns with the next grant.

Configured by `FOMOSCAN_MONTHLY_UNITS`, `FOMOSCAN_THESIS_SHARE`, `FOMOSCAN_BOARD_SHARE`, `FOMOSCAN_BURST_UNITS`.

### Why it was needed

Unpaced, the thesis collector fetched one page per token every five minutes across four tokens: 48 pages an hour,
12,000 CU an hour, **288,000 CU a day** — the entire monthly grant inside 21 hours. Measured burn on 2026-09-08 was
9,000 CU/hour against a balance of 31,500.

A refused page is **deferred, not failed**: the backfill cursor survives, and the thesis summary reports the budget
in its `error` string rather than pretending the source is down.

## The registry

`server/terminal/identityRegistry.ts` fills a local `identity.db` from the cheap boards:

- `/v2/leaderboard/traders-fomoscan` — 100 wallets with handle, realized PnL, win rate, average hold, tokens created
  and wallet age, drawn from a daily on-chain sweep of 316,007 wallets. 250 CU.
- `/v2/pump/leaderboard/traders` — pump.fun's top 100 by PnL. 250 CU.

Three boards refreshed daily cost about 22,500 CU a month. The first sweep on 2026-09-08 returned 188 distinct
identities for 500 CU and named one wallet already trading in this server's own Solana tape — the first named Solana
trader the desk has had.

Sources are ranked when two of them name the same wallet: `fomo-profile` > `pump-profile` > `fomoscan-board` >
`pump-board`. A board listing never overwrites a resolved profile.

### Numbers a board hands you that are not what they look like

- The pump board's `pnlUsd` is realized **plus unrealized**, and is routinely almost all unrealized: the top-ranked
  wallet in the checked-in fixture shows +$1,758,491 unrealized against **-$1,124 realized**. The two legs are stored
  separately and must be presented separately.
- `walletsRanked` and `coverage` describe the population a board was drawn from. A board is the top of a sweep, never
  the top of everyone trading.
- `capturedAt` is a single instant; upstream samples every 30 seconds.

## Routes

| Route | What it does |
| --- | --- |
| `GET /api/identity/coverage` | registry size by chain and source, boards read, named share of the wallets this server has seen, budget and account state |
| `GET /api/identity/board/:board/:window` | a stored ranking |
| `GET /api/identity/wallet/:chain/:address` | registry lookup only — a miss means "not named by a board we have read", never "this wallet has no owner" |
| `GET /api/identity/handle/:handle` | every address held for one handle, which is how a trader is linked across chains |

`/wallet` deliberately never falls through to the 50,000 CU resolution. Naming an unknown address stays a deliberate
act, not something a page view can trigger.

## The cross-chain link

One FOMO user has one Solana address and one Robinhood address. `GET /v2/user/handle/frankdegods` returned
`evmAddress 0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28` — exactly the wallet this server's archive already held for
that handle — alongside `solanaAddress 498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ`. At 2,500 CU per handle, the 147
named wallets in the trader book resolve to cross-chain identities for about 367,500 CU: roughly a month and a half of
a starter plan, and the single highest-value spend available once the account is topped up.
