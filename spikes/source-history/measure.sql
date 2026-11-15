BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout = '10min';
SET LOCAL timezone = 'UTC';
CREATE TEMP TABLE ranked AS
SELECT t.group_id
FROM team_group t LEFT JOIN team n ON n.id=t.team_id
LEFT JOIN standing s ON s.group_id=t.group_id AND s.team_id=t.team_id
GROUP BY t.group_id
HAVING count(n.id)=count(*) AND count(s.position)=count(*)
  AND count(DISTINCT s.position)=count(*) AND min(s.position)=1 AND max(s.position)=count(*);
CREATE TEMP TABLE live AS
SELECT DISTINCT t.group_id FROM team_group t JOIN ranked r USING(group_id)
JOIN stage_group g ON g.id=t.group_id
JOIN game x ON x.phase_id=g.phase_id AND (t.team_id=x.home_id OR t.team_id=x.away_id)
WHERE NOT x.played AND coalesce(x.sync_status,'scheduled') NOT IN ('cancelled','abandoned','awarded');
CREATE TEMP TABLE relevant_games AS
SELECT DISTINCT x.id,x.home_id,x.away_id,x.played,
  coalesce(x.kickoff::timestamptz AT TIME ZONE 'UTC',x.day::date::timestamp) AS moment
FROM team_group t JOIN live l USING(group_id) JOIN stage_group g ON g.id=t.group_id
JOIN game x ON x.phase_id=g.phase_id AND (t.team_id=x.home_id OR t.team_id=x.away_id)
WHERE x.played OR coalesce(x.sync_status,'scheduled') NOT IN ('cancelled','abandoned','awarded');
CREATE TEMP TABLE requests AS
SELECT DISTINCT side.team_id,g.moment FROM relevant_games g
CROSS JOIN LATERAL (VALUES(g.home_id),(g.away_id)) side(team_id);
CREATE TEMP TABLE chosen AS
SELECT q.team_id,q.moment,r.id,r.offense::real AS offense,r.defense::real AS defense,
  latest.id AS latest_id,latest.offense::real AS latest_offense,latest.defense::real AS latest_defense
FROM requests q
LEFT JOIN LATERAL (
 SELECT id,offense,defense FROM team_rating r WHERE r.team_id=q.team_id
   AND r.measure_date<=q.moment::date AND r.measure_date::timestamp<q.moment
 ORDER BY r.measure_date DESC,r.id LIMIT 1
) r ON true
LEFT JOIN LATERAL (
 SELECT id,offense,defense FROM team_rating r WHERE r.team_id=q.team_id
 ORDER BY r.measure_date DESC,r.id LIMIT 1
) latest ON true;
CREATE TEMP TABLE retained AS
SELECT r.* FROM team_rating r JOIN (SELECT DISTINCT id FROM chosen WHERE id IS NOT NULL) c USING(id);
-- This private temporary relation has no concurrent writers.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX ON retained(team_id,measure_date DESC,id);
CREATE TEMP TABLE compacted AS
SELECT q.team_id,q.moment,r.id,r.offense::real AS offense,r.defense::real AS defense
FROM requests q LEFT JOIN LATERAL (
 SELECT id,offense,defense FROM retained r WHERE r.team_id=q.team_id
   AND r.measure_date<=q.moment::date AND r.measure_date::timestamp<q.moment
 ORDER BY r.measure_date DESC,r.id LIMIT 1
) r ON true;
SELECT jsonb_build_object(
 'ambiguous_team_days',(SELECT count(*) FROM (
   SELECT team_id,measure_date FROM team_rating GROUP BY team_id,measure_date HAVING count(*)>1
 ) duplicates),
 'compacted_snapshot_mismatches',(SELECT count(*) FROM (
   (SELECT team_id,moment,id,offense,defense FROM chosen EXCEPT ALL SELECT * FROM compacted)
   UNION ALL
   (SELECT * FROM compacted EXCEPT ALL SELECT team_id,moment,id,offense,defense FROM chosen)
 ) difference)
) AS snapshot_equivalence;
SELECT jsonb_build_object(
 'rating_rows',(SELECT count(*) FROM team_rating),
 'teams',(SELECT count(*) FROM team),
 'ranked_groups',(SELECT count(*) FROM ranked),
 'live_ranked_groups',(SELECT count(*) FROM live),
 'relevant_games',(SELECT count(*) FROM relevant_games),
 'unplayed_relevant_games',(SELECT count(*) FROM relevant_games WHERE NOT played),
 'rating_requests',(SELECT count(*) FROM requests),
 'selected_rating_rows',(SELECT count(DISTINCT id) FROM chosen),
 'requests_without_rating',(SELECT count(*) FROM chosen WHERE id IS NULL),
 'latest_changes_selected_identity',(SELECT count(*) FROM chosen WHERE id IS DISTINCT FROM latest_id),
 'latest_changes_rating_values',(SELECT count(*) FROM chosen WHERE
   ROW(offense,defense) IS DISTINCT FROM ROW(latest_offense,latest_defense))
) AS chances_measurement;
CREATE TEMP TABLE archive_games AS
SELECT x.id,coalesce(x.kickoff::timestamptz AT TIME ZONE 'UTC',x.day::date::timestamp) AS utc
FROM game x JOIN team h ON h.id=x.home_id JOIN team a ON a.id=x.away_id
JOIN phase p ON p.id=x.phase_id JOIN championship c ON c.id=p.championship_id
WHERE c.category_id IS NULL AND x.played;
CREATE TEMP TABLE recent_games AS
SELECT * FROM archive_games WHERE utc>(SELECT max(utc)-interval '1456 days' FROM archive_games);
SELECT jsonb_build_object(
 'game_rows',(SELECT count(*) FROM game),
 'archive_games',(SELECT count(*) FROM archive_games),
 'recent_games',(SELECT count(*) FROM recent_games),
 'appearance_rows',(SELECT count(*) FROM player_game),
 'recent_eligible_appearances',(SELECT count(*) FROM player_game pg JOIN player p ON p.id=pg.player_id
   JOIN recent_games g ON g.id=pg.game_id WHERE pg.off_minute>0),
 'goal_rows',(SELECT count(*) FROM goal),
 'recent_eligible_goals',(SELECT count(*) FROM goal q JOIN player p ON p.id=q.player_id
   JOIN recent_games g ON g.id=q.game_id WHERE q.minute IS NOT NULL)
) AS ratings_measurement;
ROLLBACK;
