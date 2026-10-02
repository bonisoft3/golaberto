-- A bounded homepage projection and candidate-only rating lookups.
SET lock_timeout = '5s';
-- The covering index is built once over the retained rating history.
SET statement_timeout = '10min';
BEGIN;

-- Pgroll applies these indexes in its atomic onComplete transaction, which
-- cannot run CONCURRENTLY. Retained-volume rollout pauses writers; the lock
-- timeout refuses unexpected contention instead of waiting behind it.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_rating_home_latest_idx
  ON team_rating (team_id, measure_date DESC, id) INCLUDE (rating);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_card_home_kickoff_idx
  ON game_card (kickoff) WHERE kickoff IS NOT NULL;
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_card_home_upcoming_idx
  ON game_card (id) WHERE home_upcoming_rank > 0;
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_card_home_recent_idx
  ON game_card (id) WHERE home_recent_rank > 0;

-- Initdb already has the declared entity; retained volumes acquire the same
-- domains, generated columns, checks, defaults and foreign keys here.
CREATE TABLE IF NOT EXISTS home_game_card (
  LIKE game_card INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS,
  PRIMARY KEY (id),
  FOREIGN KEY (id) REFERENCES game(id) ON DELETE CASCADE,
  FOREIGN KEY (phase_id) REFERENCES phase(id) ON DELETE CASCADE,
  FOREIGN KEY (championship_id) REFERENCES championship(id) ON DELETE CASCADE,
  FOREIGN KEY (home_id) REFERENCES team(id) ON DELETE CASCADE,
  FOREIGN KEY (away_id) REFERENCES team(id) ON DELETE CASCADE,
  FOREIGN KEY (stadium_id) REFERENCES stadium(id) ON DELETE CASCADE,
  FOREIGN KEY (referee_id) REFERENCES referee(id) ON DELETE CASCADE
);
CALL rls_protect('home_game_card');
DROP POLICY IF EXISTS home_game_card_app_user_select ON home_game_card;
CREATE POLICY home_game_card_app_user_select ON home_game_card FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS home_game_card_service_all ON home_game_card;
CREATE POLICY home_game_card_service_all ON home_game_card FOR ALL TO service USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON home_game_card TO anon, app_user, service;
GRANT SELECT ON home_game_card TO electric;
DROP TRIGGER IF EXISTS restamp_txid ON home_game_card;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON home_game_card
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
ALTER TABLE home_game_card REPLICA IDENTITY FULL;
-- This live projection belongs to Electric, never to the CDC publication.
-- tier: container
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'electric_publication_default'
                   AND schemaname = 'public' AND tablename = 'home_game_card') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE home_game_card;
  END IF;
END $$;
-- tier: any

CREATE OR REPLACE FUNCTION home_game_order(at_time timestamptz)
RETURNS TABLE (game_id uuid, is_played boolean, feed_rank integer)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH candidates AS MATERIALIZED (
    SELECT id, played, phase_id, kickoff, home_id, away_id
    FROM game_card
    WHERE (NOT played AND kickoff > at_time AND kickoff < at_time + interval '7 days')
       OR (played AND kickoff < at_time AND kickoff > at_time - interval '7 days')
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
    SELECT g.id, g.played, g.phase_id, g.kickoff,
      (g.kickoff AT TIME ZONE 'America/Sao_Paulo')::date AS local_day,
      COALESCE(2.0 * h.rating * a.rating / NULLIF(h.rating + a.rating, 0), 0)
        * (1 + (COALESCE(i.home, 0) + COALESCE(i.away, 0)) / 2.0)
        / power(2.0, abs(extract(epoch FROM (g.kickoff - at_time))) / 86400.0) AS quality
    FROM candidates g
    LEFT JOIN ratings h ON h.team_id = g.home_id
    LEFT JOIN ratings a ON a.team_id = g.away_id
    LEFT JOIN game_importance i ON i.id = g.id
  ), ranked AS (
    SELECT *, row_number() OVER (PARTITION BY played ORDER BY quality DESC, kickoff DESC, id) AS pick,
      max(quality) OVER (PARTITION BY played, phase_id, local_day) AS phase_quality
    FROM quality
  )
  SELECT id, played, row_number() OVER (PARTITION BY played ORDER BY
    CASE WHEN NOT played THEN local_day END ASC,
    CASE WHEN played THEN local_day END DESC,
    phase_quality DESC, phase_id,
    CASE WHEN NOT played THEN kickoff END ASC,
    CASE WHEN played THEN kickoff END DESC, quality DESC, id)::integer
  FROM ranked WHERE pick <= 20;
$$;

