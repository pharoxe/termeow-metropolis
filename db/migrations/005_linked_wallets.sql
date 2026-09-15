ALTER TABLE termeow.automation_preferences
  ADD COLUMN IF NOT EXISTS linked_wallets jsonb NOT NULL DEFAULT '[]'::jsonb;
