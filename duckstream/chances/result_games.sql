WITH "members" AS (SELECT t.group_id,t.team_id,t.add_sub,t.bias,n.id AS known_team,n.name,s.position,s.points,s.played
 FROM source_team_group t LEFT JOIN source_team n ON n.id=t.team_id
 LEFT JOIN source_standing s ON s.group_id=t.group_id AND s.team_id=t.team_id),
"positions" AS (SELECT DISTINCT group_id,position FROM members WHERE position IS NOT NULL),
"position_counts" AS (SELECT group_id,COUNT(*) AS distinct_count FROM positions GROUP BY group_id),
"ranked" AS (SELECT m.group_id FROM members m JOIN position_counts p ON p.group_id=m.group_id GROUP BY m.group_id,p.distinct_count
 HAVING COUNT(m.known_team)=COUNT(*) AND COUNT(m.position)=COUNT(*) AND p.distinct_count=COUNT(*) AND MIN(m.position)=1 AND MAX(m.position)=COUNT(*)),
"live" AS (SELECT DISTINCT t.group_id FROM source_team_group t JOIN source_stage_group g ON g.id=t.group_id
 JOIN source_game x ON x.phase_id=g.phase_id AND (t.team_id=x.home_id OR t.team_id=x.away_id)
 WHERE NOT x.played AND NOT x.withdrawn),
"pairs" AS (SELECT DISTINCT t.group_id,x.* FROM source_team_group t JOIN live l ON l.group_id=t.group_id
 JOIN ranked r ON r.group_id=t.group_id JOIN source_stage_group g ON g.id=t.group_id
 JOIN source_game x ON x.phase_id=g.phase_id AND (t.team_id=x.home_id OR t.team_id=x.away_id)
 WHERE x.played OR NOT x.withdrawn)
SELECT CAST(result."group_id" AS VARCHAR) AS "group_id", CAST(result."id" AS VARCHAR) AS "id", CAST(result."home_id" AS VARCHAR) AS "home_id", CAST(result."away_id" AS VARCHAR) AS "away_id", CAST(result."home_field" AS VARCHAR) AS "home_field", CAST(result."played" AS BOOLEAN) AS "played", CAST(result."home_score" AS INTEGER) AS "home_score", CAST(result."away_score" AS INTEGER) AS "away_score", CAST(result."home_off" AS DOUBLE) AS "home_off", CAST(result."home_def" AS DOUBLE) AS "home_def", CAST(result."away_off" AS DOUBLE) AS "away_off", CAST(result."away_def" AS DOUBLE) AS "away_def", CAST(result."__order" AS TIMESTAMP) AS "__order" FROM (SELECT p.group_id,p.id,p.home_id,p.away_id,p.home_field,p.played,
 COALESCE(p.home_score,0) AS home_score,COALESCE(p.away_score,0) AS away_score,
 h.offense AS home_off,h.defense AS home_def,a.offense AS away_off,a.defense AS away_def,p.moment AS __order
 FROM pairs p
 ASOF LEFT JOIN source_team_rating h ON (p.home_key_0=h.team_key_0 AND p.home_key_1=h.team_key_1 AND p.home_key_2=h.team_key_2 AND p.home_key_3=h.team_key_3) AND (p.moment>=h.moment) ASOF LEFT JOIN source_team_rating a ON (p.away_key_0=a.team_key_0 AND p.away_key_1=a.team_key_1 AND p.away_key_2=a.team_key_2 AND p.away_key_3=a.team_key_3) AND (p.moment>=a.moment) ) result;
