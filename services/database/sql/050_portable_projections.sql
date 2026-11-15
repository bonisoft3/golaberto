SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE OR REPLACE FUNCTION refresh_standings() RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp SET work_mem = '1MB' SET hash_mem_multiplier = 1 AS $$
BEGIN
  PERFORM take_team_projection_turn();
  WITH members AS MATERIALIZED (
    SELECT m.group_id, m.team_id, m.add_sub, m.bias, t.name AS team_name,
      p.id AS phase_id, p.sort, p.bonus_points, p.bonus_points_threshold,
      c.point_win, c.point_draw, c.point_loss
    FROM team_group m JOIN team t ON t.id = m.team_id
    JOIN stage_group g ON g.id = m.group_id JOIN phase p ON p.id = g.phase_id
    JOIN championship c ON c.id = p.championship_id
  ), sides AS MATERIALIZED (
    SELECT m.group_id, m.team_id, g.id, g.day, g.kickoff,
      CASE WHEN g.home_id = m.team_id THEN g.away_id ELSE g.home_id END AS opponent,
      s.gf, s.ga, CASE WHEN g.home_id = m.team_id THEN 0 ELSE s.gf END AS away_goals,
      COALESCE(CASE WHEN g.home_id = m.team_id THEN g.home_aet ELSE g.away_aet END, 0) AS aet,
      COALESCE(CASE WHEN g.home_id = m.team_id THEN g.home_pen ELSE g.away_pen END, 0) AS pen,
      CASE WHEN s.gf > s.ga THEN 'w' WHEN s.gf < s.ga THEN 'l' ELSE 'd' END AS result,
      CASE WHEN s.gf > s.ga THEN m.point_win + CASE WHEN m.bonus_points > 0 AND s.gf - s.ga >= m.bonus_points_threshold THEN m.bonus_points ELSE 0 END
        WHEN s.gf < s.ga THEN m.point_loss ELSE m.point_draw END AS points
    FROM members m JOIN game g ON g.phase_id = m.phase_id AND g.played
      AND (g.home_id = m.team_id OR g.away_id = m.team_id)
    CROSS JOIN LATERAL (SELECT
      CASE WHEN g.home_id = m.team_id THEN g.home_score ELSE g.away_score END AS gf,
      CASE WHEN g.home_id = m.team_id THEN g.away_score ELSE g.home_score END AS ga) s
  ), campaigns AS MATERIALIZED (
    SELECT m.*, COALESCE(s.points, 0) + m.add_sub AS points,
      COALESCE(s.played, 0) AS played, COALESCE(s.wins, 0) AS wins,
      COALESCE(s.draws, 0) AS draws, COALESCE(s.losses, 0) AS losses,
      COALESCE(s.gf, 0) AS goals_for, COALESCE(s.ga, 0) AS goals_against,
      COALESCE(s.gf, 0) - COALESCE(s.ga, 0) AS goal_diff,
      COALESCE(s.away_goals, 0) AS goals_away, COALESCE(s.aet, 0) AS goals_aet,
      COALESCE(s.pen, 0) AS goals_pen, COALESCE(s.form, ARRAY[]::text[]) AS form
    FROM members m LEFT JOIN (
      SELECT group_id, team_id, sum(points) AS points, count(*) AS played,
        count(*) FILTER (WHERE result = 'w') AS wins, count(*) FILTER (WHERE result = 'd') AS draws,
        count(*) FILTER (WHERE result = 'l') AS losses, sum(gf) AS gf, sum(ga) AS ga,
        sum(away_goals) AS away_goals, sum(aet) AS aet, sum(pen) AS pen,
        array_agg(result ORDER BY day, kickoff NULLS FIRST, id) AS form
      FROM sides GROUP BY group_id, team_id
    ) s USING (group_id, team_id)
  ), head_points AS (
    SELECT c.group_id,c.team_id,sum(s.points) AS points
    FROM campaigns c JOIN sides s ON s.group_id=c.group_id AND s.team_id=c.team_id
    JOIN campaigns opponent ON opponent.group_id=c.group_id AND opponent.team_id=s.opponent AND opponent.points=c.points
    WHERE 'head'=ANY(string_to_array(c.sort,','))
    GROUP BY c.group_id,c.team_id
  ), headed AS (
    SELECT c.*, CASE WHEN count(*) OVER all_members <= 2 OR count(*) OVER level_members = count(*) OVER all_members THEN 0
      ELSE COALESCE(h.points,0) + c.add_sub END AS head
    FROM campaigns c LEFT JOIN head_points h USING(group_id,team_id)
    WINDOW all_members AS (PARTITION BY c.group_id), level_members AS (PARTITION BY c.group_id,c.points)
  ), keyed AS (
    SELECT c.*, ARRAY(SELECT CASE WHEN key = 'name' THEN c.team_name::text
      WHEN key IN ('pt','w','gd','gf','g_away','gp','g_aet','bias','g_average','head') THEN
        (9000000000000 - round(1000000 * CASE key
          WHEN 'pt' THEN c.points WHEN 'w' THEN c.wins WHEN 'gd' THEN c.goal_diff
          WHEN 'gf' THEN c.goals_for WHEN 'g_away' THEN c.goals_away WHEN 'gp' THEN c.goals_pen
          WHEN 'g_aet' THEN c.goals_aet WHEN 'bias' THEN c.bias WHEN 'head' THEN c.head
          WHEN 'g_average' THEN CASE WHEN c.goals_against = 0 AND c.goals_for > 0 THEN 1000 + c.goals_for
            ELSE c.goals_for / (c.goals_against + 0.0000001) END END))::bigint::text
      ELSE '' END FROM unnest(string_to_array(c.sort, ',')) WITH ORDINALITY AS ladder(key, ordinal)
      ORDER BY ordinal) AS ladder
    FROM headed c
  ), ranked AS (
    SELECT *, row_number() OVER (PARTITION BY group_id ORDER BY ladder COLLATE "C", team_id) AS position FROM keyed
  ), selected AS MATERIALIZED (
    SELECT r.group_id::text || ':' || r.team_id::text AS id, r.group_id, r.team_id, r.team_name,
      r.position, r.points, r.played, r.wins, r.draws, r.losses, r.goals_for, r.goals_against, r.goal_diff,
      COALESCE(r.form[cardinality(r.form)-4], '') AS form1,
      COALESCE(r.form[cardinality(r.form)-3], '') AS form2,
      COALESCE(r.form[cardinality(r.form)-2], '') AS form3,
      COALESCE(r.form[cardinality(r.form)-1], '') AS form4,
      COALESCE(r.form[cardinality(r.form)], '') AS form5,
      COALESCE((SELECT z.color FROM zone z WHERE z.group_id = r.group_id AND
        CASE WHEN COALESCE(z.positions, '') <> '' THEN r.position::text = ANY(string_to_array(z.positions, ','))
        ELSE r.position BETWEEN z.first AND z.last END ORDER BY z.last-z.first, z.id LIMIT 1), '') AS zone
    FROM ranked r
  ), removed AS (
    DELETE FROM standing sink WHERE NOT EXISTS (SELECT 1 FROM selected s WHERE s.id = sink.id)
  )
  INSERT INTO standing AS sink (id, group_id, team_id, team_name, position, points, played, wins, draws, losses,
    goals_for, goals_against, goal_diff, form1, form2, form3, form4, form5, zone)
  SELECT id, group_id, team_id, team_name, position, points, played, wins, draws, losses,
    goals_for, goals_against, goal_diff, form1, form2, form3, form4, form5, zone FROM selected incoming
  WHERE NOT EXISTS (SELECT 1 FROM standing existing WHERE existing.id=incoming.id
    AND (existing.group_id,existing.team_id,existing.team_name,existing.position,existing.points,existing.played,existing.wins,existing.draws,existing.losses,
    existing.goals_for,existing.goals_against,existing.goal_diff,existing.form1,existing.form2,existing.form3,existing.form4,existing.form5,existing.zone)
    IS NOT DISTINCT FROM (incoming.group_id,incoming.team_id,incoming.team_name,incoming.position,incoming.points,
    incoming.played,incoming.wins,incoming.draws,incoming.losses,incoming.goals_for,incoming.goals_against,
    incoming.goal_diff,incoming.form1,incoming.form2,incoming.form3,incoming.form4,incoming.form5,incoming.zone))
  ON CONFLICT (id) DO UPDATE SET group_id=EXCLUDED.group_id, team_id=EXCLUDED.team_id,
    team_name=EXCLUDED.team_name, position=EXCLUDED.position, points=EXCLUDED.points, played=EXCLUDED.played,
    wins=EXCLUDED.wins, draws=EXCLUDED.draws, losses=EXCLUDED.losses, goals_for=EXCLUDED.goals_for,
    goals_against=EXCLUDED.goals_against, goal_diff=EXCLUDED.goal_diff, form1=EXCLUDED.form1,
    form2=EXCLUDED.form2, form3=EXCLUDED.form3, form4=EXCLUDED.form4, form5=EXCLUDED.form5, zone=EXCLUDED.zone
  WHERE (sink.group_id,sink.team_id,sink.team_name,sink.position,sink.points,sink.played,sink.wins,sink.draws,sink.losses,
    sink.goals_for,sink.goals_against,sink.goal_diff,sink.form1,sink.form2,sink.form3,sink.form4,sink.form5,sink.zone)
    IS DISTINCT FROM (EXCLUDED.group_id,EXCLUDED.team_id,EXCLUDED.team_name,EXCLUDED.position,EXCLUDED.points,
    EXCLUDED.played,EXCLUDED.wins,EXCLUDED.draws,EXCLUDED.losses,EXCLUDED.goals_for,EXCLUDED.goals_against,
    EXCLUDED.goal_diff,EXCLUDED.form1,EXCLUDED.form2,EXCLUDED.form3,EXCLUDED.form4,EXCLUDED.form5,EXCLUDED.zone);
