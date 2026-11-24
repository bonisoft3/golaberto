WITH "members" AS (SELECT t.group_id,t.team_id,t.add_sub,t.bias,n.id AS known_team,n.name,s.position,s.points,s.played
 FROM source_team_group t LEFT JOIN source_team n ON n.id=t.team_id
 LEFT JOIN source_standing s ON s.group_id=t.group_id AND s.team_id=t.team_id),
"positions" AS (SELECT DISTINCT group_id,position FROM members WHERE position IS NOT NULL),
"position_counts" AS (SELECT group_id,COUNT(*) AS distinct_count FROM positions GROUP BY group_id),
"ranked" AS (SELECT m.group_id FROM members m JOIN position_counts p ON p.group_id=m.group_id GROUP BY m.group_id,p.distinct_count
 HAVING COUNT(m.known_team)=COUNT(*) AND COUNT(m.position)=COUNT(*) AND p.distinct_count=COUNT(*) AND MIN(m.position)=1 AND MAX(m.position)=COUNT(*))
SELECT CAST(result."group_id" AS VARCHAR) AS "group_id", CAST(result."team_id" AS VARCHAR) AS "team_id", CAST(result."name" AS VARCHAR) AS "name", CAST(result."add_sub" AS INTEGER) AS "add_sub", CAST(result."bias" AS INTEGER) AS "bias", CAST(result."position" AS INTEGER) AS "position", CAST(result."points" AS INTEGER) AS "points", CAST(result."played" AS INTEGER) AS "played" FROM (SELECT m.group_id,m.team_id,m.name,m.add_sub,m.bias,m.position,m.points,m.played
 FROM members m JOIN ranked r ON r.group_id=m.group_id) result;
