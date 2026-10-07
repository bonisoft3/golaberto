SET lock_timeout = '5s';
SET statement_timeout = '10min';
BEGIN;

-- Upstream round identifiers include knockout code 636; they are not a 99-round counter.
ALTER TABLE game DROP CONSTRAINT IF EXISTS game_round_check;
ALTER TABLE game ADD CONSTRAINT game_round_check CHECK (round >= 1) NOT VALID;
ALTER TABLE game_card DROP CONSTRAINT IF EXISTS game_card_round_check;
ALTER TABLE game_card ADD CONSTRAINT game_card_round_check CHECK (round >= 1) NOT VALID;
ALTER TABLE home_game_card DROP CONSTRAINT IF EXISTS home_game_card_round_check;
ALTER TABLE home_game_card ADD CONSTRAINT home_game_card_round_check CHECK (round >= 1) NOT VALID;
ALTER TABLE matches_game_card DROP CONSTRAINT IF EXISTS matches_game_card_round_check;
ALTER TABLE matches_game_card ADD CONSTRAINT matches_game_card_round_check CHECK (round >= 1) NOT VALID;
ALTER TABLE team_group DROP CONSTRAINT IF EXISTS team_group_comment_check;
ALTER TABLE team_group ADD CONSTRAINT team_group_comment_check CHECK (char_length(comment) <= 1000) NOT VALID;

ALTER TABLE zone DROP CONSTRAINT IF EXISTS zone_name_check;
ALTER TABLE zone ADD CONSTRAINT zone_name_check CHECK (char_length(name) > 0 AND char_length(name) <= 120) NOT VALID;
ALTER TABLE zone DROP CONSTRAINT IF EXISTS zone_color_check;
ALTER TABLE zone ADD CONSTRAINT zone_color_check CHECK (
  color IN ('champion','promotion','qualify','playoff','relegation') OR color ~ '^#[0-9a-fA-F]{6}$') NOT VALID;
ALTER TABLE zone_chance DROP CONSTRAINT IF EXISTS zone_chance_color_check;
ALTER TABLE zone_chance ADD CONSTRAINT zone_chance_color_check CHECK (
  color IN ('champion','promotion','qualify','playoff','relegation') OR color ~ '^#[0-9a-fA-F]{6}$') NOT VALID;
ALTER TABLE standing DROP CONSTRAINT IF EXISTS standing_zone_check;
ALTER TABLE standing ADD CONSTRAINT standing_zone_check CHECK (
  zone IN ('','champion','promotion','qualify','playoff','relegation') OR zone ~ '^#[0-9a-fA-F]{6}$') NOT VALID;

COMMIT;

BEGIN;
ALTER TABLE game VALIDATE CONSTRAINT game_round_check;
ALTER TABLE game_card VALIDATE CONSTRAINT game_card_round_check;
ALTER TABLE home_game_card VALIDATE CONSTRAINT home_game_card_round_check;
ALTER TABLE matches_game_card VALIDATE CONSTRAINT matches_game_card_round_check;
ALTER TABLE team_group VALIDATE CONSTRAINT team_group_comment_check;
ALTER TABLE zone VALIDATE CONSTRAINT zone_name_check;
ALTER TABLE zone VALIDATE CONSTRAINT zone_color_check;
ALTER TABLE zone_chance VALIDATE CONSTRAINT zone_chance_color_check;
ALTER TABLE standing VALIDATE CONSTRAINT standing_zone_check;
COMMIT;
