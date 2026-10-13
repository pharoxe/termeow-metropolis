-- Monad fork: every chain-scoped row is now "monad" (chain id 143). Older Solana / Robinhood rows stay readable, but new
-- writes must name Monad and its assets. Constraint names are Postgres' defaults for the inline CHECKs in 001 and 004.

ALTER TABLE termeow.automation_delegations DROP CONSTRAINT IF EXISTS automation_delegations_chain_check;
ALTER TABLE termeow.automation_delegations
  ADD CONSTRAINT automation_delegations_chain_check CHECK (chain IN ('solana', 'monad'));

ALTER TABLE termeow.agent_credit_quotes DROP CONSTRAINT IF EXISTS agent_credit_quotes_chain_check;
ALTER TABLE termeow.agent_credit_quotes
  ADD CONSTRAINT agent_credit_quotes_chain_check CHECK (chain IN ('solana', 'robinhood', 'monad'));

ALTER TABLE termeow.agent_credit_quotes DROP CONSTRAINT IF EXISTS agent_credit_quotes_asset_check;
ALTER TABLE termeow.agent_credit_quotes
  ADD CONSTRAINT agent_credit_quotes_asset_check CHECK (asset IN ('SOL', 'USDC', 'ETH', 'USDG', 'MON', 'AUSD'));
