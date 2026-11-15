-- The retained prefix serves both lookups; its rating payload also covers chart scans.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('public.team_rating_home_latest_idx')
      AND indisvalid AND indisready
  ) THEN
    RAISE EXCEPTION 'rating history requires its valid covering index';
  END IF;
END $$;

-- squawk-ignore require-concurrent-index-deletion
DROP INDEX IF EXISTS public.idx_team_rating_team_id;
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX IF EXISTS public.team_rating_match_history_idx;

COMMIT;
