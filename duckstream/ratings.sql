CREATE TABLE source_championship(id VARCHAR, category_id VARCHAR);
CREATE TABLE source_phase(id VARCHAR, championship_id VARCHAR);
CREATE TABLE source_game(
 id VARCHAR, phase_id VARCHAR, home_id VARCHAR, away_id VARCHAR,
 home_field INTEGER, home_score INTEGER, away_score INTEGER,
 home_aet INTEGER, away_aet INTEGER, played BOOLEAN, utc TIMESTAMP(6),
 moment BIGINT, "date" VARCHAR, four_years BIGINT, cutoff VARCHAR
);
CREATE TABLE source_team(id VARCHAR);
CREATE TABLE source_player(id VARCHAR, position VARCHAR);
CREATE TABLE source_player_game(id VARCHAR, game_id VARCHAR, player_id VARCHAR, side VARCHAR,
 on_minute INTEGER, off_minute INTEGER, red BOOLEAN);
CREATE TABLE source_goal(id VARCHAR, game_id VARCHAR, player_id VARCHAR, side VARCHAR,
 minute INTEGER, penalty BOOLEAN, own_goal BOOLEAN);
CREATE LOCAL VIEW archive AS
 SELECT x.* FROM source_game x
 JOIN source_team h ON h.id=x.home_id
 JOIN source_team a ON a.id=x.away_id
 JOIN source_phase p ON p.id=x.phase_id
 JOIN source_championship c ON c.id=p.championship_id
 WHERE c.category_id IS NULL AND x.played;
CREATE LOCAL VIEW statistics_window AS SELECT MAX(utc) AS latest,FLOOR(MAX(utc) TO MONTH) AS anchor FROM archive;
CREATE LOCAL VIEW boundary AS
 SELECT w.latest,w.anchor + INTERVAL '-7' YEAR AS seven_years,MIN(x.cutoff) AS cutoff
 FROM statistics_window w LEFT JOIN archive x ON x.utc=w.latest GROUP BY w.latest,w.anchor;
CREATE LOCAL VIEW recent AS
 SELECT x.* FROM archive x CROSS JOIN boundary b WHERE x.utc > b.latest + INTERVAL '-1456' DAY;
CREATE MATERIALIZED VIEW result_games AS
 SELECT x.id,x.phase_id,x.home_id,x.away_id,x.home_field,x.home_score,x.away_score,x.home_aet,x.away_aet,
 x.moment,x."date",x.utc>=b.seven_years AS seven_years,x.utc>b.latest+INTERVAL '-1456' DAY AS recent
 FROM archive x CROSS JOIN boundary b;
CREATE LOCAL VIEW phase_bounds AS
 SELECT phase_id,MIN(utc) AS earliest,MAX(moment) AS until FROM archive GROUP BY phase_id;
CREATE MATERIALIZED VIEW result_phases AS
 SELECT p.phase_id AS id,MIN(x.four_years) AS since,p.until
 FROM phase_bounds p JOIN archive x ON x.phase_id=p.phase_id AND x.utc=p.earliest
 GROUP BY p.phase_id,p.until;
CREATE MATERIALIZED VIEW result_cutoff AS SELECT cutoff AS since FROM boundary;
CREATE MATERIALIZED VIEW result_teams AS SELECT id FROM source_team;
CREATE MATERIALIZED VIEW result_players AS SELECT id FROM source_player;
CREATE MATERIALIZED VIEW result_appearances AS
 SELECT pg.id,pg.game_id,pg.player_id,CASE WHEN pg.side='home' THEN x.home_id ELSE x.away_id END AS team_id,
 pg.on_minute AS "on",pg.off_minute AS "off",pg.red,COALESCE(p.position,'') AS position
 FROM source_player_game pg JOIN source_player p ON p.id=pg.player_id JOIN recent x ON x.id=pg.game_id
 WHERE pg.off_minute>0;
CREATE MATERIALIZED VIEW result_goals AS
 SELECT q.id AS __order,q.game_id,q.player_id,
 CASE WHEN (q.side='home')<>q.own_goal THEN x.home_id ELSE x.away_id END AS team_id,
 q.minute AS "time",q.penalty,q.own_goal
 FROM source_goal q JOIN source_player p ON p.id=q.player_id
 JOIN recent x ON x.id=q.game_id WHERE q.minute IS NOT NULL;
