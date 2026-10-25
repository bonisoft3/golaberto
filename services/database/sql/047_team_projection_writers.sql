-- A parent edit can update a roster before enqueueing profiles, while a
-- drain holds an earlier queue row and waits for that roster. Take the same
-- turn before the statement acquires source-row locks, including cascades.
BEGIN;
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE OR REPLACE FUNCTION take_team_projection_write_turn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
SET lock_timeout = '2s' AS $$
BEGIN
  PERFORM take_team_projection_turn();
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION take_team_projection_write_turn() FROM PUBLIC;

DO $$ DECLARE source_table text; BEGIN
  FOREACH source_table IN ARRAY ARRAY[
    'app_user', 'championship', 'phase', 'stage_group', 'team_group', 'game',
    'team', 'player', 'team_player', 'player_stat', 'player_game',
    'team_roster', 'team_rating', 'team_odds_history', 'zone'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS team_projection_write_turn ON %I', source_table);
    EXECUTE format('CREATE TRIGGER team_projection_write_turn BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH STATEMENT EXECUTE FUNCTION take_team_projection_write_turn()', source_table);
  END LOOP;
END $$;
COMMIT;