END $$;

CREATE OR REPLACE FUNCTION refresh_game_cards() RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp SET work_mem = '1MB' SET hash_mem_multiplier = 1 AS $$
BEGIN
  PERFORM take_team_projection_turn();
  WITH selected AS MATERIALIZED (
    SELECT g.id,g.phase_id,p.championship_id,g.round,g.day,g.kickoff,g.played,g.home_id,g.away_id,
      h.name AS home_name,a.name AS away_name,g.home_score,g.away_score,g.home_aet,g.away_aet,g.home_pen,g.away_pen,
      c.full_name AS championship_name,p.name AS phase_name,g.stadium_id,s.name AS stadium_name,
      g.referee_id,r.name AS referee_name,g.attendance
    FROM game g JOIN phase p ON p.id=g.phase_id JOIN championship c ON c.id=p.championship_id
      JOIN team h ON h.id=g.home_id JOIN team a ON a.id=g.away_id
      LEFT JOIN stadium s ON s.id=g.stadium_id LEFT JOIN referee r ON r.id=g.referee_id
  ), removed AS (
    DELETE FROM game_card sink WHERE NOT EXISTS (SELECT 1 FROM selected s WHERE s.id=sink.id)
  )
  INSERT INTO game_card AS sink (id,phase_id,championship_id,round,day,kickoff,played,home_id,away_id,home_name,away_name,
    home_score,away_score,home_aet,away_aet,home_pen,away_pen,championship_name,phase_name,stadium_id,stadium_name,referee_id,referee_name,attendance)
  SELECT id,phase_id,championship_id,round,day,kickoff,played,home_id,away_id,home_name,away_name,
    home_score,away_score,home_aet,away_aet,home_pen,away_pen,championship_name,phase_name,stadium_id,stadium_name,referee_id,referee_name,attendance FROM selected incoming
  WHERE NOT EXISTS (SELECT 1 FROM game_card existing WHERE existing.id=incoming.id
    AND (existing.phase_id,existing.championship_id,existing.round,existing.day,existing.kickoff,existing.played,existing.home_id,existing.away_id,
    existing.home_name,existing.away_name,existing.home_score,existing.away_score,existing.home_aet,existing.away_aet,existing.home_pen,existing.away_pen,
    existing.championship_name,existing.phase_name,existing.stadium_id,existing.stadium_name,existing.referee_id,existing.referee_name,existing.attendance)
    IS NOT DISTINCT FROM (incoming.phase_id,incoming.championship_id,incoming.round,incoming.day,incoming.kickoff,incoming.played,
    incoming.home_id,incoming.away_id,incoming.home_name,incoming.away_name,incoming.home_score,incoming.away_score,
    incoming.home_aet,incoming.away_aet,incoming.home_pen,incoming.away_pen,incoming.championship_name,incoming.phase_name,
    incoming.stadium_id,incoming.stadium_name,incoming.referee_id,incoming.referee_name,incoming.attendance))
  ON CONFLICT(id) DO UPDATE SET phase_id=EXCLUDED.phase_id,championship_id=EXCLUDED.championship_id,round=EXCLUDED.round,
    day=EXCLUDED.day,kickoff=EXCLUDED.kickoff,played=EXCLUDED.played,home_id=EXCLUDED.home_id,away_id=EXCLUDED.away_id,
    home_name=EXCLUDED.home_name,away_name=EXCLUDED.away_name,home_score=EXCLUDED.home_score,away_score=EXCLUDED.away_score,
    home_aet=EXCLUDED.home_aet,away_aet=EXCLUDED.away_aet,home_pen=EXCLUDED.home_pen,away_pen=EXCLUDED.away_pen,
    championship_name=EXCLUDED.championship_name,phase_name=EXCLUDED.phase_name,stadium_id=EXCLUDED.stadium_id,
    stadium_name=EXCLUDED.stadium_name,referee_id=EXCLUDED.referee_id,referee_name=EXCLUDED.referee_name,attendance=EXCLUDED.attendance
  WHERE (sink.phase_id,sink.championship_id,sink.round,sink.day,sink.kickoff,sink.played,sink.home_id,sink.away_id,
    sink.home_name,sink.away_name,sink.home_score,sink.away_score,sink.home_aet,sink.away_aet,sink.home_pen,sink.away_pen,
    sink.championship_name,sink.phase_name,sink.stadium_id,sink.stadium_name,sink.referee_id,sink.referee_name,sink.attendance)
    IS DISTINCT FROM (EXCLUDED.phase_id,EXCLUDED.championship_id,EXCLUDED.round,EXCLUDED.day,EXCLUDED.kickoff,EXCLUDED.played,
    EXCLUDED.home_id,EXCLUDED.away_id,EXCLUDED.home_name,EXCLUDED.away_name,EXCLUDED.home_score,EXCLUDED.away_score,
    EXCLUDED.home_aet,EXCLUDED.away_aet,EXCLUDED.home_pen,EXCLUDED.away_pen,EXCLUDED.championship_name,EXCLUDED.phase_name,
    EXCLUDED.stadium_id,EXCLUDED.stadium_name,EXCLUDED.referee_id,EXCLUDED.referee_name,EXCLUDED.attendance);

  WITH selected AS MATERIALIZED (
    SELECT side.team_id::text || ':' || g.id::text AS id,side.team_id,g.id AS game_id,side.side,side.opponent_id,
      opponent.name AS opponent_name,p.championship_id,c.full_name AS championship_name,g.day,g.kickoff,g.played,
      side.gf AS goals_for,side.ga AS goals_against,
      CASE WHEN NOT g.played THEN '' WHEN side.gf > side.ga THEN 'w' WHEN side.gf < side.ga THEN 'l' ELSE 'd' END AS result
    FROM game g JOIN phase p ON p.id=g.phase_id JOIN championship c ON c.id=p.championship_id
    CROSS JOIN LATERAL (VALUES ('home',g.home_id,g.away_id,g.home_score,g.away_score),
      ('away',g.away_id,g.home_id,g.away_score,g.home_score)) side(side,team_id,opponent_id,gf,ga)
    JOIN team opponent ON opponent.id=side.opponent_id
  ), removed AS (
    DELETE FROM team_game sink WHERE NOT EXISTS (SELECT 1 FROM selected s WHERE s.id=sink.id)
  )
  INSERT INTO team_game AS sink (id,team_id,game_id,side,opponent_id,opponent_name,championship_id,championship_name,
    day,kickoff,played,goals_for,goals_against,result)
  SELECT id,team_id,game_id,side,opponent_id,opponent_name,championship_id,championship_name,
    day,kickoff,played,goals_for,goals_against,result FROM selected incoming
  WHERE NOT EXISTS (SELECT 1 FROM team_game existing WHERE existing.id=incoming.id
    AND (existing.team_id,existing.game_id,existing.side,existing.opponent_id,existing.opponent_name,existing.championship_id,existing.championship_name,
    existing.day,existing.kickoff,existing.played,existing.goals_for,existing.goals_against,existing.result)
    IS NOT DISTINCT FROM (incoming.team_id,incoming.game_id,incoming.side,incoming.opponent_id,incoming.opponent_name,
    incoming.championship_id,incoming.championship_name,incoming.day,incoming.kickoff,incoming.played,
    incoming.goals_for,incoming.goals_against,incoming.result))
  ON CONFLICT(id) DO UPDATE SET team_id=EXCLUDED.team_id,game_id=EXCLUDED.game_id,side=EXCLUDED.side,
    opponent_id=EXCLUDED.opponent_id,opponent_name=EXCLUDED.opponent_name,championship_id=EXCLUDED.championship_id,
    championship_name=EXCLUDED.championship_name,day=EXCLUDED.day,kickoff=EXCLUDED.kickoff,played=EXCLUDED.played,
    goals_for=EXCLUDED.goals_for,goals_against=EXCLUDED.goals_against,result=EXCLUDED.result
  WHERE (sink.team_id,sink.game_id,sink.side,sink.opponent_id,sink.opponent_name,sink.championship_id,sink.championship_name,
    sink.day,sink.kickoff,sink.played,sink.goals_for,sink.goals_against,sink.result)
    IS DISTINCT FROM (EXCLUDED.team_id,EXCLUDED.game_id,EXCLUDED.side,EXCLUDED.opponent_id,EXCLUDED.opponent_name,
    EXCLUDED.championship_id,EXCLUDED.championship_name,EXCLUDED.day,EXCLUDED.kickoff,EXCLUDED.played,
    EXCLUDED.goals_for,EXCLUDED.goals_against,EXCLUDED.result);
