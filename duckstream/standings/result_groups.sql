WITH "members" AS (SELECT m.group_id,m.team_id,m.add_sub,m.bias,t.name AS team_name,p.id AS phase_id,
 p.sort,p.bonus_points,p.bonus_points_threshold,c.point_win,c.point_draw,c.point_loss
 FROM source_team_group m JOIN source_team t ON t.id=m.team_id
 JOIN source_stage_group g ON g.id=m.group_id JOIN source_phase p ON p.id=g.phase_id
 JOIN source_championship c ON c.id=p.championship_id)
SELECT CAST(result."id" AS VARCHAR) AS "id" FROM (SELECT DISTINCT group_id AS id FROM members) result;
