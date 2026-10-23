-- Read-only resolution operations expire after two minutes; no payment lease is introduced.
ALTER TABLE orders ADD COLUMN resolution_started_at timestamptz;
-- Pre-upgrade operations have no trusted start time; maintain fences them before retry.
