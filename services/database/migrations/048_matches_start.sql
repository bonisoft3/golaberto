-- A request-time origin keeps the default current without hiding older fixtures.
BEGIN;
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DO $$ DECLARE alias record; BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.matches_start') AND relkind='r') THEN
    IF EXISTS (SELECT 1 FROM matches_start) THEN
      RAISE EXCEPTION 'read view placeholder matches_start contains rows';
    END IF;
    IF to_regclass('pgroll.migrations') IS NOT NULL THEN
      FOR alias IN SELECT n.nspname,c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pgroll.migrations m ON n.nspname=m.schema||'_'||m.name
        WHERE m.schema='public' AND c.relname='matches_start' AND c.relkind='v'
      LOOP EXECUTE format('DROP VIEW %I.%I',alias.nspname,alias.relname); END LOOP;
    END IF;
    DROP TABLE matches_start;
  END IF;
END $$;

CREATE OR REPLACE VIEW matches_start WITH (security_invoker=true) AS
SELECT '00000000-0000-0000-0000-000000000000'::uuid AS id,
  n AS start_offset,n+40 AS start_next_offset,(n+39)/40+1 AS start_page,
  NULL::bigint AS txid,'public:'::text AS scope_id
FROM (
  SELECT count(*)::integer AS n FROM game_archive
  WHERE played IS FALSE AND kickoff IS NOT NULL
    AND day < (now() AT TIME ZONE 'America/Sao_Paulo')::date-7
) origin;
REVOKE ALL ON matches_start FROM PUBLIC,anon,app_user,service,electric;
GRANT SELECT ON matches_start TO app_user,service;
NOTIFY pgrst,'reload schema';
COMMIT;
