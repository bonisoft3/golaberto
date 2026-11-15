-- Maintain indexed player directory rows so ranking by rating or name reads an
-- index prefix instead of joining and sorting all players per request.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

CREATE TABLE IF NOT EXISTS player_directory_entry (
  id uuid PRIMARY KEY REFERENCES player(id) ON DELETE CASCADE,
  name text NOT NULL,
  full_name text,
  birth date,
  country text,
  height integer,
  position text,
  slug text NOT NULL,
  rating double precision,
  off_rating double precision,
  def_rating double precision,
  position_key text NOT NULL,
  country_id text NOT NULL,
  region_id text NOT NULL,
  search_key text COLLATE golaberto_search NOT NULL,
  country_search_key text COLLATE golaberto_search NOT NULL,
  region_search_key text COLLATE golaberto_search NOT NULL,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL
);
CALL rls_protect('player_directory_entry');
DROP POLICY IF EXISTS player_directory_entry_app_user_select ON player_directory_entry;
CREATE POLICY player_directory_entry_app_user_select ON player_directory_entry FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS player_directory_entry_service_all ON player_directory_entry;
CREATE POLICY player_directory_entry_service_all ON player_directory_entry FOR ALL TO service USING (true) WITH CHECK (true);
REVOKE ALL ON player_directory_entry FROM PUBLIC,anon,app_user,service,electric;
GRANT SELECT ON player_directory_entry TO app_user,service;

