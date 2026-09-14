CREATE TABLE IF NOT EXISTS termeow.agent_credit_accounts (
  user_id text PRIMARY KEY,
  balance_credits integer NOT NULL DEFAULT 500 CHECK (balance_credits >= 0),
  debt_credits integer NOT NULL DEFAULT 0 CHECK (debt_credits >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS termeow.agent_credit_quotes (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES termeow.agent_credit_accounts(user_id),
  chain text NOT NULL CHECK (chain IN ('solana', 'robinhood')),
  asset text NOT NULL CHECK (asset IN ('SOL', 'USDC', 'ETH', 'USDG')),
  sender text NOT NULL,
  recipient text NOT NULL,
  amount_base_units numeric(78,0) NOT NULL CHECK (amount_base_units > 0),
  credits integer NOT NULL CHECK (credits > 0),
  tx_hash text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  settled_at timestamptz
);

CREATE TABLE IF NOT EXISTS termeow.agent_credit_ledger (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL REFERENCES termeow.agent_credit_accounts(user_id),
  delta_credits integer NOT NULL,
  reason text NOT NULL,
  reference text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS termeow.agent_voice_sessions (
  conversation_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES termeow.agent_credit_accounts(user_id),
  reserved_credits integer NOT NULL CHECK (reserved_credits > 0),
  charged_credits integer,
  provider_cost_usd numeric(18,8),
  duration_seconds integer,
  token_expires_at timestamptz NOT NULL,
  not_found_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_voice_sessions_pending ON termeow.agent_voice_sessions(created_at) WHERE settled_at IS NULL;
