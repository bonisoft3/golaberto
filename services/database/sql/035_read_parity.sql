SET lock_timeout = '5s';
SET statement_timeout = '60s';
BEGIN;

ALTER TABLE team ADD COLUMN IF NOT EXISTS logo_key text;

ALTER TABLE player_rating ADD COLUMN IF NOT EXISTS off_rating double precision;
ALTER TABLE player_rating ADD COLUMN IF NOT EXISTS def_rating double precision;

-- squawk-ignore adding-field-with-default
ALTER TABLE player_stat ADD COLUMN IF NOT EXISTS search_key text COLLATE golaberto_search NOT NULL DEFAULT '';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='player_stat'::regclass AND attname='search_key'
      AND attcollation<>'golaberto_search'::regcollation) THEN
    ALTER TABLE player_stat ALTER COLUMN search_key TYPE text COLLATE golaberto_search;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION player_stat_search_key(player_name text,team_name text,championship_name text,
  player_position text,full_name text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT replace(replace(replace(player_name||' '||team_name||' '||championship_name||' '||player_position||' '||coalesce(full_name,''),
    'ı','i'),'þ','th'),'Þ','th');
$$;
CREATE OR REPLACE FUNCTION stamp_player_stat_search_key() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE full_name text;
BEGIN
  SELECT p.name,p.full_name,coalesce(p.position,'') INTO NEW.player_name,full_name,NEW.position
  FROM player p WHERE p.id=NEW.player_id;
  SELECT t.name INTO NEW.team_name FROM team t WHERE t.id=NEW.team_id;
  SELECT c.full_name INTO NEW.championship_name FROM championship c WHERE c.id=NEW.championship_id;
  NEW.search_key:=player_stat_search_key(NEW.player_name,NEW.team_name,NEW.championship_name,NEW.position,full_name);
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION sync_player_stat_search_key_from_player() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE player_stat SET player_name=NEW.name WHERE player_id=NEW.id;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION sync_player_stat_names_from_parent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='team' THEN
    UPDATE player_stat SET team_name=NEW.name WHERE team_id=NEW.id;
  ELSE
    UPDATE player_stat SET championship_name=NEW.full_name WHERE championship_id=NEW.id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS player_stat_search_key_stamp ON player_stat;
CREATE TRIGGER player_stat_search_key_stamp BEFORE INSERT OR UPDATE OF player_name,team_name,championship_name,position,player_id,team_id,championship_id
  ON player_stat FOR EACH ROW EXECUTE FUNCTION stamp_player_stat_search_key();
DROP TRIGGER IF EXISTS player_stat_search_key_player_update ON player;
CREATE TRIGGER player_stat_search_key_player_update AFTER UPDATE OF name,full_name,position ON player FOR EACH ROW
  WHEN ((OLD.name,OLD.full_name,OLD.position) IS DISTINCT FROM (NEW.name,NEW.full_name,NEW.position)) EXECUTE FUNCTION sync_player_stat_search_key_from_player();
DROP TRIGGER IF EXISTS player_stat_team_name_update ON team;
CREATE TRIGGER player_stat_team_name_update AFTER UPDATE OF name ON team FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name) EXECUTE FUNCTION sync_player_stat_names_from_parent();
DROP TRIGGER IF EXISTS player_stat_championship_name_update ON championship;
CREATE TRIGGER player_stat_championship_name_update AFTER UPDATE ON championship FOR EACH ROW
  WHEN (OLD.full_name IS DISTINCT FROM NEW.full_name) EXECUTE FUNCTION sync_player_stat_names_from_parent();
REVOKE ALL ON FUNCTION player_stat_search_key(text,text,text,text,text),stamp_player_stat_search_key(),
  sync_player_stat_search_key_from_player(),sync_player_stat_names_from_parent() FROM PUBLIC,anon,app_user;

-- Search spelling is not projected into team profiles; key-only changes must
-- invalidate the live statistic without rebuilding its unrelated profile.
DROP TRIGGER IF EXISTS team_profile_dirty_player_stat_update ON player_stat;
CREATE TRIGGER team_profile_dirty_player_stat_update AFTER UPDATE ON player_stat FOR EACH ROW
  WHEN ((to_jsonb(OLD)-ARRAY['off_rating','def_rating','contribution','contribution_per90','goals_per90','txid','search_key'])
    IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['off_rating','def_rating','contribution','contribution_per90','goals_per90','txid','search_key']))
  EXECUTE FUNCTION mark_team_profile_dirty();

UPDATE player_stat s SET player_name=p.name
FROM player p,team t,championship c WHERE p.id=s.player_id AND t.id=s.team_id AND c.id=s.championship_id
  AND (s.player_name,s.team_name,s.championship_name,s.position,s.search_key) IS DISTINCT FROM
    (p.name,t.name,c.full_name,coalesce(p.position,''),
      player_stat_search_key(p.name,t.name,c.full_name,coalesce(p.position,''),p.full_name));

