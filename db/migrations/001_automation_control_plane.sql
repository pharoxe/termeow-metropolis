CREATE SCHEMA IF NOT EXISTS termeow;

CREATE TABLE IF NOT EXISTS termeow.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS termeow.automation_workflows (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  intent jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending_approval', 'armed', 'executing', 'completed', 'cancelled', 'failed')),
  source text NOT NULL CHECK (source IN ('elevenlabs_voice', 'terminal')),
  conversation_id text,
  context_digest text,
  approval_method text,
  failure text,
  transaction_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  cancelled_at timestamptz,
  expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS automation_workflows_user_updated_idx
  ON termeow.automation_workflows (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS automation_workflows_armed_expiry_idx
  ON termeow.automation_workflows (status, expires_at)
  WHERE status = 'armed';

CREATE TABLE IF NOT EXISTS termeow.automation_delegations (
  user_id text NOT NULL,
  chain text NOT NULL CHECK (chain = 'solana'),
  wallet_address text NOT NULL,
  wallet_id text NOT NULL,
  signer_id text NOT NULL,
  policy_id text NOT NULL,
  enabled_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, chain)
);

CREATE TABLE IF NOT EXISTS termeow.automation_execution_events (
  id bigserial PRIMARY KEY,
  automation_id uuid NOT NULL REFERENCES termeow.automation_workflows(id) ON DELETE CASCADE,
  source_event_id text NOT NULL,
  observed_market_cap_usd numeric,
  status text NOT NULL CHECK (status IN ('claimed', 'completed', 'failed')),
  transaction_hash text,
  failure text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_id, source_event_id)
);

CREATE INDEX IF NOT EXISTS automation_execution_events_status_idx
  ON termeow.automation_execution_events (status, updated_at);
