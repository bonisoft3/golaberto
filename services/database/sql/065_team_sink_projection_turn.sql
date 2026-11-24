-- Chances publication writes team_chance through game_importance before its
-- onComplete hook inserts team_odds_history, while structural invalidation
-- takes the projection turn before clearing standing and chance sinks. Take
-- the same turn before statement-level source tracking locks compute.source.
BEGIN;
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DO $$ DECLARE sink_table text; BEGIN
  FOREACH sink_table IN ARRAY ARRAY[
    'standing', 'team_chance', 'zone_chance', 'position_chance', 'game_importance', 'player_rating'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS team_projection_write_turn ON %I', sink_table);
    EXECUTE format('CREATE TRIGGER team_projection_write_turn BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH STATEMENT EXECUTE FUNCTION take_team_projection_write_turn()', sink_table);
  END LOOP;
END $$;
COMMIT;