-- Generated baselines declare entities as tables before installing their views.
DO $$ DECLARE target text; alias record; occupied boolean; BEGIN
  FOREACH target IN ARRAY ARRAY['phase_directory','player_directory','game_archive','player_appearance','championship_attendance'] LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.'||target) AND relkind='r') THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)',target) INTO occupied;
      IF occupied THEN RAISE EXCEPTION 'read view placeholder % contains rows',target; END IF;
      IF to_regclass('pgroll.migrations') IS NOT NULL THEN
        FOR alias IN SELECT n.nspname,c.relname FROM pg_class c
          JOIN pg_namespace n ON n.oid=c.relnamespace
          JOIN pgroll.migrations m ON n.nspname=m.schema||'_'||m.name
          WHERE m.schema='public' AND c.relname=target AND c.relkind='v'
        LOOP EXECUTE format('DROP VIEW %I.%I',alias.nspname,alias.relname); END LOOP;
      END IF;
      EXECUTE format('DROP TABLE %I',target);
    END IF;
  END LOOP;
END $$;

-- Composite predicates select the season or scorer before counting rows.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS player_stat_championship_read_idx
  ON player_stat (championship_id, minutes DESC, player_id, team_id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS goal_player_game_read_idx ON goal (player_id, game_id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS player_game_latest_read_idx
  ON player_game (player_id, day DESC NULLS LAST, id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_phase_round_read_idx ON game (phase_id, round, day, id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_played_day_read_idx ON game (played, day, id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_week_read_idx
  ON game ((day-(extract(isodow FROM day)::integer-1)), played, day, id);

-- Target-list lookups run after the caller's sort and LIMIT, rather than once
-- for every player considered by the directory ranking.
CREATE OR REPLACE VIEW player_directory WITH (security_invoker=true) AS
SELECT d.id,d.name,d.full_name,d.birth,d.country,d.height,d.position,d.slug,
  d.rating,d.off_rating,d.def_rating,
  coalesce(d.position,'') AS position_key,
  coalesce(d.country_id,'') AS country_id,coalesce(d.region_id,'') AS region_id,
  replace(replace(replace(d.name||' '||coalesce(d.full_name,''),'ı','i'),'þ','th'),'Þ','th')
    COLLATE golaberto_search AS search_key,
  coalesce(d.country_search_key,d.country,'') COLLATE golaberto_search AS country_search_key,
  coalesce(d.region_search_key,'') COLLATE golaberto_search AS region_search_key,
  (d.latest_team).id AS latest_team_id,(d.latest_team).name AS latest_team_name,(d.latest_team).slug AS latest_team_slug,
  NULL::bigint AS txid,'public:'::text AS scope_id,
  (d.latest_team).logo_key AS latest_team_logo_key
FROM (
  SELECT p.id,p.name,p.full_name,p.birth,p.country,p.height,p.position,p.slug,
    r.rating,r.off_rating,r.def_rating,c.id AS country_id,c.region_id,
    c.search_key AS country_search_key,c.region_search_key,
    (SELECT t FROM player_game a JOIN game g ON g.id=a.game_id
      JOIN team t ON t.id=CASE WHEN a.side='home' THEN g.home_id ELSE g.away_id END
      WHERE a.player_id=p.id AND g.played AND t.team_type='club'
      ORDER BY a.day DESC NULLS LAST,a.id ASC LIMIT 1) AS latest_team
  FROM player p LEFT JOIN player_rating r ON r.id=p.id
  LEFT JOIN (
    SELECT c.id,c.region_id,c.search_key,c.region_search_key,a.value AS country_alias
    FROM geography_country c CROSS JOIN LATERAL (
      SELECT DISTINCT value FROM jsonb_array_elements_text(c.aliases::jsonb) alias(value)
    ) a
  ) c ON c.country_alias=p.country
) d;

CREATE OR REPLACE VIEW phase_directory WITH (security_invoker=true) AS
SELECT p.id,p.name,p.championship_id,c.full_name AS championship_name,
  replace(replace(replace(c.full_name||' '||p.name,'ı','i'),'þ','th'),'Þ','th')
    COLLATE golaberto_search AS search_key,
  NULL::bigint AS txid,'public:'::text AS scope_id
FROM phase p JOIN championship c ON c.id=p.championship_id;

CREATE OR REPLACE VIEW game_archive WITH (security_invoker=true) AS
SELECT g.*,p.championship_id,c.full_name AS championship_name,c.slug AS championship_slug,
  p.name AS phase_name,c.category_id,coalesce(c.category_id::text,'professional') AS category_key,
  p.id::text AS phase_key,coalesce(g.round::text,'') AS round_key,
  (g.day-(extract(isodow FROM g.day)::integer-1)) AS week,
  (g.day-(extract(isodow FROM g.day)::integer-1))::text AS week_key,
  c.show_country,h.name AS home_name,a.name AS away_name,h.country AS home_country,a.country AS away_country,
  h.slug AS home_slug,a.slug AS away_slug,s.name AS stadium_name,r.name AS referee_name,
  h.logo_key AS home_logo_key,a.logo_key AS away_logo_key
FROM game g JOIN phase p ON p.id=g.phase_id JOIN championship c ON c.id=p.championship_id
JOIN team h ON h.id=g.home_id JOIN team a ON a.id=g.away_id
LEFT JOIN stadium s ON s.id=g.stadium_id LEFT JOIN referee r ON r.id=g.referee_id;

CREATE OR REPLACE VIEW player_appearance WITH (security_invoker=true) AS
SELECT a.id,a.player_id,a.game_id,a.side,a.on_minute,a.off_minute,a.yellow,a.red,a.bench,
  g.day,g.day_display,g.kickoff,g.kickoff_local,g.played,g.played::text AS played_key,g.slug AS game_slug,
  g.phase_id,g.phase_name,g.championship_id,g.championship_name,g.championship_slug,
  g.category_id,g.category_key,g.round,g.round_key,g.week,g.week_key,
  CASE WHEN a.side='home' THEN g.home_id ELSE g.away_id END AS team_id,
  CASE WHEN a.side='home' THEN g.home_name ELSE g.away_name END AS team_name,
  CASE WHEN a.side='home' THEN g.home_slug ELSE g.away_slug END AS team_slug,
  g.home_id,g.away_id,g.home_name,g.away_name,g.home_country,g.away_country,g.show_country,
  g.home_score,g.away_score,g.home_aet,g.away_aet,g.home_pen,g.away_pen,
  duration.minutes,a.off_rating,a.def_rating,metric.contribution,
  CASE WHEN duration.minutes>0 THEN metric.contribution*90/duration.minutes END AS contribution_per90,
  scored.goals,scored.penalties,scored.own_goals,
  CASE WHEN duration.minutes>0 THEN scored.goals*90.0/duration.minutes END::double precision AS goals_per90,
  NULL::bigint AS txid,'public:'::text AS scope_id,
  g.home_logo_key,g.away_logo_key
FROM player_game a JOIN game_archive g ON g.id=a.game_id
CROSS JOIN LATERAL (SELECT CASE WHEN NOT g.played OR a.bench THEN 0
  ELSE greatest(0,coalesce(a.off_minute,greatest(a.on_minute,90))-a.on_minute) END AS minutes) duration
CROSS JOIN LATERAL (SELECT CASE WHEN a.off_rating IS NOT NULL OR a.def_rating IS NOT NULL
  THEN coalesce(a.off_rating,0)+coalesce(a.def_rating,0) END AS contribution) metric
CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE NOT own_goal)::integer AS goals,
    count(*) FILTER (WHERE penalty AND NOT own_goal)::integer AS penalties,
    count(*) FILTER (WHERE own_goal)::integer AS own_goals
  FROM goal WHERE player_id=a.player_id AND game_id=a.game_id
) scored;

-- Preserve the championship predicate outside the grouped attendance scan.
CREATE OR REPLACE VIEW championship_attendance WITH (security_invoker=true) AS
SELECT c.id::text||':'||crowd.team_id::text AS id,c.id AS championship_id,
  crowd.team_id,t.name AS team_name,t.slug AS team_slug,crowd.games,crowd.attendance_count,
  crowd.total,crowd.average,crowd.minimum,crowd.maximum,
  NULL::bigint AS txid,'public:'::text AS scope_id,t.logo_key AS team_logo_key
FROM championship c CROSS JOIN LATERAL (
  SELECT g.home_id AS team_id,count(*)::integer AS games,count(g.attendance)::integer AS attendance_count,
    coalesce(sum(g.attendance),0)::bigint AS total,avg(g.attendance)::double precision AS average,
    min(g.attendance) AS minimum,max(g.attendance) AS maximum
  FROM phase p JOIN game g ON g.phase_id=p.id
  WHERE p.championship_id=c.id GROUP BY g.home_id
) crowd JOIN team t ON t.id=crowd.team_id;

REVOKE ALL ON phase_directory,player_directory,game_archive,player_appearance,championship_attendance
  FROM PUBLIC,anon,app_user,service,electric;
GRANT SELECT ON phase_directory,player_directory,game_archive,player_appearance,championship_attendance
  TO app_user,service;

ALTER ROLE CURRENT_USER SET pgrst.db_aggregates_enabled TO 'true';
NOTIFY pgrst,'reload config';
NOTIFY pgrst,'reload schema';
COMMIT;
