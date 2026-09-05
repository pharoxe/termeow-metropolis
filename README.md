# termeow

Voice-ready Solana trading terminal built around ClawPump. This branch (`solana-dex-fork`) replaces the Hyperliquid/Python runtime with a single TypeScript service:

- **`/onchain`** — ANSEM/USD desk with multi-timeframe candles, EMA / Bollinger / VWAP / S-R / volume / RSI / MACD / OBV, ClawPump movers, anomalies, smart-flow signals, pool liquidity, narrative research, swap quotes, and user-wallet-signed execution.
- **`/perps`** — Phoenix screener, live chart and book, contract / funding / risk data, agent account state, and guarded ClawPump execution.

Both pages use termeow's dense neon-green pixel desk theme with light and dark modes. Helius is the primary Solana RPC; Alchemy is the automatic backup.

ANSEM mint: `9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump`.

## Local setup

Node.js 22+ is required.

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Open [http://localhost:5173/onchain](http://localhost:5173/onchain). The API listens on `127.0.0.1:9300`. Vite proxies `/api` there.

Without credentials, ANSEM uses labelled public/demo fallbacks and all execution stays disabled. See [API keys](docs/API_KEYS.md).

## Production

```powershell
npm run build
$env:NODE_ENV="production"
npm start
```

Open [http://127.0.0.1:9300/onchain](http://127.0.0.1:9300/onchain).

In production the process binds `0.0.0.0` so container and PaaS health checks can reach it. Override with `HOST` if needed. Empty environment values are treated as unset so a copied `.env.example` does not crash boot.

## Deploy

The repo is a single Node service: `npm run build` then `npm start`.

| File | Use |
| --- | --- |
| `Dockerfile` | Node 22 image; builds the frontend, then serves API + `dist` |
| `railway.toml` | Railway Dockerfile builder and `/api/health` check |
| `Procfile` | `web: npm start` for Heroku-style hosts |

Do not copy `.env` into the image. Set secrets on the host. Typical platform variables: `NODE_ENV=production`, `PORT` (provided by the host), `HOST=0.0.0.0`, plus the keys in [API keys](docs/API_KEYS.md). Keep `ENABLE_MAINNET_EXECUTION=false` until a controlled wallet test has passed.

## Safety model

- Mainnet execution is opt-in through `ENABLE_MAINNET_EXECUTION=true`.
- Spot transactions are returned unsigned and signed by the connected Phantom/Solflare wallet. Private keys never enter this app.
- Privy is the embedded-wallet path when `VITE_PRIVY_APP_ID` is set.
- Session permissions are stored locally until MagicBlock delegation scopes are finalized; wallet signatures remain mandatory.
- Phoenix writes are isolated from spot routes and use the configured ClawPump agent.
- ElevenLabs is intentionally not installed yet.

## Commands

```powershell
npm run dev     # backend watcher + Vite
npm run test    # indicator/unit tests
npm run build   # typecheck + production bundle
npm run start   # serve API + built UI
npm run check   # tests + build
```

Start scripts enable Node’s system CA store so the app works behind Windows-managed HTTPS inspection without disabling TLS verification.

`@clawpump/agents` is pinned to `0.1.23` until upstream `0.1.25` ships a complete `dist` tarball.
