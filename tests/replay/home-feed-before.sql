SET lock_timeout = '2s';
SET statement_timeout = '30s';
CREATE SCHEMA replay_fixture;
INSERT INTO app_user (id, handle) VALUES ('f1993000-0000-4000-8000-000000000047', 'retained-replay-reader');
INSERT INTO game_card (id, phase_id, championship_id, day, kickoff, played,
  home_id, away_id, home_name, away_name, championship_name, phase_name)
SELECT g.id, g.phase_id, p.championship_id, current_date, now() + interval '1 hour', false,
  g.home_id, g.away_id, h.name, a.name, c.name, p.name
FROM game g JOIN phase p ON p.id=g.phase_id JOIN championship c ON c.id=p.championship_id
  JOIN team h ON h.id=g.home_id JOIN team a ON a.id=g.away_id
ORDER BY g.id LIMIT 1;
CREATE TABLE replay_fixture.game_rows AS SELECT * FROM game;
CREATE TABLE replay_fixture.source_rows AS SELECT * FROM game_card;
CREATE TABLE replay_fixture.user_rows AS SELECT * FROM app_user;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM game_card) THEN
    RAISE EXCEPTION 'retained homepage fixture needs game data';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid='home_game_card'::regclass) <> 'r'
    OR (SELECT relkind FROM pg_class WHERE oid='home_feed'::regclass) <> 'r' THEN
    RAISE EXCEPTION 'retained homepage fixture must start with the old stored projections';
  END IF;
END $$;
