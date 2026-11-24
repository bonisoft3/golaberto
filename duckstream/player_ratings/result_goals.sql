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
SELECT CAST(result."__order" AS VARCHAR) AS "__order", CAST(result."game_id" AS VARCHAR) AS "game_id", CAST(result."player_id" AS VARCHAR) AS "player_id", CAST(result."team_id" AS VARCHAR) AS "team_id", CAST(result."time" AS INTEGER) AS "time", CAST(result."penalty" AS BOOLEAN) AS "penalty", CAST(result."own_goal" AS BOOLEAN) AS "own_goal" FROM (SELECT q.id AS __order,q.game_id,q.player_id,
 CASE WHEN (q.side='home')<>q.own_goal THEN x.home_id ELSE x.away_id END AS team_id,
 q.minute AS "time",q.penalty,q.own_goal
 FROM source_goal q JOIN source_player p ON p.id=q.player_id
 JOIN recent x ON x.id=q.game_id WHERE q.minute IS NOT NULL) result;
