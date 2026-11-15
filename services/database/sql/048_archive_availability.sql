-- A fixture the source cancelled, abandoned or awarded is not available to
-- the upcoming feeds. The archive view gains the flag as a column appended to
-- whatever shape it has: production's game_archive lists the game columns
-- 035 saw, a fresh database's lists today's.
BEGIN;
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE game ADD COLUMN IF NOT EXISTS sync_status text;

DO $$ DECLARE definition text; BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='game_archive' AND column_name='fixture_available') THEN
    SELECT trim(trailing ';' FROM pg_get_viewdef('public.game_archive'::regclass, true)) INTO definition;
    EXECUTE 'CREATE OR REPLACE VIEW public.game_archive WITH (security_invoker=true) AS SELECT archive.*, '
      || '(game.played OR coalesce(game.sync_status, ''scheduled'') NOT IN (''cancelled'', ''abandoned'', ''awarded'')) AS fixture_available '
      || 'FROM (' || definition || ') archive JOIN public.game game ON game.id=archive.id';
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
