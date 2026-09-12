# Privy automation MVP

## What is implemented

- The user's embedded Solana wallet stays user-owned.
- When an unattended Solana workflow is approved, the client uses Privy's `addSigners` flow to attach the configured P-256 key quorum with a signer-specific policy.
- The server records only the Privy wallet ID/address and policy identifiers. It never stores the embedded-wallet private key.
- `POST /api/internal/automations/:id/fire` accepts a trusted signal, checks status, expiry and market-cap bounds, sizes the order, gets a fresh Jupiter quote, builds the swap, decodes its transaction, verifies the fee payer and top-level program allowlist, then asks Privy to sign and broadcast it.
- Privy's `reference_id` and idempotency header are derived from the automation and source event IDs.

The internal endpoint is protected by `AUTOMATION_TRIGGER_SECRET`. It supports Jupiter/Solana first. Robinhood/0x unattended signing remains disabled until a separate EVM calldata policy and allowance lifecycle are reviewed.

### Deployed MVP infrastructure

- Railway project/service: `termeow` / `termeow` (production environment only).
- Neon database: `termeow`, with all application objects qualified under the dedicated `termeow` schema.
- Cloudflare Worker: `termeow-automation-ingress`.
- Cloudflare queues: `termeow-automation-events` and `termeow-automation-dlq`.
- Worker health: `https://termeow-automation-ingress.anabilmahanta.workers.dev/health`.

The Worker accepts authenticated `POST /v1/automations/:automationId/fire` events, validates their shape, and enqueues them. The queue consumer calls Railway with a separate internal bearer secret. `termeow.automation_execution_events` has a unique `(automation_id, source_event_id)` constraint, making provider retries idempotent before any swap is built or signed.

## Reviewed Solana programs

| Program | Purpose |
| --- | --- |
| `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | Jupiter v6 router |
| `ComputeBudget111111111111111111111111111111` | Compute-unit limit and priority price |
| `11111111111111111111111111111111` | SOL and wrapped-SOL account setup |
| `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | Associated token accounts |
| `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | SPL Token |
| `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | Token-2022 |

A Jupiter response containing any other top-level program fails closed. New programs must be reviewed in both `server/automation/privyPolicy.ts` and the Privy policy before use.

## One-time Privy setup

1. Generate a P-256 keypair offline. Register the public key as a 1-of-1 key quorum in Privy. Store its key-quorum ID as `PRIVY_AUTOMATION_SIGNER_ID`.
2. Convert the PKCS8 private key to the base64 body expected by `@privy-io/node` and store it as `PRIVY_AUTOMATION_AUTH_PRIVATE_KEY` in Railway Variables for the current MVP. Do not put it in Neon or a committed `.env`.
3. With `PRIVY_APP_ID` and `PRIVY_APP_SECRET` set locally, run `npm run setup:privy-automation`. Store the returned ID as `PRIVY_AUTOMATION_POLICY_ID`.
4. Generate at least 32 random bytes for `AUTOMATION_TRIGGER_SECRET`; store the same value in Railway and in the Cloudflare Worker secret binding.
5. Test with a low-balance wallet and a tiny fixed-size automation before enabling wallet-percentage sizing.

The private authorization key is not the user's Solana key. It authorizes requests to Privy, which applies the attached policy before its enclave signs with the embedded wallet.

## Lean MVP stack

```text
Helius / Fomo / X webhook
          ↓
Cloudflare Worker ingress + validation
          ↓
Cloudflare Queue (retry and burst control)
          ↓
Worker consumer → Termeow internal fire endpoint
          ↓
Neon transaction/idempotency record
          ↓
Jupiter quote + build → Termeow inspection → Privy sign/send
          ↓
Solana confirmation webhook/poller → Neon execution result → UI/SFX notification
```

- **Neon Postgres:** users, wallet bindings, workflow definitions, source events, execution attempts, fills and audit logs. Use unique `(automation_id, source_event_id, stage)` constraints as the primary duplicate-execution guard.
- **Cloudflare Workers ($5 paid plan):** webhook gateway, cron triggers, signature verification and lightweight signal normalization.
- **Cloudflare Queues:** durable fan-out, retries and back-pressure. This removes the need for Redis/Upstash during the MVP.
- **Railway:** keep the existing API/UI and Privy execution worker initially. The authorization key belongs in a Railway secret variable, not a database row. Move only the signing endpoint to a Worker secret later if Node compatibility and operational testing are satisfactory.
- **Helius:** use webhooks for watched-wallet activity and the existing RPC key for confirmation/fallback reads. No additional subscription is required initially.

No extra subscription should be needed beyond the existing services. Do not add Redis until queue latency or workflow scheduling requirements prove Cloudflare Queues insufficient.

## Next hardening step

Replace the current restart snapshot stores with Neon repositories before allowing more than internal test funds. Add an execution-attempt state machine (`received → validated → quoted → submitted → confirmed/failed`) and a reconciliation job that checks a recorded signature before any retry. Then add a signer-revocation control and a second authorization key before external users.
