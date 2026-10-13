# termeow

An onchain trading agent for **Monad**. It pairs market intelligence (live order flow, smart-money tracking, launches, perps context) with **conditional execution**: a voice/text agent drafts trades and monitored strategies, you approve them with a passkey, and the server fires them later through a policy-bound delegated wallet.

Built for the **Monad Metropolis** hackathon, Onchain Finance & Trading track. See [MONAD_METROPOLIS.md](MONAD_METROPOLIS.md) for the submission write-up and sponsor-track fit.

## What it does

- **Desk (`/onchain`)**: multi-chart workspace for any Monad token. It shows candles built from the chain itself (Uniswap v2/v3/v4 swap logs, about 300 ms blocks), order-flow windows and CVD, large-print tape, both-sides wallet flow, a nad.fun launch radar, trending and new pools, and a Perpl perps regime strip.
- **Smart money**: the Nansen smart-money netflow and DEX-trade feed on chain `monad`, plus a label book built from Nansen labels and your own watchlist. A SMART tape and board show fills from labelled wallets as they happen.
- **Execution**:
  - Swaps go through **Kuru Flow**, the default router, which aggregates across Kuru's onchain order book and AMMs. 0x is an optional fallback.
  - The connected **Privy** embedded EVM wallet signs every trade.
  - Exact-amount ERC-20 approvals are requested only when they're needed.
- **Agent (`/agent`)**: an ElevenLabs voice/text agent with client tools.
  - It can resolve tokens, analyse a token or wallet, and inspect large orders.
  - It can query Kuru quotes, nad.fun, Perpl and Nansen, and propose a swap, a MON transfer or an automation.
  - Nothing executes without a passkey-confirmed approval.
- **Conditional automations**: monitor a wallet, a deployer or an X account, or set a conditional swap with exits.
  - Once armed, the server executes on a Privy delegated signer.
  - The signer is restricted by a Privy policy: Monad chain only, Kuru Flow contracts only, and approvals only to those spenders.
  - The server inspects every transaction before it is sent.

## Local setup

Node.js 22.13+ is required (the trade archive uses built-in SQLite).

```bash
cp .env.example .env
npm install
npm run dev
```

Open http://localhost:5174/onchain. The API listens on `127.0.0.1:9300`, and Vite proxies `/api` there.

With no keys at all you still get live Monad market data, public RPCs, Kuru quotes, nad.fun and Perpl. Nansen, Privy, ElevenLabs and Postgres each switch on when their keys are set (see `.env.example`). Set `MONAD_NETWORK=testnet` (and `VITE_MONAD_NETWORK=testnet`) to point everything at Monad testnet.

## Commands

```bash
npm run dev                     # backend watcher + Vite
npm run test                    # unit tests (vitest)
npm run build                   # typecheck + production bundle
npm run start                   # serve API + built UI
npm run check                   # tests + build
npm run db:migrate              # apply db/migrations (Neon/Postgres)
npm run setup:privy-automation  # create the Monad delegated-execution policy once
npm run sync:elevenlabs         # push agent tools + knowledge to ElevenLabs
```

## Production

`npm run build`, then `NODE_ENV=production npm start`. The `Dockerfile`, `railway.toml` and `fly.toml` deploy it as a single Node service. Set secrets on the host; never bake `.env` into the image.

## Safety model

- Interactive swaps and transfers are built server-side as unsigned transactions and signed in the browser by the user's own Privy wallet.
- Delegated (unattended) execution is limited to Monad. It may only call the Kuru Flow entrypoint and router, and may only approve those spenders. The server also re-checks the destination and calldata before signing.
- Every agent-proposed action needs explicit passkey MFA approval. The agent's research tools are read-only.
- The `/api/rpc` proxy forwards only an allowlist of read methods.

## Theme

The palette is true black with a light-purple accent (`#b9a4ff`) in dark mode, and lavender-white with `#8b6cf6` in light mode. The look is a clean retro-terminal one. Color tokens live in `src/styles.css` and `src/lib/themeTokens.ts`.
