-- Bound the indexed date before the exact instant comparison: an unrated
-- historical match must not scan every newer rating for either team.
BEGIN;
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE OR REPLACE VIEW match_probability WITH (security_invoker=true) AS
WITH selected AS (
  SELECT game.id,home_team.name AS home_name,away_team.name AS away_name,
    home.measure_date AS home_measure_date,away.measure_date AS away_measure_date,
    home.row_count AS home_rating_count,away.row_count AS away_rating_count,
    home.offense AS home_offense,home.defense AS home_defense,
    away.offense AS away_offense,away.defense AS away_defense,
    goals.row_count AS goal_count,goals.unknown_count AS unknown_goal_count,goals.events AS goals,
    reds.row_count AS red_count,reds.unknown_count AS unknown_red_count,reds.events AS red_cards,
    CASE game.home_field WHEN 'left' THEN 0.16133676871779334::double precision
      WHEN 'neutral' THEN 0::double precision ELSE -0.16133676871779334::double precision END AS advantage
  FROM game
  JOIN team home_team ON home_team.id=game.home_id
  JOIN team away_team ON away_team.id=game.away_id
  CROSS JOIN LATERAL (
    SELECT (coalesce(game.kickoff,game.day::timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date AS day
    -- Keep the non-leakproof UTC conversion outside the RLS-protected scan.
    OFFSET 0
  ) rating_cutoff
  LEFT JOIN LATERAL (
    SELECT candidate.measure_date,count(*)::integer AS row_count,
      min(candidate.offense)::double precision AS offense,min(candidate.defense)::double precision AS defense
    FROM team_rating candidate
    WHERE candidate.team_id=game.home_id
      AND candidate.measure_date=(
        SELECT max(history.measure_date) FROM team_rating history
        WHERE history.team_id=game.home_id
          AND history.measure_date <= rating_cutoff.day
          AND history.measure_date::timestamp AT TIME ZONE 'UTC'
            <coalesce(game.kickoff,game.day::timestamp AT TIME ZONE 'UTC'))
    GROUP BY candidate.measure_date
  ) home ON true
  LEFT JOIN LATERAL (
    SELECT candidate.measure_date,count(*)::integer AS row_count,
      min(candidate.offense)::double precision AS offense,min(candidate.defense)::double precision AS defense
    FROM team_rating candidate
    WHERE candidate.team_id=game.away_id
      AND candidate.measure_date=(
        SELECT max(history.measure_date) FROM team_rating history
        WHERE history.team_id=game.away_id
          AND history.measure_date <= rating_cutoff.day
          AND history.measure_date::timestamp AT TIME ZONE 'UTC'
            <coalesce(game.kickoff,game.day::timestamp AT TIME ZONE 'UTC'))
    GROUP BY candidate.measure_date
  ) away ON true
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS row_count,
      count(*) FILTER (WHERE event.minute IS NULL)::integer AS unknown_count,
      coalesce(jsonb_agg(jsonb_build_object('side',event.side,'minute',event.minute)
        ORDER BY event.minute NULLS LAST,event.id) FILTER (WHERE event.minute IS NOT NULL),'[]'::jsonb) AS events
    FROM (SELECT source.id,source.side,source.minute FROM goal source
      WHERE source.game_id=game.id ORDER BY source.minute NULLS LAST,source.id LIMIT 101) event
  ) goals
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS row_count,
      count(*) FILTER (WHERE event.minute IS NULL OR event.minute=0)::integer AS unknown_count,
      coalesce(jsonb_agg(jsonb_build_object('side',event.side,'minute',event.minute)
        ORDER BY event.minute NULLS LAST,event.id) FILTER (WHERE event.minute>0),'[]'::jsonb) AS events
    FROM (SELECT source.id,source.side,source.off_minute AS minute FROM player_game source
      WHERE source.game_id=game.id AND source.red ORDER BY source.off_minute NULLS LAST,source.id LIMIT 101) event
  ) reds
), rated AS (
  SELECT selected.*,
    CASE WHEN coalesce(home_rating_count,0)>1 OR coalesce(away_rating_count,0)>1 THEN 'ambiguous-rating'
      WHEN home_measure_date IS NULL OR away_measure_date IS NULL THEN 'missing-rating'
      ELSE 'available' END AS rating_status,
    CASE WHEN home_measure_date IS NULL OR away_measure_date IS NULL
        OR coalesce(home_rating_count,0)<>1 OR coalesce(away_rating_count,0)<>1 THEN NULL
      ELSE match_probability_power(home_offense,away_defense+advantage) END AS home_power,
    CASE WHEN home_measure_date IS NULL OR away_measure_date IS NULL
        OR coalesce(home_rating_count,0)<>1 OR coalesce(away_rating_count,0)<>1 THEN NULL
      ELSE match_probability_power(away_offense,home_defense-advantage) END AS away_power
  FROM selected
), available AS (
  SELECT rated.*,
    CASE WHEN rating_status<>'available' THEN rating_status
      WHEN goal_count>100 OR red_count>100 THEN 'event-limit'
      WHEN unknown_goal_count>0 OR unknown_red_count>0 THEN 'unknown-event-minute'
      ELSE 'available' END AS timeline_status
  FROM rated
)
SELECT id,id AS game_id,home_name,away_name,rating_status,timeline_status,
  jsonb_build_object(
    'home_power',home_power,'away_power',away_power,
    'home_measure_date',home_measure_date,'away_measure_date',away_measure_date,
    'rating_status',rating_status,'timeline_status',timeline_status,
    'goals',CASE WHEN timeline_status='available' THEN goals END,
    'red_cards',CASE WHEN timeline_status='available' THEN red_cards END
  )::text AS payload_json,
  NULL::bigint AS txid,'public:'::text AS scope_id
FROM available;

NOTIFY pgrst,'reload schema';
COMMIT;
