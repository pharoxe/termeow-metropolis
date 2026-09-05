# MagicBlock session-key execution outline

The analysis layer produces a structured trade intent: mint, side, entry predicates, exit predicates, maximum notional, maximum slippage, expiry, and permitted venue. It never receives a primary-wallet private key.

1. The user selects an option and reviews its trigger and risk limits in the confirmation panel.
2. The connected wallet creates an ephemeral session signer and authorizes a short-lived Session Token PDA. The authorization scope should bind the session to the chosen mint, swap direction, cumulative notional cap, slippage cap, and expiry.
3. The agent monitors ClawPump signals, Stochastic RSI, CVD, liquidity, and whale-flow conditions. When all predicates are met, it requests an unsigned route and transaction.
4. A client-side execution adapter verifies that transaction against the saved policy before the ephemeral signer signs. Each transaction must include the session token required by the session-aware program.
5. The UI reports the signature, route, fill, policy consumption, and remaining session lifetime. The user can revoke the session at any time; expiry and cumulative caps stop unattended execution automatically.

## Integration boundary

`SessionExecutionAdapter` is the only execution boundary used by the confirmation UI. It currently returns a guarded “not active” result and never submits a transaction. The MagicBlock implementation can replace that adapter without coupling analysis or presentation code to one signer implementation.

## Feasibility gate

MagicBlock session keys are secondary signers validated by a target Solana program; they are not a substitute owner for a normal wallet token account. Direct Jupiter or DEX instructions will not automatically accept the ephemeral signer for assets owned by the primary wallet. Before enabling execution, choose and validate a session-aware account/program path that can enforce the scoped policy and invoke the chosen router. This constraint should be resolved before representing the feature as non-custodial automatic execution.
