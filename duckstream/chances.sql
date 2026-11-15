CREATE TABLE source_championship(id VARCHAR, point_win INTEGER, point_draw INTEGER, point_loss INTEGER);
CREATE TABLE source_phase(id VARCHAR, championship_id VARCHAR, sort VARCHAR, bonus_points INTEGER, bonus_points_threshold INTEGER);
CREATE TABLE source_stage_group(id VARCHAR,phase_id VARCHAR);
CREATE TABLE source_team_group(group_id VARCHAR,team_id VARCHAR,add_sub INTEGER,bias INTEGER);
CREATE TABLE source_standing(group_id VARCHAR,team_id VARCHAR,position INTEGER,points INTEGER,played INTEGER);
CREATE TABLE source_team(id VARCHAR,name VARCHAR);
CREATE TABLE source_zone(id VARCHAR,group_id VARCHAR,first INTEGER,last INTEGER,positions VARCHAR,color VARCHAR);
CREATE TABLE source_game(id VARCHAR,phase_id VARCHAR,home_id VARCHAR,away_id VARCHAR,home_field VARCHAR,
 played BOOLEAN,home_score INTEGER,away_score INTEGER,moment TIMESTAMP(6),withdrawn BOOLEAN,
 home_key_0 BIGINT,home_key_1 BIGINT,home_key_2 BIGINT,home_key_3 BIGINT,away_key_0 BIGINT,away_key_1 BIGINT,away_key_2 BIGINT,away_key_3 BIGINT);
CREATE TABLE source_team_rating(team_id VARCHAR,moment TIMESTAMP(6),offense DOUBLE,defense DOUBLE,
 team_key_0 BIGINT,team_key_1 BIGINT,team_key_2 BIGINT,team_key_3 BIGINT);
CREATE LOCAL VIEW members AS
 SELECT t.group_id,t.team_id,t.add_sub,t.bias,n.id AS known_team,n.name,s.position,s.points,s.played
 FROM source_team_group t LEFT JOIN source_team n ON n.id=t.team_id
 LEFT JOIN source_standing s ON s.group_id=t.group_id AND s.team_id=t.team_id;
CREATE LOCAL VIEW positions AS SELECT DISTINCT group_id,position FROM members WHERE position IS NOT NULL;
CREATE LOCAL VIEW position_counts AS SELECT group_id,COUNT(*) AS distinct_count FROM positions GROUP BY group_id;
CREATE LOCAL VIEW ranked AS
 SELECT m.group_id FROM members m JOIN position_counts p ON p.group_id=m.group_id GROUP BY m.group_id,p.distinct_count
 HAVING COUNT(m.known_team)=COUNT(*) AND COUNT(m.position)=COUNT(*) AND p.distinct_count=COUNT(*) AND MIN(m.position)=1 AND MAX(m.position)=COUNT(*);
CREATE LOCAL VIEW live AS
 SELECT DISTINCT t.group_id FROM source_team_group t JOIN source_stage_group g ON g.id=t.group_id
 JOIN source_game x ON x.phase_id=g.phase_id AND (t.team_id=x.home_id OR t.team_id=x.away_id)
 WHERE NOT x.played AND NOT x.withdrawn;
CREATE MATERIALIZED VIEW result_groups AS
 SELECT g.id,l.group_id IS NOT NULL AS live,p.sort,p.bonus_points,p.bonus_points_threshold,
 c.point_win AS win,c.point_draw AS draw,c.point_loss AS loss
 FROM source_stage_group g JOIN ranked r ON r.group_id=g.id
 JOIN source_phase p ON p.id=g.phase_id JOIN source_championship c ON c.id=p.championship_id
 LEFT JOIN live l ON l.group_id=g.id;
CREATE MATERIALIZED VIEW result_members AS
 SELECT m.group_id,m.team_id,m.name,m.add_sub,m.bias,m.position,m.points,m.played
 FROM members m JOIN ranked r ON r.group_id=m.group_id;
CREATE LOCAL VIEW pairs AS
 SELECT DISTINCT t.group_id,x.* FROM source_team_group t JOIN live l ON l.group_id=t.group_id
 JOIN ranked r ON r.group_id=t.group_id JOIN source_stage_group g ON g.id=t.group_id
 JOIN source_game x ON x.phase_id=g.phase_id AND (t.team_id=x.home_id OR t.team_id=x.away_id)
 WHERE x.played OR NOT x.withdrawn;
CREATE MATERIALIZED VIEW result_games AS
 SELECT p.group_id,p.id,p.home_id,p.away_id,p.home_field,p.played,
 COALESCE(p.home_score,0) AS home_score,COALESCE(p.away_score,0) AS away_score,
 h.offense AS home_off,h.defense AS home_def,a.offense AS away_off,a.defense AS away_def,p.moment AS __order
 FROM pairs p
 LEFT ASOF JOIN source_team_rating h MATCH_CONDITION(p.moment>=h.moment) ON p.home_key_0=h.team_key_0 AND p.home_key_1=h.team_key_1 AND p.home_key_2=h.team_key_2 AND p.home_key_3=h.team_key_3
 LEFT ASOF JOIN source_team_rating a MATCH_CONDITION(p.moment>=a.moment) ON p.away_key_0=a.team_key_0 AND p.away_key_1=a.team_key_1 AND p.away_key_2=a.team_key_2 AND p.away_key_3=a.team_key_3;
CREATE MATERIALIZED VIEW result_zones AS
 SELECT z.group_id,z.id,z.first,z.last,z.positions,z.color FROM source_zone z JOIN ranked r ON r.group_id=z.group_id;
