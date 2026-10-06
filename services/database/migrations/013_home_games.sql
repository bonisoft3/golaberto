-- Rolling homepage selection, shared by the clock-driven stream and its tests.
SET lock_timeout = '5s';
SET statement_timeout = '60s';
BEGIN;

-- Existing volumes evolve too; fresh volumes already have these columns.
ALTER TABLE game_card ADD COLUMN IF NOT EXISTS home_upcoming_rank integer NOT NULL DEFAULT 0
  CHECK (home_upcoming_rank BETWEEN 0 AND 20);
ALTER TABLE game_card ADD COLUMN IF NOT EXISTS home_recent_rank integer NOT NULL DEFAULT 0
  CHECK (home_recent_rank BETWEEN 0 AND 20);

CREATE OR REPLACE FUNCTION home_game_order(at_time timestamptz)
RETURNS TABLE (game_id uuid, is_played boolean, feed_rank integer)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH ratings AS (
    SELECT DISTINCT ON (team_id) team_id, rating
    FROM team_rating
    WHERE measure_date <= (at_time AT TIME ZONE 'America/Sao_Paulo')::date
    ORDER BY team_id, measure_date DESC, id
  ), candidates AS (
    SELECT g.id, g.played, g.phase_id, g.kickoff,
      (g.kickoff AT TIME ZONE 'America/Sao_Paulo')::date AS local_day,
      COALESCE(2.0 * h.rating * a.rating / NULLIF(h.rating + a.rating, 0), 0)
        * (1 + (COALESCE(i.home, 0) + COALESCE(i.away, 0)) / 2.0)
        / power(2.0, abs(extract(epoch FROM (g.kickoff - at_time))) / 86400.0) AS quality
    FROM game_card g
    LEFT JOIN ratings h ON h.team_id = g.home_id
    LEFT JOIN ratings a ON a.team_id = g.away_id
    LEFT JOIN game_importance i ON i.id = g.id
    WHERE (NOT g.played AND g.kickoff > at_time AND g.kickoff < at_time + interval '7 days')
       OR (g.played AND g.kickoff < at_time AND g.kickoff > at_time - interval '7 days')
  ), ranked AS (
    SELECT *, row_number() OVER (PARTITION BY played ORDER BY quality DESC, kickoff DESC, id) AS pick,
      max(quality) OVER (PARTITION BY played, phase_id, local_day) AS phase_quality
    FROM candidates
  )
  SELECT id, played, row_number() OVER (PARTITION BY played ORDER BY
    CASE WHEN NOT played THEN local_day END ASC,
    CASE WHEN played THEN local_day END DESC,
    phase_quality DESC, phase_id,
    CASE WHEN NOT played THEN kickoff END ASC,
    CASE WHEN played THEN kickoff END DESC, quality DESC, id)::integer
  FROM ranked WHERE pick <= 20;
$$;

CREATE OR REPLACE FUNCTION refresh_home_games() RETURNS void
LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH selected AS (SELECT * FROM home_game_order(now())), ranks AS (
    SELECT g.id,
      COALESCE(s.feed_rank, 0) * CASE WHEN NOT g.played THEN 1 ELSE 0 END AS upcoming,
      COALESCE(s.feed_rank, 0) * CASE WHEN g.played THEN 1 ELSE 0 END AS recent
    FROM game_card g LEFT JOIN selected s ON s.game_id = g.id
  )
  UPDATE game_card g SET home_upcoming_rank = r.upcoming, home_recent_rank = r.recent
  FROM ranks r WHERE g.id = r.id
    AND (g.home_upcoming_rank, g.home_recent_rank) IS DISTINCT FROM (r.upcoming, r.recent);
$$;

REVOKE ALL ON FUNCTION home_game_order(timestamptz), refresh_home_games() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION home_game_order(timestamptz), refresh_home_games() TO service;
NOTIFY pgrst, 'reload schema';
COMMIT;
