BEGIN;
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE team_game ADD COLUMN IF NOT EXISTS fixture_available boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION stamp_team_game_availability() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  SELECT g.played OR coalesce(g.sync_status, 'scheduled') NOT IN ('cancelled', 'abandoned', 'awarded')
    INTO STRICT NEW.fixture_available FROM game g WHERE g.id=NEW.game_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS team_game_availability ON team_game;
CREATE TRIGGER team_game_availability BEFORE INSERT OR UPDATE OF game_id ON team_game
  FOR EACH ROW EXECUTE FUNCTION stamp_team_game_availability();

CREATE OR REPLACE FUNCTION sync_game_availability() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE available boolean;
BEGIN
  available := NEW.played OR coalesce(NEW.sync_status, 'scheduled') NOT IN ('cancelled', 'abandoned', 'awarded');
  UPDATE team_game SET fixture_available=available
    WHERE game_id=NEW.id AND fixture_available IS DISTINCT FROM available;
  IF NOT available THEN
    DELETE FROM matches_game_card WHERE id=NEW.id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS game_availability ON game;
CREATE TRIGGER game_availability AFTER UPDATE OF sync_status,played ON game
  FOR EACH ROW EXECUTE FUNCTION sync_game_availability();
UPDATE team_game t SET fixture_available=false FROM game g
  WHERE t.game_id=g.id AND NOT g.played AND g.sync_status IN ('cancelled', 'abandoned', 'awarded') AND t.fixture_available;

CREATE OR REPLACE FUNCTION home_game_selection(at_time timestamptz)
RETURNS TABLE (game_id uuid, is_played boolean, feed_rank integer, highlighted boolean)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH reference AS (
    SELECT at_time - interval '3 hours' AS kickoff_reference
  ), candidates AS MATERIALIZED (
    SELECT g.id, g.played, g.phase_id, g.kickoff, g.home_id, g.away_id,
      (g.kickoff AT TIME ZONE 'America/Sao_Paulo')::date AS local_day
    FROM game_card g JOIN game source_game ON source_game.id = g.id CROSS JOIN reference r
    WHERE g.kickoff > r.kickoff_reference - interval '14 days' AND g.kickoff < at_time + interval '14 days' AND (
      (NOT g.played AND coalesce(source_game.sync_status, 'scheduled') NOT IN ('cancelled', 'abandoned', 'awarded') AND g.kickoff > r.kickoff_reference
        AND g.kickoff < at_time + interval '14 days')
      OR (g.played AND g.kickoff > r.kickoff_reference - interval '14 days'
        AND g.kickoff < r.kickoff_reference + interval '14 days')
    )
  ), quality AS (
    SELECT g.id, g.played, g.phase_id, g.kickoff, g.local_day,
      COALESCE(2.0 * r.home * r.away / NULLIF(r.home + r.away, 0), 0)
        * (1 + (COALESCE(i.home, 0) + COALESCE(i.away, 0)) / 2.0) AS raw_quality,
      COALESCE(2.0 * r.home * r.away / NULLIF(r.home + r.away, 0), 0)
        * (1 + (COALESCE(i.home, 0) + COALESCE(i.away, 0)) / 2.0)
        / power(2.0, abs(extract(epoch FROM (g.kickoff - (at_time - interval '3 hours'))) / 86400.0)) AS weighted_quality
    FROM candidates g
    LEFT JOIN team_latest_rating hl ON hl.team_id = g.home_id
    LEFT JOIN team_latest_rating al ON al.team_id = g.away_id
    CROSS JOIN LATERAL (SELECT
      CASE WHEN hl.measure_date <= (at_time AT TIME ZONE 'America/Sao_Paulo')::date THEN hl.rating WHEN hl.team_id IS NOT NULL THEN
        (SELECT rating FROM team_rating WHERE team_id = g.home_id AND measure_date <= (at_time AT TIME ZONE 'America/Sao_Paulo')::date
          ORDER BY measure_date DESC, id LIMIT 1) END AS home,
      CASE WHEN al.measure_date <= (at_time AT TIME ZONE 'America/Sao_Paulo')::date THEN al.rating WHEN al.team_id IS NOT NULL THEN
        (SELECT rating FROM team_rating WHERE team_id = g.away_id AND measure_date <= (at_time AT TIME ZONE 'America/Sao_Paulo')::date
          ORDER BY measure_date DESC, id LIMIT 1) END AS away) r
    LEFT JOIN game_importance i ON i.id = g.id
  ), ranked AS (
    SELECT *, row_number() OVER (PARTITION BY played
      ORDER BY weighted_quality DESC, raw_quality DESC, kickoff DESC, id) AS pick,
      max(weighted_quality) OVER (PARTITION BY played, phase_id, local_day) AS phase_day_quality
    FROM quality
  ), phase_day_winners AS (
    SELECT DISTINCT ON (played, phase_id, local_day) id
    FROM quality
    ORDER BY played, phase_id, local_day,
      weighted_quality DESC, raw_quality ASC, kickoff ASC, id DESC
  ), presentation AS (
    SELECT p.*,
      row_number() OVER (PARTITION BY played ORDER BY
        CASE WHEN NOT played THEN local_day END ASC,
        CASE WHEN played THEN local_day END DESC,
        phase_day_quality DESC,
        CASE WHEN NOT played THEN kickoff END ASC,
        CASE WHEN played THEN kickoff END DESC,
        weighted_quality DESC, id)::integer AS feed_rank
    FROM ranked p WHERE pick <= 20
  ), highlighted AS (
    SELECT p.id, p.played, p.feed_rank,
      (p.raw_pick <= 5 OR w.id IS NOT NULL) AS highlighted
    FROM (
      SELECT presentation.*, row_number() OVER (PARTITION BY played ORDER BY raw_quality DESC, feed_rank) AS raw_pick
      FROM presentation
    ) p
    LEFT JOIN phase_day_winners w ON w.id = p.id
  )
  SELECT id, played, feed_rank, highlighted FROM highlighted;
