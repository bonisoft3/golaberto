SET lock_timeout = '5s';
SET statement_timeout = '60s';
BEGIN;

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_home_played_context_idx
  ON game (home_id,day DESC,kickoff DESC,id DESC) WHERE played;
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_away_played_context_idx
  ON game (away_id,day DESC,kickoff DESC,id DESC) WHERE played;
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_pair_played_context_idx
  ON game (least(home_id,away_id),greatest(home_id,away_id),day DESC,kickoff DESC,id DESC)
  WHERE played;

DO $$ DECLARE target text; alias record; occupied boolean; BEGIN
  FOREACH target IN ARRAY ARRAY['match_recent_result','match_head_to_head','match_lineup','match_location'] LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.'||target) AND relkind='r') THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)',target) INTO occupied;
      IF occupied THEN RAISE EXCEPTION 'match context placeholder % contains rows',target; END IF;
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

CREATE OR REPLACE VIEW match_recent_result WITH (security_invoker=true) AS
SELECT target.id::text||':'||side.team_id::text||':'||prior.id::text AS id,
  target.id AS target_game_id,side.team_id,side.side,prior.id AS game_id,prior.slug AS game_slug,
  prior.day,prior.day_display,prior.kickoff,prior.kickoff_local,
  prior.championship_id,prior.championship_name,prior.championship_slug,prior.show_country,
  prior.home_id,prior.home_name,prior.home_country,prior.home_slug,
  prior.away_id,prior.away_name,prior.away_country,prior.away_slug,
  prior.home_score,prior.away_score,prior.home_aet,prior.away_aet,prior.home_pen,prior.away_pen,
  CASE
    WHEN side.team_id=prior.home_id AND prior.home_score>prior.away_score THEN 'w'
    WHEN side.team_id=prior.away_id AND prior.away_score>prior.home_score THEN 'w'
    WHEN prior.home_score=prior.away_score THEN 'd'
    ELSE 'l'
  END AS result,
  NULL::bigint AS txid,'public:'::text AS scope_id
FROM game_archive target
CROSS JOIN LATERAL (
  VALUES ('home'::text,target.home_id),('away'::text,target.away_id)
) side(side,team_id)
CROSS JOIN LATERAL (
  SELECT history.* FROM game_archive history
  WHERE history.played AND history.day<target.day
    AND (history.home_id=side.team_id OR history.away_id=side.team_id)
  ORDER BY history.day DESC,history.kickoff DESC NULLS LAST,history.id DESC
  LIMIT 5
) prior;

CREATE OR REPLACE VIEW match_head_to_head WITH (security_invoker=true) AS
SELECT target.id::text||':'||prior.id::text AS id,target.id AS target_game_id,
  prior.id AS game_id,prior.slug AS game_slug,prior.day,prior.day_display,prior.kickoff,prior.kickoff_local,
  prior.championship_id,prior.championship_name,prior.championship_slug,prior.category_id,prior.show_country,
  prior.home_id,prior.home_name,prior.home_country,prior.home_slug,
  prior.away_id,prior.away_name,prior.away_country,prior.away_slug,
  prior.home_score,prior.away_score,prior.home_aet,prior.away_aet,prior.home_pen,prior.away_pen,
  NULL::bigint AS txid,'public:'::text AS scope_id,prior.home_logo_key,prior.away_logo_key
FROM game_archive target
CROSS JOIN LATERAL (
  SELECT history.* FROM game_archive history
  WHERE history.played AND history.day<target.day
    AND history.category_id IS NOT DISTINCT FROM target.category_id
    AND least(history.home_id,history.away_id)=least(target.home_id,target.away_id)
    AND greatest(history.home_id,history.away_id)=greatest(target.home_id,target.away_id)
  ORDER BY history.day DESC,history.kickoff DESC NULLS LAST,history.id DESC
  LIMIT 5
) prior;

CREATE OR REPLACE VIEW match_lineup WITH (security_invoker=true) AS
SELECT appearance.id,appearance.game_id,appearance.player_id,appearance.side,
  appearance.on_minute,appearance.off_minute,appearance.yellow,appearance.red,appearance.bench,
  player.name AS player_name,player.position,player.slug AS player_slug,
  appearance.off_rating,appearance.def_rating,
  coalesce(appearance.off_rating,0)+coalesce(appearance.def_rating,0) AS contribution,
  appearance.txid,appearance.scope_id
FROM player_game appearance JOIN player ON player.id=appearance.player_id;

CREATE OR REPLACE VIEW match_location WITH (security_invoker=true) AS
SELECT target.id,target.home_id,target.home_name,home.latitude AS home_latitude,home.longitude AS home_longitude,
  target.away_id,target.away_name,away.latitude AS away_latitude,away.longitude AS away_longitude,
  CASE WHEN home.latitude IS NOT NULL AND home.longitude IS NOT NULL
      AND away.latitude IS NOT NULL AND away.longitude IS NOT NULL
    THEN 12742*asin(sqrt(least(1,
      power(sin(radians((away.latitude-home.latitude)/2)),2)
      +cos(radians(home.latitude))*cos(radians(away.latitude))
       *power(sin(radians((away.longitude-home.longitude)/2)),2))))
  END::double precision AS distance_km,
  CASE WHEN home.latitude IS NOT NULL AND home.longitude IS NOT NULL
      AND away.latitude IS NOT NULL AND away.longitude IS NOT NULL
    THEN 'https://www.openstreetmap.org/export/embed.html?bbox='
      ||greatest(-180,least(home.longitude,away.longitude)-greatest(abs(home.longitude-away.longitude)*0.15,0.05))::text||'%2C'
      ||greatest(-85,least(home.latitude,away.latitude)-greatest(abs(home.latitude-away.latitude)*0.15,0.05))::text||'%2C'
      ||least(180,greatest(home.longitude,away.longitude)+greatest(abs(home.longitude-away.longitude)*0.15,0.05))::text||'%2C'
      ||least(85,greatest(home.latitude,away.latitude)+greatest(abs(home.latitude-away.latitude)*0.15,0.05))::text
      ||'&layer=mapnik'
  END AS map_embed_url,
  NULL::bigint AS txid,'public:'::text AS scope_id
FROM game_archive target
JOIN team home ON home.id=target.home_id JOIN team away ON away.id=target.away_id;

REVOKE ALL ON match_recent_result,match_head_to_head,match_lineup,match_location
  FROM PUBLIC,anon,app_user,service,electric;
GRANT SELECT ON match_recent_result,match_head_to_head,match_lineup,match_location
  TO app_user,service;

NOTIFY pgrst,'reload schema';
COMMIT;