END $$;

CREATE OR REPLACE FUNCTION refresh_player_stats() RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp SET work_mem = '1MB' SET hash_mem_multiplier = 1 AS $$
BEGIN
  PERFORM take_team_projection_turn();
  WITH events AS (
    SELECT p.championship_id,a.player_id,CASE WHEN a.side='home' THEN g.home_id ELSE g.away_id END AS team_id,
      CASE WHEN a.bench THEN 0 ELSE 1 END AS played,
      CASE WHEN NOT a.bench AND a.on_minute=0 THEN 1 ELSE 0 END AS started,
      CASE WHEN NOT a.bench AND a.on_minute>0 THEN 1 ELSE 0 END AS came_on,
      CASE WHEN a.bench THEN 1 ELSE 0 END AS bench,
      CASE WHEN a.bench THEN 0 ELSE greatest(COALESCE(a.off_minute,greatest(a.on_minute,90))-a.on_minute,0) END AS minutes,
      0 AS goals,0 AS penalties,0 AS own_goals,CASE WHEN a.yellow THEN 1 ELSE 0 END AS yellow,CASE WHEN a.red THEN 1 ELSE 0 END AS red
    FROM player_game a JOIN game g ON g.id=a.game_id JOIN phase p ON p.id=g.phase_id
    UNION ALL
    SELECT p.championship_id,q.player_id,CASE WHEN (q.side='home') <> q.own_goal THEN g.home_id ELSE g.away_id END,
      0,0,0,0,0,CASE WHEN q.own_goal THEN 0 ELSE 1 END,CASE WHEN q.penalty AND NOT q.own_goal THEN 1 ELSE 0 END,
      CASE WHEN q.own_goal THEN 1 ELSE 0 END,0,0
    FROM goal q JOIN game g ON g.id=q.game_id JOIN phase p ON p.id=g.phase_id
  ), counters AS (
    SELECT championship_id,player_id,team_id,sum(played) AS played,sum(started) AS started,sum(came_on) AS came_on,
      sum(bench) AS bench,sum(minutes) AS minutes,sum(goals) AS goals,sum(penalties) AS penalties,
      sum(own_goals) AS own_goals,sum(yellow) AS yellow,sum(red) AS red
    FROM events GROUP BY championship_id,player_id,team_id
  ), selected AS MATERIALIZED (
    SELECT s.championship_id::text || ':' || s.team_id::text || ':' || s.player_id::text AS id,
      s.*,p.name AS player_name,COALESCE(p.position,'') AS position,c.full_name AS championship_name,t.name AS team_name
    FROM counters s JOIN player p ON p.id=s.player_id JOIN team t ON t.id=s.team_id JOIN championship c ON c.id=s.championship_id
  ), removed AS (
    DELETE FROM player_stat sink WHERE NOT EXISTS (SELECT 1 FROM selected s WHERE s.id=sink.id)
  )
  INSERT INTO player_stat AS sink (id,championship_id,team_id,player_id,player_name,position,played,started,came_on,bench,
    minutes,goals,penalties,own_goals,yellow,red,championship_name,team_name)
  SELECT id,championship_id,team_id,player_id,player_name,position,played,started,came_on,bench,
    minutes,goals,penalties,own_goals,yellow,red,championship_name,team_name FROM selected incoming
  WHERE NOT EXISTS (SELECT 1 FROM player_stat existing WHERE existing.id=incoming.id
    AND (existing.championship_id,existing.team_id,existing.player_id,existing.player_name,existing.position,existing.played,existing.started,existing.came_on,
    existing.bench,existing.minutes,existing.goals,existing.penalties,existing.own_goals,existing.yellow,existing.red,existing.championship_name,existing.team_name)
    IS NOT DISTINCT FROM (incoming.championship_id,incoming.team_id,incoming.player_id,incoming.player_name,incoming.position,
    incoming.played,incoming.started,incoming.came_on,incoming.bench,incoming.minutes,incoming.goals,incoming.penalties,
    incoming.own_goals,incoming.yellow,incoming.red,incoming.championship_name,incoming.team_name))
  ON CONFLICT(id) DO UPDATE SET championship_id=EXCLUDED.championship_id,team_id=EXCLUDED.team_id,player_id=EXCLUDED.player_id,
    player_name=EXCLUDED.player_name,position=EXCLUDED.position,played=EXCLUDED.played,started=EXCLUDED.started,
    came_on=EXCLUDED.came_on,bench=EXCLUDED.bench,minutes=EXCLUDED.minutes,goals=EXCLUDED.goals,penalties=EXCLUDED.penalties,
    own_goals=EXCLUDED.own_goals,yellow=EXCLUDED.yellow,red=EXCLUDED.red,championship_name=EXCLUDED.championship_name,team_name=EXCLUDED.team_name
  WHERE (sink.championship_id,sink.team_id,sink.player_id,sink.player_name,sink.position,sink.played,sink.started,sink.came_on,
    sink.bench,sink.minutes,sink.goals,sink.penalties,sink.own_goals,sink.yellow,sink.red,sink.championship_name,sink.team_name)
    IS DISTINCT FROM (EXCLUDED.championship_id,EXCLUDED.team_id,EXCLUDED.player_id,EXCLUDED.player_name,EXCLUDED.position,
    EXCLUDED.played,EXCLUDED.started,EXCLUDED.came_on,EXCLUDED.bench,EXCLUDED.minutes,EXCLUDED.goals,EXCLUDED.penalties,
    EXCLUDED.own_goals,EXCLUDED.yellow,EXCLUDED.red,EXCLUDED.championship_name,EXCLUDED.team_name);
