-- Rank the complete teams directory using each team's latest stored rating.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

CREATE TABLE IF NOT EXISTS team_directory (
  id uuid PRIMARY KEY REFERENCES team(id) ON DELETE CASCADE,
  name text NOT NULL,
  city text,
  country text,
  rating double precision,
  measure_date date,
  search_name text COLLATE golaberto_search GENERATED ALWAYS AS (name) STORED,
  search_country text COLLATE golaberto_search GENERATED ALWAYS AS (coalesce(country, '')) STORED,
  rating_display text GENERATED ALWAYS AS
    (CASE WHEN rating IS NULL THEN '—' ELSE round(rating::numeric, 2)::text END) STORED,
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL
);

-- Pronto's fresh baseline declares the fields; raw SQL owns their collations.
-- Replay skips ALTER TYPE when pgroll views already depend on correct columns.
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['search_name', 'search_country'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'team_directory'::regclass
               AND attname = target AND attcollation <> 'golaberto_search'::regcollation) THEN
      EXECUTE format('ALTER TABLE team_directory ALTER COLUMN %I TYPE text COLLATE golaberto_search', target);
    END IF;
  END LOOP;
END $$;

CALL rls_protect('team_directory');
DROP POLICY IF EXISTS team_directory_app_user_select ON team_directory;
CREATE POLICY team_directory_app_user_select ON team_directory FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS team_directory_service_all ON team_directory;
CREATE POLICY team_directory_service_all ON team_directory FOR ALL TO service USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON team_directory TO anon, app_user, service;
GRANT SELECT ON team_directory TO electric;
DROP TRIGGER IF EXISTS restamp_txid ON team_directory;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON team_directory
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
ALTER TABLE team_directory REPLICA IDENTITY FULL;
-- tier: container
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'electric_publication_default'
                   AND schemaname = 'public' AND tablename = 'team_directory') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE team_directory;
  END IF;
END $$;
-- tier: any

-- Atomic pgroll completion cannot build concurrently; lock timeout bounds waits.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_directory_rating_order_idx
  ON team_directory (rating DESC NULLS LAST, name, id);

CREATE OR REPLACE FUNCTION refresh_team_directory() RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp SET statement_timeout = '20s' AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(70921024) THEN RETURN; END IF;
  WITH selected AS MATERIALIZED (
    SELECT t.id, t.name, t.city, t.country, r.rating, r.measure_date
    FROM team t LEFT JOIN LATERAL (
      SELECT rating, measure_date FROM team_rating
      WHERE team_id = t.id ORDER BY measure_date DESC, id LIMIT 1
    ) r ON true
  ), removed AS (
    DELETE FROM team_directory d WHERE NOT EXISTS (SELECT 1 FROM selected s WHERE s.id = d.id)
  )
  INSERT INTO team_directory AS d (id, name, city, country, rating, measure_date)
    SELECT id, name, city, country, rating, measure_date FROM selected ORDER BY id
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, city = EXCLUDED.city,
    country = EXCLUDED.country, rating = EXCLUDED.rating, measure_date = EXCLUDED.measure_date
  WHERE (d.name, d.city, d.country, d.rating, d.measure_date)
    IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.city, EXCLUDED.country, EXCLUDED.rating, EXCLUDED.measure_date);
END;
$$;
REVOKE ALL ON FUNCTION refresh_team_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_team_directory() TO service;
SELECT refresh_team_directory();
NOTIFY pgrst, 'reload schema';
COMMIT;
