-- Select homepage highlights and refresh their destination-owned projection flag.
SET lock_timeout = '5s';
SET statement_timeout = '1min';
BEGIN;

ALTER TABLE home_game_card ADD COLUMN IF NOT EXISTS home_highlighted boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION home_game_selection(at_time timestamptz)
RETURNS TABLE (game_id uuid, is_played boolean, feed_rank integer, highlighted boolean)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH reference AS (
    SELECT at_time - interval '3 hours' AS kickoff_reference
  ), candidates AS MATERIALIZED (
    SELECT g.id, g.played, g.phase_id, g.kickoff, g.home_id, g.away_id,
      (g.kickoff AT TIME ZONE 'America/Sao_Paulo')::date AS local_day
    FROM game_card g CROSS JOIN reference r
    WHERE g.kickoff IS NOT NULL AND (
      (NOT g.played AND g.kickoff > r.kickoff_reference
        AND g.kickoff < at_time + interval '14 days')
      OR (g.played AND g.kickoff > r.kickoff_reference - interval '14 days'
        AND g.kickoff < r.kickoff_reference + interval '14 days')
    )
  ), teams AS (
    SELECT home_id AS team_id FROM candidates UNION SELECT away_id FROM candidates
  ), ratings AS MATERIALIZED (
    SELECT t.team_id, r.rating
    FROM teams t LEFT JOIN LATERAL (
      SELECT rating FROM team_rating
      WHERE team_id = t.team_id
        AND measure_date <= (at_time AT TIME ZONE 'America/Sao_Paulo')::date
      ORDER BY measure_date DESC, id LIMIT 1
    ) r ON true
  ), quality AS (
    SELECT g.id, g.played, g.phase_id, g.kickoff, g.local_day,
      COALESCE(2.0 * h.rating * a.rating / NULLIF(h.rating + a.rating, 0), 0)
        * (1 + (COALESCE(i.home, 0) + COALESCE(i.away, 0)) / 2.0) AS raw_quality,
      COALESCE(2.0 * h.rating * a.rating / NULLIF(h.rating + a.rating, 0), 0)
        * (1 + (COALESCE(i.home, 0) + COALESCE(i.away, 0)) / 2.0)
        / power(2.0, abs(extract(epoch FROM (g.kickoff - (at_time - interval '3 hours'))) / 86400.0)) AS weighted_quality
    FROM candidates g
    LEFT JOIN ratings h ON h.team_id = g.home_id
    LEFT JOIN ratings a ON a.team_id = g.away_id
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

CREATE OR REPLACE FUNCTION home_game_order(at_time timestamptz)
RETURNS TABLE (game_id uuid, is_played boolean, feed_rank integer)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT s.game_id, s.is_played, s.feed_rank FROM home_game_selection(at_time) s;
$$;

-- The projected date follows the kickoff shown on the homepage. Generated
-- display columns, scope, and transaction IDs remain destination-owned.
CREATE OR REPLACE FUNCTION copy_home_game_cards(game_ids uuid[]) RETURNS void
LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO home_game_card AS h (
    id, phase_id, championship_id, round, day, kickoff, played, home_id, away_id,
    home_name, away_name, home_score, away_score, home_aet, away_aet, home_pen, away_pen,
    championship_name, phase_name, stadium_name, referee_name, attendance, stadium_id, referee_id,
    home_upcoming_rank, home_recent_rank, home_upcoming_group, home_recent_group
  )
  SELECT g.id, g.phase_id, g.championship_id, g.round,
    (g.kickoff AT TIME ZONE 'America/Sao_Paulo')::date, g.kickoff, g.played, g.home_id, g.away_id,
    g.home_name, g.away_name, g.home_score, g.away_score, g.home_aet, g.away_aet, g.home_pen, g.away_pen,
    g.championship_name, g.phase_name, g.stadium_name, g.referee_name, g.attendance, g.stadium_id, g.referee_id,
    g.home_upcoming_rank, g.home_recent_rank, g.home_upcoming_group, g.home_recent_group
  FROM unnest(game_ids) selected(id) JOIN game_card g USING (id)
  WHERE g.kickoff IS NOT NULL AND (g.home_upcoming_rank > 0 OR g.home_recent_rank > 0)
  ON CONFLICT (id) DO UPDATE SET
    phase_id = EXCLUDED.phase_id, championship_id = EXCLUDED.championship_id,
    round = EXCLUDED.round, day = EXCLUDED.day, kickoff = EXCLUDED.kickoff, played = EXCLUDED.played,
    home_id = EXCLUDED.home_id, away_id = EXCLUDED.away_id,
    home_name = EXCLUDED.home_name, away_name = EXCLUDED.away_name,
    home_score = EXCLUDED.home_score, away_score = EXCLUDED.away_score,
    home_aet = EXCLUDED.home_aet, away_aet = EXCLUDED.away_aet,
    home_pen = EXCLUDED.home_pen, away_pen = EXCLUDED.away_pen,
    championship_name = EXCLUDED.championship_name, phase_name = EXCLUDED.phase_name,
    stadium_name = EXCLUDED.stadium_name, referee_name = EXCLUDED.referee_name,
    attendance = EXCLUDED.attendance, stadium_id = EXCLUDED.stadium_id, referee_id = EXCLUDED.referee_id,
    home_upcoming_rank = EXCLUDED.home_upcoming_rank, home_recent_rank = EXCLUDED.home_recent_rank,
    home_upcoming_group = EXCLUDED.home_upcoming_group, home_recent_group = EXCLUDED.home_recent_group
  WHERE (to_jsonb(h) - ARRAY['txid', 'scope_id', 'day_display', 'kickoff_local', 'show_country', 'home_country', 'away_country', 'home_highlighted'])
    IS DISTINCT FROM (to_jsonb(EXCLUDED) - ARRAY['txid', 'scope_id', 'day_display', 'kickoff_local', 'show_country', 'home_country', 'away_country', 'home_highlighted']);
$$;

-- A removed kickoff is immediately ineligible, before the next clock refresh.
CREATE OR REPLACE FUNCTION sync_home_game_card() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM home_game_card WHERE id = OLD.id;
  ELSIF NEW.kickoff IS NOT NULL AND (NEW.home_upcoming_rank > 0 OR NEW.home_recent_rank > 0) THEN
    PERFORM copy_home_game_cards(ARRAY[NEW.id]);
  ELSE
    DELETE FROM home_game_card WHERE id = NEW.id;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION refresh_home_games() RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp
SET statement_timeout = '20s' SET lock_timeout = '2s' AS $$
DECLARE
  selection jsonb;
  selected_ids uuid[];
  affected_ids uuid[];
  target_id uuid;
  card game_card;
  item jsonb;
  upcoming integer;
  recent integer;
  upcoming_group boolean;
  recent_group boolean;
BEGIN
  IF NOT pg_try_advisory_xact_lock(715015, 1) THEN RETURN; END IF;
  SELECT COALESCE(jsonb_object_agg(s.game_id, jsonb_build_object(
      'rank', s.feed_rank, 'played', s.is_played, 'highlighted', s.highlighted, 'group',
      s.previous_phase_id IS DISTINCT FROM s.phase_id OR s.previous_local_day IS DISTINCT FROM s.local_day)), '{}'),
    COALESCE(array_agg(s.game_id), ARRAY[]::uuid[])
  INTO selection, selected_ids
  FROM (
    SELECT ordered.*, g.phase_id,
      (g.kickoff AT TIME ZONE 'America/Sao_Paulo')::date AS local_day,
      lag(g.phase_id) OVER (PARTITION BY ordered.is_played ORDER BY ordered.feed_rank) AS previous_phase_id,
      lag((g.kickoff AT TIME ZONE 'America/Sao_Paulo')::date)
        OVER (PARTITION BY ordered.is_played ORDER BY ordered.feed_rank) AS previous_local_day
    FROM home_game_selection(now()) ordered JOIN game_card g ON g.id = ordered.game_id
  ) s;

  SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO affected_ids
  FROM (
    SELECT unnest(selected_ids) AS id
    UNION SELECT id FROM game_card WHERE home_upcoming_rank > 0
    UNION SELECT id FROM game_card WHERE home_recent_rank > 0
  ) affected;
  FOREACH target_id IN ARRAY affected_ids LOOP
    SELECT * INTO card FROM game_card WHERE id = target_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    item := selection -> target_id::text;
    upcoming := CASE WHEN NOT card.played AND item->>'played' = 'false' THEN (item->>'rank')::integer ELSE 0 END;
    recent := CASE WHEN card.played AND item->>'played' = 'true' THEN (item->>'rank')::integer ELSE 0 END;
    upcoming_group := upcoming > 0 AND COALESCE((item->>'group')::boolean, false);
    recent_group := recent > 0 AND COALESCE((item->>'group')::boolean, false);
    IF (card.home_upcoming_rank, card.home_recent_rank, card.home_upcoming_group, card.home_recent_group)
      IS DISTINCT FROM (upcoming, recent, upcoming_group, recent_group) THEN
      UPDATE game_card SET home_upcoming_rank = upcoming, home_recent_rank = recent,
        home_upcoming_group = upcoming_group, home_recent_group = recent_group
      WHERE id = target_id;
    END IF;
  END LOOP;
  DELETE FROM home_game_card WHERE NOT (id = ANY(selected_ids));
  PERFORM copy_home_game_cards(selected_ids);
  UPDATE home_game_card h SET home_highlighted = (selection->h.id::text->>'highlighted')::boolean
  WHERE h.id = ANY(selected_ids)
    AND h.home_highlighted IS DISTINCT FROM (selection->h.id::text->>'highlighted')::boolean;
END $$;

REVOKE ALL ON FUNCTION home_game_selection(timestamptz), home_game_order(timestamptz), refresh_home_games(),
  copy_home_game_cards(uuid[]), sync_home_game_card() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION home_game_selection(timestamptz), home_game_order(timestamptz), refresh_home_games(),
  copy_home_game_cards(uuid[]), sync_home_game_card() TO service;
SELECT refresh_home_games();
NOTIFY pgrst, 'reload schema';
COMMIT;
