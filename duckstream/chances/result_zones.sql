WITH "members" AS (SELECT t.group_id,t.team_id,t.add_sub,t.bias,n.id AS known_team,n.name,s.position,s.points,s.played
 FROM source_team_group t LEFT JOIN source_team n ON n.id=t.team_id
 LEFT JOIN source_standing s ON s.group_id=t.group_id AND s.team_id=t.team_id),
"positions" AS (SELECT DISTINCT group_id,position FROM members WHERE position IS NOT NULL),
"position_counts" AS (SELECT group_id,COUNT(*) AS distinct_count FROM positions GROUP BY group_id),
"ranked" AS (SELECT m.group_id FROM members m JOIN position_counts p ON p.group_id=m.group_id GROUP BY m.group_id,p.distinct_count
 HAVING COUNT(m.known_team)=COUNT(*) AND COUNT(m.position)=COUNT(*) AND p.distinct_count=COUNT(*) AND MIN(m.position)=1 AND MAX(m.position)=COUNT(*))
SELECT CAST(result."group_id" AS VARCHAR) AS "group_id", CAST(result."id" AS VARCHAR) AS "id", CAST(result."first" AS INTEGER) AS "first", CAST(result."last" AS INTEGER) AS "last", CAST(result."positions" AS VARCHAR) AS "positions", CAST(result."color" AS VARCHAR) AS "color" FROM (SELECT z.group_id,z.id,z.first,z.last,z.positions,z.color FROM source_zone z JOIN ranked r ON r.group_id=z.group_id) result;
