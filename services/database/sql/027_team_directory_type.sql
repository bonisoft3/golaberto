-- Add source-owned team classification to the ranked directory projection.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

-- squawk-ignore prefer-robust-stmts, adding-field-with-default
ALTER TABLE team_directory
  ADD COLUMN IF NOT EXISTS team_type text NOT NULL DEFAULT 'club';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='team_directory'::regclass AND conname='team_directory_team_type_check'
  ) THEN
    ALTER TABLE team_directory ADD CONSTRAINT team_directory_team_type_check
      CHECK (team_type IN ('club', 'national')) NOT VALID;
  END IF;
END $$;
ALTER TABLE team_directory VALIDATE CONSTRAINT team_directory_team_type_check;

-- Atomic pgroll completion cannot build concurrently; lock timeout bounds waits.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_directory_by_type_rating
  ON team_directory (team_type, rating DESC NULLS LAST, name, id);

CREATE OR REPLACE FUNCTION refresh_team_directory() RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp SET statement_timeout = '20s' AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(70921024) THEN RETURN; END IF;
  WITH selected AS MATERIALIZED (
    SELECT t.id,t.name,t.city,t.country,t.team_type,r.rating,r.measure_date,
      coalesce(c.id,'') AS country_id,coalesce(c.region_id,'') AS region_id,
      coalesce(c.search_key,replace(replace(replace(coalesce(t.country,''),'ı','i'),'þ','th'),'Þ','th')) AS country_search_key,
      coalesce(c.region_search_key,'world mundo mundial monde welt mondo') AS region_search_key
    FROM team t
    LEFT JOIN geography_country c ON c.aliases::jsonb ? t.country
    LEFT JOIN LATERAL (
      SELECT rating,measure_date FROM team_rating WHERE team_id=t.id ORDER BY measure_date DESC,id LIMIT 1
    ) r ON true
  ), removed AS (
    DELETE FROM team_directory d WHERE NOT EXISTS (SELECT 1 FROM selected s WHERE s.id=d.id)
  )
  INSERT INTO team_directory AS d (id,name,city,country,team_type,rating,measure_date,country_id,region_id,country_search_key,region_search_key)
    SELECT id,name,city,country,team_type,rating,measure_date,country_id,region_id,country_search_key,region_search_key FROM selected ORDER BY id
  ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,city=EXCLUDED.city,country=EXCLUDED.country,
    team_type=EXCLUDED.team_type,rating=EXCLUDED.rating,measure_date=EXCLUDED.measure_date,country_id=EXCLUDED.country_id,region_id=EXCLUDED.region_id,
    country_search_key=EXCLUDED.country_search_key,region_search_key=EXCLUDED.region_search_key
  WHERE (d.name,d.city,d.country,d.team_type,d.rating,d.measure_date,d.country_id,d.region_id,d.country_search_key,d.region_search_key)
    IS DISTINCT FROM (EXCLUDED.name,EXCLUDED.city,EXCLUDED.country,EXCLUDED.team_type,EXCLUDED.rating,EXCLUDED.measure_date,
      EXCLUDED.country_id,EXCLUDED.region_id,EXCLUDED.country_search_key,EXCLUDED.region_search_key);
END;
$$;
REVOKE ALL ON FUNCTION refresh_team_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_team_directory() TO service;
SELECT refresh_team_directory();
NOTIFY pgrst, 'reload schema';
COMMIT;
