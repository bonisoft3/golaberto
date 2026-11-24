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
 FROM scores),
"totals" AS (SELECT group_id,team_id,CAST(SUM(points) AS INTEGER) AS points,CAST(COUNT(*) AS INTEGER) AS played,
 CAST(SUM(CASE WHEN result='w' THEN 1 ELSE 0 END) AS INTEGER) AS wins,
 CAST(SUM(CASE WHEN result='d' THEN 1 ELSE 0 END) AS INTEGER) AS draws,
 CAST(SUM(CASE WHEN result='l' THEN 1 ELSE 0 END) AS INTEGER) AS losses,
 CAST(SUM(gf) AS INTEGER) AS gf,CAST(SUM(ga) AS INTEGER) AS ga,
 CAST(SUM(away_goals) AS INTEGER) AS away_goals,CAST(SUM(aet) AS INTEGER) AS aet,CAST(SUM(pen) AS INTEGER) AS pen
 FROM sides GROUP BY group_id,team_id),
"campaigns" AS (SELECT m.group_id,m.team_id,m.team_name,m.add_sub,m.bias,m.sort,
 COALESCE(s.points,0)+m.add_sub AS points,COALESCE(s.played,0) AS played,
 COALESCE(s.wins,0) AS wins,COALESCE(s.draws,0) AS draws,COALESCE(s.losses,0) AS losses,
 COALESCE(s.gf,0) AS goals_for,COALESCE(s.ga,0) AS goals_against,
 COALESCE(s.gf,0)-COALESCE(s.ga,0) AS goal_diff,COALESCE(s.away_goals,0) AS goals_away,
 COALESCE(s.aet,0) AS goals_aet,COALESCE(s.pen,0) AS goals_pen
 FROM members m LEFT JOIN totals s ON s.group_id=m.group_id AND s.team_id=m.team_id),
"head_points" AS (SELECT c.group_id,c.team_id,CAST(SUM(s.points) AS INTEGER) AS points
 FROM campaigns c JOIN sides s ON s.group_id=c.group_id AND s.team_id=c.team_id
 JOIN campaigns o ON o.group_id=c.group_id AND o.team_id=s.opponent AND o.points=c.points
 GROUP BY c.group_id,c.team_id)
SELECT CAST(result."group_id" AS VARCHAR) AS "group_id", CAST(result."team_id" AS VARCHAR) AS "team_id", CAST(result."team_name" AS VARCHAR) AS "team_name", CAST(result."add_sub" AS INTEGER) AS "add_sub", CAST(result."bias" AS INTEGER) AS "bias", CAST(result."sort" AS VARCHAR) AS "sort", CAST(result."points" AS INTEGER) AS "points", CAST(result."played" AS INTEGER) AS "played", CAST(result."wins" AS INTEGER) AS "wins", CAST(result."draws" AS INTEGER) AS "draws", CAST(result."losses" AS INTEGER) AS "losses", CAST(result."goals_for" AS INTEGER) AS "goals_for", CAST(result."goals_against" AS INTEGER) AS "goals_against", CAST(result."goal_diff" AS INTEGER) AS "goal_diff", CAST(result."goals_away" AS INTEGER) AS "goals_away", CAST(result."goals_aet" AS INTEGER) AS "goals_aet", CAST(result."goals_pen" AS INTEGER) AS "goals_pen", CAST(result."head_points" AS INTEGER) AS "head_points" FROM (SELECT c.*,COALESCE(h.points,0)+c.add_sub AS head_points FROM campaigns c
 LEFT JOIN head_points h ON h.group_id=c.group_id AND h.team_id=c.team_id) result;