$$;

CREATE OR REPLACE FUNCTION refresh_matches_games() RETURNS void
-- PostgREST hoists this timeout before executing the RPC.
LANGUAGE plpgsql SET search_path = public, pg_temp
SET statement_timeout = '20s' SET lock_timeout = '2s' AS $$
DECLARE
  upcoming_ids uuid[];
  result_ids uuid[];
  selected_ids uuid[];
  affected_ids uuid[];
  target_id uuid;
BEGIN
  IF NOT pg_try_advisory_xact_lock(715016, 1) THEN RETURN; END IF;
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO upcoming_ids FROM (
    SELECT c.id FROM game_card c JOIN game g ON g.id=c.id WHERE NOT c.played AND c.kickoff IS NOT NULL
      AND coalesce(g.sync_status, 'scheduled') NOT IN ('cancelled', 'abandoned', 'awarded')
    ORDER BY c.kickoff ASC NULLS LAST, c.id ASC LIMIT 40
  ) upcoming;
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO result_ids FROM (
    SELECT id FROM game_card WHERE played
    ORDER BY day DESC NULLS FIRST, kickoff DESC NULLS FIRST, id ASC LIMIT 40
  ) results;
  selected_ids := upcoming_ids || result_ids;

  -- At most eighty old plus eighty selected IDs. Ordered point locks serialize
  -- copies with source writes, without locking or rewriting the archive.
  SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO affected_ids
  FROM (SELECT unnest(selected_ids) AS id UNION SELECT id FROM matches_game_card) affected;
  FOREACH target_id IN ARRAY affected_ids LOOP
    PERFORM 1 FROM game_card WHERE id = target_id FOR UPDATE;
  END LOOP;

  -- A source edit may have committed after selection but before its lock.
  -- Recheck its feed to avoid copying an extra result or an unknown fixture.
  SELECT COALESCE(array_agg(DISTINCT g.id), ARRAY[]::uuid[]) INTO selected_ids
  FROM unnest(selected_ids) selected(id) JOIN game_card g USING (id) JOIN game source_game ON source_game.id=g.id
  WHERE (g.id = ANY(upcoming_ids) AND NOT g.played AND g.kickoff IS NOT NULL
       AND coalesce(source_game.sync_status, 'scheduled') NOT IN ('cancelled', 'abandoned', 'awarded'))
     OR (g.id = ANY(result_ids) AND g.played);
  DELETE FROM matches_game_card WHERE NOT (id = ANY(selected_ids));
  PERFORM copy_matches_game_cards(selected_ids);
END $$;

CREATE OR REPLACE VIEW matches_start WITH (security_invoker=true) AS
SELECT '00000000-0000-0000-0000-000000000000'::uuid AS id,
  n AS start_offset,n+40 AS start_next_offset,(n+39)/40+1 AS start_page,
  NULL::bigint AS txid,'public:'::text AS scope_id
FROM (
  SELECT count(*)::integer AS n FROM game
  WHERE played IS FALSE AND coalesce(sync_status, 'scheduled') NOT IN ('cancelled', 'abandoned', 'awarded')
    AND kickoff IS NOT NULL AND day < (now() AT TIME ZONE 'America/Sao_Paulo')::date-7
) origin;

REVOKE ALL ON FUNCTION stamp_team_game_availability(), sync_game_availability() FROM PUBLIC;
NOTIFY pgrst, 'reload schema';
COMMIT;
