ALTER TABLE termeow.automation_preferences
  ADD COLUMN IF NOT EXISTS favorite_traders jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS favorite_tokens jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;
