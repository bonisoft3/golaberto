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
 CROSS JOIN boundary b WHERE x.utc > b.latest + INTERVAL '-1456 DAY')
SELECT CAST(result."id" AS VARCHAR) AS "id", CAST(result."home_id" AS VARCHAR) AS "home_id", CAST(result."away_id" AS VARCHAR) AS "away_id", CAST(result."home_field" AS INTEGER) AS "home_field", CAST(result."home_aet" AS INTEGER) AS "home_aet", CAST(result."moment" AS BIGINT) AS "moment", CAST(result."date" AS VARCHAR) AS "date" FROM (SELECT id,home_id,away_id,home_field,home_aet,moment,"date" FROM recent) result;