CREATE OR REPLACE FUNCTION refresh_player_directory_entries(targets uuid[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  INSERT INTO player_directory_entry AS e(
    id,name,full_name,birth,country,height,position,slug,
    rating,off_rating,def_rating,position_key,country_id,region_id,
    search_key,country_search_key,region_search_key
  )
  SELECT p.id,p.name,p.full_name,p.birth,p.country,p.height,p.position,p.slug,
    r.rating,r.off_rating,r.def_rating,
    coalesce(p.position,''),coalesce(c.id,''),coalesce(c.region_id,''),
    replace(replace(replace(p.name||' '||coalesce(p.full_name,''),'ı','i'),'þ','th'),'Þ','th') COLLATE golaberto_search,
    coalesce(c.search_key,p.country,'') COLLATE golaberto_search,
    coalesce(c.region_search_key,'') COLLATE golaberto_search
  FROM player p
  LEFT JOIN player_rating r ON r.id=p.id
  LEFT JOIN (
    SELECT DISTINCT ON (a.value) c.id,c.region_id,c.search_key,c.region_search_key,a.value AS country_alias
    FROM geography_country c
    CROSS JOIN LATERAL jsonb_array_elements_text(c.aliases::jsonb) a(value)
    ORDER BY a.value,c.id
  ) c ON c.country_alias=p.country
  WHERE p.id=ANY(targets)
  ON CONFLICT(id) DO UPDATE SET
    name=EXCLUDED.name,full_name=EXCLUDED.full_name,birth=EXCLUDED.birth,
    country=EXCLUDED.country,height=EXCLUDED.height,position=EXCLUDED.position,slug=EXCLUDED.slug,
    rating=EXCLUDED.rating,off_rating=EXCLUDED.off_rating,def_rating=EXCLUDED.def_rating,
    position_key=EXCLUDED.position_key,country_id=EXCLUDED.country_id,region_id=EXCLUDED.region_id,
    search_key=EXCLUDED.search_key,country_search_key=EXCLUDED.country_search_key,
    region_search_key=EXCLUDED.region_search_key
  WHERE (e.name,e.full_name,e.birth,e.country,e.height,e.position,e.slug,
      e.rating,e.off_rating,e.def_rating,e.position_key,e.country_id,e.region_id,
      e.search_key COLLATE "C",e.country_search_key COLLATE "C",e.region_search_key COLLATE "C")
    IS DISTINCT FROM (EXCLUDED.name,EXCLUDED.full_name,EXCLUDED.birth,EXCLUDED.country,EXCLUDED.height,EXCLUDED.position,EXCLUDED.slug,
      EXCLUDED.rating,EXCLUDED.off_rating,EXCLUDED.def_rating,EXCLUDED.position_key,EXCLUDED.country_id,EXCLUDED.region_id,
      EXCLUDED.search_key COLLATE "C",EXCLUDED.country_search_key COLLATE "C",EXCLUDED.region_search_key COLLATE "C")
$$;

CREATE OR REPLACE FUNCTION mark_player_directory_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE targets uuid[];
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT array_agg(DISTINCT id) INTO targets FROM new_rows WHERE id IS NOT NULL;
  ELSIF TG_OP='DELETE' THEN
    SELECT array_agg(DISTINCT id) INTO targets FROM old_rows WHERE id IS NOT NULL;
  ELSE
    SELECT array_agg(DISTINCT id) INTO targets FROM (SELECT id FROM old_rows UNION SELECT id FROM new_rows) s WHERE id IS NOT NULL;
  END IF;
  IF targets IS NOT NULL THEN PERFORM refresh_player_directory_entries(targets); END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION mark_player_directory_geography() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE targets uuid[];
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT array_agg(DISTINCT p.id) INTO targets
    FROM player p
    JOIN (SELECT jsonb_array_elements_text(aliases::jsonb) AS alias FROM new_rows) a ON p.country=a.alias;
  ELSIF TG_OP='DELETE' THEN
    SELECT array_agg(DISTINCT p.id) INTO targets
    FROM player p
    JOIN (SELECT jsonb_array_elements_text(aliases::jsonb) AS alias FROM old_rows) a ON p.country=a.alias;
  ELSE
    SELECT array_agg(DISTINCT p.id) INTO targets
    FROM player p
    JOIN (
      SELECT jsonb_array_elements_text(aliases::jsonb) AS alias
      FROM (SELECT aliases FROM old_rows UNION SELECT aliases FROM new_rows) s
    ) a ON p.country=a.alias;
  END IF;
  IF targets IS NOT NULL THEN PERFORM refresh_player_directory_entries(targets); END IF;
  RETURN NULL;
END $$;

DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['player','player_rating'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS player_directory_entry_insert ON %I',target);
    EXECUTE format('CREATE TRIGGER player_directory_entry_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION mark_player_directory_entry()',target);
    EXECUTE format('DROP TRIGGER IF EXISTS player_directory_entry_update ON %I',target);
    EXECUTE format('CREATE TRIGGER player_directory_entry_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION mark_player_directory_entry()',target);
    EXECUTE format('DROP TRIGGER IF EXISTS player_directory_entry_delete ON %I',target);
    EXECUTE format('CREATE TRIGGER player_directory_entry_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION mark_player_directory_entry()',target);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS player_directory_entry_geography ON geography_country;
DROP TRIGGER IF EXISTS player_directory_entry_geography_insert ON geography_country;
CREATE TRIGGER player_directory_entry_geography_insert AFTER INSERT ON geography_country
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION mark_player_directory_geography();
DROP TRIGGER IF EXISTS player_directory_entry_geography_update ON geography_country;
CREATE TRIGGER player_directory_entry_geography_update AFTER UPDATE ON geography_country
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION mark_player_directory_geography();
DROP TRIGGER IF EXISTS player_directory_entry_geography_delete ON geography_country;
CREATE TRIGGER player_directory_entry_geography_delete AFTER DELETE ON geography_country
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION mark_player_directory_geography();

REVOKE ALL ON FUNCTION refresh_player_directory_entries(uuid[]),mark_player_directory_entry(),mark_player_directory_geography()
  FROM PUBLIC,anon,app_user;

SELECT refresh_player_directory_entries(array_agg(id)) FROM player;

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS player_directory_entry_rating_idx
  ON player_directory_entry (rating DESC NULLS LAST, name ASC, id ASC);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS player_directory_entry_name_idx
  ON player_directory_entry (name ASC, id ASC);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS player_directory_entry_slug_idx
  ON player_directory_entry (slug);
ANALYZE player_directory_entry;

CREATE OR REPLACE VIEW player_directory WITH (security_invoker=true) AS
SELECT d.id,d.name,d.full_name,d.birth,d.country,d.height,d.position,d.slug,
  d.rating,d.off_rating,d.def_rating,
  d.position_key,d.country_id,d.region_id,
  d.search_key,d.country_search_key,d.region_search_key,
  (d.latest_team).id AS latest_team_id,(d.latest_team).name AS latest_team_name,(d.latest_team).slug AS latest_team_slug,
  NULL::bigint AS txid,d.scope_id,
  (d.latest_team).logo_key AS latest_team_logo_key
FROM (
  SELECT e.id,e.name,e.full_name,e.birth,e.country,e.height,e.position,e.slug,
    e.rating,e.off_rating,e.def_rating,e.position_key,e.country_id,e.region_id,
    e.search_key,e.country_search_key,e.region_search_key,e.scope_id,
    (SELECT t FROM player_game a JOIN game g ON g.id=a.game_id
      JOIN team t ON t.id=CASE WHEN a.side='home' THEN g.home_id ELSE g.away_id END
      WHERE a.player_id=e.id AND g.played AND t.team_type='club'
      ORDER BY a.day DESC NULLS LAST,a.id ASC LIMIT 1) AS latest_team
  FROM player_directory_entry e
) d;

REVOKE ALL ON player_directory FROM PUBLIC,anon,app_user,service,electric;
GRANT SELECT ON player_directory TO app_user,service;

ALTER ROLE authenticator SET plan_cache_mode TO 'force_custom_plan';
NOTIFY pgrst,'reload config';
NOTIFY pgrst,'reload schema';
COMMIT;
