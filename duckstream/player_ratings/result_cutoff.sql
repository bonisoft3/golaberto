WITH "archive" AS (SELECT x.* FROM source_game x
 JOIN source_team h ON h.id=x.home_id
 JOIN source_team a ON a.id=x.away_id
 JOIN source_phase p ON p.id=x.phase_id
 JOIN source_championship c ON c.id=p.championship_id
 WHERE c.category_id IS NULL AND x.played),
"statistics_window" AS (SELECT MAX(utc) AS latest FROM archive),
"boundary" AS (SELECT MAX(w.latest) AS latest, MIN(x.cutoff) AS cutoff
 FROM statistics_window w LEFT JOIN archive x ON x.utc=w.latest)
SELECT CAST(result."since" AS VARCHAR) AS "since" FROM (SELECT cutoff AS since FROM boundary) result;
