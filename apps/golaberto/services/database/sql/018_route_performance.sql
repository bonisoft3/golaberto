-- Route filters and ordering on archive tables with millions of rows.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

-- Pgroll applies these in its atomic onComplete transaction, which cannot run
-- CREATE INDEX CONCURRENTLY. Pause writers on retained volumes during this
-- build; lock_timeout fails quickly if the expected quiet window is missing.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS championship_routes_region_begins_idx
  ON championship (region, begins DESC, id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS championship_routes_catalog_order_idx
  ON championship (region_name, name, begins DESC, id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS championship_routes_featured_idx
  ON championship (begins DESC, id) WHERE featured;

-- Directories order by name; team already has a name-only index from 005.
-- These composite forms include the stable entity key used for paging.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_routes_name_id_idx
  ON team (name, id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS stadium_routes_name_id_idx
  ON stadium (name, id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS referee_routes_name_id_idx
  ON referee (name, id);

-- Championship round, stadium history and referee history screens sort the
-- same 318k-card archive after filtering by these leading columns.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_card_routes_phase_round_idx
  ON game_card (phase_id, round, day, kickoff, id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_card_routes_stadium_history_idx
  ON game_card (stadium_id, day DESC, kickoff DESC, id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS game_card_routes_referee_history_idx
  ON game_card (referee_id, day DESC, kickoff DESC, id);

-- Team history has different direction and ID tie-break rules in its upcoming
-- and results feeds, so each partial index matches the emitted order exactly.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_game_routes_upcoming_idx
  ON team_game (team_id, day, kickoff, id) WHERE NOT played;
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS team_game_routes_results_idx
  ON team_game (team_id, day DESC, kickoff DESC, id) WHERE played;

-- Team squads and player seasons are two independently filtered route views.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS player_stat_routes_team_idx
  ON player_stat (team_id, championship_name, played DESC, minutes DESC, player_name, id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS player_stat_routes_player_idx
  ON player_stat (player_id, championship_name, team_name, id);

-- Player appearances are the largest route lookup (3.29M rows); game lineups
-- also order by side, bench and entry minute after their game filter.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS player_game_routes_player_day_idx
  ON player_game (player_id, day DESC, id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS player_game_routes_game_lineup_idx
  ON player_game (game_id, side DESC, bench, on_minute, id);

-- Game pages read these child rows in display order.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS goal_routes_game_order_idx
  ON goal (game_id, aet, minute, id);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS comment_routes_game_order_idx
  ON comment (game_id, created_at DESC, id);

COMMIT;
