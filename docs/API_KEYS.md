# API keys and runtime configuration

Copy `.env.example` to `.env`. The checked-in template contains no secrets, and `.env` is gitignored.

## Required for the complete vertical slice

| Variable | Where to obtain it | Purpose | Browser-safe? |
| --- | --- | --- | --- |
| `CLAWPUMP_API_KEY` | [ClawPump dashboard](https://agents.clawpump.tech/dashboard/api) | Agent MCP, market tools, quotes, portfolio, and execution | No |
| `CLAWPUMP_AGENT_ID` | ClawPump dashboard / `list_agents` response | Selects the ClawPump intelligence agent | ID only; keep server-side |
| `JUPITER_API_KEY` | [Jupiter developer portal](https://portal.jup.ag/) | Optional authenticated transaction builder after the ClawPump route quote | No |
| `ZEROEX_API_KEY` | [0x dashboard](https://dashboard.0x.org/) | Solana Swap API quotes and transaction instructions | No |
| `HELIUS_API_KEY` or `HELIUS_SOLANA_RPC_URL` | [Helius dashboard](https://dashboard.helius.dev/) | Primary Solana mainnet RPC and transaction confirmation | No |
| `PRIVY_APP_ID` | [Privy dashboard](https://dashboard.privy.io/) | Server-side Privy project identity | No |
| `PRIVY_APP_SECRET` | Privy dashboard | Server verification and future token validation | No |
| `VITE_PRIVY_APP_ID` | Same Privy app | Initializes the browser SDK; Privy app IDs are public identifiers | Yes |

## Strongly recommended

| Variable | Purpose |
| --- | --- |
| `ALCHEMY_API_KEY` or `ALCHEMY_SOLANA_RPC_URL` | Backup Solana RPC. The backend retries Alchemy when the Helius request fails. |

## Finding the agent ID

Open [ClawPump Agents](https://agents.clawpump.tech/dashboard). The UUID after `?agent=` in an agent's dashboard URL is its ID. It can also be read from the `id` field returned by the ClawPump `list_agents` tool. Read-only market intelligence and swap quotes work without an ID.

## Execution safety

- Mainnet spot routing is available by default; there is no environment toggle that can leave the interface in a misleading preview-only state.
- The routing dropdown currently supports 0x Solana Swap API and ClawPump + Jupiter through one server-side quote/build contract.
- Every route becomes an unsigned transaction. The connected Privy wallet reviews and signs it in the browser; private keys never enter this app.
- Quotes expire after 60 seconds, are bound to their selected router, and require a fresh user confirmation before submission.
- Never store a user wallet private key or an x402 payment private key in this project.

## Fixed public identifiers

- ANSEM mint: `9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump`
- USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

## Voice agent

Set `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` server-side to activate the lazy-loaded voice interface.

Set `TWITTERAPI_IO_API_KEY` server-side to enable armed X launch monitors. The backend polls each distinct account once per cycle and serves captured launch signals from Termeow's own automation store; clients never receive the provider key or call twitterapi.io directly. `TWITTERAPI_IO_POLL_MS` defaults to 60 seconds and cannot be lower than 15 seconds.