-- Both refresh and selected-card edits use this copy. Generated display/scope
-- columns and txid remain owned by the destination table.
CREATE OR REPLACE FUNCTION copy_home_game_cards(game_ids uuid[]) RETURNS void
LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO home_game_card AS h (
    id, phase_id, championship_id, round, day, kickoff, played, home_id, away_id,
    home_name, away_name, home_score, away_score, home_aet, away_aet, home_pen, away_pen,
    championship_name, phase_name, stadium_name, referee_name, attendance, stadium_id, referee_id,
    home_upcoming_rank, home_recent_rank, home_upcoming_group, home_recent_group
  )
  SELECT g.id, g.phase_id, g.championship_id, g.round, g.day, g.kickoff, g.played, g.home_id, g.away_id,
    g.home_name, g.away_name, g.home_score, g.away_score, g.home_aet, g.away_aet, g.home_pen, g.away_pen,
    g.championship_name, g.phase_name, g.stadium_name, g.referee_name, g.attendance, g.stadium_id, g.referee_id,
    g.home_upcoming_rank, g.home_recent_rank, g.home_upcoming_group, g.home_recent_group
  FROM unnest(game_ids) selected(id) JOIN game_card g USING (id)
  WHERE g.home_upcoming_rank > 0 OR g.home_recent_rank > 0
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
  WHERE (to_jsonb(h) - ARRAY['txid', 'scope_id', 'day_display', 'kickoff_local'])
    IS DISTINCT FROM (to_jsonb(EXCLUDED) - ARRAY['txid', 'scope_id', 'day_display', 'kickoff_local']);
$$;

CREATE OR REPLACE FUNCTION sync_home_game_card() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM home_game_card WHERE id = OLD.id;
  ELSIF NEW.home_upcoming_rank > 0 OR NEW.home_recent_rank > 0 THEN
    PERFORM copy_home_game_cards(ARRAY[NEW.id]);
  ELSE
    DELETE FROM home_game_card WHERE id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS sync_home_game_card_insert ON game_card;
CREATE TRIGGER sync_home_game_card_insert AFTER INSERT ON game_card FOR EACH ROW
  WHEN (NEW.home_upcoming_rank > 0 OR NEW.home_recent_rank > 0)
  EXECUTE FUNCTION sync_home_game_card();
DROP TRIGGER IF EXISTS sync_home_game_card_update ON game_card;
CREATE TRIGGER sync_home_game_card_update AFTER UPDATE ON game_card FOR EACH ROW
  WHEN (OLD.home_upcoming_rank > 0 OR OLD.home_recent_rank > 0
     OR NEW.home_upcoming_rank > 0 OR NEW.home_recent_rank > 0)
  EXECUTE FUNCTION sync_home_game_card();
DROP TRIGGER IF EXISTS sync_home_game_card_delete ON game_card;
CREATE TRIGGER sync_home_game_card_delete AFTER DELETE ON game_card FOR EACH ROW
  WHEN (OLD.home_upcoming_rank > 0 OR OLD.home_recent_rank > 0)
  EXECUTE FUNCTION sync_home_game_card();

CREATE OR REPLACE FUNCTION refresh_home_games() RETURNS void
-- PostgREST 12.2 hoists this function setting before executing the RPC.
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
  -- A timed-out client must not start a second refresh beside the first one.
  IF NOT pg_try_advisory_xact_lock(715015, 1) THEN RETURN; END IF;
  SELECT COALESCE(jsonb_object_agg(s.game_id, jsonb_build_object(
      'rank', s.feed_rank, 'played', s.is_played, 'group', s.feed_rank = s.group_rank)), '{}'),
    COALESCE(array_agg(s.game_id), ARRAY[]::uuid[])
  INTO selection, selected_ids
  FROM (
    SELECT s.*, min(s.feed_rank) OVER (PARTITION BY s.is_played, g.championship_id) AS group_rank
    FROM home_game_order(now()) s JOIN game_card g ON g.id = s.game_id
  ) s;

  -- Each old/new feed has at most forty IDs. Partial indexes find old ranks;
  -- point locks and updates avoid scanning the archive and serialize copies
  -- with the card's own update trigger, including when its rank is unchanged.
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
END $$;

REVOKE ALL ON FUNCTION home_game_order(timestamptz), refresh_home_games(),
  copy_home_game_cards(uuid[]), sync_home_game_card() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION home_game_order(timestamptz), refresh_home_games(),
  copy_home_game_cards(uuid[]), sync_home_game_card() TO service;
SELECT refresh_home_games();
NOTIFY pgrst, 'reload schema';
COMMIT;
