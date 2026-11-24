WITH "members" AS (SELECT t.group_id,t.team_id,t.add_sub,t.bias,n.id AS known_team,n.name,s.position,s.points,s.played
 FROM source_team_group t LEFT JOIN source_team n ON n.id=t.team_id
 LEFT JOIN source_standing s ON s.group_id=t.group_id AND s.team_id=t.team_id),
"positions" AS (SELECT DISTINCT group_id,position FROM members WHERE position IS NOT NULL),
"position_counts" AS (SELECT group_id,COUNT(*) AS distinct_count FROM positions GROUP BY group_id),
"ranked" AS (SELECT m.group_id FROM members m JOIN position_counts p ON p.group_id=m.group_id GROUP BY m.group_id,p.distinct_count
 HAVING COUNT(m.known_team)=COUNT(*) AND COUNT(m.position)=COUNT(*) AND p.distinct_count=COUNT(*) AND MIN(m.position)=1 AND MAX(m.position)=COUNT(*)),
"live" AS (SELECT DISTINCT t.group_id FROM source_team_group t JOIN source_stage_group g ON g.id=t.group_id
 JOIN source_game x ON x.phase_id=g.phase_id AND (t.team_id=x.home_id OR t.team_id=x.away_id)
 WHERE NOT x.played AND NOT x.withdrawn)
SELECT CAST(result."id" AS VARCHAR) AS "id", CAST(result."live" AS BOOLEAN) AS "live", CAST(result."sort" AS VARCHAR) AS "sort", CAST(result."bonus_points" AS INTEGER) AS "bonus_points", CAST(result."bonus_points_threshold" AS INTEGER) AS "bonus_points_threshold", CAST(result."win" AS INTEGER) AS "win", CAST(result."draw" AS INTEGER) AS "draw", CAST(result."loss" AS INTEGER) AS "loss" FROM (SELECT g.id,l.group_id IS NOT NULL AS live,p.sort,p.bonus_points,p.bonus_points_threshold,
 c.point_win AS win,c.point_draw AS draw,c.point_loss AS loss
 FROM source_stage_group g JOIN ranked r ON r.group_id=g.id
 JOIN source_phase p ON p.id=g.phase_id JOIN source_championship c ON c.id=p.championship_id
 LEFT JOIN live l ON l.group_id=g.id) result;
