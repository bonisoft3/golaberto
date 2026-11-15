CREATE TABLE source_player_game(id VARCHAR,game_id VARCHAR,player_id VARCHAR,side VARCHAR,
 on_minute INTEGER,off_minute INTEGER,yellow BOOLEAN,red BOOLEAN,bench BOOLEAN);
CREATE TABLE source_goal(id VARCHAR,game_id VARCHAR,player_id VARCHAR,side VARCHAR,penalty BOOLEAN,own_goal BOOLEAN);
CREATE TABLE source_game(id VARCHAR,phase_id VARCHAR,home_id VARCHAR,away_id VARCHAR);
CREATE TABLE source_phase(id VARCHAR,championship_id VARCHAR);
CREATE TABLE source_championship(id VARCHAR,full_name VARCHAR);
CREATE TABLE source_team(id VARCHAR,name VARCHAR);
CREATE TABLE source_player(id VARCHAR,name VARCHAR,position VARCHAR);
CREATE LOCAL VIEW appearances AS
 SELECT p.championship_id,a.player_id,CASE WHEN a.side='home' THEN g.home_id ELSE g.away_id END AS team_id,
 CASE WHEN a.bench THEN 0 ELSE 1 END AS played,
 CASE WHEN NOT a.bench AND a.on_minute=0 THEN 1 ELSE 0 END AS started,
 CASE WHEN NOT a.bench AND a.on_minute>0 THEN 1 ELSE 0 END AS came_on,
 CASE WHEN a.bench THEN 1 ELSE 0 END AS bench,
 CASE WHEN a.bench THEN 0 ELSE COALESCE(a.off_minute,CASE WHEN a.on_minute>90 THEN a.on_minute ELSE 90 END)-a.on_minute END AS elapsed,
 CASE WHEN a.yellow THEN 1 ELSE 0 END AS yellow,CASE WHEN a.red THEN 1 ELSE 0 END AS red
 FROM source_player_game a JOIN source_game g ON g.id=a.game_id JOIN source_phase p ON p.id=g.phase_id;
CREATE LOCAL VIEW events AS
 SELECT championship_id,player_id,team_id,played,started,came_on,bench,
 CASE WHEN elapsed>0 THEN elapsed ELSE 0 END AS minutes,
 0 AS goals,0 AS penalties,0 AS own_goals,yellow,red FROM appearances
 UNION ALL
 SELECT p.championship_id,q.player_id,CASE WHEN (q.side='home')<>q.own_goal THEN g.home_id ELSE g.away_id END,
 0,0,0,0,0,CASE WHEN q.own_goal THEN 0 ELSE 1 END,CASE WHEN q.penalty AND NOT q.own_goal THEN 1 ELSE 0 END,
 CASE WHEN q.own_goal THEN 1 ELSE 0 END,0,0
 FROM source_goal q JOIN source_game g ON g.id=q.game_id JOIN source_phase p ON p.id=g.phase_id;
CREATE LOCAL VIEW counters AS
 SELECT championship_id,player_id,team_id,CAST(SUM(played) AS INTEGER) AS played,
 CAST(SUM(started) AS INTEGER) AS started,CAST(SUM(came_on) AS INTEGER) AS came_on,CAST(SUM(bench) AS INTEGER) AS bench,
 CAST(SUM(minutes) AS INTEGER) AS minutes,CAST(SUM(goals) AS INTEGER) AS goals,CAST(SUM(penalties) AS INTEGER) AS penalties,
 CAST(SUM(own_goals) AS INTEGER) AS own_goals,CAST(SUM(yellow) AS INTEGER) AS yellow,CAST(SUM(red) AS INTEGER) AS red
 FROM events GROUP BY championship_id,player_id,team_id;
CREATE MATERIALIZED VIEW result_player_stat AS
 SELECT s.championship_id || ':' || s.team_id || ':' || s.player_id AS id,
 s.championship_id,s.team_id,s.player_id,p.name AS player_name,COALESCE(p.position,'') AS position,
 s.played,s.started,s.came_on,s.bench,s.minutes,s.goals,s.penalties,s.own_goals,s.yellow,s.red,
 c.full_name AS championship_name,t.name AS team_name
 FROM counters s JOIN source_player p ON p.id=s.player_id JOIN source_team t ON t.id=s.team_id
 JOIN source_championship c ON c.id=s.championship_id;
