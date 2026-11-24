CREATE TABLE source_championship(id VARCHAR, category_id VARCHAR);
CREATE TABLE source_phase(id VARCHAR, championship_id VARCHAR);
CREATE TABLE source_game(
 id VARCHAR, phase_id VARCHAR, home_id VARCHAR, away_id VARCHAR,
 home_field INTEGER, home_score INTEGER, away_score INTEGER,
 home_aet INTEGER, away_aet INTEGER, played BOOLEAN, utc TIMESTAMP(6),
 moment BIGINT, "date" VARCHAR
);
CREATE TABLE source_team(id VARCHAR);
CREATE LOCAL VIEW archive AS
 SELECT x.* FROM source_game x
 JOIN source_team h ON h.id=x.home_id
 JOIN source_team a ON a.id=x.away_id
 JOIN source_phase p ON p.id=x.phase_id
 JOIN source_championship c ON c.id=p.championship_id
 WHERE c.category_id IS NULL AND x.played;
CREATE LOCAL VIEW statistics_window AS SELECT FLOOR(MAX(utc) TO MONTH) AS anchor FROM archive;
CREATE LOCAL VIEW boundary AS SELECT anchor + INTERVAL '-7' YEAR AS seven_years FROM statistics_window;
CREATE MATERIALIZED VIEW result_games AS
 SELECT x.id,x.home_id,x.away_id,x.home_field,x.home_score,x.away_score,x.home_aet,x.away_aet,
 x.moment,x."date"
 FROM archive x CROSS JOIN boundary b WHERE x.utc>=b.seven_years;
CREATE MATERIALIZED VIEW result_teams AS SELECT id FROM source_team;
