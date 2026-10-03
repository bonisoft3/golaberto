-- One heading per championship in each selected homepage feed.
SET lock_timeout = '5s';
SET statement_timeout = '60s';
BEGIN;

ALTER TABLE game_card ADD COLUMN IF NOT EXISTS home_upcoming_group portable_bool NOT NULL DEFAULT false;
ALTER TABLE game_card ADD COLUMN IF NOT EXISTS home_recent_group portable_bool NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION refresh_home_games() RETURNS void
LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH selected AS (
    SELECT s.*, min(s.feed_rank) OVER (PARTITION BY s.is_played, g.championship_id) AS group_rank
    FROM home_game_order(now()) s JOIN game_card g ON g.id = s.game_id
  ), ranks AS (
    SELECT g.id,
      COALESCE(s.feed_rank, 0) * CASE WHEN NOT g.played THEN 1 ELSE 0 END AS upcoming,
      COALESCE(s.feed_rank, 0) * CASE WHEN g.played THEN 1 ELSE 0 END AS recent,
      COALESCE(NOT g.played AND s.feed_rank = s.group_rank, false) AS upcoming_group,
      COALESCE(g.played AND s.feed_rank = s.group_rank, false) AS recent_group
    FROM game_card g LEFT JOIN selected s ON s.game_id = g.id
  )
  UPDATE game_card g SET home_upcoming_rank = r.upcoming, home_recent_rank = r.recent,
    home_upcoming_group = r.upcoming_group, home_recent_group = r.recent_group
  FROM ranks r WHERE g.id = r.id
    AND (g.home_upcoming_rank, g.home_recent_rank, g.home_upcoming_group, g.home_recent_group)
      IS DISTINCT FROM (r.upcoming, r.recent, r.upcoming_group, r.recent_group);
$$;

REVOKE ALL ON FUNCTION refresh_home_games() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_home_games() TO service;
NOTIFY pgrst, 'reload schema';
COMMIT;
