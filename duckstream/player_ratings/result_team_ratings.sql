WITH "archive" AS (SELECT x.* FROM source_game x
 JOIN source_team h ON h.id=x.home_id
 JOIN source_team a ON a.id=x.away_id
 JOIN source_phase p ON p.id=x.phase_id
 JOIN source_championship c ON c.id=p.championship_id
 WHERE c.category_id IS NULL AND x.played),
"statistics_window" AS (SELECT MAX(utc) AS latest FROM archive),
"boundary" AS (SELECT MAX(w.latest) AS latest, MIN(x.cutoff) AS cutoff
 FROM statistics_window w LEFT JOIN archive x ON x.utc=w.latest),
"rated_teams" AS (SELECT DISTINCT r.team_id FROM source_team_rating r CROSS JOIN boundary b WHERE r.measure_date > b.cutoff),
"recent" AS (SELECT x.* FROM archive x
 JOIN rated_teams rh ON rh.team_id=x.home_id
 JOIN rated_teams ra ON ra.team_id=x.away_id
 CROSS JOIN boundary b WHERE x.utc > b.latest + INTERVAL '-1456 DAY'),
"recent_teams" AS (SELECT home_id AS team_id FROM recent
 UNION
 SELECT away_id AS team_id FROM recent)
SELECT CAST(result."team_id" AS VARCHAR) AS "team_id", CAST(result."measure_date" AS VARCHAR) AS "measure_date", CAST(result."offense" AS DOUBLE) AS "offense", CAST(result."defense" AS DOUBLE) AS "defense" FROM (SELECT r.team_id,r.measure_date,r.offense,r.defense
 FROM source_team_rating r
 JOIN recent_teams t ON t.team_id=r.team_id
 CROSS JOIN boundary b
 WHERE r.measure_date > b.cutoff) result;
