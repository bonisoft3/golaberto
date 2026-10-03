-- An appearance carries its game's day, so a player's games order by date in a
-- synced table rather than through a server-side join (ir decision-local-reads).
-- The game is the one writer: an appearance takes the day on the way in, and a
-- game that moves takes its appearances with it.
--
-- Idempotent via CREATE OR REPLACE and DROP TRIGGER IF EXISTS; initdb replays
-- this on a fresh volume.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

BEGIN;

CREATE OR REPLACE FUNCTION player_game_day() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.day := (SELECT day FROM game WHERE id = NEW.game_id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS player_game_day ON player_game;
CREATE TRIGGER player_game_day BEFORE INSERT OR UPDATE OF game_id, day ON player_game
  FOR EACH ROW EXECUTE FUNCTION player_game_day();

CREATE OR REPLACE FUNCTION game_day_moves_appearances() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE player_game SET day = NEW.day WHERE game_id = NEW.id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS game_day_moves_appearances ON game;
CREATE TRIGGER game_day_moves_appearances AFTER UPDATE OF day ON game
  FOR EACH ROW WHEN (OLD.day IS DISTINCT FROM NEW.day) EXECUTE FUNCTION game_day_moves_appearances();

COMMIT;
