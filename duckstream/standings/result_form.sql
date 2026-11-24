WITH "members" AS (SELECT m.group_id,m.team_id,m.add_sub,m.bias,t.name AS team_name,p.id AS phase_id,
 p.sort,p.bonus_points,p.bonus_points_threshold,c.point_win,c.point_draw,c.point_loss
 FROM source_team_group m JOIN source_team t ON t.id=m.team_id
 JOIN source_stage_group g ON g.id=m.group_id JOIN source_phase p ON p.id=g.phase_id
 JOIN source_championship c ON c.id=p.championship_id),
"scores" AS (SELECT m.group_id,m.team_id,g.id,g.day,g.kickoff,
 CASE WHEN g.home_id=m.team_id THEN g.away_id ELSE g.home_id END AS opponent,
 CASE WHEN g.home_id=m.team_id THEN g.home_score ELSE g.away_score END AS gf,
 CASE WHEN g.home_id=m.team_id THEN g.away_score ELSE g.home_score END AS ga,
 CASE WHEN g.home_id=m.team_id THEN 0 ELSE g.away_score END AS away_goals,
 COALESCE(CASE WHEN g.home_id=m.team_id THEN g.home_aet ELSE g.away_aet END,0) AS aet,
 COALESCE(CASE WHEN g.home_id=m.team_id THEN g.home_pen ELSE g.away_pen END,0) AS pen,
 m.point_win,m.point_draw,m.point_loss,m.bonus_points,m.bonus_points_threshold
 FROM members m JOIN source_game g ON g.phase_id=m.phase_id AND g.played
 AND (g.home_id=m.team_id OR g.away_id=m.team_id)),
"sides" AS (SELECT group_id,team_id,id,day,kickoff,opponent,gf,ga,away_goals,aet,pen,
 CAST(CASE WHEN gf>ga THEN 'w' WHEN gf<ga THEN 'l' ELSE 'd' END AS VARCHAR) AS result,
 CASE WHEN gf>ga THEN point_win+CASE WHEN bonus_points>0 AND gf-ga>=bonus_points_threshold THEN bonus_points ELSE 0 END
 WHEN gf<ga THEN point_loss ELSE point_draw END AS points
 FROM scores)
SELECT CAST(result."group_id" AS VARCHAR) AS "group_id", CAST(result."team_id" AS VARCHAR) AS "team_id", CAST(result."id" AS VARCHAR) AS "id", CAST(result."day" AS VARCHAR) AS "day", CAST(result."kickoff" AS VARCHAR) AS "kickoff", CAST(result."result" AS VARCHAR) AS "result" FROM (SELECT group_id,team_id,id,day,kickoff,result FROM sides) result;
