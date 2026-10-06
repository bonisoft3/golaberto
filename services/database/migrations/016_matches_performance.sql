-- Bounded matches feeds retain the existing archive selection semantics.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

-- Pgroll onComplete is atomic; retained-volume rollout pauses writers while
-- these indexes are built. Refuse unexpected contention rather than queue.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_card_matches_upcoming_idx
  ON game_card (kickoff ASC NULLS LAST, id ASC)
  WHERE NOT played AND kickoff IS NOT NULL;
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_card_matches_results_idx
  ON game_card (day DESC NULLS FIRST, kickoff DESC NULLS FIRST, id ASC)
  WHERE played;

-- Initdb already has the declared entity; retained volumes acquire the same
-- domains, generated columns, checks, defaults and foreign keys here.
CREATE TABLE IF NOT EXISTS matches_game_card (
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
CALL rls_protect('matches_game_card');
DROP POLICY IF EXISTS matches_game_card_app_user_select ON matches_game_card;
CREATE POLICY matches_game_card_app_user_select ON matches_game_card FOR SELECT TO app_user USING (true);
DROP POLICY IF EXISTS matches_game_card_service_all ON matches_game_card;
CREATE POLICY matches_game_card_service_all ON matches_game_card FOR ALL TO service USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON matches_game_card TO anon, app_user, service;
GRANT SELECT ON matches_game_card TO electric;
DROP TRIGGER IF EXISTS restamp_txid ON matches_game_card;
CREATE TRIGGER restamp_txid BEFORE UPDATE ON matches_game_card
  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
-- tier: container
ALTER TABLE matches_game_card REPLICA IDENTITY FULL;
-- This live projection belongs to Electric, never to the CDC publication.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'electric_publication_default'
                   AND schemaname = 'public' AND tablename = 'matches_game_card') THEN
    ALTER PUBLICATION electric_publication_default ADD TABLE matches_game_card;
  END IF;
END $$;
-- tier: any

-- Both refresh and selected-card edits use this copy. Generated display/scope
-- columns and txid remain owned by the destination table.
CREATE OR REPLACE FUNCTION copy_matches_game_cards(game_ids uuid[]) RETURNS void
LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO matches_game_card AS h (
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

-- Only an already-selected ID is touched by a card write. A feed switch or
-- newly unknown fixture time removes it until the next membership refresh;
-- copying it directly into the other full feed would exceed that feed's cap.
CREATE OR REPLACE FUNCTION sync_matches_game_card() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM matches_game_card WHERE id = OLD.id;
  ELSIF OLD.played IS DISTINCT FROM NEW.played OR (NOT NEW.played AND NEW.kickoff IS NULL) THEN
    DELETE FROM matches_game_card WHERE id = NEW.id;
  ELSIF EXISTS (SELECT 1 FROM matches_game_card WHERE id = NEW.id) THEN
    PERFORM copy_matches_game_cards(ARRAY[NEW.id]);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS sync_matches_game_card_update ON game_card;
CREATE TRIGGER sync_matches_game_card_update AFTER UPDATE ON game_card FOR EACH ROW
  EXECUTE FUNCTION sync_matches_game_card();
DROP TRIGGER IF EXISTS sync_matches_game_card_delete ON game_card;
CREATE TRIGGER sync_matches_game_card_delete AFTER DELETE ON game_card FOR EACH ROW
  EXECUTE FUNCTION sync_matches_game_card();

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
    SELECT id FROM game_card WHERE NOT played AND kickoff IS NOT NULL
    ORDER BY kickoff ASC NULLS LAST, id ASC LIMIT 40
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
  FROM unnest(selected_ids) selected(id) JOIN game_card g USING (id)
  WHERE (g.id = ANY(upcoming_ids) AND NOT g.played AND g.kickoff IS NOT NULL)
     OR (g.id = ANY(result_ids) AND g.played);
  DELETE FROM matches_game_card WHERE NOT (id = ANY(selected_ids));
  PERFORM copy_matches_game_cards(selected_ids);
END $$;

REVOKE ALL ON FUNCTION refresh_matches_games(), copy_matches_game_cards(uuid[]),
  sync_matches_game_card() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_matches_games(), copy_matches_game_cards(uuid[]),
  sync_matches_game_card() TO service;
SELECT refresh_matches_games();
NOTIFY pgrst, 'reload schema';
COMMIT;
