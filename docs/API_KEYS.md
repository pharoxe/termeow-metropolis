# API keys and runtime configuration

Copy `.env.example` to `.env`. The checked-in template contains no secrets, and `.env` is gitignored.

## Required for the complete vertical slice

| Variable | Where to obtain it | Purpose | Browser-safe? |
| --- | --- | --- | --- |
| `CLAWPUMP_API_KEY` | [ClawPump dashboard](https://agents.clawpump.tech/dashboard/api) | Agent MCP, market tools, quotes, portfolio, and execution | No |
| `CLAWPUMP_AGENT_ID` | ClawPump dashboard / `list_agents` response | Selects the agent wallet and Phoenix account | ID only; keep server-side |
| `JUPITER_API_KEY` | [Jupiter developer portal](https://portal.jup.ag/) | Optional authenticated transaction builder after the ClawPump route quote | No |
| `HELIUS_API_KEY` or `HELIUS_SOLANA_RPC_URL` | [Helius dashboard](https://dashboard.helius.dev/) | Primary Solana mainnet RPC and transaction confirmation | No |
| `PRIVY_APP_ID` | [Privy dashboard](https://dashboard.privy.io/) | Server-side Privy project identity | No |
| `PRIVY_APP_SECRET` | Privy dashboard | Server verification and future token validation | No |
| `VITE_PRIVY_APP_ID` | Same Privy app | Initializes the browser SDK; Privy app IDs are public identifiers | Yes |
| `PHOENIX_ACCESS_CODE` | Phoenix partner/onboarding contact | Phoenix private-beta onboarding | No |
| `PHOENIX_BUILDER_AUTHORITY` | Phoenix Flight builder account | Builder routing and fee attribution | Public key only |

## Strongly recommended

| Variable | Purpose |
| --- | --- |
| `ALCHEMY_API_KEY` or `ALCHEMY_SOLANA_RPC_URL` | Backup Solana RPC. The backend retries Alchemy when the Helius request fails. |
| `PHOENIX_BUILDER_PDA_INDEX` | Flight builder PDA index; defaults to `0`. |
| `PHOENIX_BUILDER_SUBACCOUNT_INDEX` | Flight builder subaccount index; defaults to `0`. |

## Finding the agent ID

Open [ClawPump Agents](https://agents.clawpump.tech/dashboard). The UUID after `?agent=` in an agent's dashboard URL is its ID. It can also be read from the `id` field returned by the ClawPump `list_agents` tool. Read-only market intelligence and swap quotes work without an ID; portfolio, wallet and Phoenix account/execution tools need one.

## Safety switches

- `ENABLE_MAINNET_EXECUTION=false` is the default. Quotes, charts, auth, and previews still work.
- Change it to `true` only after ClawPump, RPC, and wallet integration tests pass.
- The spot backend turns the ClawPump route into an unsigned Jupiter transaction. The user wallet signs it in the browser; private keys never enter this app.
- ClawPump supplies the route quote; Jupiter serializes that route for the connected wallet. This avoids sending spot funds to an agent wallet.
- The Phoenix backend uses the configured ClawPump agent wallet and requires preview, explicit risk confirmation, and an idempotency key.
- Never store a user wallet private key or an x402 payment private key in this project.

## Fixed public identifiers

- ANSEM mint: `9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump`
- USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

## Deferred

No ElevenLabs variables are present yet. The UI and backend keep a distinct thesis-agent boundary, but voice credentials and runtime code will be added in a later phase.
