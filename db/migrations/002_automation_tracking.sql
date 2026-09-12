ALTER TABLE termeow.automation_workflows
  ADD COLUMN IF NOT EXISTS last_signal jsonb,
  ADD COLUMN IF NOT EXISTS active_exit_conditions jsonb;

CREATE TABLE IF NOT EXISTS termeow.automation_preferences (
  user_id text PRIMARY KEY,
  tracked_traders jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_allocation_percent numeric,
  default_slippage_bps integer,
  default_duration_hours integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automation_workflows_armed_kind_idx
  ON termeow.automation_workflows ((intent->>'kind'), updated_at DESC)
  WHERE status = 'armed';
