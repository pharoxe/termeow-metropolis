# termeow · Monad Metropolis submission

**Primary track:** Onchain Finance & Trading
**Sponsor tracks entered:** Kuru, Agora, Aurora Intents, Perpl, Privy, Nansen

## One-liner

termeow is an onchain trading agent for Monad. It reads the market from the chain itself and from smart-money intelligence, explains what it sees, and turns "buy X if wallet Y buys under a $2M cap, take profit at +40%" into a passkey-approved automation. That automation runs later on a policy-restricted delegated wallet.

## Why Monad

- **Fast blocks.** Blocks land every ~300 ms and finalise in ~600 ms, so candles, order flow and wallet tape built from raw swap logs are effectively real-time.
- **Cheap reaction.** Automations can react to a tracked wallet's fill within a block or two.
- **Cheap execution.** Gas is cheap enough that one conditional entry with several staged exits still costs little.

## Architecture (fork summary)

The Solana stack (ClawPump MCP, Jupiter, pump.fun, Helius) and the earlier Robinhood Chain EVM stack were replaced with a single Monad profile (`shared/chains.ts`, mainnet chain 143 / testnet 10143).

| Layer | Monad implementation |
| --- | --- |
| Market tape | Uniswap v2/v3/v4 log pollers + WebSocket over a pool of public Monad RPCs (QuickNode, Alchemy, Ankr, MonadInfra, Goldsky), respecting each one's `eth_getLogs` range cap |
| Launches | nad.fun BondingCurve events (create / buy / sell / graduate) plus the nad.fun REST API |
| Smart money | Nansen smart-money netflow, DEX trades, token flow intelligence and wallet labels, plus the user's watchlist |
| Perps context | Perpl market tickers (mark / oracle / funding / OI) |
| Swaps | Kuru Flow aggregator by default; 0x optional |
| Wallets | Privy embedded EVM wallets, passkey MFA, a delegated signer and an `eth_sendTransaction` policy |
| Credits | Voice-agent credits paid in MON, USDC or Agora AUSD on Monad, verified against finalized blocks |

## Sponsor-track fit (brief ratings)

| Track | Fit | Why |
| --- | --- | --- |
| **Kuru** | ★★★★★ Strong | Kuru Flow is the default router for every swap: desk ticket, voice agent and unattended automations. The delegated-wallet policy allowlists only Kuru Flow contracts, so Kuru is literally the execution layer of the product. |
| **Privy** | ★★★★½ Strong | Embedded EVM wallets for login and signing, passkey MFA on every agent-proposed action, and server-side delegated execution bound by a Monad-only transaction policy. That is a full non-custodial agent-wallet story. |
| **Nansen** | ★★★★ Strong | Nansen smart-money netflow, trades and labels power the SMART tape and board, the label book that decides who counts as smart money, and the agent's research tools. Depth depends on how much Monad coverage Nansen's API has. |
| **Perpl** | ★★★ Moderate | Perpl perps data (funding, OI, mark vs oracle) feeds the desk's regime strip and the agent's context. It is read-only, with no perps execution yet; adding Perpl orders as an automation action would make this strong. |
| **Agora** | ★★½ Light | AUSD is supported as a funding and credit-payment asset and priced as a stable, but Agora isn't central to the product. A stronger fit would be AUSD as the default quote/settlement asset for automations. |
| **Aurora Intents** | ★½ Weak | Not integrated. The natural fit is cross-chain deposits that fund a user's Monad wallet before an automation arms. It's worth entering only if that onboarding flow gets built. |

## Demo script (≈3 min)

1. Open the desk on MON/WMON: show chain-built candles, the order-flow windows, the SMART tape and the Perpl regime strip.
2. Open the agent and say "What's smart money doing on Monad today?" The agent calls the Nansen tools and the HUD opens.
3. Say "Buy 10% of my wallet of <token> if <labelled wallet> buys, under $2M market cap, sell half at +40%." The agent drafts a `conditional_swap`, and you confirm it with a passkey.
4. Show the armed automation, then the delegated Kuru Flow execution and the transaction on MonadVision.

## Known gaps / unverified

- `npm install`, tests and build were not run in the fork environment. Every source and test file typechecks against shims, but run `npm install && npm run check` before demoing.
- A few third-party field names were taken from documentation and haven't been exercised against live responses. Check them first if anything looks empty:
  - Privy server-SDK `sendTransaction` parameters
  - Perpl ticker fields
  - Kuru Flow `transaction.to`
- `package.json` still lists the old Solana/ClawPump dependencies. Nothing imports them now. Remove them with `npm uninstall @clawpump/agents @modelcontextprotocol/sdk @solana/web3.js`; keep `@solana/kit` and `@solana-program/*` only if Privy's bundle still asks for them.
- The older docs in `docs/` (e.g. `ROBINHOOD_FOCUS_PLAN.md`) describe the pre-fork system.
