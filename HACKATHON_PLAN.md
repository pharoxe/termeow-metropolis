# ClawPump AnsemHack implementation plan

## Product thesis

Turn Terminal V into a compact Solana execution cockpit: live token evidence, a guarded spot swap flow, and Phoenix perps behind a clear product toggle. The hackathon vertical slice is ANSEM/USD on spot and SOL-PERP on Phoenix.

The interface deliberately uses separate `/onchain` and `/perps` pages. They share navigation, design tokens, normalized data components, authentication, and one deployable Express service, while keeping different execution and risk models out of the same ticket.

## Current foundation

- React/Vite/TypeScript frontend and Express backend replace the Hyperliquid/Python runtime.
- ANSEM is identified by mint `9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump`.
- Live ANSEM price, liquidity, volume, market cap, candles, and technicals have public fallbacks.
- ClawPump MCP adapters cover token search, intelligence, swap quotes, portfolio, and Phoenix tools.
- Spot routes are quoted by ClawPump, converted to an unsigned Jupiter transaction, then signed by the connected wallet.
- Phoenix orders use a distinct agent-backed preview/execute path with explicit risk confirmation and idempotency.
- Phantom/Solflare wallet UX and conditional Privy UX exist. MagicBlock Session Keys are represented only as a permission-design mock.
- Mainnet writes remain disabled by default.

## Hackathon milestones

### 1. Credentialed integration

- Add ClawPump API key and agent ID, Helius RPC, Alchemy fallback, and Privy credentials.
- Confirm ClawPump quote payload compatibility with the Jupiter transaction builder.
- Verify Phoenix market/account schemas and builder attribution with the real partner account.
- Record one low-value mainnet ANSEM swap and one Phoenix preview in a controlled wallet.

### 2. ANSEM evidence depth

- Promote ClawPump token intelligence and on-chain signals into normalized evidence cards.
- Add holder concentration, token authority/security state, large swaps, smart-wallet flow, and freshness/source labels.
- Keep the local EMA, MACD, RSI, VWAP, Bollinger Bands, ATR, and volume calculations as deterministic fallbacks.
- Store small rolling snapshots so the terminal can show change, not only the latest value.

### 3. Execution hardening

- Persist `draft → previewed → confirmed → submitted → finalized/failed` states.
- Bind previews to wallet, mint, amount, slippage, expiry, and an idempotency key.
- Add RPC confirmation tracking, rejected-signature handling, rate limits, structured logs, and an audit record.
- Keep every spot signature user-controlled; do not accept private keys or require custodial deposits.

### 4. Authentication and permissions

- Complete Privy embedded Solana wallet creation and server-side access-token verification.
- Finalize a MagicBlock Session Keys permission matrix before integration: allowed programs, mint pairs, notional ceiling, slippage ceiling, expiry, and revocation.
- Ensure session delegation cannot authorize Phoenix/agent-wallet writes or arbitrary Solana instructions.

### 5. Demo and deployment

- Deploy the single Node service behind HTTPS.
- Add a deterministic read-only demo mode when sponsor services are unavailable.
- Prepare a two-minute loop: inspect ANSEM evidence → quote → wallet confirmation → signature → switch to perps → Phoenix preview.
- Capture real usage, quote, preview, signature, failure-rate, and builder-attribution metrics.

## ElevenLabs-ready boundary

Voice is intentionally deferred. A later thesis-agent module should receive the selected instrument, visible evidence, wallet exposure, and product mode; return a structured thesis; and call read/preview tools only. Spoken input must never confirm or execute a transaction. The future panel can live beside either page without coupling voice transport to the market or execution adapters.

## SWOT

| Strengths | Weaknesses |
| --- | --- |
| Clear ANSEM vertical slice with live mainnet market data. | Credentialed ClawPump and Phoenix execution still requires partner keys and funded test accounts. |
| Sponsor stack is load-bearing: ClawPump intelligence/routes and Phoenix perps. | ClawPump spot execution is agent-wallet oriented, so non-custodial spot requires a Jupiter transaction-builder bridge. |
| Separate spot/perp pages make risk and custody boundaries legible. | Privy and wallet-adapter dependencies add bundle weight and inherited advisories. |
| Mainnet writes are gated and private keys never enter the app. | MagicBlock permission design is not finalized. |

| Opportunities | Threats |
| --- | --- |
| ANSEM-first polish gives judges a coherent, token-native demo. | Sponsor API/package contract changes can break the demo close to judging. |
| Builder attribution and genuine on-chain volume support a credible business model. | Thin token liquidity, spoofed symbols, or stale signals can produce unsafe decisions. |
| Evidence-to-thesis-to-trade can later become the ElevenLabs differentiator. | Phoenix access, jurisdiction, collateral, or builder configuration may block live execution. |
| Normalized adapters make additional Solana venues relatively cheap to add. | Session-key scopes that are too broad create unacceptable wallet risk. |

## Recommended game plan

For the hackathon, optimize for a reliable proof loop rather than feature breadth. Finish credentialed ClawPump reads and one non-custodial ANSEM swap first. Add a high-quality Phoenix preview second, and enable Phoenix execution only if builder attribution and agent-wallet custody are unambiguous. Spend remaining time on evidence clarity, transaction-state persistence, and demo resilience. Keep ElevenLabs and real MagicBlock delegation out of the critical path, but preserve their interfaces so neither requires another rewrite.

## Known upstream constraint

`@clawpump/agents@0.1.25` is currently published without its declared `dist` runtime. This project pins `0.1.23`, the newest verified complete package, until the upstream tarball is corrected.
