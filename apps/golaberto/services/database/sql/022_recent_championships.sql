-- The homepage lists every recent tournament, ranked by upstream's geometric mean.
SET lock_timeout = '5s';
SET statement_timeout = '60s';
BEGIN;

-- Fresh volumes have the declared entity; retained volumes acquire its same shape.
CREATE TABLE IF NOT EXISTS home_championship (
  id uuid PRIMARY KEY REFERENCES championship(id) ON DELETE CASCADE,
  region portable_string NOT NULL,
  region_name portable_string NOT NULL,
  full_name portable_string NOT NULL,
  strength portable_double NOT NULL,
  txid bigint DEFAULT pg_current_xact_id()::text::bigint,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL
);
CALL rls_protect('home_championship');
DROP POLICY IF EXISTS home_championship_app_user_select ON home_championship;
CREATE POLICY home_championship_app_user_select ON home_championship FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS home_championship_service_all ON home_championship;
CREATE POLICY home_championship_service_all ON home_championship FOR ALL TO service USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON home_championship TO anon, app_user, service;
GRANT SELECT ON home_championship TO electric;
DROP TRIGGER IF EXISTS restamp_txid ON home_championship;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON home_championship
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
ALTER TABLE home_championship REPLICA IDENTITY FULL;
-- tier: container
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'electric_publication_default'
                   AND schemaname = 'public' AND tablename = 'home_championship') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE home_championship;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION recent_championships(at_time timestamptz)
RETURNS TABLE (id uuid, region text, region_name text, full_name text, strength double precision)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH reference AS (
    SELECT (at_time AT TIME ZONE 'America/Sao_Paulo')::date AS today
  ), candidates AS MATERIALIZED (
    SELECT c.* FROM championship c CROSS JOIN reference r
    WHERE c.begins < r.today + 30 AND c.ends > r.today - 30
  ), members AS (
    SELECT DISTINCT c.id AS championship_id, tg.team_id
    FROM candidates c JOIN phase p ON p.championship_id = c.id
    JOIN stage_group g ON g.phase_id = p.id JOIN team_group tg ON tg.group_id = g.id
  ), teams AS (
    SELECT DISTINCT team_id FROM members
  ), ratings AS MATERIALIZED (
    SELECT t.team_id, COALESCE(r.rating, 0) AS rating
    FROM teams t LEFT JOIN LATERAL (
      SELECT rating FROM team_rating
      WHERE team_id = t.team_id AND measure_date <= (SELECT today FROM reference)
      ORDER BY measure_date DESC, id LIMIT 1
    ) r ON true
  ), ordered AS (
    SELECT m.championship_id, r.rating,
      power(0.7::double precision, (row_number() OVER (
        PARTITION BY m.championship_id ORDER BY r.rating DESC, m.team_id) - 1)::double precision) AS weight
    FROM members m JOIN ratings r USING (team_id)
  ), strengths AS (
    SELECT championship_id, sum(rating * weight) / sum(weight) AS strength
    FROM ordered GROUP BY championship_id
  )
  SELECT c.id, c.region::text, c.region_name::text, c.full_name::text,
    COALESCE(s.strength, 0) FROM candidates c LEFT JOIN strengths s ON s.championship_id = c.id;
$$;

CREATE OR REPLACE FUNCTION refresh_recent_championships() RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp SET statement_timeout = '20s' AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(70921023) THEN RETURN; END IF;
  WITH selected AS MATERIALIZED (SELECT * FROM recent_championships(now())),
  removed AS (
    DELETE FROM home_championship h WHERE NOT EXISTS (SELECT 1 FROM selected s WHERE s.id = h.id)
  )
  INSERT INTO home_championship AS h (id, region, region_name, full_name, strength)
    SELECT id, region, region_name, full_name, strength FROM selected
  ON CONFLICT (id) DO UPDATE SET region = EXCLUDED.region, region_name = EXCLUDED.region_name,
    full_name = EXCLUDED.full_name, strength = EXCLUDED.strength
  WHERE (h.region, h.region_name, h.full_name, h.strength)
    IS DISTINCT FROM (EXCLUDED.region, EXCLUDED.region_name, EXCLUDED.full_name, EXCLUDED.strength);
END;
$$;
REVOKE ALL ON FUNCTION recent_championships(timestamptz), refresh_recent_championships() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recent_championships(timestamptz), refresh_recent_championships() TO service;
SELECT refresh_recent_championships();
NOTIFY pgrst, 'reload schema';
COMMIT;