END $$;

CREATE OR REPLACE FUNCTION refresh_phase_rounds() RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp SET work_mem = '1MB' SET hash_mem_multiplier = 1 AS $$
BEGIN
  PERFORM take_team_projection_turn();
  WITH current_round AS (
    SELECT g.phase_id,COALESCE(max(g.round) FILTER (WHERE g.played),min(g.round)) AS current
    FROM game g JOIN phase p ON p.id=g.phase_id WHERE g.round IS NOT NULL GROUP BY g.phase_id
  ), selected AS MATERIALIZED (
    SELECT r.phase_id::text AS id,r.phase_id,r.current,
      (SELECT min(g.round) FROM game g WHERE g.phase_id=r.phase_id AND g.round>r.current) AS next FROM current_round r
  ), removed AS (
    DELETE FROM phase_round sink WHERE NOT EXISTS (SELECT 1 FROM selected s WHERE s.id=sink.id)
  )
  INSERT INTO phase_round AS sink (id,phase_id,current,next) SELECT id,phase_id,current,next FROM selected incoming
  WHERE NOT EXISTS (SELECT 1 FROM phase_round existing WHERE existing.id=incoming.id
    AND (existing.phase_id,existing.current,existing.next)
    IS NOT DISTINCT FROM (incoming.phase_id,incoming.current,incoming.next))
  ON CONFLICT(id) DO UPDATE SET phase_id=EXCLUDED.phase_id,current=EXCLUDED.current,next=EXCLUDED.next
  WHERE (sink.phase_id,sink.current,sink.next) IS DISTINCT FROM (EXCLUDED.phase_id,EXCLUDED.current,EXCLUDED.next);
END $$;

REVOKE ALL ON FUNCTION refresh_standings(),refresh_game_cards(),refresh_player_stats(),refresh_phase_rounds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_standings(),refresh_game_cards(),refresh_player_stats(),refresh_phase_rounds() TO service;

NOTIFY pgrst, 'reload schema';
