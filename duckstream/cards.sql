CREATE TABLE source_game(id VARCHAR,phase_id VARCHAR,"round" INTEGER,day VARCHAR,kickoff VARCHAR,
 played BOOLEAN,home_id VARCHAR,away_id VARCHAR,home_score INTEGER,away_score INTEGER,
 home_aet INTEGER,away_aet INTEGER,home_pen INTEGER,away_pen INTEGER,stadium_id VARCHAR,referee_id VARCHAR,attendance INTEGER,fixture_available BOOLEAN);
CREATE TABLE source_phase(id VARCHAR,championship_id VARCHAR,name VARCHAR);
CREATE TABLE source_championship(id VARCHAR,full_name VARCHAR,category_id VARCHAR);
CREATE TABLE source_team(id VARCHAR,name VARCHAR);
CREATE TABLE source_stadium(id VARCHAR,name VARCHAR);
CREATE TABLE source_referee(id VARCHAR,name VARCHAR);
CREATE MATERIALIZED VIEW result_game_card AS
 SELECT g.id,g.phase_id,p.championship_id,g."round",g.day,g.kickoff,g.played,g.home_id,g.away_id,
 h.name AS home_name,a.name AS away_name,g.home_score,g.away_score,g.home_aet,g.away_aet,g.home_pen,g.away_pen,
 c.full_name AS championship_name,p.name AS phase_name,g.stadium_id,s.name AS stadium_name,
 g.referee_id,r.name AS referee_name,g.attendance
 FROM source_game g JOIN source_phase p ON p.id=g.phase_id JOIN source_championship c ON c.id=p.championship_id
 JOIN source_team h ON h.id=g.home_id JOIN source_team a ON a.id=g.away_id
 LEFT JOIN source_stadium s ON s.id=g.stadium_id LEFT JOIN source_referee r ON r.id=g.referee_id;
CREATE LOCAL VIEW sides AS
 SELECT id,phase_id,day,kickoff,played,fixture_available,home_id AS team_id,away_id AS opponent_id,
 CAST('home' AS VARCHAR) AS side,home_score AS gf,away_score AS ga FROM source_game
 UNION ALL
 SELECT id,phase_id,day,kickoff,played,fixture_available,away_id AS team_id,home_id AS opponent_id,
 CAST('away' AS VARCHAR) AS side,away_score AS gf,home_score AS ga FROM source_game;
CREATE MATERIALIZED VIEW result_team_game AS
 SELECT g.team_id || ':' || g.id AS id,g.team_id,g.id AS game_id,g.side,g.opponent_id,
 opponent.name AS opponent_name,p.championship_id,c.full_name AS championship_name,g.day,g.kickoff,g.played,
 g.gf AS goals_for,g.ga AS goals_against,
 CAST(CASE WHEN NOT g.played THEN '' WHEN g.gf>g.ga THEN 'w' WHEN g.gf<g.ga THEN 'l' ELSE 'd' END AS VARCHAR) AS result,
 c.category_id,p.id AS phase_key,COALESCE(c.category_id,'professional') AS category_key,g.fixture_available
 FROM sides g JOIN source_phase p ON p.id=g.phase_id JOIN source_championship c ON c.id=p.championship_id
 JOIN source_team opponent ON opponent.id=g.opponent_id;
